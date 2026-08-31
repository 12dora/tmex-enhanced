# G5 结果：crash-safe BIOS 式自升级

## 做了什么

实现版本目录 + 原子 `current` 切换 + journal + 锁 + 预启动 + DB 三件套备份/回滚 + GC。旧版本在新版本 `/healthz`（`status===ok` 且 `version===toVersion`）通过之前不会下线。任意阶段 `SIGKILL` 后，`upgrade --repair`（以及每次 `upgrade`/`init` 开头）按 journal 阶段恢复或清场。

## 阶段表

| phase | 动作 | 中断后 | `--repair` |
|---|---|---|---|
| `lock` | `upgrade.lock`（O_EXCL；pid 已死则回收） | 旧服务仍在跑 | 清 staging/候选，标 `aborted` |
| `staging` | 下载到 `staging/<txn>`，校验 HTTP/tar/`package.json` 版本/布局；有 `SHA256SUMS` 则比对 sha256，没有则记录未校验并继续。rename 进 `versions/<to>` | 旧服务仍在跑 | 删 staging + 候选（永不删 `current` 指向的目录） |
| `preflight` | DB 三件套副本 + 127.0.0.1 临时端口 + `TMEX_ROLES=standalone` 拉起候选，60s 轮询 `/healthz` | 旧服务未停 | 同 staging |
| `backup` | 停服务并确认退出，复制 `tmex.db{,-wal,-shm}` | 服务已停，`current` 仍旧 | 拉起旧服务，删候选 |
| `switching` | 原子 `current.tmp` rename 覆盖 `current` | 旧或新，journal 未 committed | 拉起 journal.fromVersion |
| `started` | 正式端口健康检查 | `current` 已是新版 | 再检查：通过则 `committed`+GC；失败则恢复 DB、切回 `current`、拉起旧版、删新版本目录，标 `rolled_back` |
| `committed` | 原子写 `install-meta.json`，GC | 新版在跑 | 只清残留 |
| `aborted` / `rolled_back` | 终态 | 旧版可启动 | 只清残留 |

成功 GC：删 `staging/<txn>`；默认删 `backups/<txn>`（`--keep-backup` 保留）；`versions/*` 只留 current + 上一个 last-known-good；仅 `committed` 后删顶层遗留 `cli/runtime/resources/native`。

`run.sh` 与 shim 一律走 `<installDir>/current/...`。`init` 直接写新布局。遗留顶层布局在第一次 apply 前按 `install-meta.json` 的 `cliVersion` 复制到 `versions/<from>/` 再原子建 `current`（缺版本号则中止）。`--no-service` 跳过 launchd/systemd，upgrade 用 pid 文件直接 spawn/kill `run.sh`。

## 文件列表

新增：
- `packages/app/src/lib/upgrade-state.ts` + `.test.ts`
- `packages/app/src/lib/upgrade-lock.ts` + `.test.ts`
- `packages/app/src/lib/upgrade-switch.ts` + `.test.ts`
- `packages/app/src/lib/upgrade-verify.ts` + `.test.ts`
- `packages/app/src/lib/upgrade-gc.ts` + `.test.ts`
- `packages/app/src/lib/upgrade-legacy.ts` + `.test.ts`
- `packages/app/src/lib/upgrade-apply.ts` + `.test.ts`

修改：
- `packages/app/src/lib/{fs-utils,json-file,install,install-layout,cli-shim,release-fetch,service.ts 未改逻辑但 writeText 已原子}.ts` 及对应测试
- `packages/app/src/commands/{upgrade,init,direct,uninstall}.ts` + upgrade 测试
- `packages/app/src/{types,cli/help,i18n/index,runtime/assemble}.ts`
- `apps/gateway/src/api/system-routes.ts`（healthz 增加 `version`）+ healthz 测试
- `apps/gateway/src/system/upgrade.ts`（stage 放到 `<installDir>/staging/<txn>`，spawn 传 `--txn`）+ 测试
- `install.sh`（有 SHA256SUMS 则校验，没有则提示未校验）
- `docs/release/2026083101-upgrade-crash-safety.md`
- `.github/workflows/release.yml`：**未改**（已在生成并上传 `SHA256SUMS`）

## 测试 / tsc

`packages/app`：
- 前：472 pass / 0 fail（任务写的 475/1 与本 worktree 实测不符；无失败用例）
- 后：503 pass / 0 fail
- `tsc --noEmit`：前 1 / 后 1（预存在：`Cannot find type definition file for 'node'`）
- `bun run build:cli`：成功

`apps/gateway` healthz+upgrade：12 pass → 13 pass。gateway 全量 tsc 仍有约 21 个预存在错误，未新增。

biome：owned 源文件 `biome check` 通过。`install.sh` `bash -n` 通过。

## 在 scratch 目录里怎么复盘

**禁止**对 `~/Library/Application Support/tmex` 或生产 9883 操作。

```bash
export PATH="$HOME/.bun/bin:$PATH"
SCRATCH=/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/ca52e5db-7f6e-4446-8b64-e719939894f2/scratchpad/g5-install
mkdir -p "$SCRATCH"
cd /Users/konata/code/tmex-enhanced-wt-r9/packages/app
bun run build:cli   # 若 dist 已有可跳过；完整 init 还需要 dist/runtime + resources（bun run build）

# 无 launchd 的全新安装（需已有 runtime/resources 产物）：
node dist/cli-node.js init --no-interactive --no-service \
  --install-dir "$SCRATCH" --host 127.0.0.1 --port 19883 \
  --db-path "$SCRATCH/data/tmex.db" --autostart false --skip-dep-check

ls -l "$SCRATCH/current"   # -> versions/<cliVersion>
```

模拟 kill（不必真杀进程，写 journal 再 `--repair` 与测试同构）：

```bash
# 1) staging 中断：候选是垃圾
FROM=$(readlink "$SCRATCH/current")   # versions/x.y.z
mkdir -p "$SCRATCH/versions/9.9.9" "$SCRATCH/staging/dead-txn"
echo garbage > "$SCRATCH/versions/9.9.9/marker"
cat > "$SCRATCH/upgrade-state.json" <<'EOF'
{"txnId":"dead-txn","phase":"staging","fromVersion":"REPLACE","toVersion":"9.9.9","startedAt":"2026-08-31T00:00:00.000Z","updatedAt":"2026-08-31T00:00:01.000Z"}
EOF
# 把 REPLACE 换成实际 from 版本
node dist/cli-node.js upgrade --repair --no-service --install-dir "$SCRATCH"
# 期望：versions/9.9.9 消失，current 仍指向旧版，journal.phase=aborted

# 2) started 中断：current 已切新版但未 committed
# 先准备 versions/新版与 current 指向它，journal phase=started，再 --repair
# 健康检查失败 → rolled_back 并切回 fromVersion；成功 → committed
```

真升级（仍用 scratch，不要打生产）：

```bash
node dist/cli-node.js upgrade --version 1.1.4 --no-service --install-dir "$SCRATCH"
# 或只修：  node dist/cli-node.js upgrade --repair --no-service --install-dir "$SCRATCH"
```

单元层已覆盖：journal→action、原子 symlink、锁回收、遗留转换、GC/prune、sha256、apply dry-run（含 fake service）、以及一个真实 Bun 脚本提供 `/healthz` 的预启动。

## 指挥官需要补的（未改 owned 之外的文件）

1. **`apps/gateway/src/system/install-info.ts` 的 `resolveInstallDir()`** 仍用 `TMEX_FE_DIST_DIR/../..`，新布局会落到 `current/` 而不是 install 根。本任务已在 `run.sh` 写入 `TMEX_INSTALL_DIR`，并在 `UpgradeController.resolveUpgradeInstallDir` 做了兜底（读 `TMEX_INSTALL_DIR`，或从 `current/` 上溯）。请把 `install-info.ts` 改为优先 `TMEX_INSTALL_DIR` / `install-meta.json` 所在目录，否则 doctor/自更新探测会错。
2. **未加 `TMEX_PREFLIGHT=1` 到 gateway mesh 启动路径**（禁止改 mesh）。预启动用 `TMEX_ROLES=standalone`（不连 Hub、不开 peer）。若 standalone 仍拉起 tunnel，需在 gateway runtime 另加最小开关。
3. **mesh 未登录 `/healthz`** 原先只回 `{status:ok}`。本任务在 owned 的 `assemble.ts` `attachStartedAt` 里补了 `version`（以及原有 `startedAt`）。若某条路径不经过 assemble，需在 `mesh-http.ts` 放行 `version`。
4. **`.github/workflows/release.yml` 已经生成并上传 `SHA256SUMS`**，未再改。旧 release 无此资产时 CLI/`install.sh` 会提示完整性未校验并继续。

## 预存在失败

本 worktree 实测 `packages/app` **没有**失败用例（0 fail）。任务描述的「1 pre-existing fail」未出现；`assemble.test.ts` 会把假 hub 的 `hub-fail` 打到 stderr，但测试仍 pass。
