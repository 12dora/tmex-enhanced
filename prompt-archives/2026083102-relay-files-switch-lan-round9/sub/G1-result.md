# G1 结果：file roots 批量重排 API

worktree：`/Users/konata/code/tmex-enhanced-wt-r9`（`feat/round9-relay-files-perf`），未做任何 git 写操作。

## 做了什么

- 新增 `PUT /api/files/roots/order`，body `{ rootIds: string[] }`。
  - 校验：必须是对象；`rootIds` 为非空字符串数组、无重复、无空串；非法 JSON / 非对象 → 400 `{ error: t('apiError.invalidRequest') }`（与同文件其它 file-root 路由一致）。
  - 未知 id 忽略；**一个都没命中**（含空数组）→ 400，不写库、不广播。
  - 成功：`{ roots: FileRootDto[] }`（复用 GET 的 `listRootDtos()`），并 `broadcastSettingsUpdate('file-roots')`。
  - 路由挂在 `PATCH/DELETE /api/files/roots/:id` 之前；鉴权与兄弟路由相同（走同一套 `fileRootRoutes` → `filesRoutes`）。
- `reorderFileRoots(ids): boolean`（`apps/gateway/src/db/file-roots.ts`）：单事务。命中的 id 按给定顺序写成 `0..n-1`，未列出的根保持原相对顺序接在后面并重编号；无命中返回 `false` 且不改写。

语义比 `reorderDevices` 更完整：device 只改 listed 的 `sortOrder`（未列出项可能与 listed 撞号），这里会把未列出项整体接到 listed 之后，避免 `GET` 按 `sortOrder, path` 排序时穿插。

## 文件

- `apps/gateway/src/db/file-roots.ts`（新增 `reorderFileRoots`）
- `apps/gateway/src/api/file-root-routes.ts`（PUT `/api/files/roots/order`）
- `apps/gateway/src/db/file-roots.test.ts`（新建：全量 / 部分列表 / 未知 id / 无命中不写 / 事务）
- `apps/gateway/src/api/file-root-routes.test.ts`（新建：200 顺序 + DTO、部分+未知、400 非法 body）

测试 `afterEach` 会删掉本任务插入的 `file_roots`。共享内存库里该表的 `device_id` 外键（migration `0008`）**没有** `ON DELETE CASCADE`，不清理会让 `default-local-device-seed.test.ts` 的 `DELETE FROM devices` 炸 FK。

## 验证（before → after）

| 目标 | before | after |
|---|---|---|
| `apps/gateway` `bun test` | 2969 pass / 0 fail / 298 files | 2993 pass / 4 fail / 302 files |
| 本任务测试 | — | 8 pass / 0 fail（`file-roots.test.ts` 5 + `file-root-routes.test.ts` 3） |
| `bunx tsc --noEmit -p .` | 21 既有 `error TS` | 22；**owned 文件 0 条** |
| `bunx biome check`（上述 4 文件） | — | 通过 |

全量 4 个 fail 均在其他 agent 的 mesh 文件（`node-list-projection.test.ts`、`peer-manager.test.ts` ×2、`mesh-routes.test.ts`），与本任务无关。文件数 298→302、pass 2969→2993 含本任务 +8 及其它并发 agent 新增。tsc +1 不在 owned 文件（`src/mesh/mesh-runtime.ts`）。未跑 dev server / Playwright。

## 范围外（commander / 其他 agent）

- 未改 `apps/gateway/src/db/index.ts`：`file-root-routes` 本来就从 `../db/file-roots` 直引，不必再导出。
- 未改 `@tmex/api-client` / 前端：调用方需 `PUT /api/files/roots/order` + `{ rootIds }`。
- 未改 `packages/shared` 契约：响应 shape 已是现成的 `ListFileRootsResponse`。
- 未改 `index.routing.test.ts`（现有 `PUT /api/files/roots/:id` 不存在，无冲突）。
- `file_roots.device_id` 迁移 SQL 缺少 `ON DELETE CASCADE`（与 schema.ts 声明不一致）。本任务用测试清理绕过；若要删设备时级联清根，需要新 migration（本任务不能改 drizzle）。
