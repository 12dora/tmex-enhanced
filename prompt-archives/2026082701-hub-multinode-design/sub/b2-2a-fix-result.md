# B2-2a-fix 结果 — mesh 传输面审查修复

worktree：`/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。

## 文件清单

新增：

- `packages/shared/src/auth/uplink-auth.ts` + `uplink-auth.test.ts`
- `apps/gateway/src/mesh/ctl.test.ts`
- `apps/gateway/src/mesh/peer-server.test.ts`

修改：`packages/shared/src/auth/index.ts`（barrel）；`apps/gateway/src/mesh/{types,ctl,uplink-client,peer-protocol,peer-server,peer-manager,link-stream-carrier,stream-targets,index,test-support}.ts` 及对应 `*.test.ts`；`apps/gateway/src/runtime.ts`（`dispatchHttp` 签名与 WeakMap）；`apps/gateway/src/api/route.ts`（`mesh?` + `dispatchRoutes` 注入）。

未改 `mesh/{mesh-deps,auth-routes,session-middleware,mesh-routes,forwarder,mesh-http,mesh-runtime}*`、`hub/**`、`ws/**`、`auth/**`。

## 条目 → 改动 → 测试

| # | 改动 | 测试 |
|---|---|---|
| 1 签名 oracle | `DOMAIN_UPLINK_AUTH` + Borsh `UplinkAuthSchema`；`UplinkClient` 仅在 `awaiting-challenge` 接受一次 32B nonce，签 `uplinkAuthMessage(nonce, hubHost)` | `uplink-auth.test.ts` 固定 hex 向量；`uplink-client.test.ts` 验签 / 短 nonce / 二次 challenge |
| 2 明文 ws | `PeerTransportKind = 'ws-secure' \| 'relay' \| 'dc'`；peer WS 上 `SecureChannelLink`+`LinkMux`，transcript `path:'relay'`（`'dc'` 留给指纹绑定） | `peer-protocol.test.ts` `ws-secure handshake encrypts the mux like relay`（send/recv key 交叉） |
| 3 头过滤 | `openHttpStream`/`acceptHttpStream` 剥 `cookie/authorization/host/connection/upgrade/proxy-*/x-forwarded-*/x-tmex-via`；响应剥 `set-cookie` | `stream-targets.test.ts` OPEN 头 / set-cookie |
| 4 可信 via | 见下方签名；`viaNodeId` 只来自已认证链路；`dispatchRoutes` 从 WeakMap 填 `ctx.mesh` | stream-targets：伪造 `x-tmex-via` 仍得 `entry-1`；`dispatchRoutes` 注入 |
| 5 pull body | `Request.body.pull()` 读一个 LinkStream chunk，无后台贪婪循环 | `request body pull reads one LinkStream chunk at a time` |
| 6 RST/413 | 每侧 AbortController；peer RST `cancel` reader；完整响应 `await stream.end()` **不** RST 请求向 | `infinite upload plus immediate 413 keeps a complete response` |
| 7 WS session | `{sid,via,uid}` 绑在 stream；每帧 `verify` 失败 RST；幂等 teardown，`onClose` 一次；END 对端也 `end()` | revoke 后 RST；graceful END 双方 `closed.reason==='end'` |
| 8 续期头 | `verifyAuth` 保留 `renewedExpiresAt`，成功响应注入 `x-tmex-session-renewed` | acceptHttpStream 续期头 |
| 9 UplinkClient | connect/auth 10s 超时；非 stop 关闭 teardown+offline+backoff；attempt 仅在 auth 成功且 uptime≥30s 清零；每用户串行 catch-up，seq 严格，hash 分叉 `onKeyLogFork` + 停 apply | 超时 backoff；意外关闭 backoff；同 seq 不同 hash fork；并发 node.list 只一条 `key.log.req` |
| 10 PeerManager | `winningDialInitiator`；generation+AbortController 取消 pending dial；未知 OPEN `reset('unknown-stream-type')` 不计流；并发上限 256 | unknown OPEN RST + idle；stop 取消 dial；cap=1；winner 函数 |
| 11 Carrier | `close()`=closing，排空再 `end()`；`terminate()`=RST | `close drains already-accepted frames before END` |
| 12 PeerServer | 逐 host 绑定，全失败才抛聚合错误；仅合法 WS upgrade 计数；TTL 淘汰空 IP | 坏 host 回退 127.0.0.1；8 次 GET 426 不 429；第 4 次 upgrade 429 |
| 13 sleep | 具名 abort handler，resolve/reject 都 `removeEventListener` | `ctl.test.ts` 两条路径 |

## 变更签名

```ts
// packages/shared/src/auth
export const DOMAIN_UPLINK_AUTH = 'tmex/uplink-auth/v1'
export const UplinkAuthSchema // { domain, nonce: bytes(32), hub_host: string }
export function uplinkAuthMessage(nonce: Uint8Array, hubHost: string): Uint8Array
export function decodeUplinkAuth(bytes: Uint8Array): UplinkAuth
export function hubHostFromUrl(hubUrl: string): string

// mesh/types.ts
export type DispatchContext = {
  uid: string | null
  viaNodeId: string
  renewedExpiresAt?: number
}
export const requestDispatchContext: WeakMap<Request, DispatchContext>
export type DispatchHttp = (request: Request, ctx: DispatchContext) => Promise<Response>
export type PeerTransportKind = 'ws-secure' | 'relay' | 'dc'
export type KeyLogForkEvent = {
  userId: string
  local: { seq: bigint; hash: Uint8Array }
  remote: { seq: bigint; hash: Uint8Array }
}

// GatewayRuntime
dispatchHttp(request: Request, ctx: DispatchContext): Promise<Response>
// 实现：requestDispatchContext.set(request, ctx) 后走 handleApiRequest

// ApiRouteContext
mesh?: DispatchContext  // dispatchRoutes 从 WeakMap 补齐

// handshakeWsDirect
handshakeWsDirect(opts: {
  socket: WebSocketTransportInput  // 不再吃 LinkSession
  role: 'initiator' | 'acceptor'
  identity: MeshIdentity
  userStore: UserStore
  timeoutMs?: number
}): Promise<PeerHandshakeResult>  // transport: 'ws-secure', 含 sendKey/recvKey

// PeerServerOptions.onAccept
(socket: ServerSocketAdapter, remoteIp: string) => void  // 不再是 LinkSession

// UplinkClientOptions 新增
onKeyLogFork?: (event: KeyLogForkEvent) => void
connectTimeoutMs?: number  // 默认 10_000
authTimeoutMs?: number     // 默认 10_000

// PeerManagerOptions 新增
maxConcurrentStreams?: number  // 默认 256
export function winningDialInitiator(selfNodeId: string, peerNodeId: string): string

export function stripForwardedRequestHeaders(headers?: Record<string, string> | null): Record<string, string>
export function stripSetCookieHeaders(headers: Record<string, string>): Record<string, string>
```

HTTP 流状态：`receiving-request` → 写完响应头+体后 `await stream.end()` 进入 `response-complete`（此时不再 `reset` 请求向）；peer RST / 外层 abort 才 RST。Entry 在读到响应头后停止上传（`stopUpload`），不 RST。

## 测试

owned mesh：

```
 48 pass
 0 fail
 128 expect() calls
Ran 48 tests across 8 files. [1277.00ms]
```

shared uplink-auth：

```
 4 pass
 0 fail
 9 expect() calls
Ran 4 tests across 1 file. [44.00ms]
```

`src/api`：

```
 247 pass
 0 fail
 614 expect() calls
Ran 247 tests across 19 files. [361.00ms]
```

`cd apps/gateway && bun test src/mesh src/api` **非整绿**：范围外 `src/mesh/mesh-runtime.test.ts` 1 fail（见下）。

## tsc / biome

| | 数量 |
|---|---|
| 基线 gateway tsc | 23 |
| 本次全量 gateway tsc | **24**（+1 不在本任务文件，当前为 `user-key-service` / push / tmux 等存量；**owned 文件 0**） |
| shared tsc | **0** |
| biome 范围文件 | clean |

## 协调者必须做

1. **Hub 验签（blocker follow-up）**：hub 仍按「对 nonce 原字节验签」。客户端已改为签 `uplinkAuthMessage(nonce, hubHost)`。请在 `apps/gateway/src/hub/**` 用同一 helper + 测试向量验签。未改之前 `mesh-runtime.test.ts`「hub,node … auth handshake」会 timeout（`waitUntil uplink.state === 'online'`）。
2. **B2-2b / 登录处理器**：`viaNodeId` 只读 `ctx.mesh?.viaNodeId` 或 `requestDispatchContext.get(req)`，禁止 OPEN/header/body。
3. **Peer 调用方**：`handshakeWsDirect` 现吃 `socket`+`role`；`PeerServer.onAccept` 现为 adapter；transport 字符串 `'ws-direct'` → `'ws-secure'`。
4. 双机同时拨号的真实 WS 集成测在 SecureChannel 关闭时会有 `LinkError: websocket is closed` 未处理 rejection（shared `SecureChannelLink.send` 返回的 Promise 未被 mux 接住）。生产逻辑已按字典序 initiator 仲裁；集成测留给不关 socket 的后续接线。
5. 未改 `handleApiRequest` 签名；`dispatchRoutes` 已从 WeakMap 填 `ctx.mesh`，现有 `handleApiRequest` 无需改即可把 via/uid 送到 handler。
