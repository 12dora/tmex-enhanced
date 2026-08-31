# G5b 结果：crash-safe upgrader release-gate 修复（review I）+ 复杂度门禁

指挥官保留的两处未动：`runPreflight` 分配真实 ephemeral `TMEX_PEER_PORT`；候选 runner 把 stdout/stderr tail 放进 preflight 错误（`CandidateHandle.logTail`）。

Should-fix（S1–S5）全部做了，没有跳过。复杂度门禁未改 allowlist。

## Blockers

| ID | 修复 |
|---|---|
| **B1** | 回滚不传 `expectedVersion`；要求 `status==='ok'`、`current`→`fromVersion`、`startedAt` ≥ 本次重启。候选/新版本仍严格比 `version`。真实 1.1.3 `/healthz` 的 `startedAt` 是 **epoch 毫秒 number**（不是 ISO 字符串）；`parseHealthTimestamp` 两种都认。回归 fixture：`{status:'ok',startedAt:1788190485291,restarting,env,tmux}`。 |
| **B2** | `rollbackToOld()` 不再吞 `stop()`；停完必须 `!isRunning()` 否则抛错、保留 journal+backup。`restoreDbTrio()` 先删目标 `tmex.db`/`-wal`/`-shm` 再按备份集合恢复，fsync 文件+目录。`--no-service` SIGKILL 路径 `killPidAndWait` 等到退出。 |
| **B3** | `InstallMeta.serviceMode: 'managed' \| 'none'`。`init --no-service` 自己 `start()` 并写 `tmex.pid`。`run.sh` 在 `exec` 前 `printf $$ > tmex.pid`。upgrade 成功提交时把解析后的模式写回 meta（legacy 无该字段时用 `--no-service` 回退，之后以 meta 为准；flag 不再覆盖已持久化的模式）。Web：读 meta；`none` 且无存活 pid → 拒绝并提示先停进程；`none` 时 spawn 传 `--no-service`。 |
| **B4** | journal 写 `{candidatePid, candidateStartedAt}`。`--repair` from `preflight`：cmdline 含候选 `server.js` 才杀，等待退出后再删目录。 |
| **B5** | legacy 转换拷 `native/`。预启动前：若 fromVersion 有 native manifest，用真实 `enableDirect`（候选 version dir）装 pin；失败则中止，除非 `--allow-missing-native`。测试打真实 fixture，不是 no-op stub。 |
| **B6** | 仅 HTTP **404** = 未发布（warn+continue）；网络错误 / 其他非 2xx **abort**。校验在解压/执行前。CLI `fetchReleaseSha256Sums`；`install.sh` 用 http_code 分类；gateway `stageGithubRelease()` 重复最小逻辑并有测试。 |
| **B7** | `~/.bun/bin/tmex` 禁止先 `rm`；temp symlink + atomic rename。故障注入：crash-before-rename 时旧 target 仍在。 |
| **B8** | lock payload：`pid + startedAt + identity`（macOS `ps -o lstart=` / Linux `/proc/<pid>/stat` starttime）。pid 死 **或** 身份不符 → stale。测试：pid 活着但 identity 不匹配可回收。 |
| **B9** | repair `switching`/`backup`：`service.start()` 后先验证 running + health，再清 txn / 写终态；失败保留 journal+backup，非零退出。 |

## Should-fix

- **S1** preflight：候选 bun 跑 `VACUUM INTO`（先 `wal_checkpoint(TRUNCATE)`）；失败回退文件拷贝。文档已写限制。
- **S2** gateway `UpgradeController`：子进程 early exit → idle/error（含 spawn 与 executing 之间的 `pendingEarlyExit`）。
- **S3** `toVersion === current` → 健康 no-op，不写 aborted journal。
- **S4** journal 记录 `keepBackup`；后续 repair 尊重。
- **S5** `sweepUpgradeGarbage`：孤儿 `staging/*`、`*.tmp`（upgrade-state/current/run.sh/tmex）；committed 时补完 prune/legacy；不碰 `current` 目标与 `data/`。

其它：CLI `--help`/`-h` 显示帮助；**未知 flag 拒绝**（`assertKnownFlags`）。`tmex upgrade --help` 不再静默打默认 install dir。

复杂度：拆 phase helper。`applyUpgrade` / `buildInitConfig` / `runInit` / `runUpgrade` 均低于门限。`bun scripts/complexity/gate.ts` → `complexity gate ok (1118 files, 9369 functions)`。

## 文件列表

新增：`packages/app/src/lib/upgrade-{state,lock,switch,verify,gc,legacy,apply,health,db,process,native}.ts` 及对应 `.test.ts`。

修改（owned）：`packages/app/src/{types,index,cli-auth-entry,cli/help,i18n/index,commands/{init,upgrade,direct,uninstall},lib/{args,cli-shim,fs-utils,install,install-layout,json-file,release-fetch,install.test,install-layout.test,cli-shim.test,release-fetch.test,args.test,install-script.test},runtime/assemble}.ts`、`packages/app/{CHANGELOG.md,package.json}`、`install.sh`、`apps/gateway/src/{system/upgrade.ts,system/upgrade.test.ts,api/system-routes.ts,api/system-routes.healthz.test.ts}`、`docs/release/2026083101-upgrade-crash-safety.md`。

未改：`.github/workflows/release.yml`（已有 SHA256SUMS）；`apps/gateway/src/system/install-info.ts`（不在本任务 owned 范围，见下方指挥官待办）。

## 测试 / tsc / biome / build

| | 前 | 后 |
|---|---|---|
| `packages/app` bun test | 507 pass / 0 fail | **537 pass / 0 fail** |
| `packages/app` tsc | 1（预存 `Cannot find type definition file for 'node'`） | **1** |
| `apps/gateway` `bun test src/system src/api` | 435 pass / 0 fail | **441 pass / 0 fail** |
| gateway tsc | 21 | **21** |
| complexity gate | fail（applyUpgrade 24、buildInitConfig 18、runInit 23、runUpgrade 17） | **ok** |
| `bun run build:cli` | — | **成功**（`cli-node.js` 187.40 KB） |

biome：owned 源文件 `biome check` 通过（无 `--write` 于非本任务文件）。

## Scratch rehearsal

**禁止**生产：未碰 9883 / `~/Library/Application Support/tmex/` / 默认 tmux socket / 名为 `tmex` 的 session。全程 `--install-dir`。socket：`tmux -L tmex-r9-rehearsal`。结束后 `pkill -f …/install-g5b` + `tmux -L tmex-r9-rehearsal kill-server`。

目录：`/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/ca52e5db-7f6e-4446-8b64-e719939894f2/scratchpad/rehearsal/install-g5b`（未复用脏的旧 `install/`）。

配方：从 `pkg113/package` 搭 legacy 顶层 `cli/runtime/resources` + `app.env`（`GATEWAY_PORT=19893`，`TMEX_TMUX_SOCKET=tmex-r9-rehearsal`，`TMEX_ROLES=standalone`，`TMEX_DIRECT_ENABLED=false`）+ 旧 `run.sh` + `install-meta.json`（`cliVersion` 1.1.3）。`bash run.sh` 启动。再用本 worktree `npm pack` 的 1.1.4：`cd <pkg114> && node bin/tmex.js upgrade --apply-current-package --no-service --install-dir <dir> --lang zh-CN`。

### 1.1.3 启动后 `/healthz`（无 `version`，`startedAt` 为 number）

```json
{"status":"ok","startedAt":1788190183293,"restarting":false,"env":"production","tmux":{"healthy":true,"clientVersion":"tmux 3.7b","clientProvenance":null,"serverVersion":"3.7b","reason":"ok"},"owner":null}
```

### 升级 stdout（exit 0）

```
[tmex] upgrade committed 1.1.3 -> 1.1.4
[tmex] 升级完成。
- 目标版本: latest
- 安装目录: /private/tmp/claude-501/-Users-konata-code-tmex-enhanced/ca52e5db-7f6e-4446-8b64-e719939894f2/scratchpad/rehearsal/install-g5b
- healthz: http://127.0.0.1:19893/healthz
```

升级后：`current -> versions/1.1.4`；`versions: 1.1.3 1.1.4`；staging/backups 空；顶层 `cli/runtime/resources` 均不存在。

```json
{"status":"ok","version":"1.1.4","startedAt":1788190187817,"restarting":false,"env":"production","tmux":{"healthy":true,"clientVersion":"tmux 3.7b","clientProvenance":null,"serverVersion":"3.7b","reason":"ok"},"owner":null}
```

journal `phase: committed`，含 `keepBackup: false`、`candidatePid`、`dbBackup: true`。

### 未知 flag

`node bin/tmex.js upgrade --help --lang zh-CN` → exit 0，打印帮助，**没有**打默认 install dir。

`node bin/tmex.js upgrade --not-a-real-flag --install-dir <dir> --lang zh-CN` → exit 1，stderr：`未知参数：--not-a-real-flag`。

### 失败切换 → `--repair` → `rolled_back`

把 1.1.4 `runtime/server.js` 换成 `throw new Error("g5b-broken-switch")`，journal 改 `started`，停进程后 `upgrade --repair --no-service --install-dir <dir> --lang zh-CN`。

第一次 repair 因 B1 把 epoch number 当非法 `startedAt` 而失败（journal 停在 `started`，但 `current` 已切回 1.1.3）。修好 `parseHealthTimestamp` 后杀掉残留进程再 repair：

```
[tmex] 已回滚到 1.1.3：健康检查版本不符：期望 1.1.4，实际 。
[tmex] 升级修复完成（verify_or_rollback）。
```

exit 0。journal `phase: rolled_back`。`current -> versions/1.1.3`。`versions` 只剩 `1.1.3`（候选 1.1.4 已删）。staging/backups 空。旧版 `/healthz` 无 `version`：

```json
{"status":"ok","startedAt":1788190883777,"restarting":false,"env":"production","tmux":{"healthy":true,"clientVersion":"tmux 3.7b","clientProvenance":null,"serverVersion":"3.7b","reason":"ok"},"owner":null}
```

清理：`pkill -f …/install-g5b`；`tmux -L tmex-r9-rehearsal kill-server`。端口 19893 已释放。

## 指挥官待办（范围外）

- `apps/gateway/src/system/install-info.ts` 的 `resolveInstallDir` 仍可能落到 `current/`（G5 留下的；本任务不拥有该文件）。
- 遗留 gateway 若仍占着 `GATEWAY_PORT` 而 `tmex.pid` 指向别的/已死 pid，direct-mode `stop()` 只杀 pidfile，回滚健康检查会看到**旧** `startedAt` 而失败。`serviceMode=none` 且无存活 pid 时 Web 升级会拒绝；CLI `--repair --no-service` 前仍需操作者先停掉占用端口的进程。
- 从未写过 `serviceMode` 的纯 1.1.3 安装，Web 升级仍默认 `managed`（会走 launchd）。第一次 CLI `upgrade --no-service` 成功后会把 `none` 写入 meta。发版说明可提醒 no-service 用户先用 CLI 升一次。
- `packages/app` tsc 预存 1 条 `@types/node`；gateway tsc 预存 21 条。均非本任务引入。
