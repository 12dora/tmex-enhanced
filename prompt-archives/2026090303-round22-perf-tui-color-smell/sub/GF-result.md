# TASK GF 结果（B10 + B13）

## 做了什么

### B10 三个小重复 helper

1. **`decodeB64url`**
   - 新模块 `packages/shared/src/auth/b64url.ts`：在已有 `decodeBase64url`（`encoding.ts`，B9 占用，未改）上加空串/非法输入/`expectedLen` 校验。
   - `apps/gateway/src/api/route-input.ts` 改为 re-export + `requireB64url` 调用共享实现。
   - `apps/gateway/src/hub/uplink-server.ts` 认证签名与 key-log append 的三处 `b64urlToBytes` 改为 `decodeB64url`（catch 不依赖 `UplinkCtlError` 类型，行为不变）。
   - 单测：`packages/shared/src/auth/b64url.test.ts`；`route-input.test.ts` 原断言仍走 re-export。

2. **`identicalKeyLog`**
   - 实现落在 `packages/shared/src/auth/key-log.ts`：decode seq → `list(seq)` → bytes/sig 等值 → `{ seq, hash }`。
   - 实际重复对是 `uplink-server.identicalHeadRecord` ↔ `hub-runtime.identicalForwardedKeyLog`（报告 §3.10）；`mesh-runtime` **没有**这份逻辑。
   - `hub-runtime` 直接调用共享函数；`uplink-server` 因 `handleKeyLogAppend` 行数贴 120 阈值，留了 2 行薄包装 `identicalListed`（比较逻辑只此一处）。
   - 单测加在 `packages/shared/src/auth/key-log.test.ts`。

3. **`resolveUserId`**
   - 规范实现保持 `hub-authorization.resolveMeshUserId`（本就更完整：explicit → cert → node 行 → 唯一 user）。
   - `mesh-runtime.resolveUserId` 删除重复体，改为委托 `resolveMeshUserId`（保留 export，避免外部若再导出断裂）。
   - 在 `hub-authorization.test.ts` 补了 explicit / cert / 无证 node 行 / 多用户歧义。

未改 `packages/shared/src/auth/index.ts`（非本任务占用）：gateway 用相对路径 `'../../../../packages/shared/src/auth/{b64url,key-log}'`。

### B13 `schema.ts` 按域拆分

`apps/gateway/src/db/schema.ts`（原 865 行）改为 6 行 barrel；表定义迁到 `schema/*.ts`。**未改任何 schema importer。**

| 文件 | 行 | 表 |
|---|---:|---|
| `schema/settings.ts` | 181 | siteSettings, gatewayKv, terminalShortcutSettings, tlsConfig, tunnel*, localAuthSettings, nodeAccessPolicy |
| `schema/devices.ts` | 101 | devices 及 runtime/tree/folders/fileRoots（FK 同文件） |
| `schema/messaging.ts` | 90 | webhook / telegram / weixin |
| `schema/agent.ts` | 233 | llmProviders, agent*, watch*（`watchRules` import `devices`） |
| `schema/users-auth.ts` | 142 | users / keys / key-log / sessions / certs / enrollmentTokens |
| `schema/mesh.ts` | 138 | nodes / identity / peerCache / hubTrust / meshHubs / hubRoleTransitions / userHubAuthorizations（import `users`） |
| `schema.ts` barrel | 6 | `export *` |

跨文件 FK 用 `.references(() => importedTable.id)`。运行时 `import * as schema` 仍得到 40 张表。

## 测量

| 项 | 改前 | 改后 |
|---|---|---|
| gateway `tsc --noEmit` | 0 | 0 |
| shared `tsc --noEmit` | 0 | 0 |
| `bun test src/db src/hub src/mesh src/api` | 1406 pass / 23 fail（当时 B14 `@tmex/shared/http` 半成品） | **1834 pass / 0 fail** |
| biome（本任务文件） | — | ok |
| `schema.ts` 行数 | 865 | 6（+ 6 个域文件，最大 233） |

聚焦复跑：`route-input` + `hub-authorization` + `hub-runtime` + `uplink-server` → 92 pass / 0 fail。shared helper 测试 33 pass。

## Drizzle

- `drizzle-kit check`：`Everything's fine`。
- `drizzle-kit generate` 产出了 `0039_sturdy_toro.sql`：内容是 **CREATE 已在 0033–0038 存在的表**（`node_access_policy` / `hub_role_transitions` / `user_hub_authorizations`）以及若干 sqlite CHECK 重建。原因是 `meta/` 快照只到 **0032**，与 SQL 迁移 0038 不同步——**拆表前 generate 也会出这份假 diff**，不是 schema 语义变化。
- 已删除 `0039_sturdy_toro.sql`、`meta/0039_snapshot.json`，并还原 `_journal.json`。当前仍 39 个 SQL、check 通过。

## 复杂度门禁

本任务占用文件 **无违规**（`handleKeyLogAppend` 曾因 4 行调用涨到 122，已用 `identicalListed` 压回阈值内）。

全仓 `bun scripts/complexity/gate.ts` 仍 fail：**7 违规 + 1 stale**，全部在 ghostty-terminal / terminal-ui（并行任务占用），未改。

## 未做 / 注意

- 未改 `encoding.ts` / `auth/index.ts` / `codec.ts` / `drizzle.config.ts`（非占用文件）。
- 为补 `resolveMeshUserId` 用例改了 `hub-authorization.test.ts`（源文件测试，非 schema importer）。
- `identicalKeyLog` 的第二调用方按代码是 `uplink-server`，不是 prompt 里写的 `mesh-runtime`。
