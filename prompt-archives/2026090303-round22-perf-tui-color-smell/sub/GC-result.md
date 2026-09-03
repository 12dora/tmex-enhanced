# GC / B7 + B12 结果：upgrade-apply 拆事务 + dep-install 破环

## 做了什么

**B7**：把崩溃安全升级事务（journal 写入 → staging → native addon → preflight → stop → backup/switch `current` → start/verify → commit；失败走 abort/rollback）整段搬到 `packages/app/src/lib/upgrade-txn.ts`。调用顺序与副作用顺序未改。`applyUpgrade` / `repairUpgrade` 仍从 `upgrade-apply.ts` 导出；测试用的 `deployPackageToVersionDir`、`allocateEphemeralPort` 以及 `CandidateHandle` / `CandidateRunner` / `UpgradeApplyDeps` / `ApplyUpgradeOptions` 从 `upgrade-apply.ts` 再导出，外部 import 路径不变。

**B12**：共享类型与两侧互调的叶子函数（`DepName` / `InstallCommand` / `DepInstallPlan`、runner deps 类型、`isRootUid` / `resolveInstallCommand` / `isSudoAvailable`）下沉到 `packages/app/src/lib/dep-install-types.ts`。之后：

- `dep-install.ts` → `dependency-install-runner.ts` + `dep-install-types.ts`
- `dependency-install-runner.ts` → `dep-install-types.ts`（不再 import `dep-install.ts`）
- `dep-install-types.ts` → 只依赖 `./process`

环已断。`executeDependencyInstall` 等对外导出名仍在 `dep-install.ts`。

## 文件

| 路径 | 动作 |
|---|---|
| `packages/app/src/lib/upgrade-txn.ts` | **新建**事务执行器 |
| `packages/app/src/lib/upgrade-apply.ts` | 只留 apply/repair 编排 + 再导出 |
| `packages/app/src/lib/dep-install-types.ts` | **新建**共享类型/叶子函数 |
| `packages/app/src/lib/dep-install.ts` | 改 import，再导出叶子符号 |
| `packages/app/src/lib/dependency-install-runner.ts` | 改从 types 取类型/叶子函数 |

未改测试文件、未改 `commands/*`、未改 allowlist。

## 测量

| 项 | before | after |
|---|---:|---:|
| `upgrade-apply.ts` 行数 | 898 | **374**（门禁 900，验收 ≤750） |
| `upgrade-txn.ts` 行数 | — | 551 |
| `executeUpgradeTxn` 行数 | 110 | 110 |
| `packages/app` `tsc --noEmit` | 1（`TS2688` node types） | **1**（同） |
| `cd packages/app && bun test src/lib` | 329 pass / 34 files | **333 pass / 35 files**（+4 来自并行 B9 的 `totp-uri.test.ts`，非本任务） |
| 本任务相关 4 个 spec | — | 55 pass / 0 fail |

`bunx biome check` 上述 5 个文件：通过。

本任务文件均低于 CC=15 / 函数 120 行 / 文件 900 行。全仓 `bun scripts/complexity/gate.ts` 当前失败，违规在并行任务的 `apps/gateway/src/hub/uplink-server.ts:1536 handleKeyLogAppend: 122 lines > 120`，不在本任务文件占用范围内，未改该文件。

## 未能做的

全仓 complexity gate 被并行任务挡住；不能越权改 `uplink-server.ts`。
