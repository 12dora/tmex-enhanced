# 移动端堆叠分屏竞态修复计划

日期：2026-07-10

## 背景

在 Tailwind 扫描修复后的相关 E2E 回归中，`split-screen-mobile.spec.ts` 以 10 次重复运行复现 1 次失败：双 pane 没有收敛为等宽的移动端拼接布局。失败截图中的“重连中”由测试 finally 删除设备并 kill session 后触发，已由 gateway 日志与 trace 时间线证实不是先因。

根因链有两段：

1. `DevicePage` 的 `isMobileRef` 与 `stackedLayoutTargetRef` 仅在 passive effect 更新，Terminal 首次尺寸同步可能在 ref 仍是旧值时发生；随后没有保证再发一次堆叠布局请求。
2. gateway 收到堆叠布局请求后并发调用 `resizeWindow` 与 `selectLayout`。两者各自 fire-and-forget，`select-layout` 可先于 `resize-window` 执行，留下不等宽 pane，且不一定再有 ResizeObserver 回调纠正。

## 目标

移动端多 pane window 首次进入时始终触发堆叠布局；每次堆叠布局在 runtime 内按 `resize-window → select-layout` 串行执行。保留桌面分屏和普通窗口 resize 现有行为。

## 实施步骤

1. 在 `apps/gateway/src/tmux-client/local-external-connection.test.ts` 先增加失败单元测试：调用新的 `applyStackedLayout` 后，mock tmux 命令记录必须先出现 `resize-window`，后出现 `select-layout`。
2. 在 `apps/gateway/src/ws/index.test.ts` 先扩展 runtime recorder，并增加失败断言：多 pane、非等宽 snapshot 的 `handleApplyStackedLayout` 必须委托给一个 runtime 级 `applyStackedLayout` 操作，而不是分别下发两个 void 调用。
3. 在 `DeviceSessionRuntimeConnection`、`DeviceSessionRuntime`、Local／SSH external connection 增加 `applyStackedLayout(windowId, cols, rows)`：以每连接的 promise 队列串行执行 resize、刷新 snapshot、再 select-layout、再刷新 snapshot；错误仍走现有 `onError` 回调。
4. 让 `WebSocketServer.handleApplyStackedLayout` 调用该原子 runtime 操作。
5. 在 `DevicePage` 将移动端与堆叠目标 ref 在 render 时同步为当前值；当 target 从空变为某个多 pane window 时，调用当前 Terminal 的 `runPostSelectResize()`，保证首个快照后的尺寸同步不会只依赖 ResizeObserver。
6. 运行新增 unit tests、移动端 spec 的重复运行、桌面／移动／selection／render 相关 E2E、前端类型检查和构建；若失败只按具体根因继续排查，不能以加长超时规避。

## 验收标准

- 同一 `applyStackedLayout` 调用的 tmux 命令顺序稳定为 resize 后 layout。
- gateway 多 pane 堆叠路径只调用 runtime 原子操作。
- 移动端 E2E 在重复运行中持续满足 pane 等宽与拼接窗口宽度公式。
- 桌面 gutter resize、标题栏拖拽预览、split-down 与选择持久化没有回归。
