# G3 结果 — 远程 hub 角色切换 API（`POST /api/hub/role`）

## 做了什么

目标 hub 新增带持久化过渡的角色切换接口。FE 仍走现有 `/n/<hubNodeId>/api/...` 转发器，无需新协议。

- **路由**（`withAuth`，与 `/api/hub/nodes/*` 相同）：
  - `POST /api/hub/role` body `HubRoleRequest` → 202 `HubRoleTransition`。校验：非 hub 安装 `HUB_NOT_HUB` 409；`operationId` UUID-ish 否则 `INVALID_REQUEST` 400；同一 operationId 幂等 200；同时只允许一条 in-flight（`HUB_ROLE_BUSY` 409）；`mode=active` 要求 `writerEpoch > max(env/config epoch, 全部 mesh_hubs epoch)` 否则 `HUB_EPOCH_STALE` 409；self 未授权（含签名 `retire-hub`）`HUB_NOT_AUTHORIZED` 409。无 `patchHostEnv` 的独立 gateway 进程 `HUB_ROLE_UNSUPPORTED` 409。
  - `GET /api/hub/role/status?operationId=` 回读指定过渡；无 id 回读最新；缺失 404。
- **执行顺序**：落库 `accepted` → `persisting`：原子写 `TMEX_HUB_MODE`（active 同时写 `TMEX_HUB_WRITER_EPOCH`）→ 更新本机 `mesh_hubs` 并立刻 `UplinkServer.applyLocalRole()`（demote 立即停写）→ `restarting`：约 1 s 后 `RuntimeController.requestRestart()`（与 `POST /api/settings/restart` 同路径）。下次启动若最新过渡 in-flight 且 env/config 与目标一致 → `complete`，否则 `failed`。
- **表** `hub_role_transitions`（managed 迁移 `0034_hub_role_transitions.sql`），不受 `mesh_hubs.replaceAll()` 影响。
- **注入**：`packages/app` assemble 把 `readEnvFile`/`writeEnvFile`/`withEnvLock` 封装成 `patchHubRoleEnv`，并把 `runtimeController.requestRestart` 延迟调度注入 HubRuntime。测试用 fake。
- **CLI**：`tmex hub promote/demote` 在 DB 可写时 best-effort 插入 `phase=restarting` 行；`tmex hub list` 打印 `role-transition <phase> <operationId>`。
- **文档**：`docs/hub/2026090104-multi-hub-standby.md` 增加「远程切换（UI）」：API 序列与顺序规则（A 可达先 demote 再 promote；否则靠更高 epoch fence）。

## 入口 404/405 映射（给 FE）

目标 hub 回答 **404/405** 时，入口/FE 应映射为 **`HUB_ROLE_UNSUPPORTED`**（旧版本没有该接口）。本任务未改 `apps/fe` 与 `apps/gateway/src/mesh/forwarder.ts`。

未在 `GET /api/mesh/hubs` 上暴露 `roleTransition`（可选；需改 mesh-routes，不在 scope）。

## 文件

新建：

- `apps/gateway/drizzle/0034_hub_role_transitions.sql`
- `apps/gateway/src/hub/hub-role-routes.ts`
- `apps/gateway/src/hub/hub-role-routes.test.ts`
- `apps/gateway/src/hub/hub-role-transitions.ts`

修改：

- `apps/gateway/drizzle/meta/_journal.json`
- `apps/gateway/src/db/schema.ts`、`managed-migrations.ts`
- `apps/gateway/src/hub/{hub-runtime,uplink-server,index}.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts`
- `apps/gateway/src/mesh/integration/{multi-hub-harness,multi-hub.integration.test}.ts`
- `packages/app/src/runtime/assemble.ts`
- `packages/app/src/commands/hub.ts`、`hub.test.ts`
- `docs/hub/2026090104-multi-hub-standby.md`

未写 drizzle `0034_snapshot.json`（migrator 只读 journal + SQL）。

## 测试 / tsc

| 包 | bun test | tsc `--noEmit` |
|---|---|---|
| `apps/gateway` | **3438 pass / 0 fail** | **0** |
| `packages/app` | **644 pass / 1 fail** | **1**（既有：`Cannot find type definition file for 'node'`） |

`packages/app` 失败项与本任务无关：`cpu-features stub plugin > packaged dist/runtime/server.js does not leave cpu-features as an external require`。未改。

Biome：已对变更源文件 `biome check --write`，随后 `biome check` 干净。

路由单测覆盖：校验矩阵、幂等、busy、stale epoch、retire-self 未授权、env 写入 + mesh_hubs + 1s restart fake、status 回读、启动 complete/failed、迁移表存在。

集成：harness 注入内存 env patch / restart fake；API demote A + promote B → takeDown A 后 C/D 挂到 B；用旧 epoch 重建 A → `starting fenced`。Harness 没有真实 `/healthz`，因此 C/D 切写者靠 failover 而非 failback probe。

## 未做 / 留给别人

- FE「切换」按钮、`HubApi.role()`、404/405 → `HUB_ROLE_UNSUPPORTED` 映射。
- `GET /api/mesh/hubs` 的 `roleTransition` 字段。
- drizzle-kit snapshot `0034_snapshot.json`。
