# 设备文件夹后端执行结果

## 改动文件

新建：

- `apps/gateway/src/db/device-folders.ts`：layout / CRUD / replace / 删设备清 placement
- `apps/gateway/src/db/device-folders.test.ts`（5）
- `apps/gateway/src/api/device-folder-routes.ts`：`/api/device-folders` REST
- `apps/gateway/src/api/device-folder-routes.test.ts`（13）
- `packages/api-client/src/device-folders.ts`
- `apps/gateway/drizzle/0024_narrow_tomas.sql`
- `apps/gateway/drizzle/meta/0024_snapshot.json`（drizzle-kit 生成）

修改：

- `apps/gateway/src/db/schema.ts`：`device_folders`、`device_folder_placements`
- `apps/gateway/drizzle/meta/_journal.json`
- `apps/gateway/src/db/managed-migrations.ts`：追加 `'0024_narrow_tomas.sql'`
- `apps/gateway/src/db/index.ts`：re-export
- `apps/gateway/src/api/index.ts`：`deviceFolderRoutes` 接在 `deviceRoutes` 之后
- `apps/gateway/src/api/device-routes.ts`：`handleDeleteDevice` 成功后 `removeDeviceFolderPlacementsForDevice(id)`
- `apps/gateway/src/settings/broadcaster.ts`：`SettingsNamespace` 增加 `'device-folders'`
- `packages/api-client/src/index.ts`：`export * from './device-folders'`

`packages/app` 无硬编码 migration 清单（`bundle-resources.sh` / `build-managed.ts` 整目录拷贝 drizzle），只改了 gateway 的 `MIGRATIONS`。

## Migration

文件名：`0024_narrow_tomas.sql`

drizzle-kit 原产物把 `device_folder_placements` 写在 `device_folders` 前面（FK 会失败），已手工调换建表顺序；snapshot 未手写。

## REST

| 方法 | 路径 | 成功 |
|---|---|---|
| GET | `/api/device-folders` | 200 `DeviceFolderLayout` |
| POST | `/api/device-folders` | 201 `{ folder }` |
| PUT | `/api/device-folders/layout`（注册在 `/:id` 前） | 200 `DeviceFolderLayout` |
| PATCH | `/api/device-folders/:id` | 200 `{ folder }` |
| DELETE | `/api/device-folders/:id` | 200 `{ success: true }` |

写操作后 `broadcastSettingsUpdate('device-folders')`。校验一律走 `@tmex/shared` 的 `validateDeviceFolderName` / `wouldCreateFolderCycle` / `isFolderForestValid` / `reparentOnFolderDelete` / `normalizeFolderLayoutOrder` / `deviceFolderItemKey`。

## 测试 / tsc

- `cd apps/gateway && bun test src/`：**2466 pass / 0 fail**（基线 2448，本任务新增 18）
- gateway `bunx tsc --noEmit -p .`：`error TS` **21 → 21**（未增加；本任务文件 0 条）
- `packages/api-client` `bunx tsc --noEmit -p .`：本任务文件无错误；`src/client.test.ts`、`src/files-download.test.ts` 仍有既有错误（未改这些文件）
- 已对改动源文件跑 `biome check --write`（不含 drizzle 生成物）

## 未尽事项

- `packages/panels` 的 `settings-events-init.test.tsx` 会扫 gateway `SettingsNamespace` 全集；前端需把 `'device-folders'` 映射到 `deviceFoldersQueryKey`，否则该测试会红（交给并行前端代理）。
- 安装版 / managed embed 要等正式 `bundle:resources` / `build:managed` 才会带上 `0024_narrow_tomas.sql`（与 0021–0023 相同）。
- 浏览器实测不在本任务范围。
