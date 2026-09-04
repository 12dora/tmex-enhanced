# G1 结果：本机 relay 角色后端（setup / leave targetRole / local status）

## 做了什么

网页侧五角色切换所需的后端：standalone 可 `POST /api/setup/relay` 进 `relay` / `relay,node`；`/api/local/leave` 可从 `relay,node` 退到 `relay` 或 `standalone`；`/api/local/status` 在含 relay 角色时返回运营快照（不含令牌/哈希）。

### 1. `POST /api/setup/relay`

- 新文件 `packages/app/src/runtime/relay-setup-service.ts`（`becomeRelay`）。`setup-service.ts` 抽出共享件到 `setup-shared.ts`（SetupError、env 锁、assert*），`setup-service.ts` 746 → 555 行，未再膨胀。
- 注册在 `setup-routes.ts`。`assemble-routes.ts` 仍 598 行、未加逻辑；`relayStatus` 接线在 `assemble-relay.ts`（runtime 创建后注入 `routeDeps.relayStatus`）。`assemble.ts` 无需改。
- URL 走 `normalizeRelayUrl`（`@tmex/shared`），失败映射 `invalid_url`。
- Env：`TMEX_ROLES`、`TMEX_RELAY_PUBLIC_URL`、清空 `TMEX_HUB_URL` / `TMEX_HUB_PUBLIC_URL`；`TMEX_RELAY_ADMIN_TOKEN` 保留已有值否则 `generateRelayAdminToken()`。响应永不回令牌。
- `relayPassword`：`hashRelayPassword` + `RelayConfigStore.ensure` / `rotatePassword({kick:false})`，空/null = 无密码只 `ensure`。不写 `app.env`。`relay_config` 行按 runtime 首启同样 `ensure`，重启后 runtime 能捡起。
- `relay,node`：`ensureNodeIdentity` + `bootstrapUserWithSelfAdmit`（冲突 409 `user_exists`），重启后无 uplink。响应带 `fingerprint`。
- 响应：`{ ok, role, relayPublicUrl, hasPassword, restarting: true }`；走 `withSetupTransition`。

### 2. `/api/local/leave` + `targetRole`

- Body `{ expectedRole, targetRole?: 'standalone' | 'relay' }`，默认 `standalone`。
- `relay,node → relay`：`clearMeshMembership()`，保留中继运营表与 `TMEX_RELAY_*`，写 `TMEX_ROLES=relay`。
- `→ standalone`：`clearAll()`（mesh + 中继运营），并**删除** `TMEX_RELAY_PUBLIC_URL` / `TMEX_RELAY_ADMIN_TOKEN`（修 EX1 A3：原先 `STANDALONE_ENV` 只覆盖 hub 键导致泄漏）。
- `node` / `hub,node` 带 `targetRole:'relay'` → 400 `invalid_target`。
- 响应 `{ ok, fromRole, targetRole, restarting: true }`。

`MeshMembershipStore` 拆成 `clearMeshMembership()` / `clearRelayOperatorState()`；`clearAll()` = 两者。中继表：`relay_config`、`relay_tenants`、`relay_nodes`、`relay_enrollments`、`relay_key_log`（计量在 tenants 的 bytes 列，无独立 metering 表）。

### 3. `/api/local/status` relay 块

- `LocalStatus.relay: null | { publicUrl, hasPassword, tenantCount, nodesOnline, currentNodes }`，仅 `roles.relay` 非 null。
- `RelayRuntime.snapshotForLocalStatus()`：`hasPassword` 看 config；`tenantCount` / `currentNodes`（各租户 `countActiveNodes` 之和）走 store；`nodesOnline` 走 uplink registry。
- `SetupServiceDeps.relayStatus?` 可 stub。无 runtime 且角色含 relay 时回空快照（全 0 / `publicUrl` 仍读 env）。

### 4. api-client

- `LocalStatusResponse.relay`（必填，可为 null）
- `SetupRelayRequest/Response`、`SetupApi.setupRelay()`
- `LocalLeaveRequest.targetRole`、`LocalLeaveResponse.targetRole`

### 5. 文档

`docs/relay/2026090304-relay-role.md` §10「网页」段首补了 setup / leave / status 短述。

## 改动文件

**新增**

- `packages/app/src/runtime/relay-setup-service.ts`（139）
- `packages/app/src/runtime/relay-setup-service.test.ts`
- `packages/app/src/runtime/setup-shared.ts`（258）
- `apps/gateway/src/relay/relay-runtime.test.ts`

**修改**

- `packages/app/src/runtime/setup-service.ts`、`setup-service.test.ts`
- `packages/app/src/runtime/setup-routes.ts`、`setup-routes.test.ts`
- `packages/app/src/runtime/membership-reset.ts`、`membership-reset.test.ts`
- `packages/app/src/runtime/local-routes.ts`、`local-routes.test.ts`
- `packages/app/src/runtime/assemble-relay.ts`
- `apps/gateway/src/auth/mesh-membership-store.ts`、`mesh-membership-store.test.ts`
- `apps/gateway/src/relay/relay-runtime.ts`（仅 snapshot + 存 `this.publicUrl`）
- `packages/api-client/src/local/{types,setup-api,local-api}.ts` 及对应 test
- `docs/relay/2026090304-relay-role.md`

**未改（现有 API 够用）**

- `assemble.ts` / `assemble-routes.ts`
- `relay-config-store.ts` / `relay-password.ts` / `relay-tenant-store.ts`

## 测试

- `relay-setup-service.test.ts`：两角色、校验（URL / role / not_standalone / user_exists）、password Argon2id round-trip（`verifyRelayPassword`）、admin token 保留、env 键写入、`relay,node` 用户存在且 `getLocalStatus.role === 'relay,node'`。
- `membership-reset.test.ts`：leave `targetRole` 矩阵（含 invalid_target、standalone 清 relay env）。
- `mesh-membership-store.test.ts`：store 拆分互不误伤。
- `relay-runtime.test.ts`：snapshot 空/有租户。
- `setup-routes` / `local-routes` / `setup-service` / api-client 测试同步。

## 验证

- `packages/app` `bun test`：**816 pass / 1 skip / 0 fail**（基线 798；+18 为本任务）。已知 `scripts/build-runtime.test.ts` env 失败未在本包 `bun test` 发现集里复现为 fail。
- `packages/api-client` `bun test`：**204 pass**（基线 201）。
- `apps/gateway` 隔离：`mesh-membership-store.test.ts` + `relay-runtime.test.ts` **5 pass**。
- `apps/gateway` 全量当时 **4162 pass / 2 fail**，失败不在本任务文件：
  1. `apps/gateway/src/mesh/relay-routes.test.ts`：`join-material` 顶层 `tenantId`（B6）
  2. `apps/gateway/src/mesh/relay-dial.test.ts`：`http://[::1]:9` loopback（其他 agent）
- `tsc`：app/gateway 本任务文件 0 新增错。仓库内 `user-key-service.ts` 缺 `nodeNames`（B5）、api-client `nodesRevoked`（B4）属其他 agent。api-client 基线 5 个 pre-existing tsc 仍在。
- `biome check`：本任务文件已 `--write` 干净。所有触及文件 ≤600 行，未改 complexity allowlist。

未跑 Playwright e2e。

## 需要指挥官处理

1. **`LocalStatusResponse.relay` 现为必填**（可 `null`）。F1 已报 `hub-setup-wizard.test.tsx` fixture 未补 `relay: null`；前端/测试凡构造该类型的都需带上。本任务未改 `apps/fe/**`。
2. 未碰 `apps/gateway/src/mesh/**`、`relay-routes.ts` / `relay-uplink-*.ts` / `relay-admin-routes.ts`、`packages/shared/**`、`apps/fe/**`、`packages/app/src/commands/**`。
3. gateway 全量 2 fail 与 tsc `nodeNames` / `nodesRevoked` 属并行任务，非本 diff。
4. `relay,node` setup 后本机无 uplink；节点拨自己的 relay 由另一任务做（loopback 当 host === `TMEX_RELAY_PUBLIC_URL`）。
