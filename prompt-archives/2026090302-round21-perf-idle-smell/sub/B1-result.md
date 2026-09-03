# B1 结果 — 网关日志分级、轮转、降噪

工作区：`/Users/konata/code/tmex-r21`（`feat/round21-perf-idle-slim`）。

## 做了什么

### 1. 日志分级（O3 part 1）

新增网关本地模块 `apps/gateway/src/log/level.ts`（不进 `@tmex/shared`，避免浏览器 bundle）。

- 环境变量：`TMEX_LOG_LEVEL=error|warn|info|debug`，缺省 **info**，大小写不敏感，非法值回落到 info。
- 经 `process.env` 读取（`loadEnv()` 已在启动时跑完；本模块不 import `loadEnv`）。
- `mesh-log.ts` 的 `logLine`/`infoLine` 走 info，`warnLine` 走 warn，新增 `debugLine`。

`rtcLog()` 按 **event 名** 分级（`rtc-log.ts` 的 `RTC_DEBUG_EVENTS`）：

| 级别 | event | 原行为 | 调用点 |
|---|---|---|---|
| **debug** | `dial start` | 无差别 `console.log` | `rtc-peer-manager.ts` connectToPeer |
| **debug** | `signal send` / `signal recv` | 同上（含 SDP 类型字段、wake） | `rtc-peer-manager.ts`、`peer-manager.ts` wake |
| **debug** | `signal`（ICE candidate 行） | `rtcLogCandidate` → `rtcLogRateLimited(..., 'signal')` | `rtc-log.ts:136` |
| **debug** | `datachannel created` / `datachannel received` | 同上 | `rtc-peer-manager.ts` |
| **debug** | `gathering` | 同上 | `rtc-peer-manager.ts` ICE gathering |
| **debug** | `selected pair` | 同上 | `rtc-peer-manager.ts` |
| **debug** | `upgrade retry`（含 `cause=breaker_cooling`） | 同上；熔断冷却期的「我在等」噪声 | `peer-manager.ts` |
| **info** | `breaker trip` / `breaker reset` | 保持 | `rtc-dial-breaker.ts` |
| **info** | `dial failed`（仍 60s 限速 + 聚合 count） | 保持 | `rtc-log.ts` / `peer-manager.ts` |
| **info** | `ice` / `ice failed` / `peer state` | 状态迁移，运维需要 | `rtc-peer-manager.ts` |
| **info** | `datachannel open` / `error` / `closed` | 状态迁移 | `rtc-peer-manager.ts` |
| **info** | `liveness timeout` / `buffer overflow` / `ctl failed` | 故障信号 | liveness / fanout / peer-manager |

未列名的 `rtcLog` event 默认 **info**（宁可多留运维线索）。

Webhook：`events/channels/webhook.ts` 在 webhook 数为 **0** 时不再打印 `[events] refreshed config: 0 webhooks`（`webhookConfigRefreshLine(0) === null`）；count > 0 仍为 info。

### 2. 连接日志带上下文（O4）

- `[ws] client connected`：先 `bindSocket` 再打日志，一行，`session=<id> carrier=<kind>`，级别 **debug**。
- `[ws] client disconnected`：一行，补 `session` / `carrier` / `code` / `reason`（换行已压成空格）。
  - 正常关闭 `1000`/`1001` → **debug**
  - 其余（含 `1006`）→ **info**

### 3. macOS 日志轮转（O3 part 2）

**方案：网关进程自己打开、写入、按行边界 rename 轮转 `tmex.log` / `tmex.err.log`，不 truncate 已被 launchd 打开的 fd。**

为什么不是别的：

- launchd `StandardOutPath` 是子进程 fd 1 的打开方式，**外部 truncate 会留稀疏空洞**（任务硬约束）。
- 不能改 Linux：`StandardOutput=journal` 原样保留，journald 已轮转。
- 不能把 plist 改成 `/dev/null`：升级瞬间若新 plist + 旧网关会丢日志；`scripts/health-check.sh` 与现有排障路径都指向 `<installDir>/tmex.log`。
- `run.sh` 本任务不能改（`install.ts` 非本任务文件）。轮转必须能在「只换 runtime」时生效：`run.sh` 已 export `TMEX_INSTALL_DIR`。

实现（`apps/gateway/src/log/rotate.ts`）：

- `RotatingFileWriter`：行缓冲，只在 `\n` 边界落盘；`size + line > maxBytes` 且当前文件非空时才 rotate，**从不把一行拆进两个文件**。单行超过 cap 会整行写入再在下一行 rotate。
- 轮转：`close` → 丢掉最老的 `.{N-1}` → `.1`→`.2` … → 当前文件 rename 为 `.1` → `openSync(path, 'a')`。同步 `renameSync`/`writeSync`，单线程写，无交错半行。
- 接管 stdio：拦截 `process.stdout/stderr.write` 与 `console.log/info/debug/warn/error`（Bun 的 `console.log` 可能绕过 `stdout.write`）。不把数据再写回 launchd 的原 fd，避免双写。rotate 后尝试 `dup2` 把 fd 1/2 指到新文件，释放 launchd 打开的旧 inode（失败则 JS 路径仍走 rotator；原 fd 闲置、不再增长）。
- 安装条件：`NODE_ENV=test` 默认不装（避免劫持测试 runner）；darwin + production + `TMEX_INSTALL_DIR`，或显式 `TMEX_LOG_FILE`。`mesh-log.ts` 模块加载时 `maybeInstallProcessLogRotation()`。
- 默认 **16 MiB / 文件 × 3 代**（当前 + `.1` + `.2`，合计 ≤ 48 MiB）。`TMEX_LOG_MAX_BYTES`、`TMEX_LOG_GENERATIONS` 可覆盖。路径：`TMEX_LOG_FILE` / `TMEX_LOG_ERR_FILE`，否则 `$TMEX_INSTALL_DIR/tmex.log` 与 `tmex.err.log`。
- plist（`packages/app/src/lib/service.ts`）：**仍** `StandardOutPath=tmex.log`（运维路径不变、启动极早期日志仍落盘）；新增 `EnvironmentVariables.TMEX_LOG_FILE` / `TMEX_LOG_ERR_FILE`，升级 rewrite plist 后路径显式。Linux unit 未改。
- 安装目录是 versioned `current/`，日志在 **installDir 根**（与 `run.sh`/`app.env` 同级），升级不换路径。

## 验证

- 新测试：`src/log/level.test.ts` — 每个 level 只发出对应子集；RTC chatter 在 info 下为 0、breaker/ice failed 仍在；ws connect debug / 异常断开 info；webhook 0 条无输出。
- 新测试：`src/log/rotate.test.ts` — 写穿 cap 后出现 `.1`/`.2`、无 `.3`；拼接各代后行号连续无丢失、无半行；超长单行不拆文件。
- `cd apps/gateway && bun test`：3794 pass / **2 fail**（`PeerManager > replay cache is per-peer…`、`multi-hub … token created on A survives A crash`，与日志无关的既有 flake；基线是 3 fail + 2 errors）。本任务引起的 `rtc-peer-manager`「structured rtc logs」与 `peer-manager`「upgrade retry」已把用例切到 `TMEX_LOG_LEVEL=debug`。
- `cd packages/app && bun test`：687 pass / **1 fail**（已知 cpu-features）。
- `bunx tsc --noEmit -p .`：gateway **0**（基线 21）、app **1**（基线 1，`Cannot find type definition file for 'node'`）。
- `bunx biome check` 对全部改动文件通过。

未在浏览器里验证（无 UI 变更）。未碰生产 `~/Library/Application Support/tmex/`、未碰名为 `tmex` 的 tmux session、未起 dev server。
