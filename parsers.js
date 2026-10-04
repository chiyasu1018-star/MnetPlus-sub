/* Mnet Plus CC 字幕提取器 — parsers.js
 *
 * 多格式解析器：把任意来源的字幕响应统一成内部 Cue：
 *     { language, start, end, content, source }
 *
 * 依赖：utils.js（window.MnetCCUtils）
 * 暴露：window.MnetCCParsers
 *
 * 设计要点：
 *  - 绝不根据扩展名（.cmft）判断格式，一律看响应正文。
 *  - WebVTT 解析必须容忍：BOM、NOTE/STYLE/REGION 块、cue identifier、
 *    cue settings、多行文本、无小时时间格式、缺 WEBVTT 头的分片。
 *  - 语言绝不写死；这里只负责「尽量判断」，判断不出交给上层兜底。
 */
(() => {
    "use strict";

    if (window.MnetCCParsers) return;

    const U = window.MnetCCUtils;

    /* ================= 格式判定 ================= */

    // 正文是否以 WEBVTT 开头（容忍 BOM 与前置空行）
    function looksLikeWebVTT(text) {
        if (typeof text !== "string") return false;
        return /^\uFEFF?\s*WEBVTT(\s|$|\r|\n)/.test(text);
    }

    function isProbablyJSON(text) {
        if (typeof text !== "string") return false;
        const t = text.replace(/^\uFEFF/, "").trimStart();
        return t.startsWith("{") || t.startsWith("[");
    }

    // 返回 "vtt" | "json" | "unknown"
    function detectFormat(url, text) {
        if (looksLikeWebVTT(text)) return "vtt";

        if (typeof text === "string") {
            const t = text.replace(/^\uFEFF/, "").trimStart();

            if (isProbablyJSON(t)) {
                try { JSON.parse(t); return "json"; } catch (_) { /* 继续 */ }
            }

            // 没有 WEBVTT 头的 VTT 分片：只要出现时间轴箭头就按 VTT 处理
            if (t.indexOf("-->") !== -1) return "vtt";
        }

        // 正文不可读时，退回到 URL 特征（仅作最后手段）
        const low = String(url || "").toLowerCase();
        if (low.indexOf(".cmft") !== -1 || low.indexOf(".vtt") !== -1 || low.indexOf(".webvtt") !== -1) {
            return "vtt";
        }
        return "unknown";
    }

    /* ================= WebVTT ================= */

    // 去掉 WEBVTT 头及其后的 header 元数据块（直到第一个空行）
    function stripVttHeader(text) {
        let s = String(text).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

        const m = s.match(/^[ \t]*WEBVTT[^\n]*\n([\s\S]*)$/);
        if (!m) return s;

        let rest = m[1];

        // header 元数据（如 Kind:/Language:/X-TIMESTAMP-MAP=）直到空行
        const idx = rest.indexOf("\n\n");
        if (idx !== -1) {
            const head = rest.slice(0, idx);
            if (head.indexOf("-->") === -1) rest = rest.slice(idx + 2);
        }
        return rest;
    }

    // 逐行扫描 cue。容忍无空行分隔、缺 WEBVTT 头、块间多余空行。
    function scanVttLines(text) {
        const out = [];
        const lines = String(text).replace(/\r\n?/g, "\n").split("\n");

        let i = 0;
        let pending = null;   // { start, end }
        let buf = [];

        function flush() {
            if (pending) {
                const content = U.stripVttTags(U.decodeVttEntities(buf.join("\n"))).trim();
                if (content) out.push({ start: pending.start, end: pending.end, content: content });
            }
            pending = null;
            buf = [];
        }

        while (i < lines.length) {
            const raw = lines[i];
            const trimmed = raw.trim();

            // 空行 = cue 结束
            if (trimmed === "") { flush(); i++; continue; }

            // NOTE / STYLE / REGION 块：整块跳过
            if (/^(NOTE|STYLE|REGION)\b/i.test(trimmed)) {
                flush();
                i++;
                while (i < lines.length && lines[i].trim() !== "") i++;
                continue;
            }

            // 时间轴行
            const arrow = trimmed.match(/^(\S+)[ \t]*-->[ \t]*(\S+)(?:[ \t]+(.*))?$/);
            if (arrow) {
                flush();
                const st = U.parseTimestamp(arrow[1]);
                const en = U.parseTimestamp(arrow[2]);
                if (isFinite(st) && isFinite(en)) pending = { start: st, end: en };
                i++;
                continue;
            }

            // cue identifier：紧跟其后的下一行是时间轴行，则本行是标识，丢弃
            if (!pending && i + 1 < lines.length && lines[i + 1].indexOf("-->") !== -1) {
                i++;
                continue;
            }

            // 其余情况：只有已经进入 cue 才当正文
            if (pending) buf.push(raw);
            i++;
        }

        flush();
        return out;
    }

    // 返回 [{ start, end, content }]
    function parseWebVTT(text) {
        if (typeof text !== "string" || !text) return [];
        try {
            const body = stripVttHeader(text);
            return scanVttLines(body);
        } catch (err) {
            U.error("parseWebVTT 失败", err);
            return [];
        }
    }

    /* ================= JSON Cue API ================= */

    // 从任意 JSON 结构里挖出 cue 数组
    function collectCueObjects(payload) {
        const list = [];
        if (!payload || typeof payload !== "object") return list;

        // 常见：contentMap 是对象字典，值可能是数组，也可能再包一层 { cues: [...] }
        const map = payload.contentMap || (payload.data && payload.data.contentMap);
        if (map && typeof map === "object" && !Array.isArray(map)) {
            for (const v of Object.values(map)) {
                if (Array.isArray(v)) {
                    // { ko_KR: [ {displaySecond, content}, ... ] }
                    // 早期写成 list.push(v)，把整个数组当成一条 cue 推了进去，
                    // 结果 JSON 接口永远解析出 0 条。
                    list.push(...v);
                } else if (v && typeof v === "object" && Array.isArray(v.cues)) {
                    // { ko_KR: { cues: [...] } }
                    list.push(...v.cues);
                } else if (v) {
                    list.push(v);
                }
            }
        }

        // 也接受直接数组
        for (const key of ["cues", "captionCues", "items", "list"]) {
            if (Array.isArray(payload[key])) list.push(...payload[key]);
            if (payload.data && Array.isArray(payload.data[key])) list.push(...payload.data[key]);
        }
        if (Array.isArray(payload.data)) list.push(...payload.data);
        if (Array.isArray(payload)) list.push(...payload);

        return list;
    }

    // 返回 [{ language, start, end, content }]
    function parseJSONCue(payload, fallbackLanguage) {
        const out = [];
        const list = collectCueObjects(payload);

        for (const raw of list) {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;

            const language = U.normalizeLanguageCode(raw.language || raw.lang || raw.locale) || fallbackLanguage || "";
            if (!language) continue;

            // start
            let start = Number(raw.displaySecond);
            if (!isFinite(start)) start = Number(raw.start);
            if (!isFinite(start)) start = U.parseTimestamp(raw.startTime || raw.start_time);
            if (!isFinite(start)) continue;

            // end：优先显式 end，其次 start + duration
            let end = Number(raw.end);
            if (!isFinite(end)) end = U.parseTimestamp(raw.endTime || raw.end_time);
            if (!isFinite(end)) {
                const dur = Number(raw.displayDurationSecond != null ? raw.displayDurationSecond : raw.duration);
                if (isFinite(dur)) end = start + dur;
            }
            if (!isFinite(end) || end <= start) end = start + 2;

            let content = raw.content;
            if (typeof content !== "string") content = raw.text;
            if (typeof content !== "string") content = raw.caption;
            if (typeof content !== "string") continue;

            content = U.decodeVttEntities(content).replace(/\r\n?/g, "\n").trim();
            if (!content) continue;

            out.push({ language: language, start: start, end: end, content: content });
        }

        return out;
    }

    /* ================= 统一入口 ================= */

    // 返回 [{ language, start, end, content, source }]
    function parseSubtitleResponse(url, text) {
        const fallbackLanguage = U.extractLanguageFromUrl(url);
        const format = detectFormat(url, text);

        let cues = [];
        if (format === "vtt") {
            cues = parseWebVTT(text).map((c) => ({
                language: fallbackLanguage || "unknown",
                start: c.start,
                end: c.end,
                content: c.content,
            }));
        } else if (format === "json") {
            let obj = null;
            try { obj = JSON.parse(text.replace(/^\uFEFF/, "")); } catch (_) { obj = null; }
            if (obj) cues = parseJSONCue(obj, fallbackLanguage);
        }

        return {
            format: format,
            language: fallbackLanguage,
            cues: cues.map((c) => ({
                language: U.normalizeLanguageCode(c.language) || fallbackLanguage || "unknown",
                start: Number(c.start),
                end: Number(c.end),
                content: String(c.content).replace(/\r\n?/g, "\n").trim(),
                source: format,
            })),
        };
    }

    window.MnetCCParsers = {
        looksLikeWebVTT,
        detectFormat,
        parseWebVTT,
        parseJSONCue,
        parseSubtitleResponse,
    };
})();
