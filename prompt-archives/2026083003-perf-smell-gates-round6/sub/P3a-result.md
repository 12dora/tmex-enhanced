# P3a 结果 — fe 包体积：Markdown 懒加载、设置页标签分块、CodeViewer 高亮护栏

## 1. CodeViewer 高亮护栏（X4 item 1）

`packages/panels/src/code-viewer/code-viewer.tsx`：`highlightCode` 加两条体积线，超线只渲染转义纯文本。

- `AUTO_DETECT_LIMIT = 64 KiB`：未知/不支持语言（走 `hljs.highlightAuto`）超过即不做自动识别。
- `HIGHLIGHT_LIMIT = 512 KiB`：已知语言（`hljs.highlight`）超过也退回纯文本（网关文本上限 2 MiB）。
- `try/catch` 与转义逻辑不动，行号栏/DOM 结构不变。

实测（`bun test`，panels 包内一次性脚本，跑完已删）：

| 场景 | 之前 | 之后 |
|---|---:|---:|
| 1 MiB 未知语言（`highlightAuto`，产出 2.52 MiB HTML） | 9,537 ms | 11 ms（渲染整条 CodeViewer） |
| 2 MiB `.ts`（>512 KiB 退回纯文本） | ~33 ms 高亮 + 巨量 HTML | 9 ms |
| 36 KiB `.ts`（线下，仍高亮） | — | 23 ms |

回归测试：新增 `packages/panels/src/code-viewer/code-viewer.test.tsx`（4 例）——未知扩展名小文件仍有 `hljs-` 标记；未知扩展名 >64 KiB 无 `hljs-` 且输出转义文本；已知语言 >64 KiB 仍高亮；已知语言 >512 KiB 退回纯文本。

取舍：超线的大文件失去语法着色（X4 已列为已知风险），换来主线程不再被卡住 8–15 秒。

## 2. Markdown 懒加载 + 设置页标签分块（X4 item 2）

- `apps/fe/src/pages/FilePage.tsx`：`MarkdownPreview` 改为 `React.lazy(() => import('@tmex/panels/markdown'))`，只有 markdown 分类的文件才会触发下载；`Suspense` fallback 复用页内已有的 `CenteredMessage` + `Loader2`（与加载态一致）。
- `packages/panels/src/settings/version-tab-sections.tsx`：变更日志的 `MarkdownPreview` 同样改 `React.lazy`（相对路径动态 import），fallback 是行内小 spinner。
- `apps/fe/src/pages/SettingsPage.tsx`：七个标签面板全部改成一个 `React.lazy` 一块，整块面板区包一层 `Suspense`（行内 spinner）。`TerminalSettingsTab` 也从静态 `@tmex/panels/settings` 改为动态 import。`React.lazy` 会缓存已解析模块，首次加载后切换仍是同步的。
- `apps/fe/src/main.tsx` + `packages/panels/package.json`：新增窄导出 `@tmex/panels/settings/events` → `./src/settings/settings-events-init.tsx`，main.tsx 由此取 `SettingsEventsInit`，入口不再拉整个 settings barrel（barrel 里的微信登录带 `qrcode.react`）。settings barrel 本身未改（其它 tab 仍从 barrel 取，现在都在异步块里）。

`packages/panels/src/markdown/index.ts` 没有改动：FilePage 直接动态 import 该 barrel 就已经把整条 Markdown 链推进异步块，另加一个 lazy 出口属于多余抽象。

## 3. 构建对比（`bunx vite build`，production）

| 块 | before | after |
|---|---:|---:|
| 入口 `index-*.js` | 1,351.93 kB / gzip 420.02 kB | 1,338.83 kB / gzip 415.00 kB |
| 入口 CSS | 183.14 kB / gzip 33.58 kB | 144.34 kB / gzip 22.98 kB |
| `FilePage` | 149.49 kB / gzip 48.59 kB（**静态**依赖 markdown 块） | 150.23 kB / gzip 48.89 kB（markdown 改为 `import()`） |
| `SettingsPage` | 118.21 kB / gzip 25.12 kB | **9.00 kB / gzip 3.34 kB** |
| `markdown-preview` | 454.96 kB / gzip 137.30 kB（随 FilePage/SettingsPage 一起加载） | 433.21 kB / gzip 128.92 kB（只在 markdown 文件 / 变更日志时加载） |
| 新增 markdown CSS（katex） | 含在入口 CSS 内 | 独立 `markdown-preview-*.css` 29.3 kB |
| 新增 hljs 主题 CSS | 含在入口 CSS 内 | 独立 `hljs-terminal-theme-*.css` 9.5 kB |
| 设置页各标签 | 都在 SettingsPage 块内 | general 2.07 / notification 4.08 / ai 0.42 / devices-and-files 0.50 / version-tab 3.58 / version-tab-sections 4.67 / remote-access 49.66 / nodes-tab 84.70 / weixin 28.92 / search 20.10 / files-tab 19.23 / terminal-sheet 19.61 kB |

直接证据：

- 入口块 `index-dBfQ3bzb.js` 中 `qrcode` 相关字符串命中数 **0**（qrcode 现在只在 `weixin-accounts-tab-*.js` 与一个共享 settings 块里）。
- `FilePage-*.js` 的静态 import 只剩入口块与几个小块，markdown 改为 `import("./index-CjrQyWdx.js")`（markdown barrel stub，0.29 kB，再拉 markdown-preview）。
- 打开代码/纯文本文件、进设置页首屏，各自省下约 **129 KiB gzip** 的 Markdown 链；首屏 CSS 少 **10.6 KiB gzip**。

注意：after 构建里同时含有其它并行 agent 的在途改动（agent chat、ghostty、sidebar sessions 等），入口 JS 的 −13.1 kB raw / −5.0 kB gzip 不能全部记在本任务名下；qrcode 命中数与 SettingsPage / markdown 静态依赖的变化是可直接归因的。构建产物只落在 gitignore 的 `apps/fe/dist/`，`git status` 里没有生成文件变动（`packages/shared/src/i18n/*` 的改动来自其它 agent）。

## 4. 改动文件

- `packages/panels/src/code-viewer/code-viewer.tsx`
- `packages/panels/src/code-viewer/code-viewer.test.tsx`（新增）
- `packages/panels/src/settings/version-tab-sections.tsx`
- `packages/panels/package.json`（新增 `./settings/events` 导出）
- `apps/fe/src/pages/FilePage.tsx`、`apps/fe/src/pages/FilePage.test.tsx`
- `apps/fe/src/pages/SettingsPage.tsx`、`apps/fe/src/pages/SettingsPage.test.tsx`
- `apps/fe/src/main.tsx`（仅 `SettingsEventsInit` 的导入路径）

净增约 +90 行（其中 41 行是新增测试，其余多为 `lazy()` 包装与 Suspense 结构）。

测试适配：`renderToStaticMarkup` 对 lazy 组件首帧只出 fallback，因此 FilePage 的 markdown 用例与 SettingsPage 的面板用例改成「渲染一次 → 等模块解析 → 再渲染断言」，并顺带断言首帧确实只有 fallback（即面板确实被拆块）。

## 5. 验证

- `cd apps/fe && bun test src/`：**866 pass / 0 fail**（基线 866/0）
- `cd packages/panels && bun test`：**584 pass / 0 fail**（基线 580/0，+4 为新增 code-viewer 用例）
- `bunx tsc --noEmit -p .`：apps/fe **0 错**、packages/panels **0 错**（基线均 0）
- `bunx biome check <改动文件>`：仅 `apps/fe/src/main.tsx:85 lint/correctness/useExhaustiveDependencies` 一条，已用 HEAD 版本复现确认为既有问题（与本次仅改一行 import 无关），未动。
- 未跑 Playwright e2e（按要求）。

## 6. 风险 / 遗留

- 大文件失色见第 1 节（有意取舍）。若日后要恢复，正确做法是 worker 里高亮 + 行虚拟化，不在本轮范围。
- 设置页每个标签首次打开多一次网络往返（本地网关，块都很小；nodes/remote-access 两块较大但本来就是独立块）。首帧 fallback 是一个居中 spinner，不改变已加载后的布局。
- `@tmex/panels/settings/events` 是新增导出路径；settings barrel 仍导出同名符号，老引用不受影响。
