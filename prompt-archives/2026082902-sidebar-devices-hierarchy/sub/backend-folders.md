# 任务：设备文件夹（device folders）后端——schema / migration / DB helper / REST 路由 / api-client

你在 git worktree `/Users/konata/code/tmex-enhanced-wt-merge`（分支 `chore/merge-hub-tabs`）里工作。**其他代理正在同一 worktree 里并行改前端文件**（`apps/fe/**`、`packages/panels/**`、`packages/stores/**`、locale JSON），你只能改下面「文件范围」里的文件；**禁止执行任何 git 命令**（不要 add/commit/stash/checkout/reset）。运行时是 Bun（`~/.bun/bin/bun`，若 PATH 里没有先 `export PATH="$HOME/.bun/bin:$PATH"`）。先读 `AGENTS.md`（项目规则，具有约束力）。macOS 没有 `timeout` 命令；`bun test` 输出带 ANSI 色，用 `sed 's/\x1b\[[0-9;]*m//g'` 清洗。

## 背景
设备管理页要支持「文件夹」层级：文件夹任意嵌套；条目（mesh 节点 或 单台设备）通过 placement 放进某个文件夹。数据只存在**提供 UI 的节点自己的库**里。契约与纯逻辑**已经写好**，你必须直接复用，不要重写：

- 契约：`packages/shared/src/contracts/device-folders.ts`（`DeviceFolder`、`DeviceFolderPlacement`、`DeviceFolderLayout`、`CreateDeviceFolderRequest`、`UpdateDeviceFolderRequest`、`UpdateDeviceFolderLayoutRequest`、`DEVICE_FOLDER_NAME_MAX_LENGTH`、`DEVICE_FOLDER_SELF_NODE_ID='self'`），已从 `@tmex/shared` 主入口导出。
- 纯逻辑：`packages/shared/src/device-folders.ts`（`validateDeviceFolderName`、`wouldCreateFolderCycle`、`isFolderForestValid`、`reparentOnFolderDelete`、`normalizeFolderLayoutOrder`、`deviceFolderItemKey`、`sameDeviceFolderItem` 等），已导出，测试在 `device-folders.test.ts`。**gateway 校验一律调用这些函数**，保证与前端一致。
- i18n key 已加好（`apiError.folderNotFound`、`apiError.folderNameRequired`、`apiError.folderNameTooLong`、`apiError.folderCycle`、`apiError.folderLayoutInvalid`，另有已存在的 `apiError.invalidRequest`），gateway 用 `import { t } from '../i18n'` 取文案。**不要改 locale JSON / resources.ts / types.ts**。

先阅读这些既有文件了解模式：`apps/gateway/src/db/schema.ts`、`apps/gateway/src/db/devices.ts`、`apps/gateway/src/db/index.ts`、`apps/gateway/src/db/managed-migrations.ts`、`apps/gateway/src/db/migrate.ts`、`apps/gateway/drizzle/meta/_journal.json`、`apps/gateway/src/api/device-routes.ts`、`apps/gateway/src/api/route.ts`、`apps/gateway/src/api/http.ts`、`apps/gateway/src/api/index.ts`、`apps/gateway/src/api/tree-order.test.ts`（路由测试写法）、`apps/gateway/src/api/index.routing.test.ts`、`packages/api-client/src/devices.ts`、`packages/api-client/src/index.ts`。

## 文件范围（只准改/建这些）
- `apps/gateway/src/db/schema.ts`（追加两张表）
- `apps/gateway/drizzle/0024_*.sql` + `apps/gateway/drizzle/meta/*`（由 `cd apps/gateway && bun run db:generate` 生成，不要手写 snapshot；生成后检查 SQL 内容正确）
- `apps/gateway/src/db/managed-migrations.ts`（把新 migration 文件名追加到 `MIGRATIONS`）
- 新建 `apps/gateway/src/db/device-folders.ts` + `apps/gateway/src/db/device-folders.test.ts`
- `apps/gateway/src/db/index.ts`（re-export）
- 新建 `apps/gateway/src/api/device-folder-routes.ts` + `apps/gateway/src/api/device-folder-routes.test.ts`
- `apps/gateway/src/api/index.ts`（注册路由，放在 `deviceRoutes` 之后）
- `apps/gateway/src/api/device-routes.ts`：仅在 `handleDeleteDevice` 成功删除后调用 `removeDeviceFolderPlacementsForDevice(id)`（self 设备被删时清掉 `device:self:<id>` 的 placement）
- `apps/gateway/src/settings/broadcaster.ts`：`SettingsNamespace` 追加 `'device-folders'`，每次写操作后 `broadcastSettingsUpdate('device-folders')`
- 新建 `packages/api-client/src/device-folders.ts`，并在 `packages/api-client/src/index.ts` 里 `export * from './device-folders'`
- 若 `packages/app`（CLI 安装版）有一份 migration 清单/拷贝脚本需要同步（grep `0023_acme_account_directory` 全仓确认），一并更新。

## Schema（Drizzle，sqlite）
```ts
export const deviceFolders = sqliteTable('device_folders', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  parentId: text('parent_id'),            // 自引用，不加 FK（删除时手动上提子项）；加 index
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
export const deviceFolderPlacements = sqliteTable('device_folder_placements', {
  itemKey: text('item_key').primaryKey(), // `node:<nodeId>` 或 `device:<nodeId>:<deviceId>`，用 shared 的 deviceFolderItemKey 生成
  kind: text('kind').notNull(),           // check in ('node','device')
  nodeId: text('node_id').notNull(),
  deviceId: text('device_id'),            // kind='node' 时 null
  folderId: text('folder_id').references(() => deviceFolders.id, { onDelete: 'cascade' }), // null = 根层显式排序
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
```
（folder_id 加 index。placement 的 cascade 只是兜底；DELETE 路由必须先用 `reparentOnFolderDelete` 算出新布局、写回后再删文件夹行，确保「删文件夹不丢内容」。）

## DB helper（`apps/gateway/src/db/device-folders.ts`）
- `getDeviceFolderLayout(): DeviceFolderLayout`（folders 按 parent、sortOrder；placements 按 folderId、sortOrder）
- `createDeviceFolder(input: { id, name, parentId }): DeviceFolder`（sortOrder = 同父下最大值+1）
- `updateDeviceFolder(id, patch: { name?, parentId?, sortOrder? }): DeviceFolder | null`
- `deleteDeviceFolder(id): boolean`（事务：`reparentOnFolderDelete` → 写回 folders 的 parentId/sortOrder 与 placements 的 folderId/sortOrder → 删行）
- `replaceDeviceFolderLayout(layout: UpdateDeviceFolderLayoutRequest): DeviceFolderLayout`（事务：更新每个 folder 的 parentId/sortOrder；placements 整体 delete + insert；结果经 `normalizeFolderLayoutOrder` 后落库）
- `removeDeviceFolderPlacementsForDevice(deviceId)`（删 `nodeId='self' && deviceId=?` 的行）
- `getDeviceFolderById(id)`
全部同步（bun:sqlite + drizzle，与 devices.ts 一致）。

## REST（`/api/device-folders`，全部 JSON，错误体 `{ error: string }`）
- `GET /api/device-folders` → 200 `DeviceFolderLayout`
- `POST /api/device-folders` body `CreateDeviceFolderRequest` → 201 `{ folder }`；名字经 `validateDeviceFolderName`：empty→400 `apiError.folderNameRequired`，tooLong→400 `apiError.folderNameTooLong`；parentId 非 null 且不存在→404 `apiError.folderNotFound`；id 用 `crypto.randomUUID()`
- `PATCH /api/device-folders/:id` body `UpdateDeviceFolderRequest` → 200 `{ folder }`；不存在→404；name 校验同上；parentId 改动时 `wouldCreateFolderCycle`→400 `apiError.folderCycle`，目标不存在→404；改 parent 时 sortOrder 未给则排到新父末尾
- `DELETE /api/device-folders/:id` → 200 `{ success: true }`；不存在→404
- `PUT /api/device-folders/layout` body `UpdateDeviceFolderLayoutRequest` → 200 `DeviceFolderLayout`；校验：body 结构（用 `readJsonObjectBody` + 手写字段检查，不引入校验库）；`folders` 的 id 集合必须与库中完全一致，否则 400 `apiError.folderLayoutInvalid`；`isFolderForestValid` 失败→400 `apiError.folderCycle`；每个 placement：kind ∈ {node,device}，nodeId 非空字符串，kind=device 时 deviceId 非空、kind=node 时 deviceId 必须为 null，folderId 为 null 或存在的文件夹 id，sortOrder 为整数；同一 itemKey 重复→400 `apiError.folderLayoutInvalid`。
- 路径顺序：`/api/device-folders/layout` 的 PUT 要在 `/:id` 之前注册，避免被 `:id` 吃掉（参考 `/api/devices/order`）。
- 写操作后 `broadcastSettingsUpdate('device-folders')`。

## api-client（`packages/api-client/src/device-folders.ts`）
风格照 `devices.ts`（注入 `ApiClient`，`parseApiError` 兜底文案）：
```ts
export const deviceFoldersQueryKey = ['device-folders'] as const;
export async function fetchDeviceFolderLayout(client = defaultApiClient): Promise<DeviceFolderLayout>
export async function createDeviceFolder(body: CreateDeviceFolderRequest, errorFallback?, client?): Promise<DeviceFolder>
export async function updateDeviceFolder(id: string, body: UpdateDeviceFolderRequest, errorFallback?, client?): Promise<DeviceFolder>
export async function deleteDeviceFolder(id: string, errorFallback?, client?): Promise<void>
export async function replaceDeviceFolderLayout(body: UpdateDeviceFolderLayoutRequest, errorFallback?, client?): Promise<DeviceFolderLayout>
```

## 测试
- `db/device-folders.test.ts`：建、改、删（子项上提）、replace layout、removeForDevice。
- `api/device-folder-routes.test.ts`：照 `tree-order.test.ts` 的 `dispatchRoutes` 写法覆盖：创建成功/空名/超长名；PATCH 成环 400；PATCH 改名；DELETE 子文件夹与 placement 上提到父级；PUT layout 成功、id 集合不一致 400、成环 400、非法 placement 400；GET 形态；通过 `handleApiRequest` 的 `/api/device-folders` 路由可达（参考 `index.routing.test.ts`）。
- 完成标准：`cd apps/gateway && bun test src/`：**基线 2448 pass / 0 fail**，你新增的全部通过、无新失败；`bunx tsc --noEmit -p .` 的错误数不高于基线（基线已有若干与你无关的既有错误，先记录 `bunx tsc --noEmit -p . | grep -c "error TS"` 的数量，改完后不增加）；`cd packages/api-client && bunx tsc --noEmit -p .` 通过；对你改动的文件跑 `bunx biome check --write <files>`。**不要对 drizzle 生成物、i18n 生成物跑 biome。**
- 单测里 DB 是 `:memory:`（preload 设置），`runMigrations()` 会应用 drizzle 目录下全部 migration，包括你新生成的。

## 交付
把最终报告写到 `prompt-archives/2026082902-sidebar-devices-hierarchy/sub/backend-folders-result.md`（简体中文，简洁）：改了哪些文件、migration 文件名、测试数量、tsc 错误数对比、未尽事项。除非做完（或确实卡死无法推进）不要写这个文件。
