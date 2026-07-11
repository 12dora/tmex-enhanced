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

## 审查修复（追加批次）

代码审查发现三处缺陷与两处次要问题，修复后 gateway 884、shared 93 全绿：

1. **snapshot diff 误报 pane 关闭**：pane 消失判定原先只看同一窗口内的 next
   panes，`move-pane` / `break-pane` 把 pane 挪进其他（含新建）窗口会被误判为
   关闭。改为以 next 全部窗口的 pane id 并集判定；closedWindows 语义不变
   （整窗关闭仍不逐 pane 报）。补 move-pane / break-pane 两个场景测试。
2. **`runTmux` server-gone 路径漏落 tmuxAvailable=false**：三处 session gone
   检测点中该路径缺 `updateDeviceRuntimeStatus`，导致桥的 tmuxAvailable 守卫
   失效，同一物理事件可能 session_closed + device_disconnect 双发。对齐另两处
   补齐落库，配套测试断言状态与单发。
3. **生命周期事件对推送渠道默认跳过**：telegram/weixin 只有
   `enableNotificationPush` 粗粒度总开关（默认开），6 种生命周期事件
   （device_disconnect / device_tmux_missing / session_created /
   session_closed / tmux_window_close / tmux_pane_close）直接放行会让存量
   用户升级后凭空多出一批推送。在两渠道分发入口按
   `PUSH_CHANNEL_SKIPPED_LIFECYCLE_EVENTS` 集合跳过，待 per-event 订阅掩码
   落地后再开放；webhook 的 eventMask 已是显式订阅制、ws-broadcast 面向站内
   UI，均不受影响。三面测试钉住（两渠道跳过、bell/notification 照旧、
   ws-broadcast 全量）。
4. 次要：桥 `bridgeThrottleMap` 补惰性过期清理（对齐 `shouldSendTelegram`
   的 sweep 模式），`handleDeleteDevice` 接线 `connectionAlertNotifier.clear`；
   桥的节流窗口改为成功发射后才消耗（settings 读取或发射失败不白耗 5 分钟）。

### 追加变异验红

| 变异 | 结果 |
|---|---|
| diff：全局 pane 并集退回窗口内局部判定 | 1 fail 红 ✓（move-pane 场景） |
| 推送渠道跳过集合置空 | 3 fail 红 ✓（telegram/weixin/分发三面） |
| runTmux server-gone 移除 tmuxAvailable 落库 | 1 fail 红 ✓ |
