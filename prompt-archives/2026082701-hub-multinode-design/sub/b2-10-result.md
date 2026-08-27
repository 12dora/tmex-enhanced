# B2-10 结果 — 处理 B2-7 review

worktree：`/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。对照 `b2-7-review.md`（协调者判定剩余项全部有效）、`b2-9-result.md`（rtcSession 贯穿 attach/SWITCH/ACK，未回退）。未碰生产 tmex / 名为 `tmex` 的 tmux session。未 `bun install`。未 commit。

## 做了什么

1. **直连入站生命周期**：每个 direct Borsh 帧与每条 bulk 操作都走 `NodeSessionStore.verify({sid, via})`（续期仍由 store 内 5 分钟节流）。过期/吊销/via 不匹配 → 关掉整个 `GatewaySession`（primary + direct）、`pc.close()`、`bulk.abortByOwner(connectionId)`。`closeSocketsForUser/Sid` 与 key-log/logout 同样拆掉 registry 里的直连/PC。
2. **每连接身份 `connectionId`**：registry 按 `connectionId` 索引（不再用 sid 覆盖）；`/api/rtc/authorize` 与 `GET /api/mesh/connection` 绑定具体 WS。两标签同 sid 各自 attach。
3. **`sendControl()`**：区分 `queued-backpressure`（帧已入队，drain 后切换、不重发）与 `blocked`（未发送，drain 后发一次）。探测不再走 `canSend()`，不会把 skipped frame 打进 guard。旧载体 close 与 drain 竞速；`notifyClosed` 只靠 close 即可取消 pending switch。
4. **链路升级**：relay → DC 然后 ws-secure；ws-secure → 只试 DC。高等级失败不提前返回旧链。`retiring` 集合：`onRevoked` / `stop` / 证书失效强制关掉 active **和** retiring。后台 upgrade 的 rejection 被 catch，避免泄漏。
5. **`dc:A:B` 信令**：hub 确定性会话只接受 `from:'node'`。目标仅在授权存在、target=self、source 匹配授权 via 时缓存；inbox 硬上限。`acceptingBrowser` / owner / listener / inbox 在 `finally` 清理。
6. **集成测试**：`acceptWsStream` 真实建两条同 sid 会话；错误 connectionId / 吊销后下一帧拒绝；bulk 经 `dispatchHttp` 的 `/api/files/upload/init` 建真实 transfer，错 uid → `permission_denied`。`mesh.integration` 去掉两字节否定断言。

## 文件清单

| 文件 | 作用 |
|---|---|
| `apps/gateway/src/mesh/mesh-runtime.ts` | SessionRegistry 按 connectionId；verify/teardown；accept finally；connectionLookup |
| `apps/gateway/src/mesh/mesh-runtime.test.ts` | 两标签 sid 不互相覆盖 |
| `apps/gateway/src/mesh/mesh-deps.ts` | `X_TMEX_CONNECTION`、`ConnectionLookup`、authorize `connectionId` |
| `apps/gateway/src/mesh/mesh-routes.ts` + test | `GET /api/mesh/connection`；authorize 409 `MULTIPLE_CONNECTIONS` |
| `apps/gateway/src/mesh/mesh-http.ts` | 升级 data 带 connectionId；lookup 接线 |
| `apps/gateway/src/mesh/rtc/carrier-switch.ts` + test | 4 态 send；notifyClosed；真实 guard+LinkStreamCarrier |
| `apps/gateway/src/ws/index.ts` | sendControl 4 态；`setOnSessionClosed` |
| `apps/gateway/src/mesh/rtc/rtc-peer-manager.ts` | authorization/accept 带 connectionId；`notifySessionClosed` |
| `apps/gateway/src/mesh/rtc/signaling.ts` + test | 缓存策略、硬上限、hostile flood、unregister 清 inbox |
| `apps/gateway/src/mesh/rtc/bulk.ts` + test | `verify` / `ownerKey` / `abortByOwner` |
| `apps/gateway/src/mesh/peer-manager.ts` + test | 升级顺序、retiring、inbox cap、upgrade catch |
| `apps/gateway/src/mesh/stream-targets.ts` | accept/open WS 带 connectionId |
| `apps/gateway/src/mesh/link-stream-carrier.ts` | `onClose` |
| `apps/gateway/src/hub/uplink-server.ts` + test | dc:A:B 拒绝 `from:'browser'` |
| `apps/gateway/src/mesh/integration/direct-path.integration.test.ts` | 真实 WS 两会话、revoke、真实 bulk |
| `apps/gateway/src/mesh/integration/mesh.integration.test.ts` | 长明文标记 + 解密正向断言 |
| `packages/app/src/runtime/assemble.ts` + test | 登记 connectionId；`peerBindHost: gatewayConfig.peerBindHost` |
| `apps/gateway/src/mesh/types.ts` / `index.ts` / `rtc/index.ts` | 类型/导出 |

## 公开 API

```ts
export const X_TMEX_CONNECTION = 'x-tmex-connection'

export type ConnectionLookupResult =
  | { ok: true; connectionId: string }
  | { ok: false; code: 'NO_CONNECTION' | 'MULTIPLE_CONNECTIONS' }
export type ConnectionLookup = (input: {
  sid: string; via: string; connectionId?: string | null
}) => ConnectionLookupResult

export type RegisterGatewaySessionInput = {
  sid: string; uid: string; via: string
  session: GatewaySession
  connectionId?: string
  pc?: { close(): void }
}
class SessionRegistry {
  register(entry: RegisterGatewaySessionInput): RegisteredGatewaySession
  getByConnectionId(id: string): RegisteredGatewaySession | null
  getBySession(session: GatewaySession): RegisteredGatewaySession | null
  listBySid(sid: string): RegisteredGatewaySession[]
  listByUid(uid: string): RegisteredGatewaySession[]
  lookup(sid, via, connectionId?): ConnectionLookupResult
  // get(sid): 仅当该 sid 恰好 1 条 live 时返回，否则 null
}

export type ControlSendStatus = 'sent' | 'queued-backpressure' | 'blocked' | 'closed'
CarrierSwitchController.notifyClosed(session: GatewaySession): void
WebSocketServer.sendControl(...): ControlSendStatus
WebSocketServer.setOnSessionClosed(handler): void

RtcAuthorizeBrowserInput.connectionId?: string
AcceptBrowserResult.connectionId: string
BrowserAuthorization.connectionId: string
RtcPeerManager.notifySessionClosed(session): void

BulkAttachContext { uid: string; ownerKey?: string; verify?: () => boolean }
BulkTransferService.abortByOwner(ownerKey: string): void

openWsStream(link, auth, connectionId?: string)
WsStreamOpenPayload.connectionId?: string

GET  /api/mesh/connection  → 200 { connectionId } | 404 NO_CONNECTION | 409 MULTIPLE_CONNECTIONS
POST /api/rtc/authorize    body.connectionId 与/或 header x-tmex-connection
```

## 前端必须做的 delta（`connectionId`）

**不改 HELLO Borsh。** 浏览器按标签页区分 Gateway WS：

1. **每个 `GatewayConnection` 实例生成一个 UUID**，记为 `connectionId`。
2. 打开目标 node 的 Gateway WS（本地 `/ws` 或转发 `/n/:id/ws`）时带请求头：
   `x-tmex-connection: <uuid>`
3. HELLO 完成后（或 authorize 之前）`GET /api/mesh/connection`，同一 session cookie / via：
   - 单连接：`200 { "connectionId": "..." }`（即使没带头，也能拿到）
   - 多标签：`409 { "code": "MULTIPLE_CONNECTIONS", "hint": "send x-tmex-connection matching this tab GatewayConnection" }` → 必须带头再 GET，或直接用本地 UUID
4. `POST /api/rtc/authorize` JSON 增加 `"connectionId": "<uuid>"`（也可再带 `x-tmex-connection`）。缺省且该 sid 已有多条 live WS → **409**，直连会挂错标签页。
5. 两标签同 cookie：各自用自己的 UUID，authorize / 信令 / attach 互不覆盖。

## 测试

`cd apps/gateway && bun test`：

```
 1812 pass
 0 fail
 6422 expect() calls
Ran 1812 tests across 208 files. [44.85s]
```

相对 B2-9 基线 1802：**+10**。

`cd packages/app && bun test src/runtime`：

```
 20 pass
 0 fail
 54 expect() calls
Ran 20 tests across 3 files. [396.00ms]
```

相对 B2-7 的 19：**+1**（assemble connectionId）。

## tsc / biome

| | 基线 | 本次 |
|---|---|---|
| gateway tsc | 23 | **23**（owned 文件 0 新增） |
| packages/app tsc | 1 | **1** |
| biome 范围 27 文件 | | **clean** |

## 未能做 / 协调者必须做

1. **前端未改**（范围外）。必须按上面 delta 改 `GatewayConnection` / authorize 调用，否则多标签会 409 或挂错会话。
2. `files.ts` 的 `rememberTransferUid` 仍是模块私有。直连集成测试用 `dispatchHttp` 调 `/api/files/upload/init` 并 overlay `filesBulkHooks.getTransferOwner` 补 uid；生产路径走真实 `handleUploadInit` 即可。
3. `mesh-deps.RtcAuthorizeBrowserInput.sid` 仍可选（B2-9 leftover）；运行时 authorize 仍要求 cookie sid。
4. assemble 已改为 `peerBindHost: gatewayConfig.peerBindHost`（消化 B2-9 leftover #1）。

未碰生产 tmex（9883 / `~/Library/Application Support/tmex/`）、默认 tmux session `tmex`。
