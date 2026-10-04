/* Mnet Plus CC 字幕提取器 — page-hook.js（MAIN world / document_start）
 *
 * 唯一职责：拦截 Mnet Plus 页面自身发出的字幕接口请求，读取 contentMap，
 * 把**所有语言**的字幕通过 window.postMessage 交给 content.js。
 *
 * 注意：这里不做任何语言筛选。语言由用户在 content.js 的 UI 中选择。
 * 语言种类也不硬编码——完全从 API 返回的 cue.language 动态收集。
 *
 * 不读取、不保存、不上传任何 Authorization / Cookie / Token。
 * 不操作 DOM，不创建按钮，不调用 chrome.* API。
 */
(() => {
    "use strict";

    const SOURCE = "mnetplus-cc-exporter";
    const CONTENT_SOURCE = "mnetplus-cc-content";

    if (window.__MNET_CC_HOOK__) return;
    window.__MNET_CC_HOOK__ = true;

    // key = language + "|" + displaySecond + "|" + content，天然去重
    const store = new Map();
    // 已经见过的语言代码集合（动态，不硬编码）
    const languages = new Set();

    function post(msg) {
        try {
            window.postMessage(Object.assign({ source: SOURCE }, msg), "*");
        } catch (_) {}
    }

    /* ---------------- URL 匹配（不限定语言） ---------------- */

    function isCaptionUrl(url) {
        let u = url;
        if (u && typeof u !== "string") {
            try { u = String(u.url || u.href || u); } catch (_) { return false; }
        }
        if (typeof u !== "string" || !u) return false;
        return u.indexOf("/captions/") !== -1 && u.indexOf("/cues") !== -1;
    }

    /* ---------------- 数据提取（保留所有语言） ---------------- */

    function normalizeCue(raw) {
        if (!raw || typeof raw !== "object") return null;

        // 不硬编码语言：只要求 language 是非空字符串
        const language = typeof raw.language === "string" ? raw.language.trim() : "";
        if (!language) return null;

        const start = Number(raw.displaySecond);
        const dur = Number(raw.displayDurationSecond);
        if (!isFinite(start) || !isFinite(dur)) return null;
        if (typeof raw.content !== "string") return null;

        const content = raw.content.replace(/\r\n?/g, "\n").trim();
        if (!content) return null;

        return {
            content: content,
            displaySecond: start,
            displayDurationSecond: dur,
            language: language
        };
    }

    function addFromPayload(payload) {
        if (!payload || typeof payload !== "object") return;

        const map = payload.contentMap || (payload.data && payload.data.contentMap);
        if (!map || typeof map !== "object") return;

        const added = [];
        for (const raw of Object.values(map)) {
            const cue = normalizeCue(raw);
            if (!cue) continue;
            languages.add(cue.language);
            const key = cue.language + "|" + cue.displaySecond + "|" + cue.content;
            if (store.has(key)) continue;
            store.set(key, cue);
            added.push(cue);
        }

        if (added.length) {
            post({
                type: "CUES",
                cues: added,
                total: store.size,
                languages: Array.from(languages)
            });
        }
    }

    /* ---------------- Hook: fetch ---------------- */

    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
        window.fetch = function (...args) {
            const promise = originalFetch.apply(this, args);
            try {
                const url = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
                if (isCaptionUrl(url)) {
                    promise
                        .then((response) => {
                            try {
                                if (response && response.ok) {
                                    // clone 一份，绝不消耗原 Response
                                    response.clone().json().then(addFromPayload).catch(() => {});
                                }
                            } catch (_) {}
                        })
                        .catch(() => {});
                }
            } catch (_) {}
            return promise;
        };
    }

    /* ---------------- Hook: XMLHttpRequest ---------------- */

    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
        const originalOpen = XHR.prototype.open;
        const originalSend = XHR.prototype.send;

        XHR.prototype.open = function (method, url, ...rest) {
            try { this.__mnetCcUrl = typeof url === "string" ? url : String(url); } catch (_) {}
            return originalOpen.call(this, method, url, ...rest);
        };

        XHR.prototype.send = function (...args) {
            try {
                if (isCaptionUrl(this.__mnetCcUrl)) {
                    this.addEventListener("load", () => {
                        try {
                            if (this.status < 200 || this.status >= 300) return;
                            const type = this.responseType;
                            if (type && type !== "json" && type !== "text") return;
                            const raw = type === "json" ? this.response : this.responseText;
                            if (!raw) return;
                            addFromPayload(typeof raw === "string" ? JSON.parse(raw) : raw);
                        } catch (_) {}
                    });
                }
            } catch (_) {}
            return originalSend.apply(this, args);
        };
    }

    /* ---------------- 响应 content.js 的请求 ---------------- */

    window.addEventListener("message", (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== CONTENT_SOURCE) return;

        if (data.type === "REQUEST_ALL") {
            post({
                type: "ALL_CUES",
                cues: Array.from(store.values()),
                total: store.size,
                languages: Array.from(languages)
            });
        } else if (data.type === "RESET") {
            store.clear();
            languages.clear();
        }
    });

    post({ type: "HOOK_READY" });
})();
