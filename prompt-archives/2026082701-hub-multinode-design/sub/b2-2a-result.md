# B2-2a 结果 — Mesh 传输面（UplinkClient / PeerManager / stream targets / dispatchHttp）

worktree：`/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。

## 做了什么

节点侧 transport plane：**连 hub、peer link（path 1 = 明文 WS mux，path 3 = relay + SecureChannel）、http/ws 流终结**。WebRTC DataChannel（path 1 数据面 / path 2）留给 B3-1，类型上留了 `PeerTransportKind = 'dc'` 与 `DataChannelLinkSlot`。

未改 `src/auth/**`、`src/hub/**`、`packages/**`、`mesh/rtc/**`、`auth-routes*` / `mesh-routes*` / `forwarder*`。

## 文件清单

新增 `apps/gateway/src/mesh/`：

| 文件 | 职责 |
|---|---|
| `types.ts` | 身份、`KeyLogApplier`、transport 种类、错误 |
| `ctl.ts` | JSON ctl 编解码、backoff、scheduler |
| `uplink-protocol.ts` | 客户端 uplink ctl codec（**不** import `src/hub/**`） |
| `uplink-client.ts` | `UplinkClient` |
| `peer-protocol.ts` | peer handshake（ws-direct / relay） |
| `peer-server.ts` | `Bun.serve` `/peer` + 源 IP 限速 |
| `peer-manager.ts` | 复用 / LAN 回落 / relay / idle / 吊销 |
| `link-stream-carrier.ts` | `Carrier` over `LinkStream` |
| `stream-targets.ts` | http/ws 流两端 |
| `index.ts` | barrel |
| `test-support.ts` + `*.test.ts` | 单测（不从 barrel 导出） |

修改：

- `apps/gateway/src/runtime.ts` — `dispatchHttp`
- `apps/gateway/src/api/index.ts` / `route.ts` — `ApiRouteContext.server` 可选
- `apps/gateway/src/ws/index.ts` — `attachStreamSession`
- `apps/gateway/src/ws/index.test.ts` — 覆盖 `attachStreamSession`

## 导出 API

```ts
import {
  UplinkClient, PeerManager, PeerServer,
  LinkStreamCarrier, openHttpStream, openWsStream,
  acceptHttpStream, acceptWsStream,
  handshakeWsDirect, handshakeRelay,
  NodeUnreachableError,
} from './mesh'  // apps/gateway/src/mesh
```

### `UplinkClient`

```ts
type MeshIdentity = { nodeId: string /* 16B hex */; edSecretKey: Uint8Array }
type UplinkStatus = {
  version: string; tmux: boolean; direct_capable: boolean;
  inventory: unknown; endpoints: unknown;
}
type KeyLogApplier = {
  head(userId: string): Promise<{ seq: bigint; hash: Uint8Array }>
  applyMany(userId: string, records: { bytes: Uint8Array; sig: Uint8Array }[]):
    Promise<{ applied: number; error?: string }>
  list?(userId: string, fromSeq: bigint):
    Promise<{ seq: bigint; bytes: Uint8Array; sig: Uint8Array }[]>
}

new UplinkClient({
  hubUrl, identity, userId, keyLogApplier, userStore,
  statusProvider: () => UplinkStatus,
  onNodeList?, onRtcSignal?, onEnrollRedeemed?,
  wsFactory?, scheduler?, pingIntervalMs?,
})

readonly identity: MeshIdentity
readonly userId: string
link: LinkSession | null
state: 'offline' | 'connecting' | 'online'
start(): void
stop(): Promise<void>
onStateChange(cb: (state) => void): () => void
setOnRelayStream(handler: ((stream, fromNodeId: string) => void) | null): void
sendCtl(msg: UplinkCtlMessage): void
sendStatus(): void
openRelay(toNodeId: string): Promise<LinkStream>  // OPEN JSON {to}
```

行为：`wss://<hub>/hub/uplink`；退避 1s→60s + jitter；`auth.challenge` 对 **nonce 原字节** Ed25519 签名；上线发 `node.status`，`sendStatus()` 或心跳里 status 变化再发；15s ping，3 次未 pong 重连；`node.list` 只 upsert `peer_cache` 元数据（跳过 self），`key_log_head.seq > local` → `key.log.req{from_seq: head+1}` → `applyMany`。

入站 uplink 流 OPEN `{to: self, from}` 交给 `setOnRelayStream`（PeerManager 构造时挂上）。

### `PeerManager`

```ts
new PeerManager({
  identity, userStore, uplink, peerPort,
  now?, scheduler?,
  keyLogApplier?, statusProvider?,          // peer ctl node.status / key.log
  sessionStore?, dispatchHttp?, wsServer?,  // 终结 http/ws 流（B2-2b 注入）
  connectTimeoutMs?, idleMs?, hostname?, wsFactory?,
  startServer?,                             // 测试可 false
})

get listenPort(): number | null
start(): Promise<void>
stop(): Promise<void>
getLink(nodeId: string): Promise<LinkSession>
onRevoked(nodeId: string): void   // close + deletePeer
listReach(): Map<string, 'lan' | 'relay' | null>
```

`getLink`：活链路复用 → `peer_cache.endpoints_json` 依次 `ws://host:port/peer`（3s 超时）→ `uplink.openRelay` → 全失败抛 `NodeUnreachableError`（`code = 'NODE_UNREACHABLE'`）。无流 5 min idle 关闭。入站 http/ws 流走 `acceptHttpStream` / `acceptWsStream`。

### 握手 / 传输

**Path 1（当前）`transport: 'ws-direct'`**：peer 口明文 WS 上跑 `WebSocketLink` + 握手；握手 transcript **`path: 'dc'`**（与 Phase 3 DataChannel 身份绑定相同、无额外加密）。B3-1 把 mux 换到 DataChannel 即可，slot：

```ts
type PeerTransportKind = 'ws-direct' | 'relay' | 'dc'
type DataChannelLinkSlot = { readonly transport: 'dc'; session: LinkSession | null }
```

**Path 3 `transport: 'relay'`**：raw relay 流上 JSON 握手 → `derivePeerSessionKeys` + `SecureChannelLink` + `LinkMux`。initiator = 打开连接的一侧。

#### Peer 握手线格式（ctl JSON，一帧一条；二进制 b64url，id hex）

```json
{"t":"hello","node_id":"<32 hex>","nonce":"<b64url 32B>","eph_x25519_pk":"<b64url 32B>","dtls_fingerprint":null}
{"t":"sig","sig":"<b64url 64B Ed25519 over borsh(transcript)>"}
```

双方先 `hello`，收到对端 hello 后签 `buildPeerTranscript(path, self, peer)`（`path` = `'dc'` | `'relay'`），用 `node_certs` 的 `ed_pk` 验签；未知 / `revokedLogSeq != null` / 验签失败关链路。relay 再 `X25519(eph_sk, peer_eph_pk)` → `derivePeerSessionKeys`。

握手后 peer ctl：`ping`/`pong`、`node.status`（可带 `name`、`key_log_head`）、`key.log.req`/`res`（hub 宕时互相同步；服务端需要 `KeyLogApplier.list`）。

### `openHttpStream` / `openWsStream` / `LinkStreamCarrier`

```ts
type HttpStreamOpenPayload = {
  type?: 'http'
  method: string; path: string; query?: string
  headers?: Record<string, string>; origin: string; auth?: string | null
}
openHttpStream(link, openPayload, body?: ReadableStream<Uint8Array> | Uint8Array | null, signal?: AbortSignal): Promise<Response>

type WsStreamOpenPayload = { type?: 'ws'; auth: string }
openWsStream(link, auth: string): Promise<{
  stream: LinkStream
  send(bytes: Uint8Array): Promise<void>
  readable: ReadableStream<Uint8Array>
  close(): void
}>

class LinkStreamCarrier implements Carrier {
  constructor(stream: LinkStream, opts?: { highWaterMark?: number }) // 默认 1 MiB
  send(bytes): 'sent' | 'backpressure' | 'closed'   // pending > 1MiB → backpressure
  bufferedAmount(): number
  onDrain(cb): void                                  // 降回 ≤ 1MiB
  close(code, reason): void                          // stream.end()
  terminate(): void                                  // stream.reset()
}
```

OPEN 字节：

- http：`{"type":"http","method","path","query?","headers?","origin","auth"}`
- ws：`{"type":"ws","auth"}`
- relay：`{"to"}`；hub 入站加 `from`

目标侧：`NodeSessionStore.verify(sid, {viaNodeId: 链路对端})`；`/api/auth/challenge|login` 跳过。http 响应首 DATA `flags.head` = `{status, headers}`；请求体未读完而响应已结束 → RST；`Request.signal` abort → RST。ws 验 auth 后 `attachStreamSession(carrier)`。

### `dispatchHttp` / `attachStreamSession`

```ts
// GatewayRuntime
dispatchHttp(request: Request, ctx: { uid: string }): Promise<Response>
// /api/* 与 /healthz 走 handleApiRequest（server 可选）；其它 404。uid 目前未写入 ApiRouteContext。

// WebSocketServer
attachStreamSession(carrier: Carrier): {
  session: GatewaySession
  onMessage(bytes: Uint8Array): void
  onClose(): void
}
```

`ApiRouteContext.server?: Server<unknown>`。现有 handler 没有读 `ctx.server`。

### Uplink ctl 线格式（与 B2-1 对齐，独立 codec）

`t` ∈ `auth.challenge | auth.response | auth.ok | ping | pong | node.status | node.list | key.log.req | key.log.res | key.log.append | rtc.signal | enroll.redeemed`。二进制 b64url，id hex，`seq` JSON number（大整数可 string）。未知 `t` 解码抛错。

## 测试

`cd apps/gateway && bun test src/mesh src/ws/index.test.ts`：

```
 87 pass
 0 fail
 226 expect() calls
Ran 87 tests across 7 files. [764.00ms]
```

覆盖：uplink auth / backoff / heartbeat / node.list→peer_cache / key.log catch-up；handshake happy / unknown / revoked / wrong key；relay 两端密钥一致且 mux 通；PeerManager 复用 / 坏 endpoint→relay / idle / unreachable / onRevoked；http 对 `GatewayRuntime.dispatchHttp` 往返、body、abort→RST、early response；ws HELLO via `attachStreamSession`；carrier backpressure/drain。

全量 `cd apps/gateway && bun test`：

```
 1573 pass
 0 fail
 5187 expect() calls
Ran 1573 tests across 186 files. [29.71s]
```

基线 1520。本任务约 +26（mesh 6 个文件 + ws attachStreamSession）。无并发范围失败。

## tsc / biome

| | 数量 |
|---|---|
| 基线 `apps/gateway` | 23 |
| 本次全量 | **23** |
| `src/mesh/**`、`runtime.ts`、`api/index.ts`、`api/route.ts`、`ws/index.ts` | **0** |

`bunx biome check` 范围文件 clean。

## 协调者 / B2-2b / B3-1

1. **B2-2b** 用 `PeerManager.getLink` + `openHttpStream`/`openWsStream`。构造 PeerManager 时注入 `sessionStore`、`dispatchHttp: runtime.dispatchHttp`、`wsServer`、`keyLogApplier`、`statusProvider`。OPEN 带 `type: 'http'|'ws'`。
2. **不要** import `src/hub/uplink-protocol.ts`；两边独立 codec，集成测再钉死。
3. **`WebSocketLink` 现 API**（B1-2 后）：客户端 `WebSocket`，服务端 `ServerSocketAdapter{send,close,onMessage,onClose,onDrain}`。PeerServer 已按此适配。假 socket 测试必须是 adapter，不能只模拟 `onmessage`。
4. **`KeyLogApplier.list`** 是扩展；没有则 peer `key.log.req` 不回 records。B1-3c 接线时可补。
5. **`dispatchHttp` 的 `uid`** 尚未进路由 ctx；鉴权已在 stream 层用 `node-session`+`via` 做完。若 API 要读 uid，另开一小改。
6. 本任务**没有** `MeshRuntime` 组装 / 角色启动；那是后续接线。`PeerServer` 默认绑 `::` + `0.0.0.0`；测试用 `hostname: '127.0.0.1'`。
7. 无范围外文件需要改。
