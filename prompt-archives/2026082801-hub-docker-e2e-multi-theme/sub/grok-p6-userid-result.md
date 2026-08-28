# grok-p6-userid 执行结果

日期：2026-08-28。工作区 `tmex-enhanced-wt-merge`（`chore/merge-hub-tabs`），无 git 操作。未改 `peer-manager.ts` / `link-mux*`。

落地 p4 Finding 6：`hub join` 把节点 `userId` 写进 `node_identity`，`assembleTmex` 启动 mesh 时把它当作 `createMeshRuntime` 的 explicit `userId`。`hub user add` 自 admit 与 `mesh reset-root` 同样写/保留该列。`resolveUserId` 的 self-cert → 唯一 user 回退未改，给旧库用。

## 改动摘要

| 位置 | 处理 |
|---|---|
| `apps/gateway/src/db/schema.ts` | `nodeIdentity.userId: text('user_id')`（可空，无 FK） |
| `apps/gateway/drizzle/0020_node_identity_user.sql` | drizzle-kit generate：`ALTER TABLE \`node_identity\` ADD \`user_id\` text;`（SQLite 可空，已有行保持 NULL） |
| `NodeIdentityRecord` / `SaveNodeIdentityInput` / load\|save | 读写 `userId` |
| `UserKeyService.commitJoin` | `persistEncryptedIdentity` 一并写入 `user_id` |
| `UserKeyService.bootstrapUserWithSelfAdmit` | 同一事务 `UPDATE node_identity SET user_id`（`hub user add` / `mesh reset-root` 都走这里） |
| `packages/app/.../hub.ts` `commitVerifiedJoin` | identity 带 `userId: genesisUid`，成功后再 `identityStore.save({ ...loaded, userId: genesisUid, hubUrl })` |
| `packages/app/.../assemble.ts` | `userId: (await identityStore.load())?.userId ?? undefined` 传给 `createMeshRuntime` |

`ensureNodeIdentity` 新建行时 `userId: null`。`persistHubUrl`（join/leave）spread 已加载记录，不会把 `user_id` 抹掉。

## 测试（先红后绿）

| 测试 | 覆盖 |
|---|---|
| `0020 adds nullable user_id on node_identity so pre-existing rows stay valid` | 迁移可空；无 `user_id` 的 INSERT 仍合法 |
| `save/load round-trips userId and preserves it across hubUrl-only updates` | store 持久化；hubUrl 更新不丢 userId |
| `commitJoin writes user, log, certs and identity in one shot`（补断言） | join 事务写入 `userId` |
| `bootstrapUserWithSelfAdmit commits genesis and admit-node together`（补断言） | hub 自 admit 写 `user_id` |
| `bootstrapUserWithSelfAdmit reset keeps username...`（补断言） | reset-root 保留同一 `userId` |
| `hub user add writes genesis...`（补断言） | CLI 自 admit |
| `hub join against fake hub`（补断言） | `commitVerifiedJoin` 持久化 genesisUid |
| `mesh reset-root`（补断言） | 重置后 identity.userId 仍是原用户 |
| `passes persisted identity userId to createMeshRuntime` | assemble → mesh explicit userId |

## 数字

| 检查 | 结果 |
|---|---|
| `bun test`（`apps/gateway`） | **2272 pass / 0 fail**（p4 基线 2263；本轮 +2 新用例，其余增量来自并行 agent） |
| `bun test`（`packages/app`） | **240 pass / 0 fail**（基线 239 + assemble 1） |
| `bunx tsc --noEmit -p apps/gateway` | **21** 个 `error TS`（基线 ≤ 21） |
| `bunx tsc --noEmit -p packages/app` | **1** 个 `error TS`（基线 ≤ 1） |
| `bunx biome check`（改动 ts） | 通过 |
| `bunx drizzle-kit generate` | **No schema changes, nothing to migrate** |

## Harness（remote-cycle tag `p6`）

第一次 pack 时 `remote-cycle.sh` 只跑 `build:runtime` / `build:cli`，**不**跑 `bundle:resources`，`resources/gateway-drizzle` 仍停在 0019。runtime 已 INSERT `user_id`，hub 启动报 `table node_identity has no column named user_id`。本地补了 `bun run bundle:resources` 后再 pack。

第二次（有效）`scripts/hub-e2e/out/report.md`（远程 2026-08-28T07:34:50Z）：

| scenario | result |
|---|---|
| 1a–1c | PASS |
| 2a–2c | PASS |
| 3a–3g | PASS |
| 4a / **4b** / **4c** / 4d | PASS |
| 5 | PASS |
| **6a** / **6b** / 6c | PASS |
| 7a–7b | PASS |
| **8** | PASS |

全 PASS。日志在 `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/741cc3a1-5392-48be-8081-06f3803bdeb4/scratchpad/remote-out-p6/`。
