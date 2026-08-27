# B2-6 结果 — B2-5 review 修复 + 生产接线 + redeem 幂等

worktree `/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。对照 `b2-5-review.md`（协调者判定全部有效）与 C5-4 补丁 B。

未改 `mesh/rtc/**`、`ws/**`、`packages/app`、前端。未碰生产 tmex / 名为 `tmex` 的 tmux session。未 `bun install`。未 commit。

---

## 一、文件清单

修改：

| 文件 | 作用 |
|---|---|
| `packages/shared/src/ws-borsh/schema.ts` + `index.test.ts` | `EnrollRedeemedSchema`：`enrollPk` 32 B / `certSig` 64 B；证书上限 + `nodeId` 32-hex 校验 |
| `apps/gateway/src/mesh/auth-routes.ts` + test | `hub=sync` 先预校验再 ack 再 persist；拒绝 409、超时 504；node 默认 sync |
| `apps/gateway/src/mesh/mesh-deps.ts` | `KeyLogPublisher` 增加 `publishAndAck` / `queryHubHead` / `queryKeyLogAt` |
| `apps/gateway/src/mesh/mesh-routes.ts` + test | `ENROLL_REDEEMED` 只推给 `entrySid` 匹配的 `/mesh/ws`；两 socket 测试 |
| `apps/gateway/src/mesh/mesh-runtime.ts` | 生产接线：`publishAndAck`、`HubRuntime.nodeId`、`hubPublicUrl`、`onEnrollRedeemed`、enrollment `sid` |
| `apps/gateway/src/mesh/uplink-protocol.ts` + test | node 侧 ctl 镜像 hub 边界：总字节 / 字符串 / `enroll_pk` 32 / `cert_sig` 64 / `node_id` 32-hex / `entry_sid` |
| `apps/gateway/src/mesh/uplink-client.ts` | `lastKeyLogHead`、`queryHubHead`、`queryKeyLogAt` |
| `apps/gateway/src/mesh/index.ts` | 导出新 ctl 上限常量 |
| `apps/gateway/src/hub/{types,uplink-protocol,uplink-server,hub-runtime}.ts` + tests | `entry_sid`、ack 先于 effects、死 uplink 不抛、redeem 幂等 |

新增：

| 文件 | 作用 |
|---|---|
| `apps/gateway/src/mesh/integration/hub-contract.integration.test.ts` | `createMeshRuntime(hub,node)`：`node.list.hub`、`mode.hubNodeId`、redeem 只达创建者 socket、`?hub=sync` 真 ack |

未改：`mesh-http.ts`（`hubPublicUrl` 选项 B2-5 已有，本次由 `mesh-runtime` 注入）。

---

## 二、前端契约增量（相对 B2-5，最终）

### `POST /api/auth/keylog`（keylog sync 语义）

| 条件 | 行为 |
|---|---|
| `?hub=sync`（任意角色） | 强制 hub-sync |
| 无 query **且** `roles.hub` | 仍 local-first：先本地 apply，再 best-effort `publish`；响应 `{ok, seq, hash}`（无 `hubAck`） |
| 无 query **且** 仅 `roles.node` | **默认 hub-sync**（与带 `?hub=sync` 相同） |

**hub-sync 路径：**

1. 本地 `verifyKeyLogRecord` + 内存 `applyKeyLogRecord`（不落库）。本地非法 → 400 / 本地 fork → 409 `{code:'KEY_LOG_FORK'}`，不打 hub。
2. `UplinkClient.appendAndAck`（带 request id）。
3. **明确拒绝**（`fork` / `seq_gap` / `unavailable` / …）→ **409 `{code: <hubError>}`，本地不 persist**。
4. **超时**：同一 `{bytes, sig}` 再发一次；仍超时则查 hub head（最近一次 `node.list.key_log_head` 或 `key.log.req` 该 seq）。若 hub head hash == 本记录 hash（或 hub 已存相同字节）→ 视为 ack 并本地 persist；否则 **504 `{code:'HUB_TIMEOUT'}`，本地不 persist**。
5. 肯定 ACK 后才 `UserKeyService.apply`。若 catch-up 已写入相同 head，幂等成功 `{ok, seq, hash, hubAck:true}`。

成功响应（hub-sync）：

```ts
{ ok: true, seq: number, hash: string /* b64url */, hubAck: true }
```

**不再**在 200 里返回 `hubAck:false`。超时/拒绝走 504/409，前端应把非 200 或非 `hubAck===true` 都当成未确认（保留 pending）。

Admit / revoke 继续打 `POST /api/auth/keylog?hub=sync`，仅当 `hubAck === true` 清 pending。

### `/mesh/ws` `KIND_ENROLL_REDEEMED`

```ts
KIND_ENROLL_REDEEMED = 0x0a05
EnrollRedeemedSchema {
  enrollPk: bytes(32),
  certificate: bytes,      // 编码前 ≤ 2048 B
  certSig: bytes(64),
  nodeId: string           // 32-hex
}
```

**定向：** 只发给 `ws.data.sid === enrollment 创建者 sid` 的 socket。无 sid / 不匹配 → **不广播**（轮询 `GET /api/hub/enrollments/:id` 兜底）。

### Hub enrollment / redeem

`POST /api/hub/enrollments` 把创建者 session sid 写入 `authorizationJson.entry_sid`（与 `entry_node_id` 并列）。

Uplink `enroll.redeemed`：

```ts
{ t: 'enroll.redeemed', certificate, cert_sig, enroll_pk, node_id /* 32-hex */, entry_sid?: string }
```

`POST /api/hub/enrollments/redeem`：token 已用且 **证书+sig 与已存 `certificate_b64`/`cert_sig_b64` 相同** → 返回与首次相同的 `{user, user_key_log, node_certs}`（HTTP 200，供 CLI 网络重试）；不同 cert → 仍 400 `{error:'reused'}`。幂等重放不再二次推 `enroll.redeemed`。

### `GET /api/auth/mode`

生产 `createMeshRuntime` 下：hub 角色 `hubNodeId` = 本机 `node_identity`；`hubPublicUrl` = `HubRuntimeConfig.publicUrl` / `MeshHttpRuntime.hubPublicUrl`。`node.list.hub` 写入 `peer_cache` 哨兵行，普通 node 离线可答。

---

## 三、公开 API

```ts
// mesh-deps / auth-routes
type KeyLogHubAck = { ok: true; seq: bigint | number } | { ok: false; error: string }
type KeyLogPublisher = {
  publish(record: { bytes: Uint8Array; sig: Uint8Array }): void | Promise<void>
  publishAndAck?(record): Promise<KeyLogHubAck>
  queryHubHead?(): Promise<{ seq: bigint | number; hash: Uint8Array } | null>
  queryKeyLogAt?(seq: bigint): Promise<{ bytes: Uint8Array; sig: Uint8Array } | null>
}
type AuthKeyLogPublisher = KeyLogPublisher

// mesh-routes
MeshRoutes.forwardEnrollRedeemed(msg: {
  enrollPk: Uint8Array; certificate: Uint8Array; certSig: Uint8Array
  nodeId: string; entrySid?: string
}): void   // 无 entrySid → 不发送

// uplink-client
UplinkClient.lastKeyLogHead: { seq: bigint; hash: Uint8Array } | null
queryHubHead(): Promise<{ seq: bigint; hash: Uint8Array } | null>
queryKeyLogAt(seq: bigint, timeoutMs?): Promise<{ bytes: Uint8Array; sig: Uint8Array } | null>
appendAndAck(record, timeoutMs?): Promise<UplinkKeyLogAck>

// uplink-protocol (node)
UPLINK_CTL_MAX_BYTES = 64 * 1024
UPLINK_CTL_MAX_STRING_LEN = 4 * 1024
UPLINK_CTL_MAX_CERT_BYTES = 2048
UplinkEnrollRedeemed.entrySid?: string

// hub
HubAuthResult.sid?: string | null
EnrollRedeemedMessage.entry_sid?: string
UPLINK_CTL_MAX_CERT_BYTES = 2048

// ws-borsh
ENROLL_REDEEMED_MAX_CERT_BYTES = 2048
ENROLL_REDEEMED_NODE_ID_RE
assertEnrollRedeemedFields(data): void
```

生产接线（`createMeshRuntime`）：

- `new HubRuntime({ config: { …, nodeId: identity.nodeIdHex } })`，`authenticate` 带 `sid`
- `MeshHttpRuntime({ hubPublicUrl: hubEndpointUrl(config), publisher: { publish, publishAndAck: uplink.appendAndAck, queryHubHead, queryKeyLogAt } })`
- `UplinkClient({ onEnrollRedeemed → http.mesh.forwardEnrollRedeemed({…, entrySid}) })`

---

## 四、测试 / tsc / biome

```
cd apps/gateway && bun test src/mesh src/hub
  214 pass  0 fail  1045 expect() calls
  Ran 214 tests across 30 files. [16.68s]
```

含 `mesh/rtc/**`：本跑次 **0 fail**（B3-1-fix 当时未把 rtc 测红）。

```
cd packages/shared && bun test
  283 pass  0 fail  887 expect() calls
  Ran 283 tests across 29 files. [1160.00ms]
```

| | 基线 | 现在 |
|---|---|---|
| gateway tsc | 24 | **23**（owned 文件 0；rtc 0；未升） |
| shared tsc | 0 | **0** |

biome：范围 21 文件 `Checked 21 files. No fixes applied.`

---

## 五、未能做的 / 协调者必须做

1. **`UserKeyService` 无 dry-run API**（`apps/gateway/src/auth/` 范围外）。预校验在 `AuthRoutes` 内用 `verifyKeyLogRecord` + 内存 `applyKeyLogRecord`，通过后再 `apply` 落库。
2. **`mesh-http.ts` 无 diff**：`hubPublicUrl` 选项已在 B2-5；本次只在 `createMeshRuntime` 注入。
3. **跨 node 的 `/n/<hub>/api/hub/*` 仍走 assemble 的 hub dispatch**（`packages/app` 范围外）。entry 上 `/mesh/ws` 的 sid 是 **该 entry 的 self-session**；经转发打到 hub 的 sid 是 hub-session。同机 `hub,node`（集成测试覆盖）两者一致；远程 entry 上若 sid 对不上，推送静默跳过，前端继续 poll `GET /api/hub/enrollments/:id`。若要远程 entry 也推到浏览器，需 forwarder 把 entry self-sid 带到 enrollment（范围外）。
4. 前端若仍把 200 + `hubAck:false` 当“hub 未确认”，需改为：非 200（409/504）同样保留 pending。`?hub=sync` 成功体现在只有 `hubAck:true`。

B2-5 报告里「协调者必须做」的 4 条生产接线（`HubRuntime.nodeId`、`hubPublicUrl`、`onEnrollRedeemed`、`publishAndAck`）**已在本任务落地**，无需再补 mesh-runtime。
