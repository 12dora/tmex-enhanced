# B1-2 结果 — link codec / 流控 / LinkSession

## 做了什么

新增自包含模块 `packages/shared/src/link/`（Bun + 浏览器，无 `bun`/`node:` import），并从 `@tmex/shared/link` 导出。未改 `packages/shared/src/index.ts`。

| 文件 | 作用 |
|---|---|
| `packages/shared/src/link/types.ts` | 常量、错误、`LinkStream` / `LinkSession` / `ByteTransport` |
| `packages/shared/src/link/codec.ts` | 帧编解码 + 增量 `FrameDecoder` |
| `packages/shared/src/link/mux.ts` | `LinkMux`：流状态机 + 窗口流控 |
| `packages/shared/src/link/in-memory-link.ts` | 进程内 byte pipe 与 `createInMemoryLinkPair` |
| `packages/shared/src/link/websocket-link.ts` | `WebSocketLink`（标准 WS + 服务端 adapter） |
| `packages/shared/src/link/secure-channel-link.ts` | AES-256-GCM 封装 + HKDF/X25519 密钥日程 |
| `packages/shared/src/link/index.ts` | barrel |
| `packages/shared/src/link/*.test.ts` | 5 个测试文件，27 个用例 |
| `packages/shared/package.json` | `exports["./link"]` |

（`package.json` 里同时存在的 `"./auth"` 是并行任务写入的，未改其内容。）

## 协议要点

- 帧：`[streamId u32 LE][op u8][flags u8][len u32 LE][payload]`，header 10 B。
- op：`OPEN=1 DATA=2 END=3 RST=4 WINDOW=5`。`flags` bit0 = `head`。
- 单帧 payload ≤ 1 MiB（超限 → 协议错误关链路）；流初始窗口 1 MiB；链路未确认出站 > 32 MiB → 关链路。
- Initiator 奇数 id，acceptor 偶数 id；stream 0 = `ctl`（只 DATA，禁止 END/RST）。
- `END` 半关闭发送方向；双向 END → `closed.reason='end'`。`RST` 立刻双向终止。
- 未知/已关闭流上的 DATA/END → 对该 id 发 RST 并忽略。
- WINDOW 在 **消费** 后发送：`readable` 使用 `highWaterMark: 0` 的 pull 流，应用 `read()` 才回 WINDOW。

## 公共 API

入口：`import { … } from '@tmex/shared/link'`

### 会话 / 流

```ts
class LinkMux implements LinkSession {
  constructor(transport: ByteTransport, opts: LinkMuxOptions)
}
type LinkMuxOptions = {
  role: 'initiator' | 'acceptor';
  streamWindow?: number;      // default 1 MiB
  maxFramePayload?: number;   // default 1 MiB
  maxLinkUnacked?: number;    // default 32 MiB
}

interface LinkSession {
  openStream(openPayload: Uint8Array): Promise<LinkStream>;
  onStream(cb: (stream: LinkStream) => void): void;
  readonly ctl: { send(bytes: Uint8Array): void; onMessage(cb: (bytes: Uint8Array) => void): void };
  close(reason?: string): void;
  readonly closed: Promise<{ reason: string }>;
}

interface LinkStream {
  readonly id: number;
  readonly openPayload: Uint8Array;
  readonly readable: ReadableStream<{ bytes: Uint8Array; head: boolean }>;
  write(bytes: Uint8Array, opts?: { head?: boolean }): Promise<void>; // 进入发送窗口后 resolve
  end(): void;
  reset(reason?: string): void;
  readonly closed: Promise<{ reason: 'end' | 'rst' | 'link-closed'; message?: string }>;
  onAbort(cb: () => void): void; // peer RST 或链路关闭；已 abort 时立即调用
}

type ByteTransport = {
  send(bytes: Uint8Array): void | Promise<void>;
  onData(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: (reason?: string) => void): void;
  close(reason?: string): void;
};
```

`write()` 按窗口与 1 MiB 帧上限分片；`head` 只打在该次 write 的第一片。

### 传输实现

```ts
function createBytePipe(): [ByteTransport, ByteTransport];
function createInMemoryLinkPair(): [LinkSession, LinkSession]; // [initiator, acceptor]

class WebSocketLink implements LinkSession {
  constructor(ws: WebSocketLike, opts: { role: LinkRole; streamWindow?: number; … })
}
interface WebSocketLike {
  send(data: Uint8Array): number | undefined; // Bun ServerWebSocket 可返回写入字节数
  close(code?: number, reason?: string): void;
  binaryType?: string;
  readyState?: number;
  onopen / onmessage / onclose
  addEventListener?: (type: string, listener: (ev: unknown) => void) => void;
}
function websocketTransport(ws: WebSocketLike): ByteTransport;
```

客户端传标准 `WebSocket`（会设 `binaryType='arraybuffer'`，CONNECTING 时排队）。服务端用 `{ send, close, onmessage, onclose }` 包一层 Bun `ServerWebSocket`，本包不 import Bun 类型。

### SecureChannel

```ts
class SecureChannelLink implements ByteTransport {
  constructor(inner: ByteTransport, opts: SecureChannelOptions)
  onRekeyNeeded(cb: () => void): void
}
type SecureChannelOptions = {
  sendKey: Uint8Array;   // 32
  recvKey: Uint8Array;   // 32
  sendDirection: number; // u32，进 nonce
  recvDirection: number;
  sendCounter?: bigint;  // 测试/恢复
  recvCounter?: bigint;
};

function secureChannelDirections(role: LinkRole): { sendDirection: number; recvDirection: number };
// initiator: send=1 recv=2；acceptor 相反
const SC_DIRECTION_INITIATOR = 1;
const SC_DIRECTION_ACCEPTOR = 2;
const SC_REKEY_COUNTER = 2n ** 63n;

function deriveSecureChannelKeys(
  sharedSecret: Uint8Array,
  transcriptHash: Uint8Array,
  senderNodeId: Uint8Array | string,   // 建议 raw 16B node_id
  receiverNodeId: Uint8Array | string
): { sendKey: Uint8Array; recvKey: Uint8Array };

function x25519SharedSecret(sk: Uint8Array, pk: Uint8Array): Uint8Array;
function buildAesGcmNonce(direction: number, counter: bigint): Uint8Array; // 12B
function byteTransportFromStream(stream: LinkStream): ByteTransport; // relay 流 → 内层 transport
```

密钥：`sendKey = HKDF-SHA-256(ss, salt=transcriptHash, info="tmex-sc/v1/" ‖ sender ‖ "->" ‖ receiver, 32)`，`recvKey` 对调 sender/receiver。

线格式：明文 10 B header（`len` = ciphertext‖tag 长度）‖ ciphertext ‖ tag(16)。**AAD = 明文帧头**（`len` = 原 payload 长度 = wire_len − 16）。nonce = `u32 direction LE ‖ u64 counter LE`。计数器 ≥ 2^63：触发 `onRekeyNeeded` 并拒绝继续 send。

Phase 2 relay 组装：`new LinkMux(new SecureChannelLink(byteTransportFromStream(relayStream), { sendKey, recvKey, ...secureChannelDirections(role) }), { role })`。

### 编解码

```ts
encodeFrame({ streamId, op, flags?, payload? }): Uint8Array
encodeFrameHeader(streamId, op, flags, payloadLength): Uint8Array
class FrameDecoder { constructor(opts?: { maxPayload?: number }); push(chunk: Uint8Array): Frame[] }
```

## HKDF 固定向量（给 auth 交叉核对）

```
sharedSecret   = 32 × 0x11
transcriptHash = 32 × 0x22
senderNodeId   = 16 × 0x33   (raw bytes，不是 hex 字符串)
receiverNodeId = 16 × 0x44
info           = "tmex-sc/v1/" ‖ sender ‖ "->" ‖ receiver   (UTF-8 前缀/箭头 + raw id)

sendKey = 9bedf74372ce35b96fed7c4be7e4ab00a7d46bfc68a7b6c6d8c4651d7bb9167c
recvKey = 5c82f44020726a4698df0075a900cb4192772a5e91f3ba9b04fd4105a504a888
```

对端用 `deriveSecureChannelKeys(ss, th, receiver, sender)` 即互换。

## 测试

`cd packages/shared && bun test src/link`：

```
 27 pass
 0 fail
 91 expect() calls
Ran 27 tests across 5 files. [114.00ms]
```

覆盖：codec 往返/半包重组；id 奇偶；1 MiB 窗口阻塞直到消费后 WINDOW；超限帧关链路；32 MiB unacked 关链路；双向 half-close；RST → onAbort + pending write reject；未知 DATA → RST；ctl 不关闭；InMemory 并发流；Fake WebSocket pair；SecureChannel 加解密、nonce 不重用、密文/AAD 篡改失败、方向密钥不同、上述 HKDF 向量。

`cd packages/shared && bun test`（含并行 auth 模块新测试）：

```
 231 pass
 0 fail
 681 expect() calls
Ran 231 tests across 28 files. [753.00ms]
```

基线 141；本任务 +27；其余为并行 auth。全绿。

## tsc / biome

- 基线 `packages/shared` tsc：**0**
- 之后 `bunx tsc --noEmit -p packages/shared`：**0**（本模块文件无错误，总数未增加）
- `bunx biome check packages/shared/src/link packages/shared/package.json`：clean

## 协调器需要知道的

- 消费方请用 `@tmex/shared/link`，不要从主入口 `@tmex/shared` 再导出（避免进浏览器 bundle 的约束与本任务一致）。
- 本任务**未**实现 `DataChannelLink`（架构 §3 有，B1-2 范围没有）。
- gateway 包 Bun `ServerWebSocket` 时需自己写 adapter：`send(bytes)` 直接转 `ws.send(bytes)`，`onmessage`/`onclose` 钩上。
- `node_id` 在 HKDF info 里按 **raw bytes** 拼接。若 auth 用 hex 字符串，向量会对不上——请按上面向量对齐。
- 无需改本范围外的文件。
