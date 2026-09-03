# S1 结果 — 删除已证明的死代码

工作区：`/Users/konata/code/tmex-r21`（`feat/round21-perf-idle-slim`）。
日期：2026-09-03。

每个候选都重新用 ripgrep 验证后再动手。删掉承重代码比留下 50 行更糟，所以有疑点一律保留。

合计：`git diff --stat` **−1599 / +5**（含 spike 脚本）。未改 `package.json`、allowlist、i18n 生成物。

---

## 验证摘要

| 包 | tests | tsc `--noEmit` | 相对基线 |
| --- | --- | --- | --- |
| gateway | 3705 pass / 5 fail / 1 error（排除 `peer-manager*.ts`；失败项均为本轮已知 flake） | 1（`peer-manager.ts` RtcWakePorts，AB 任务文件，非本任务） | 基线 21 tsc；tests 因排除 peer-manager 少约 80 条。全量第一次跑被 AB 半成品 `sendPeerCtl is not a function` 拖死，故排除对方文件重跑 |
| fe `bun test src/` | **1743 pass** | 0 | 验收 1742 |
| app | 686 pass / **1 fail**（已知 `cpu-features stub plugin`） | 1（`Cannot find type definition file for 'node'`） | 与基线一致 |
| shared | **451 pass** | 0 | 验收 447 |
| api-client | **155 pass** | 3（既有 `client.test.ts` / `files-download.test.ts`） | tsc 基线 5，未超 |
| biome | 30 个改动文件 `Checked … No fixes applied` | — | — |
| `bun run build:fe` | 成功（5444 modules，8.58s） | — | 证明删掉的 barrel 没有被 bundler 入口引用 |

gateway 5 fail + 1 error 与验收列出的已知 flake 一致：

- `multi-hub … token created on A survives A crash`
- `stream failover … legacy HELLO/DEVICE_CONNECT/SUBSCRIBE/SELECT`
- `large raw-body push` 两条 24 MiB
- `RtcPeerManager > ice failed summary lists local and remote candidate types`
- unhandled `channel closed before open`

未起 dev server，未碰生产 tmex / 名为 `tmex` 的 tmux session。

---

## 1. Dead barrels

`package.json` exports 核过：gateway / fe / app **没有** 把这些 barrel 写成具名 subpath。`packages/api-client` 只有通配 `"./*": "./src/*.ts"`（`@tmex/api-client/local` 会解析到不存在的 `src/local.ts`，不是 `local/index.ts`）。`packages/shared` 的 `"./auth"` 是另一个包，未动。

| 候选 | grep | 裁决 | 行数 |
| --- | --- | --- | ---: |
| `apps/gateway/src/mesh/index.ts` | `from '\.\./mesh'` / `from '\./mesh'` / `gateway/src/mesh'` 在 `apps/gateway`：**0**。`packages/app` 也无 `src/mesh'` 桶导入 | **deleted** | 127 |
| `apps/gateway/src/tls/index.ts` | `from '\.\./tls'` / `from '\./tls'` 在 `apps/gateway`：**0** | **deleted** | 15 |
| `apps/gateway/src/tunnel/index.ts` | 同上 tunnel：**0**（`runtime.ts` 写的是 `./tunnel/manager`） | **deleted** | 11 |
| `apps/fe/src/auth/index.ts` | `from '@/auth'`（无后续路径）：**0**。消费者全是 `@/auth/NodeLoginButton` 等深路径 | **deleted** | 13 |
| `packages/app/src/tls/index.ts` | `from '\.\./tls'` / `from '\./tls'` / 以 `/tls'` 结尾：**0**。实际是 `../tls/cert-authority` | **deleted** | 43 |
| `packages/api-client/src/local/index.ts` | `@tmex/api-client/local'`（无后续路径）：**0**。全是 `local/tls-api` / `local/types` 等 | **deleted** | 6 |

---

## 2. §1.2 死导出

| 符号 | grep | 裁决 | 行数 |
| --- | --- | --- | ---: |
| `backupInstallArtifacts` / `restoreInstallArtifacts`（`install.ts`） | 全仓仅定义处。`commands/upgrade.ts` 走 `staging/<txnId>` + rename（:111–153, :310）；`upgrade-apply.ts` 也是 staging 目录，无 copy-backup 调用 | **deleted**（顺带去掉只被它们使用的 `copyFile` / `resolve` import） | 66 |
| `setAccessGuardNow` / `createAccessGuard` / `AccessGuardOptions` | 仅 `access-guard.ts` | **deleted** | 23 |
| `isHubAuthRecordType` / `nodesBlockingHubAuthRecords` | 仅 `hub-authorization.ts`。顺带去掉已无用的 `HUB_AUTH_RECORD_TYPES` import | **deleted** | 12 |
| `warnLine` / `infoLine`（`mesh-log.ts`） | **B1 已接上**：`log/level.test.ts` 调用 `warnLine`/`debugLine`；B1-result 写明 `logLine`/`infoLine`→info、`warnLine`→warn | **kept**（探索时是死的，本轮已被点亮） | 0 |
| `parsePidFileContents` | 仅定义；`parsePidFileRecord` 仍被使用 | **deleted** | 4 |
| `canonicalEventFrameBytes` | — | **kept**（canonical 硬排除；另一 agent 正在接线） | 0 |
| `resetSharedDirectDialLimiter` | 仅定义 | **kept**（`peer-ws-race.ts` 硬排除） | 0 |
| `sha256Of` | 仅定义。`verifyTarballSha256` 用的是 `sha256Hex` | **deleted**（顺带去掉 `createHash` import） | 5 |
| `teamDomainFromAuthDomain` | 仅定义 | **deleted** | 8 |
| `accessStatusFrom` | 仅定义；同文件 `emptyAccessStatus` / `computeAccessEffective` 仍活 | **deleted** | 27 |
| `readKeepAlivePool` | 仅定义 | **kept**（`packages/panels` 硬排除） | 0 |
| `setGatewayEventLoopLagForTest` | 仅定义。测试用的是 `stopGatewayEventLoopLagForTest` | **deleted** | 5 |
| `normalizeHubTrustUrl` | 仅定义；同文件 `tryCanonicalHubUrl` 仍调 `canonicalHubUrl` | **deleted** | 4 |
| `minHubTokensVersion` | 仅定义。顺带去掉无用的 `MIN_HUB_TOKENS_VERSION` import | **deleted** | 5 |
| `optionalString`（`mesh/ctl.ts`） | 仅定义 | **deleted** | 8 |
| `DISCONNECT_ERROR_TYPES` | 仅定义；映射表 `BRIDGE_EVENT_BY_ERROR_TYPE` 仍活 | **deleted** | 9 |
| `TMUX_PASSTHROUGH_PREFIX`（字符串） | 仅定义；`TMUX_PASSTHROUGH_PREFIX_BYTES` 仍被 passthrough handler 使用 | **deleted** | 1 |
| `Lines`（prompt components） | 仅定义；`Doc`/`Section`/`Item` 仍活 | **deleted** | 3 |
| `TLS_RENEW_WINDOW_DAYS` | 仅定义 | **deleted** | 3 |
| `DIRECT_ADDON_FILENAME` | 仅定义。顺带去掉因此而多余的 `NATIVE_ADDON_FILENAME` import | **deleted** | 9 |
| `decodeTermResize` + 本地 `TermResizePayload` | 仅 helper 内。`decodeTermInput` / `decodeTmuxSelect` / `decodeTermHistory` 仍被 spec 引用 | **deleted** | 16 |
| `pickHeader` | 仅定义；`collectTmexHeaders` 仍活 | **deleted** | 4 |
| `notWriterBody` | 仅定义。测试直接拼 `{ code: HUB_NOT_WRITER, … }` | **deleted** | 10 |
| weixin `MESSAGE_STATE_GENERATING` / `ITEM_TYPE_*` | — | **kept**（第 1 组：逆向协议常量表，成组保留） | 0 |
| rtc `@deprecated` 别名（§1.4） | — | **kept**（`rtc/**` 硬排除） | 0 |
| `parseSdpFingerprint`（`packages/app/.../native-datachannel.ts`） | app 这份只被自己的测试引用；生产指纹解析在 `@tmex/shared/auth` 与 `ws-client` | **deleted**（第 1 组；测试 describe 一并删） | 11 + 14 测试 |

---

## 3. Zombie contract types（`packages/shared/src/contracts/*`）

`export * from './contracts/…'` 仍在 `@tmex/shared` 主入口。只删**外部 0 引用、且不是活类型字段**的导出。

| 文件 | grep 结论 | 裁决 | 行数 |
| --- | --- | --- | ---: |
| `agent.ts` 11 个 request/response + 漏网的 `CreateAgentSessionRequest` | 全仓仅定义。api-client 自己另有一份 `CreateAgentSessionRequest`，**不**从 shared 进口 | **deleted**。DTO（`AgentSessionDto` 等）保留 | 73 |
| `websocket.ts` 报告列出的 10 个 + 报告误判仍被 borsh 复用的 `TmuxSelectPayload` / `TermInputPayload` / `TermResizePayload` / `TermHistoryPayload` | `packages/shared` 内这四个名字只出现在 contracts 文件。borsh `convert.ts` 只进口 `StateSnapshotPayload` / `EventTmuxPayload` / `EventDevicePayload`。fe helper 里的同名 interface 是本地副本 | **deleted** 死信封。三件活 payload **kept** | 96 |
| `system.ts`：`StagedUpgradePackageResponse` `RestartGatewayResponse` `MeshUpgradeErrorCode` `MeshUninstallError` `MeshUpgradeLatest` `MeshUpgradeError` | 类型名 0 外部引用（`handleMeshUpgradeLatest` 是函数名） | **deleted** | 44 |
| `UninstallState` | 被活的 `UninstallStatus.state` 使用（`system/uninstall.ts`） | **kept** | 0 |
| `tunnel.ts`：`TunnelJobState` / `TunnelAuthStatus` / `TunnelConfigStatus` / `TunnelProcessStatus` | 0 外部**名字**引用，但是 `TunnelStatusResponse` / `TunnelJobStatus` 的字段类型，那些响应类型是活的 | **kept**（内联会改公共 API 形状，不是纯删除） | 0 |
| `llm.ts` `UpdateAgentLlmSettingsResponse` | 仅定义。`UpdateAgentLlmSettingsRequest` / `GetAgentLlmSettingsResponse` 仍被 panels / api-client 使用 | **deleted** | 4 |
| `telegram.ts` `CreateTelegramBotRequest` / `UpdateTelegramBotRequest` | 仅定义。`ListTelegramBotsResponse` 仍活 | **deleted** | 14 |
| `weixin.ts` `CreateWeixinAccountRequest` / `UpdateWeixinAccountRequest` | 仅定义。list/login 响应仍活 | **deleted** | 12 |
| `local-auth.ts` `SetLocalAuthRequest` | 仅定义。`BootstrapLocalAuthRequest` / `LocalAuthStatus` 仍活 | **deleted** | 5 |
| `site-settings.ts` `UpdateSiteSettingsResponse` | 仅定义。`UpdateSiteSettingsRequest` / `GetSiteSettingsResponse` 仍活 | **deleted** | 4 |
| files.ts 等其余「见脚本输出」 | `CreateFileRootRequest` / `ListFilesResponse` / `AuthTotpRecordResponse` 等**有**外部引用 | **kept**（未列名的不猜） | 0 |

---

## 4. Spike scripts

| 文件 | grep | 裁决 |
| --- | --- | --- |
| `dump-tui.py` | `apps/fe/tests/theme-notify-2031.spec.ts` 按路径调用；`docs/appearance/2026070501-*.md` 引用 | **kept** |
| 其余 10 个（`analyze-tui.py` `build-tmux.sh` `pty-harness.py` `run-all.sh` `run-container.sh` `sgr-window.py` `spike-assert.ts` `spike-up.sh` `test-runner.sh` `u2-inject.sh`） | 文件名只在 `scripts/spike-theme/` 内部互相引用 + EX4 报告。无测试/脚本按路径调用 | **deleted**（888 行 / ~60 KB） |

---

## 5. `scripts/health-check.sh` — **kept**

探索认为端口写死 3000/8080、无外部命中。本轮 **B1-result.md** 把它写成排障路径：「`scripts/health-check.sh` 与现有排障路径都指向 `<installDir>/tmex.log`」。

读过脚本：

- 默认 `localhost:3000` / `8080` 确实不是现行端口，但 `TMEX_HOST` / `TMEX_GATEWAY_HOST` 可覆盖。
- 失败时打印 `~/Library/Application Support/tmex/tmex.log`（任务要求：有任何疑点就留）。

因此保留。它不是死文件，是一份过时但仍被本轮日志任务当作运维线索的脚本。

---

## 6. 顺手修的 bug

`apps/fe/tests/mobile-keyboard-avoidance.spec.ts`：

```ts
import type { KeyboardBehaviorMode } from '@tmex/stores';
```

原先 `from '../src/stores/ui'`，该目录不存在。类型在 `packages/stores/src/ui.ts`，与 `packages/terminal-ui/src/hooks/use-keyboard-avoidance.ts` 一致。`import type` 会被擦除，所以 Playwright 一直没报。

---

## 明确未动（有用结果，不是失败）

| 项 | 原因 |
| --- | --- |
| canonical 子系统全部 | 硬排除；另一 agent 正在接线 |
| `mesh/{peer-manager,mesh-runtime,peer-ws-race,rtc/**,stream-replay-state}` | 硬排除 |
| `packages/{ws-client,stores,ghostty-terminal,terminal-ui,panels,ui}` | 硬排除 |
| `warnLine`/`infoLine` | B1 本轮已使用 |
| tunnel 嵌套状态类型、`UninstallState` | 是活响应的字段类型 |
| weixin ilink 协议常量 | 第 1 组建议留 |
| `scripts/health-check.sh` | 见 §5 |
| `dump-tui.py` | e2e 按路径调用 |
| i18n locale JSON / 生成物 | 本轮禁止 |
| `package.json` / allowlist | 本轮禁止 |
| §3 DO NOT REMOVE 清单（vendor wasm、字体、drizzle、min-version 闸门、legacy encode 夹具、构建入口等） | 未碰 |
