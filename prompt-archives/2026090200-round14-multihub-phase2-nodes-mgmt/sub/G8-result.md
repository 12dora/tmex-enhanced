# G8 — 复杂度门禁闭合

`bun scripts/complexity/gate.ts` 从 **73 violations** 收到 **exit 0**（`complexity gate ok (1173 files, 10677 functions)`，无 stale）。`--tighten` 已在末尾跑过：allowlist **157 → 151**（6 条实测已回落到默认阈值，被剔除）。未改 `gate.ts` 阈值。

## 拆分（行为保持，未改导出 API）

| 函数 | 前 | 后 | 做法 |
|---|---|---|---|
| `apps/gateway/src/api/system.ts:handleSystemApiRequest` | CC **30** | CC **6** / 20L | 路由表拆成 `handleUpgradeApiRequest` / `dispatchUpgradeCollection` / `dispatchUpgradePackage` / `handleUninstallApiRequest`。顺带拆 `handleStartUpgradeOpen`（CC 19 → 9）+ `parseStartUpgradeRequest`。 |
| `packages/app/src/commands/uninstall.ts:runUninstall` | CC **28** / **123**L | CC **13** / **68**L | 抽出 `executeUninstallPlan`、`uninstallServiceStep`、`removeProgramStep`、`removeDatabaseStep`、`removeTempUninstallCopy`。 |
| `apps/gateway/src/system/remote-upgrade-job.ts:runJob` | CC **27** | CC **3** / 14L | 抽出 `runDownloadPhase`（CC 7）、`runPushPhase`（CC 10）、`runStartPhase`（CC 12）。 |
| `apps/gateway/src/hub/hub-runtime.ts:dispatchForwardedWrite` | CC **27** | CC **6** / 14L | 抽出 `forwardedWriteCtx` + 每路由 `dispatchForwardedRedeem/CreateEnrollment/Rename/Revoke/KeyLogPost`。文件仍 1399 行，走文件级 allowlist。 |

其余 67 条全部 **allowlist**（codec 枚举分派、编排 hook/状态机、测试夹具、CLI 分派、文件长度；既有条目只抬锁值、保留原 reason）。`cancelRemoteUpgradeJob`（CC 19）未拆，按「有疑则白名单」入表。

## 文件

- `scripts/complexity/allowlist.json`（151 条，已 `--tighten`）
- `apps/gateway/src/api/system.ts`
- `apps/gateway/src/system/remote-upgrade-job.ts`
- `apps/gateway/src/hub/hub-runtime.ts`
- `packages/app/src/commands/uninstall.ts`

未改 fe 源码、未改 `gate.ts`、无 git。

## 测试 / tsc / biome

| 包 | bun test | tsc --noEmit |
|---|---|---|
| `apps/gateway` | **3508 pass / 0 fail**（329 files） | **0** |
| `packages/app` | **644 pass / 0 fail**（`bun test src`，60 files） | **1**（预存 `TS2688` `@types/node`） |
| `packages/shared` | 未改源码，未跑 test | **0** |

Biome：`bunx biome check --write` 于上述 4 个 ts 文件，干净。

## 未留

门禁 exit 0，无 stale。fe / codec 仅 allowlist，未拆。
