结论：存在 blockers。对“单个大于 64 KiB 的帧”需要精确区分：首个 `backpressure` 本身把 `skippedFrame` 初始化为 `false`；但 drain 前任何下一次广播都会将其置为 `true`，随后以 `backpressure_gap` 终止。canonical 单帧硬限制为 32 KiB，不受这个“大帧分片”特例影响；legacy 默认允许 1 MiB 帧，64 KiB terminal batch 加 envelope 会触发该路径。

验证：相关现有测试为 `30 pass / 0 fail`，但最小复现得到 `first=backpressured → second=dropped → backpressure_gap`，并复现了 stale drain 后事务停在 `HISTORY_APPLIED + BUFFERING`。

## 1. Blockers

### 1. DataChannel 大帧会让正常 legacy 流进入 gap/超时终止

位置：[data-channel-carrier.ts:124](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/rtc/data-channel-carrier.ts:124)、[websocket-send-guard.ts:131](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/websocket-send-guard.ts:131)、[websocket-send-guard.ts:82](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/websocket-send-guard.ts:82)、[legacy-feed-broadcaster.ts:269](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/legacy-feed-broadcaster.ts:269)、[index.ts:598](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/index.ts:598)

真实调用链是：

`LegacyFeedBroadcaster.sendTerminalOutput`
→ `WebSocketServer.sendChunked`
→ `sendToClient`
→ `WebSocketSendGuard.sendFramesStatus`
→ `GatewaySession.activeCarrier.send`
→ `DataChannelCarrier.send`

64 KiB DataChannel fragment实际只能承载 `64 KiB - 8` 字节；legacy terminal batch 本身最大 64 KiB，再加 Borsh envelope 必然需要多个 fragment。[terminal-output-batcher.ts:2](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/terminal-output-batcher.ts:2)、[fragment-core.ts:1](/Users/konata/code/tmex-enhanced-wt-r9/packages/shared/src/link/fragment-core.ts:1)

具体场景：

1. 70 KiB 帧的第一个 fragment 成功，第二个暂时失败。
2. 新代码返回 `backpressure`，guard 建立 `skippedFrame=false` 状态。
3. drain 前下一批 terminal output 到达；`canSend()` 将 `skippedFrame=true` 并丢弃该批。
4. `handleDrain()` 以 `backpressure_gap` 终止 carrier。

更严重的是，RTC direct carrier 的挂载路径只切换 `activeCarrier`，没有把其 drain 持久转发给 `WebSocketServer.handleDrain()`；该绑定只存在于 `attachStreamSession()` 的 primary stream 路径。[rtc-peer-manager.ts:430](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:430)、[index.ts:202](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/index.ts:202) 因此若没有第二帧，guard 也可能收不到 drain，最终走 `backpressure_timeout`。

canonical 的具体“大于 64 KiB”问题不存在，因为其 wire frame 上限为 32 KiB。[canonical-state.ts:13](/Users/konata/code/tmex-enhanced-wt-r9/packages/shared/src/ws-borsh/canonical-state.ts:13) 但 direct carrier 缺少通用 drain 转发仍会影响 canonical 的其他背压场景。

最小修复：先为每个 RTC direct carrier 注册持久的 `WebSocketServer.handleDrain(session, carrier)` 转发；同时不能让 legacy 在 accepted-backpressure 期间直接丢掉后续流帧。应明确区分“当前帧已由 carrier 接管，但需等待 drain”和“当前帧未接收”，并对前者提供有界排队/恢复语义，而不是直接沿用 websocket gap guard。

### 2. ACK 返回 backpressure 后事务会永久卡在 ACKED

位置：[switch-barrier.ts:150](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/borsh/switch-barrier.ts:150)、[switch-barrier.ts:168](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/borsh/switch-barrier.ts:168)、[switch-barrier.ts:433](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/borsh/switch-barrier.ts:433)、[session-state.ts:342](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/borsh/session-state.ts:342)

`sendSwitchAck()` 在发送前清除 ACK timer 并转入 `ACKED`；一旦发送返回 `backpressure`，它调用 `completeTransaction()`。但状态机不允许 `ACKED -> STABLE`，所以 cleanup 不会执行，也没有 drain continuation 或剩余 timer。

具体场景：DataChannel 暂时无法写入 ACK 的首个 fragment。carrier 已保存 remainder，新返回值变成 `backpressure`；对于 `wantHistory:false`，事务随后永远保持 `ACKED + BUFFERING`，不会发送 `LIVE_RESUME`。

最小修复：ACK 的 accepted-backpressure 必须等待实际 drain 后继续 ACK 后流程，并保留 liveness deadline；真正失败则经合法的 `ACKED -> SELECT_FAILED -> STABLE` 路径清理，不能调用无效的 `ACKED -> STABLE`。

### 3. 等待 drain 没有 deadline，且 carrier 可能永远不产生 drain

位置：[switch-barrier.ts:214](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/borsh/switch-barrier.ts:214)、[switch-barrier.ts:235](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/borsh/switch-barrier.ts:235)、[switch-barrier.ts:279](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/borsh/switch-barrier.ts:279)、[data-channel-carrier.ts:50](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/rtc/data-channel-carrier.ts:50)

history timer 在发送前被清除；history 或 `LIVE_RESUME` 返回 backpressure 后只注册 drain callback，没有新的事务 timer。

`DataChannelCarrier` 只在 `onBufferedAmountLow` 中重试 remainder。若首个 fragment 就返回 false、实际没有任何 queued bytes，或 buffered amount 从未超过 1 MiB low threshold，就可能没有 threshold crossing，因而永远不触发 drain。guard 五秒后终止 direct carrier时，RTC 路径只回退 primary，不会清理或迁移 SwitchBarrier 的 pending transaction；输出继续永久缓冲。

最小修复：

- 等待 drain 时始终保留一个带 token/transaction identity 的 deadline。
- deadline 到期必须显式重试当前 active carrier或失败并停止缓冲。
- direct carrier detach/close 时必须重新绑定等待到新 carrier，或终止对应事务。
- DataChannel 首次发送失败且没有可排空数据时，不能仅依赖 `bufferedAmountLow` 才再次推进 remainder。

### 4. 旧事务的 drain callback 会吞掉新事务的 drain；cancel 还会伪造 drain

位置：[switch-barrier.ts:325](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/borsh/switch-barrier.ts:325)、[switch-barrier.ts:345](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/borsh/switch-barrier.ts:345)、[switch-barrier.ts:423](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/borsh/switch-barrier.ts:423)、[data-channel-carrier.ts:137](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/rtc/data-channel-carrier.ts:137)

`onDrain()` 没有 unsubscribe；每个事务都会永久加入一个 callback。旧 callback 执行时先读取“当前”pending，并在 token 校验前将其 `awaitingLiveResume=false`。因此：

1. 事务 A 等待 drain。
2. A 被取消，事务 B 也进入等待 drain。
3. drain 到达，A 的旧 callback 先执行。
4. 它清掉 B 的 `awaitingLiveResume`，随后才发现 token 不匹配并返回。
5. B 的 callback看到 flag 已清除，不再发送 resume。

最小复现最终停在 `HISTORY_APPLIED + BUFFERING`，没有任何 `LIVE_RESUME`。

此外，`cancelTransaction()` 在 carrier 尚未 drain 时直接调用 `gatewayWebSocketSendGuard.handleDrain()`，会过早清除真实背压状态。新事务随即可能向仍保有旧 remainder 的 DataChannel 发送 ACK，得到未接收的 backpressure并落入 blocker 2。

最小修复：callback 必须捕获 pending 对象和注册时的 carrier，并在修改任何状态前验证 `getPending(...) === capturedPending`、token 及 carrier；为 drain listener增加 unsubscribe，或每个 session/carrier只装一个稳定 listener。取消事务绝不能用 `handleDrain()` 模拟未发生的 drain。

## 2. Should fix

### 1. `LIVE_RESUME` 的 accepted-backpressure 会导致重复投递

位置：[data-channel-carrier.ts:118](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/rtc/data-channel-carrier.ts:118)、[switch-barrier.ts:279](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/borsh/switch-barrier.ts:279)、[switch-barrier.ts:350](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/borsh/switch-barrier.ts:350)

DataChannel 已将逻辑帧保存在 `remainder` 中，drain 时会先补齐该帧，再调用 listener。barrier 随后重新编码并发送另一个 `LIVE_RESUME`。真实 DataChannel 最小复现收到两个 `LIVE_RESUME`。客户端目前会因第一帧已完成事务而忽略第二帧，因此影响较低，但这暴露了 Carrier 状态语义不一致。

最小修复：明确区分 accepted-backpressure 与未接收的 blocked 状态。前者在 drain 后只完成 barrier 状态并 flush 输出，不重发控制帧；后者才重试。

### 2. 新测试使用了错误的 backpressure 模型

位置：[switch-barrier.test.ts:286](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/borsh/switch-barrier.test.ts:286)

`createResumeBackpressureCarrier()` 返回 `backpressure` 时完全不保存 frame，因此只能验证“未接受后重试”，无法覆盖 DataChannel“carrier 已保存 remainder、drain 前补齐”的真实语义，也没有把 `DataChannelCarrier → WebSocketSendGuard → broadcaster/SwitchBarrier` 串起来。

应补充：

- 70 KiB DataChannel 帧后紧跟另一帧，验证不会意外 `backpressure_gap`。
- 单帧 drain 能清除 direct carrier 的 guard。
- accepted-backpressure 的 `LIVE_RESUME` 只投递一次。
- 旧、新华事务均等待 drain 时，新事务仍能 resume。
- 无 queued bytes、无 drain 事件时的 deadline/清理路径。

## 3. Nits

无。