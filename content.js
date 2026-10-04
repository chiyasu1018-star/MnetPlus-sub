/* Mnet Plus CC 字幕提取器 — content.js（ISOLATED world / document_start）
 *
 * 职责：UI / 状态 / 视频定位与 seek 扫描 / 字幕汇总·去重·排序 / 覆盖度评估 /
 *       SRT 生成与下载 / SPA 生命周期处理。
 *
 * 网络拦截与解析由 page-hook.js + parsers.js 在 MAIN world 完成，
 * 两者通过 window.postMessage 通信。
 *
 * 语言策略：底层不写死任何语言。语言列表完全由实际收到的 cue.language 动态生成，
 *          出现 zh_TW / es_ES / th_TH 等新语言无需改代码。
 */
(() => {
    "use strict";

    const U = window.MnetCCUtils;
    const P = window.MnetCCParsers;

    // 依赖缺失时【绝不静默退出】：挂一个看得见的面板，并给出明确指引。
    // 历史故障：utils.js 被浏览器去重后只注入到 MAIN world，导致这里 U 为 undefined，
    // 用户只看到「右下角面板不出现」，没有任何提示。
    if (!U || !P) {
        console.error("[MnetCC] 依赖未加载 —— utils.js:", !!U, "| parsers.js:", !!P);
        showLoadFailure(!!U, !!P);
        return;
    }

    if (window.__MNET_CC_CONTENT__) return;
    window.__MNET_CC_CONTENT__ = true;

    // 依赖缺失兜底面板（不依赖 utils.js，纯 DOM）。
    // 函数声明会被提升，因此可以放在依赖检查之后定义。
    function showLoadFailure(hasUtils, hasParsers) {
        try {
            if (document.getElementById("__mnet_cc_host__")) return;

            const host = document.createElement("div");
            host.id = "__mnet_cc_host__";
            host.setAttribute("data-mnetcc-state", "load-failure");
            host.style.cssText = "position:fixed;right:22px;bottom:22px;z-index:2147483647;";

            const root = host.attachShadow({ mode: "open" });
            root.innerHTML =
                "<style>" +
                ".box{font:13px/1.6 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;" +
                "background:#fff;color:#b42318;border:1px solid #fda29b;border-radius:10px;" +
                "padding:12px 14px;max-width:290px;box-shadow:0 6px 24px rgba(0,0,0,.18)}" +
                ".ttl{font-weight:700;margin-bottom:6px}" +
                ".d{color:#475467;font-size:12px;margin-top:6px}" +
                "code{background:#f2f4f7;padding:0 3px;border-radius:3px;font-size:11px}" +
                "</style>" +
                '<div class="box">' +
                '<div class="ttl">Mnet Plus CC 字幕提取器</div>' +
                "<div>⚠️ 扩展内部组件加载失败</div>" +
                '<div class="d">utils.js: <code>' + (hasUtils ? "OK" : "缺失") + "</code>　" +
                "parsers.js: <code>" + (hasParsers ? "OK" : "缺失") + "</code></div>" +
                '<div class="d">请到扩展管理页点「重新加载」，然后 <b>刷新本页（F5）</b>。</div>' +
                "</div>";

            const mount = () => {
                if (document.body) { document.body.appendChild(host); return true; }
                return false;
            };
            if (!mount()) document.addEventListener("DOMContentLoaded", mount, { once: true });
        } catch (_) {}
    }

    const HOOK_SOURCE = "mnetplus-cc-exporter";
    const SELF_SOURCE = "mnetplus-cc-content";

    const AUTO = "__AUTO__";
    const ALL = "__ALL__";

    const STEP_SECONDS = 10;            // seek 扫描步长
    const STEP_WAIT_MS = 800;           // 每次 seek 后等待播放器重新请求字幕
    const SEEK_TIMEOUT_MS = 2500;       // 等待 seeked 事件上限
    const TAIL_WAIT_MS = 1500;          // 扫到结尾后的额外等待
    const SETTLE_MS = 600;              // 收尾等待
    const MULTI_DOWNLOAD_GAP_MS = 400;  // 多语言导出错开下载
    const COVERAGE_TOLERANCE = 15;      // 末尾允许的未覆盖秒数，超过则提示可能不完整

    const state = {
        cues: new Map(),        // cueKey -> { language, start, end, content, source }
        languages: new Map(),   // language -> 条数
        lastLanguage: "",       // 最近一次收到 cue 的语言（≈ 播放器当前字幕轨）
        videoKey: "",
        duration: 0,
        running: false,
        cancel: false,
        langSig: null,
        selectedLanguage: AUTO,
        lastDiag: "",
    };

    const ui = { host: null, button: null, status: null, lang: null, clear: null, rescan: null, autoScan: null };

    const log = (...a) => U.log(...a);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    /* ================= 字幕入库 ================= */

    function addCue(cue) {
        if (!cue) return false;

        const language = U.normalizeLanguageCode(cue.language) || "unknown";
        const start = Number(cue.start);
        let end = Number(cue.end);
        const content = typeof cue.content === "string" ? cue.content.replace(/\r\n?/g, "\n").trim() : "";

        if (!isFinite(start) || !content) return false;
        if (!isFinite(end) || end <= start) end = start + 0.5;

        const normalized = {
            language: language,
            start: start,
            end: end,
            content: content,
            source: cue.source || "unknown",
        };

        state.lastLanguage = language;

        const key = U.cueKey(normalized);
        if (state.cues.has(key)) return false;

        state.cues.set(key, normalized);
        state.languages.set(language, (state.languages.get(language) || 0) + 1);
        return true;
    }

    function cuesOf(language) {
        const out = [];
        for (const cue of state.cues.values()) if (cue.language === language) out.push(cue);
        return out;
    }

    function coverageOf(cues) {
        if (!cues.length) return null;
        let min = Infinity;
        let max = -Infinity;
        for (const c of cues) {
            if (c.start < min) min = c.start;
            if (c.end > max) max = c.end;
        }
        return { min: min, max: max };
    }

    // 自动：优先「播放器当前正在请求的那条字幕轨」，其次条数最多的语言
    function resolveAutoLanguage() {
        if (state.lastLanguage && state.languages.has(state.lastLanguage)) return state.lastLanguage;
        let best = null;
        let bestN = -1;
        for (const [code, n] of state.languages) {
            if (n > bestN) { bestN = n; best = code; }
        }
        return best;
    }

    /* ================= 与 page-hook.js 通信 ================= */

    window.addEventListener("message", (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== HOOK_SOURCE) return;

        if (data.type === "RAW") {
            handleRaw(data.url, data.text);
        } else if (data.type === "CUES" || data.type === "ALL_CUES") {
            // 兼容旧版 page-hook（正常情况下不会走到这里）
            if (!Array.isArray(data.cues)) return;
            let added = 0;
            for (const cue of data.cues) if (addCue(cue)) added++;
            refreshLanguageSelect();
            if (!state.running && added) showIdleCount();
            if (added) log("收到", added, "条，总计", state.cues.size);
        } else if (data.type === "DIAG") {
            state.lastDiag = data.message || "";
            log("诊断:", data.level, data.message, data.url || "");
            if (data.level === "warn" && !state.running) {
                setStatus("⚠ " + state.lastDiag + "\n(详见控制台 [MnetCC] 日志)", true);
            }
        }
    });

    /* ================= 解析（在 ISOLATED world 完成） =================
     *
     * page-hook.js 只负责把字幕响应正文原样搬过来，解析放在这边做。
     * 这样 MAIN world 完全不需要 utils.js / parsers.js，
     * 避免「同名文件被浏览器去重、只注入其中一个 world」的加载故障。
     */
    function handleRaw(url, text) {
        if (typeof text !== "string" || !text) return;

        let result;
        try {
            result = P.parseSubtitleResponse(url, text);
        } catch (err) {
            log("解析异常:", url, err);
            return;
        }

        log("字幕资源:", url,
            "| 格式:", result.format,
            "| URL 语言:", result.language || "(未识别)",
            "| cues:", result.cues.length);

        if (result.format === "unknown") {
            state.lastDiag = "发现字幕资源，但无法识别格式";
            log("诊断:", "warn", state.lastDiag, url);
            if (!state.running) setStatus("⚠ " + state.lastDiag + "\n(详见控制台 [MnetCC] 日志)", true);
            return;
        }
        if (!result.cues.length) {
            state.lastDiag = "发现 " + result.format.toUpperCase() + " 资源，但解析出 0 条字幕";
            log("诊断:", "warn", state.lastDiag, url);
            if (!state.running) setStatus("⚠ " + state.lastDiag + "\n(详见控制台 [MnetCC] 日志)", true);
            return;
        }

        let added = 0;
        for (const cue of result.cues) if (addCue(cue)) added++;
        refreshLanguageSelect();
        if (!state.running && added) showIdleCount();
        if (added) log("收到", added, "条，总计", state.cues.size);
    }

    function askHook(type) {
        try {
            window.postMessage({ source: SELF_SOURCE, type: type }, "*");
        } catch (_) {}
    }

    /* ================= 视频定位 ================= */

    function videoIdentity(video) {
        try {
            return video.currentSrc || video.src || "";
        } catch (_) {
            return "";
        }
    }

    // 兼容播放器把 <video> 放在 Shadow DOM 里的情况
    function collectVideos(root, out) {
        try {
            const direct = root.querySelectorAll("video");
            for (const v of direct) out.push(v);
        } catch (_) {}
        try {
            const all = root.querySelectorAll("*");
            for (const el of all) {
                if (el.shadowRoot) collectVideos(el.shadowRoot, out);
            }
        } catch (_) {}
    }

    function pickVideo() {
        const list = [];
        collectVideos(document, list);
        if (!list.length) return null;

        let best = null;
        let bestScore = -1;
        for (const v of list) {
            let score = 0;
            try {
                const rect = v.getBoundingClientRect();
                score = Math.max(0, rect.width) * Math.max(0, rect.height);
                if (v.offsetParent !== null) score += 1e9;
                if (!v.paused) score += 1e6;
            } catch (_) {}
            if (score > bestScore) { bestScore = score; best = v; }
        }
        return best;
    }

    /* ================= seek ================= */

    function seekTo(video, time) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                video.removeEventListener("seeked", onSeeked);
                clearTimeout(timer);
                resolve();
            };
            const onSeeked = () => setTimeout(finish, 120);
            const timer = setTimeout(finish, SEEK_TIMEOUT_MS);
            video.addEventListener("seeked", onSeeked);
            try { video.currentTime = time; } catch (_) { finish(); }
        });
    }

    function buildSeekPoints(duration) {
        const tail = Math.max(0, duration - 0.5);
        const points = [];
        for (let t = 0; t < duration; t += STEP_SECONDS) points.push(t);
        if (!points.length) points.push(0);
        if (tail - points[points.length - 1] > 0.5) points.push(tail);
        points[points.length - 1] = tail;
        return points;
    }

    /* ================= 主流程 ================= */

    async function runExport() {
        log("=== 开始 ===");

        if (state.running) {
            state.cancel = true;
            setButton("正在取消…");
            return;
        }

        const video = pickVideo();
        if (!video) {
            setButton("没有找到视频");
            setStatus("页面上没有找到 <video> 元素。\n请先打开视频并等播放器加载出来。", true);
            return;
        }
        if (!isFinite(video.duration) || video.duration <= 0) {
            setButton("视频未就绪");
            setStatus("视频时长还没加载完成，请等几秒后再点一次。", true);
            return;
        }

        // 切换视频时清空缓存
        const key = videoIdentity(video);
        if (!state.videoKey) {
            state.videoKey = key;
        } else if (key && key !== state.videoKey) {
            resetAll(false);
            state.videoKey = key;
            log("检测到切换视频，已重置缓存");
        }

        state.duration = video.duration;

        // cue 库由 content.js 独占并随 RAW 消息实时更新，无需再向 hook 索取。
        const wantScan = !ui.autoScan || ui.autoScan.checked;

        if (!wantScan) {
            await wait(SETTLE_MS * 2);
            await doExport();
            return;
        }

        state.running = true;
        state.cancel = false;

        const duration = video.duration;
        const originalTime = video.currentTime;
        const wasPaused = video.paused;

        setButton("正在扫描…");

        try {
            try { video.pause(); } catch (_) {}

            const points = buildSeekPoints(duration);
            for (const target of points) {
                if (state.cancel) break;
                const t = Math.min(target, Math.max(0, duration - 0.5));
                await seekTo(video, t);
                await wait(STEP_WAIT_MS);
                setStatus(scanProgressText(t, duration), true);
            }

            if (!state.cancel) {
                await wait(TAIL_WAIT_MS);
                await wait(SETTLE_MS);
            }
        } catch (err) {
            log("scan error", err);
            setButton("扫描失败");
            setStatus("扫描过程中出错：" + (err && err.message ? err.message : err) + "\n请刷新页面后重试。", true);
            state.running = false;
            return;
        } finally {
            try {
                video.currentTime = Math.min(originalTime, Math.max(0, duration - 0.5));
                if (!wasPaused) video.play().catch(() => {});
            } catch (_) {}
            state.running = false;
        }

        if (state.cancel) {
            setButton("已取消");
            setStatus("扫描已取消，当前已缓存 " + state.cues.size + " 条字幕。", true);
            return;
        }

        await doExport();
    }

    function scanProgressText(t, duration) {
        const langs = Array.from(state.languages.keys());
        let s = "正在扫描 " + Math.round(t) + " / " + Math.round(duration) + " 秒…\n已找到 " + state.cues.size + " 条字幕";
        if (langs.length) s += "（" + langs.map(U.languageLabel).join("、") + "）";
        return s;
    }

    /* ================= 导出 ================= */

    function buildReport(cues, code) {
        const cov = coverageOf(cues);
        const dur = state.duration || 0;
        let text = "· " + U.languageLabel(code) + "： " + cues.length + " 条";
        if (cov) {
            text += "\n   覆盖 " + U.formatSrtTime(cov.min).slice(0, 8) + " → " + U.formatSrtTime(cov.max).slice(0, 8);
            if (dur > 0 && cov.max < dur - COVERAGE_TOLERANCE) {
                text += "\n   ⚠ 字幕可能不完整（视频总长 " + U.formatSrtTime(dur).slice(0, 8) + "）";
            }
        }
        return text;
    }

    async function doExport() {
        const selection = (ui.lang && ui.lang.value) || state.selectedLanguage || AUTO;

        let targets;
        if (selection === ALL) {
            targets = Array.from(state.languages.keys());
        } else if (selection === AUTO) {
            const auto = resolveAutoLanguage();
            targets = auto ? [auto] : [];
        } else {
            targets = [selection];
        }

        if (!targets.length) {
            setButton("未检测到字幕");
            setStatus(
                "扫描完成，但没有捕获到任何字幕。\n\n" +
                "排查建议：\n" +
                "1. 播放器里先打开 CC 字幕（Mnet Plus 只请求当前选中的字幕轨）\n" +
                "2. 播放几秒让播放器发出字幕请求\n" +
                "3. 打开控制台看有没有 [MnetCC] 日志\n" +
                "4. 如果看到「无法识别格式」，请把日志里的 URL 反馈给我",
                true
            );
            return;
        }

        const ready = [];
        const empty = [];
        for (const code of targets) {
            const cues = cuesOf(code);
            if (cues.length) ready.push({ code: code, cues: cues });
            else empty.push(code);
        }

        if (!ready.length) {
            setButton("该语言无字幕");
            const have = state.languages.size
                ? Array.from(state.languages.keys()).map(U.languageLabel).join("、")
                : "无";
            setStatus(
                "没有捕获到「" + targets.map(U.languageLabel).join("、") + "」的字幕。\n" +
                "当前已捕获：" + have + "\n\n" +
                "提示：Mnet Plus 只会请求播放器当前选中的那条字幕轨，\n" +
                "请到播放器里把字幕切换成目标语言，再点一次「提取 CC 字幕」。",
                true
            );
            return;
        }

        const title = U.sanitizeFileName(getVideoTitle());
        setStatus("正在生成 SRT…", true);

        const reports = [];
        for (let i = 0; i < ready.length; i++) {
            const item = ready[i];
            const sorted = sortCues(item.cues);
            const srt = buildSRT(sorted);
            const filename = title + "_" + item.code + ".srt";
            await downloadText(filename, srt);
            reports.push(buildReport(sorted, item.code) + "\n   → " + filename);
            if (i < ready.length - 1) await wait(MULTI_DOWNLOAD_GAP_MS);
        }

        setButton(ready.length > 1 ? "已导出 " + ready.length + " 个文件" : "已导出 " + ready[0].cues.length + " 条");

        let msg = "已导出：\n" + reports.join("\n");
        if (empty.length) msg += "\n\n未捕获到：" + empty.map(U.languageLabel).join("、");
        if (ready.length > 1) msg += "\n\n若浏览器拦截了多文件下载，请在地址栏选择「允许」后重试。";
        setStatus(msg, true);
        log("=== 导出完成 ===", reports);
    }

    /* ================= 排序 & SRT ================= */

    function sortCues(cues) {
        return cues.slice().sort((a, b) => {
            if (a.start !== b.start) return a.start - b.start;
            if (a.end !== b.end) return a.end - b.end;
            return a.content.localeCompare(b.content);
        });
    }

    function buildSRT(sorted) {
        const blocks = [];
        for (let i = 0; i < sorted.length; i++) {
            const cur = sorted[i];
            const start = cur.start;
            let end = cur.end;

            const next = sorted[i + 1];
            if (next && next.start > start && next.start < end) {
                end = next.start;   // 避免与下一条重叠
            }
            if (!(end > start)) end = start + 0.5;

            blocks.push(
                (i + 1) + "\n" +
                U.formatSrtTime(start) + " --> " + U.formatSrtTime(end) + "\n" +
                cur.content + "\n"
            );
        }
        return blocks.join("\n");
    }

    /* ================= 文件名 & 下载 ================= */

    function getVideoTitle() {
        let title = "";
        try {
            const og = document.querySelector('meta[property="og:title"]');
            if (og && og.content) title = og.content;
        } catch (_) {}
        if (!title) {
            try {
                const h1 = document.querySelector("h1");
                if (h1 && h1.textContent) title = h1.textContent;
            } catch (_) {}
        }
        if (!title) title = document.title || "";
        return title.replace(/[\-|–—]\s*Mnet\s*Plus.*$/i, "").trim();
    }

    function downloadText(filename, text) {
        // 加 BOM，保证 Windows 记事本 / PotPlayer 正确识别 UTF-8
        const blob = new Blob(["\uFEFF" + text], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.style.display = "none";
        (document.body || document.documentElement).appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        return Promise.resolve();
    }

    /* ================= 缓存 & 重置 ================= */

    function resetAll(tellHook) {
        state.cues.clear();
        state.languages.clear();
        state.lastLanguage = "";
        state.langSig = null;
        state.selectedLanguage = AUTO;
        state.lastDiag = "";
        if (tellHook !== false) askHook("RESET");
    }

    /* ================= UI ================= */

    function setButton(text) {
        if (ui.button) ui.button.textContent = text;
    }

    function setStatus(text, visible) {
        if (!ui.status) return;
        ui.status.textContent = text || "";
        ui.status.style.display = visible && text ? "block" : "none";
    }

    function showIdleCount() {
        if (!state.cues.size) return;
        const langs = Array.from(state.languages.keys()).map(U.languageLabel).join("、");
        setStatus("已捕获 " + state.cues.size + " 条字幕（" + langs + "）\n点击「提取 CC 字幕」扫描全片并导出", true);
    }

    function refreshLanguageSelect() {
        if (!ui.lang) return;

        const codes = Array.from(state.languages.keys()).sort((a, b) => {
            const diff = (state.languages.get(b) || 0) - (state.languages.get(a) || 0);
            return diff !== 0 ? diff : a.localeCompare(b);
        });

        const sig = codes.join(",");
        if (sig === state.langSig) return;
        state.langSig = sig;

        const prev = state.selectedLanguage || AUTO;

        let html = '<option value="' + AUTO + '">自动（跟随当前播放）</option>';
        html += '<option value="' + ALL + '">全部语言（每语言一个文件）</option>';
        for (const code of codes) {
            html += '<option value="' + U.escapeHtml(code) + '">' +
                U.escapeHtml(U.languageLabel(code)) + " · " + (state.languages.get(code) || 0) + " 条" +
                "</option>";
        }
        ui.lang.innerHTML = html;

        const values = [AUTO, ALL].concat(codes);
        ui.lang.value = values.indexOf(prev) !== -1 ? prev : AUTO;
        state.selectedLanguage = ui.lang.value;
    }

    function mountUI() {
        if (ui.host || !document.body) return;

        const host = document.createElement("div");
        host.id = "__mnet_cc_host__";
        host.style.cssText = "position:fixed;right:22px;bottom:22px;z-index:2147483647;";

        const root = host.attachShadow({ mode: "open" });
        root.innerHTML =
            "<style>" +
            ".wrap{display:flex;flex-direction:column;align-items:flex-end;gap:8px;" +
            'font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;}' +
            ".status{display:none;max-width:360px;max-height:320px;overflow:auto;padding:10px 12px;border-radius:10px;" +
            "background:#ffffff;color:#111111;font-size:12px;line-height:1.6;" +
            "border:1px solid #e0e0e0;box-shadow:0 4px 18px rgba(0,0,0,.16);white-space:pre-wrap;}" +
            ".panel{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:12px;" +
            "background:#ffffff;color:#111111;border:1px solid #e0e0e0;" +
            "box-shadow:0 4px 18px rgba(0,0,0,.16);}" +
            ".panel label{font-size:12px;font-weight:600;color:#111111;white-space:nowrap;}" +
            ".lang{max-width:220px;padding:6px 8px;border:1px solid #d9d9d9;border-radius:8px;" +
            "background:#ffffff;color:#111111;font-size:13px;font-family:inherit;cursor:pointer;}" +
            ".auto{display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:12px;" +
            "background:#ffffff;color:#333333;border:1px solid #e0e0e0;font-size:12px;" +
            "box-shadow:0 4px 18px rgba(0,0,0,.16);cursor:pointer;}" +
            ".row{display:flex;align-items:center;gap:8px;}" +
            ".mini{padding:8px 14px;border:1px solid #d9d9d9;border-radius:999px;background:#ffffff;" +
            "color:#666666;font-size:12px;cursor:pointer;font-family:inherit;}" +
            ".mini:hover{background:#f2f2f2;}" +
            ".btn{padding:10px 18px;border:1px solid #d9d9d9;border-radius:999px;background:#ffffff;" +
            "color:#111111;font-size:14px;font-weight:600;cursor:pointer;" +
            "box-shadow:0 4px 18px rgba(0,0,0,.18);font-family:inherit;}" +
            ".btn:hover{background:#f2f2f2;}" +
            ".btn:active{background:#e8e8e8;}" +
            "</style>" +
            '<div class="wrap">' +
            '<div class="status"></div>' +
            '<div class="panel"><label>字幕语言</label><select class="lang"></select></div>' +
            '<label class="auto"><input type="checkbox" class="autoscan" checked>自动扫描完整视频</label>' +
            '<div class="row">' +
            '<button class="mini clear" type="button">清空</button>' +
            '<button class="mini rescan" type="button">重新扫描</button>' +
            '<button class="btn" type="button">提取 CC 字幕</button>' +
            "</div>" +
            "</div>";

        document.body.appendChild(host);

        ui.host = host;
        ui.button = root.querySelector(".btn");
        ui.status = root.querySelector(".status");
        ui.lang = root.querySelector(".lang");
        ui.clear = root.querySelector(".clear");
        ui.rescan = root.querySelector(".rescan");
        ui.autoScan = root.querySelector(".autoscan");

        ui.button.addEventListener("click", runExport);

        ui.lang.addEventListener("change", () => {
            state.selectedLanguage = ui.lang.value;
        });

        ui.clear.addEventListener("click", () => {
            if (state.running) {
                setStatus("扫描进行中，请先等扫描结束或点一次按钮取消。", true);
                return;
            }
            resetAll(true);
            refreshLanguageSelect();
            setButton("提取 CC 字幕");
            setStatus("已清空本地字幕缓存。", true);
        });

        ui.rescan.addEventListener("click", () => {
            if (state.running) {
                setStatus("扫描进行中，请稍候。", true);
                return;
            }
            resetAll(true);
            refreshLanguageSelect();
            setStatus("缓存已清空，正在重新扫描…", true);
            runExport();
        });

        refreshLanguageSelect();
    }

    function bootstrapUI() {
        if (document.body) { mountUI(); return; }
        const observer = new MutationObserver(() => {
            if (document.body) { observer.disconnect(); mountUI(); }
        });
        const target = document.documentElement || document;
        observer.observe(target, { childList: true, subtree: true });
        document.addEventListener("DOMContentLoaded", () => {
            observer.disconnect();
            mountUI();
        }, { once: true });
    }

    /* ================= SPA 生命周期 ================= */

    function currentVideoKey() {
        const v = pickVideo();
        return v ? videoIdentity(v) : "";
    }

    function handleRouteChange() {
        const key = currentVideoKey();
        if (!key) return;
        if (state.videoKey && key !== state.videoKey) {
            log("SPA 路由变化，视频已切换，重置缓存");
            resetAll(true);
            refreshLanguageSelect();
            setButton("提取 CC 字幕");
            setStatus("检测到切换视频，字幕缓存已重置。", true);
        }
        state.videoKey = key;
    }

    function watchSpa() {
        for (const fn of ["pushState", "replaceState"]) {
            const orig = history[fn];
            if (typeof orig !== "function") continue;
            history[fn] = function (...args) {
                const r = orig.apply(this, args);
                setTimeout(handleRouteChange, 300);
                return r;
            };
        }
        window.addEventListener("popstate", () => setTimeout(handleRouteChange, 300));

        // 兜底：<video> 的 src 变化（覆盖非路由式切换）
        setInterval(handleRouteChange, 3000);
    }

    /* ================= 启动 ================= */

    bootstrapUI();
    watchSpa();
    log("content 已就绪");
})();
