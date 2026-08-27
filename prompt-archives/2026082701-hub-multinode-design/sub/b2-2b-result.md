# B2-2b 结果：Mesh HTTP surface

范围仅 `apps/gateway/src/mesh/` 下列新文件（未改 `index.ts` / B2-2a 文件 / `auth/` / `hub/` / `ws-borsh`）。

## 做了什么

落地 node 侧 HTTP/WS 入口：`/api/auth/*`、`/api/mesh/*`、`/api/rtc/authorize`、`/mesh/ws`、`/n/:id/api/*` 与 `/n/:id/ws` 转发、本地 UI 鉴权 guard。运输面（`PeerLinkProvider` / `StreamOpener`）通过 `mesh-deps.ts` 注入，assembler 接线。

## 文件清单

| 文件 | 作用 |
|---|---|
| `mesh-deps.ts` | 注入接口、`WeakMap<Request, ctx>`、常量 |
| `auth-routes.ts` | `/api/auth/*` |
| `session-middleware.ts` | cookie / via 会话、standalone 旁路、`requireSession` |
| `mesh-routes.ts` | `/api/mesh/*`、`/api/rtc/authorize`、`/mesh/ws` |
| `forwarder.ts` | `/n/:id/api/*`、`/n/:id/ws` |
| `mesh-http.ts` | `MeshHttpRuntime` 路由顺序 + `localUiGuard` + WS 回调 |
| `*.test.ts` | 27 条单测 |

## 公开 API

```ts
function setMeshRequestContext(req: Request, ctx: MeshRequestContext): void
function getMeshRequestContext(req: Request): MeshRequestContext
// ctx: { via: string; auth?: string | null; clientIp?: string; selfRewrite?: string }
// 默认 via='self'。禁止信任客户端 x-tmex-via 头。

function getSelfRewrite(req: Request): string | null  // /n/self/* 剥离后的本地 path+query

type PeerLinkProvider = {
  getLink(nodeId: string): Promise<LinkSession>
  listReach(): Map<string, 'lan' | 'relay' | null>
  onNodeEvent(cb: (e: NodeEventPayload) => void): () => void
}
type StreamOpener = {
  openHttpStream(link, open: HttpStreamOpen, body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Response>
  openWsStream(link, auth: string): Promise<OpenedWsStream>
}
// OpenedWsStream: { send(bytes); onMessage(cb); onClose(cb); close(code?, reason?) }

class MeshHttpRuntime {
  constructor(opts: {
    roles: { hub: boolean; node: boolean }  // 两者 false = standalone
    nodeId: string
    nodePk: Uint8Array                      // 本机 Ed25519 公钥，challenge 返回
    userStore: UserStore
    keyLogService: UserKeyService
    challengeStore: ChallengeStore
    nodeSessionStore: NodeSessionStore
    peers: PeerLinkProvider
    streams: StreamOpener
    publisher: KeyLogPublisher              // key.log.append；失败不影响本地 apply
    rtc?: { fingerprint?: RtcFingerprintProvider; signals?: RtcSignalRouter; config?: RtcConfigProvider }
    now?: () => number
    primaryUserId?: string                  // GET /api/auth/mode 的用户；缺省从 certs/nodes 推断
  })
  handleRequest(req, server: { upgrade(req, opts?): boolean }): Promise<Response | null | undefined>
  // Response = 已处理；null = 未处理（assembler 继续）；undefined = upgrade 已接管
  handleWebSocket: { open(ws); message(ws, data); close(ws, code?, reason?) }
  localUiGuard(req): Response | null        // 401 JSON；不 redirect
  stop(): void
}

function authenticateRequest(req, { roles, nodeSessionStore, now? }, viaOverride?): AuthenticateResult
function requireSession(deps, handler): (req) => Promise<Response>
```

`mesh/index.ts` **未** re-export（B2-2a 所有）。assembler 从上述路径直接 import。

---

## HTTP 契约（前端以此为准）

JSON `Content-Type: application/json`。错误体一律 `{ code: string, ...extra }`。二进制字段 **base64url（无 padding）**。

### 内部约定（assembler 必须设，客户端不可伪造）

- `setMeshRequestContext(req, { via, auth?, clientIp? })`
  - 本地 Bun socket：`via: 'self'`（可省略，默认即此）
  - 入站 `http` 流：`via` = 对端 node id；`auth` = OPEN.auth sid
  - `clientIp` 用于登录失败限速；不要用 `x-forwarded-for`
- 升级成功后把 `ws` 交给 `runtime.handleWebSocket.*`（看 `ws.data.kind`：`mesh-event` / `mesh-forward-ws`）
- `/n/self/*`（或 `/n/<本机 nodeId>/*`）若 `handleRequest` 返回 `null`：读 `getSelfRewrite(req)`（如 `/api/devices`），改写 URL 后再走 gateway

### `GET /api/auth/mode`

无鉴权。

```json
{
  "mode": "none" | "mesh",
  "nodeId": "<hex>",
  "uid": "<user id>" | null,
  "username": "<username>" | null,
  "kdfParams": { "salt": "<b64url>", "memory_kib": 65536, "iterations": 3, "parallelism": 1 } | null,
  "passkeysForThisOrigin": true | false,
  "passkeyAvailable": true | false,
  "totpEnabled": true | false
}
```

- `mode:'none'` 当 `roles` = standalone（hub=false, node=false）
- `passkeysForThisOrigin`：该用户 `user_keys.origin` 等于请求 `Origin`（缺省用 URL origin）
- `passkeyAvailable`：`https` 或 `localhost` / `*.localhost`，且 host **不是 IP**
- `totpEnabled`：用户已有 `set-totp`（前端 `method=root` 时要带 TOTP）
- `uid` 是 key-log / login 用的 id（UUID）；`username` 是显示名。challenge `{uid}` 两者都接受

### `POST /api/auth/challenge`

```json
{ "uid": "<userId 或 username>" }
```

```json
{ "challenge_id": "<b64url>", "nonce": "<b64url 32B>", "nodePk": "<b64url 32B>" }
```

登记 `{kind:'login', uid, entryNodeId: via, ttl: 60s}`。错误：`400 MALFORMED`、`404 UNKNOWN_USER`。

### `POST /api/auth/login`

```json
{
  "login": "<b64url borsh Login>",
  "sig": "<b64url Ed25519>",
  "delegation": "<b64url borsh Delegation>",
  "delegation_sig": "<b64url；root=64B Ed25519；passkey=UTF-8 JSON AuthenticationResponseJSON>",
  "totp": { "code": "123456", "k_totp": "<b64url 32B>" }
}
```

`totp` 仅当 **已验证的** `delegation.method === 'root'` **且** 该用户启用了 TOTP 时需要；passkey 登录不需要。

成功 `200`：

```json
{ "sid": "<b64url 32B>", "expires_at": 1710000000000 }
```

头：

- 总是：`x-tmex-set-session: <sid>;<max-age-sec>`（entry 转成自己 origin 的 cookie）
- 仅 `via=self`：`Set-Cookie: tmex_s_self=<sid>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<sec>`（https 加 `Secure`）

验证顺序与错误（401，除非另标）：

| 条件 | `code` |
|---|---|
| body 非法 | `MALFORMED` 400 |
| 同 uid 或同 ip 1 分钟内 10 次失败后再试 | `RATE_LIMITED` 429 |
| challenge 未知/已消费/过期/非 login | `CHALLENGE_CONSUMED` |
| `login.entry` ≠ 登记的 via | `ENTRY_MISMATCH` |
| `login.target` 不是本机 `nodeId` 或 `'self'`；或 `target_pk` ≠ 本机公钥 | `TARGET_MISMATCH` |
| `login.uid` ≠ `delegation.uid` / challenge.uid | `UID_MISMATCH` |
| 用户不存在 | `UNKNOWN_USER` 404 |
| delegation 过期 / 坏签 / method / ttl / 未来 issued | `DELEGATION_EXPIRED` `DELEGATION_BAD_SIGNATURE` `DELEGATION_METHOD_MISMATCH` `DELEGATION_INVALID_TTL` `DELEGATION_ISSUED_IN_FUTURE` |
| login 签名失败 | `BAD_SIGNATURE`（以及 `CHALLENGE_MISMATCH`） |
| root + 已设 TOTP 但没带 totp | `TOTP_REQUIRED` |
| TOTP 解密/校验失败 | `TOTP_INVALID` |

`login.entry`：本地登录用 `'self'`；经其它 entry 转发时用 **该 entry 的 node id**（目标侧 via）。`login.target` 用目标 node id。

### `POST /api/auth/logout`

需要 node-session。撤销该 uid 在本机全部 session；`Set-Cookie tmex_s_self` Max-Age=0。`200 { ok: true }`。无会话 `401 UNAUTHORIZED`。

### Passkey

`POST /api/auth/passkey/register/options` — 需会话。返回 SimpleWebAuthn `PublicKeyCredentialCreationOptionsJSON` **外加** `challenge_id`。challenge 60s，kind `passkey-register`。

`POST /api/auth/passkey/register/verify { response, challenge_id }` — 需会话。`response` 为 `RegistrationResponseJSON`。成功返回 `AddPasskeyPayload` 字段（`public_key` 为 b64url）。**不写 key-log**。错误：`CHALLENGE_CONSUMED`、`PASSKEY_VERIFY_FAILED`。

`POST /api/auth/passkey/login/options { uid, delegation }` — **无需会话**。`delegation` 为 b64url Borsh。challenge = `delegationChallenge(delegation)`。返回 `PublicKeyCredentialRequestOptionsJSON`。

### `POST /api/auth/keylog`

需会话。`{ bytes, sig }` b64url。成功 `200 { ok, seq, hash }` 并 `publisher.publish`。分叉 `409 { code: 'KEY_LOG_FORK' }`。其它校验失败 `400 { code: <verify/apply error> }`（如 `seq_gap`）。

### 会话

- 本地 cookie：`tmex_s_self`
- 远程 cookie（entry origin）：`tmex_s_<nodeId>`
- 滑动续期：响应头 `x-tmex-session-renewed: <expires_at ms>`；entry 刷新对应 cookie Max-Age
- WS 关闭码 **4401** = 该 node 未登录（`/n/:id/ws` 无 cookie 时本地直接 close 4401）
- 401 无 `NODE_LOGIN_REQUIRED` = 当前 origin（self）未登录 → 跳 `/login`
- 转发 401 带 `{ code: 'NODE_LOGIN_REQUIRED', nodeId }` = 只登录该 node，不跳全局登录页

standalone：所有请求放行，`userId=null`，无登录页（`mode:'none'`）。`localUiGuard` 恒 `null`。

### `GET /api/mesh/nodes`

无鉴权（登录页要列表）。

```json
{ "nodes": [{
  "id": "<hex>",
  "name": "studio" | "self",
  "publicKey": "<b64url Ed25519>",
  "online": true,
  "reach": "lan" | "relay" | null,
  "version": "1.2.3" | null,
  "direct_capable": false,
  "inventory": {},
  "loggedIn": true
}]}
```

合并非吊销 `node_certs` + `peer_cache` + `listReach()`；含 `self`；未 admit / revoked 不出现。`loggedIn`：self 看 `tmex_s_self`，其它看 `tmex_s_<id>`。`version` 若 `inventory.version` 存在则取出。

### `GET /api/mesh/rtc-config`

`{ stun: string[], turn: unknown | null }`。来自注入的 `rtc.config`（见下）；缺省 `{ stun: [], turn: null }`。

### `POST /api/rtc/authorize`

需会话。`{ rtcSession, fp_browser: { algorithm, value } }`。成功 `{ nonce: b64url, fp_node: { algorithm, value } }`。无 `rtc.fingerprint` → `503 { code: 'DIRECT_UNAVAILABLE' }`。challenge kind `rtc-authorize`，2 分钟。

### `GET /mesh/ws`

需 `tmex_s_self`。Bun upgrade，`data.kind = 'mesh-event'`。二进制 Borsh envelope：`KIND_NODE_EVENT` / `KIND_RTC_SIGNAL`（`wsBorsh`）。入站 `RTC_SIGNAL` 交给 `rtc.signals.send`。

### `/n/:id/api/*` 转发

- `id` 为 `self` 或本机 `nodeId`：剥前缀，mesh 自己的 path 内部处理，其余 `null` + `getSelfRewrite`
- 其它：`getLink(id)`，失败 `503 { code: 'NODE_UNREACHABLE', nodeId }`
- 请求头丢弃：`cookie` / `authorization` / `host` / `connection` / `upgrade` / `proxy-*` / `x-forwarded-*`
- `auth` = cookie `tmex_s_<id>`；`/api/auth/challenge|login` 为 `null`
- 响应头 allowlist：`content-type/length/range`、`accept-ranges`、`cache-control`、`etag`、`last-modified`、`content-disposition`、`x-tmex-*`
- 强制：`Content-Security-Policy: sandbox; default-src 'none'; base-uri 'none'; form-action 'none'`、`X-Content-Type-Options: nosniff`
- MIME allowlist：`image/png|jpeg|gif|webp|avif`、`video/mp4|webm`、`audio/mpeg|ogg|wav`、`text/plain`、`application/json|x-ndjson|pdf|octet-stream`。其它（含 `image/svg+xml`、`text/html`、`*/xml`）覆盖为 `application/octet-stream` + `Content-Disposition: attachment`
- 目标 401：透传并 **覆盖/合并** JSON `{ ..., code: 'NODE_LOGIN_REQUIRED', nodeId }`
- 目标 `x-tmex-set-session: <sid>;<max-age>` → entry `Set-Cookie: tmex_s_<id>=...`（HttpOnly, SameSite=Lax, Path=/, Max-Age, https→Secure）
- `x-tmex-session-renewed` 透传并刷新该 cookie Max-Age

### `/n/:id/ws`

upgrade 后双向泵字节。无 cookie → upgrade 后 close **4401**。目标 close code 原样传播。

### `localUiGuard`

在 mesh `handleRequest` **之后**、gateway 路由之前。`/login`、静态（`/assets/` `/static/` `/favicon` `/manifest`、带扩展名）、以及 public auth（mode/challenge/login/passkey/login/options）放行。其它 `/api/*` 无会话 → `401 { code: 'UNAUTHORIZED' }`（不 redirect）。HTML SPA 路由放行。

---

## 测试 / tsc / biome

```
 27 pass
 0 fail
 135 expect() calls
Ran 27 tests across 5 files. [5.27s]
```

覆盖：login happy（真实 `bootstrapUser` + shared auth 签 delegation/login）、consumed challenge / wrong entry / wrong target_pk / expired delegation / bad sig / TOTP required+invalid、rate limit 429、logout、mode none/mesh、keylog publish + fork 409、passkey options、session 续期头、via 流 sid、nodes 合并/吊销过滤、rtc-config / DIRECT_UNAVAILABLE / authorize、mesh/ws NODE_EVENT、header 过滤、SVG/HTML→octet-stream、PNG 放行、未知头丢弃、CSP、401 增强、转发 Set-Cookie、self fallthrough、503、ws 泵、4401、standalone guard。

tsc：本任务文件 **0 errors**。gateway 全量当前 **24**（基线 23；增量均在并发文件：push/ws/tmux/managed-entry，**不含**本 scope）。

biome：`Checked 11 files. No fixes applied.`

## 协调者必须做的（scope 外）

1. **`apps/gateway/src/mesh/index.ts`** 未导出本任务符号；assembler 从 `./mesh-http` 等 import，或由 B2-3 加 barrel。
2. **B2-2a `openWsStream` 实际返回 `{ stream, send, readable, close }`**，本任务 `StreamOpener.openWsStream` 要 `{ send, onMessage, onClose, close }`。assembler 适配一层（readable → onMessage，closed → onClose）。
3. **`PeerManager` 很可能没有 `onNodeEvent`**。assembler 用 uplink `node.list` / peer 状态包一层 `PeerLinkProvider`。
4. **`peer_cache` 没有 rtc 列**（B2-2a `node.list` 的 `rtc:{stun,turn}` 未落库）。`GET /api/mesh/rtc-config` 读 `rtc.config.getRtcConfig()`。assembler 应缓存最近一次 `node.list.rtc` 注入；否则返回空 STUN。
5. **`nodePk` 必填**：用 `ensureNodeIdentity().edPublicKey`。
6. **`primaryUserId`**：`UserStore` 无 `listUsers`；bootstrap 后传入，否则 mode 只能从 certs/nodes 猜。
7. **入站 http 流**在调用 `handleRequest` 前必须 `setMeshRequestContext({ via: peerNodeId, auth, clientIp })`。`dispatchHttp` 只覆盖 gateway 业务路由，**不能**替代 mesh auth。
8. **Bun.serve websocket**：`data.kind` 为 `mesh-event` / `mesh-forward-ws` 时走 `meshHttp.handleWebSocket`，不要交给 gateway `/ws`。
9. `UserStore` 若后续加 `listUsers`，mode 可去掉 `primaryUserId`。

未碰生产 tmex、默认 tmux session `tmex`、`bun install`。
