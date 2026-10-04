/* Mnet Plus CC 字幕提取器 — page-hook.js（MAIN world / document_start）
 *
 * 唯一职责：拦截 Mnet Plus 页面自身发出的**字幕资源**请求，读出响应正文原文，
 * 通过 window.postMessage 原样交给 ISOLATED world 的 content.js 去解析。
 *
 * ⚠⚠ 本文件必须保持【零依赖】—— MAIN world 只注入这一个文件。⚠⚠
 *
 * 原因（踩过的坑，别改回去）：
 *   Chrome / Edge 会按「文件名」对整个扩展的内容脚本去重。若同一个 .js 文件名
 *   同时出现在 MAIN 入口和 ISOLATED 入口的 js 数组里，浏览器只会把它注入到
 *   其中一个 world（先处理的 MAIN），另一个 world 里就完全不存在。
 *   历史故障：utils.js / parsers.js 同时列在两个入口 → ISOLATED world 里
 *   window.MnetCCUtils 为 undefined → content.js 第 15 行判定失败后直接 return，
 *   表现为「右下角面板不出现」，控制台报
 *       [MnetCC] utils.js 未加载，content 退出
 *
 *   因此：MAIN 入口的 js 数组 = ["page-hook.js"]，且该文件不得 require 任何外部模块。
 *   utils.js / parsers.js 只属于 ISOLATED 入口。
 *
 * 支持的字幕资源形式（不写死、不按扩展名判断，格式判定在 ISOLATED 侧做）：
 *   ① JSON Cue API   /media/v1/public/videos/{id}/captions/{id}/cues?language=xx_XX
 *   ② .cmft 资源     正文实为 WEBVTT（也有可能是 JSON）
 *   ③ 其它 .vtt / .webvtt / 含 caption 的文本资源
 *
 * 这里不做语言筛选、不硬编码语言列表、不解析正文、不保存解析结果。
 * 不读取、不保存、不上传任何 Authorization / Cookie / Token。
 * 不操作 DOM，不创建按钮，不调用 chrome.* API。
 */
(() => {
    "use strict";

    if (window.__MNET_CC_HOOK__) return;
    window.__MNET_CC_HOOK__ = true;

    const SOURCE = "mnetplus-cc-exporter";
    const CONTENT_SOURCE = "mnetplus-cc-content";

    const MAX_BODY_BYTES = 8 * 1024 * 1024;   // 超过 8MB 的响应直接放弃（字幕不可能这么大）

    const seenUrls = new Set();               // 已抓取过的 URL#长度，避免重复搬运

    /* ================= 日志 / 通信 ================= */

    function log(...a) {
        try { console.log("[MnetCC]", ...a); } catch (_) {}
    }

    function warn(...a) {
        try { console.warn("[MnetCC]", ...a); } catch (_) {}
    }

    function post(msg) {
        try {
            window.postMessage(Object.assign({ source: SOURCE }, msg), "*");
        } catch (_) {}
    }

    /* ================= URL 判定 ================= */

    function toUrlString(url) {
        if (!url) return "";
        if (typeof url === "string") return url;
        try {
            if (typeof url.url === "string") return url.url;
            if (typeof url.href === "string") return url.href;
            return String(url);
        } catch (_) {
            return "";
        }
    }

    function isSubtitleUrl(url) {
        const u = toUrlString(url);
        if (!u) return false;
        const low = u.toLowerCase();

        // ① JSON Cue API
        if (low.indexOf("/captions/") !== -1 && low.indexOf("/cues") !== -1) return true;

        // ② .cmft（正文可能是 WEBVTT，也可能是 JSON，交给正文判定）
        if (low.indexOf(".cmft") !== -1) return true;

        // ③ 常见字幕扩展名
        if (low.indexOf(".webvtt") !== -1) return true;
        if (low.indexOf(".vtt") !== -1) return true;
        if (low.indexOf(".srt") !== -1) return true;

        // ④ caption / subtitle 关键词 + 文本型资源
        if (low.indexOf("caption") !== -1 || low.indexOf("subtitle") !== -1) {
            if (low.indexOf("/converted/") !== -1) return true;
            if (low.indexOf(".json") !== -1) return true;
            if (low.indexOf("/cues") !== -1) return true;
        }

        return false;
    }

    /* ================= 正文搬运（不解析，解析在 ISOLATED 侧） ================= */

    function handleSubtitleResponse(url, text) {
        if (typeof text !== "string" || !text) return;

        if (text.length > MAX_BODY_BYTES) {
            warn("响应过大，跳过:", url, text.length);
            return;
        }

        const key = url + "#" + text.length;
        if (seenUrls.has(key)) return;
        seenUrls.add(key);

        log("字幕资源:", url, "(" + text.length + " 字节) → 转交 ISOLATED 解析");
        post({ type: "RAW", url: url, text: text });
    }

    /* ================= Hook: fetch ================= */

    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
        window.fetch = function (...args) {
            const promise = originalFetch.apply(this, args);
            try {
                const url = toUrlString(args[0]);
                if (isSubtitleUrl(url)) {
                    log("fetch 命中:", url);
                    promise
                        .then((response) => {
                            try {
                                if (!response) return;
                                if (typeof response.ok === "boolean" && !response.ok) {
                                    warn("fetch 响应非 2xx:", response.status, url);
                                    return;
                                }
                                // clone 一份，绝不消耗原 Response
                                response.clone().text()
                                    .then((text) => handleSubtitleResponse(url, text))
                                    .catch((err) => warn("读取 fetch 正文失败:", url, err));
                            } catch (_) {}
                        })
                        .catch(() => {});
                }
            } catch (_) {}
            return promise;
        };
    }

    /* ================= Hook: XMLHttpRequest ================= */

    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
        const originalOpen = XHR.prototype.open;
        const originalSend = XHR.prototype.send;

        XHR.prototype.open = function (method, url, ...rest) {
            try { this.__mnetCcUrl = toUrlString(url); } catch (_) {}
            return originalOpen.call(this, method, url, ...rest);
        };

        XHR.prototype.send = function (...args) {
            try {
                const url = this.__mnetCcUrl;
                if (isSubtitleUrl(url)) {
                    log("XHR 命中:", url);
                    this.addEventListener("load", () => {
                        try {
                            if (this.status < 200 || this.status >= 300) return;
                            const type = this.responseType;
                            if (type && type !== "json" && type !== "text" && type !== "") return;

                            let text = null;
                            if (type === "json") {
                                try { text = JSON.stringify(this.response); } catch (_) { text = null; }
                            } else {
                                text = this.responseText;
                            }
                            if (text) handleSubtitleResponse(url, text);
                        } catch (_) {}
                    });
                }
            } catch (_) {}
            return originalSend.apply(this, args);
        };
    }

    /* ================= 响应 content.js 的请求 ================= */

    window.addEventListener("message", (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== CONTENT_SOURCE) return;

        // 只保留 RESET：清空已抓取记录，让重新扫描时同一 URL 能再次被抓到。
        // （cue 库由 content.js 独占，hook 不再重复保存一份。）
        if (data.type === "RESET") {
            seenUrls.clear();
            log("hook seenUrls 已重置");
        }
    });

    post({ type: "HOOK_READY" });
    log("page-hook 已就绪（MAIN world，零依赖）");
})();
