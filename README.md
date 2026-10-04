# Mnet Plus CC 字幕提取器

在 Mnet Plus（`mnetplus.world` / `www.mnetplus.world`）视频页面拦截官方 CC 字幕，
自动扫描整部视频并导出 `.srt`。**支持任意语言**，语言列表从接口实际返回的数据动态生成。
全部处理在本地完成，**不上传任何字幕或登录信息**。

---

## 一、文件结构

```text
manifest.json     Manifest V3 声明（两个 world 的 content script）
page-hook.js      MAIN world     —— 只负责拦截字幕接口，不筛选语言
content.js        ISOLATED world —— 语言选择 UI / 扫描 / 去重 / 导出
README.md         本说明
```

`manifest.json` 里两个 `content_scripts` 条目的顺序不能颠倒：
`content.js` 在前（先注册 `message` 监听），`page-hook.js` 在后。

---

## 二、架构

```text
Mnet Plus 页面
      ↓  页面自己发起请求
page-hook.js（MAIN world）
      ↓  拦截 /captions/{id}/cues（不限语言）
      ↓  读取 contentMap，保留每条的 language（不硬编码任何语言代码）
      ↓  window.postMessage({ type: "CUES", cues, languages })
content.js（ISOLATED world）
      ↓  按 language 分桶缓存 + 去重
      ↓  动态生成语言下拉框
      ↓  点击按钮 → 自动 seek 全视频，触发各时间段字幕请求
      ↓  按用户选择的语言汇总 + 排序 + 相邻重叠裁剪
      ↓  生成 SRT（带 BOM）→ 自动下载
```

两个世界各司其职：

| | page-hook.js | content.js |
|---|---|---|
| world | `MAIN` | `ISOLATED` |
| 能否 hook 页面 `fetch` / `XHR` | ✅ | ❌（看不到页面自己的请求） |
| 能否操作 DOM / 建按钮 | ✅ | ✅ |
| 是否筛选语言 | ❌ 全部保留 | ✅ 由用户选择 |
| 是否碰 Authorization / Cookie | 否 | 否 |

旧版（1.0.0）把「拦截 + UI」全塞进一个 MAIN world 脚本，导致
`scanVideo()` 里引用了 `createUI()` 的局部变量 `button`，
点击时直接抛 `ReferenceError`——这就是「按钮能出现但点了没反应」的真正原因。

---

## 三、语言处理

**底层不写死任何语言。** `page-hook.js` 里没有 `language === "zh_CN"` 这类判断，
只要求 `cue.language` 是非空字符串；语言种类完全由接口返回的数据决定。
所以将来出现 `zh_TW`、`es_ES`、`th_TH`、`id_ID` 等新语言，**不需要改代码**。

`content.js` 里的 `LANGUAGE_NAMES` 只是给常见语言加个好看的中文/本地化显示名，
未收录的语言会回退成 `XX (xx_XX)` 形式，不影响功能。

### 下拉框三个选项

| 选项 | 行为 | 输出文件名 |
|---|---|---|
| **自动（跟随当前播放）** | 用播放器最近请求的那条字幕轨 | `标题_ko_KR.srt` |
| **全部语言（每语言一个文件）** | 已捕获的每种语言各导一份 | `标题_ko_KR.srt`、`标题_en_US.srt`、`标题_zh_CN.srt` |
| **某个具体语言** | 只导这一种 | `标题_zh_CN.srt` |

下拉框里的语言选项带条数，例如 `简体中文 (zh_CN) · 426 条`。

---

## 四、安装

1. 打开 `edge://extensions/`（或 `chrome://extensions/`）。
2. 打开右下角「开发人员模式」。
3. 把本文件夹**整个**拖进去，或点「加载解压缩的扩展」选择本文件夹。
4. 打开 `https://mnetplus.world/` 或 `https://www.mnetplus.world/`，按 `Ctrl + R` 刷新。

> 若之前装过 1.0.0 版本，请先**移除**旧扩展再重新加载。
> 更新本版本后点一次「重新加载 ↻」即可。

---

## 五、使用

1. 打开视频，**在播放器里选中你想要的那条字幕轨**。
2. 右下角出现白底黑字的「字幕语言」下拉框 + 「提取 CC 字幕」按钮。
3. 选好语言 → 点「提取 CC 字幕」。
4. 扫描中状态框实时显示：`正在扫描 120 / 664 秒… 已找到 37 条字幕（简体中文 (zh_CN)）`。
5. 结束后自动下载 `视频标题_zh_CN.srt`。
6. 扫描过程中**再次点击按钮可取消**；「清空」按钮可清掉本地缓存。

### ⚠️ 想抓另一种语言？必须先在播放器里切换

Mnet Plus **只会请求播放器当前选中的那一条字幕轨**。所以：

```text
播放器切到「韩语」→ 点「提取 CC 字幕」→ 拿到 标题_ko_KR.srt
播放器切到「中文」→ 再点一次        → 拿到 标题_zh_CN.srt（韩语的缓存仍保留）
```

同一视频多次扫描的结果会**累积**（按 `语言+时间+内容` 去重），
所以想一次性导出多语言，就是：逐个切换播放器语言 → 每次点一下按钮 → 最后选「全部语言」导出。
切换视频时会自动清空缓存，不用手动处理。

---

## 六、自测清单

```text
1. 加载扩展，无报错
2. 刷新 Mnet Plus 页面
3. 打开有 CC 的视频
4. 右下角出现下拉框 + 按钮
5. 点按钮
6. 按钮立刻变成「正在扫描…」        ← 若这步没变化，先看控制台
7. 视频自动 seek，进度数字在变
8. 字幕条数不断增加，下拉框出现语言
9. 扫描到视频结尾
10. 生成 SRT 并自动下载
11. 打开 SRT，检查时间轴与字幕内容
```

控制台排查（F12 → Console）：

- 点击后应出现 `[MnetPlus CC] export started`
- 若一直没有字幕，在 Console 里搜 `/cues`，确认真实请求 URL 是否含 `/captions/` 与 `/cues`
- 若下拉框一直是空的，说明接口响应里 `contentMap` 的每条 cue 没有 `language` 字段，
  把接口响应贴出来即可定位

---

## 七、隐私

本扩展**不请求任何权限**（无 `permissions`，无 `background`）。

- 不读取、不保存 Authorization / Cookie / Token
- 不建立第三方服务器
- 不上传字幕

`page-hook.js` 只读取网页自己已经请求回来的 CC 响应体，除此之外不做任何事。

> 关于 `background.js`：原方案里它是「可选」的，用于走 `chrome.downloads` 下载。
> 本版本**刻意不加**——因为那需要申请 `downloads` 权限，扩展更新时会触发
> 权限变更提示甚至被浏览器暂时停用；而 content script 里用
> `Blob + <a download>` 已经足够可靠。少一个权限，少一类故障。

---

## 八、已知限制

- 扫描是按 `每 10 秒 seek 一次` 触发的，单次约 0.8 秒；一集 11 分钟的节目约需 1 分钟。
- 只能抓到**播放器实际请求过**的字幕轨，见第五节的说明。
- 「全部语言」一次会触发多个下载，Chrome / Edge 可能弹出「允许多文件下载」提示，
  在地址栏点允许即可。下载之间已错开 400ms 以降低被拦概率。
- 某段视频本身没有 CC，则该段在 SRT 里为空。
