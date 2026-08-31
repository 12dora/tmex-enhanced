# C1a 结果：Crash-safe upgrader — CLI/runtime blockers

工作树：`/Users/konata/code/tmex-enhanced-wt-upg`（`feat/crash-safe-upgrade`）
计划锚点：`EX3-result.md`。未触碰 C1b 四文件：`apps/gateway/src/system/upgrade.ts`、`upgrade.test.ts`、`install.sh`、`packages/app/src/lib/install-script.test.ts`。未使用 git。未触碰生产 tmex / 默认 socket / `127.0.0.1:39001`。

## 验证数字

### 编码前基线

| 命令 | 结果 |
|---|---|
| `cd packages/app && bun test` | 537 tests，**1 fail**（预存在：`scripts/build-runtime.test.ts` cpu-features stub，`dist/runtime/server.js` 不存在） |
| `cd packages/app && bunx tsc --noEmit -p .` | **1** 个预存在错误 `TS2688 Cannot find type definition file for 'node'`；`wc -l` = **3** |
| `cd apps/gateway && bun test src/system src/api` | 441 tests，**0 fail** |
| `cd apps/gateway && bunx tsc --noEmit -p .` | `wc -l` = **50**（用户口述 ~21；编码前实测已是 50） |

### 编码后

| 命令 | 结果 |
|---|---|
| `cd packages/app && bun test` | **584 pass / 1 fail / 585 tests**（22.46s）。唯一 fail 仍是 `scripts/build-runtime.test.ts` cpu-features stub（单独复跑确认） |
| `cd packages/app && bunx tsc --noEmit -p .` | 仍 **1** 个 `@types/node`；`wc -l` = **3**（未增加） |
| `cd apps/gateway && bun test src/system src/api src/runtime.preflight.test.ts` | **446 pass / 0 fail / 446 tests**（983ms） |
| `cd apps/gateway && bunx tsc --noEmit -p .` | `wc -l` = **50**（未增加） |
| `bunx biome check <changed files>` | 38 个文件，**clean**（先 `--write` 修了 12 个 format/import） |
| `cd packages/app && bun run build:cli` | **成功**：`Bundled 60 modules in 6ms`，`cli-node.js 198.30 KB` |
| `bun scripts/complexity/gate.ts`（仓库根） | **C1a 文件全部通过**。全仓仍 **1 violation**：`apps/gateway/src/system/upgrade.ts:366 parsePidFileContents CC 17 > 15`（C1b 所有文件，未改 allowlist、未改该文件） |

复杂度：将 `liveHealthUrl` 抽到 `upgrade-health.ts`（`upgrade-apply.ts` 从 901 行降到 ~889），`acceptHealthzBody` 的 TLS 分支抽成 `rejectMissingTlsListener`。未编辑 `scripts/complexity/allowlist.json`。

---

## 逐项

### 12. Flag 解析统一（合并引入的阻塞 bug）

**修复：** 单一来源 `packages/app/src/lib/upgrade-flags.ts`：`UPGRADE_FLAGS`、`UPGRADE_PASSTHROUGH_FLAGS`、`UPGRADE_USAGE`。`args.ts` 的 `COMMAND_FLAGS.upgrade` 与 `commands/upgrade.ts` 共用同一 Set。补齐 `no-service`、`txn`、`allow-unverified`。`--allow-unverified` **不在** passthrough 列表中，不会传给 apply 子进程。未知 flag 仍由 `assertKnownUpgradeFlags` / `assertKnownFlags` 拒绝。`--help` 仍由 `index.ts` 在 dispatch 前处理。

**测试：**
- `args.test.ts`：`accepts upgrade --txn, --allow-unverified and --no-service together`
- `commands/upgrade.test.ts`：`passthrough argv from download is accepted by both flag tables`（完整 passthrough argv 再 parse + `assertKnownUpgradeFlags`，并断言 argv 不含 `--allow-unverified`）

**偏差：** 无。

### 1. Blocker 1 — repair 不得删除当前事务 staging

**修复：** `runLockedUpgrade()` 在 repair 前读取 `--txn` → `activeTxnId`，传入 `repairUpgrade(..., { activeTxnId })`。`cleanupTxn` 在 `journal.txnId === activeTxnId` 时保留 staging。所有 `sweepUpgradeGarbage` 经 `sweepRepairGarbage` 传 `keepTxnId: activeTxnId`。commit 后再由正常路径清理当前事务。

**测试：**
- `upgrade-apply.test.ts`：`missing journal keeps active staging and deletes orphan staging`
- `upgrade-apply.test.ts`：`terminal journal cleanup keeps the active txn staging`
- `commands/upgrade.test.ts`：`download extract then extracted CLI repair+apply commits and later cleans staging`（真实 tarball + extracted `bin/tmex.js` import `repairUpgrade`/`applyUpgrade`）

**偏差：** 无。

### 2. Blocker 2 — `repairMissingJournal()` 不得删 legacy 顶层目录

**修复：** `repairMissingJournal()` 只做 `convertLegacyLayout` + `sweepRepairGarbage`。`removeLegacyTopLevelDirs` 仅由 `finishCommittedCleanup()` 调用。

**测试：** `upgrade-apply.test.ts`：`legacy missing-journal repair plus failed preflight keeps top-level dirs`（与 blocker 1 合并：legacy 布局 + 旧服务仍运行 + preflight 失败 ⇒ 顶层 `cli/runtime/resources` 仍在、旧服务未 stop）。

**偏差：** 无。

### 3. Blocker 3 — 显式 preflight RuntimeMode

**修复：**
- `packages/app/src/runtime/mode.ts`：`RuntimeMode = 'normal' | 'preflight'`，`TMEX_RUNTIME_MODE`，`handlePreflightHttp`（`/healthz` → `{status,version,startedAt}`，其它 404）
- `apps/gateway/src/runtime.ts`：preflight 仍跑 migrations；跳过 seed/refresh/push/agent/watch/tunnel/通知；`restoreRemoteAgentSessions` 为空；`liveStart` 可注入探测
- `assemble.ts`：`assemblePreflightTmex` 不建 auth/mesh/TLS/前端；dummy TLS
- `server.ts`：preflight 不调用 `tls.startup()`
- `runPreflight` 设置 `TMEX_RUNTIME_MODE=preflight`

**测试：**
- `apps/gateway/src/runtime.preflight.test.ts`：`runs migrations once and never starts live side effects`（migrations=1，`liveStart`=0）
- `packages/app/src/runtime/mode.test.ts`：env 读取 + preflight HTTP 仅 `/healthz`
- `assemble.test.ts`：`assembleTmex preflight`（mesh 不得 start、无前端、`/healthz` 有 version/startedAt、其它 404）

**偏差：** 无。旧 candidate 不知该 env 的说明按任务原文接受。

### 4. Blocker 4 — 1.0.2 healthz 无 version/startedAt

**修复：** `upgrade-health.ts`：`statusOnly`、`verifyOldHealthz`、`oldServiceHealthOpts`、`isLegacy102`。`fromVersion === '1.0.2'` 只要求 `status==='ok'`。`verifyOldServiceRunning` / `rollbackToOld` 共用；已 running 则不 `start()`、不要求新 `startedAt`。`repairRestartOld` / `repairVerifyOrRollback` 传入 `serviceMode`。数字 epoch `startedAt` 仍走 `parseHealthTimestamp`（`< 1e12` 视为秒）。候选/新版本仍走严格 version +（重启后）`startedAt`。

**测试：**
- `upgrade-health.test.ts`：`1.0.2 status-only body is accepted`；live server `{status:'ok'}`；`1.1.3 numeric epoch startedAt still works with minStartedAt`
- `upgrade-apply.test.ts`：`1.0.2 managed repair uses status-only health and can roll back`

**偏差：** `statusOnly` 按 **版本是否为 1.0.2** 决定，没有再 `&& serviceMode === 'managed'`。原因：1.0.2 的 `/healthz` 在任何 serviceMode 下都没有 `version`/`startedAt`；`none` 路径的归属由 PID ownership（blocker 5）保证，healthz 仍只能用 status。`serviceMode` 仍传入以便调用方区分 managed running vs PID。

### 5. Blocker 5 — `serviceMode=none` PID 归属（CLI）

**修复：** `upgrade-process.ts`：`assertOwnedInstallProcess`（cmdline 必须匹配 `<installDir>/current/runtime/server.js` 或 legacy `<installDir>/runtime/server.js`，realpath 容忍）；`parsePidRecord`/`formatPidRecord` 兼容纯数字 `tmex.pid`。`createDirectProcessControl({ installDir })` 在任何 signal 前校验归属。外来 live PID：`stop()` / `isRunning()` **抛归属错误**（不是 `isRunning()===false`），不发信号、不删 pid 文件。`init.ts` 补传 `installDir`。

**测试：**
- `upgrade-process.test.ts`：`foreign live PID throws on stop, does not signal, and keeps the pid file`（含 `isRunning()` 同样抛错）
- `upgrade-process.test.ts`：`owned current/runtime/server.js process can be stopped`
- 纯数字 / JSON pid record 解析

**偏差：** Web 侧 `assertNoneModePidOwnership` / 不再用 `process.pid` 当合法 tmex PID 的测试属 C1b（`upgrade.test.ts`），本任务未改。

### 6. Blocker 6 — SHA256SUMS 政策（CLI + 设计文档）

**修复：** `assertReleaseIntegrity()` 在 `upgrade-verify.ts`：
- `>= 1.1.4`：必须 200 + 精确条目 + digest；404 即使 `--allow-unverified` 也中止
- 更旧目标：仅 `--allow-unverified` 允许 404
- 200 无条目 / digest 不匹配一律失败

`delegateUpgrade()` 使用该函数；flag 只用于外层下载，不传 apply 子进程。设计文档 `docs/release/2026083101-upgrade-crash-safety.md` staging 段（约第 39 行）已改为与本政策完全一致的措辞。`fetchReleaseSha256Sums` 增加 `unpublished`（404 vs 200 无条目）。

**测试：**
- `upgrade-verify.test.ts`：1.1.4 门槛、1.1.0 仅 flag 允许 404、1.1.4+404 含 flag 仍失败、200 无条目、digest mismatch
- `commands/upgrade.test.ts`：1.1.0 无 flag 失败；1.1.4 + 404 含 flag 失败

**偏差：** 未改 `install.sh` / `apps/gateway/src/system/upgrade.ts`（C1b）。

### 7. Blocker 7 — `stopping` 阶段

**修复：** `UpgradePhase` 增加 `'stopping'`；`recoveryAction('stopping') = 'restart_old'`。`service.stop()` 前写 `stopping`；`assertStopped()` 后再写 `backup` 再拷 DB。旧 `backup` journal：先 `isRunning()`，已跑则不 double-start。stop 失败时 journal 停在 `stopping`，无 backup 目录。

**测试：**
- `upgrade-state.test.ts`：`stopping also restarts the old service`
- `upgrade-apply.test.ts`：backup+running ⇒ `starts === 0`；backup+stopped ⇒ `starts === 1`；stopping journal 恢复；stop 失败不拷 DB

**偏差：** 无。

### Should-fix A — `upgrade-db.ts` argv

**修复：** `vacuumIntoScript` 使用 `process.argv[1]` / `[2]`，非空校验。`copyPreflightDb` 可注入 `spawnSync`。

**测试：** `vacuum script reads argv[1] and argv[2] and rejects empty paths`；真实 `VACUUM INTO`；`passes src and dest after -e to spawnSync`。

**偏差：** 无。

### Should-fix B — native addon 离线复用

**修复：** `oldNativeMatchesPin`：文件存在 + manifest SHA256 + platform + version + NAPI。匹配则 `copyDirectory`，不调 `enableDirect`。不匹配才 npm。保留 `--allow-missing-native`。

**测试：** 匹配时 `enableDirect` 设为“若调用则失败”仍成功；hash/platform/version/NAPI 任一不匹配则重装。

**偏差：** 无。

### Should-fix D — legacy shim 仅在 CLI 存在时写

**修复：** `convertLegacyLayout` 仅当 `current/cli/bin/tmex.js` 存在才写 shim；否则保留已有 shim。可注入隔离 `localBinDir`/`bunBinDir`。

**测试：** 无顶层 cli 时不写指向不存在路径的 shim、已有内容不变；有 CLI 的旧布局继续写正确 shim。

**偏差：** 无。

### Should-fix I remainder — repair 传入 `shimDirs`

**修复：** `repairShimDirs(deps)` 默认 `[defaultLocalBinDir(), defaultBunBinDir()]`，可经 `deps.shimDirs` 覆盖。所有 repair 入口的 `sweepUpgradeGarbage` 都带上。

**测试：** `upgrade-gc.test.ts`：`cleans shim tmex.*.tmp without touching foreign shims`。

**偏差：** 无单独的 `repairUpgrade` 端到端 shim 测试；repair 一律走 `sweepRepairGarbage`，GC 单测覆盖实际删除语义。

### Should-fix E — TLS readiness（已实现，未降级）

**修复：**
- `apps/gateway/src/api/system-routes.ts`：`setHealthzTlsProvider`；healthz 增加 `tls: { mode, listenerRunning }`（无 provider 时 `{ mode: 'none', listenerRunning: false }`）
- assembled runtime 在 `assembleTmex` 注册真实 TLS 状态
- `HealthCheckOpts.requireTlsListener`；commit / 新服务验证两处 `requireTlsListener: true`
- selfsigned/acme 要求 listener；none/external 不阻断；preflight 不启用该检查（preflight healthz 无 tls 字段，且不传 `requireTlsListener`）

**测试：**
- `system-routes.healthz.test.ts`：默认 `tls: { mode: 'none', listenerRunning: false }`
- `upgrade-health.test.ts`：`requireTlsListener only blocks selfsigned/acme when listener is down`
- assemble 正常路径已有 tls 字段断言

**偏差：** 没有「占用 TLS 端口 + 完整 apply 拒绝 commit」的 e2e（需真实 HTTPS listener 抢端口）。契约层（healthz 字段 + accept 规则 + commit 传 flag）已落地，未半实现。

### Should-fix C（Web upgrade.log FD）

C1b 范围，未做。

---

## 未完成 / 阻塞

1. **复杂度门禁全仓未绿**：`apps/gateway/src/system/upgrade.ts:parsePidFileContents` CC 17。该文件属 C1b，C1a 不得修改。CLI 侧等价逻辑在 `packages/app/src/lib/upgrade-process.ts` 的 `parsePidRecord`，已拆到阈值内。C1b 把 Web 解析抽成 helper 或复用 CLI 解析后即可过门。
2. **预存在 `packages/app` 1 fail**：`scripts/build-runtime.test.ts` cpu-features stub，与本任务无关；基线即存在。
3. **预存在 tsc**：app `@types/node`；gateway 50 行错误均在 tmux/ssh/ws 测试，未因本任务增加。

## 未改动的禁区

- `apps/gateway/src/system/upgrade.ts`
- `apps/gateway/src/system/upgrade.test.ts`
- `install.sh`
- `packages/app/src/lib/install-script.test.ts`
- 生产 `~/Library/Application Support/tmex/`、9883、launchd、tmux session `tmex`
- `scripts/complexity/allowlist.json`
