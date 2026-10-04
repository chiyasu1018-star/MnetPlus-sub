# Mnet Plus CC 字幕提取器 v3.1.0

在 Mnet Plus（`mnetplus.world` / `www.mnetplus.world`）视频页面拦截官方 CC 字幕，
自动扫描整部视频并导出 `.srt`。**支持任意语言**，语言列表从实际收到的字幕资源动态生成。
全部处理在本地完成，**不上传任何字幕或登录信息**。

> **v3.0.0**：从「只认 JSON Cue API」升级为**多格式统一解析**，
> 同时支持 ① JSON `/cues` 接口 和 ② `.cmft`（正文实为 WebVTT）两类资源。
>
> **v3.1.0（本次修复）**：修掉「扩展已加载，但右下角面板根本不出现」的致命故障。
> 根因是 **Chrome/Edge 会按文件名对整个扩展的内容脚本去重**，而 v3.0.0 把
> `utils.js` / `parsers.js` 同时写进了 MAIN 和 ISOLATED 两个入口 —— 于是它们
> 只被注入到 MAIN world，ISOLATED world 里 `window.MnetCCUtils` 是 `undefined`，
> `content.js` 依赖检查失败后直接 `return`，什么也不显示。
> 详见「一、文件结构」里的 ⚠️ 铁律 —— **这条不能改回去**。
>
> v3.1.0 修复清单：
>
> | # | 问题 | 影响 | 修法 |
> |---|---|---|---|
> | 1 | `utils.js`/`parsers.js` 被列在两个 world，被浏览器去重 | **面板完全不出现** | MAIN world 改为零依赖，解析搬到 ISOLATED |
> | 2 | 依赖缺失时 `content.js` 静默 `return` | 用户零提示，无从排查 | 新增红色兜底面板，写明缺哪个文件 |
> | 3 | `extractLanguageFromUrl` 的正则带了 `i` 标志 | `zh_CN_caption` 被误判成 **`cn`**，语言名与文件名全错 | 去掉 `i`、先匹配「语言_区域」、接受前导 `/` |
> | 4 | `collectCueObjects` 对 `contentMap: { ko_KR: [...] }` 用 `push(v)` | **JSON 接口永远解析出 0 条字幕** | 展平一层数组，并支持 `{ cues: [...] }` 嵌套 |
>
> 其中 3、4 是这次顺带挖出来的老 bug：它们不会让面板消失，
> 但会让「中文抓成 cn」「JSON 轨一条都抓不到」，同样致命。

---

## 一、文件结构

```text
manifest.json     Manifest V3 声明（两个 world 各一套 content script）
utils.js          纯工具：时间戳 / 语言码 / 去重键 / 文件名 / 实体解码
parsers.js        多格式解析：parseWebVTT() / parseJSONCue() / detectFormat()
page-hook.js      MAIN world     —— 只做网络拦截 + 把响应正文原样搬运（零依赖、不解析）
content.js        ISOLATED world —— 解析 + UI / 扫描 / 汇总去重排序 / 覆盖度 / SRT 导出
README.md         本说明
README.txt        纯文本版快速上手
tests/
  regression.test.js   回归测试（Node vm 沙箱，26 项断言，不需要浏览器）
.gitignore        排除 .workbuddy-ai/ 等本地数据
```

> 装扩展时浏览器只读 `manifest.json` 里列出的那 4 个 js 文件，
> `tests/`、`README*`、`.gitignore` 都是仓库文档/测试，不影响扩展运行。

`manifest.json` 里两个 `content_scripts` 条目：

| 顺序 | world | 加载的文件 |
|---|---|---|
| 1 | `MAIN` | `page-hook.js` |
| 2 | `ISOLATED` | `utils.js` → `parsers.js` → `content.js` |

MAIN 放前面是为了让网络 hook 尽早装上，抢在页面自身脚本之前。

### ⚠️ 铁律：同一个文件名不能出现在两个 world 的 `js` 数组里

**Chrome / Edge 会按「文件名」对整个扩展的内容脚本去重。**
若 `utils.js` 同时出现在 MAIN 入口和 ISOLATED 入口的 `js` 数组里，
浏览器只会把它注入到**其中一个 world（先被处理的 MAIN）**，
另一个 world 里这个文件**根本不存在，且不会有任何显式报错**。

v3.0.0 正是踩了这个坑，症状是控制台只报一行：

```text
[MnetCC] 依赖未加载 —— utils.js: false | parsers.js: false
```

右下角什么面板都没有，看起来像「插件压根没生效」。

因此架构定为：

* **MAIN world 只放 `page-hook.js`，且该文件必须零依赖。**
  它只做三件事：判断 URL 是不是字幕资源 → 读出响应正文 → `postMessage` 原样转发。
  **它不解析、不保存、不需要任何工具函数。**
* **解析搬到 ISOLATED world**（由 `content.js` 调用 `parsers.js`）。
  这样 MAIN world 完全不需要 `utils.js` / `parsers.js`，
  两份共享代码就只需要存在一份，从根上消除了同名冲突。

> 以后新增文件时，先确认它**没有**和另一个 world 的任何一个文件同名。
> 同名即静默失效，排查成本很高。

`utils.js` 与 `parsers.js` 都是无副作用的纯函数模块，只注入 ISOLATED world。

---

## 二、架构

```text
                 Mnet Plus 页面
                       │
                       ▼
        page-hook.js（MAIN world，零依赖）
                       │
          拦截页面自己的 fetch / XHR
                       │
              判断 URL 是否字幕资源
                       │
        读出响应正文（clone，不消耗原响应）
                       │
    window.postMessage { type:"RAW", url, text }
                       │
                       ▼
       content.js（ISOLATED world）
                       │
              detectFormat(url, text)
                       │
             ┌─────────┴─────────┐
             │                   │
        JSON /cues            .cmft / .vtt
             │                   │
             ▼                   ▼
       parseJSONCue()      parseWebVTT()
             │                   │
             └─────────┬─────────┘
                       ▼
                Unified Cue
        { language, start, end, content, source }
                       │
                  去重 / 排序
                       │
              ┌────────┴────────┐
              │                 │
        字幕语言选择        覆盖度评估
              │                 │
              └────────┬────────┘
                       ▼
                   SRT 导出
```

**为什么解析放在 ISOLATED 而不是 MAIN？**
只有「拦截」必须待在 MAIN（否则看不到页面自己的请求）；「解析」不需要。
把解析挪到 ISOLATED 后，MAIN world 只剩一个零依赖文件，
既避免了同名去重，也让解析运行在扩展自己的隔离环境里，页面脚本无法干扰。

**关键原则：没有任何解析器直接生成 SRT，也没有任何解析器直接下载文件。**
所有来源一律先转成同一种内部结构，后面的 UI、去重、排序、导出完全不关心字幕最初来自哪里。

| | page-hook.js | content.js |
|---|---|---|
| world | `MAIN` | `ISOLATED` |
| 能否 hook 页面 `fetch` / `XHR` | ✅ | ❌（看不到页面自己的请求） |
| 是否解析响应正文 | ❌ 只搬运 | ✅ 解析成 Cue |
| 能否操作 DOM / 建按钮 | ✅ | ✅ |
| 是否持有 cue 库 | ❌ 只记已抓 URL | ✅ 唯一来源 |
| 是否筛选语言 | ❌ 全部保留 | ✅ 由用户选择 |
| 是否碰 Authorization / Cookie | 否 | 否 |

---

## 三、支持的两种字幕资源

### ① JSON Cue API

```text
https://api.mnetplus.world/media/v1/public/videos/{videoId}/captions/{captionId}/cues?language=zh_CN&displaySecond=34
```

返回 JSON，主体是 `contentMap`，每条形如：

```json
{ "content": "字幕内容", "displaySecond": 34, "displayDurationSecond": 3.2, "language": "zh_CN" }
```

解析后统一成 `{ language, start: 34, end: 37.2, content }`。
`start` 取 `displaySecond`，`end = start + displayDurationSecond`。

### ② `.cmft`（正文实为 WebVTT）

```text
https://video.cdn.mnetplus.world/mnetplus/videos/.../converted/..._zh_CN_caption_000000132.cmft
```

**扩展名是 `.cmft`，但 Response Body 是标准 WebVTT。**

> ⚠️ **绝不根据扩展名判断格式。** 一律读正文：
> 正文以 `WEBVTT` 开头 → 按 WebVTT 解析；正文是 `{`/`[` 开头 → 按 JSON 解析；
> 正文没有 `WEBVTT` 头但含 `-->` → 仍按 WebVTT 片段解析。

WebVTT 解析器（`parsers.js`）实际支持：

| 特性 | 支持 |
|---|---|
| UTF-8 BOM | ✅ |
| `WEBVTT` 头 + header 元数据（`Kind:` / `Language:` / `X-TIMESTAMP-MAP`） | ✅ |
| cue identifier（时间轴前一行标识） | ✅ |
| `start --> end` | ✅ |
| cue settings（`align:center position:50%`） | ✅ |
| 多行字幕 | ✅ |
| 空行分隔（也容忍**没有**空行，靠 `-->` 切分） | ✅ |
| `NOTE` / `STYLE` / `REGION` 块 | ✅ 整块跳过 |
| HTML/VTT 内联标签（`<b>` `<c.yellow>` `<v Name>` `<ruby>`） | ✅ 剥离 |
| WebVTT 实体（`&amp;` `&lrm;` `&#39;` `&#x27;`） | ✅ 解码 |
| `HH:MM:SS.mmm` 与 `MM:SS.mmm` | ✅ |
| 逗号小数点（`.srt` 风格的 `00:00:01,000`） | ✅ |
| 缺少 `WEBVTT` 头的分片文件 | ✅ |

### 语言从哪来（多级判定）

```text
1. cue.language（JSON 自带）
2. URL query 参数   ?language=zh_CN
3. URL 文件名       ..._zh_CN_caption_000000132.cmft
4. URL 路径段       /zh_CN/
5. 都判断不出 → unknown
```

实现见 `utils.js` 的 `extractLanguageFromUrl()`。**底层没有任何
`language === "zh_CN"` 这类硬编码**，所以将来出现 `zh_TW`、`es_ES`、`th_TH` 也无需改代码。

---

## 四、统一数据结构

```js
{
    language: "zh_CN",   // 语言代码
    start:    3.4,       // 开始（秒）
    end:      5.205,     // 结束（秒）
    content:  "字幕内容",  // 已剥离标签、已解码实体
    source:   "vtt"      // "vtt" | "json"
}
```

去重键 = `language + "|" + start + "|" + end + "|" + content`（`utils.js` 的 `cueKey()`）。

同一句字幕可能被请求多次（重试 / 播放器重载 / 拖动进度 / 同一 cue 出现在不同 chunk），
所以**不能** `cues.push()` 完事——必须先 `Map.set(key, cue)` 去重。

排序按 `start` → `end` → `content`。网络请求到达顺序 ≠ 字幕时间顺序。

---

## 五、语言与导出

| 下拉选项 | 行为 | 输出文件名 |
|---|---|---|
| **自动（跟随当前播放）** | 用播放器最近请求的那条字幕轨 | `标题_ko_KR.srt` |
| **全部语言（每语言一个文件）** | 已捕获的每种语言各导一份 | `标题_ko_KR.srt`、`标题_en_US.srt`、`标题_zh_CN.srt` |
| **某个具体语言** | 只导这一种 | `标题_zh_CN.srt` |

下拉框里的选项带条数，例如 `简体中文 (zh_CN) · 426 条`。

### VTT → SRT 的时间格式

```
WebVTT  00:00:03.400   →   解析成 3.4 秒   →   SRT 00:00:03,400
```

注意 WebVTT 用**句点**、SRT 用**逗号**。不是字符串替换，而是解析成秒后重新格式化。

---

## 六、安装

1. 打开 `edge://extensions/`（或 `chrome://extensions/`）。
2. 打开右下角「开发人员模式」。
3. 点「加载解压缩的扩展」，选择本文件夹（或整个文件夹拖进去）。
4. 打开 `https://www.mnetplus.world/`，按 `Ctrl + R` 刷新。

> 装过旧版请先**移除**旧扩展再重新加载；已装本扩展则点一次「重新加载 ↻」。
> 本次新增了 `utils.js` / `parsers.js` 两个文件，务必确认这两个文件也在文件夹里。

---

## 七、使用

1. 打开视频，**在播放器里选中你想要的那条字幕轨**。
2. 右下角出现控制面板：
   ```
   ┌─────────────────────────────┐
   │ 字幕语言  [ 自动（跟随当前播放）▼ ] │
   │ ☑ 自动扫描完整视频                │
   │      [清空] [重新扫描] [提取 CC 字幕] │
   └─────────────────────────────┘
   ```
3. 点「提取 CC 字幕」。
4. 状态框实时显示 `正在扫描 120 / 664 秒… 已找到 37 条字幕（简体中文 (zh_CN)）`。
5. 结束后自动下载 SRT，并在状态框列出**每条语言的条数、时间覆盖范围**。
6. 扫描中再次点按钮 = 取消；「清空」清缓存；「重新扫描」清缓存后立即重扫。

### ⚠️ 想抓另一种语言？必须先在播放器里切换

Mnet Plus **只会请求播放器当前选中的那一条字幕轨**。所以：

```text
播放器切到「韩语」→ 点「提取 CC 字幕」→ 拿到 标题_ko_KR.srt
播放器切到「中文」→ 再点一次        → 拿到 标题_zh_CN.srt（韩语缓存仍保留）
```

同一视频多次扫描的结果会**累积**（按 `语言+时间+内容` 去重）。
切换视频（SPA 内跳转，不刷新）会自动清空缓存。

### 覆盖度判断

导出时会统计每条语言的**最早 / 最晚字幕时间**，并与视频总长比对：

```text
· 简体中文 (zh_CN)： 426 条
   覆盖 00:00:03 → 00:11:04
· English (en_US)： 381 条
   覆盖 00:00:03 → 00:07:20
   ⚠ 字幕可能不完整（视频总长 00:11:04）
```

不会「假装成功」——末尾缺超过 15 秒就明确标出来。

---

## 八、调试

`utils.js` 顶部：

```js
const DEBUG = true;   // 发布时改成 false
```

打开后控制台会输出：

```text
[MnetCC] page-hook 已就绪
[MnetCC] fetch 命中: https://video.cdn.mnetplus.world/.../x_zh_CN_caption_000000132.cmft
[MnetCC] 字幕资源: https://...
[MnetCC]   格式: vtt | URL 语言: zh_CN | cues: 38
[MnetCC] 新增 cue: 38 总计: 38 语言: zh_CN
[MnetCC] content 已就绪
[MnetCC] === 开始 ===
```

遇到新视频格式时，看这四行就能定位：**有没有抓到 / 抓到什么 URL / 什么格式 / 解析出多少条 / 语言是什么**。

若出现「发现字幕资源，但无法识别格式」，说明正文既不像 VTT 也不像 JSON，
把日志里的 URL 和响应开头 200 字符贴出来即可定位。

---

## 九、错误提示（不会静默失败）

| 情况 | 提示 |
|---|---|
| **依赖未注入（加载故障）** | **右下角红框「⚠️ 扩展内部组件加载失败」+ 缺失文件名 + 修复步骤** |
| 页面没有 `<video>` | 「页面上没有找到 &lt;video&gt; 元素」 |
| 视频时长未加载 | 「视频时长还没加载完成，请等几秒」 |
| 一个 cue 都没抓到 | 「扫描完成，但没有捕获到任何字幕」+ 4 条排查建议 |
| 有资源但格式不识别 | 「⚠ 发现字幕资源，但无法识别格式」 |
| 选了某语言但没抓到 | 「该语言无字幕」+ 已捕获语言列表 + 切换字幕轨提示 |

**第一行是 v3.1.0 新增的。** 以前依赖缺失时 `content.js` 直接 `return`，
用户看到的是「点了没反应、面板也没有」，完全无法定位。
现在无论因为什么原因起不来，右下角都会出现一个红色面板，
上面直接写明 `utils.js` / `parsers.js` 哪个缺失，并提示「重新加载扩展 + 刷新页面」。

如果看到这个红框，**不用怀疑代码**，按面板上的两步做即可：
1. 扩展管理页点「重新加载」（🔄）
2. 回到页面按 F5

---

## 十、隐私

本扩展**不请求任何权限**（无 `permissions`，无 `background`）。

- 不读取、不保存 Authorization / Cookie / Token
- 不建立第三方服务器
- 不上传字幕

`page-hook.js` 只读取网页**自己已经请求回来**的 CC 响应体（`response.clone()`，
不消耗原始 Response），除此之外不做任何事。

---

## 十一、已知限制

- **只能抓到播放器实际请求过的字幕轨。** 见第七节。
- 扫描按「每 10 秒 seek 一次」触发，单次约 0.8 秒；11 分钟的节目约需 1 分钟。
  若只想要播放器已请求的部分，可取消勾选「自动扫描完整视频」，秒出。
- 若播放器改用 `<track>` 标签或原生 HLS 文字轨加载字幕，
  `window.fetch` / `XHR` 看不到这类请求，需要另行处理（目前 Mnet Plus 走 fetch）。
- 「全部语言」一次触发多个下载，浏览器可能弹「允许多文件下载」，在地址栏点允许即可。
  下载之间已错开 400ms。
- 某段视频本身没有 CC，则该段在 SRT 里为空。

---

## 十二、自测清单

```text
0.  【加载自检，先做这步】刷新页面后 Console 必须出现这两行：
      [MnetCC] page-hook 已就绪（MAIN world，零依赖）
      [MnetCC] content 已就绪
    若看到红色的「扩展内部组件加载失败」面板 → 扩展没注入进来，
    先解决加载问题，不要往下测字幕。见「九、错误提示」。
1.  加载扩展，扩展页无报错
2.  刷新 Mnet Plus 页面，Console 出现 [MnetCC] content 已就绪 / page-hook 已就绪
3.  打开有 CC 的视频
4.  右下角出现面板（下拉框 + 复选框 + 三个按钮）
5.  点「提取 CC 字幕」
6.  按钮立刻变「正在扫描…」        ← 若没变化，先看控制台
7.  视频自动 seek，进度数字在变
8.  字幕条数增加，下拉框出现语言
9.  扫到视频结尾，状态框列出条数与覆盖范围
10. 生成 SRT 并自动下载
11. 打开 SRT 检查时间轴与内容（VTT 来源的应已转成逗号毫秒）
12. 不刷新页面直接点另一个视频 → 状态框提示「检测到切换视频，字幕缓存已重置」
```

### 修改 manifest 后必须做的两件事

改完 `manifest.json`（尤其增删 `js` 数组）后：

1. 扩展管理页点「**重新加载**」（🔄）—— 只改磁盘上的文件、不点这个，
   浏览器仍然用缓存的旧 manifest，症状是「改了没生效」。
2. 回到页面按 **F5** —— 已经打开的标签页不会自动重新注入。

> 排查经验：如果「面板不出现」且 Console 有 `依赖未加载`，
> 99% 是某个文件名同时出现在两个 world 的 `js` 数组里被去重了（见第一节铁律）。

---

## 十三、测试

不需要浏览器，用 Node 跑（Node 18+）：

```bash
node tests/regression.test.js
```

当前 **26 项断言全部通过**，覆盖：

| 分组 | 内容 |
|---|---|
| `[0]` manifest 结构守卫 | **没有文件名跨 world 重复**、MAIN 入口只有零依赖的 `page-hook.js`、manifest 引用的文件都存在、`page-hook.js` 代码里不出现 `MnetCCUtils`/`MnetCCParsers` |
| `[1]` 依赖与初始化 | `utils.js`/`parsers.js` 是否真的挂上 `window`、UI 是否挂载、是否误入 load-failure |
| `[2]` `.cmft`/WEBVTT | 不靠扩展名判格式、`zh_CN_caption` 提取出 `zh_CN`（不是 `cn`）、时间戳、内联标签与实体清理 |
| `[3]` JSON Cue API | `contentMap` 的数组值被展平、`{cues:[...]}` 嵌套也被支持 |
| `[4]` SRT 时间 | 逗号毫秒、跨小时 |
| `[5]` RAW 链路 | `page-hook → content.handleRaw → cue 库 → UI`，含重复投递去重 |
| `[6]` 异常载荷 | 未知格式 / 空载荷都不抛异常 |

> `[0]` 那组是 v3.1.0 特意加的：当初「面板完全不出现」就是被同名文件跨 world
> 去重搞的，这条断言能在**不打开浏览器**的情况下直接把它拦下来。

---

## 十四、免责声明

- 本工具只读取**你自己的浏览器已经收到**的字幕数据（页面本来就把它渲染成屏幕上的字幕），
  在本地转成 SRT，**不破解任何加密、不绕过任何付费或权限校验、不请求任何额外接口**。
- 不申请任何浏览器权限，不包含后台脚本，不向任何服务器发送数据。
- 请仅用于**个人已获授权内容的备份、学习与研究**（例如保存自己订阅节目的字幕做语言学习）。
  使用时请自行遵守 Mnet Plus 的服务条款与所在地区法律，**不要二次分发受版权保护的字幕内容**。
- 作者不对使用本工具产生的任何后果负责。
