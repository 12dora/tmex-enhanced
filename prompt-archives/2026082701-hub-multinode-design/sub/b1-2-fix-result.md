# B1-2-fix 结果 — link 层审查修复

范围：仅 `packages/shared/src/link/**`。9 条审查意见均已按 TDD（先红后绿）修完。

## 改了哪些文件

| 文件 | 作用 |
|---|---|
| `types.ts` | `LinkStream.end(): Promise<void>` |
| `codec.ts` | `FrameDecoder` 改为 chunk list + cursor |
| `mux.ts` | 发送链 END、逐流 outstanding、WINDOW 校验、RST/关闭释放额度、远端 OPEN 奇偶/递增、本地分配防覆盖 |
| `secure-channel-link.ts` | 链路发送队列；AAD = 实际线上帧头；模块头写明互通契约 |
| `websocket-link.ts` | 拆成 client/server 适配器 + 链路发送队列/背压 |
| `index.ts` | 导出新适配器，去掉 `WebSocketLike` |
| `*.test.ts` | 每条审查对应回归测试 |

## 公共 API 变化

保持 `LinkMux` / `LinkSession` / `LinkStream` / `SecureChannelLink` / `secureChannelDirections` / `byteTransportFromStream` / `deriveSecureChannelKeys` / `x25519SharedSecret` / `createInMemoryLinkPair`。

刻意变更：

```ts
interface LinkStream {
  end(): Promise<void>; // 原先 void；排在已发出的 write 之后
}

// 删除 WebSocketLike。WebSocketLink 接受二者之一：
constructor(socket: WebSocket | ServerSocketAdapter, opts: WebSocketLinkOptions)

function createClientWebSocketTransport(ws: WebSocket): ByteTransport
function createServerSocketTransport(adapter: ServerSocketAdapter): ByteTransport
function websocketTransport(socket: WebSocket | ServerSocketAdapter): ByteTransport

interface ServerSocketAdapter {
  send(bytes: Uint8Array): number;          // Bun：>0 成功，-1 背压，0 丢弃
  close(code?: number, reason?: string): void;
  onMessage(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: (reason?: string) => void): void;
  onDrain(cb: () => void): void;
}
```

仍导出 `WebSocketTransportInput`、`WebSocketLinkOptions`。

## 审查项 → 改动 → 测试

1. **SecureChannel 发送队列**  
   `send()` 整段「分配 counter → encrypt → inner.send」走 `sendChain`。失败 `finishClose` 并拒绝后续队列。  
   测试：`serializes concurrent sends so wire order matches counter order`；`closes the channel and rejects the rest of the queue on send failure`

2. **AAD = 线上帧头**  
   加密前按 `payload.length + 16` 构造 wire header 作 AAD 并发送；解密用收到的线上帧头作 AAD，再重建明文 header。模块头注释写明互通契约。  
   测试：`uses the sent wire header as GCM AAD (len = ciphertext+tag)`（顺带更新 `uses a unique nonce per frame`）

3. **`end()` 入发送链**  
   调用时立刻 `sendClosed`（新 write 立即 reject），END 排在已入队 write 之后；返回 `Promise<void>`。  
   测试：`enqueues END behind in-flight writes and returns a promise`

4. **WINDOW 校验**  
   逐流 `outstanding`；只接受 `0 < delta <= outstanding`（含 ctl 上 outstanding=0、delta=0、超额）；全局 `unacked` 只减同一 delta。超过初始窗口也关链路。  
   测试：`closes the link on WINDOW that is not 0 < delta <= outstanding`；`accepts WINDOW only up to outstanding and decrements global unacked by the same delta`

5. **RST / 关闭释放额度**  
   本地 RST、远端 RST、双向 END `forgetStream`、链路关闭都 `releaseOutstanding`。已终结流上迟到的 WINDOW 被忽略（stream 已不在 map）。  
   测试：`releases remaining outstanding on RST so later streams can send`；`releases remaining outstanding on local RST`；`ignores a late WINDOW after RST instead of double-counting credit`

6. **WebSocket 发送队列 / 背压**  
   所有发送（含连接前积压）走同一队列。服务端 `send()===-1` 暂停，`onDrain` 恢复；`===0` 关 `LinkSession`。客户端 `bufferedAmount > 4MiB` 暂停，轮询到 `< 1MiB` 恢复。  
   测试：`pauses the server send queue on -1 and resumes on drain`；`closes the LinkSession when the server socket send returns 0`；`throttles client sends when bufferedAmount is above 4 MiB and resumes below 1 MiB`；`queues sends until the client socket opens and flushes through the send path`

7. **远端 OPEN 奇偶 + 递增**  
   远端必须用相反奇偶、id 严格大于 `remoteMaxStreamId`；本地 `allocStreamId` 若 id 已存在则协议错误而非覆盖。  
   测试：`rejects remote OPEN with the local role parity instead of overwriting the id`；`rejects remote OPEN that is not strictly increasing`

8. **拆分 WebSocket 适配器**  
   `createClientWebSocketTransport(ws: WebSocket)` 对真实 `WebSocket` 可赋值（编译期断言）；`ServerSocketAdapter` 用结构假对象。`WebSocketLink` 接受两者。  
   测试：`createClientWebSocketTransport type-checks against a structural fake`；`createServerSocketTransport type-checks against a structural fake`；文件顶编译期 `_clientTransportAcceptsWebSocket: (ws: WebSocket) => ByteTransport`

9. **FrameDecoder O(n)**  
   chunk 列表 + cursor；仅在完整帧可用时拼接一次（单 chunk 内直接 slice）。  
   测试：`reassembles a 1 MiB frame delivered as 1-byte chunks in well under a second`；`emits three complete frames and retains a half frame from coalesced input`

## 测试 / tsc / biome

`cd packages/shared && bun test src/link`：

```
 45 pass
 0 fail
 152 expect() calls
Ran 45 tests across 5 files. [474.00ms]
```

`cd packages/shared && bun test`：

```
 277 pass
 0 fail
 866 expect() calls
Ran 277 tests across 28 files. [1070.00ms]
```

基线 231 pass / 0 tsc；本任务后 **tsc 0 → 0**（`bunx tsc --noEmit -p .` exit 0）。`biome check packages/shared/src/link` clean。

## 协调器需要做的

- **AAD 互通契约已变**：对端必须用线上 10B 头（`len = ciphertext+tag`）作 GCM AAD，不能再用明文 payload 长度。auth/handshake 侧无需改密钥日程。
- **消费 `WebSocketLike` 的代码必须改**：该类型已删除。客户端传标准 `WebSocket`；gateway 包 Bun `ServerWebSocket` 时实现 `ServerSocketAdapter`（`send` 返回 number，并用 Bun 的 `drain` 调 `onDrain`）。旧的 `{ onmessage, onclose }` 属性钩子不再被识别。
- **`LinkStream.end()` 现返回 `Promise<void>`**：运行时可忽略；若他处有 `end(): void` 实现则需对齐。
- 本范围外无需改文件才能让 shared 绿；gateway 接入 WebSocketLink 时才需要 adapter。
