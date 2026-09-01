# G2 结果 — Hub 授权改为用户签名 key-log（`admit-hub` / `retire-hub`）

## 做了什么

用用户签名的 key-log 记录替代 `TMEX_HUB_PEERS` 作为 hub 授权的权威来源，env 仅作 bootstrap / 回退。威胁模型保持不变：普通 node 不能靠广告自己当 hub。

- **Shared**：`KeyLogType` 末尾追加 `admit-hub` / `retire-hub`（ Borsh `nativeEnum` 只允许 append）。payload 为 `AdmitHubPayload { hub_node_id, public_url?, priority? }`、`RetireHubPayload { hub_node_id }`。签名矩阵均为 `root | passkey`。apply：admit 要求未吊销 node cert（否则 `unknown_node`）；retire 要求已有授权；`revoke-node` 顺带 retired；`rotate-root` 保留授权，`reset-root` 清空。导出 `buildAdmitHubPayload` / `buildRetireHubPayload`、`MIN_HUB_AUTH_RECORD_VERSION = '1.1.13'`、`KEYLOG_TYPE_UNSUPPORTED_BY_NODES`。
- **Gateway 投影**：迁移 `0033_hub_authorizations.sql` 放宽 `user_key_log_type_check`，新建 `user_hub_authorizations`。`persistApplied` 写该表。`UserKeyState.hubAuthorizations` 从投影重建。
- **合并规则**（`apps/gateway/src/hub/hub-authorization.ts`）：signed-active → 授权；signed-retired → 拒绝（压过 env 与 self）；无记录 → `self || TMEX_HUB_PEERS`。uid 由 `resolveMeshUserId` 推导（单用户 / 本机 cert），不硬编码。
- **运行时**：`UplinkServer.isAuthorizedHub`、`hub-replication`、`mesh-runtime` 全部走合并解析。apply 后立即 upsert/drop `mesh_hubs`；retire self 立刻 fence 成 standby。`GET /api/mesh/hubs` 增加可选 `authorization: 'signed' | 'env' | 'self'`（不进 `node.list` 线格式）。
- **兼容门**：写者在 HTTP `POST /api/auth/keylog` 与 uplink `key.log.append` 追加新类型前，若任一未吊销 node 的 version `< 1.1.13` 或空/无法解析，返回 409 `{ code: KEYLOG_TYPE_UNSUPPORTED_BY_NODES, minVersion, nodes }`。HTTP 可用 `X-Tmex-Force-Keylog: 1` 强制并打 warning。已在链上的相同记录 replay 不挡。
- **CLI**：`tmex hub list` AUTH 列为 `signed` / `env` / `self` / `no`。`allow`/`disallow` 仍写 env，并打印签名优先、由 UI 管理的说明。`hub standby` 仍自动把写者写入 env。
- **文档**：`docs/hub/2026090104-multi-hub-standby.md` 授权 allowlist / 已知限制已更新。

`managed-migrations.ts` 同时补上了此前 journal 已有但数组缺失的 `0032_mesh_hubs.sql`。

## 文件

新建：

- `apps/gateway/drizzle/0033_hub_authorizations.sql`
- `apps/gateway/src/hub/hub-authorization.ts`
- `apps/gateway/src/hub/hub-authorization.test.ts`

修改：

- `packages/shared/src/auth/encoding.ts`、`encoding.test.ts`、`key-log.ts`、`key-log.test.ts`、`index.ts`
- `apps/gateway/src/db/schema.ts`、`managed-migrations.ts`、`drizzle/meta/_journal.json`
- `apps/gateway/src/auth/{user-store,user-key-persistence,key-log-store,user-key-service,user-key-service.test,schema.migration.test,index}.ts`
- `apps/gateway/src/hub/{uplink-server,hub-replication,hub-runtime,index}.ts`
- `apps/gateway/src/mesh/{mesh-runtime,auth-routes,mesh-routes}.ts`
- `apps/gateway/src/mesh/integration/{multi-hub-harness,multi-hub.integration.test}.ts`
- `packages/app/src/commands/hub.ts`、`hub.test.ts`
- `docs/hub/2026090104-multi-hub-standby.md`

未改 `HubEndpointInfo` 线格式（`node.list` codec 不变）；authorization 只出现在 HTTP `/api/mesh/hubs`。未写 drizzle `0033_snapshot.json`（migrator 只读 journal + SQL，测试已通过）。

## 测试 / tsc

| 包 | bun test | tsc `--noEmit` |
|---|---|---|
| `packages/shared` | **416 pass / 0 fail**（基线 413，本任务新增） | **0** |
| `apps/gateway` | **3408 pass / 0 fail**（基线 ≈3346；含本任务与其他 agent 新增） | **0** |
| `packages/app` | **643 pass / 1 fail**（基线 629） | **1**（既有：`Cannot find type definition file for 'node'`） |

`packages/app` 失败项与本任务无关：`cpu-features stub plugin > packaged dist/runtime/server.js does not leave cpu-features as an external require`。未改。

Biome：已对变更源文件 `biome check --write`，随后 `biome check` 干净。

集成：`admit-hub` 无 env 即可进入 `hubs[]`（`authorization=signed`）；`retire-hub` 从 `mesh_hubs` 删除；retire self 立即 fence standby；旧版本 node 存在时 HTTP 409，`X-Tmex-Force-Keylog: 1` 可强制。

## 未做 / 留给别人

- FE 签名 UI / checkbox（明确不在 scope）。
- `packages/api-client` 的 `HubEndpointInfo` 类型未加 `authorization`（禁止改该包）；HTTP JSON 已带该字段，FE 可后补。
- drizzle-kit snapshot `0033_snapshot.json` 未生成。
