# C3 结果：Upgrader review follow-ups

未改 Blocker 4（`repairVerifyOrRollback` 的 `isRunning()` 守卫已由 commander 修好）。

## 逐项

### Blocker 1 — `--allow-unverified` 只放行真正的 404

`assertReleaseIntegrity` 对 `< 1.1.4` 仅在 `sums.unpublished === true` 时允许 `--allow-unverified`。HTTP 200 缺精确条目（`missing: true, unpublished: false`）和 digest mismatch 无论 flag / 目标版本一律中止。

新增测试：`200-missing-entry + allowUnverified:true` ⇒ throws。

### Blocker 2 — install.sh 不再把远端 SHA256SUMS 行交给 `shasum -c`

新增 `tmex_sha256sums_hex_for`：只接受 filename 字段**恰好**为 `tmex-cli-<v>.tgz` 的行（拒绝 `/abs/...` 与 `../`），取出 hex，对已下载的 `$tgz` 自行 `shasum -a 256` 后字符串比较。

测试覆盖：绝对路径清单行、`../` 清单行均拒绝且不解压。

### Blocker 3 — PID 归属 + TOCTOU 再校验

两处（`packages/app/src/lib/upgrade-process.ts` 与 `apps/gateway/src/system/upgrade.ts`）：

- **无 identity 的遗留纯数字 pid**：可执行文件 token（第一段或其 basename）必须是 `bun`/`node`，且某个 argv token **等于** runtime 路径（含 realpath），禁止 substring。
- **有 identity**：identity 匹配即视为归属（主路径）；读不到 live identity 时回退到上述 token 检查。
- `killPidAndWait()` 在 SIGTERM 与 SIGKILL 前都再跑 ownership；失败则停发信号并抛归属错误。进程在 verify 与 signal 之间退出视为 gone，不抛。测试用注入 probes 覆盖。

### Should-fix 2 — 生产入口接线测试

`runUpgrade(parseArgs([... --apply-current-package --txn live-txn ...]))` 走 `runLockedUpgrade`，断言 `repairUpgrade` 收到 `activeTxnId: 'live-txn'`、`applyUpgrade` 收到 `txnId: 'live-txn'`。漏传 `activeTxnId` 会失败。

### Docs — 已知限制

`docs/release/2026083101-upgrade-crash-safety.md` 增加「已知限制」：preflight 仍有 import-time 副作用；1.1.4 门槛对 prerelease 在 CLI/`install.sh` vs Web 比较不一致（当前不发预发布、Web fail-closed）。

## 验证数字

| 命令 | 结果 |
|---|---|
| `cd packages/app && bun test` | **597 pass / 0 fail**（60 files）。基线里 `scripts/build-runtime.test.ts` 在 dist 未构建时的那 1 个失败本次未出现。 |
| `cd packages/app && bunx tsc --noEmit -p .` | 仍是 1 条既有：`TS2688 Cannot find type definition file for 'node'` |
| `bunx biome check <changed files>` | clean |
| `cd packages/app && bun run build:cli` | 成功（`cli-node.js` 200.35 KB） |
| `bash -n install.sh` | ok |
| `cd apps/gateway && bun test src/system` | **46 pass / 0 fail**（5 files） |
| `cd apps/gateway && bunx tsc --noEmit -p .` | **21** 条 `error TS`（未增加） |
| 仓库根 `bun scripts/complexity/gate.ts` | ok（1121 files, 9451 functions） |

## 改动文件

- `packages/app/src/lib/upgrade-verify.ts` + test
- `packages/app/src/lib/upgrade-process.ts` + test
- `packages/app/src/lib/upgrade-apply.ts`（candidate/recorded kill 走 `killPidAndWait` 再校验）
- `packages/app/src/commands/upgrade.ts` + test（`RunUpgradeDeps` + 生产入口 txn 接线）
- `packages/app/src/lib/install-script.test.ts`
- `install.sh`
- `apps/gateway/src/system/upgrade.ts` + test
- `docs/release/2026083101-upgrade-crash-safety.md`
