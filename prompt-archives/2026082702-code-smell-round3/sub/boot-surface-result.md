# useTerminalBootSurface 拆分结果

## 背景

`packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts` 原 378 行，`useTerminalBootSurface`
本体 282 行，其中单个 `useEffect`（L136–348）约 213 行，同时塞进了三件事：资源加载（prepareResources +
字体）、渲染目标（控制器/mount）的建立与释放、以及启动/恢复状态机（`onRecoveryRequired`、
`onSnapshotApplied` 与 `cancelled` / `hasCommittedSnapshot` 两个隐式状态位）。

## 产出

新增两个不含 React / DOM / ghostty 具体依赖的模块（同目录）：

- `terminal-render-target.ts`：一代终端渲染目标的生命周期。`createTerminalRenderTarget()` 串起
  控制器创建 → 离屏 mount → `open`，任一步失败或期间被取消都在抛出前把已建立的控制器与 mount
  释放干净；`createHiddenMount()` 负责双缓冲的「离屏」半边（`visibility: hidden` +
  `pointerEvents: none`），`activateRenderTarget()` 负责「换进来」半边（visible/auto +
  `scrollToBottom` + `forceFullRepaint`）。全部经 `RenderTargetDeps` 注入（document、控制器工厂、
  宿主解析、取消判定、诊断上报、dispose 钩子），对 mount / terminal 只做最小结构约束，因此可以用
  纯对象假件测试。
- `terminal-surface-lifecycle.ts`：显式的启动/恢复状态机 `TerminalSurfaceLifecycle`，
  `boot()` / `cancel()` 两个入口，`cancelled`、`hasCommittedSnapshot`、`stopDiagnosticSamples`
  三个内部状态；启动态迁移抽成三个纯函数 `recoveryBootState()` / `snapshotBootState()` /
  `bootErrorState()`，可单独断言。副作用全部经 `TerminalSurfaceLifecycleDeps` 注入，模块本身不 import
  React、DOM、TerminalSurface 实现。

`useTerminalBootSurface` 只剩「把 runtime 接到 React state」：hook 本体 ~45 行，effect 体 ~20 行；
接线部分拆成 `createLifecycleDeps` / `buildSurface` / `buildRenderTarget` / `createStageReporter` /
`convergeSnapshotSize` / `requestPaneScreen` 等模块级小函数（均 ≤ 25 行）。文件 330 行（含 62 行未动的
e2e 探针与类型定义）。

## 特征化测试（先写，重构后保持绿）

- `terminal-render-target.test.ts`（10 例）：create → open → ready 的**精确事件序列**
  （`controller:create` → `document:createElement` → `host:append` → `stage:controller_ready` →
  `terminal:open` → `stage:opened`）；boot 中途取消（控制器已 resolve）只 dispose 控制器且不建 mount；
  宿主缺失路径；controller 失败 / open 失败各自的诊断 stage 与清理顺序；`dispose()` 的
  `probe:clear → terminal.dispose → mount.remove` 顺序；双缓冲换入（activate 前恒 hidden，
  activate 后 visible/auto 且 `scrollToBottom` 先于 `forceFullRepaint`）。
- `terminal-surface-lifecycle.test.ts`（17 例）：happy path 的完整顺序
  （`surface:set:null` → `bind:null` → `state:loading` → `stage:mount` → 资源 → `stage:fonts_ready` →
  建面 → `initialize`，再到首帧 `bind` → `state` → 采样，快照落地时
  `bind` → `commit` → `stage:generation_activated` → `state:ready` → 停旧采样 → 起新采样）；
  资源失败 / 初始化失败的两条错误消息与回退消息；unmount-before-ready 的三种时点（资源加载中取消、
  initialize 中取消、取消后回调静默）；恢复态在「首屏未提交 + atomicScreen」下回 Loading、
  `resource_exhausted` 落硬失败，首屏已提交或非 atomic 链路则不动启动态但仍重取首屏。

## 行为一致性说明（唯一一处刻意简化）

原实现的 `diagnosticArgs` 在不传 mount 时默认取 `mountRef.current`。`mountRef` 只在
`onSnapshotApplied` 里被赋值，而用到该默认值的 stage（`mount`、`fonts_ready`、`font_load_failed`、
`controller_failed`）全部发生在首个 `onSnapshotApplied` 之前（effect cleanup 也会把它清空），因此这些
点上 `mountRef.current` 恒为 `null`。据此改为显式传 `null` 并删除 `mountRef`；`recovery_started`
原本就显式传 `null`，`opened` / `open_failed` / `generation_activated` / 采样均显式传 target 的 mount。
其余顺序、条件、错误消息、诊断 stage 逐条对齐，无功能性改动。

`TERMINAL_SCROLLBACK = 10000` 及其传参方式（`scrollback: TERMINAL_SCROLLBACK`）按要求原样保留。
`window.__tmexE2eXterm` 等 e2e 兼容成员与 `setE2eTerminalProbe` / `clearE2eTerminalProbe` 未改动，
探针清理仍由渲染目标的 `dispose()` 触发。`TerminalBootState` 移到 lifecycle 模块并从 hook 原样
re-export，`Terminal.tsx` 无需改动。

## 验证

- `cd packages/terminal-ui && bun test`：301 pass / 0 fail（基线 233 + 本任务 27 + 并行任务新增）。
- `bunx tsc --noEmit -p .`：0 error。
- `bunx biome check`（五个文件）：clean。
