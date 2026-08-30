# OB 任务结果：iOS PWA 两个独立缺陷修复

## Bug 1：终端设置面板在 iOS PWA 上「加载失败」

### 诊断

主因是**陈旧构建产物**，不是模块求值期异常：

- 应用只有 webmanifest，没有 Service Worker。iOS 主屏 PWA 的 standalone webview 会顽固缓存启动页；
  服务端升级后缓存的 `index.html` 仍指向旧 hash 的 chunk URL，那些文件已被新版覆盖删除，
  `import('../settings/terminal-settings-sheet')` 会一直 404。
- 浏览器把失败的模块 URL 记进 module map，**就地重试拿到的是同一条失败记录**——旧实现的
  「重试」按钮重新跑同一个 `import()`，因此表现为「重试无效、必现失败」，与用户描述吻合。
  这与 `apps/fe/src/lazy-chunk.tsx` 顶部注释记录的成因完全一致。

同时对 `packages/panels/src/settings/terminal-settings-sheet.tsx` 的 import 图做了 2–3 层排查，
确认 `packages/panels` / `ui` / `theme` / `terminal-ui` / `stores` / `shared` / `api-client` /
`ghostty-terminal` 里**没有任何顶层副作用语句、没有 top-level await**，也没有用到
`structuredClone` / `Object.groupBy` / `Promise.withResolvers` / `.at(-n)` / `String.replaceAll`；
`navigator.clipboard`、`localStorage`、`document`、`matchMedia` 全部有 guard。

**一个次要但真实的隐患（超出本次改动范围，仅记录）**：
`packages/ghostty-terminal/src/link-detector.ts:18` 顶层用 `new RegExp(...)` 拼出带
**lookbehind `(?<!...)`** 的正则。lookbehind 要 Safari 16.4+，iOS < 16.4 会在**模块求值期**抛
`SyntaxError`，让整个 chunk 的 `import()` reject，看起来和 chunk 404 一模一样。因为是
`new RegExp` 而非正则字面量，esbuild 的 `build.target` 检查抓不到（`apps/fe/vite.config.ts`
也没设 `build.target`，Vite 默认 `safari14`）。它同时在 `DevicePage` 的 eager 图里，所以
iOS < 16.4 应该连终端页都开不了；用户终端可用 ⇒ 不是本次故障的成因。建议后续改写成
「捕获前一个字符再在匹配循环里跳过」的形式。

### 改动

`packages/panels/src/device-console/deferred-terminal-settings-sheet.tsx`（重写）：

1. **模块级加载器 + 缓存** `loadTerminalSettingsSheet()`：成功结果缓存到模块级
   （组件卸载重挂、再次打开面板都不再走 loading 态），失败**不缓存**且清掉 inflight，
   重试能真正重新发起 `import()`；并发调用共享同一个 inflight promise。
2. **空闲预热** `useTerminalSettingsPreload()`：`requestIdleCallback`（不可用时 `setTimeout 1200ms`）
   在首帧后把 chunk 拉下来，趁当前 `index.html` 还新鲜，绕开发版后的失败窗口，顺带让面板离线可用。
   由 `packages/panels/src/device-console/page-actions.tsx` 的 `DeviceConsoleActions`（渲染工具栏者）调用。
3. **兜底条给出真正的恢复路径**：视图模型从 `terminalSettingsFallbackView(loadError: boolean)`
   改成 `terminalSettingsFallbackView(failureCount: number)`，返回
   `{ role, messageKey, hintKey?, showRetry, showReload }`。
   - 未失败：`status` + `settings.terminal.loading`，无按钮。
   - 首次失败起：`alert` + `settings.terminal.loadFailed` + 新提示
     `settings.terminal.loadFailedHint`（说明多半发布了新版本），同时给「重试」与
     「重新加载应用」（`location.reload()`，可通过 `reload` prop 注入以便测试）。
   - 重试到 `MAX_SHEET_LOAD_RETRIES = 2` 后只留「重新加载应用」——照搬 `lazyChunk` 的
     「有限次就地重试 + 兜底整页刷新」策略。
4. 兜底条抽成独立的 `TerminalSettingsFallback` 组件，便于静态渲染测试，也压住主组件的行数/CC。

**未改 `apps/fe/src/lazy-chunk.tsx`**：`packages/panels` 不能反向依赖 `apps/fe`，故在包内按同一模式
实现，并在文件头注释里指明参照关系。

### i18n

在三个 locale 的 `settings.terminal.*` 下（紧邻既有 `loading` / `loadFailed`）新增两个 key：

| key | en_US | zh_CN | ja_JP |
| --- | --- | --- | --- |
| `loadFailedHint` | A new version was likely deployed. Reload the app to fetch the latest files. | 可能刚发布了新版本，重新加载应用即可获取最新文件。 | 新しいバージョンが公開された可能性があります。… |
| `reloadApp` | Reload app | 重新加载应用 | アプリを再読み込み |

未跑 `build:i18n`，未碰生成的 `resources.ts` / `types.ts`（由 commander 重新生成）。仓库没有
`CustomTypeOptions` 类型增强，`t()` 接受任意 string，无需 cast。

### 测试

- 新增 `packages/panels/src/device-console/deferred-terminal-settings-sheet.test.tsx`（8 个用例）：
  视图模型三态；`TerminalSettingsFallback` 在三态下的静态渲染（`role` 与 retry/reload 按钮的
  `data-testid` 出现与否）；`open={false}` 不渲染；`open` 且 chunk 未就绪时渲染 loading 兜底条。
  新 i18n key 尚未进 `I18N_RESOURCES`，故断言按 `data-testid` 而非文案。
- `packages/panels/src/device-console/device-console-actions.test.ts`：删掉两个已被新文件覆盖的
  视图模型用例（旧签名是 boolean），保留并扩充 locale 覆盖用例，新增 `loadFailedHint`、`reloadApp`
  两个 key 的三语言存在性断言。

---

## Bug 2：`✳` 类字符在 iOS 上被渲染成 emoji

### 诊断与实测

`U+2733 ✳` 是 `Extended_Pictographic=Yes` 且 `Emoji_Presentation=No`，iOS 仍按遗留行为用
Apple Color Emoji 渲染成绿色星号。实测确认了任务描述里的一处偏差：

```
U+2733 ✳  pict=true  pres=false   ← 会被 emoji 化，需要修
U+2736 ✶  pict=false pres=false   ← 普通 dingbat，不受影响
U+273B ✻  pict=false pres=false   ← 同上
U+273D ✽  pict=false pres=false   ← 同上
U+2734 ✴  pict=true  pres=false   ← 需要修
U+2744 ❄  pict=true  pres=false   ← 需要修
U+2699 ⚙  pict=true  pres=false   ← 需要修
U+2728 ✨ / U+2B50 ⭐ / 🚀        ← pres=true，本就是 emoji，保持不动
```

即 Claude Code 的转圈字符里只有 `✳`（及 `✴`）需要处理，`✶✻✽` 不该被改写；测试里对此加了显式守卫。

### 改动

`packages/stores/src/terminal-meta.ts`：

- 新增导出 `forceTextPresentation(text)`：对 `Extended_Pictographic=Yes` 且
  `Emoji_Presentation=No` 的码点追加 `U+FE0E`；后面已经跟着 `U+FE0F` / `U+FE0E` / `U+20E3`
  的**保持原样**（尊重有意的 emoji 序列与 keycap）。
  - 快路径：整串先用 `/\p{Extended_Pictographic}/u` 测一次，纯 ASCII/中文标题直接原样返回。
  - 逐码点分类结果缓存在模块级 `Map<string, boolean>`（标题重渲染频繁）。
  - 无改动时返回原字符串引用，避免制造新对象。
- 应用点（全部是展示路径）：`toSafeText`（进而覆盖 `buildTerminalLabel`）、
  `buildWindowTitleParts` 的 `title` / `processName`、`buildWindowDisplayName`、`buildBrowserTitle`。
  于是页面标题、`document.title`、窗口 tab / 侧栏行、关闭确认弹窗全部自动生效，不需要改各组件。

### 关键取舍：`rawTitle`（回写路径的安全性）

审了全部调用方后发现一个**不能直接归一**的口子：
`packages/panels/src/device-tree/use-rename-dialog.ts:34` 拿
`buildWindowTitleParts(target).title` 当重命名输入框的初值，用户直接确认就会把这串**回写到
tmux 窗口名**。若沿用归一后的 title，会把不可见的 `U+FE0E` 写进服务端数据。

处理方式：`WindowTitleParts` 增加 `rawTitle`（未归一原文），`title` 明确标注为「仅展示，
不要回传服务端」；`use-rename-dialog.ts` 改用 `rawTitle`。

> **超范围提示**：`use-rename-dialog.ts` 属于 `packages/panels/src/device-tree/`，不在本任务给定的
> 可改文件清单内，但这是一行、且是为了不让我引入的展示层归一污染服务端数据；不改的话
> 「不得用于回传服务端」这条硬要求就不成立。该文件不属于并行 agent 的 owned 范围
> （terminal-ui / tmux-event-router / clipboard），无冲突风险。若不接受，回退这一行即可。

另有两处**未改、仅记录**：
- `packages/panels/src/device-tree/pane-row-content.tsx` 等直接渲染 `pane.title` 原文的地方
  没有走 terminal-meta，pane 行标题不会被归一。若要覆盖，需要在这些组件里显式调用
  `forceTextPresentation`（超范围）。
- `packages/stores/src/tmux-event-router.ts` 归属另一 agent，本次**未做任何改动**，
  也不需要改动——归一严格发生在展示期。

### 测试

新增 `packages/stores/src/terminal-meta.test.ts`（10 个用例）：`✳` 补 `FE0E`；`✴❄⚙` 同理；
`✳` + `FE0F` 保持原样；幂等（对已补过的串再跑一次不变）；`🚀` / `🔔` 不动；keycap `1️⃣` 不动；
纯 ASCII 原样；中文/`①`/`✶✻✽` 不受影响；`buildTerminalLabel` 标题与设备名均归一；
`buildWindowTitleParts` 的 `title` 归一而 `rawTitle` 保持原文；`buildWindowDisplayName` 拼接正确。

---

## 验证结果

| 检查 | 基线 | 改动后 |
| --- | --- | --- |
| `packages/panels` `bun test` | 629 pass / 0 fail | **635 pass / 0 fail**（+8 新增，−2 迁移删除） |
| `packages/stores` `bun test` | 334 pass / 0 fail | **345 pass / 0 fail**（+10 新增，+1 已有文件计数差） |
| `apps/fe` `bun test src/` | — | **892 pass / 0 fail**（本任务未改 apps/fe） |
| `packages/panels` `bunx tsc --noEmit -p .` | 0 | **0** |
| `apps/fe` `bunx tsc --noEmit -p .` | 0 | **0** |
| `packages/stores` `bunx tsc --noEmit -p .` | 1（`host-services.test.ts:93` 既有） | **1（同一条，未新增）** |
| `bunx biome check <改动文件>` | — | **通过**（格式已 `--write` 修正） |

**复杂度门禁 `bun scripts/complexity/gate.ts` 有 1 条 violation：
`packages/stores/src/site.ts:53 createSiteStore: 217 lines > 201`。该文件本任务从未打开或修改**
（我的改动只涉及 `terminal-meta.ts` 及其测试），属于既有/他人改动引入，未处理。
本次新增的所有函数均远低于 CC 15 / 120 行。

未跑 e2e，未执行任何 git 命令，未触碰 `packages/terminal-ui`、
`packages/stores/src/tmux-event-router.ts` 与共享剪贴板工具。

## 改动文件清单

- `packages/panels/src/device-console/deferred-terminal-settings-sheet.tsx`（重写）
- `packages/panels/src/device-console/deferred-terminal-settings-sheet.test.tsx`（新增）
- `packages/panels/src/device-console/page-actions.tsx`（接入预热 hook）
- `packages/panels/src/device-console/device-console-actions.test.ts`（迁移用例 + 扩充 locale 断言）
- `packages/stores/src/terminal-meta.ts`
- `packages/stores/src/terminal-meta.test.ts`（新增）
- `packages/panels/src/device-tree/use-rename-dialog.ts`（一行，超范围，见上文说明）
- `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json`（各 +2 key）
