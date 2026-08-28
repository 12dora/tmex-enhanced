## Findings

### Blocker

1. **Wake 没有端到端的发送方认证，失陷 hub 可以伪造任意已加入节点发出的 wake。**  
   位置：[mesh-runtime.ts:831](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-runtime.ts:831)、[peer-manager.ts:430](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:430)

   node 仅从 `rtcSession=dc:A:B` 推导 `fromNodeId`，随后只检查本地是否信任 A；wake 本身没有签名、nonce 或防重放信息。诚实 hub 会在转发前校验 uplink 身份和同一用户关系，但失陷 hub 控制下行链路，可以直接向 B 注入一条声称来自 A 的 wake。

   具体场景：失陷 hub 向 B 发送 `dc:A:B + {"type":"rtc.wake"}`，B 会主动创建 PeerConnection，并把当前 host/srflx/TURN candidates 发回 hub，产生网络元数据泄露和可控资源消耗。DTLS/peer handshake 仍会阻止 hub 冒充 A 或访问 B 的业务流，因此这不是跨节点业务权限突破，但它违反了“hub 不是信任根、hub 只转发”的明确要求。

   建议 wake 对 `{domain, from, to, rtcSession, nonce/timestamp}` 使用 node 私钥签名，由接收端使用 `node_certs` 验证。

### Should-fix

2. **接收侧没有 wake 限速或冷却，发送侧的 `wakeGate` 无法防御恶意节点或失陷 hub。**  
   位置：[peer-manager.ts:430](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:430)、[peer-manager.ts:709](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:709)、[rtc-log.ts:44](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/rtc-log.ts:44)

   每条 wake 都在任何抑制判断前无条件写日志。无连接时，攻击者还可以在上一轮失败结束后立即触发下一轮 RTC/WS/relay 拨号。即使已经是 `dc`，持续注入 wake 仍能制造无限日志，造成磁盘/日志管道 DoS。接收端还未验证自己确实是较小 ID 的 offerer；较小 ID 的恶意节点唤醒较大 ID 时，后者仍会进入 answerer 拨号并反向发送 wake。

3. **5 秒发送冷却会静默吞掉快速重连所需的 wake，而且不会在冷却结束后补发。**  
   位置：[peer-manager.ts:719](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:719)、[peer-manager.ts:741](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:741)、[peer-manager.ts:853](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:853)

   `clearRtcWake()` 只清除 `pending`，保留 `nextEligibleAt`。如果 DC 在建立后 5 秒内断开，较大 ID 一侧立即再次 `getLink()` 时，新的 answerer 会因冷却而不发送 wake，也没有延迟补发任务。较小 ID 一侧不会启动 offer，最终等待握手超时并降级到 WS/relay。

4. **`stop()` 会把尚未完成的 `waitForTransport()` 错误地解析为 `true`。**  
   位置：[peer-manager.ts:363](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:363)、[peer-manager.ts:404](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:404)

   `stop()` 调用 `waiter.resolve(false)`，但保存的闭包是 `resolve: () => finish(true)`，完全忽略传入值。具体场景：测试或调用方等待 `dc`，进程开始关闭，promise 却返回成功，产生“已经直连”的假阳性。现有测试只覆盖成功和超时，没有覆盖 stop。

5. **提前成功的 transport waiter 不会取消 timeout；吊销节点也不会清理其 waiter。**  
   位置：[peer-manager.ts:391](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:391)、[peer-manager.ts:408](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:408)、[peer-manager.ts:490](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:490)

   transport 到达后，map 项会删除，但 `scheduler.sleep(timeoutMs, stopAbort.signal)` 仍存活至原始超时，继续持有 waiter 闭包。大量长超时等待会积累定时器和内存。节点被吊销时，相关 waiter 也会一直等到超时，而不是立即返回 `false`。

6. **DataChannel 生命周期日志在真实 `node-datachannel` 上会被后续回调注册覆盖；fake 的多监听器模型掩盖了问题。**  
   位置：[rtc-peer-manager.ts:623](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:623)、[rtc-peer-manager.ts:655](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:655)、[data-channel-link.ts:49](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/data-channel-link.ts:49)、[test-fakes.ts:84](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/test-fakes.ts:84)

   `bindChannelDiagnostics()` 先注册 `onOpen/onError/onClosed`，`waitChannelOpen()` 随即再次注册这些回调，之后 `DataChannelLink` 又注册 `onOpen/onClosed`。本地缓存中的 node-datachannel 0.33.1 源码每类事件只保存一个 `ThreadSafeCallback`，后注册者会覆盖前者；fake 却把回调放进数组。因此生产环境可能完全没有 `datachannel open/error/closed` 日志，而新增测试仍通过。

7. **selected candidate pair 对 IPv4-mapped IPv6 地址脱敏不完整。**  
   位置：[ice.ts:216](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/ice.ts:216)、[rtc-peer-manager.ts:608](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:608)

   `maskIceAddress('::ffff:192.168.1.42')` 当前得到 `ffff:192.168.1.42::`，完整 IPv4 仍在日志中。双栈 socket 返回 IPv4-mapped 地址时，`selected pair` 会违反“不记录完整 IP”的要求。现有测试只覆盖普通 IPv4 和完整展开的 IPv6。

8. **单侧测试确实依赖 wake，但没有经过真实 hub 协议、认证和路由。**  
   位置：[peer-manager.test.ts:112](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.test.ts:112)、[peer-manager.test.ts:1101](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.test.ts:1101)

   测试仅调用较大 ID 的 `getLink()`，因此确实覆盖了 `wake → 小 ID getLink → offer`，不是直接配对 DC 的假捷径。但 fake uplink 将消息直接调用到 `receiveRtcSignal(fromId, ...)`，绕过了编码/解码、`UplinkServer.forwardDcSignal()`、下行来源绑定和吊销校验。它无法发现 finding 1，也无法证明真实 hub 路径会正确拒绝伪造 sender/session。应补一条使用真实 authenticated uplink server 的两节点测试及伪造/吊销反例。

## 其余结论

- DTO 的 `transport` 投影正确：保留 `reach` 兼容语义，对端返回实际 `ws-secure | relay | dc | null`，self 返回 `null`；未发现字段映射错误。
- 正常双方同时拨号时，`pending` 合并和确定性 node ID 角色避免了 offer glare；未知或已吊销 peer 在诚实 hub/正常接收路径下会被拒绝。
- 定向验证结果：新增 PeerManager 用例 4/4 通过，RTC/DTO 相关测试 52/52 通过。完整选定测试中的 6 个失败均因只读沙箱禁止 `Bun.serve()` 监听端口；TypeScript 仍为既有 21 个基线错误。