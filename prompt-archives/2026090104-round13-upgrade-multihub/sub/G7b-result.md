# G7b result — RV5 取消竞态（backend）

按 TDD 修了 RV5-1/2/3/4/6。硬约束：Stop 之后不得留下半下载/半暂存垃圾；目标仍在升级时不得报告「已取消」。

## 按 finding 的修复与证明测试

### RV5-1 PUT 已落盘、ACK 未到

**根因**：`job.pushed` 只在 PUT Promise 返回后置位；cancel 在 ACK 窗口 abort 后跳过 DELETE。目标侧 `removeStagedPackage` 不与同版本 in-flight PUT 串行，PUT 未 rename 时 DELETE 会 404。

**修复**：
- 入口 `cancelRemoteUpgradeJob`：push 阶段 abort PUT，**await PUT promise settle**，然后始终 `DELETE /api/system/upgrade/package?version=`（404 = 无包，幂等）。
- 目标 `UpgradeController`：`stagePackage` 登记 `stagingVersion` + `stagingDone`；同版本 DELETE 先等 PUT 结束（成功或失败），再删已落盘文件——PUT 中途不得 404。

**证明**：
- `upgrade.test.ts` `DELETE package waits for an in-flight PUT of the same version then removes what landed`
- `remote-upgrade-job.test.ts` `cancel after PUT landed but before ACK DELETEs the staged package`（目标 `stagePackage` 完成后挂起 ACK，cancel 后 `staging/staged/` 为空）

### RV5-2 cancel 与 staged POST handoff 竞态

**根因**：start 阶段把 job.abort 接到 POST 上；目标已 2xx 接受后 Stop 会 abort transport、DELETE 已不存在的 staged 包、overlay 报 `UPGRADE_CANCELLED`，目标继续 installing。

**修复**：一旦 `job.startPromise` 已发出，cancel **不 abort POST**；await start 响应：
- 2xx → 标 `handed-off`，`handled: false`，由 `handleMeshNodeUpgradeCancel` 转发 `DELETE /api/system/upgrade` 并**透传目标结果**
- 非 2xx → DELETE package，标 cancelled

overlay 只有在确认目标未在跑时才是 `UPGRADE_CANCELLED`。

**证明**：
- `remote-upgrade-job.test.ts` `cancel during staged POST does not abort it; 2xx hands off and is not UPGRADE_CANCELLED`
- `remote-upgrade-job.test.ts` `cancel during staged POST that fails cleans up as a cancelled job`
- `upgrade-service.test.ts` `cancel racing a slow staged POST forwards DELETE and returns 200 when the target is still downloading`
- `upgrade-service.test.ts` `cancel racing a slow staged POST returns 409 when the target is executing`

### RV5-3 共享 download inflight + abort

**根因**：`downloadVerifiedRelease` inflight 只保留第一个 caller 的 signal；`remote-upgrade-job` 另有一套 ref-count。本机升级与远端 job 同版本时会互相 abort / 误删 `.part`。

**修复**：waiter/ref/abort 全部收进 `release-download.ts` 的 cache-key inflight：
- 每个 caller 注册自己的 signal；abort 只拒绝该 caller
- **最后一个** caller 离开才 abort 底层 fetch，并在该 caller 的 promise reject 前删 `.part`
- 远端 job 去掉重复 ref-count，直接把 `job.abort.signal` 传给 `downloadVerifiedRelease`

**证明**：
- `release-download.test.ts` `aborting the first of two shared callers does not fail the second`
- `release-download.test.ts` `aborting every shared caller aborts the fetch and removes the .part`
- `remote-upgrade-job.test.ts` `cancelling a remote job does not abort a shared local download`
- `remote-upgrade-job.test.ts` `two nodes share one download`（改为走同一 inflight 层）

### RV5-4 crash 后孤儿 sidecar

**根因**：staged start 先 `rename` `.tgz` 再异步删 `.json`；崩溃后 `pruneOrphanStagedFiles` / `loadStagedFromDisk` 不删无 tarball 的 sidecar。

**修复**：先删 `.json` 再 `rename` `.tgz`。`loadStagedFromDisk` 遇到 sidecar 指向缺失文件时 `rmSync` 掉 sidecar；`pruneOrphanStagedFiles` 同样删除无 `.tgz` / 未登记的 `.json`（无 sidecar 的 `.tgz` 原本就会删）。

**证明**：`upgrade.test.ts` `orphan staged sidecar without a tarball is pruned on the next start`

### RV5-6 目标无 cancel 能力

**根因**：1.1.11 宣告 `staged-package` 但仍无 DELETE 路由；push 完成后 Stop 仍报已取消，包留在目标上。`deleteStagedBestEffort` 对非 2xx 不打日志。

**修复**：
- `/api/system/info` 的 `upgradeCapabilities` 增加 `'upgrade-cancel'`（1.1.12+）
- job 记录目标 capabilities
- **push 已完成**或 **staged start 已发出** 且目标无 `'upgrade-cancel'`：`501 { code:'UPGRADE_CANCEL_UNSUPPORTED', nodeId }`，**不 abort、job 继续跑**
- 入口侧 download / mid-push（未落盘或截断 PUT 自清理）仍允许对任何目标取消
- `deleteStagedBestEffort` 对非 2xx `console.warn`

**证明**：
- `system.test.ts` `includes staged-package and upgrade-cancel`
- `remote-upgrade-job.test.ts` `cancel after push on a 1.1.11 target is unsupported and keeps the job running`
- `upgrade-service.test.ts` `cancel after push against a 1.1.11 target is 501 and the job keeps running`（fake 目标：`staged-package` only，DELETE 一律 404）

## 取消决策表（phase × 目标能力 → 响应）

入口 `DELETE /api/mesh/nodes/:id/upgrade`。本机节点不走 job，直接 `controller.cancel()`。

| 阶段 | 目标有 `upgrade-cancel`（1.1.12+） | 目标无 `upgrade-cancel`（1.1.11 等） |
|---|---|---|
| 本机 downloading | 200 idle `UPGRADE_CANCELLED`，清 txn / unverified cache | 同左（本机即目标） |
| 本机 executing / `commitStarted` | 409 `UPGRADE_NOT_CANCELLABLE` | 同左 |
| 本机 idle | 409 `UPGRADE_NOT_RUNNING` | 同左 |
| 入口 job：download（未落盘） | 200 overlay cancelled；abort fetch；`.part` 由 inflight 层在末 waiter 离开时删除 | **允许取消**，同上 |
| 入口 job：mid-push（PUT 仍在流，截断自清理） | 200 cancelled；abort PUT；await settle；DELETE package（404 幂等） | **允许取消**，同上 |
| 入口 job：PUT 已在目标落盘、ACK 未到 | await PUT；DELETE package；200 cancelled；`staging/staged/` 空 | 若观察到 PUT 2xx → **501** `UPGRADE_CANCEL_UNSUPPORTED`，job 继续；否则按截断清理 |
| 入口 job：push 完成、POST 尚未发出 | DELETE package；200 cancelled | **501**，不 abort，job 继续 POST |
| 入口 job：已发出 `POST source:'staged'`，目标 2xx 且仍 downloading/verifying | 不 abort POST；handoff；转发 `DELETE /api/system/upgrade` → **透传 200 cancelled** | **501**，job 继续（不报已取消） |
| 入口 job：已发出 POST，目标 2xx 且 executing | 不 abort POST；handoff；转发 DELETE → **409 `UPGRADE_NOT_CANCELLABLE`** | **501**，job 继续 |
| 入口 job：已发出 POST，start 失败 | DELETE package；200 cancelled | **501** 若已 push 完成；否则 cancelled |
| 入口 job：已 handed-off | `handled:false`，转发 `DELETE /api/system/upgrade` | 转发；旧目标 404 → 501 |
| 无 running job | 转发目标 DELETE | 转发；404 → 501 |

overlay 报 `UPGRADE_CANCELLED` 的前提：目标确认不在升级（本机/入口 download·mid-push 已清干净，或目标 DELETE 返回 200 idle）。executing 或旧目标无法中断时**绝不**报已取消。

## 测试 / tsc / biome

| 命令 | 结果 |
|---|---|
| `cd apps/gateway && bun test src/system src/api src/mesh/mesh-routes.test.ts` | **650 pass / 0 fail**（G7 时 638；本任务相关 5 文件 **131 pass / 0 fail**） |
| `cd apps/gateway && bunx tsc --noEmit -p .` | **0 errors** |
| `cd packages/shared && bun test` | **413 pass / 0 fail** |
| `cd packages/shared && bunx tsc --noEmit -p .` | **0 errors** |
| biome（11 个改动文件） | 干净 |

## 改动文件

- `packages/shared/src/contracts/system.ts` — 文档 `'upgrade-cancel'`
- `apps/gateway/src/api/system.ts` + `system.test.ts`
- `apps/gateway/src/system/upgrade.ts` + `upgrade.test.ts`
- `apps/gateway/src/system/release-download.ts` + `release-download.test.ts`
- `apps/gateway/src/system/remote-upgrade-job.ts` + `remote-upgrade-job.test.ts`
- `apps/gateway/src/system/upgrade-service.ts` + `upgrade-service.test.ts`

未改：`apps/fe/**`、`src/hub/**`、`packages/app/**`、`mesh-routes.ts`（仅跑了既有 remote-upgrade 用例，650 全绿）。

## 指挥官无需额外合入

无。`upgradeCapabilities` 仍是 `string[]`，FE 识别 `'upgrade-cancel'` 即可。

## 风险

- 1.1.11 在 PUT 已写完、入口却把 abort 当成截断失败时，仍可能留下 staged 包；能观察到 2xx 则走 501 而不是谎报取消。无 DELETE 路由无法补救。
- start 阶段 cancel 最多等到目标 POST 超时（默认 60s），期间 GET overlay 仍是 downloading。
- 末 waiter abort 会立即从 inflight map 摘掉该 key，同版本新 caller 会开新下载，不加入正在死去的 fetch。
