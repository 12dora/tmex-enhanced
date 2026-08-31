# C1b 结果：Crash-safe upgrader — gateway Web entry + install.sh

工作树：`/Users/konata/code/tmex-enhanced-wt-upg`（`feat/crash-safe-upgrade`）。未执行任何 git 命令；未触碰生产 tmex 安装、`tmex` tmux session、或 `127.0.0.1:39001`。只改了所有权内四个文件。

## 基线（编码前）

| 命令 | 结果 |
|---|---|
| `cd apps/gateway && bun test src/system` | **40 tests / 0 fail / 108 expect**（5 files） |
| `cd apps/gateway && bunx tsc --noEmit -p .` | **21 error TS**（`wc -l` = 50，含折行） |
| `cd packages/app && bun test src/lib/install-script.test.ts` | **9 pass / 0 fail / 24 expect** |

## 验收（编码后，fresh run）

| 命令 | 结果 |
|---|---|
| `cd apps/gateway && bun test src/system` | **44 pass / 0 fail / 123 expect**（5 files） |
| `bunx tsc --noEmit -p .` | **21 error TS / 50 lines**（未增加） |
| `cd packages/app && bun test src/lib/install-script.test.ts` | **16 pass / 0 fail / 47 expect** |
| `bunx biome check` 三个 TS 文件 | clean |
| `bash -n install.sh` | ok |

## 1. Blocker 5（Web entry）— none-mode PID 归属

### 修复

`apps/gateway/src/system/upgrade.ts`：

- 新增本地 `processCommandLine()`（macOS：`ps -p <pid> -o command=`；Linux：`/proc/<pid>/cmdline`）。gateway 不从 `packages/app` 导入，与现有 checksum 逻辑的重复模式一致。
- `cmdlineOwnsInstallRuntime()` 要求 cmdline 引用 `<installDir>/current/runtime/server.js` 或 legacy `<installDir>/runtime/server.js`，并对 `installDir` / 目标路径做 `realpath` 容错。
- `assertNoneModePidOwnership()`：先 `kill(pid, 0)` 确认存活，再校验 cmdline；失败抛错、不发 SIGTERM/SIGKILL。
- `UpgradeControllerDeps.processCommandLine` 可注入，供正例测试。
- `parsePidFileContents()` 兼容纯数字 `tmex.pid`，并顺带接受 JSON `{ pid }`（C1a 扩展 pid record 后 Web 仍能读）。

归属失败文案与 C1a i18n `upgrade.pidNotOwned` 英文对齐：`PID ${pid} is not the tmex runtime for this install (${installDir}).`

### 测试

- 负例：pid 文件指向真实存活的 `sleep 60` 子进程 → 拒绝升级、不 spawn、sleep 仍存活、不创建 `upgrade.log`。
- 正例：注入 `processCommandLine` 返回 `<installDir>/current/runtime/server.js`，`process.pid` 仅用于存活探测 → 通过并带 `--no-service`。原「`process.pid` 即合法 tmex PID」用例已替换。
- 无 pid 文件：仍拒绝（原有用例保留）。

### 偏差

- 正例走注入的 cmdline reader，没有再拉起一个真正的 `server.js` 进程（C1b 提示明确要求 fake cmdline provider）。
- 没有单独的 symlink/realpath 集成测试；匹配器实现了 realpath 容错。

## 2. Blocker 6（Web + install.sh）— SHA256SUMS 政策

### 修复（Web）

- `assertReleaseIntegrity()` 使用 gateway `compareVersions()`，阈值 `1.1.4`。
- `stageGithubRelease()` 在 missing sums 时直接 throw；Web **永远不允许** unverified（无 flag）。
- 文案对齐 C1a `packages/app/src/i18n/index.ts` 英文：
  - ≥ 1.1.4：`Release ${version} requires SHA256SUMS (HTTP 200, matching digest). Refusing to continue.`
  - 缺 entry：`SHA256SUMS does not list ${fileName}`
  - digest 不符：`Release tarball sha256 mismatch for ${file}.`
- 原 `upgrade.test.ts` ~L85「404 仍继续」happy path 改为 200 + 精确 `tmex-cli-<v>.tgz` entry + matching digest。extract 失败用例同样改为先通过 checksum，再测布局校验。

### 修复（install.sh）

- 解析并剥离 `--allow-unverified`，不传给 `tmex init`。
- 沿用 `tmex_classify_checksum_http`：
  - ≥ 1.1.4（`tmex_version_ge`）且 404 → abort，即使带 `--allow-unverified`。
  - < 1.1.4 且 404：仅当显式 `--allow-unverified` 才警告后继续；否则 abort。
  - 200 但无精确 tarball 行 → abort（`does not list`）。
  - digest 不符 → abort。

### 测试

Web（`upgrade.test.ts`）：

- 404 / 1.1.4 abort
- 404 / 1.1.0 abort（Web never unverified）
- 200 无精确 entry abort
- digest mismatch abort（原有，文案 regex 更新）
- 200 matching digest 仍解压成功

install.sh（`install-script.test.ts`，fake `curl`/`tar`/`node`，`TMEX_VERSION` 钉死，临时目录）：

- 1.1.4 + 404 abort，不 tar、不 init
- 1.1.4 + 404 + `--allow-unverified` 仍 abort
- 1.1.0 + 404 无 flag abort
- 1.1.0 + 404 + `--allow-unverified` 成功，init argv **不含**该 flag
- 200 digest mismatch / 无 entry abort
- 200 matching digest 解压并跑 init

### 偏差

- Web 对 **旧版本** 404 抛的是既有英文 `Release SHA256SUMS is missing; tarball integrity is unverified.`，**不**复制 C1a 的 `Re-run with --allow-unverified`（Web 没有该 flag）。install.sh 旧版本拒绝文案则与 C1a `upgrade.integrityUnverifiedDenied` 对齐。
- `install.sh` 用 `tmex_version_ge` 判断 ≥ 1.1.4；预发布号会被剥成数字分量（`1.1.4-beta` 会当成 1.1.4）。gateway `compareVersions()` 按 semver 把预发布判为小于正式版。测试只用 `1.1.4` / `1.1.0`。

## 3. Should-fix C — `upgrade.log` FD 泄漏

### 修复

`spawnUpgrade()` 先做 serviceMode/PID 前置检查，再 `openSync(upgrade.log)`。spawn 同步抛错时 `closeLog()` 关闭 FD；`waitForSpawnAndDetach` 的 settled 回调仍关闭成功路径的 FD。

### 测试

- none-mode 无 pid：不创建 `upgrade.log`
- none-mode foreign pid：同样不创建

## 改动文件

- `apps/gateway/src/system/upgrade.ts`
- `apps/gateway/src/system/upgrade.test.ts`
- `install.sh`
- `packages/app/src/lib/install-script.test.ts`

未改 `packages/app/**` 其余文件、`apps/gateway/src/runtime.ts`、`apps/gateway/src/api/system-routes.ts`。
