/* Mnet Plus CC 字幕提取器 — content.js（ISOLATED world / document_start）
 *
 * 职责：语言选择 UI / 视频定位与 seek 扫描 / 字幕汇总·去重·排序 / SRT 生成与下载。
 * 网络拦截由 page-hook.js 在 MAIN world 完成，两者通过 window.postMessage 通信。
 *
 * 语言策略：
 *  - 不在底层写死任何语言。page-hook.js 把 API 里出现的所有语言都传过来。
 *  - 语言列表完全由实际收到的 cue.language 动态生成，出现 zh_TW / es_ES / th_TH 等
 *    新语言也无需改代码。
 *  - 用户可在下拉框里选：自动 / 全部语言 / 某个具体语言。
 */
(() => {
    "use strict";

    if (window.__MNET_CC_CONTENT__) return;
    window.__MNET_CC_CONTENT__ = true;

    const HOOK_SOURCE = "mnetplus-cc-exporter";
    const SELF_SOURCE = "mnetplus-cc-content";

    const STEP_SECONDS = 10;       // 每次 seek 的间隔（秒）
    const STEP_WAIT_MS = 800;      // 每次 seek 后等待页面重新请求字幕
    const SEEK_TIMEOUT_MS = 2000;  // 等待 seeked 事件的上限
    const TAIL_WAIT_MS = 1200;     // 扫描到结尾后的额外等待
    const SETTLE_MS = 500;         // 收尾等待，让最后一批消息落地
    const MULTI_DOWNLOAD_GAP_MS = 400;  // 多语言导出时错开下载，降低被浏览器拦截的概率

    const AUTO = "__AUTO__";
    const ALL = "__ALL__";

    /* 常见语言的显示名。仅用于「更好看」——未知语言会回退成代码本身，
       所以这里不构成硬编码限制。 */
    const LANGUAGE_NAMES = {
        zh_CN: "简体中文", zh_TW: "繁體中文", zh_HK: "繁體中文（香港）", zh_SG: "简体中文（新加坡）",
        ko_KR: "한국어", en_US: "English", en_GB: "English (UK)", en_AU: "English (AU)",
        ja_JP: "日本語", th_TH: "ไทย", vi_VN: "Tiếng Việt", id_ID: "Bahasa Indonesia",
        ms_MY: "Bahasa Melayu", fil_PH: "Filipino", hi_IN: "हिन्दी",
        es_ES: "Español", es_MX: "Español (MX)", pt_BR: "Português (BR)", pt_PT: "Português",
        fr_FR: "Français", de_DE: "Deutsch", it_IT: "Italiano", ru_RU: "Русский",
        ar_SA: "العربية", tr_TR: "Türkçe", pl_PL: "Polski", nl_NL: "Nederlands",
    };

    const state = {
        cues: new Map(),        // key = language|displaySecond|content
        languages: new Map(),   // language -> 条数
        lastLanguage: "",       // 最近一次收到 cue 的语言（≈ 播放器当前字幕轨）
        videoKey: "",
        running: false,
        cancel: false,
        langSig: null,          // null 保证首次一定渲染下拉框（否则空签名会被误判为"未变化"）
        selectedLanguage: AUTO,
    };

    const ui = { host: null, button: null, status: null, lang: null, clear: null };

    const log = (...args) => console.log("[MnetPlus CC]", ...args);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    /* ================= 语言工具 ================= */

    function languageLabel(code) {
        const name = LANGUAGE_NAMES[code];
        if (name) return name + " (" + code + ")";
        const head = String(code).split(/[-_]/)[0];
        return (head ? head.toUpperCase() : code) + " (" + code + ")";
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function cuesOf(language) {
        const out = [];
        for (const cue of state.cues.values()) if (cue.language === language) out.push(cue);
        return out;
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

        if (data.type === "CUES" && Array.isArray(data.cues)) {
            let added = 0;
            for (const cue of data.cues) if (addCue(cue)) added++;
            if (added) {
                refreshLanguageSelect();
                if (!state.running) showIdleCount();
            }
        } else if (data.type === "ALL_CUES" && Array.isArray(data.cues)) {
            let added = 0;
            for (const cue of data.cues) if (addCue(cue)) added++;
            refreshLanguageSelect();
            if (!state.running && added) showIdleCount();
        }
    });

    function askHook(type) {
        try {
            window.postMessage({ source: SELF_SOURCE, type: type }, "*");
        } catch (_) {}
    }

    function addCue(cue) {
        if (!cue) return false;
        const language = typeof cue.language === "string" ? cue.language.trim() : "";
        if (!language) return false;

        const start = Number(cue.displaySecond);
        const dur = Number(cue.displayDurationSecond);
        const content = typeof cue.content === "string" ? cue.content.replace(/\r\n?/g, "\n").trim() : "";
        if (!isFinite(start) || !isFinite(dur) || !content) return false;

        state.lastLanguage = language;

        const key = language + "|" + start + "|" + content;
        if (state.cues.has(key)) return false;

        state.cues.set(key, {
            content: content,
            displaySecond: start,
            displayDurationSecond: dur,
            language: language
        });
        state.languages.set(language, (state.languages.get(language) || 0) + 1);
        return true;
    }

    /* ================= 视频定位 ================= */

    function videoIdentity(video) {
        try {
            return video.currentSrc || video.src || "";
        } catch (_) {
            return "";
        }
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
            if (score > bestScore) {
                bestScore = score;
                best = v;
            }
        }
        return best;
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
            try {
                video.currentTime = time;
            } catch (_) {
                finish();
            }
        });
    }

    function buildSeekPoints(duration) {
        const tail = Math.max(0, duration - 0.5);
        const points = [];
        for (let t = 0; t < duration; t += STEP_SECONDS) points.push(t);
        if (!points.length) points.push(0);
        if (tail - points[points.length - 1] > 0.5) points.push(tail);
        points[points.length - 1] = tail;  // 保证最后一点贴近结尾
        return points;
    }

    /* ================= 主流程 ================= */

    async function exportCaptions() {
        log("export started");

        // 扫描中再次点击 = 取消
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

        // 切换视频时清空缓存（首次点击保留已捕获的字幕）
        const key = videoIdentity(video);
        if (!state.videoKey) {
            state.videoKey = key;
        } else if (key && key !== state.videoKey) {
            clearCache(false);
            state.videoKey = key;
            log("检测到切换视频，已重置字幕缓存");
        }

        askHook("REQUEST_ALL");  // 先取 hook 已经缓存的部分

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
                askHook("REQUEST_ALL");
                await wait(SETTLE_MS);
            }
        } catch (err) {
            log("scan error", err);
            setButton("扫描失败");
            setStatus("扫描过程中出错：" + (err && err.message ? err.message : err) + "\n请刷新页面后重试。", true);
            state.running = false;
            return;
        } finally {
            // 还原播放状态
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
        if (langs.length) s += "（" + langs.map(languageLabel).join("、") + "）";
        return s;
    }

    /* ================= 导出 ================= */

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
            setStatus("扫描完成，但没有捕获到任何字幕。\n请确认播放器里已经开启了字幕。", true);
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
                ? Array.from(state.languages.keys()).map(languageLabel).join("、")
                : "无";
            setStatus(
                "没有捕获到「" + targets.map(languageLabel).join("、") + "」的字幕。\n" +
                "当前已捕获：" + have + "\n\n" +
                "提示：Mnet Plus 只会请求播放器当前选中的那条字幕轨，\n" +
                "请到播放器里把字幕切换成目标语言，再点一次「提取 CC 字幕」。",
                true
            );
            return;
        }

        const title = sanitizeFileName(getVideoTitle());
        setStatus("正在生成 SRT…", true);

        const done = [];
        for (let i = 0; i < ready.length; i++) {
            const item = ready[i];
            const srt = buildSRT(item.cues);
            const filename = title + "_" + item.code + ".srt";
            await downloadText(filename, srt);
            done.push(languageLabel(item.code) + " " + item.cues.length + " 条 → " + filename);
            if (i < ready.length - 1) await wait(MULTI_DOWNLOAD_GAP_MS);
        }

        if (ready.length > 1) {
            setButton("已导出 " + ready.length + " 个文件");
        } else {
            setButton("已导出 " + ready[0].cues.length + " 条");
        }

        let msg = "已导出：\n" + done.map((d) => "· " + d).join("\n");
        if (empty.length) msg += "\n\n未捕获到：" + empty.map(languageLabel).join("、");
        if (ready.length > 1) msg += "\n\n若浏览器拦截了多文件下载，请在地址栏选择「允许」后重试。";
        setStatus(msg, true);
    }

    /* ================= SRT ================= */

    function formatTime(seconds) {
        const totalMs = Math.max(0, Math.round(seconds * 1000));
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

    function buildSRT(cues) {
        const sorted = cues
            .slice()
            .sort((a, b) => a.displaySecond - b.displaySecond || a.content.localeCompare(b.content));

        const blocks = [];
        for (let i = 0; i < sorted.length; i++) {
            const cur = sorted[i];
            const start = cur.displaySecond;
            let end = start + cur.displayDurationSecond;

            const next = sorted[i + 1];
            if (next && next.displaySecond > start && next.displaySecond < end) {
                end = next.displaySecond;  // 避免与下一条时间轴重叠
            }
            if (!(end > start)) end = start + 0.5;

            blocks.push(
                (i + 1) + "\n" +
                formatTime(start) + " --> " + formatTime(end) + "\n" +
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

    function sanitizeFileName(name) {
        const cleaned = String(name || "")
            .replace(/[\\/:*?"<>|]/g, "_")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120);
        return cleaned || "MnetPlus";
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

    /* ================= 缓存 ================= */

    function clearCache(tellHook) {
        state.cues.clear();
        state.languages.clear();
        state.lastLanguage = "";
        state.langSig = null;
        state.selectedLanguage = AUTO;
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
        const langs = Array.from(state.languages.keys()).map(languageLabel).join("、");
        setStatus("已缓存 " + state.cues.size + " 条字幕（" + langs + "）\n点击「提取 CC 字幕」开始扫描全片", true);
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
            html += '<option value="' + escapeHtml(code) + '">' +
                escapeHtml(languageLabel(code)) + " · " + (state.languages.get(code) || 0) + " 条" +
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
            ".status{display:none;max-width:340px;padding:8px 12px;border-radius:10px;" +
            "background:#ffffff;color:#111111;font-size:12px;line-height:1.55;" +
            "border:1px solid #e0e0e0;box-shadow:0 4px 18px rgba(0,0,0,.16);white-space:pre-wrap;}" +
            ".panel{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:12px;" +
            "background:#ffffff;color:#111111;border:1px solid #e0e0e0;" +
            "box-shadow:0 4px 18px rgba(0,0,0,.16);}" +
            ".panel label{font-size:12px;font-weight:600;color:#111111;white-space:nowrap;}" +
            ".lang{max-width:210px;padding:6px 8px;border:1px solid #d9d9d9;border-radius:8px;" +
            "background:#ffffff;color:#111111;font-size:13px;font-family:inherit;cursor:pointer;}" +
            ".row{display:flex;align-items:center;gap:8px;}" +
            ".clear{padding:8px 14px;border:1px solid #d9d9d9;border-radius:999px;background:#ffffff;" +
            "color:#666666;font-size:12px;cursor:pointer;font-family:inherit;}" +
            ".clear:hover{background:#f2f2f2;}" +
            ".btn{padding:10px 18px;border:1px solid #d9d9d9;border-radius:999px;background:#ffffff;" +
            "color:#111111;font-size:14px;font-weight:600;cursor:pointer;" +
            "box-shadow:0 4px 18px rgba(0,0,0,.18);font-family:inherit;}" +
            ".btn:hover{background:#f2f2f2;}" +
            ".btn:active{background:#e8e8e8;}" +
            "</style>" +
            '<div class="wrap">' +
            '<div class="status"></div>' +
            '<div class="panel"><label>字幕语言</label><select class="lang"></select></div>' +
            '<div class="row">' +
            '<button class="clear" type="button">清空</button>' +
            '<button class="btn" type="button">提取 CC 字幕</button>' +
            "</div>" +
            "</div>";

        document.body.appendChild(host);

        ui.host = host;
        ui.button = root.querySelector(".btn");
        ui.status = root.querySelector(".status");
        ui.lang = root.querySelector(".lang");
        ui.clear = root.querySelector(".clear");

        // 关键：必须真的绑定 click handler
        ui.button.addEventListener("click", exportCaptions);
        ui.lang.addEventListener("change", () => {
            state.selectedLanguage = ui.lang.value;
        });
        ui.clear.addEventListener("click", () => {
            if (state.running) {
                setStatus("扫描进行中，请先等扫描结束或点一次按钮取消。", true);
                return;
            }
            clearCache(true);
            refreshLanguageSelect();
            setButton("提取 CC 字幕");
            setStatus("已清空本地字幕缓存。", true);
        });

        refreshLanguageSelect();
    }

    function bootstrapUI() {
        if (document.body) {
            mountUI();
            return;
        }
        const observer = new MutationObserver(() => {
            if (document.body) {
                observer.disconnect();
                mountUI();
            }
        });
        const target = document.documentElement || document;
        observer.observe(target, { childList: true, subtree: true });
        document.addEventListener("DOMContentLoaded", () => {
            observer.disconnect();
            mountUI();
        }, { once: true });
    }

    bootstrapUI();
})();
