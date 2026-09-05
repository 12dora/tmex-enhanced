# EX4 前端流畅度勘察（Opus 探索报告摘要）

## 已排除的假设

- 无 xterm.js：终端是自研 `packages/ghostty-terminal`（WASM 单例 + canvas），无 renderer/smoothScroll 配置；scrollback 固定 10000。
- 输出写入已有界合帧（`pane-output-coalescer.ts` 32 KiB / 4 ms）+ rAF 脏行渲染（round 21/22）。
- 输入刻意不 debounce（`useTerminalInput.ts:98` → `transport.send`），不要动。
- StrictMode 生产 no-op；轮询已可见性门控；store 选择器已足够细；`backdrop-blur` 不在滚动容器里。

## 问题清单

- **P1 路由切换强制空白帧 + 重挂 + 150 ms 入场动画**：`apps/fe/src/use-page-module.ts:70-84` 无已解析模块缓存，初始恒 loading；`page-wrapper.tsx:78` `key=state.status` 导致 loading→ready 重建并重播 `.tmex-reveal`。改法：模块级 `Map<loader, module>` 缓存，命中时 `useState` 初始化同步 ready。收益确定，风险低。
- **P2 顶层路由 chunk 无预热**：`nav-link.tsx:10-28` 无 hover/touch 预取；设置页内部已有 `pages/settings/chunk-preload.ts`（`preloadChunk`/`startIdleChunkPreload`）。改法：loader 提到独立模块，NavLink `onPointerEnter/onTouchStart` 预热，首帧后空闲预热 devices+settings（只 2 个，别拖 hljs）。
- **P3 终端页切走再切回保活池整体销毁**：`terminal-keep-alive.ts` 池由组件 ref 持有；本轮不做（StrictMode/portal 风险）。
- **P4 文件树无 `content-visibility`**：`packages/panels/src/files/files-node-roots.tsx:43` `DISPLAY_CAP=500`，`:296-317` 全量挂载；先例 `settings/directory-picker-modal.tsx:148-153`（阈值 200 后 `contentVisibility:'auto'` + `containIntrinsicSize`）。改法照搬；bench `files-tree-render.bench.tsx`。不要加到 `SortableVerticalList` 根行。
- **P5 base-ui ScrollArea 触屏隐藏滚动条但 JS 全量跑**：`packages/ui/src/components/scroll-area.tsx:52` coarse 指针 hidden；每 scroll 事件 2 次 getComputedStyle + 4 次自定义属性写。使用点 `sidebar-device-list.tsx:230`、`files-tab.tsx:83`、`directory-picker-modal.tsx:411`。建议先量；`<Corner />` 在本仓恒 null 可删（零风险）。
- **P6 Agent 会话首屏一次挂 200 个 markdown 块**：`packages/panels/src/agent/chat-thread.tsx:22` `WINDOW_STEP=200`，`:169-176` handleScroll 每事件同步读三项布局。改法：行级 `content-visibility:auto` + rAF 合并 handleScroll；注意 `showEarlier` 锚点与吸底读 `scrollHeight`，要补测试。
- **P7 vite 无 manualChunks**：`apps/fe/vite.config.ts:90-95`；业务改动即 vendor 缓存全失效（入口 282 KB gz）。改法：只拆 react/react-dom/react-router/react-query/i18next/zustand 为 `vendor-react`，不要按 node_modules 一刀切（会破坏 round 22 懒加载边界）；`apps/fe/scripts/check-bundle-budget.ts:8` 预算口径改为首屏 preload 集合总和。
- **P8 lucide barrel 导入**：不做，tree-shake 正常。

## 实施顺序

P1 → P2 → P4 → P5（先量，只删 Corner）→ P6 → P7；P3/P8 不做。
