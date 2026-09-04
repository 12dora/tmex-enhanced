# G2 结果 — Backend: relay leftovers

## 结论

B1 `peer_cache.version`、B3 本机免密 status、B4 RTT + `currentNodes` / `totals.nodes`、self-dial 回环、B6 去掉 join-material 顶层兼容字段均已落地。`KEYLOG_RECORD_COMPAT` 两处豁免**未删**（门禁仍读 `nodes` 表，加列后仍无法判定中继对端）。

## 改动文件

### 新增
- `apps/gateway/drizzle/0041_peer_cache_version.sql`
- `apps/gateway/src/mesh/relay-dial.ts` + `relay-dial.test.ts`
- `apps/gateway/src/mesh/relay-uplink-heartbeat.ts` + `relay-uplink-heartbeat.test.ts`
- `apps/gateway/src/mesh/uplink-peer-persist.ts`（从 `uplink-client.ts` 拆出 peer_cache 写入，压行数）
- `apps/gateway/src/mesh/relay-node-list.test.ts`
- `apps/gateway/src/relay/relay-quota-ctl.ts`

### 修改（本任务）
- schema / 迁移：`apps/gateway/src/db/schema/mesh.ts`、`managed-migrations.ts`、`drizzle/meta/_journal.json`（只追加 0041；编辑时 G3 已写入 0042，未动其条目）
- `apps/gateway/src/auth/user-store.ts` + test、`schema.migration.test.ts`（0041 PRAGMA）
- mesh：`relay-routes.ts` + test、`relay-uplink-client.ts` + test、`relay-node-list.ts`、`uplink-client.ts` + test、`mesh-http.ts` + test
- relay：`relay-uplink-server.ts`、`relay-uplink-handlers.ts`、`relay-admin-routes.ts` + `relay-uplink.test.ts` / `relay-admin.test.ts`
- harness：`relay-tenant-ops.ts` 的 `primaryJoinRelay()`，以及两个 integration 测试改读 `relays[0]`
- `packages/shared/src/relay/codec.ts` + test（`relay.quota.currentNodes` 可选）
- `packages/api-client/src/relay/admin-api.ts` / `tenant-api.ts` + tests
- `packages/app/src/commands/relay.ts`、`lib/relay-session.ts` + `commands/relay.test.ts`
- `docs/relay/2026090304-relay-role.md`：§7.1 totals.nodes、§7.2 免密 status / rttMs / currentNodes / join-material、§8 quota 字段、§9 RTT + self-dial、CLI list 免密、§13 version 子弹

未改 G1 的 `relay-runtime.ts` / `relay-config-store.ts` / `relay-password.ts` / `relay-tenant-store.ts`（使用已有 `countActiveNodes`）。未改 G3 的 `packages/shared/src/auth/**`、`user-key-persistence.ts`、`key-log-store.ts`、`apps/fe/**`。

## 行为要点

1. **B1**：`peer_cache.version` 可空 TEXT。upsert 仅在 `version !== undefined` 时覆盖，避免其它调用方抹掉版本。`relayListToNodeList` 解开状态块写 `blob.version`，解不开回落缓存。Hub `persistUplinkPeerCache` 写 `node.version`。
2. **B1 豁免**：`inspectHubAuthRecordCompat` / `refuseUnsupportedHubAuthRecord` 仍按 `nodes` 表判定，中继租户该表为空，加 `peer_cache.version` 不够。未加「过旧 cached version 被拒」测试。
3. **B3**：`isLocalRelayStatusRequest` = `GET /api/mesh/relay/status` + `isTrustedLocalClient`（不信 `x-tmex-client-source`，peer 转发否）。`RelayRoutes.handle` 与 `MeshHttpRuntime.localUiGuard` 都放行。`tmex relay list` 先无 cookie 打 status，401 再走 node-session。`relay leave` 仍 login。
4. **B4**：heartbeat 记最新 ping→pong RTT，重连清零；status 的 attached 行报 `rttMs`。服务端 `relay.quota` 带 `currentNodes`（auth.ok、`notifyQuota`、keylog member 成功且未 ignored）。HTTP `GET /api/relay/status` 的 `totals.nodes` 为各租户 `countActiveNodes` 之和。
5. **Self-dial**：`resolveRelayDialUrl` 仅改拨号 URL；`RelayUplinkClient.relayHost` 仍来自原始 `hubUrl`（签名绑公网 host）。回环跳过 CA pin。enroll HTTP 走改写后的 `http://127.0.0.1:<GATEWAY_PORT>/api/relay/enroll`。join-material **不改写**返回给其它节点的 URL。
6. **B6**：join-material 只留 `logKey` + `relays[]`。harness `primaryJoinRelay` 读 `relays[0]`。

## 测试

- `relay-dial.test.ts`：改写 / 不改写、回环 CA、env 解析
- `relay-uplink-heartbeat.test.ts`：RTT 最新值、reset 清零
- `relay-node-list.test.ts`：缓存 version 回落
- `relay-routes.test.ts`：join-material 无顶层字段、本机 GET status 200、公网/peer 401、leave 仍 401、enroll 拨号改写且 proof 绑公网 host
- `mesh-http.test.ts`：localUiGuard 对本机 GET status 放行
- `relay-uplink-client.test.ts`：cache version、self-dial WS + 签名、quota.currentNodes
- `uplink-client.test.ts`：hub/peer persist 带 version
- `user-store.test.ts`：upsert 不传 version 不覆盖
- `schema.migration.test.ts`：0041 列可空
- codec / admin-api / tenant-api / `relay.test.ts` list 免密与 401 回退、leave 仍 login
- integration：join-material 无顶层字段，走 `relays[0]`

## 验证

| 项 | 结果 |
|---|---|
| `bunx tsc --noEmit -p apps/gateway` | 0 |
| `bunx tsc --noEmit -p packages/shared` | 0 |
| `bunx tsc --noEmit -p packages/api-client` | 5（基线：`client.test.ts`×4 + `files-download.test.ts`×1） |
| `bunx tsc --noEmit -p packages/app` | 0 |
| `apps/gateway bun test` | 4168 pass / 0 fail / 2 errors（`# Unhandled error between tests`，本任务文件隔离复跑 0 fail） |
| `packages/shared bun test` | 631 pass / 0 fail（基线 621） |
| `packages/api-client bun test` | 204 pass / 0 fail（基线 201） |
| `packages/app bun test` | 818 pass / 1 skip / 0 fail（基线 798 +1 已知 env fail，本次变为 skip） |
| `bunx biome check <本任务文件>` | 通过 |
| `bun scripts/complexity/gate.ts` | ok。本任务文件：`relay-uplink-client.ts` 600、`relay-uplink-server.ts` 599、`user-store.ts` 957/960、`uplink-client.ts` 681/720。未改 allowlist |

## 需要指挥官处理

1. **KEYLOG 豁免不能在本任务删。** 两处在 scope 外：`apps/gateway/src/hub/hub-authorization.ts` 的 `inspectHubAuthRecordCompat`（`listNodes().length === 0` 放行中继记录）、`apps/gateway/src/mesh/auth-key-log-routes.ts` 的 `refuseUnsupportedHubAuthRecord`（中继模式放行 `rotate-root-keep`）。门禁读的是 `nodes.version` 不是 `peer_cache.version`。要拦「中继对端 cached version 过旧」，需让 compat 检查回落 `peer_cache.version`（G3 拥有 encoding/key-log；hub-authorization 可能要另开任务），然后再删豁免并补拒绝测试。
2. **HTTP redeem 后的 `currentNodes` 推送。** keylog member 路径已 `notifyQuota`。HTTP redeem 在 `apps/gateway/src/relay/relay-routes.ts`（G1），成功后应调 `uplink.notifyQuota(tenant.id)`，否则只靠下次 auth.ok / 配额 PATCH 才会更新占用。
3. **Health probe 未 self-dial。** `probeRelayHealth`（`relay-uplink-http.ts`，由 `uplink-pool` 调用）仍打公网 URL。hairpin NAT 下 `relay,node` 本机探自己的 `/api/relay/health` 可能失败。应在 probe 或 pool 里套 `resolveRelayDialUrl`；`uplink-pool.ts` / `mesh-runtime.ts` 不在本任务 scope。
4. **`RelayRoutes` / `RelayUplinkClient` 的 `dial` 缺省读 `process.env`。** 生产正确；集成测试未注入 `dial`，依赖 env 里没有「本机就是该公网中继」。`mesh-runtime.ts` 是 G3，若要把运行时 roles/`TMEX_RELAY_PUBLIC_URL` 显式注入，需 G3 接线。
5. **G1 的 tenant-store 已有 `countActiveNodes`，本任务直接用。** 并行 G1 还在同一批文件加了 sealed pack 字段；未回滚、未依赖 pack API。
6. **`schema.migration.test.ts` 只有 0041 用例。** 若 G3 要把 0042 的 PRAGMA 断言写进同一文件，需协调，避免互相覆盖。
