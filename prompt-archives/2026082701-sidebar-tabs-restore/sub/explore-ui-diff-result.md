未写文件：请求中未提供 `-o` 路径，且当前工作区为只读。本次未修改任何文件。以下为审计结果。

# 465c94b~1..HEAD 前端 UI/UX 变化

已排除已知的 `465c94b`、`0706f73`、`aa69374`。`apps/fe/src/app.css` 无变化；`packages/theme` 的字体文件移动没有内容变化，仅增加了 CJK fallback。

| Commit | 用户可见变化（之前 → 之后） | 类型 | 当前归属 | 回退估算 |
|---|---|---|---|---|
| `86aa974` | 终端分屏拖拽条、拖拽指示线、Pane 标题等样式恢复；移动端连接后会重新同步 stacked layout 尺寸 | 样式＋功能 | `apps/fe/src/index.css`；`packages/terminal-ui/src/components/SplitTerminalArea.tsx`；`packages/panels/src/device-console/use-pane-size-sync.ts` | S |
| `1aa6743` | Pane 菜单按钮不再被读屏器描述成 Monitor，而是正确描述为 Pane menu | 无障碍功能 | `packages/panels/src/device-tree/pane-row.tsx` | S |
| `c7ab0b5` | 普通 UI 文本和元素不再被意外选中或拖拽；输入框、可编辑区域、终端仍可选中文本 | 样式／交互 | `apps/fe/src/index.css` | S |
| `df7c891` | 点击终端快捷键捕获按钮后，Safari/WKWebView 等环境也能立即进入捕获状态 | 功能 | `packages/panels/src/settings/TerminalShortcutsEditor.tsx` | S |
| `cd6296e` | 路由指向已关闭或不存在的窗口时，之前可能停留在空白状态；现在等待短暂稳定期后自动切到有效窗口和 Pane | 功能 | `packages/panels/src/device-console/selection-recovery.ts`、`use-pane-route-reconciliation.ts` | S |
| `ce8231a` | 中文界面字体 fallback 从通用 sans-serif 优先改为 PingFang SC、Microsoft YaHei | 样式 | `packages/theme/src/themes.css` | S |
| `8b3fa54` | 终端设置面板改为延迟加载；加载期间显示“Loading terminal settings…”，加载失败显示重试和关闭操作 | 功能／UX | `packages/panels/src/device-console/page-actions.tsx` | S |
| `ed388f8` | 远端尺寸与本地待同步尺寸冲突时，之前可能长期忽略远端变化；现在超时后重试并应用权威尺寸 | 功能 | `packages/panels/src/device-console/use-pane-size-sync.ts`；`packages/terminal-ui/src/components/useTerminalResize.ts` | M |
| `53d2f45` | 只有 `windowId` 的路由之前可能跳到其他窗口；现在保持在 URL 指定的窗口，并选择该窗口的有效 Pane | 功能 | `packages/panels/src/device-console/selection-recovery.ts`、`use-pane-route-reconciliation.ts` | S |
| `a6c24d2` | 终端启动时从黑色全屏遮罩改为主题化 spinner；加载时不显示 Retry，只有错误状态才显示重试 | 样式＋交互 | `packages/terminal-ui/src/components/Terminal.tsx`；`hooks/useTerminalBootSurface.ts` | M |
| `f860a21` | 快照恢复后终端之前可能停留在快照采集尺寸，导致换行错误；现在重新应用最后一次权威布局尺寸 | 功能 | `packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts`；`useTerminalResize.ts` | S |
| `0f85994` | 从后台双缓冲、重建后等待绘制再切换，改为单一 `TerminalSurface` 直接写入原始字节；实时输出更直接，但快照重建可能可见闪烁，也不再保留 rebase 时的滚动距离 | 功能／渲染行为 | `packages/terminal-ui/src/components/Terminal.tsx`、`TerminalSurface.tsx`、`terminal-snapshot.ts`、相关 hooks | L |
| `55400f2` | 快照内容统一 CRLF 后再写入，修复整屏换行阶梯问题；恢复失败不再永久停留在 Loading 状态 | 功能 | `packages/terminal-ui/src/components/terminal-snapshot.ts`、`TerminalSurface.tsx`；启动状态由 `useTerminalBootSurface.ts` 管理 | M |
| `6559b06` | 终端快照恢复后重新应用历史中的鼠标模式，TUI 的鼠标悬停、滚轮等操作不再因恢复而失效 | 功能 | `packages/terminal-ui/src/components/terminal-snapshot.ts`、`TerminalSurface.tsx` | S |
| `c9d738d` | canonical history 页面边界补充换行，修复历史页之间的文本粘连 | 功能 | `packages/terminal-ui/src/components/terminal-snapshot.ts`、`TerminalSurface.tsx` | S |
| `493bb80` | 移动端判断改用 `matchMedia('(min-width: 48rem)')`，修复首帧误判桌面端及窗口变化后状态不同步 | 功能 | `packages/ui/src/hooks/use-mobile.ts`；影响 `packages/ui/src/components/sidebar/sidebar-provider.tsx`、`packages/panels/src/device-console/page-actions.tsx` | S |
| `68eaa86` | 打开终端文件链接失败时，之前静默失败；现在显示错误通知 | 功能 | `packages/terminal-ui/src/components/hooks/useTerminalFileLinks.ts` | S |
| `4f540f3` | Files 页面和文件设置页面不再共用冲突的 roots 查询缓存，减少切换后列表为空或数据形状错误 | 功能 | `packages/panels/src/settings/files-tab.tsx` | S |
| `973b011` | Markdown 中的本地图片 URL 之前缺少 `rootId`，可能无法加载；现在按文件所在 root 生成正确 raw URL | 功能 | `apps/fe/src/pages/FilePage.tsx`；`packages/panels/src/markdown/markdown-preview.tsx` | M |
| `973b011` | Watch 对话框的时间字段之前使用浏览器 locale；现在遵循站点语言设置 | 功能／本地化 | `packages/panels/src/watch/watch-dialog.tsx` | S |
| `c108a69` | Agent 并发提交之前可能创建重复 session，首屏历史加载也可能覆盖正在到达的消息；现在使用 single-flight 并合并 in-flight 消息 | 功能 | `packages/panels/src/agent/use-agent-tab-model.ts`、`agent-tab.tsx`、`agent-composer.tsx` | M |
| `80c3591` | 对未提供 server-side selection 能力的嵌入式宿主，停止 active Pane 自动跟随；默认 tmex WebSocket transport 不受影响 | 条件性功能 | `packages/panels/src/device-console/use-pane-active-follow.ts` | S |

## 已被后续提交覆盖的中间行为

- `8b3fa54` 引入的 `TerminalGeneration` 后台双缓冲、rebase 后保留滚动位置等行为，已由 `0f85994` 删除。
- `e5ec121` 对该双缓冲重建过程增加的时间切片和边界保护，也随 `TerminalGeneration` 删除。
- 如果目标是恢复这套双缓冲终端渲染，而不是简单回退单个提交，预计为 L。

## 仅嵌入宿主或默认关闭，不计入主 UI 回退清单

以下提交增加了宿主可配置能力，但默认 tmex 前端行为保持不变：

- `fd682a9`：`features.agentUi=false` 时隐藏 Agent 入口。
- `374d17a`：`features.filesUi=false` 时隐藏 Files 相关入口。
- `1ac11a8`：宿主可通过 `hideHeader` 隐藏 Files header，默认不隐藏。
- `af04292`：宿主可注入分组设备来源。
- `318dd1b`：宿主可接管快捷键编辑器的 load/save。
- `f0e8025`：宿主可自定义浏览器 tab title。
- `db2271a`：宿主可替换终端文件链接 provider，默认行为不变。
- `465dbc8`：宿主服务注入及字体资源目录调整，默认打开、保存、剪贴板和字体内容无实质变化。
- `33841bb`、`c2edef2`、`faa7ae9`、`6dfa44e`、`57ee110`、`478af69` 等：组件拆分或嵌入式 API 抽取，默认 UI 行为保持不变。

当前 2026-08-27 重构后的主要归属变化是：通用 Sidebar 位于 `packages/ui/src/components/sidebar/`，设备树位于 `packages/panels/src/device-tree/`，DeviceConsole 位于 `packages/panels/src/device-console/`，Agent 位于 `packages/panels/src/agent/`。