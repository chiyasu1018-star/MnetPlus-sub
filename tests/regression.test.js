/* Mnet Plus CC 字幕提取器 —— 回归测试（Node vm 沙箱，无需浏览器）
 *
 * 运行：
 *   node tests/regression.test.js
 *
 * 覆盖：
 *   [0] manifest 结构守卫  —— 防止「同名文件跨 world 被去重」的致命故障复发
 *   [1] 依赖装载 / UI 挂载
 *   [2] .cmft（正文是 WEBVTT）解析 + 语言提取
 *   [3] JSON Cue API（contentMap）解析
 *   [4] SRT 时间格式
 *   [5] RAW 消息链路（page-hook → content.handleRaw → cue 库 → UI）
 *   [6] 异常载荷不崩溃
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DIR = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

/* ============================================================
 * [0] manifest 结构守卫
 *
 * Chrome / Edge 会按「文件名」对整个扩展的内容脚本去重：同一个 .js 名字
 * 同时出现在 MAIN 和 ISOLATED 两个入口时，只会被注入到其中一个 world，
 * 另一个 world 里该文件根本不存在且无报错 —— 表现为右下角面板完全不出现。
 * 这条断言是那次的教训，必须常驻。
 * ============================================================ */
console.log("\n[0] manifest 结构守卫");

const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
ok("manifest_version 为 3", manifest.manifest_version === 3, manifest.manifest_version);

const seen = new Map();
const collisions = [];
for (const entry of manifest.content_scripts) {
    const world = entry.world || "ISOLATED";
    for (const file of entry.js) {
        if (seen.has(file)) collisions.push(file + "（" + seen.get(file) + " ↔ " + world + "）");
        else seen.set(file, world);
    }
}
ok("没有文件名跨 world 重复", collisions.length === 0, collisions);

ok("MAIN 入口只有 page-hook.js（零依赖）",
    (() => {
        const mains = manifest.content_scripts.filter((e) => (e.world || "ISOLATED") === "MAIN");
        return mains.length === 1 && mains[0].js.length === 1 && mains[0].js[0] === "page-hook.js";
    })(),
    manifest.content_scripts.filter((e) => (e.world || "ISOLATED") === "MAIN").map((e) => e.js));

const missing = [];
for (const file of seen.keys()) if (!fs.existsSync(path.join(DIR, file))) missing.push(file);
ok("manifest 引用的文件都存在", missing.length === 0, missing);

/* page-hook.js 必须零依赖（不能引用 utils / parsers 暴露的全局） */
const hookSrc = fs.readFileSync(path.join(DIR, "page-hook.js"), "utf8");
const hookCode = hookSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
ok("page-hook.js 代码里不引用 MnetCCUtils / MnetCCParsers",
    hookCode.indexOf("MnetCCUtils") === -1 && hookCode.indexOf("MnetCCParsers") === -1);

/* ============================================================
 * 沙箱
 * ============================================================ */

function makeEl(tag) {
    const el = {
        tagName: tag, id: "", name: "", textContent: "", innerHTML: "", value: "", checked: true,
        style: { cssText: "" }, children: [], _q: {}, _l: {},
        appendChild(c) { this.children.push(c); return c; },
        removeChild() {}, remove() {},
        setAttribute(k, v) { this[k] = v; }, getAttribute(k) { return this[k]; },
        addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
        removeEventListener() {},
        querySelector(s) { if (!this._q[s]) this._q[s] = makeEl("q" + s); return this._q[s]; },
        querySelectorAll() { return []; },
        attachShadow() { if (!this._shadow) this._shadow = makeEl("shadow-root"); return this._shadow; },
        click() {},
        getBoundingClientRect() { return { width: 100, height: 100 }; },
        offsetParent: {}, paused: true, duration: 664, currentTime: 0,
        play() { return Promise.resolve(); }, pause() {},
    };
    return el;
}

const documentShim = {
    body: makeEl("body"), documentElement: makeEl("html"),
    createElement: (t) => makeEl(t),
    getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, title: "t",
};

const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, JSON, Math, Number, String, Object, Array, Boolean, Date, RegExp, Error,
    isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    document: documentShim,
    history: { pushState() {}, replaceState() {} },
    MutationObserver: class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} },
    location: { href: "https://www.mnetplus.world/media/zh-CN/videos/x" },
    navigator: { userAgent: "test" },
    Blob: function () {}, URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    __listeners: {},
    addEventListener(t, f) { (this.__listeners[t] = this.__listeners[t] || []).push(f); },
    removeEventListener() {},
    postMessage() {},
};
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);

function load(f) {
    vm.runInContext(fs.readFileSync(path.join(DIR, f), "utf8"), ctx, { filename: f });
}

/* 按 manifest 的 ISOLATED 入口加载（顺序也照 manifest 来） */
const isolated = manifest.content_scripts.find((e) => (e.world || "ISOLATED") === "ISOLATED");
for (const f of isolated.js) load(f);

const U = ctx.MnetCCUtils, P = ctx.MnetCCParsers;

/* ---------- [1] 依赖装载 ---------- */
console.log("\n[1] 依赖与初始化");
ok("window.MnetCCUtils 存在", !!U);
ok("window.MnetCCParsers 存在", !!P);
ok("content 已启动", ctx.__MNET_CC_CONTENT__ === true);

const host = documentShim.body.children[0];
ok("UI host 已挂载到 body", !!host && host.id === "__mnet_cc_host__", host && host.id);
ok("host 未处于 load-failure 状态", !(host && host["data-mnetcc-state"]), host && host["data-mnetcc-state"]);

const statusEl = host && host._shadow && host._shadow._q[".status"];
const langEl = host && host._shadow && host._shadow._q[".lang"];

/* ---------- [2] .cmft / WEBVTT ---------- */
console.log("\n[2] .cmft / WEBVTT 解析");
const VTT =
    "WEBVTT\n\n" +
    "00:00:03.400 --> 00:00:05.205\n" +
    "안녕하세요, 반갑습니다\n\n" +
    "00:00:05.205 --> 00:00:07.000\n" +
    "두 번째 자막입니다\n";

const CMFT_URL = "https://cdn.mnetplus.world/media/videos/x/captions/1/zh_CN_caption_000000132.cmft";
const r1 = P.parseSubtitleResponse(CMFT_URL, VTT);
ok("格式判定为 vtt（不靠 .cmft 扩展名）", r1.format === "vtt", r1.format);
ok("语言从 URL 提取为 zh_CN（不是 cn）", r1.language === "zh_CN", r1.language);
ok("解析出 2 条 cue", r1.cues.length === 2, r1.cues.length);
ok("时间戳正确 (3.4 / 5.205)", r1.cues[0].start === 3.4 && r1.cues[0].end === 5.205, r1.cues[0]);
ok("内联标签与实体被清理",
    P.parseSubtitleResponse(CMFT_URL, "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<c.yellow>a &amp; b</c>\n")
        .cues[0].content === "a & b",
    P.parseSubtitleResponse(CMFT_URL, "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<c.yellow>a &amp; b</c>\n")
        .cues[0].content);

/* ---------- [3] JSON Cue API ---------- */
console.log("\n[3] JSON Cue API 解析");
const JSON_URL = "https://api.mnetplus.world/media/v1/public/videos/x/captions/1/cues?language=ko_KR";
const r2 = P.parseSubtitleResponse(JSON_URL, JSON.stringify({
    contentMap: { ko_KR: [{ start: 0, end: 2, content: "첫 줄" }, { start: 2, end: 4, content: "둘째 줄" }] },
}));
ok("格式判定为 json", r2.format === "json", r2.format);
ok("语言 ko_KR", r2.language === "ko_KR", r2.language);
ok("contentMap 的数组值被展平（2 条）", r2.cues.length === 2, r2.cues.length);

const r2b = P.parseSubtitleResponse(JSON_URL, JSON.stringify({
    contentMap: { ko_KR: { cues: [{ displaySecond: 1, displayDurationSecond: 2, content: "x" }] } },
}));
ok("contentMap 的 {cues:[...]} 嵌套也被支持", r2b.cues.length === 1, r2b.cues.length);

/* ---------- [4] SRT 时间格式 ---------- */
console.log("\n[4] SRT 时间格式（逗号毫秒）");
ok("3.4 -> 00:00:03,400", U.formatSrtTime(3.4) === "00:00:03,400", U.formatSrtTime(3.4));
ok("3661.007 -> 01:01:01,007", U.formatSrtTime(3661.007) === "01:01:01,007", U.formatSrtTime(3661.007));

/* ---------- [5] RAW 消息链路 ---------- */
console.log("\n[5] RAW 消息链路（page-hook → content.handleRaw）");
/* 坑：vm 沙箱里 `window` 是 contextify 后的全局代理，!== 外部的 ctx 对象。
   必须取沙箱内部的 window 作为 event.source，否则会被
   `if (event.source !== window) return` 拦掉（测试坑，不是产品 bug）。 */
const INNER_WINDOW = vm.runInContext("window", ctx);
function dispatchRAW(url, text) {
    const ev = { source: INNER_WINDOW, data: { source: "mnetplus-cc-exporter", type: "RAW", url: url, text: text } };
    for (const f of (ctx.__listeners.message || [])) f(ev);
}
dispatchRAW(CMFT_URL, VTT);

ok("状态框被更新（说明 cue 已入库）", /2/.test(statusEl ? statusEl.textContent : ""), statusEl && statusEl.textContent);
/* refreshLanguageSelect 用 ui.lang.innerHTML = html 填选项，
   所以只能检查 innerHTML 字符串（shim 不解析 HTML）。 */
ok("语言下拉框已填入 zh_CN 选项",
    langEl ? String(langEl.innerHTML).indexOf("zh_CN") !== -1 : false,
    langEl && langEl.innerHTML);

dispatchRAW(CMFT_URL, VTT);
ok("重复投递被去重（状态仍为 2）", /2/.test(statusEl ? statusEl.textContent : ""), statusEl && statusEl.textContent);

/* ---------- [6] 异常载荷 ---------- */
console.log("\n[6] 异常载荷不应崩溃");
let threw = null;
try { dispatchRAW("https://x/y.cmft", "<html>not a subtitle</html>"); }
catch (e) { threw = e; }
ok("未知格式载荷不抛异常", !threw, threw && threw.message);

try { dispatchRAW("https://x/y.cmft", ""); dispatchRAW("https://x/y.cmft", null); }
catch (e) { threw = e; }
ok("空载荷不抛异常", !threw, threw && threw.message);

console.log("\n========================================");
console.log("通过 " + pass + " / 失败 " + fail);
process.exit(fail ? 1 : 0);
