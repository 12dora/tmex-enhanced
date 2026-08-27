# B2-1 结果 — HubRuntime + 新 Borsh kinds

## 做了什么

Hub 侧注册表 / 信令 / 盲中转落地：`ctl` JSON 编解码、内存 node registry、uplink 鉴权与 relay、HTTP 管理/redeem、`/hub/uplink` 的 Bun WS adapter。未碰 `runtime.ts`、`src/auth/**`、`src/mesh/**`、`src/ws/**`。未 import 并发中的 key-log-store。

## 文件清单

`packages/shared`（仅这三处）：

- `src/ws-borsh/kind.ts` — `KIND_NODE_EVENT=0x0a01`、`KIND_RTC_SIGNAL=0x0a02`、`KIND_CARRIER_SWITCH=0x0a03`、`KIND_CARRIER_SWITCH_ACK=0x0a04`；纳入 `VALID_KINDS` / `kindToString`
- `src/ws-borsh/schema.ts` — 对应 schema + u8 枚举常量
- `src/ws-borsh/index.test.ts` — roundtrip / kind 有效性

`apps/gateway/src/hub/**`（新）：

| 文件 | 作用 |
|---|---|
| `types.ts` | `HubKeyLogSource`、config、auth callback、心跳常量 |
| `uplink-protocol.ts` | ctl JSON encode/decode，未知 `t` 拒绝 |
| `node-registry.ts` | nodeId → `{link, meta, lastSeen, authenticated}`；重复连接关旧 link |
| `node-persistence.ts` | `patchNode(db, id, patch)`（UserStore 无 update） |
| `uplink-server.ts` | challenge/auth、heartbeat、node.list、key.log、rtc、relay pump |
| `hub-runtime.ts` | HTTP + WS upgrade + `attachLocalNode` + `stop` |
| `index.ts` | barrel |
| `*.test.ts` + `hub-test-helpers.ts` | 单测 |

## 公开 API

### Borsh kinds（`kind.ts` / `schema.ts`）

```ts
KIND_NODE_EVENT = 0x0a01
KIND_RTC_SIGNAL = 0x0a02
KIND_CARRIER_SWITCH = 0x0a03
KIND_CARRIER_SWITCH_ACK = 0x0a04

NODE_EVENT_STATUS_ONLINE = 0, OFFLINE = 1, REVOKED = 2
RTC_SIGNAL_FROM_BROWSER = 0, FROM_NODE = 1
CARRIER_SWITCH_TO_DIRECT = 0, TO_PRIMARY = 1

NodeEventSchema        { nodeId: string, status: u8, reach: option<string>, inventory: option<string> }
RtcSignalSchema        { rtcSession: string, from: u8, to: string, sdp: option<string>, candidate: option<string> }
CarrierSwitchSchema    { epoch: u32, to: u8 }
CarrierSwitchAckSchema { epoch: u32 }
```

枚举走 u8，与 `SITE_THEME` 一致。`isValidKind` / `kindToString` 已覆盖。

**未改** `ws-borsh/index.ts`（范围外）。kinds 目前需从 `./kind` 导入；`schema.*` 已随 `export * as schema` 可见。协调者需在 `index.ts` 补 named re-export（仿 `KIND_CANONICAL_*` / `SITE_THEME_*`）。

### HubRuntime

```ts
new HubRuntime({
  db: AuthDb,
  userStore: UserStore,
  keyLogSource: HubKeyLogSource,
  config: { publicUrl: string; stun: string[]; turn?: { url: string; username: string; credential: string } | null },
  authenticate: (req) => { userId: string; entryNodeId: string } | null | Promise<...>,
  now?: () => number,
  heartbeatIntervalMs?: number,   // default 15_000
  heartbeatMissLimit?: number,    // default 3
})

handleRequest(req, server: { upgrade(req, opts?): boolean }): Promise<Response | undefined>
attachLocalNode(link: LinkSession): void
registerRtcSession(rtcSession: string, { fromNodeId, toNodeId }): void
stop(): void
handleUplinkOpen(ws) / handleUplinkMessage(ws, msg) / handleUplinkClose(ws)
isUplinkSocket(ws): boolean
```

HTTP：

- `POST /api/hub/enrollments/redeem` 公开
- `GET /hub/uplink` upgrade，`data.kind = 'hub-uplink'`
- 管理（`authenticate` 失败 → 401）：`GET /api/hub/nodes`、`POST /api/hub/nodes/:id/rename`、`POST /api/hub/nodes/:id/revoke`、`POST /api/hub/enrollments`
- 未命中 `/api/hub/*` 以外 → `undefined`（交给 assembler 下游）

### UplinkServer / NodeRegistry

```ts
accept(link: LinkSession): void
registerRtcSession / unregisterRtcSession
sendTo(nodeId, msg): boolean
broadcastNodeList(userId): Promise<void>
disconnect(nodeId, reason?): boolean
stop(): void

registry.put / get / listForBroadcast(userId) / remove / closeAll
```

### HubKeyLogSource（构造注入，不 import B1-3c）

```ts
head(userId): Promise<{ seq: bigint; hash: Uint8Array }>
list(userId, fromSeq?: bigint): Promise<{ seq: bigint; bytes: Uint8Array; sig: Uint8Array }[]>
append(userId, { bytes, sig }): Promise<{ ok: true; seq: bigint; hash: Uint8Array } | { ok: false; error: string }>
```

## ctl JSON 线格式

UTF-8 JSON，`t` 判别。二进制一律 **unpadded b64url**。`node_id` = `nodeIdToHex`（32 hex）。`seq` 为 number（安全整数）或十进制 string。未知 `t` → `UplinkCtlError`。

```jsonc
{ "t": "auth.challenge", "nonce": "<b64url 32B>" }
{ "t": "auth.response", "node_id": "<hex>", "sig": "<b64url 64B>" }   // sig = Ed25519(nonce 原字节)
{ "t": "auth.ok" }
{ "t": "ping" }
{ "t": "pong" }
{ "t": "node.status", "version": "…", "tmux": true, "direct_capable": false, "inventory": {}, "endpoints": [] }
{
  "t": "node.list",
  "version": 1,
  "key_log_head": { "seq": 0, "hash": "<b64url 32B>" },
  "rtc": { "stun": ["stun:…"], "turn": { "url": "…", "username": "…", "credential": "…" } | null },
  "nodes": [{ "id", "name", "online", "endpoints", "inventory", "direct_capable", "version" }]
}
{ "t": "key.log.req", "from_seq": 1 }
{ "t": "key.log.res", "records": [{ "seq": 1, "bytes": "<b64url>", "sig": "<b64url 64B>" }] }
{ "t": "key.log.append", "bytes": "<b64url>", "sig": "<b64url 64B>" }
{ "t": "rtc.signal", "rtcSession": "…", "from": "browser"|"node", "to": "<nodeId>", "sdp"?: "…", "candidate"?: "…" }
{ "t": "enroll.redeemed", "certificate": "<b64url>", "cert_sig": "<b64url 64B>", "enroll_pk": "<b64url 32B>" }
```

relay OPEN：入 `{to}` JSON；转发给目标时附加 `{from}`。DATA 原样双向拷贝；END 半关闭对向；RST/`onAbort` 双向 RST。跨 `user_id` → RST `cross-user`。

心跳：每 15s `ping`；连续 miss > 3 关链路并广播离线。`auth.response` 用 `node_certs` 的 `ed_pk` 验 nonce；未知/吊销关链路（`unknown-cert` / `revoked` / `unauthorized`）。同 nodeId 再连：关旧 link（`replaced`）。

## HTTP 体

**POST `/api/hub/enrollments`**（需 auth）：`{ enroll_pk, authorization, authorization_sig, exp }` 皆 b64url；用用户当前 root pk + `root_epoch` 验 authorization。201 `{ ok, id, expires_at }`。

**POST `/api/hub/enrollments/redeem`**：`{ certificate, cert_sig, name, version }`。成功：

```json
{
  "user": { "id", "username", "root_public_key": "<b64url>", "root_epoch", "kdf_params" },
  "user_key_log": [{ "seq", "bytes", "sig" }],
  "node_certs": [{ "node_id", "user_id", "admit_record_seq", "certificate", "cert_sig", "authorization", "authorization_sig", "revoked_log_seq" }]
}
```

然后若 entry 在线，向其 ctl 推 `enroll.redeemed`。失败：`unknown_enrollment` / `expired` / `reused` / `bad_cert_sig` / `enroll_pk_mismatch` / `uid_mismatch` → 400。

## 测试

`cd apps/gateway && bun test src/hub`：

```
 18 pass
 0 fail
 128 expect() calls
Ran 18 tests across 4 files. [634.00ms]
```

覆盖：auth 成功/错钥/revoked；重复 nodeId 替换；node.status → node.list；心跳超时离线广播；key.log req/res + append 重播；relay 双向字节 + END/RST + 跨用户拒绝；rtc 路由 + spoofed `from:'node'` 拒绝；enroll create→redeem + `enroll.redeemed`；错 enroll_pk / 过期 / 重放；管理 API 401。

`cd packages/shared && bun test src/ws-borsh src/auth`：

```
 168 pass
 0 fail
 571 expect() calls
Ran 168 tests across 14 files. [737.00ms]
```

全量 `packages/shared && bun test` 当前 **250 pass / 14 fail / 1 error**，失败全在并发 `src/link/**`（secure-channel / mux / websocket-link），非本任务。

biome：范围 15 文件 `Checked 15 files. No fixes applied.`

## tsc

| | 数量 |
|---|---|
| 基线 gateway | 23 |
| 本次全量 gateway | 25（**`src/hub/**` = 0**） |
| 基线 shared | 0 |
| 本次全量 shared | 7（全在 `src/link/**`，**`ws-borsh/kind.ts` `schema.ts` = 0**） |

gateway 多出的 2 条在 `src/mesh/peer-server.ts`（并发 B2-2）；shared 7 条在 link。本范围未引入错误。

## 协调者必须做

1. **`packages/shared/src/ws-borsh/index.ts`** 补 re-export：`KIND_NODE_EVENT` 等 4 个 kind + `NODE_EVENT_STATUS_*` / `RTC_SIGNAL_FROM_*` / `CARRIER_SWITCH_TO_*`。否则 `wsBorsh.KIND_NODE_EVENT` 不存在（测试从 `./kind` 直引）。
2. **Assembler**：`handleRequest` 先于 gateway；Bun `websocket.open/message/close` 里 `isUplinkSocket` 则转 `handleUplinkOpen/Message/Close`。注入真实 `HubKeyLogSource` 与 `authenticate(req) → { userId, entryNodeId }`（`entryNodeId` 用于 enroll.redeemed 推送；比任务字面 `{userId}` 多了这个字段）。
3. **UserStore 缺口**（未改 auth）：无 `updateNode`。本模块用注入的 `db` + `patchNode` 写 `nodes` 的 name/status/inventory/lastSeen。建议 B1-3b follow-up 补 `updateNode`。
4. **`enrollment_tokens` 无 `entry_node_id` 列**。create 时把 `{ authorization_b64, entry_node_id }` 塞进 `authorizationJson`。若要落库持久化，需 schema + UserStore 扩列。
5. **node_id 键** = `nodeIdToHex(certificate.node_id)`（32 hex），与 `node_certs.node_id` 对齐。

未碰生产 tmex / 默认 tmux session / `bun install`。
