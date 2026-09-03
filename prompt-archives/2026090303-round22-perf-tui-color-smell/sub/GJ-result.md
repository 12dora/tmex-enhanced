# GJ 结果：semver ×3 / SHA256SUMS ×2 / PID 解析核心

## 结论

1. **semver** 已合一到既有 `packages/shared/src/semver.ts`（浏览器安全）。删除 gateway / app 两份副本。不可解析语义在调用点显式保留（见下表）。
2. **SHA256SUMS** 解析 + fail-closed 校验抽到 Node-only `packages/shared/src/release/verify.ts`（相对路径 import，不进 barrel）。网关下载路径改走共享 `assertReleaseChecksum`。CLI wrapper 仍保留 `< 1.1.4` + `--allow-unverified`（`commands/upgrade.ts` 占用中）。
3. **PID** 两侧调用点都在 skip 文件内，只落地共享核心（CLI 更严语义），未改调用方。

未注册新的 package.json 子路径：semver 走已有 `@tmex/shared`；verify / pid-file 与 `env/load-env` 一样相对 import。

## 改动文件

**新建**
- `packages/shared/src/release/verify.ts` + `verify.test.ts`
- `packages/shared/src/process/pid-file.ts` + `pid-file.test.ts`

**修改**
- `packages/shared/src/semver.ts` / `semver.test.ts`：补 `requireSemver` / `compareSemverRequired` + SemVer 2.0 链
- `packages/shared/src/index.ts` / `index.test.ts`：导出上述两个 throwing wrapper
- `apps/gateway/src/system/release-download.ts`：parser / sha256Hex / assert 改 shared
- `apps/gateway/src/system/upgrade-service.ts` / `update-check.ts`
- `packages/app/src/lib/bun.ts` / `upgrade-verify.ts` / `upgrade-verify.test.ts` / `release-fetch.ts`

**删除**
- `apps/gateway/src/system/semver.ts` + `semver.test.ts`
- `packages/app/src/lib/semver.ts` + `semver.test.ts`

## 1. semver 旧函数 → 新调用（不可解析行为）

| 旧符号 | 调用点 | 不可解析 | 新调用 |
| --- | --- | --- | --- |
| `packages/shared` `parseSemver` / `compareSemver` | 已是规范实现；`ws-client` / `fe` / `hub-authorization` 已在用 | `null` | 不变 |
| gateway `compareVersions` | `update-check.checkForUpdate` | 视为 `0`（`hasUpdate=false`） | `compareSemver(...) ?? 0` |
| gateway `compareVersions` | `upgrade-service.isAlreadyAtOrAboveLatest` | 调用前已被 `RELEASE_VERSION_PATTERN` 滤掉 | `compareSemver(...) !== null && cmp >= 0` |
| gateway `compareVersions` | `release-download.assertReleaseSha256` | 只影响 404 文案；两侧都 throw | **删除该比较**；统一 fail-closed 文案（测试正则仍匹配） |
| app `compareSemver`（抛错，忽略 prerelease） | `bun.ts` `validateBunAt` | 抛 `errors.version.invalid` | `compareSemver`；`null` 时仍抛同一 i18n |
| app `compareSemver` | `upgrade-verify.sha256SumsRequired` | 抛同一 i18n | `compareSemver`；`null` 时抛 i18n |

规范 API：`parseSemver(): Semver | null`、`compareSemver(): number | null`、`requireSemver()` / `compareSemverRequired()` 抛 `invalid semver: ...`。

**附带语义**：app 旧 parser 用前缀 `/^(\d+)\.(\d+)\.(\d+)/`，把 `1.3.9-canary.1` 当成 `1.3.9`。合一后走 SemVer 2.0（prerelease 低于同核心正式版）。`bun --version` 实际输出无 prerelease；`MIN_BUN_VERSION=1.3.0`。

## 2. SHA256SUMS

共享模块：`parseSha256Sums`、`sha256Hex`、`checksumStatus`、`assertReleaseChecksum` / `assertReleaseIntegrityBytes`。缺条目一律拒绝。测试覆盖：valid、tampered、missing entry、malformed line、CRLF。

网关：`assertReleaseSha256` 改为调用共享 assert；404 文案改为同时满足原两条测试正则（`SHA256SUMS is missing` + `Refusing to continue`）。`CHECKSUMS_REQUIRED_SINCE` 删除——网关原本两个分支都是 throw，只是文案不同。

CLI：`upgrade-verify.assertReleaseIntegrity` **必须**保留 `< 1.1.4` + `allowUnverified`。`packages/app/src/commands/upgrade.ts` 及其测试占用中，`delegateUpgrade(..., '1.1.0', { allow-unverified: true })` 依赖 404 放行。共享核心本身 fail-closed。

## 3. PID 决策

**不把网关静默对齐到 CLI，也不把 CLI 放宽到网关。** 理由：

- 网关 `parsePidFileRecord`：`asPositiveInt`（JSON pid 可以是数字字符串；裸 JSON 数字也行）；**丢弃** `runtimePath`。无针对 parser 的单测；`assertNoneModePidOwnership` 只读 `pid` / `identity`。
- CLI `parsePidRecord`：JSON `pid` 必须是 number；**保留** `runtimePath`，写入 `formatPidRecord` 时带上。
- 生产 pid 文件由 CLI 写出（pid 为 JSON number），更严解析能吃现网文件。但不能让网关开始用 `runtimePath` 做归属判定——那会改变升级杀进程条件，而 `upgrade.ts` 本任务不能改。

共享核心 = CLI 更严语义（`packages/shared/src/process/pid-file.ts`）。

**待迁移调用点（skip 文件，请后续改）：**
- `apps/gateway/src/system/upgrade.ts` — `parsePidFileRecord` / `PidFileRecord`（约 892–915 行）；建议 import shared 后 **显式丢掉** `runtimePath`（薄 wrapper），不要开始读该字段。
- `packages/app/src/lib/upgrade-process.ts` — `parsePidRecord`（约 151–171 行）改为 re-export / 转调 shared。
- `packages/app/src/lib/upgrade-apply.ts` — 只是 re-export `hasLivePidFile` 等，parser 不在此。
- `packages/app/src/commands/init.ts` — 用 `pidFilePath`，不解析内容。

## 度量

| 项 | 前 | 后 |
| --- | ---: | ---: |
| gateway `semver.ts` | 61 | **删除** |
| app `semver.ts` | 30 | **删除** |
| shared `semver.ts` | 64 | 78 |
| gateway `release-download.ts` | 377 | 357 |
| app `upgrade-verify.ts` | 67 | 60 |
| 新 `release/verify.ts` | — | 61 |
| 新 `process/pid-file.ts` | — | 34 |
| 重复 semver 源码 | 91 | 0（+14 wrapper） |
| `packages/shared bun test` | 子集 13 pass / 3 files | **514 pass / 50 files**（含新 18 pass） |
| `packages/app bun test src/lib` | 子集 67 pass / 5 files（含 3 条已删 semver） | **328 pass / 34 files** |
| `apps/gateway bun test src/system` | GD 记录 153 / 10 files | **148 pass / 9 files**（−5 条已迁走的 `semver.test.ts`） |
| shared / app / gateway 针对性用例 | — | 全部 pass（含 `commands/upgrade.test.ts` 73 合入） |
| shared tsc | 0 | **0** |
| app tsc | 1（既有 `TS2688` node types） | **1**（同条） |
| gateway tsc | 0 | 3（`weixin-routes.ts` / `websocket-send-guard.ts`，**非本任务文件**，并行 agent） |
| `bunx biome check <changed files>` | — | **通过** |
| `bun scripts/complexity/gate.ts` | — | 失败 7 条，全在 `panels` / `terminal-ui` / `ghostty-terminal`（并行任务）；GJ 文件不在违规名单 |

## 未能做的

- **未做真实升级演练**（临时实例）。验收按单测覆盖 valid / tampered / missing / malformed / CRLF；禁止碰生产 9883 / `~/Library/Application Support/tmex`。
- **PID 调用点未迁移**（见上）。共享模块已可相对 import：`packages/shared/src/process/pid-file.ts`。
- CLI `--allow-unverified` 旧版本分支未删：被 skip 的 `commands/upgrade.ts` 测试锁住。
