# G7 result — 取消进行中的升级（下载阶段）并保证磁盘可恢复

## 做了什么

目标节点和入口节点都可以在 **downloading** 阶段 Stop：abort fetch/stream、删掉本次写入的半成品，状态回到 `{state:'idle', targetVersion:null, error:'UPGRADE_CANCELLED'}`。`executing` 不可打断。取消后 FE 刷新仍能从 GET overlay / 本地 status 读到 `UPGRADE_CANCELLED`。

## 契约

`packages/shared/src/contracts/system.ts`：

- `UPGRADE_CANCELLED = 'UPGRADE_CANCELLED'`（FE 按此精确字符串识别）
- `MeshUpgradeErrorCode` 新增：`UPGRADE_CANCEL_UNSUPPORTED` | `UPGRADE_NOT_CANCELLABLE` | `UPGRADE_NOT_RUNNING`

## DELETE 请求 / 响应形状

### 1. 本机目标 `DELETE /api/system/upgrade`

与 POST 相同：managed 构建 / `handleManagedSystemApiRequest` → **403** `{error:'managed_externally', managed:true, canSelfUpdate:false}`。

| 场景 | HTTP | Body |
|---|---|---|
| downloading 取消成功 | 200 | `{ state:'idle', targetVersion:null, error:'UPGRADE_CANCELLED', startedAt }`（`startedAt` 保留） |
| executing | 409 | `{ code:'UPGRADE_NOT_CANCELLABLE', state:'executing', targetVersion, error, startedAt }` |
| idle（含二次取消） | 409 | `{ code:'UPGRADE_NOT_RUNNING', state:'idle', targetVersion:null, error, startedAt }` |

`UpgradeController.cancel()` 返回值：`{ ok:true, status }` 或 `{ ok:false, code:'UPGRADE_NOT_CANCELLABLE'\|'UPGRADE_NOT_RUNNING', status }`。

### 2. 暂存包 `DELETE /api/system/upgrade/package?version=<semver>`

与 PUT 相同认证（mesh forwarded 或已登录 sid+uid；open-mode → 403 `staged_requires_auth`）。

| 场景 | HTTP | Body |
|---|---|---|
| 已暂存 | 200 | `{ ok:true }`（删除 `.tgz` + `.json` sidecar） |
| 无此版本 | 404 | `{ code:'PACKAGE_NOT_STAGED' }` |
| 非法 version | 400 | `{ error }` |
| 未认证 | 403 | `{ code:'UPGRADE_NOT_ALLOWED', reason:'staged_requires_auth' }` |

### 3. 入口 `DELETE /api/mesh/nodes/:id/upgrade`

`NOT_FOUND` / `NODE_LOGIN_REQUIRED` 与 start/status 相同。

| 场景 | HTTP | Body |
|---|---|---|
| 本机节点 | 同 `controller.cancel()`：200 idle / 409 + `nodeId` | `{ state, targetVersion, error, startedAt }` 或 `{ code, ...status, nodeId }` |
| 远程、入口 job 仍在 download/push（或已 cancelled 幂等） | 200 | `{ state:'idle', targetVersion:null, error:'UPGRADE_CANCELLED', startedAt }` |
| 远程、job 已 handoff 或无 job | 转发 `DELETE /api/system/upgrade` | 见下行 |
| 上游 200 | 透传目标 idle status | |
| 上游 409 | 409 | `{ code:'UPGRADE_NOT_CANCELLABLE'\|'UPGRADE_NOT_RUNNING', ...statusFields, nodeId }` |
| 上游 403 | 403 | `{ code:'UPGRADE_NOT_ALLOWED', nodeId }` |
| 上游 404（旧目标无此路由） | **501** | `{ code:'UPGRADE_CANCEL_UNSUPPORTED', nodeId }` |

GET overlay：cancelled job → `{state:'idle', targetVersion:null, error:'UPGRADE_CANCELLED', startedAt}`（保留 10 min，与 failed 相同 TTL）。cancelled **不是** running，随后 `POST` 立即允许（不会 409）。

## 取消路径与磁盘清理

原则：取消后磁盘回到「这次升级开始之前」。已校验过的 `release-cache/*.tgz` + `.sha256` 可留。

| 路径 | 删除什么 | 证明测试 |
|---|---|---|
| 目标 downloading（release 下载） | abort fetch；整个 `staging/<txnId>/`（partial tarball、`.part`、`package/`）；本版本 `release-cache/` 的 `.part` 和**无 sidecar 的**最终 `.tgz`。已有 sidecar 的缓存保留。 | `upgrade.test.ts` `downloading cancel aborts the fetch, removes the txn dir and unverified cache, and reports UPGRADE_CANCELLED` |
| 目标 staged start 仍在 downloading（校验/解压） | txn dir（staged `.tgz` 已 rename 进 txn，随之一起消失）；`staging/staged/` 该版本空 | `upgrade.test.ts` `staged-source cancel while still downloading removes the txn dir (consumed tarball included)` |
| 目标 PUT 体中途 abort | `staging/staged/*.tgz.part-<id>`；目录空 | `upgrade.test.ts` `aborted PUT body deletes the unique .part...`；`aborted PUT over an in-memory link leaves staging/staged empty` |
| 入口 job 取消于 download | abort fetch；`release-cache/tmex-cli-<v>.tgz.part`；不留下无 `.sha256` 的最终 `.tgz` | `remote-upgrade-job.test.ts` `cancel during download removes the cache .part...`；`release-download.test.ts` `aborting an in-flight download removes the .part...` |
| 入口 job 取消于 push | abort 转发 PUT 的 `AbortSignal`；cancel 文件流；目标 handler 把截断 body 当失败并删 `.part-<id>` | `remote-upgrade-job.test.ts` `cancel aborts an in-flight push...` + 上面 in-memory PUT abort |
| 入口 job 取消于 push 已完成、POST `source:'staged'` 之前/之中 | 入口 best-effort `DELETE /api/system/upgrade/package?version=`；旧目标无路由则忽略（warn） | `remote-upgrade-job.test.ts` `cancel after push but before start DELETEs the staged package on the target` |
| 崩溃半取消后下次 start | prune：过期/超量 staged、孤儿 `.part`、无 sidecar 的 staged/cache `.tgz`、idle 时非 `staged`/`release-cache` 的 txn 目录。已校验 cache 保留。 | `upgrade.test.ts` `orphan .part and txn leftovers from a crashed cancel are pruned on the next start` |

竞态：cancel 与 download 收尾抢 mutex。要么完整取消并清理（200 / `UPGRADE_CANCELLED`），要么已 `commitStarted`/`executing` → 409 `UPGRADE_NOT_CANCELLABLE`，不会半写状态。测试：`cancel racing a finishing download is either full cleanup or uncancelled executing`。

二次 cancel 幂等：idle → 409 `UPGRADE_NOT_RUNNING`，磁盘仍干净。cancelled job 再 DELETE → 200 overlay，不转发。

## 实现要点

- `UpgradeController`：`AbortController` + `withLock`；`commitStarted` 在 spawn 前抢锁置位，之后 cancel 视为不可取消。`run()` 把 signal 传给 `stageGithubRelease` / `extractCliTarball`（tar 进程收到 abort 会 SIGTERM）。
- `downloadVerifiedRelease` / `downloadTarballToFile` 接受 `AbortSignal`，与既有 timeout `AbortSignal.any` 合并；abort 时 destroy pipeline 并删 `.part`。rename 后、写 sidecar 前 abort 会清掉无 sidecar 的最终文件。
- `RemoteUpgradeJob` 新状态 `cancelled`；每步 `AbortController`；push 的 file stream 存在 job 上以便立刻 `cancel()`；download 阶段最后一名 waiter abort 共享 inflight 并清 cache `.part`。
- `mesh-routes.ts` 仅扩展 `matchUpgradeNodeRoute` 的 DELETE + `handleUpgradeCancel`。forwarder `signal` 仍运行时透传（未改 `forwardAuthorized` 签名）。

## 测试 / tsc / biome

| 命令 | 结果 |
|---|---|
| `cd apps/gateway && bun test src/system src/api src/mesh/mesh-routes.test.ts` | **638 pass / 0 fail** |
| 本任务相关 7 个文件（upgrade / release-download / remote-upgrade-job / upgrade-service / system / system-managed / mesh-routes） | **211 pass / 0 fail** |
| `cd apps/gateway && bunx tsc --noEmit -p .` | **0 errors** |
| `cd packages/shared && bunx tsc --noEmit -p .` | **0 errors** |
| biome（15 个改动文件） | 干净 |

新增/覆盖用例概览：

- `upgrade.test.ts`：idle / executing / downloading cancel、二次 cancel、staged downloading cancel、竞态、crash prune、PUT abort、in-memory link abort
- `release-download.test.ts`：abort 去掉 `.part`、无 sidecar `.tgz`
- `system.test.ts`：DELETE upgrade 200/409；DELETE package 403/404/200
- `system-managed.test.ts`：DELETE upgrade / package → 403
- `upgrade-service.test.ts`：NOT_FOUND / NODE_LOGIN_REQUIRED、本机 200/409、job cancel overlay、re-POST、handoff 转发、旧目标 501、403
- `remote-upgrade-job.test.ts`：abort mid-push、download 清 `.part`、push 后 DELETE package、handoff 不 handled
- `mesh-routes.test.ts`：DELETE 401/404、job 200 overlay + GET + re-POST、旧目标 501、handoff 转发 409

## 改动文件

- `packages/shared/src/contracts/system.ts`
- `apps/gateway/src/system/upgrade.ts` + `upgrade.test.ts`
- `apps/gateway/src/system/release-download.ts` + `release-download.test.ts`
- `apps/gateway/src/system/remote-upgrade-job.ts` + `remote-upgrade-job.test.ts`
- `apps/gateway/src/system/upgrade-service.ts` + `upgrade-service.test.ts`
- `apps/gateway/src/api/system.ts` + `system.test.ts`
- `apps/gateway/src/api/system-managed.ts`（路径本就匹配所有 method，DELETE 已 403）+ `system-managed.test.ts`
- `apps/gateway/src/mesh/mesh-routes.ts`（仅 upgrade DELETE + `handleUpgradeCancel`）+ `mesh-routes.test.ts` 远程升级用例

未改：`src/hub/**`、`apps/fe/**`、`packages/app/**`、其它 mesh 文件。

## 指挥官无需额外合入

无。`UPGRADE_CANCELLED` 已从 `@tmex/shared` 导出。FE Stop 按钮走 G5/G6 契约即可。

## 风险

- 入口 job 取消共享下载时，仅最后一名 waiter 会 abort 底层 fetch 并清 `.part`；其它节点的 job 继续用同一份下载。
- 目标 `DELETE /api/system/upgrade/package` 对旧节点不存在：入口 best-effort，失败只打 `[mesh][upgrade] cancel staged package failed ...`。
- cancel 与 spawn 窗口：download/extract 完成后、`executing` 之前会置 `commitStarted`，此时 DELETE 已是 409，安装进程不会被杀。
