# 结论

**不建议通过。** 6 条 round-2 finding 中：**4 条已修复，2 条部分修复**。握手交接仍存在可复现的数据丢失 blocker；另外新增的 32 条缓存会静默淘汰消息。

## Round-2 六条结论

| Finding | 状态 | 证据 |
|---|---|---|
| 1. 握手 → Link 交接 | **部分修复** | 无监听器时会缓存，close/error 可向晚注册者回放；但握手监听器仍活跃时，LinkMux 帧进入 `recvQueue.pending`，随后被 `stop()` 丢弃。 |
| 2. 接收冷却绕过 | **已修复** | [peer-manager.ts:757](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:757) 在解析、验签前设置冷却；[peer-manager.ts:1660](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:1660) 在 `dropPeer()` 后保留至少 5 秒 gate。存在下述可用性副作用。 |
| 3. 全局 nonce FIFO | **已修复** | [peer-manager.ts:810](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:810) 改为 per-peer map；过期时间为 `issuedAt + 60s`，覆盖完整验签窗口；达到 256 后拒绝新值，不再驱逐仍有效 nonce。 |
| 4. nonce 规范编码 | **已修复** | [ice.ts:265](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/ice.ts:265) 解码后要求严格 16 字节，并通过重新编码比较拒绝 padding/非规范表示；解析入口也执行该检查。 |
| 5. 压缩 IPv6 脱敏 | **已修复** | [ice.ts:353](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/ice.ts:353) 先展开为 8 个 hextet，再由 [ice.ts:378](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/ice.ts:378) 保留 /48。round-2 的三个复现地址均得到预期结果。 |
| 6. revoked hub 集成路径 | **部分修复** | 消息现在经过 authenticated uplink/hub，但目标只是一个没有 runtime/uplink 的离线 revoked identity；即使删除 hub 的吊销判断，后续也会因 registry 中没有目标而丢弃，测试仍通过。 |

## Blocker

1. **握手监听器仍会吞掉先到达的 LinkMux 帧。**

   位置：[dc-handshake.ts:112](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/dc-handshake.ts:112)、[dc-handshake.ts:124](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/dc-handshake.ts:124)、[dc-handshake.ts:151](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/dc-handshake.ts:151)、[channel-fanout.ts:36](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/channel-fanout.ts:36)

   fanout 只在 `message.length === 0` 时缓存。若 A 已完成握手并发送 OPEN，而 B 已收到所需的 `sig`、但握手 Promise 尚未继续执行，B 的握手 listener 仍存在：`sig` 唤醒 waiter，随后的 OPEN 被放入握手 `pending`；B 随后退出循环并调用 `stop()`，该 OPEN 没有交回 fanout 或 Link。

   我用延迟 A→B `sig`、再让 A 完成后立即发送 OPEN 的不落盘脚本复现：

   ```json
   {"gotB":0,"statuses":["fulfilled","fulfilled"],"openA":true,"openB":true}
   ```

   即两端握手成功、通道仍 open，但 OPEN 永久丢失。新增测试在 [dc-handshake.test.ts:118](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/dc-handshake.test.ts:118) 先 `Promise.all` 等两端握手都结束，之后才在 [dc-handshake.test.ts:143](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/dc-handshake.test.ts:143) 创建 Link，因此没有覆盖真实竞态。

2. **浏览器 `sess` 的 nonce → carrier 交接仍吞首帧。**

   位置：[rtc-peer-manager.ts:373](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:373)、[rtc-peer-manager.ts:399](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:399)、[rtc-peer-manager.ts:678](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:678)

   `waitFirstMessage()` 注册的一次性 listener 在 Promise 结算后不注销。浏览器连续发送 nonce 和首个 carrier frame 时，第二帧仍被旧 listener 接收；因为 fanout 认为存在 listener，不会缓存，稍后构造的 `DataChannelCarrier` 收不到它。

   复现结果：

   ```json
   {"nonceObserved":true,"carrierFrames":[]}
   ```

   这是本轮新发现的遗留交接缺陷，不是 `78ee7a0` 首次引入，但本提交新增的 carrier 缓存无法修复它。

## Should-fix

3. **新增缓存有条数上限，但溢出时静默丢弃最旧消息。**

   位置：[channel-fanout.ts:3](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/channel-fanout.ts:3)、[channel-fanout.ts:38](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/channel-fanout.ts:38)、[data-channel-link.ts:138](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/data-channel-link.ts:138)、[data-channel-carrier.ts:69](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/data-channel-carrier.ts:69)

   因此缓存不是 unbounded，但可靠 DataChannel 被本地转换成了有损队列。发送 33 条后，我实际只收到 32 条，范围为 `1..32`，第 0 条被静默删除。若被删的是 OPEN、DATA 或某个重组 fragment，流会缺字节、挂起或出现协议错误。溢出至少应显式关闭通道，而不能继续交付已截断的数据序列。

4. **验签前冷却可以阻塞随后到达的合法 wake。**

   位置：[peer-manager.ts:749](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:749)、[peer-manager.ts:757](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:757)

   声称来自可信 peer 的坏签名 wake 会先占用 5 秒 gate；该 peer 的合法 wake 在窗口内直接 rate-drop。真实 hub 集成测试确认第一次合法拨号最终走到 `datachannel open timeout`，第二轮才成功，整条测试耗时约 **15.7 秒**。

   这不是新的权限突破：诚实 hub 会绑定 uplink sender，失陷 hub 本来就能直接丢弃 signaling。但它确实把一次伪造帧变成了稳定的合法重连延迟/阻塞手段，并造成实际的 10 秒 fallback。

## Nit

5. **revoked 集成测试仍可真空通过，且其他认证反例被冷却遮蔽。**

   位置：[rtc-wake.integration.test.ts:278](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/integration/rtc-wake.integration.test.ts:278)、[rtc-wake.integration.test.ts:297](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/integration/rtc-wake.integration.test.ts:297)、[uplink-server.ts:926](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-server.ts:926)、[uplink-server.ts:932](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-server.ts:932)

   - `revoked.nodeId` 只有数据库 identity，没有在线 registry entry。删除 `rtcNodesOwnedBy()` 的 revoked 检查后，消息仍在 `registry.get(msg.to)` 处丢弃，现有断言不变。
   - unsigned、wrong-key、spoofed-from 连续发送。首个 unsigned 已设置冷却，后两个主要只验证 rate-drop，不再分别验证 wrong-key 和 sender mismatch。
   - 应使用真实在线第三节点，建立 authenticated uplink 后在 hub store 标记吊销，再从该仍存活 uplink 发 wake；各伪造子例之间则应推进测试时钟或使用不同 peer。

## 专项风险核对

- **Closed-channel refusal 遗留 pending dial：没有发现。** [rtc-peer-manager.ts:301](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:301) 拒绝关闭通道；catch 关闭 PC；[peer-manager.ts:1026](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:1026) 释放 signaling/inbox；[peer-manager.ts:513](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:513) 最终删除 `pending`。
- **未知 peer 导致 nonce outer map 增长：没有。** [peer-manager.ts:464](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:464) 在进入 wake handler 前拒绝不可信 peer；nonce map 只在验签成功后创建。过期项是按同一 peer 下次合法 wake 惰性清理，不会按墙钟主动删除，但每个可信 peer 有容量上限。
- **验证结果：** RTC 定向测试 24 pass、0 fail；真实 hub wake 集成测试 1 pass、0 fail，但暴露上述首次拨号 timeout。更大的定向集合为 50 pass、6 fail，6 项均是只读沙箱禁止 `Bun.serve()` 监听端口。
