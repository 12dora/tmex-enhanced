## blocker

1. **`packages/shared/src/link/secure-channel-link.ts:237`：并发发送未串行化，隐式 nonce 计数器与线上帧顺序可能不一致。**
   - `LinkMux` 会从多个流并发调用 `send()`；两个调用分别取得 counter 0、1 后并发执行 WebCrypto，较小帧可能先完成并写入底层传输。接收端按到达顺序从 counter 0 解密，立即发生 GCM 校验失败并关闭链路。并发发送 1 MiB 帧与 1 字节帧即可稳定触发。
   - 建议：用链路级发送队列串行执行“解析帧、分配 counter、加密、`inner.send`”全过程；任一加密或发送失败后关闭 SecureChannel 并拒绝后续队列，不能继续使用已经跳过的 counter。

## major

1. **`packages/shared/src/link/secure-channel-link.ts:248`：AAD 不是实际发送的帧头，不符合 §2 step 3。**
   - 加密时 AAD 使用 `len = plaintext.length` 的 `ptHeader`，线上发送的却是 `len = ciphertext.length` 的 `wireHeader`。遵循规范、以实际帧头作为 AAD 的另一端会对每个 SecureChannel 帧解密失败，也会造成不同版本实现无法互通。
   - 建议：加密前按 `plaintext.length + GCM_TAG_LENGTH` 构造最终线上帧头，并直接把该帧头作为 AAD；解密时以收到的线上帧头重建相同 AAD，解密后再生成内层明文帧头。

2. **`packages/shared/src/link/mux.ts:122`：`end()` 会越过此前已调用但尚未执行的 `write()`。**
   - `write()` 通过 Promise 微任务进入 `writeChain`，而 `end()` 同步设置 `sendClosed` 并立即发送 END。调用 `const p = stream.write(body); stream.end()` 时，对端先收到 END、读到空 body，随后 `p` 以“stream send direction is closed”失败。这会直接破坏 HTTP 请求体/响应体的 half-close 语义。
   - 建议：把 END 排入同一个发送链，在所有先前写入成功后发送；调用 `end()` 时只标记拒绝新的写入。最好让 `end()` 返回 Promise，以便传播底层发送失败。

3. **`packages/shared/src/link/mux.ts:639`：WINDOW 增量未经 outstanding 校验，可绕过流窗口和 32 MiB 上限。**
   - 任意现存流（包括 ctl）收到 `WINDOW{0xffffffff}` 都会扩大 `sendWindow`，同时把全局 `unacked` 强制减到零，即使该流从未发送对应字节。对端可周期性发送伪造 WINDOW，使发送方持续突破每流 1 MiB 和链路 32 MiB 限制。
   - 建议：逐流记录实际未确认字节；仅接受 `0 < delta <= stream.outstanding` 的 WINDOW，并同步扣减逐流与全局计数。超额、零增量或导致窗口超过初始窗口的 WINDOW 应作为协议错误关闭链路。

4. **`packages/shared/src/link/mux.ts:629`：RST 删除流时没有释放该流的未确认额度。**
   - 目标提前拒绝请求体是 §3 明确要求的正常场景。若连续 32 个流各发送 1 MiB 后被对端 RST，`unacked` 会永久保留为 32 MiB；第 33 个流发送 1 字节时链路被错误关闭。
   - 建议：逐流维护 outstanding；处理本地或对端 RST 时终结该流并从全局 `unacked` 中释放其剩余额度。流终态处理必须保证迟到的 WINDOW 不会重复扣减。

5. **`packages/shared/src/link/websocket-link.ts:42`、`packages/shared/src/link/websocket-link.ts:101`：WebSocket 发送结果和背压被当作成功。**
   - Bun `send()` 返回 `-1` 表示消息已入队但存在背压，返回 `0` 表示消息已丢弃；当前两者都立即成功返回，连接前积压队列的 flush 甚至完全不检查结果。慢链路下实现会继续灌入数据并触发 Bun 的背压关闭；返回 0 时 DATA、END 或 WINDOW 会静默丢失，造成内容缺失或流永久等待。
   - 建议：实现链路级发送队列；Bun 端在 `-1` 后暂停并由 `drain` 恢复，浏览器客户端依据 `bufferedAmount` 限流；返回 0 时立即拒绝发送并关闭 LinkSession。连接前积压队列必须走同一发送路径。

6. **`packages/shared/src/link/mux.ts:605`：未校验远端 OPEN 的 stream ID 奇偶性。**
   - 本端为 initiator 时，远端发送奇数 OPEN 1 会被接受；本端随后分配自己的首个流时同样得到 1，并直接覆盖 Map 中的远端流。后续 DATA 会投递到错误对象，另一端通常因重复 OPEN 关闭整条链路。
   - 建议：根据本端角色强制远端使用相反奇偶性，并跟踪远端最大 stream ID、防止复用；本地分配时如 ID 已存在，应立即报协议错误而不是覆盖。

7. **`packages/shared/src/link/websocket-link.ts:9`：声明的 `WebSocketLike` 与浏览器/Bun 客户端 `WebSocket` 不兼容。**
   - 标准 `WebSocket.send()` 返回 `void`，不能赋给这里的 `number | undefined`；`onopen/onmessage/onclose` 的参数声明也与 DOM 事件回调不兼容。因此直接执行 `new WebSocketLink(new WebSocket(url), ...)` 会在 TypeScript 类型检查时报错，无法用于注释声称支持的客户端 WebSocket。
   - 建议：为标准客户端 WebSocket 和 Bun 服务端包装器提供明确的独立适配器，或把接口改为兼容真实返回值及事件签名；不要依赖当前不成立的结构化类型兼容。

## minor

1. **`packages/shared/src/link/codec.ts:127`：任意碎片输入下存在二次方复制成本。**
   - 每次收到未完成帧的新片段都会重新分配 `buffer.length + chunk.length` 并复制全部历史数据。1 MiB 帧若被拆成大量小片段，会累计复制数十至数百 GiB 数据，实际表现为链路线程长时间阻塞。
   - 建议：保留分段队列并记录读取游标，或使用可增长缓冲区，仅在完整帧需要连续 payload 时合并一次；增加大量小片段和“多帧加半帧”组合测试。

结论：当前 diff 不应合并。正常的 relay 多流并发即可触发 SecureChannel 解密失败；half-close、RST 和 WINDOW 处理会导致数据丢失、额度泄漏或绕过上限，WebSocket 适配器也尚未正确处理 Bun/浏览器的真实发送与背压语义。现有 happy-path 测试无法覆盖这些核心竞态与互操作问题。