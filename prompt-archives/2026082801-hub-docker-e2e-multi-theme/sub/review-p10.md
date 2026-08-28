结论：**Request changes，暂不建议合入。** P9 的核心修复方向成立，但确认 6 个新缺陷，其中 3 个可造成安全边界绕过或内存 DoS。

## Findings

1. **P1 — 节点撤销时 parked 链会被重新提升为 live。**  
   [peer-manager.ts:434](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:434)、[peer-manager.ts:1324](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:1324)

   场景：旧 live 链未 ACK quiesce，新链被 parked；证书随后撤销。`onRevoked()` 调用 `dropPeer()`，而后者无条件执行 `activateParked()`；`track()` 又不复查 trust，于是已撤销节点的新链被绑定为 live。实测撤销后 `live` 从旧链变为 parked 链。

   修复：撤销路径先 `dropParked(nodeId, 'revoked')`，且 `activateParked()`/`track()` 提升前必须重新验证证书仍受信任。

2. **P1 — 单条 parked 链可通过 OPEN/CTL 无界堆积造成内存 DoS。**  
   [peer-manager.ts:1337](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:1337)、[mux.ts:377](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/link/mux.ts:377)、[mux.ts:643](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/link/mux.ts:643)

   parked session 未注册 stream/ctl 消费者。Mux 会把 OPEN 保存在无界 `streams`/`pendingIncoming`，CTL 也进入无界 `ctlInbox`，且 CTL 仍持续返还 WINDOW。认证对端在 30 秒 fence 窗口内可持续灌入；实测 1,000 个 OPEN 后保留 1,000 个 pending stream。替换 parked 链还能重置超时。

   修复：park 时立即注册 ctl drain，并在仍处于 parked 状态时 reset 所有 OPEN；同时增加 link 级 stream/pending/ctl 队列硬上限。

3. **P1 — 无分页批次使 head-CAS 实现产生二次量级内存占用。**  
   [user-key-service.ts:385](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/auth/user-key-service.ts:385)、[user-key-service.ts:417](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/auth/user-key-service.ts:417)、[uplink-server.ts:709](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-server.ts:709)

   hub 从 `from_seq` 返回全部记录，没有条数/字节上限。`applyMany()` 又在 `prepared` 中保留每一步 `previous`/`next` 状态；每步都会复制不断增长的 passkey/node-cert Map，因此 N 条增长型记录累计为 O(N²) Map entry，可在提交前 OOM或长时间阻塞事件循环。事务开始后也无法及时观察 abort。

   修复：协议增加分页和响应字节上限，客户端拒绝超限响应；每个有限批次继续使用原子 CAS。不要在无界批次中保留完整状态快照。

4. **P2 — legacy/缺省 NODE_EVENT 会把 `direct_capable` 错误改成 `false`。**  
   [mesh-events.ts:105](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/mesh-events.ts:105)、[mesh-nodes.ts:52](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/mesh-nodes.ts:52)

   新 decoder 将 wire `null` 强制转换为 `false`。旧服务端的四字段事件以及新服务端的 synthetic offline 事件都没有该值，却会覆盖列表中原有的 `true`。实测 legacy payload 解码结果为 `direct_capable:false`。

   修复：保留 `null`/`undefined`，只有 wire 明确携带 boolean 时才更新现有字段。

5. **P2 — overflow 第 9 个及以后节点仍能互相饿死。**  
   [uplink-server.ts:290](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-server.ts:290)

   每用户只有前 8 个节点拥有独立桶；第 9 个起全部共享 `remainder`。实测 burst=1 时第 9 个请求成功、第 10 个立即被拒绝；持续活跃的第 9 个节点可长期抢走补充 token。

   修复：超过公平容量时显式拒绝注册/限流，或采用真正有界且公平的调度；不能把所有剩余节点重新合并成一个竞争桶。

6. **P2 — send rejection 关闭了 mux 状态，却没有关闭底层 transport。**  
   [mux.ts:480](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/link/mux.ts:480)、[mux.ts:729](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/link/mux.ts:729)

   `finishClose()` 不调用 `transport.close()`。若 `send()` reject 且 transport 不触发 `onClose`，底层仍可继续投递数据；关闭后的 mux 回调仍向 `pendingChunks` push，但不再 drain。实测 `closeCalls=0`，继续投递 100 个 chunk 后全部滞留。`finishClose()` 本身具幂等保护，没有 double-resolve 问题。

   修复：同步及异步 send failure 都走 `close(message)`，确保先关闭 transport、幂等完成 mux close，再 reject 原调用。

## P9 关闭状态

| P9 finding | 状态 |
|---|---|
| #1 入站 quiesce fence | 原数据丢失场景已关闭；引入 Findings 1、2 |
| #2 applier abort/generation | 原跨代并发写入已关闭；CAS retry 会重读 head，未见错误提交；引入 Finding 3 |
| #3 NODE_EVENT 元数据 | 字段交付已关闭；新旧二进制解码双向可用，但 optional 语义仍有 Finding 4 |
| #4 overflow | TTL、容量、计数、显式 `rate_limited` 已关闭；节点公平性未完全关闭 |
| #5 mux 假在线 | mux 状态的 close-before-reject 已关闭；底层 transport 清理不完整 |

复核执行了相关 8 个测试文件：**170 pass / 0 fail**；上述缺陷均未被现有测试覆盖。