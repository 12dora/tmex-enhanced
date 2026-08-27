## blocker

1. `apps/gateway/src/mesh/rtc/carrier-switch.ts:52`  
   **问题：** 发送 `CARRIER_SWITCH{to:direct}` 后没有立即把 node 的出站载体切到 direct；真正切换发生在收到 ACK 后的第 62 行，顺序与 §3 相反。  
   **影响：** 浏览器收到 switch 后会停止从 primary 接收入站数据，但 ACK 到达 node 前产生的终端输出仍被发送到 primary。这些帧位于 switch 帧之后，浏览器已经切换接收源，因而会直接丢失。  
   **建议：** 捕获旧载体并通过它发送 switch，发送成功后立即 `session.switchActiveCarrier(direct)`；ACK 只用于解除 direct 入站缓冲并完成屏障，不应控制 node 的出站切换。相应修改测试，使 attach 后 node 的 active carrier 已是 direct。

## major

1. `apps/gateway/src/mesh/rtc/dc-handshake.ts:75`  
   **问题：** 身份验签前的 `recvQueue` 对消息数量和总字节数完全不设上限，每条消息还会复制一份。  
   **影响：** 失陷 hub 可以把 peer 信令改接到攻击者的 DTLS 端点；攻击者虽然最终无法提供合法 transcript 签名，但能在 10 秒握手窗口内持续发送 DataChannel 消息，令 `pending` 无限增长并耗尽目标 node 内存。  
   **建议：** 对握手帧设置很小的单帧上限和队列上限，例如 4 KiB、最多 8 条；超限、未知消息过多或 channel 关闭时立即终止握手并关闭 PeerConnection。

2. `apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:286`  
   **问题：** `acceptBrowser()` 使用 `ensureBrowser()`，因此未经 `/api/rtc/authorize` 登记的 `rtcSession` 也会创建原生 PeerConnection。成功使用的记录又因第 380 行只清理 `!rec.used` 的记录而永久留在 Map 中。  
   **影响：** 按设计由入站信令调用该方法后，失陷 hub 可以伪造大量随机 `rtcSession`，在没有 node-session 和 nonce 的情况下批量分配 PeerConnection；合法浏览器反复建立直连也会永久积累已使用记录和 PC，最终耗尽原生资源。  
   **建议：** `acceptBrowser()` 只接受已由 authorize 创建的记录，未知 session 直接拒绝；设置全局登记数量上限；nonce 验证成功后原子删除授权记录，将已接管的 PC 放入独立生命周期管理，并在 direct carrier 关闭时关闭 PC。过期记录应由定时器主动回收。

3. `apps/gateway/src/mesh/rtc/fragmenter.ts:97`  
   **问题：** 重组器只限制同时存在 32 个 frameId，没有限制 `total`、单片载荷和单帧累计字节数；`total` 最大可达 65535，完成时第 117–125 行会按攻击者累计的数据量分配连续内存。  
   **影响：** 一台失陷 node 可向另一台 node 声明 `total=65535` 并持续发送大分片，使单个待重组帧增长到数 GiB，造成 OOM 或在最终分配 `Uint8Array` 时抛出未处理异常，违反“失陷 node 只影响自身”的隔离目标。  
   **建议：** 固定最大重组帧为 1 MiB，验证 `total <= ceil(maxFrameBytes/maxFragmentPayload)`、每片长度不超过协议上限、累计长度不超过 1 MiB；违反时应关闭对应通道，而不是静默丢弃。

4. `apps/gateway/src/mesh/rtc/fragmenter.ts:129`  
   **问题：** 15 秒 timeout 只在下一次 `push()` 时调用 `sweep()`，空闲通道上的过期分片不会被主动释放。  
   **影响：** 对端填满 32 个未完成帧后停止发送，相关内存可以保留到通道关闭，而不是 15 秒；长期存活的直连或 peer link 会持续占用攻击者注入的缓冲区。  
   **建议：** 为最早 deadline 安排定时清理，或由载体维护周期性 sweep；通道关闭时显式清空全部 pending 状态。

5. `apps/gateway/src/mesh/rtc/data-channel-link.ts:58`  
   **问题：** `sendMessageBinary()` 返回 false 后只把整帧重新放回队列，没有注册 `onBufferedAmountLow()`，因此队列永远不会再次 flush；同时 `send()` 返回 void，`LinkMux` 会误认为数据已经发送成功。  
   **影响：** peer link 一旦在正常高负载下触发一次底层背压，就会永久停住，而 `openStream()`/`write()` 仍可能已经成功返回。若失败发生在中间分片，接收端还会留下永远无法完成的半帧。  
   **建议：** 实现带 resolver 的发送队列，设置高/低水位并在 `onBufferedAmountLow` 后从失败分片继续发送；`send()` 返回的 Promise 只能在整帧被底层接受后 resolve，关闭时应 reject 所有队列项。

6. `apps/gateway/src/mesh/rtc/data-channel-carrier.ts:60`  
   **问题：** 底层拒绝任一分片时返回 `backpressure`，但当前 Borsh 帧没有被内部保存或重试；若前面的分片已发送，已经形成不可恢复的截断帧。  
   **影响：** `WebSocketSendGuard` 把该状态视为当前帧已处理并只暂停后续发送。低水位事件到来后它会继续工作，当前终端事件则永久丢失；中间分片失败时重组器只会在超时后静默删除半帧。  
   **建议：** 在发送前检查高水位；一旦开始发送，carrier 必须内部保存剩余分片并保证整帧完成。若无法保证原子续传，部分发送后的 false 必须视为传输 gap 并立即关闭 direct carrier，触发 primary 回退。

7. `apps/gateway/src/mesh/rtc/fragmenter.ts:2`  
   **问题：** 常量把载荷本身设为 64 KiB，因此实际 DataChannel 消息是 64 KiB 加 8 字节头；发送方也完全忽略 `channel.maxMessageSize()`。  
   **影响：** 与只协商出 65536 字节上限的浏览器连接时，任何大于 65528 字节的帧都会在首个满分片处发送失败，导致直连或 peer link 无法传输正常的较大 Borsh/link 帧。  
   **建议：** 将 64 KiB 定义为包含头部的消息上限，载荷设为 `64 KiB - 8`；实际发送时再取 `min(协议载荷上限, channel.maxMessageSize() - 8)`，并拒绝无法容纳头部的通道。

8. `apps/gateway/src/mesh/rtc/ice.ts:19`  
   **问题：** TURN 对象包含 `url/username/credential` 时只保留 URL 字符串，用户名和凭证被丢弃；而 node-datachannel 的结构化配置需要 `username/password`。  
   **影响：** 配置了认证 TURN 的部署会以匿名方式连接 TURN，服务器拒绝 allocation；处于复杂 NAT 的节点因此无法使用设计中的 TURN 回退，只能继续退到高延迟 hub relay。现有测试还把这一错误行为锁定为预期。  
   **建议：** 按 node-datachannel 0.33.1 的 `IceServer` 类型解析 TURN URL，传递 `hostname`、`port`、`username`、`password` 和正确的 `relayType`；同步修正测试，验证凭证确实进入 PeerConnection 配置。

结论：该 diff 的指纹 transcript 与浏览器 nonce/fingerprint 基本绑定到了正确对象，但载体切换顺序会直接丢业务帧，且握手、分片重组和 RTC 授权登记存在可被失陷 hub 或 peer 放大的资源耗尽问题；DataChannel 背压和 TURN 配置也无法在真实负载及复杂 NAT 下可靠工作。当前版本不应合入，至少应先修复上述 blocker 和所有 major 问题并补充对应的故障及攻击场景测试。