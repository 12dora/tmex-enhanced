# T5 前端流畅度（P1 / P2 / P4 / P5 / P6 / P7）执行结果

Worktree：`/Users/konata/code/tmex-r28`，未做任何 git 状态变更（未 add / 未 commit）。全程未跑 Playwright e2e（其他 agent 并行改 FE）。

## P1 路由页模块缓存（消掉重访的空白帧 + 重播入场动画）

- `apps/fe/src/use-page-module.ts`
  - 新增模块级 `Map<PageModuleLoader, PageModule>`，`requestPageModule` 成功落地时写入（失败不写、被取消也仍写入——模块确实已经在 module map 里了）。
  - 新增导出：`cachedPageModule()`、`initialPageModuleState()`、`clearPageModuleCache()`（后者仅测试用）。
  - `usePageModule`：`useState` 用惰性初始化器取 `initialPageModuleState(loader)`——命中缓存时**首帧就是 ready**；effect 里命中缓存直接 return，不再多发一次请求、也不再多一次 `setState`。
  - 换路由（loader 变了）时在**渲染期**把状态切到新 loader 的起点（`activeLoader` 对象 + 渲染期 setState），否则那一帧还会渲染上一个页面的模块。
  - 坑：`useState(moduleLoader)` 会把裸函数当惰性初始化器直接调用掉（第一版写完 5 个用例全挂在 "Too many re-renders"），故 loader 装在 `{ loader }` 对象里。
- 效果：`page-wrapper.tsx` 的 `key={state.status}` 在重访时不再从 `loading` 翻到 `ready`，`.tmex-reveal` 只在真正有内容的那一帧播一次。首访行为完全不变。
- 测试：`use-page-module.test.ts` 新增 4 例（未加载过仍是 loading / 成功后起点即 ready / 失败不进缓存 / 按 loader 区分）；`page-wrapper.test.tsx` 新增 2 例（首访第一帧仍是空的、加载过之后重挂第一帧就渲染出页面与页标题）。

## P2 路由 chunk 预热

- 新增 `apps/fe/src/page-modules.ts`：`devicesPageModule` / `devicePageModule` / `settingsPageModule` / `filePageModule` / `loginPageModule`，以及 `IDLE_PRELOAD_PAGE_MODULES = [devicesPageModule, settingsPageModule]`。路由表与预热共用同一个函数引用。
- `apps/fe/src/pages/settings/chunk-preload.ts` → `apps/fe/src/lib/chunk-preload.ts`（测试同步搬到 `apps/fe/src/lib/chunk-preload.test.ts`）。从 `pages/settings` 往上引是分层倒置，直接搬到 `lib/` 而不是留 re-export shim；`SettingsPage.tsx` 改成 `@/lib/chunk-preload`，行为不变。
- `nav-link.tsx`：新增可选 `preload?: ChunkPreloadTarget`，`onPointerEnter` / `onTouchStart` 上调 `preloadChunk`；导出纯函数 `withChunkPreload(preload, handler)`——没给 loader 时原样返回原处理函数（不多包闭包），给了就先预热再透传事件。
- 接线：`nav-main.tsx` 的 `NavMainItem` 新增 `preload`，`app-sidebar.tsx` 的「管理设备」项带 `devicesPageModule`，`sidebar-title.tsx` 的齿轮链接带 `settingsPageModule`。
- `main.tsx`：首帧后（`i18nReady` 之后、紧挨着 rest 语言包预取）`startIdleChunkPreload(IDLE_PRELOAD_PAGE_MODULES)`，只有设备页 + 设置页两个，FilePage / DevicePage / hljs 一概不预热。
- 测试：`nav-link.test.tsx`（5 例，含「同一个 loader 反复悬停只发一次」「预热失败不抛给事件处理」）、`page-modules.test.ts`（2 例，断言空闲预热集合恰为设备+设置，且 loader 源码里不含 `DevicePage`/`FilePage`/`LoginPage`）。

## P4 文件树 content-visibility

- `packages/panels/src/files/files-node-roots.tsx`
  - 新增 `FILE_ROW_SKIP_RENDER_THRESHOLD = 100`、`SKIPPED_ROW_STYLE = { contentVisibility: 'auto', containIntrinsicSize: 'auto 26px' }`（照搬 `settings/directory-picker-modal.tsx:148-153` 的做法，行高按文件行实际 py-1 + text-xs 取 26px）。
  - 某个目录的**可见行数 > 100** 时，给它的子 `FileLeaf` 与子 `DirNode` 传 `rowStyle`；根行永远不传——它是 `SortableVerticalList` 的可排序项，拖拽要实测几何。
  - `FileLeaf` 把跳渲样式并进它原有的 `style={{paddingLeft}}`（不新增 DOM 层，事件委托的 `data-file-leaf-path` 结构不变）；`DirectoryNodeView` 新增 `rowStyle?: CSSProperties`，合并到它最外层 div 的 style 上（与拖拽 style 共存）。
- 测试：`files-node-roots.test.tsx` 新增 3 例（超阈值时每个文件行都带、缩进保留；阈值以内不带；根行那一层不带）。
- bench：`files-tree-render.bench.tsx` 增加 `120 rows` 一档（跨阈值）。实测 `500 rows mean=18.67ms / 120 rows mean=6.84ms / 50 rows mean=2.26ms`，原有 500/50 两档的预算未动、仍通过。注意 SSR bench 量不到 content-visibility 的收益（那是浏览器绘制阶段的事），这一档只兜住「加样式没把渲染成本抬上去」。

## P5 ScrollArea

- 只删了 `packages/ui/src/components/scroll-area.tsx` 里的 `<ScrollAreaPrimitive.Corner />`。核对了 `@base-ui/react@1.2.0` 源码：`ScrollAreaCorner` 在 `hiddenState.corner` 时 `return null`，而 `corner = scrollbarXHidden || scrollbarYHidden`、`scrollbarXHidden = viewportWidth >= scrollableContentWidth`；本仓只挂纵向 `ScrollBar`，横竖两条滚动条的交点恒不存在，所以它一直渲染 null。
- **没有**把 ScrollArea 换成普通 div（未实测，风险不明），也没有动 coarse 指针下的隐藏逻辑。

## P6 Agent 会话线程

- `packages/panels/src/agent/chat-thread.tsx`
  - `handleScroll` 合帧：新增 `createScrollCoalescer(measure, host)`（导出、可注入帧调度），一帧内多少次 scroll 都只做一次 `scrollHeight/scrollTop/clientHeight` 读取。测量函数每帧都要读最新的 `blocks/windowSize`，故用 `measureRef` 中转，合帧器只 `useMemo` 建一次，卸载时 `dispose`。
  - 额外加了 `flush()`：吸底的那次 rAF 里先把「压在同一帧里还没结算的滚动测量」结算掉，再决定要不要 `scrollTop = scrollHeight`。没有它的话存在一帧的窗口——流式追加与用户上滚撞在同一帧时会把人拽回底部（合帧引入的回归，已消除）。
  - 抽出 `stickToBottom` / `bottomAnchor` / `restoreBottomAnchor` 三个纯函数，吸底与 `showEarlier` 锚点回写都改走它们。
  - 行级跳渲：块外包一层 `<div className="flex flex-col">`（块自己的 `self-start` / `self-end` 仍然生效，视觉不变），渲染行数 > `CHAT_ROW_SKIP_RENDER_THRESHOLD`（40）时给这层加 `content-visibility: auto` + `contain-intrinsic-size: auto 64px`。包装层恒存在、只有样式随阈值开关，避免跨阈值时整棵子树重挂。`threadRows` 返回值不变，原有 memo 语义与「50 次流式 delta 只重渲尾行」的测试保持有效。
- 测试（`chat-thread.test.tsx` 新增 9 例）：
  - 合帧：12 次 onScroll 只测 1 次、下一帧还能再测；`flush` 立刻结算且不重复测、无待测时是空操作；`dispose` 后压着的那帧不测。
  - 吸底：流式追加后 `stickToBottom` 仍贴底且 `isPinnedToBottom` 为真；上滚超阈值不再吸底。
  - `showEarlier` 锚点：`scrollHeight` 长高 5000px 后 `scrollTop` 恰好上移 5000（距底距离不变）。
  - 跳渲样式：长会话每块都有、短会话没有、包装层是 `flex flex-col` 且 `self-end` 仍在。
  - **说明**：本仓没有 jsdom / happy-dom（`bun test` 全部用 `react-dom/server` 静态渲染），所以吸底与锚点是对抽出的纯函数 + 假元素对象验证，合帧是对注入的假 rAF 验证，跳渲样式走 SSR 断言。

## P7 vendor chunk 与预算口径

- `apps/fe/vite.config.ts`：`build.rollupOptions.output.manualChunks`，只把 `react`、`react-dom`、`scheduler`、`react-router`、`@tanstack/react-query`、`i18next`、`react-i18next`、`zustand` 归到 `vendor-react`（导出 `packageNameOfModuleId` / `vendorChunkOf`，包名取模块 id 里最后一段 `node_modules/` 之后的部分，兼容 bun 的 `.bun/<pkg>@<ver>/node_modules/<pkg>` 布局）。**没有**按 node_modules 一刀切，round 22 的懒加载边界（base-ui 弹层 `ToolbarRootContext`、hljs/`yaml`、mermaid、`markdown-preview`、sonner、直连栈）产物名与体积均未变化。
- `apps/fe/scripts/check-bundle-budget.ts`：口径改为 **index.html 里 `<script type=module>` + `modulepreload` 的合计**（CSS 同理合计所有首屏 stylesheet），预算总额保持 `entryJs 300_000 / entryCss 30_000` 不变；输出里逐个列出文件与字节数。

### 体积对照（`bunx vite build`，gzip）

| | 改前 | 改后 |
| --- | --- | --- |
| 入口 JS | `index-C_YmJ4-C.js` 903.47 kB / gzip 281,501 | `index-*.js` 523.20 kB / gzip 160,558 + `vendor-react-D2dqH1R8.js` 379.31 kB / gzip 120,809 |
| 首屏 JS 合计 (gzip) | 281,501 | **281,367**（−134 B） |
| 入口 CSS (gzip) | 24,032 | 24,032 |
| index.html 首屏集合 | 1 个 script | 1 个 script + 1 个 modulepreload |

首屏字节数基本不变（拆分本就不为了减字节），收益是业务代码改动不再让 379 kB 的框架代码缓存作废。预算脚本 `ok / exit=0`。最后一次跑的是完整 `bun run --cwd apps/fe build`（`tsc && vite build`，8.9s），产物只落在 `apps/fe/dist`（已 gitignore），**没有**写进 `packages/app/resources/fe-dist`。

## 验收

- `bun test src/`（apps/fe）：2401 pass / 0 fail。
- `bun test`（packages/panels）：949 pass / 0 fail；（packages/ui）：414 pass / 0 fail。
- `bunx tsc --noEmit -p apps/fe`、`-p apps/fe/tsconfig.node.json`、`-p packages/panels`、`-p packages/ui`：均无输出。
- `bunx biome check` 改动文件：clean（app-sidebar / nav-main / main.tsx / SettingsPage / directory-node-view / page-modules.test 的 import 排序与格式已 `--write` 修好）。

## 改动文件

新增：
- `apps/fe/src/page-modules.ts`、`apps/fe/src/page-modules.test.ts`
- `apps/fe/src/components/page-layouts/components/nav-link.test.tsx`
- `apps/fe/src/lib/chunk-preload.ts`、`apps/fe/src/lib/chunk-preload.test.ts`（自 `pages/settings/` 移动而来，旧文件已删）

修改：
- `apps/fe/src/use-page-module.ts`、`apps/fe/src/use-page-module.test.ts`、`apps/fe/src/page-wrapper.test.tsx`
- `apps/fe/src/main.tsx`、`apps/fe/src/pages/SettingsPage.tsx`、`apps/fe/src/pages/SettingsPage.test.tsx`（只改了一处指向旧路径的注释）
- `apps/fe/src/components/page-layouts/components/{nav-link,nav-main,app-sidebar,sidebar-title}.tsx`
- `apps/fe/vite.config.ts`、`apps/fe/scripts/check-bundle-budget.ts`
- `packages/panels/src/files/{files-node-roots.tsx,files-node-roots.test.tsx,directory-node-view.tsx,files-tree-render.bench.tsx}`
- `packages/panels/src/agent/{chat-thread.tsx,chat-thread.test.tsx}`
- `packages/ui/src/components/scroll-area.tsx`

（`git status` 里其它文件属于并行 agent，未触碰。）

## 有意跳过 / 留待确认

- **文件页（FilePage）的 hover 预热没接**：侧栏「文件」是标签页不是路由链接，文件行走的是 `FileLeafContextMenu` 的事件委托（不是 `NavLink`），要接预热得把 loader 从 `apps/fe` 一路传进 `packages/panels`，跨包倒置且收益不确定。空闲预热按要求本就不含它。
- **Brand（`/` 首页链接）没接预热**：它经 `linkComponent` 传 `NavLink`，接预热要给 `Brand` 加透传 prop；首页就是设备页，已被「管理设备」的 hover 预热与空闲预热覆盖。
- **P5 只删 Corner**：没把 ScrollArea 换成普通 div，也没动 coarse 指针下「隐藏滚动条但 JS 照跑」那部分——按勘察结论需要先量。
- **P3（终端保活池）/ P8（lucide barrel）** 按 EX4 结论不做。
- `check-bundle-budget.ts` 里新导出的 `entryScripts` / `entryStyles` 没有单测：脚本在 `apps/fe/scripts/` 下，`bun test src/` 覆盖不到；已用真实构建产物验证（含 modulepreload 的场景）。
