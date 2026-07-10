# 移动端堆叠分屏竞态修复结果

日期：2026-07-10

## 已实施

- `DevicePage` 在 render 时同步更新 `isMobileRef` 与 `stackedLayoutTargetRef`；多 pane 移动端目标出现且设备已连接时，主动调用当前终端的 `runPostSelectResize()`。
- gateway 增加 runtime 级 `applyStackedLayout(windowId, cols, rows)`，Local／SSH 连接各自用 promise 队列串行执行 `resize-window → select-layout`，并在最终布局后刷新 snapshot。
- WebSocket 多 pane 堆叠路径改为调用该原子操作；单 pane 保留原来的普通 `resizeWindow` 行为。

## TDD 与验证证据

1. 先新增 Local connection、runtime proxy 与 WebSocket delegation 三项测试；实施前均因缺少原子接口或仍走两个独立调用而失败。
2. 实施后运行：

   `bun test apps/gateway/src/tmux-client/device-session-runtime.test.ts apps/gateway/src/tmux-client/local-external-connection.test.ts apps/gateway/src/ws/index.test.ts`

   结果为 83 pass、0 fail、174 expects。
3. `bun run --filter @tmex/fe test:e2e -- split-screen-mobile.spec.ts --repeat-each=10` 结果为 10 pass、0 fail。

## 边界

该修复只处理移动端多 pane 的首次堆叠布局收敛，不改变桌面单 pane 的普通 resize 协议。后者的一条独立偶发远端 resize 现象记录在 `plan-03.md`，本提交不把未验证的修复混入其中。
