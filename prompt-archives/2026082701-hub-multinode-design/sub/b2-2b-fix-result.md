# B2-2b-fix 结果 — mesh HTTP 面安全评审 + 组装接线

worktree：`/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。

## 做了什么

按评审 12 项全部落地：本地 `/ws` 会话守卫与 4401、目标侧组合分发、passkey Borsh 断言、RTC authorize 委托、`/n/self` 显式 rewrite、登录体去 sid、续期/401/logout 协议、`TMEX_TRUST_PROXY`、standalone `/api/auth/mode`、clientIp 与 `/healthz` 最小探活。

## 文件清单

| 文件 | 作用 |
|---|---|
| `apps/gateway/src/mesh/mesh-deps.ts` | 统一 `requestDispatchContext` 再导出；rewrite/4401/WS kind；RTC authorize 形状 |
| `apps/gateway/src/mesh/session-middleware.ts` | 可信 via、续期挂上下文、self 消费 `x-tmex-set-session`、trust-proxy origin |
| `apps/gateway/src/mesh/auth-routes.ts` | 登录体、logout `;0`、`/api/auth/nodes`、Borsh passkey、uid 绑定、key-log effects |
| `apps/gateway/src/mesh/mesh-routes.ts` | nodes/rtc-config 需会话；authorizeBrowser；`/mesh/ws` 4401 + 浏览器信令 |
| `apps/gateway/src/mesh/forwarder.ts` | `{rewritten}`、401 64KiB、删内部头、logout `;0` 清 cookie |
| `apps/gateway/src/mesh/mesh-http.ts` | WS 守卫/注册表/5min 续验、`/healthz`、socket 关闭 |
| `apps/gateway/src/mesh/mesh-runtime.ts` | 目标侧 dispatch 链；key-log/logout 关 socket；trustProxy |
| `apps/gateway/src/config.ts` | `TMEX_TRUST_PROXY`（默认 false） |
| `packages/app/src/runtime/assemble.ts` | clientIp、rewrite 再入、standalone mode、`/ws` 守卫、本地续期头 |
| `*.test.ts` / `config.test.ts` / `assemble.test.ts` | 各项回归 |

## 公开 API（相对 B2-2b 的增量）

```ts
// mesh-deps
export { requestDispatchContext, type DispatchContext } from './types'
MESH_REJECT_4401_KIND = 'mesh-reject-4401'
MESH_GATEWAY_WS_KIND = 'gateway-ws'
WS_SESSION_VERIFY_MS = 5 * 60_000
AUTH_401_BODY_LIMIT = 64 * 1024
type MeshRewritten = { rewritten: Request }
type MeshHandleResult = Response | MeshRewritten | null | undefined
isMeshRewritten(value: unknown): value is MeshRewritten
parseSetSessionHeader(value: string): { sid: string; maxAgeSec: number } | null  // sid 可为空（logout `;0`）

type RtcFingerprintProvider = {
  authorizeBrowser(input: {
    rtcSession: string; uid: string; via: string; fpBrowser: DtlsFingerprint
  }): RtcAuthorizeBrowserResult | null | Promise<RtcAuthorizeBrowserResult | null>
}
type RtcSignalRouter = {
  send(signal: RtcSignalMessage, owner?: { uid: string; sid: string }): void
  subscribe(cb: (signal: RtcSignalMessage) => void): () => void
}

class MeshHttpRuntime {
  handleRequest(req, server): Promise<MeshHandleResult>
  guardGatewayWebSocket(req, server): Response | null | undefined
  rewriteSelf(req): Request | null
  closeSocketsForUser(uid: string): void
  closeSocketsForSid(sid: string): void
  touchSocket(ws): boolean
  applyKeyLogEffects(userId, effects: KeyLogEffect[]): void
}

// session-middleware
attachAuthToRequest(req, auth, via?): void
applyLocalRenewal(req, response): Response
consumeSetSessionForBrowser(req, response): Response
publicRequestUrl(req): URL  // via=self 且 trustProxy 时读 x-forwarded-proto/host

// forwarder
rewriteSelf(req, localNodeId): Request | null
rewriteRequest(req, rewrite): Request

// MeshRuntime 新增
guardGatewayWebSocket / rewriteSelf / closeSocketsForUser / closeSocketsForSid / touchSocket
handleRequest → MeshHandleResult

// config
config.trustProxy: boolean  // TMEX_TRUST_PROXY, default false
```

`MeshRequestContext` 仍保留独立 WeakMap（`auth` / `clientIp` / `selfRewrite` / `sid` / `trustProxy`）。`via` 以 `requestDispatchContext.viaNodeId` 为可信源；`setMeshRequestContext` 会回写 `requestDispatchContext`。`DispatchContext` 无 sid/clientIp，不能单表替代。

## 前端 HTTP 契约增量（必读）

### `POST /api/auth/login`

成功 JSON **只有** `{ "expires_at": <ms> }`，**不再返回 sid**。

- `x-tmex-set-session: <sid>;<max-age>` 是内部头：entry 转成 `Set-Cookie: tmex_s_<T>` 后**删除**；self 路径直接 `Set-Cookie: tmex_s_self` 后**删除**。浏览器永远看不到该头，也拿不到 sid。
- 远端登录（目标 via ≠ self）仍只发内部头，由 entry 落 cookie。

### `POST /api/auth/logout`

`200 { ok: true }`。内部头 `x-tmex-set-session: ;0`（空 sid + Max-Age 0）。entry 据此 `Set-Cookie: tmex_s_<T>=; Max-Age=0`。self 路径同样清 `tmex_s_self`。关联 `/ws` 与 `/mesh/ws` 以 **4401** 关闭。

### Passkey `delegation_sig`

**b64url（无 padding）的 Borsh `PasskeyAssertion` 字节**，不是 UTF-8 JSON。解码走 `decodePasskeyAssertionSig`。验签要求 `storedKey.userId === user.id === delegation.uid`。

### 节点列表

| 路径 | 鉴权 | 体 |
|---|---|---|
| `GET /api/auth/nodes` | **公开** | `{ nodes: [{ id, name, online }] }` 无公钥/inventory |
| `GET /api/mesh/nodes` | **需会话** | 原完整 DTO（含 `publicKey` / inventory / loggedIn） |
| `GET /api/mesh/rtc-config` | **需会话** | `{ stun, turn }` |

登录页：未登录用 `/api/auth/nodes`。self 登录成功后，用新的 `tmex_s_self` 拉 `/api/mesh/nodes` 再 fan-out（公钥只在登录后需要）。

### 其它

- 本地 `/ws` 与 `/n/self/ws`：无 `tmex_s_self` 则升级后 **4401**。
- `/mesh/ws`：无会话同样升级后 **4401**（不再 HTTP 401）。
- `/healthz`（mesh）：无会话 `{status:'ok'}`；完整 body 需 `tmex_s_self`。
- standalone：`GET /api/auth/mode` → `{mode:'none'}`，其余路径与从前完全一致（不构造 mesh）。
- 活跃会话续期：网关响应可带 `x-tmex-session-renewed: <ms>`；entry 已刷新 Max-Age，本地 self 同样刷 cookie。

## 分项

1. `/ws`：`guardGatewayWebSocket` 升级 `mesh-reject-4401` 或 `gateway-ws`+`{sid,uid,via}`；`open` 关 4401；注册表 + logout/key-log 关闭；入站 5min `verify`。
2. 目标侧 `dispatchHttp`：`setMeshRequestContext({via: peerNodeId, clientIp: peer:<id>})` → mesh `handleRequest` → hub（`roles.hub`）→ `gateway.dispatchHttp`。via 读 `requestDispatchContext`。
3. passkey Borsh + uid 绑定；合成 ES256 登录测试 + 跨用户拒绝。
4. `/api/rtc/authorize` 只调 `rtc.fingerprint.authorizeBrowser`；浏览器 `RTC_SIGNAL` 强制 `from:'browser'` 并传 `{uid,sid}`；`from:'node'` 丢弃。
5. `handleRequest` 对 `/n/self/*` 返回 `{rewritten}`；assembler 再走 guard→mesh→gateway。`/api/mesh/nodes|rtc-config` `requireSession`。
6. 登录无 sid；内部头消费后删除；logout `;0`。
7. `authenticateRequest` 把 `renewedExpiresAt` 写入上下文；assemble 对本地网关响应 `applyLocalRenewal`。
8. 401 最多读 64KiB 后 cancel；改写时删 `content-length/content-range/etag/content-disposition`。
9. `/mesh/ws` 无会话 4401；socket 带 sid/uid；logout 关闭。
10. `TMEX_TRUST_PROXY` 默认 false；仅 **via=self 的本地 Bun socket** 用 `x-forwarded-proto/host` 计算 origin / Secure / passkeyAvailable。转发请求永不信任。CLI 稍后写入 env。
11. standalone assemble 挂轻量 `GET /api/auth/mode`；其它路径仍只走 gateway。
12. assemble `server.requestIP(req)` → `clientIp`；`/healthz` 如上。转发登录目标侧目前用 `peer:<entryNodeId>` 作限速桶（OPEN 无 clientIp 字段，见协调者）。

## 测试

本范围（不含 B2-2a / B3-1 文件）：

```
src/config.test.ts + auth-routes/session-middleware/mesh-routes/forwarder/mesh-http：
  63 pass
  0 fail
Ran 63 tests across 6 files.

packages/app src/runtime：
  15 pass
  0 fail
  41 expect() calls
Ran 15 tests across 3 files. [369.00ms]
```

`cd apps/gateway && bun test src/mesh`：

```
 121 pass
 1 fail
Ran 122 tests across 21 files. [11.56s]
```

唯一失败：`mesh-runtime.test.ts`「hub,node role uses in-memory uplink…」`waitUntil` 3s 超时（`uplink.state === 'online'`）。原因是并发 **B2-2a-fix** 把 `UplinkClient.authenticate` 改成等待 `auth.challenge` 并用 `uplinkAuthMessage` 签名，hub 侧 verifier 尚未同步（B2-2a-fix prompt 写明 hub 由后续补丁）。本任务未改 `uplink-client.ts` / `hub/**`。同文件另外 3 条（含新增 inbound via）通过。

未观察到 B3-1 `src/mesh/rtc/**` 测试失败。

## tsc / biome

| | 数量 |
|---|---|
| 基线 gateway | 23 |
| 本范围文件 | **0**（含新测试） |
| 全量 gateway | **77**（push/tmux/ws/rtc/ctl/stream-targets 等并发文件；**不含**本 scope） |
| packages/app | **1**（仍是 `Cannot find type definition file for 'node'`；assemble 0） |

biome：范围 17 文件 `Checked 17 files. No fixes applied.`

## 协调者必须做

1. **前端**按上面契约改登录页：body 无 sid；未登录用 `/api/auth/nodes`；登录后再拉 `/api/mesh/nodes`；passkey sig 用 Borsh。
2. **CLI** 后续写 `TMEX_TRUST_PROXY`（默认 false）。Cloudflare Tunnel 场景需显式打开。
3. **B2-2a / hub verifier**：内存 uplink 握手测试被 `uplinkAuthMessage` 卡住；修好后 `mesh-runtime.test.ts` 那条应收复。
4. **转发登录真实 IP**：`HttpStreamOpen` / `acceptHttpStream` 若加 `clientIp`，目标侧可替换 `peer:<via>`。当前禁止从请求头取 IP。
5. **B3-1**：实现 `authorizeBrowser` 与 `RtcSignalRouter.send(..., {uid,sid})` 的 rtcSession 所有权校验；本任务测试使用 fake。
6. `apps/gateway/src/mesh/index.ts` 仍未 barrel 本任务符号（与 B2-2b 相同）。

未碰生产 tmex、默认 tmux session `tmex`、`bun install`。
