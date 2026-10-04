/* Mnet Plus CC 字幕提取器 — utils.js
 *
 * 纯工具函数，无副作用，不碰 DOM / 网络 / chrome.*。
 * 同时注入 MAIN world 与 ISOLATED world（各自独立一份实例）。
 *
 * 暴露：window.MnetCCUtils
 */
(() => {
    "use strict";

    if (window.MnetCCUtils) return;

    const DEBUG = true;                 // 发布时改 false
    const PREFIX = "[MnetCC]";

    const log = (...a) => { if (DEBUG) console.log(PREFIX, ...a); };
    const warn = (...a) => { if (DEBUG) console.warn(PREFIX, ...a); };
    const error = (...a) => { if (DEBUG) console.error(PREFIX, ...a); };

    /* ================= 时间戳 ================= */

    // 支持 "00:00:03.400" / "03:05.205" / "1:02:03.400" / 逗号小数点
    function parseTimestamp(ts) {
        if (typeof ts !== "string") return NaN;
        const s = ts.trim().replace(",", ".");
        const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/);
        if (!m) return NaN;
        const h = m[1] ? parseInt(m[1], 10) : 0;
        const mi = parseInt(m[2], 10);
        const se = parseInt(m[3], 10);
        const ms = m[4] ? parseInt((m[4] + "000").slice(0, 3), 10) : 0;
        if (!isFinite(h) || !isFinite(mi) || !isFinite(se)) return NaN;
        return h * 3600 + mi * 60 + se + ms / 1000;
    }

    // 秒 -> "HH:MM:SS,mmm"（SRT 用逗号）
    function formatSrtTime(seconds) {
        const totalMs = Math.max(0, Math.round(Number(seconds) * 1000));
        const h = Math.floor(totalMs / 3600000);
        const m = Math.floor((totalMs % 3600000) / 60000);
        const s = Math.floor((totalMs % 60000) / 1000);
        const ms = totalMs % 1000;
        return (
            String(h).padStart(2, "0") + ":" +
            String(m).padStart(2, "0") + ":" +
            String(s).padStart(2, "0") + "," +
            String(ms).padStart(3, "0")
        );
    }

    // 秒 -> "HH:MM:SS.mmm"（VTT 用句点）
    function formatVttTime(seconds) {
        return formatSrtTime(seconds).replace(",", ".");
    }

    /* ================= 语言 ================= */

    // "zh-cn" -> "zh_CN"；"zh_CN" -> "zh_CN"；"en" -> "en"
    function normalizeLanguageCode(raw) {
        if (raw === null || raw === undefined) return "";
        let s = String(raw).trim();
        if (!s) return "";
        s = s.replace(/-/g, "_");
        const m = s.match(/^([A-Za-z]{2,3})(?:_([A-Za-z]{2,4}))?/);
        if (!m) return s;
        const lang = m[1].toLowerCase();
        const region = m[2] ? m[2].toUpperCase() : "";
        return region ? lang + "_" + region : lang;
    }

    // 多级语言判定（URL 层）。返回 "" 表示无法判断。
    function extractLanguageFromUrl(url) {
        if (!url) return "";
        const u = String(url);

        // 1) query 参数
        let m = u.match(/[?&](?:language|lang|locale|languageCode|langCode)=([A-Za-z_-]{2,10})/i);
        if (m) return normalizeLanguageCode(decodeURIComponent(m[1]));

        // 2) .../zh_CN_caption_000000132.cmft  /  ..._zh_CN_caption_...  /  ..._en_caption_...
        //    必须【区分大小写】且先匹配「语言_区域」：
        //    早期写成 /_([a-z]{2}(?:_[A-Z]{2})?)_caption/i，加了 i 之后
        //    "_CN_caption" 里的区域码会被当成语言，于是 zh_CN 的 URL 被误判成 "cn"。
        //    同时把前导 "/" 也接受，因为真实 URL 是 /zh_CN_caption_xxx.cmft。
        m = u.match(/[\/_]([A-Za-z]{2,3}_[A-Za-z]{2,4})_caption/);
        if (m) return normalizeLanguageCode(m[1]);
        //    退一步：只有语言、没有区域，如 _en_caption_
        m = u.match(/[\/_]([A-Za-z]{2,3})_caption/);
        if (m) return normalizeLanguageCode(m[1]);

        // 3) ..._zh_CN_....cmft / .vtt
        m = u.match(/_([a-z]{2}_[A-Z]{2})_/);
        if (m) return normalizeLanguageCode(m[1]);

        // 4) 路径里出现 /zh_CN/ 这样的段
        m = u.match(/\/([a-z]{2}_[A-Z]{2})\//);
        if (m) return normalizeLanguageCode(m[1]);

        return "";
    }

    // 常见语言显示名。仅影响「好不好看」——未知语言回退成代码本身，不构成限制。
    const LANGUAGE_NAMES = {
        zh_CN: "简体中文", zh_TW: "繁體中文", zh_HK: "繁體中文（香港）", zh_SG: "简体中文（新加坡）",
        ko_KR: "한국어", en_US: "English", en_GB: "English (UK)", en_AU: "English (AU)",
        ja_JP: "日本語", th_TH: "ไทย", vi_VN: "Tiếng Việt", id_ID: "Bahasa Indonesia",
        ms_MY: "Bahasa Melayu", fil_PH: "Filipino", hi_IN: "हिन्दी",
        es_ES: "Español", es_MX: "Español (MX)", pt_BR: "Português (BR)", pt_PT: "Português",
        fr_FR: "Français", de_DE: "Deutsch", it_IT: "Italiano", ru_RU: "Русский",
        ar_SA: "العربية", tr_TR: "Türkçe", pl_PL: "Polski", nl_NL: "Nederlands",
    };

    function languageLabel(code) {
        if (!code) return "未知语言";
        if (code === "unknown") return "未知语言 (unknown)";
        const name = LANGUAGE_NAMES[code];
        if (name) return name + " (" + code + ")";
        const head = String(code).split(/[-_]/)[0];
        return (head ? head.toUpperCase() : code) + " (" + code + ")";
    }

    /* ================= 字幕 ================= */

    // 唯一键：language + start + end + content
    function cueKey(cue) {
        return cue.language + "|" + cue.start + "|" + cue.end + "|" + cue.content;
    }

    const VTT_ENTITIES = {
        "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
        "&nbsp;": " ", "&lrm;": "\u200E", "&rlm;": "\u200F",
        "&LRM;": "\u200E", "&RLM;": "\u200F",
    };

    function decodeVttEntities(s) {
        let out = String(s);
        for (const k in VTT_ENTITIES) {
            if (out.indexOf(k) !== -1) out = out.split(k).join(VTT_ENTITIES[k]);
        }
        // 数字实体 &#39; / &#x27;
        out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
            try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return ""; }
        });
        out = out.replace(/&#(\d+);/g, (_, d) => {
            try { return String.fromCodePoint(parseInt(d, 10)); } catch (_) { return ""; }
        });
        return out;
    }

    // 去掉 WebVTT 内联标签：<c.yellow> <v Name> <b> <i> <ruby> <00:00:01.000> 等
    function stripVttTags(s) {
        return String(s)
            .replace(/<\d{1,2}:\d{2}:\d{2}\.\d{1,3}>/g, "")
            .replace(/<\/?(?:c|v|b|i|u|ruby|rt|lang|span|em|strong)(?:\.[^>\s]*)*(?:\s[^>]*)?>/gi, "")
            .replace(/<[^>]{0,120}>/g, "");
    }

    function sanitizeFileName(name) {
        const cleaned = String(name || "")
            .replace(/[\\/:*?"<>|]/g, "_")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120);
        return cleaned || "MnetPlus";
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    window.MnetCCUtils = {
        DEBUG, log, warn, error,
        parseTimestamp, formatSrtTime, formatVttTime,
        normalizeLanguageCode, extractLanguageFromUrl, languageLabel, LANGUAGE_NAMES,
        cueKey, decodeVttEntities, stripVttTags,
        sanitizeFileName, escapeHtml,
    };
})();
