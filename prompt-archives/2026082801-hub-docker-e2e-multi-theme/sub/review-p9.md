结论：**Request changes，暂不建议合入。** P8 的 #1、#2 仍未完全关闭；另确认 3 个新缺陷。

## Findings

1. **P1 — 入站高优先级链仍可绕过 quiesce ACK 替换旧链。**  
   [peer-manager.ts:950](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:950)

   `maybeUpgrade()` 已禁止本端未 ACK 时主动升级，但 `track()` 在收到对端发起的更高优先级链时，仍直接执行 `retirePeer(prev)`，没有检查 `prev.quiesceCapable`。旧版本 peer 会自动拨号升级，因此混版本场景仍可由旧端触发替换，导致在途 OPEN/流丢失。

   修复：入站替换也必须经过旧链 fence；新链先暂存，旧链确认 quiesce 后才能切换。补“legacy peer 主动发起升级”的滚动版本测试。

2. **P1 — applier 的 abort/timeout 只取消等待，底层数据库写入仍继续。**  
   [uplink-client.ts:638](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:638)、[uplink-client.ts:789](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:789)、[user-key-service.ts:344](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/auth/user-key-service.ts:344)

   `awaitCatchUp()` race timeout/abort 后便让受追踪的 catch-up Promise 结束，但原始 `head/list/applyMany` Promise 未取消、未追踪。`applyMany()` 又逐条提交事务；超时或重连时，旧代次可继续提交部分 key-log，与新代次并发，触发 `seq_gap`、错误重试或安全状态延迟生效。`allSettled(previousTasks)` 因此只是等待包装任务，并未真正收敛数据库操作。

   修复：让 applier 接收 `AbortSignal`，或先完整验证后以 head-CAS 原子提交整批；至少序列化并追踪原始 mutation Promise，不能把包装 Promise 的 abort 当成底层任务完成。

3. **P2 — 去重指纹包含 UI 元数据，但 NODE_EVENT 实际丢弃这些字段。**  
   [node-event-dedupe.ts:5](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/node-event-dedupe.ts:5)、[mesh-routes.ts:382](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-routes.ts:382)、[mesh-nodes.ts:35](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/mesh-nodes.ts:35)

   `version/direct_capable/name` 会触发 `shouldEmitList()`，但 Borsh NODE_EVENT 只编码 status、reach、inventory；前端 patch 也不更新这些字段。节点仅改变 `direct_capable` 或独立 `version` 时，事件虽然发出，Nodes UI 仍显示旧值，直到轮询刷新。

   修复：扩展 NODE_EVENT schema、前后端类型及 patcher；或在这些元数据变化时明确触发完整节点列表刷新。

4. **P2 — overflow 共享桶允许同用户节点互相饿死，且 overflow Map 无界。**  
   [uplink-server.ts:185](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-server.ts:185)、[uplink-server.ts:614](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-server.ts:614)

   超过 1024 个 bucket 后，同一用户的所有溢出节点共享 20-token burst。一个持续请求的已认证节点可耗尽补充 token，使其他溢出节点无法同步 key-log；受限请求还被静默丢弃，客户端只能等待超时。`overflow` 按 userId 永不 TTL/淘汰，`size` 也不统计它。

   修复：使用有界且具节点公平性的 overflow 分片/配额，给限流请求返回显式响应，并为 per-user 状态增加 TTL、容量和可观测计数。

5. **P2 — WINDOW/RST 的异步发送失败被吞掉后，mux 可保持假在线。**  
   [mux.ts:479](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/link/mux.ts:479)、[mux.ts:495](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/link/mux.ts:495)

   `sendFrame()` 只在同步 throw 时关闭 mux；新增的 `.catch(() => undefined)` 吞掉异步 rejection。对一个返回 rejected Promise、但未同时触发 `onClose` 的合法 `ByteTransport`，RST/WINDOW 丢失后 mux 仍保持 open，可能造成远端流泄漏或流控永久停滞。最小 Bun 复现结果为 `still-open`。

   修复：在 `sendFrame()` 统一处理异步 rejection：调用 `finishClose()` 后再 reject；fire-and-forget 调用方随后可安全消费 rejection，但不能吞掉状态转换。

## P8 关闭状态

| P8 finding | 状态 |
|---|---|
| #1 混版本 quiesce | **未关闭**：本端主动路径已修，入站替换仍绕过 |
| #2 catch-up generation | **未关闭**：发送代次已绑定，底层 applier 未取消/收敛 |
| #3 status-only 去重 | 原去重与生命周期问题已关闭；引入元数据交付缺口 |
| #4 1025 节点循环绕过 | 原 burst 重置已关闭；引入共享桶饥饿和无界 overflow 状态 |

`allSettled` 本身未单列：当前包装 Promise 会在 abort 后迅速结束，不会独立永久阻塞新连接；真正问题是它没有等待仍在运行的底层 applier。