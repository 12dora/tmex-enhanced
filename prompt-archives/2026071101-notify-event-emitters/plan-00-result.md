# 执行结果：通知事件发射面补齐

三个 commit（fad01bc 实现 / 860e5c3 测试 / 274b0a3 stores 开关），四包全绿：
gateway 891、shared 93、stores 36、ws-client 23。

## 落点

- `apps/gateway/src/tmux-client/snapshot-diff.ts`（新）：`diffSnapshotClosures`
  纯函数；local/ssh 连接类 `requestSnapshotInternal` 在 emitSnapshot 后调
  `emitSnapshotClosures`（门槛：prev 空/next 空/!connected/manualDisconnect）。
- `apps/gateway/src/push/connection-alerts.ts`：`maybeEmitEvent` 桥 +
  `bridgeThrottleMap`（5min，clear() 一并清）+ 两个注入 setter；
  `runtime.ts` 启动接线、stop 注销。
- 连接类 `ensureSession → {created}`、`notifySessionClosed`（session gone 三处：
  重连探测、快照 server-gone、runTmux server-gone）；`connection-types.ts` 加
  `notifyEvent` 可选回调，`device-session-runtime.ts` 透传，
  `tmux-client/registry.ts` 接线 eventNotifier。
- `packages/stores`：runtime features `hostManagedNotifications`（默认 false），
  tmux store notification 分支入口短路；bell 声/高亮路径不动。

## 变异验红记录

| 变异 | 结果 |
|---|---|
| 桥：去掉 source 门控 | 1 fail 红 ✓ |
| 桥：去掉 throttle | 12 fail 红 ✓ |
| 桥：去掉 tmuxAvailable 跳过 | 12 fail 红 ✓ |
| 桥：映射表剔除 connection_closed | 12 fail 红 ✓ |
| diff：去掉无效快照门槛 | 1 fail 红 ✓ |
| ensureSession 恒 created:false | 1 fail 红 ✓ |
| stores：去掉抑制守卫 | 1 fail 红 ✓ |
| session_closed once 守卫 | **变异存活**：该守卫被 connected 前置检查遮蔽，
  现实控制流中双发窗口极窄（需精确并发时序），评估为无害的冗余防御，保留不删 |

## 计划偏差

- ssh 连接类未单独重复发射测试：发射逻辑与 local 逐行同构（同一份实现复制），
  由 local 全矩阵 + ssh 编译/全量回归覆盖。
- session gone 检测点实为三处（计划写两处）：`runTmux` server-gone 路径同样
  shutdown，一并发射。
