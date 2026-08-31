# C4 结果：Mesh remote-upgrade 评审 follow-up

对照 `RV2-result.md` 的 4 项 Should-fix + 1 项 Nit，全部落地。未改 `apps/fe/**`、`packages/panels/src/agent/**`、`apps/gateway/src/mesh/forwarder.ts`。

## 1. 本机路径 403/409 优先于 GitHub latest

`handleMeshNodeUpgradeStart` 在本机路径上，于 `requireLatestUpgradeRelease()` **之前**做预检：

- `canSelfUpdate === false` → `403 UPGRADE_NOT_ALLOWED`（GitHub 502 / already-latest 不再抢答）
- 控制器 `status().state !== 'idle'` → `409 UPGRADE_IN_PROGRESS`（附带当前 status 字段）

GitHub 解析成功后仍走 `startLocalMeshUpgrade` → `startLocalUpgradeAttempt` → `upgradeController.start()`，原子并发检查保留。预检拒绝时不调用 `start()`。

覆盖：`canSelfUpdate=false` + GitHub 502 仍 403；busy + GitHub 502 仍 409 且 `start()` 未调用（`upgrade-service.test.ts`、`mesh-routes.test.ts`）。

## 2. SemVer 正确的 prerelease 比较

`apps/gateway/src/system/semver.ts` 的 `compareVersions` 按 SemVer 2.0 逐段比较 prerelease：纯数字标识符按数值；数字标识符低于非数字；标识符更少的预发布版更低；有 prerelease 低于同核心版本的正式版。

`1.2.3-beta.2` < `1.2.3-beta.10` < `1.2.3`。`isAlreadyAtOrAboveLatest('1.2.3-beta.2', '1.2.3-beta.10')` 现为 `false`。

## 3. 409 正文白名单

`mapForwardedUpgradeResponse` 映射远程 409 时只复制 `state` / `targetVersion` / `error` / `startedAt`（`state` 须为 idle|downloading|executing；后三者须为 `string | null`）。`jsonError` 的 `code` 与本地 `nodeId` 后写，上游无法覆盖。伪造 `code: UPGRADE_ALREADY_LATEST` / `nodeId: spoof` / 其它字段会被丢掉。

## 4. 有界、失败关闭的远程正文

`upgrade-service.ts` 自带 64KB `readBodyLimited`，不再对远端 info/409 调用 `Response.json()`。

- 403/404 替换成本地响应前 `body.cancel()`，打断 stream-targets 的持续入队。
- 409 超限/无法解析 → 仍返回 `UPGRADE_IN_PROGRESS` + `nodeId`，不带不可信 extra。
- `GET /api/system/info` 为 200 但正文超限、截断、无法解析、或非对象 → `503 NODE_UNREACHABLE`，**不发**破坏性 POST。

## 5. Nit：`NOT_FOUND` 入契约

`packages/shared/src/contracts/system.ts` 的 `MeshUpgradeErrorCode` 增加 `'NOT_FOUND'`。未登记/已撤销仍返回 `404 { code: 'NOT_FOUND', nodeId }`。客户端 i18n 映射按文件所有权未改（`apps/fe/**`）。

## 改动文件

- `apps/gateway/src/system/upgrade-service.ts`
- `apps/gateway/src/system/upgrade-service.test.ts`
- `apps/gateway/src/system/semver.ts`
- `apps/gateway/src/system/semver.test.ts`（新）
- `apps/gateway/src/mesh/mesh-routes.test.ts`
- `packages/shared/src/contracts/system.ts`

## 验证

| 命令 | 结果 |
|---|---|
| `cd apps/gateway && bun test src/mesh src/system src/api` | **1040 pass / 0 fail**（86 files） |
| `bunx tsc --noEmit -p .` | **21** 条 `error TS`（无新增；均不在本次改动文件） |
| `bunx biome check`（上列 6 个文件） | clean |
| `bun scripts/complexity/gate.ts` | ok（1113 files, 9315 functions） |
