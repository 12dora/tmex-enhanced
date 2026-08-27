# B2-11 结果 — 补齐直连 session 生命周期缺口（B2-10 review）

worktree：`/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。对照 `b2-10-review.md`（协调者判定全部有效）、`f3-4-result.md`（浏览器无法给 WS 设自定义头）。未碰生产 tmex / 名为 `tmex` 的 tmux session。未 `bun install`。未 commit。未改 `apps/gateway/src/ws/index.ts`（范围内但本轮无需动）。

## 浏览器合约（F3-5 必须按此实现）

**不改 HELLO Borsh。** 浏览器不能给 `new WebSocket(url)` 设请求头，也不能读 upgrade 响应头。唯一能在握手上携带的自定义信息是 **URL query**。

服务端 `connectionId` 由 node **生成**（32 随机字节 b64url，约 43 字符），**不是** 浏览器 UUID。浏览器只生成一个 **client nonce `cid`**，用来找回这条 WS 对应的服务端 id。

### 1. 打开 Gateway WS 时带 `cid`

每个标签页 / 每个 `GatewayConnection` 实例生成一个高熵 nonce（UUID 或 32 字节 b64url 均可），记为 `cid`。

| 路径 | URL |
|---|---|
| 本机 node | `/ws?cid=<cid>`（等价 `/n/self/ws?cid=`、`/n/<selfNodeId>/ws?cid=`） |
| 经 hub 转发 | `/n/<targetNodeId>/ws?cid=<cid>` |

Hub 的 `Forwarder.handleRemoteWs` 从 query 取出 `cid`，经 `openWsStream(link, auth, cid)` 写进对端 stream open payload。目标 node `acceptWsStream` 把它当 nonce 登记，**自己再生成** server `connectionId`。

本地 `/ws` 由 `guardGatewayWebSocket` 读 `?cid=`（无 query 时才回落到头 `x-tmex-connection`，仅服务端 WS 客户端用得上）。

### 2. 用 nonce 换服务端 id

HELLO 完成后（primary READY）打：

```
GET /api/mesh/connection?cid=<cid>
Cookie: tmex_s_<via>=...
```

| 状态 | body |
|---|---|
| 200 | `{ "connectionId": "<server-id>" }` |
| 404 | `{ "code": "NO_CONNECTION" }` — nonce 未知 / 会话未登记 |
| 409 | `{ "code": "MULTIPLE_CONNECTIONS" }` — **未带 cid** 且该 `{sid,via}` 有多条 live WS |

**不要** 把 `cid` 当成 authorize 的 `connectionId`。GET 返回的才是 server id。

未带 `cid` 的 GET 仍保留单连接兜底（恰好 1 条 live → 200），多标签必须带 `?cid=`。

### 3. authorize 用 **server** connectionId

```
POST /api/rtc/authorize
{ "rtcSession": "...", "connectionId": "<server-id>", "fp_browser": {...} }
```

也可再带头 `x-tmex-connection: <server-id>`。缺省且多连接 → 409。错误 / 未知 id → 404。

### 4. 约束

- `cid` 在 `{sid, via}` 作用域内必须唯一。第二张标签复用同一 nonce → 新 WS 被 RST，**旧会话保持不动**。
- 重连必须换新 `cid`（新 WS = 新 server id）。不要缓存跨 attempt 的 server id。
- F3-5 最小改动：WS URL 拼 `cid`；`GET /api/mesh/connection?cid=`；authorize 用返回的 server id。409「等 primary 重连」分支对带 cid 的 GET 不再是多标签的主路径。

## 做了什么

1. **connectionId 只由服务端生成**；registry 按它索引并 scoped 到 `{sid, via}`。调用方再传入已占用的 id / cid → `DUPLICATE_CONNECTION` / `DUPLICATE_CID`，绝不 `drop(prev)`。
2. **attachDirect 前** 再走 `NodeSessionStore.verify({sid, via})`。`CarrierSwitchController.verifyInbound` 在帧进入 ACK 屏障缓冲（及 flush）前验票；失败走完整 teardown（session / PC / bulk）。
3. **bulk 下载**：每个 data 帧和 EOF 发送前 `verify`（续期仍由 store 5 分钟节流）；失败 cancel reader + teardown。
4. **signaling**：`shouldCacheLocal` / 授权·目标·来源 在 listener 查找之前统一执行，握手期注入的外来 SDP/candidate 被丢弃。
5. **`RtcSignaling.onMessage` 返回 unsubscribe**；DC 失败 / 超时 / PC close / manager stop 的 finally 里调用并清 inbox。重复失败的 DC 尝试不再堆积历史 listener。

## 文件清单

| 文件 | 作用 |
|---|---|
| `apps/gateway/src/mesh/mesh-runtime.ts` | 生成 id、cid 映射、拒绝重复、attach 前 verify、verifyInbound 接线、openWs 传 cid |
| `apps/gateway/src/mesh/mesh-runtime.test.ts` | 生成 / 映射 / 重复拒绝 |
| `apps/gateway/src/mesh/mesh-deps.ts` | `StreamOpener.openWsStream(..., cid?)`、lookup `cid`、`MeshSocketData.cid` |
| `apps/gateway/src/mesh/mesh-routes.ts` + test | `GET ?cid=` |
| `apps/gateway/src/mesh/mesh-http.ts` + test | `/ws?cid=` 写入 upgrade data |
| `apps/gateway/src/mesh/stream-targets.ts` + test | open/accept 传 cid；重复登记 RST |
| `apps/gateway/src/mesh/forwarder.ts` + test | `/n/:id/ws?cid=` → `openWsStream` |
| `apps/gateway/src/mesh/types.ts` / `index.ts` | payload `cid`、导出 `generateConnectionId` |
| `apps/gateway/src/mesh/rtc/carrier-switch.ts` + test | `verifyInbound` 挡屏障缓冲 |
| `apps/gateway/src/mesh/rtc/bulk.ts` + test | 下载每帧 / EOF verify |
| `apps/gateway/src/mesh/rtc/signaling.ts` + test | 校验先于 listener |
| `apps/gateway/src/mesh/rtc/ice.ts` | `onMessage` → unsubscribe |
| `apps/gateway/src/mesh/rtc/rtc-peer-manager.ts` | verifyInbound、bindSignaling unsub |
| `apps/gateway/src/mesh/peer-manager.ts` + test | 包装 signaling、失败/close/stop 退订 |
| `apps/gateway/src/mesh/integration/direct-path.integration.test.ts` | 真上传 `{ok:true}`、过期/错 via 不能 attach、重复 cid |
| `packages/app/src/runtime/assemble.ts` + test | 只传 `cid`，由 registry 生成 server id |

## 公开 API

```ts
export const CONNECTION_ID_BYTES = 32
export function generateConnectionId(): string  // 32 bytes b64url

export type RegisterGatewaySessionInput = {
  sid: string; uid: string; via: string
  session: GatewaySession
  connectionId?: string   // 仅测试/注入；生产不传
  cid?: string            // 浏览器 nonce
  pc?: { close(): void }
}
export type RegisterGatewaySessionResult =
  | { ok: true; entry: RegisteredGatewaySession }
  | { ok: false; code: 'DUPLICATE_CONNECTION' | 'DUPLICATE_CID' }

class SessionRegistry {
  register(entry: RegisterGatewaySessionInput): RegisterGatewaySessionResult
  lookup(sid, via, connectionId?, cid?): ConnectionLookupResult
}

ConnectionLookup = (input: {
  sid: string; via: string
  connectionId?: string | null
  cid?: string | null
}) => ConnectionLookupResult

StreamOpener.openWsStream(link, auth, cid?: string)
openWsStream(link, auth, cid?: string)
WsStreamOpenPayload.cid?: string

CarrierSwitchOptions.verifyInbound?: (session: GatewaySession) => boolean
RtcPeerManagerOptions.verifyInbound?: VerifyInbound

RtcSignaling.onMessage(cb): () => void   // unsubscribe

GET  /api/mesh/connection?cid=<nonce>  → 200 { connectionId } | 404 | 409
POST /api/rtc/authorize  body.connectionId = **server** id
```

`register()` 不再在冲突时静默替换。`MeshRuntime.registerGatewaySession` 现在返回 `RegisterGatewaySessionResult`。

## 测试

`cd apps/gateway && bun test`：

```
 1823 pass
 0 fail
 6469 expect() calls
Ran 1823 tests across 208 files. [45.44s]
```

相对 B2-10 的 1812：**+11**。

`cd packages/app && bun test src/runtime`：

```
 20 pass
 0 fail
 54 expect() calls
Ran 20 tests across 3 files. [360.00ms]
```

覆盖：真上传 `{ok:true}`；过期 / 错 via 不能 attachDirect；重复 connectionId/cid 拒绝且旧会话仍在；下载 verify 失败 abort；握手期外来信令丢弃；多次失败 DC 后 listener 为 0。

## tsc / biome

| | 基线 | 本次 |
|---|---|---|
| gateway tsc | 23 | **23**（owned 文件 0 新增；`src/ws/index.test.ts` 仍是既有错误） |
| packages/app tsc | 1 | **1**（runtime 0 新增） |
| biome 31 个改动文件 | | **clean** |

## 未能做 / 协调者必须做

1. **前端未改（F3-5）**。必须按上面合约：WS URL 加 `?cid=`，`GET /api/mesh/connection?cid=` 换 server id，authorize 带该 id。继续用无 cid 的 GET 在多标签下仍是 409。
2. `apps/gateway/src/ws/index.ts` 范围内未改（sendControl 语义 B2-10 已闭环）。
3. `files.ts` 的 `rememberTransferUid` 仍模块私有；直连集成测试继续 overlay `filesBulkHooks.getTransferOwner`。
4. 浏览器合约 **刻意不** 走 HELLO。若以后要去掉 GET，需要动 Borsh（本轮按 B2-10 避开）。

未碰生产 tmex（9883 / `~/Library/Application Support/tmex/`）、默认 tmux session `tmex`。
