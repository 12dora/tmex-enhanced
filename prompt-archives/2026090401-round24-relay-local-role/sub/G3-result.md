# G3 结果：`rename-node` 密钥日志记录

## 做了什么

新增签名记录类型 `rename-node`（`root` / `passkey`，`minVersion 1.1.24`，`allowForce: false`）。任意持根钥或 passkey 的节点可改任意已承认节点的名字；各节点本地应用。Hub 经 `?hub=sync` 收到时同样写 `nodes.name` 并广播，Hub 网格也可走这条路径。

**未**把 `rename-node` 放进 `RELAY_RECORD_TYPES`（否则 Hub 模式会跳过 ACK、不推旧上级）。Applier 单独放在 `rename-node-record.ts`，避免 `key-log.ts` 涨过 allowlist。

### 1. 记录定义（shared）

- Borsh：`node_id(16) ‖ name(string)`，类型追加在 `KeyLogType` **末尾**。
- 校验：trim 后非空、≤ 64 个 UTF-16 码元（对齐加入向导 `MAX_NAME_LENGTH`；Hub HTTP rename 本身只 trim）。
- `UserKeyState.nodeNames?: Map<hex, name>`：最新投影；`reset-root` 清空。标成可选，因为 `user-key-service.currentState` 不在本任务 scope，不能补字段——快照未回放时缺省，applier 会 `??= new Map()`。持久化真相在表，不靠这个 Map。

### 2. Gateway 落账

- `persistApplied` → `nodes.name`（无行则 `patchNode` no-op）、`peer_cache.name`（无行则 stub upsert，保留已有 `version`）、本机则 `node_identity.name`。
- 站点名不在 persist 里改：`onApplied` → `emitRenameNodeEvent` → 已有 `onLocalNodeName`（与 Hub `handleRename` 的 `syncLocalSiteName` 同一条 assemble 接线）。
- Hub 广播：落账后 `UplinkServer.applyAppendEffects` 已 `broadcastNodeList`（读 DB `nodes.name`）。`bindKeyLogProjection` 额外 `registry.updateMeta` + `NODE_EVENT`。
- **未改** `hub-runtime.ts`。投影回调抽到 `apps/gateway/src/mesh/key-log-projection.ts`，在 `constructMeshDeps` 绑定（不塞进已 allowlist 的 `createMeshStoresAndServices`）。

### 3. 迁移 0042

注册前重读：`0041_peer_cache_version` 已在（B1/G2）。本任务只 **append** `0042_rename_node_keylog`。按 0040 重建 `user_key_log` 放开 CHECK。无 snapshot（0040 也没有）。

## 改动文件

**新增**

- `packages/shared/src/auth/rename-node-record.ts`
- `apps/gateway/drizzle/0042_rename_node_keylog.sql`
- `apps/gateway/src/mesh/key-log-projection.ts`
- `apps/gateway/src/auth/rename-node-compat.test.ts`
- `apps/gateway/src/mesh/rename-node-keylog.test.ts`

**修改**

- `packages/shared/src/auth/encoding.ts`（564 行，接近 600 警告线）及 `encoding.test.ts`
- `packages/shared/src/auth/key-log.ts`、`key-log.test.ts`、`index.ts`
- `apps/gateway/src/db/schema/users-auth.ts`
- `apps/gateway/src/db/managed-migrations.ts`、`drizzle/meta/_journal.json`（仅追加 0042）
- `apps/gateway/src/auth/key-log-store.ts`、`key-log-store.test.ts`
- `apps/gateway/src/auth/user-key-persistence.ts`、`user-key-persistence.test.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts`、`node-list-apply.ts`、`node-list-apply.test.ts`
- `docs/relay/2026090304-relay-role.md`（§4 表 + 应用规则、§6 CHECK、§9「节点名」）

**未改**

- `hub-runtime.ts`、`user-store.ts`、`schema/mesh.ts`、`relay-*.ts`、`uplink-client.ts`、`mesh-http.ts`、`apps/fe/**`、`packages/app/**`

## 测试

- shared：编解码 round-trip、trim/空/超长、signer 矩阵、`KEYLOG_RECORD_COMPAT`、root 投影、passkey 验签应用、`unknown_node`。
- gateway：persist 写 `nodes` + `peer_cache`、本机写 `node_identity`、CHECK 接受类型、`inspectHubAuthRecordCompat` 对 1.1.23 节点 409 且 `allowForce:false`、1.1.24 放行、self rename 发 `NODE_EVENT` + `onLocalNodeName`。

## 验证

- `bunx tsc --noEmit -p packages/shared`：0
- `bunx tsc --noEmit -p apps/gateway`：0（`nodeNames` 可选，未逼 `user-key-service.ts`）
- `packages/shared` `bun test`：**631 pass / 0 fail**（基线 621）
- `apps/gateway` 本任务文件隔离：**18 pass**
- `apps/gateway` 全量：**4166 pass / 2 fail / 2 errors**（基线 4141）。失败不在本 diff：
  1. `src/mesh/relay-dial.test.ts`：`http://[::1]:9` loopback
  2. `src/mesh/relay-node-list.test.ts`：`peer_cache.version` 回落测 FK（G2 未完成 fixture）
- `bunx biome check`：本任务 18 个源文件干净
- complexity gate：本任务文件未超 allowlist；`encoding.ts` 564/600 接近阈值

未跑 Playwright e2e。未改 allowlist。

## 指挥官必须接的 FE

改名提交走已有 **`AuthApi.appendKeyLog({ bytes, sig }, { hubSync: true })`** → `POST /api/auth/keylog?hub=sync`（与 `set-relays` 相同）。本地 `buildKeyLogRecord` + `encodeRenameNodePayload` / `buildRenameNodePayload`。

现状 Hub 路径（中继模式下不可用，需按角色分流）：

- `HubApi.rename` → `POST /n/<hub>/api/hub/nodes/:id/rename`
- `apps/fe/src/pages/settings/use-node-rename-channel.ts`（通用站名）
- `apps/fe/src/pages/settings/use-site-settings-save.ts`
- `apps/fe/src/pages/settings/nodes/management/use-node-row-actions.ts`
- 节点详情 `node-detail-types.ts`

Hub 网格可继续走 HTTP rename，也可改走 `rename-node`；由 FE 决定。

## 需要指挥官处理

1. **中继模式提交 `rename-node` 会 409 `KEYLOG_TYPE_UNSUPPORTED_BY_NODES`。** `inspectHubAuthRecordCompat`（`apps/gateway/src/hub/hub-authorization.ts:214`，**不在 G3 scope**）只对 `RELAY_RECORD_TYPES` 在 `listNodes().length === 0` 时放行。中继租户有 certs、无 `nodes` 行，`nodesBlockingMinVersion` 把无 version 的 cert 全当成过旧。请把空注册表豁免扩到 `RENAME_NODE_RECORD_TYPES`（已从 `@tmex/shared/auth` 导出）。**不要**把类型塞进 `RELAY_RECORD_TYPES`。
2. 若希望 `currentState().nodeNames` 在快照加载时也完整：在 `projectRelayKeyLogState` / `user-key-service.currentState` 回放 `rename-node` 或从 `peer_cache` 填 Map。当前落账不依赖该投影。
3. 迁移：0041 已在，0042 接在其后。若后续任务再加 0043，勿改 0042 条目。
4. gateway 全量 2 fail 属并行任务（relay-dial / relay-node-list），非本 diff。
