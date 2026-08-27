# B2-5 结果 — 前端阻塞的后端契约补齐

worktree `/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。对照 `f4-1` / `f4-3` / `f4-3-review` 的阻塞项，以及 `b2-2b-fix` / `b2-1-fix` 现约。

未改 `mesh-runtime.ts` / `peer-manager.ts` / `ws/**` / `packages/app`（接线见文末「协调者必须做」）。`uplink-client.ts` 只动了 `key.log.ack` + 本地领先补传，未碰 `connectWithLink` 区域。

---

## 一、文件清单

| 文件 | 变更 |
|---|---|
| `packages/shared/src/ws-borsh/{kind,schema,index}.ts` + `index.test.ts` | `KIND_ENROLL_REDEEMED = 0x0a05` + `EnrollRedeemedSchema` + re-export |
| `apps/gateway/src/auth/user-store.ts` | 小查询：`getHubMeta` / `upsertHubMeta`（`peer_cache.node_id='hub'`）、`getEnrollmentTokenById` / `ByNodeId`；`consumeEnrollmentToken` 可选写回 `authorizationJson` |
| `apps/gateway/src/mesh/auth-routes.ts` + test | `keylog/head`、`passkeys`、`mode` 新字段、`POST /api/auth/keylog?hub=sync` |
| `apps/gateway/src/mesh/mesh-routes.ts` + test | `isHub`；公开 `forwardEnrollRedeemed` |
| `apps/gateway/src/mesh/mesh-http.ts` + test | 注入 `hubPublicUrl`；`/mesh/ws` 5 min 续验 4401 测试 |
| `apps/gateway/src/mesh/uplink-protocol.ts` + test | `node.list.hub`、`key.log.append.id`、`key.log.ack`、`enroll.redeemed.node_id` |
| `apps/gateway/src/mesh/uplink-client.ts` + test | persist hub meta；`appendAndAck`；本地 head > hub 时按序 `key.log.append` |
| `apps/gateway/src/hub/{types,uplink-protocol,uplink-server,hub-runtime}.ts` + tests | 同上 ctl；redeem 落证书；enrollment GET；nodes 带证书；append ack |

---

## 二、前端契约增量（最终）

### `GET /api/auth/mode`（公开）

mesh 增加（standalone 全为 `null`）：

```ts
rootEpoch: number | null
rootPublicKey: string | null   // b64url
hubNodeId: string | null       // roles.hub → 本 nodeId；否则 peer_cache 学到的 hub
hubPublicUrl: string | null    // 同上 / MeshHttpRuntime.hubPublicUrl
```

### `GET /api/auth/keylog/head`（需会话）

```ts
{ seq: number | string, hash: string /* b64url */, rootEpoch: number, uid: string }
```

### `GET /api/auth/passkeys`（需会话）

```ts
{ passkeys: Array<{
  credential_id: string, name: string | null, rp_id: string,
  origin: string, created_at: number, log_seq: number
}> }
```

### `POST /api/auth/keylog?hub=sync`（需会话）

先经 uplink `key.log.append {bytes, sig, id}` 等 `key.log.ack`，再本地 apply。响应：

```ts
{ ok: true, seq: number, hash: string, hubAck: boolean, hubError?: string }
```

无 `?hub=sync` 时响应仍是 `{ok, seq, hash}`（best-effort publish 不变）。
本地 apply 若与已有 head 字节相同，视为幂等成功（hub 先落、catch-up 抢跑时不 `seq_gap`）。
`publishAndAck` 未接线时 `hubAck:false, hubError:'unavailable'`，仍本地 apply。

### `GET /api/mesh/nodes`（需会话）

每行增加 `isHub: boolean`。

### Hub HTTP

`POST /api/hub/enrollments` → `{ ok, id, expires_at, public_url }`（`id` 原已有，现加 `public_url`）。

`GET /api/hub/enrollments/:id`（需会话，不能是 `redeem`）：

```ts
{ status: 'pending' | 'redeemed', enroll_pk: string /* b64url */,
  certificate?: string, cert_sig?: string, node_id?: string }
```

Redeem 时把 `{certificate_b64, cert_sig_b64, node_id}` 写进该 token 的 `authorization_json`（C5-4 可轮询同一形状）。

`GET /api/hub/nodes` 行在有 cert 或 redeemed token 时带 `certificate` / `cert_sig`（b64url）。

### Uplink ctl

`node.list` 可选 `hub: { nodeId, publicUrl }`。节点 `UplinkClient` 写入 `peer_cache` 哨兵行 `node_id='hub'`，重启后 `/api/auth/mode` 与 `/api/mesh/nodes` 离线可答。

`key.log.append` 可选 `id`。新消息 `key.log.ack { id, ok, seq? | error? }`。

`enroll.redeemed` **现要求** `node_id`（hex）：`{ certificate, cert_sig, enroll_pk, node_id }`。

### `/mesh/ws`

新 Borsh kind：

```ts
KIND_ENROLL_REDEEMED = 0x0a05
EnrollRedeemedSchema { enrollPk: bytes, certificate: bytes, certSig: bytes, nodeId: string }
```

`wsBorsh.KIND_ENROLL_REDEEMED` / `wsBorsh.schema.EnrollRedeemedSchema` 已从 `@tmex/shared` re-export。
`MeshRoutes.forwardEnrollRedeemed({enrollPk, certificate, certSig, nodeId})` 广播给当前 entry 上的 `/mesh/ws`。

会话过期：`/mesh/ws` 升级时无会话仍 4401；连接中每 5 min `touchSocket` 失败同样 4401（已补测试）。

---

## 三、公开 API（代码）

```ts
// user-store
HUB_META_PEER_ID = 'hub'
getHubMeta(): { nodeId: string; publicUrl: string } | null
upsertHubMeta({ nodeId, publicUrl, now, listVersion? }): void
getEnrollmentTokenById(id): EnrollmentTokenRecord | null
getEnrollmentTokenByNodeId(nodeId): EnrollmentTokenRecord | null
consumeEnrollmentToken(pk, { nodeId, now, authorizationJson? })

// auth-routes
type AuthKeyLogPublisher = {
  publish(record): void | Promise<void>
  publishAndAck?(record): Promise<{ok:true, seq: bigint|number} | {ok:false, error:string}>
}
AuthRoutesDeps.hubPublicUrl?: string | null

// mesh-http
MeshHttpRuntimeOptions.hubPublicUrl?: string | null

// mesh-routes
MeshNodeDto.isHub: boolean
MeshRoutes.forwardEnrollRedeemed(msg): void

// uplink-client
UPLINK_KEY_LOG_ACK_TIMEOUT_MS = 10_000
UplinkClient.appendAndAck(record, timeoutMs?): Promise<UplinkKeyLogAck>

// hub
HubRuntimeConfig.nodeId?: string   // 有则 node.list 带 hub，并 upsertHubMeta
```

---

## 四、测试 / tsc / biome

```
cd apps/gateway && bun test src/mesh src/hub
  174 pass  0 fail  746 expect() calls
  Ran 174 tests across 26 files. [10.37s]

cd apps/gateway && bun test src/auth/user-store.test.ts
  7 pass  0 fail

cd packages/shared && bun test
  282 pass  0 fail  883 expect() calls
  Ran 282 tests across 29 files. [1125.00ms]
```

| | 基线 | 现在 |
|---|---|---|
| gateway tsc | 24 | **23**（本范围 0；全量下降来自并发模块，非本任务） |
| shared tsc | 0 | **0** |

biome：范围 22 文件 `Checked 22 files. No fixes applied.`

---

## 五、未能做的 / 协调者必须做

范围禁止改 `mesh-runtime.ts` / `packages/app`，下列接线未落地，前端三条阻塞路径会停在半成品：

1. **`HubRuntimeConfig.nodeId`** — `createMeshRuntime` 里 `new HubRuntime({ config: { publicUrl, stun, turn, nodeId: identity.nodeIdHex } })`。否则 `node.list` 没有 `hub`，普通 node 学不到 `hubPublicUrl`，join 命令仍只能用 entry origin。
2. **`MeshHttpRuntime({ hubPublicUrl: hubEndpointUrl(config) })`** — hub 本机在尚未 ingest `node.list` 时 `/api/auth/mode.hubPublicUrl` 的回退。
3. **`enroll.redeemed` → 浏览器** — `new UplinkClient({ onEnrollRedeemed: (msg) => http.mesh.forwardEnrollRedeemed({ enrollPk: msg.enroll_pk, certificate: msg.certificate, certSig: msg.cert_sig, nodeId: msg.nodeId }) })`。HTTP 轮询（`GET /api/hub/enrollments/:id` 与 `GET /api/hub/nodes` 的证书字段）不依赖此接线。
4. **`publisher.publishAndAck`** — 包 `uplink.appendAndAck`：`ack.ok ? {ok:true, seq: ack.seq} : {ok:false, error: ack.error}`。不接则 `?hub=sync` 永远 `hubAck:false`。本地领先补传**不需要**改 mesh-runtime（`KeyLogApplier.list` 已有）。

前端：join 用 enrollment 响应的 `public_url`；admit/revoke 走 `POST /api/auth/keylog?hub=sync` 且等 `hubAck`；`/mesh/ws` 加 `KIND_ENROLL_REDEEMED` case 调 `offerCertificate`；4401 停重连。

未碰生产 tmex、名为 `tmex` 的 tmux session、`bun install`、生成文件。
