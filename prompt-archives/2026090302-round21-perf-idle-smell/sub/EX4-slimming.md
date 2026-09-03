# EX4 — 可安全删除 / 可合并清单（只读调查）

工作区：`/Users/konata/code/tmex-r21`（只读，未改动任何源文件）
日期：2026-09-03

## 0. 度量基线

| 维度 | 数值 | 取数方式 |
| --- | --- | --- |
| 非生成 TS/TSX 总行数 | 451,506（src 229,333 / test 222,173） | `git ls-files '*.ts' '*.tsx'` + `wc -l`，按 `*.test.*` / `*.spec.*` / `*.integration.*` / `*.bench.*` 拆分 |
| 测试文件数 | 808 | `find apps packages -name '*.test.ts' -o …` |
| `apps/fe/dist` 总体积 | 29 MB（fonts 21 MB + assets 8 MB） | `du -sh`，构建产物为今日 10:28 的新鲜产物 |
| FE **首屏 eager** JS | `assets/index-BKi60w-r.js` 1,189,792 B raw / **366,749 B gzip** | `wc -c` + `gzip -9c \| wc -c` |
| FE **首屏 eager** CSS | `assets/index-B5F4jiqE.css` 147,131 B raw / **23,045 B gzip** | 同上 |
| 首屏合计 | **≈ 390 KB gzip** | index.html 只 `<script src=index-*.js>` + `<link index-*.css>` |
| 懒加载重块（不进首屏） | mermaid.core 147 KB gz、wardley 147 KB gz、cytoscape 141 KB gz、markdown-preview 128 KB gz | dist/assets 逐文件 gzip |
| i18n 语言包（懒加载） | en_US 32 KB gz / zh_CN 34 KB gz / ja_JP 37 KB gz | 同上 |
| `prompt-archives/` | 16 MB（md 9.3 MB、diff 2.4 MB、patch 1.8 MB、png 1.9 MB） | `du`/`find -name '*.ext'` |
| `docs/` | 1.9 MB（其中 `docs/images/screenshot.png` 1.4 MB），55 个文件 | `du -sh docs/*` |
| `packages/theme/resources/fonts` | 16 MB / 15 个 woff2 | `du -sh` |

**方法**：用脚本重建了全仓 import 图（相对路径 + workspace `exports` map + `@/` alias + 动态 `import()` + `require()` + `mock.module()`），再做导出符号级引用计数（标识符出现索引，区分「本文件内」「其它非测试文件」「仅测试文件」）。脚本在 scratchpad，未写入仓库。

---

## 1. 删除候选（Removal candidates）

### 1.1 死代码 — 整文件（barrel 无人 import）

| 路径 | 体积 | 非用证据 | 置信 | 出错风险 | 用户可见 |
| --- | --- | --- | --- | --- | --- |
| `apps/gateway/src/mesh/index.ts` | 127 行 / 2,934 B | import 图：inbound = 0。`rg "from '\./mesh'\|from '\.\./mesh'\|mesh/index"` 全仓唯一命中是 `packages/app/src/commands/mesh.test.ts:7`（另一个同名文件）。所有消费者都直接深路径 import（`./mesh/peer-manager` 等） | HIGH | 无 | 否 |
| `packages/app/src/tls/index.ts` | 43 行 / 1,181 B | inbound = 0；`rg "from '\.\./tls'"` 无命中，实际消费者写 `../tls/cert-authority`、`../tls/acme-service` 深路径（enroll.ts:30、pem.test.ts:2、assemble.test.ts:39 …） | HIGH | 无 | 否 |
| `apps/gateway/src/tls/index.ts` | 15 行 / 347 B | inbound = 0；`rg "from '\./tls'\|from '\.\./tls'"` 在 apps/packages 下 0 命中 | HIGH | 无 | 否 |
| `apps/fe/src/auth/index.ts` | 13 行 / 548 B | inbound = 0；`rg "from '@/auth'"` 0 命中（全仓 `auth/index` 命中全部属于 **另一个包** `@tmex/api-client/auth/index`） | HIGH | 无 | 否 |
| `apps/gateway/src/tunnel/index.ts` | 11 行 / 388 B | inbound = 0；`rg "from '\./tunnel'\|from '\.\./tunnel'"` 0 命中 | HIGH | 无 | 否 |
| `packages/api-client/src/local/index.ts` | 6 行 / 169 B | inbound = 0；消费者全部写 `@tmex/api-client/local/tunnel-api` / `local/tls-api` / `local/types` 深路径 | HIGH | 无 | 否 |

合计 215 行 / 5.5 KB。这些 barrel 是「写完没人用」的死出口，删掉同时会让 `packages/*` 的 `exports` 通配 (`"./*"`) 少一条无效路径。

### 1.2 死代码 — 导出符号（0 外部引用 且 本文件内也只出现 1 次）

全仓共 **90 个**真死导出（22 function / 9 const / 24 type / 35 interface）。代码类 31 个：

| 文件:行 | 符号 | 体积 | 证据 | 置信 | 风险 |
| --- | --- | --- | --- | --- | --- |
| `packages/app/src/lib/install.ts:194,221` | `backupInstallArtifacts` / `restoreInstallArtifacts` | ~55 行 | `rg` 全仓仅命中定义处，连测试都没有。现行升级走 `commands/upgrade.ts` 的 `staging/<txnId>` + rename 换目录（upgrade.ts:111-153,310），不再用 copy-backup/restore | HIGH | 低（是崩溃安全升级器之前的遗留实现） | 否 |
| `apps/gateway/src/tunnel/access-guard.ts:56,68` | `setAccessGuardNow` / `createAccessGuard` | ~15 行 | 同上，0 引用（同文件的 `setAccessGuardFetch`/`resetAccessGuardForTests` 有引用，这两个没有） | HIGH | 低 | 否 |
| `apps/gateway/src/hub/hub-authorization.ts:157,198` | `isHubAuthRecordType` / `nodesBlockingHubAuthRecords` | ~10 行 | 0 引用；`nodesBlockingMinVersion`（被它包一层）本身有引用 | HIGH | 低 | 否 |
| `apps/gateway/src/mesh/mesh-log.ts:21,25` | `warnLine` / `infoLine` | 6 行 | 0 引用；同文件 `logLine` 大量使用 | HIGH | 无 | 否 |
| `apps/gateway/src/weixin/ilink/types.ts:13,18,19,20` | `MESSAGE_STATE_GENERATING`、`ITEM_TYPE_VOICE/FILE/VIDEO` | 4 行 | 0 引用 | HIGH | **建议保留**：这是逆向出的协议常量表，成组保留有文档价值 | 否 |
| `apps/gateway/src/system/upgrade.ts:961` | `parsePidFileContents` | 3 行 | 0 引用（`parsePidFileRecord` 有用） | HIGH | 无 | 否 |
| `apps/gateway/src/ws/canonical/encoded-size.ts:274` | `canonicalEventFrameBytes` | 5 行 | 0 引用 | HIGH | 无 | 否 |
| `apps/gateway/src/mesh/peer-ws-race.ts:92` | `resetSharedDirectDialLimiter` | 7 行 | 0 引用（测试也没用） | HIGH | 低 | 否 |
| `packages/app/src/lib/upgrade-verify.ts:30` | `sha256Of` | 3 行 | 0 引用 | HIGH | 无 | 否 |
| `apps/gateway/src/tunnel/access-sanitize.ts:15` | `teamDomainFromAuthDomain` | 7 行 | 0 引用 | HIGH | 无 | 否 |
| `apps/gateway/src/tunnel/access-store.ts:104` | `accessStatusFrom` | ~6 行 | 0 引用 | HIGH | 无 | 否 |
| `packages/panels/src/device-console/terminal-keep-alive.ts:269` | `readKeepAlivePool` | 3 行 | 0 引用 | HIGH | 无 | 否 |
| `apps/gateway/src/ws/event-loop-lag.ts:132` | `setGatewayEventLoopLagForTest` | ~4 行 | 0 引用（名字说是给测试，但测试没用） | HIGH | 无 | 否 |
| `apps/gateway/src/auth/hub-trust-store.ts:20` | `normalizeHubTrustUrl` | ~5 行 | 0 引用 | HIGH | 无 | 否 |
| `apps/gateway/src/hub/hub-tokens.ts:22` | `minHubTokensVersion` | 3 行 | 0 引用 | HIGH | 无 | 否 |
| `apps/gateway/src/mesh/ctl.ts:27` | `optionalString` | ~4 行 | 0 引用 | HIGH | 无 | 否 |
| `apps/gateway/src/push/connection-bridge.ts:4` | `DISCONNECT_ERROR_TYPES` | 1 行 | 0 引用 | HIGH | 无 | 否 |
| `apps/gateway/src/tmux-client/pane-stream/parser-state.ts:9` | `TMUX_PASSTHROUGH_PREFIX` | 1 行 | 0 引用 | HIGH | 无 | 否 |
| `apps/gateway/src/agent/prompts/components.ts:12` | `Lines` | 1 行 | 0 引用 | HIGH | 无 | 否 |
| `packages/api-client/src/local/tls-types.ts:137` | `TLS_RENEW_WINDOW_DAYS` | 1 行 | 0 引用 | HIGH | 无 | 否 |
| `packages/app/src/commands/direct.ts:369` | `DIRECT_ADDON_FILENAME` | 1 行 | 0 引用 | HIGH | 无 | 否 |
| `apps/fe/tests/helpers/ws-borsh.ts:248` | `decodeTermResize` | ~6 行 | 0 引用（e2e helper 里的死函数） | HIGH | 无 | 否 |
| `scripts/hub-e2e/driver/hash.ts:6` | `pickHeader` | ~4 行 | 0 引用 | HIGH | 无 | 否 |
| `apps/gateway/src/mesh/integration/multi-hub-harness.ts:409` | `notWriterBody` | ~3 行 | 0 引用 | HIGH | 无 | 否 |

代码类合计 ≈ **160–200 行**。

### 1.3 死代码 — `packages/shared/src/contracts/*` 的僵尸契约类型

| 文件 | 0 外部引用的导出数 | 具体符号 |
| --- | --- | --- |
| `contracts/agent.ts` | 11 | `ListAgentSessionsResponse` `UpdateAgentSessionRequest` `AgentSessionResponse` `ListAgentMessagesResponse` `PostAgentMessageRequest` `ListAgentQueuedMessagesResponse` `EnqueueAgentMessageRequest` `EditQueuedAgentMessageRequest` `ListAgentConfirmationsResponse` `DecideAgentConfirmationRequest` `DecideAgentConfirmationResponse` |
| `contracts/websocket.ts` | 10 | `WsMessageType` `WsMessage` `DeviceConnectPayload` `DeviceDisconnectPayload` `TmuxSelectWindowPayload` `TermPastePayload` `CreateWindowPayload` `CloseWindowPayload` `ClosePanePayload` `RenameWindowPayload` |
| `contracts/system.ts` | 7 | `StagedUpgradePackageResponse` `RestartGatewayResponse` `MeshUpgradeErrorCode` `UninstallState` `MeshUninstallError` `MeshUpgradeLatest` `MeshUpgradeError` |
| `contracts/tunnel.ts` | 4 | `TunnelJobState` `TunnelAuthStatus` `TunnelConfigStatus` `TunnelProcessStatus` |
| `contracts/{llm,telegram,weixin,files,local-auth,site-settings}.ts` | 9 | 见脚本输出 |

**合计 41 个导出、约 150 行类型声明。**

证据：`packages/shared/src/contracts/` 共 188 个导出类型；`packages/api-client/src/**` 另外定义了 94 个类型，两组**名字零重叠**（`comm -12` 结果为空）。也就是说 REST 侧真正在用的是 api-client 自己的类型，`contracts/` 里这 41 个是「写了但没人接」的文档化残留。`contracts/websocket.ts` 尤其明显：`WsMessage` / `WsMessageType` 这套 JSON 信封是 Borsh 化之前的协议，现在只剩 `StateSnapshotPayload` / `EventTmuxPayload` / `EventDevicePayload` / `TermInput/Resize/History/TmuxSelectPayload` 还在被 borsh 层复用。

置信 HIGH（纯类型，无运行时）；风险 LOW；用户不可见。**注意**：`contracts/` 有「协议记录」的意图，删之前建议和维护者确认是否要保留作为 API 文档。

### 1.4 `@deprecated` 别名（RTC 拨号熔断器）

| 位置 | 符号 | 证据 | 置信 |
| --- | --- | --- | --- |
| `apps/gateway/src/mesh/rtc/rtc-dial-breaker.ts:10` | `RTC_DIAL_BREAKER_MS_DEFAULT` | 只在 `rtc/index.ts:95` 被 re-export，无任何最终消费者 | HIGH |
| 同文件 `:160` | `RtcDialBreaker.shouldSkip()` | `rg "\bshouldSkip\b"` 全仓只命中定义处 | HIGH |
| 同文件 `:260` | `RtcDialBreaker.noteSuccess()`（已是 no-op） | 唯一引用是 `rtc-dial-breaker.test.ts:144` 那条「no longer reset cooling」断言 | HIGH（需同步改测试） |
| 同文件 `:70,137-138` | `RtcDialBreakerOptions.onOpen` | 只有本文件内的适配分支引用，无外部传入者 | HIGH |

注释自己写了「保留别名以免旧测试引用断裂」，而那些旧测试已经不存在了。约 20 行 + 1 条测试。

### 1.5 一次性 spike 脚本

| 路径 | 体积 | 证据 | 置信 | 风险 |
| --- | --- | --- | --- | --- |
| `scripts/spike-theme/` 中除 `dump-tui.py` 外的 10 个文件（`analyze-tui.py` `build-tmux.sh` `pty-harness.py` `run-all.sh` `run-container.sh` `sgr-window.py` `spike-assert.ts` `spike-up.sh` `test-runner.sh` `u2-inject.sh`） | ~60 KB | 逐文件 `rg -l` 交叉引用：这 10 个文件**只互相引用**，无任何仓库外部消费者。唯一有外部消费者的是 `dump-tui.py`（被 `apps/fe/tests/theme-notify-2031.spec.ts:15` 和 `docs/appearance/2026070501-*.md` 引用） | MED-HIGH | 丢掉 mode 2031 那轮调查的复现装置；docs 里有该调查的记录但不引用这些脚本 | 否 |
| `scripts/health-check.sh` | 190 行 / 5 KB | `rg "health-check"` 全仓 0 外部命中。内容硬编码 `localhost:3000` / `localhost:8080` 和 `TMEX_ADMIN_PASSWORD=test123`——都不是本项目现行端口（9663/9883、dev 19663/19883），是极早期遗留 | HIGH | 无 | 否 |

### 1.6 i18n 死 key

**76 个** leaf key（共 2,010 个）在全仓（排除 `resources.ts` / `types.ts` / locale JSON 自身）既无全路径命中，也无任何后缀命中，且不是复数变体：

代表性分组（完整 76 条见附录 A）：
- `settings.language_en_US` / `language_zh_CN` / `language_ja_JP` / `languagePlaceholder`：曾经是「语言下拉」的静态标签，现在语言名走 locale manifest 的 `nativeName`。全仓无 `` t(`language_${...}`) `` 这类计算键（已 grep 确认）。
- `telegram.*` 9 条、`weixin.*` 13 条：机器人/微信设置页重做后的旧文案。
- `terminal.*` 11 条（`initFailed` `editorPlaceholder` `inputModeDirect` …）：终端输入模式重做的残留。
- `sshError.sshConfigRefNotSupported`：代码里实际用的是 `sshError.configRefNotSupported`（`apps/gateway/src/ws/error-classify.ts:11`）——这是一条**拼错的孤儿 key**。
- `apiError.file{OutsideRoots,NotADirectory,TooLarge,Binary}`：`apiError.*` 全部是字面量调用（已确认无 `` t(`apiError.${code}`) ``），所以这 4 条确实死。

置信 MED-HIGH（见「不要删」章节里列的计算键前缀，已从名单中排除）。收益：3 个 locale JSON 各瘦一点，`resources.ts`（416 KB）与 `types.ts` 联动缩小，前端每语言 chunk ~1-2 KB gz。

**执行注意（硬约束）**：`packages/shared/src/i18n/resources.ts` 与 `types.ts` 是 `bun run build:i18n` 生成物，**只能改 `packages/shared/src/i18n/locales/*.json` 再重新生成**，不得手改、不得 lint。

### 1.7 待确认的低置信项

| 项 | 为什么不敢下结论 | 能定论的检查 |
| --- | --- | --- |
| `packages/shared/bench/*.bench.ts`（2 个） | 没有任何 package.json script 引用，但可以手工 `bun packages/shared/bench/x.bench.ts` 跑；且它们是 `canonical-state.ts` 若干导出的唯一消费者 | 问维护者是否还跑；`apps/gateway/bench/*` 有 script 引用（`bench:parser` 等），对照看 |
| `prompt-archives/**/*.{diff,patch}`（4.2 MB） | 是历史评审产物，理论上可由 git 历史重建 | 按任务书默认 **KEEP**；只有在维护者明确说「diff 可弃」时才动 |
| `docs/images/screenshot.png`（1.4 MB，README 里按 640px 显示） | 不是死文件，是**没压过**的文件 | 重新导出为 640px WebP/PNG 可省 ~1.2 MB；纯优化，不是删除 |
| `apps/fe/public/{logo,tmex,tmex-maskable}.png`（580 KB） | 三张都在用（README、`system-routes.ts:41,47` 的 webmanifest、`index.html:19`、`shared/src/brand.ts:7`） | 同上，只能压缩不能删 |

---

## 2. 合并候选（Consolidation candidates）

用 10 行滑窗归一化哈希做了全仓克隆检测（排除测试、生成物、vendor）。下表按重复窗口数排序。

| A | B | 重复内容 | 谁是活的 | 缝（seam） | 置信 | 风险 |
| --- | --- | --- | --- | --- | --- | --- |
| `apps/fe/src/node/mesh-hubs.ts:187-235`（331 行） | `apps/fe/src/node/mesh-nodes.ts:561-610`（864 行） | 19 个重复窗口：`startPolling()` 的整套骨架——options 默认值、`schedule`/`delay` 注入、节流窗口 `runRefresh`/`requestRefresh`、`events.onStatusChange` / `onNodeEvent` 挂载、页面可见性补拉 | **两个都活**（`mesh-nodes` 供设备/节点侧栏，`mesh-hubs` 供多 hub 卡片） | 抽 `createThrottledPoller({intervalMs, throttleMs, refresh, now, visibility, events, schedule, delay})` 到 `apps/fe/src/node/` 新文件，两边各自只保留 `onNodeEvent` 过滤逻辑与 sweep | HIGH（重复是实的） | MED——`mesh-nodes` 多一层 `unknownSeen`/`authSeen` sweep 与 401 处理，抽取时要小心不要把节流语义改了 |
| `packages/api-client/src/download-transfer.ts`（132 行） | `packages/panels/src/files/bulk-transfer.ts`（382 行） | 25 个重复窗口：`DownloadPrepareEvent` 接口逐字重复、`prepareDownload()`（NDJSON 进度流解析 + downloadId/size/name 提取 + 错误映射）、leg2 读流计速循环 | **两个都活**：`bulk-transfer.ts:270` 在 REST 路径上直接调 `downloadFileWithProgress`，但在 direct/peer 传输路径上**自己又实现了一遍** `prepareDownload` | 把 `prepareDownload` + leg2 读流循环提到 `@tmex/api-client`，参数化 `fetch`（REST client vs peer transport），`bulk-transfer` 只保留通道选择与 toast | HIGH | MED——两条路径的取消/清理语义要逐条对齐（`download-transfer.ts` 有 downloadId best-effort 清理） |
| `apps/gateway/src/api/http.ts`（75 行） | `packages/app/src/runtime/http.ts`（76 行） | 33 个重复窗口，但 `diff` 显示实为「同主题不同实现」：`json()` vs `jsonOk()`（header 大小写不同）、`readJsonObjectBody()` vs `readJsonBody()` | 两个都活（gateway 路由 40 处用前者；runtime setup 路由用后者） | 只值得统一 `readJson*Body` 的 body 上限/错误形状；`json()` 的 header 差异是有意的（manifest content-type） | MED | LOW，但收益也低（~20 行） |
| `apps/gateway/src/system/upgrade.ts:865-880` | `packages/app/src/lib/upgrade-lock.ts:35-50` | 9 个重复窗口：pid 文件/锁文件的读写与陈旧判定 | 两个都活（gateway 侧自升级 vs CLI 侧 `tmex upgrade`） | 二者跨 workspace（gateway ↔ app），app 已经在多处直接 `import '../../../../apps/gateway/src/...'`，所以把锁实现收到 `apps/gateway/src/system/` 单点是可行的 | MED | MED——升级锁改错的代价是升级半途死锁，要配足测试 |
| `packages/panels/src/settings/{llm-provider-form-modal,telegram-bot-form-modal,weixin-account-form-modal}.tsx` | — | 4+7 个重复窗口：三个设置弹窗的表单壳（字段布局、保存/取消按钮排布、错误行） | 三个都活（分别是三个设置 tab） | 抽一个 `SettingsFormModal` 壳组件到 `packages/panels/src/settings/` | MED | LOW |
| `packages/shared/src/ws-borsh/index.ts` ↔ `kind.ts` | — | 48 个重复窗口 | **不是重复**：barrel 逐条 re-export `kind.ts` 的常量表，检测器把 export 清单当成了克隆 | — | — | 假阳性，忽略 |

---

## 3. 「看着像死的、其实是承重墙」——DO NOT REMOVE

| 目标 | 为什么看着像死的 | 承重证据 |
| --- | --- | --- |
| `packages/app/src/vendor/node-datachannel/**`（662 行 TS + LICENSE） | import 图里 13 个导出 0 引用（`Audio` `Video` `Track` `RtpPacketizer` …），像是没用的 vendored 面板 | ① 由 `packages/app/scripts/vendor-node-datachannel.ts` **脚本生成**，手改会被下次重生成覆盖；② 入口是**动态 import**：`packages/app/src/lib/native-datachannel.ts:146` `await import('../vendor/node-datachannel/index.ts')`；③ `packages/app/scripts/build-runtime.ts:116` 校验它被内联进 bundle |
| `packages/ghostty-terminal/src/assets/ghostty-vt.wasm`（542 KB） | 二进制大文件 | `vendor/ghostty` 是 git submodule，在本 worktree 里是**空目录**；没有 zig 工具链无法重建。`packages/app/scripts/copy-runtime-assets.sh` 把它拷进 `dist/runtime/assets/` 随包分发 |
| `packages/theme/resources/fonts/**`（16 MB / 15 个 woff2） | 占仓库和 fe-dist 体积大头（dist/fonts 21 MB，占 29 MB 产物的 72%） | ① 设置里 7 种等宽字体可切换，**用户可见功能**；② `apps/fe/public/fonts` 是指向它的相对 symlink，vite 原样拷进 dist；③ `packages/theme/src/exports-and-fonts.test.ts:56` 断言「15 个 woff2 仅存在于 packages/theme/resources/fonts」和 symlink target；④ 浏览器**按需**加载（`packages/theme/src/fonts/index.ts` 的 `loadTerminalFonts` 运行时注入 @font-face），不进 JS bundle。要瘦身只能是**产品决策**减少内置字体数量，不是「删死代码」 |
| `packages/theme/resources/fonts/NotoSansSymbols2-Regular.woff2` | 不在 `FONT_MANIFEST` 里，像孤儿 | 是**兜底符号字体**：`apps/fe/src/index.css:40-41` 静态 `@font-face`，`packages/theme/src/fonts/index.ts:11` `SYMBOL_FALLBACK`，`packages/terminal-ui/src/components/theme.ts:66` 列为内嵌 family |
| `packages/shared/src/i18n/{resources.ts,types.ts}`（7,554 + 2,274 行） | 巨大、重复 | **生成物**（`packages/shared/scripts/build-i18n.ts`）。AGENTS.md 明令：不得手改、不得 lint。改 i18n 只能改 `locales/*.json` 再 `bun run build:i18n` |
| `packages/theme/src/{themes.css,tokens.generated.css,fonts/manifest.generated.ts}` | 大且重复 | 生成物，分别由 `scripts/theme/build-theme-presets.ts`、`build-shortcut-tokens.ts`、`scripts/fonts/build-fonts.ts` 生成；`packages/theme/src/presets.test.ts:75` 有「未过期」断言 |
| `apps/gateway/drizzle/*.sql`（39 个迁移）+ `meta/_journal.json` | 老迁移看着可以压平 | 迁移是历史事实，压平会让已安装实例升级失败。**注意**：`meta/NNNN_snapshot.json`（1.9 MB）已经在 `packages/app/scripts/bundle-resources.sh:30` 打包时被 `find … -name '*_snapshot.json' -delete` 剔除，不随 npm 包分发；仓库里必须留着给 `drizzle-kit generate` |
| `MIN_HUB_TOKENS_VERSION='1.1.13'`（`packages/shared/src/uplink/codec.ts:42`）、`MIN_HUB_AUTH_RECORD_VERSION='1.1.13'`、`MIN_ROTATE_ROOT_KEEP_RECORD_VERSION='1.1.16'`（`packages/shared/src/auth/key-log.ts:68,70`）、`TERM_VIEWPORT_MIN_SERVER_VERSION='1.1.7'`（`packages/ws-client/src/server-features.ts:9`） | 当前发布 1.1.20，看着像「不再发布的旧版本兼容分支」 | mesh 里**每个 node 独立升级**，现网确实可能还有 1.1.7 的节点。这些是运行时兼容闸门，不是死分支 |
| `EncodeUplinkCtlOptions.legacy`（`packages/shared/src/uplink/codec.ts:585`）及 6 处 `if (legacy)` 编码分支 | `rg "legacy: true"` 只命中 `codec.test.ts`（13 处）与 `terminal-output-metrics.test.ts`（2 处），生产 0 调用 | 它是**测试夹具**：用来伪造「旧版 peer 发来的帧」，从而验证 decoder 的向后兼容。删掉编码侧就失去了对 decoder 兼容路径的覆盖 |
| `packages/shared/src/ws-borsh/legacy-{pane-fields,window-fields,snapshot-draft}.ts`（421 行 + 332 行测试） | 名字带 legacy | 活的：`state-snapshot-diff.ts:9-11` 依赖它们做 canonical → 旧版 `TmuxSession` 投影；`legacy` 只是「非 canonical 形状」的命名，不是废弃 |
| `apps/gateway/src/ws/legacy-{feed-broadcaster,event-delivery}.ts`（499 行） | 名字带 legacy | 活的：`apps/gateway/src/ws/index.ts:41` 直接 `import { LegacyFeedBroadcaster }`，`session-close.ts:7` 依赖类型。它与 `canonical-feed-session.ts` 并存是**协议双轨**（见 §2 备注），不是残留 |
| `packages/ghostty-terminal/src/selection-clipboard.ts` 与 `packages/shared/src/browser-clipboard.ts` 重复的 `writeTextToClipboard` | 克隆检测报 14 个重复窗口 | **有意重复**，源码里写了理由：「本包是零依赖的可独立发布包，不能引入 workspace 私有包，故保留本地副本」。`ghostty-terminal` 是独立发布的 npm 包 |
| `apps/fe/src/pages/settings/nodes/https/parts.tsx` 与 `.../setup/form-parts.tsx` | 克隆检测报 16 个重复窗口 | **有意重复**，文件头注释：「与 setup/ 的同类件刻意各自独立，两者文件范围不同」 |
| `packages/app/src/cli-auth-entry.ts`（119 行）、`packages/app/src/runtime/server.ts`（101 行） | import 图 inbound = 0 | 都是**构建入口**：`packages/app/scripts/build-runtime.ts:207,212` 分别把它们 `bun build` 成 `dist/runtime/server.js` 与 auth CLI；`packages/app/src/lib/auth-spawn.ts:53` 在开发态直接按路径 spawn |
| `packages/app/src/lib/test-master-key.ts`（4 行） | 极小、看着没人用 | 被 `import '../lib/test-master-key'`（副作用导入）在多个 `packages/app` 测试首行引用 |
| `apps/fe/tests/helpers/mesh-boot.ts`（507 行） | import 图 inbound = 0 | 由 `apps/fe/tests/helpers/mesh.ts:22` 以**字符串路径** spawn（`join('apps','fe','tests','helpers','mesh-boot.ts')`），不是 import |
| `scripts/spike-theme/dump-tui.py` | 在一堆 spike 脚本里 | 被 `apps/fe/tests/theme-notify-2031.spec.ts:15` 按路径调用 |
| `scripts/issue45-mouse-tui.py` | 孤零零一个 py | 被 4 个 e2e spec 按路径调用（`terminal-mouse-gestures` / `terminal-mouse-row-alignment` / `mobile-mouse-reporting` / `terminal-mouse-drag-recovery`） |
| 计算键前缀的 i18n key（不要按「全路径无命中」删） | 静态 grep 查不到 | 已确认的模板调用前缀：`notification.eventType.*`（`apps/gateway/src/events/channels/notification-format.ts:99`）、`watch.type.*` / `watch.typeDesc.*`、`deviceStatus.errorBadge.*`、`agent.tool.*`、`settings.terminal.shortcuts.action.*`、`files.error.*`、`settings.remoteAccess.**`（十余处）、`auth.errors.*`（`apps/fe/src/node/enrollment-engine.ts:610`）、`nodes.membership.${camel(kind)}Confirm.*`。我的死 key 名单已用「任意后缀命中」规则把这些排除在外 |
| 888 个「仅测试引用」的导出 | knip 之类工具会一股脑报出来 | 这是本仓刻意的可测试性缝（注入 `now`/`schedule`/`io`）。**不要**按「unused export」清理，只有上面那 90 个「0 外部引用且本文件内也只出现一次」的才是真死 |

---

## 4. 顺手能修的 bug（不是删除，但发现了）

| 位置 | 问题 |
| --- | --- |
| `apps/fe/tests/mobile-keyboard-avoidance.spec.ts:2` | `import type { KeyboardBehaviorMode } from '../src/stores/ui'` —— **`apps/fe/src/stores/` 目录不存在**。该类型现在在 `packages/stores/src/ui.ts:93`，正确写法是 `from '@tmex/stores'`（`packages/terminal-ui/src/hooks/use-keyboard-avoidance.ts:1` 就是这么写的）。因为是 `import type`，转译时被擦除，Playwright 不报错，所以一直没暴露 |
| `packages/shared/src/i18n/locales/*.json` | `sshError.sshConfigRefNotSupported` 拼错，代码用的是 `sshError.configRefNotSupported` |

## 5. 「没有发现」的项（诚实记录）

- **注释掉的代码块**：`rg "^\s*//\s*(const|let|return|if \(|await |import |export |function )"` 全仓只有 1 条命中，且是正常说明注释。**没有可清的注释代码**。
- **skip / todo 测试**：只有 `apps/fe/tests/ssh-device-connect.spec.ts:52` 一条条件 skip（缺环境变量），以及 `rtc-loopback.integration.ts:149` 的 `describe.skipIf(!nativeMod)`。**没有僵尸测试**。
- **`TODO` / `FIXME` / `HACK`**：apps + packages 下 0 命中。
- **`packages/ui` 组件**：29 个组件全部有外部消费者（最低 `progress` / `separator` 各 1 处）。**无死组件**。
- **`@tmex/panels` 的 19 条 exports 子路径**：全部至少 1 处消费。**无死出口**。
- **永久开/关的 feature flag**：扫了全部 `TMEX_*` 环境变量（60+ 个），没有发现恒定分支。`TMEX_HUB_URL` / `TMEX_HUB_URLS` 是互补而非新旧（`config.ts:307` `parseHubUrls(hubUrl, TMEX_HUB_URLS)`，两者都有文档）。

---

## 附录 A：76 个候选死 i18n key

```
common.pwaInstallTitle / pwaInstallHintIOSSafari / pwaInstallHintIOSChrome
device.addFirstDevice / noDevicesDescription / typeSSHBadge / sessionHint / deleteSuccess / createSuccess / updateSuccess
terminal.initFailed / deviceErrorWithType / noDeviceSelected / bellNotification / bellFallback / editorPlaceholder / editorClear / sendShortcut / inputModeDirect / inputModeEditor / newWindow
settings.sshReconnectRetries / languagePlaceholder / language_en_US / language_zh_CN / language_ja_JP / siteTab / notificationsTab / saveSettings
telegram.enableBot / authorizedChats / revokeAuth / tokenOptional / botCreated / botUpdated / botDeleted / authApproved / chatRemoved / applyTime
weixin.loginPending / loginConfirmed / pendingUsers / authorizedUsers / noPendingUsers / noAuthorizedUsers / revokeAuth / removeUser / authApproved / userRemoved / loadUsersFailed / userCount / applyTime
sshError.sshConfigRefNotSupported
websocket.upgradeFailed / invalidMessage
apiError.fileOutsideRoots / fileNotADirectory / fileTooLarge / fileBinary
notification.clickToJump
sidebar.addDeviceLink / openSettingsLink / openSettings / newWindow / orphanedSessions
agent.model.noProviders / agent.files.comingSoon / agent.session.noSessions / agent.session.privacyNotice
watch.rules.neverTriggered
validation.deviceNameRequired
files.upload.uploading
file.accessDenied
nodes.upgrade.upgradeAll / nodes.upgrade.allProgress
nodes.setup.precheck.docsHint
```

---

## 6. 依赖重量（npm deps）

方法：逐 workspace 把每个 `dependencies` / `devDependencies` 条目在**本包目录内**做 `from '<dep>'` / `import('<dep>')` / `require('<dep>')` / CSS `@import`/`@plugin` 搜索。以下每条我都独立复核过。

### 6.1 可直接删除（0 引用）

| 包 | 依赖 | 声明位置 | 证据 | 安装体积 | 置信 |
| --- | --- | --- | --- | --- | --- |
| `apps/fe` | `shadcn@^3.8.4` | **dependencies** | `rg "from 'shadcn\|require\('shadcn"` 全仓 0 命中。`apps/fe/package.json:11` 的 `shadcn` script 跑的是 `bunx --bun shadcn@latest`，刻意绕开本地副本 | 1.3 MB | HIGH |
| `apps/fe` | `tw-animate-css@^1.4.0` | dependencies | 除 `package.json` / `bun.lock` 外 0 命中。真正生效的是 `tailwindcss-animate`（`apps/fe/src/index.css:7` `@plugin "tailwindcss-animate";`） | 56 KB | HIGH |
| `apps/fe` | `@fontsource-variable/geist@^5.2.8` | dependencies | `rg fontsource` 全仓只命中 `apps/fe/package.json`。而且它是 Geist **Sans**，本项目用的是 `packages/theme` 自建的 Geist **Mono** Nerd Font 管线，完全无关 | 108 KB | HIGH |
| `apps/fe` | `autoprefixer@^10.4.20` | dev | 0 引用，且**全仓不存在任何 `postcss.config.*`**（`find -name 'postcss.config*'` 空） | 432 KB | HIGH |
| `apps/fe` | `postcss@^8.5.2` | dev | 同上；Tailwind v4 走 `@tailwindcss/vite`（`vite.config.ts:3,48`），自带流水线 | 332 KB | HIGH |
| `apps/gateway` | `@types/uuid@^10.0.0` | dev | 0 引用；`uuid@11` 自带 `.d.ts`，且 `@types/uuid@10` 是**上一个 major** 的桩 | — | HIGH |
| `packages/panels` | `ghostty-terminal` | dependencies | `rg "ghostty-terminal" packages/panels/src` 0 命中（真正的使用者是 `packages/terminal-ui`，16 处） | — | HIGH |
| `apps/fe` | `tailwind.config.ts`（**文件**，31 行） | — | Tailwind v4 只有在 CSS 里写 `@config` 才读 JS 配置；`rg "@config" -g '*.css'` 全仓 0 命中。反证：该文件自定义的 `bg-tertiary` / `accent-hover` / `color-bell` 在构建产物 `dist/assets/index-B5F4jiqE.css` 里 0 出现。唯一引用者是 `apps/fe/components.json:7`（shadcn CLI 元数据） | — | HIGH（删文件时顺手清 `components.json` 的 `tailwind.config` 字段） |

### 6.2 可用几行代码替代

| 包 | 依赖 | 证据 | 建议 |
| --- | --- | --- | --- |
| `apps/gateway` | `uuid@^11.0.5`（~788 KB） | 只有 5 个 `import { v4 as uuidv4 } from 'uuid'`（`api/webhook-routes.ts:2`、`db/file-roots.ts:2`、`api/device-routes.ts:2`、`api/weixin-routes.ts:2`、`api/telegram-routes.ts:2`）。同一份代码里 `randomUUID(` 已经用了 **83 次**（分布在 41 个文件） | 5 处改 `crypto.randomUUID()`，删 `uuid` + `@types/uuid` |

### 6.3 冗余重复声明（不是 bug，但有版本漂移风险）

`apps/fe/package.json` 里有 **14 个** 依赖是 0 本地引用、真正的使用者是某个 workspace 包（该包自己也声明了同一依赖）：`@base-ui/react`（owner `packages/ui`）、`@dnd-kit/{core,sortable,utilities}`、`highlight.js`、`katex`、`mermaid`、`react-markdown`、`rehype-highlight`、`rehype-katex`、`remark-gfm`、`remark-math`（owner `packages/panels`）、`class-variance-authority`/`clsx`/`tailwind-merge`（owner `packages/ui`）、`ghostty-terminal`（owner `packages/terminal-ui`）。

当前版本完全一致，所以没有实际问题；但 bun workspace 每个包有自己的 `node_modules`，**一旦哪一对漂移就会在 bundle 里出现同一个库的两份拷贝**。建议保留 `apps/fe` 直接 render 用到的那些，删掉纯转发的。置信 MED（要逐条确认 `apps/fe/src` 确实没有直接 import）。

### 6.4 依赖声明缺失（潜在 bug，不是瘦身）

1. `packages/app/tsconfig.json:10` `"types": ["node"]`，但**全仓没有任何 package.json 声明 `@types/node`** —— 实际解析到传递依赖里的 `@types/node@18`，而该包 `engines.node` 是 `>=20`。
2. 同一条 `"types": ["node"]` 把 bun 类型排除了，可 `packages/app` 里 `bun:test` 被 import 了 64 次（`@types/bun` 虽已声明但被 `types` 数组压掉）。
3. 六个包（`ui` `shared` `api-client` `ws-client` `ghostty-terminal` `notifications`）的 tsconfig 写 `"types": ["bun-types"]` 但没在自己的 package.json 里声明 `bun-types`，靠根 hoisting 才解析得到。

---

## 7. 前端包体积（apps/fe）

产物是今日 10:28 的新鲜构建；`ANALYZE=1` 重建复现出**逐字节相同的 content hash**，故下列数字可信。`vite.config.ts` 没有 `manualChunks`，prod 不出 sourcemap。

### 7.1 首屏实际下载

`dist/index.html` 只有 **1 个 `<script>`、0 个 `modulepreload`** —— 从 `main.tsx` 静态可达的一切都被压进单个 1.19 MB 文件。

| 首屏资源 | raw | gzip |
| --- | ---: | ---: |
| `assets/index-BKi60w-r.js` | 1,189,792 | **366,749** |
| `assets/index-B5F4jiqE.css` | 147,131 | **23,045** |
| 一个语言包（`zh_CN-DuULH_6A.js`） | 99,615 | 33,868 |
| **合计** | ~1.44 MB | **≈ 424 KB** |

### 7.2 首屏 chunk 构成（visualizer `renderedLength`，压缩前源字节）

`react-dom` 561 K · **`@base-ui/react`+utils 542 K（247 模块）** · `react-router` 213 K · `@tmex/ws-client` 148 K · **`@dnd-kit/*` 130 K** · `@tmex/panels` 120 K · `@tmex/stores` 118 K · `tailwind-merge` 94 K · `@tmex/shared` 83 K · `i18next` 81 K · `@tanstack/query-core` 74 K · `@floating-ui/*` 67 K · `@tmex/ui` 66 K · `sonner` 64 K · `@noble/hashes` 43 K · `@zorsh/zorsh` 29 K · `lucide-react` 23 K（49 个图标）

### 7.3 重库懒/急判定

| 库 | 首屏? | 证据 |
| --- | --- | --- |
| mermaid | **懒** ✅ | 43 个独立 chunk，首屏 0 字节。边界：`packages/panels/src/markdown/mermaid-block.tsx:25` `await import('mermaid')` |
| katex | **懒** ✅ | 全在 `markdown-preview-*.js` / `.css`；源头 `packages/panels/src/markdown/markdown-preview.tsx:8` |
| react-markdown + remark/rehype | **懒** ✅ | `index-T4oqB7qV.js` 157 KB / 47 KB gz |
| qrcode.react | **懒** ✅ | 边界 `packages/panels/src/settings/weixin-account-login-modal.tsx:26` |
| ghostty wasm（554 KB / 157 KB gz） | **懒** ✅ | 只被 `ShortcutButtonRow-*.js` 引用，随 DevicePage 加载 |
| **`@dnd-kit/*`** | **首屏** ❌ | 见下 |
| **watch 规则 UI** | **首屏** ❌ | 见下 |
| **`@base-ui/react`** | **首屏** ❌ | 542 K，最大的非 React 首屏成本 |
| lucide-react | 首屏但 tree-shaking 正常 ✅ | 135 处 barrel import、101 个不同图标，首屏只落 49 个模块 / 23 KB。**不需要改成深路径 import** |
| `@fontsource-variable/geist` | **根本没进包** | 从未被 import |

### 7.4 可挪走的首屏重量 —— 精确缝位

**(1) `@dnd-kit/*`（130 K rendered / ≈28 KB gz）** —— 只在拖拽开始后才需要，却挂在常驻侧栏上。静态链路：

```
apps/fe/src/main.tsx:17
  → @/components/page-layouts/components/app-sidebar
app-sidebar.tsx:15  → import { SortableVerticalList, useSortableRow } from '@tmex/panels/device-tree'
packages/panels/src/device-tree/index.ts:19  → './device-tree-dnd'
device-tree-dnd.tsx:13,20,21  → @dnd-kit/{core,sortable,utilities}
```
缝：`packages/panels/src/device-tree/device-tree-dnd.tsx`（131 行 / 8 导出）。把 `SortableVerticalList` 包进首次 pointer-down 才 resolve 的 `lazy()`。

**(2) watch 规则 UI（≈50 K rendered）** —— `main.tsx:29` 只 import 了 `WatchEventsInit`，但另一条 eager 路径把整棵表单树拖进首屏：

```
main.tsx:17 → app-sidebar.tsx:15 → packages/panels/src/device-tree/index.ts:1
  → device-tree/sidebar-device-list.tsx:13 → './device-tree-dialogs'
  → packages/panels/src/device-tree/device-tree-dialogs.tsx:3 → '../watch/watch-dialog'
```
缝：`device-tree-dialogs.tsx:3` 与 `packages/panels/src/device-console/page-actions.tsx:6`，两处都改 `lazy(() => import('../watch/watch-dialog'))`。它是模态框，不打开不渲染。**这是性价比最高的一处**（改动小、行为零变化）。

**(3) `@base-ui/react` 里的 trigger-gated 组件（≈154 K rendered）** —— `select` 66 K + `menu` 52 K + `dialog` 18 K + `tooltip` 18 K，都是「点了才出现」的，经 `packages/ui/src/components/{select,dropdown-menu,dialog,sheet,tooltip}.tsx` 被急加载。`sidebar`/`tabs`/`button` 必须留首屏。

### 7.5 `highlight.js` 被打了两份

单一安装（`highlight.js@11.11.1`，无版本重复），但**两条互不相交的模块图**：

- `FilePage-DIRnhmNf.js`：`highlight.js/lib/common.js` + `lib/languages/*.js`（CJS 构建）38 个模块 —— 来自 `packages/panels/src/code-viewer/code-viewer.tsx:8` `import hljs from 'highlight.js/lib/common'`
- `markdown-preview-Cf2M3lmO.js`：`highlight.js/lib/core.js` + **`highlight.js/es/languages/*.js`**（ESM 构建）38 个模块 —— 来自 `rehype-highlight` → `lowlight`

Rollup 无法跨构建格式去重，同时开文件页和 markdown 就会下两份。修法：让 `code-viewer` 复用 lowlight 的实例，或改成 `es/` 入口。

**收益的诚实估算**：`FilePage` chunk 实测 150,361 raw / **48,763 gz**，其中绝大部分是 hljs；`markdown-preview` 是 433,551 / 128,386 gz。去重后 FilePage 能瘦到接近零 hljs，**在「用户同时用到两条路径」时省 ≈40 KB gz**；只开文件页不开 markdown 时省 0。（子代理给的 95 KB 是按压缩前 `renderedLength` 折算的，偏乐观，以我实测的 gz 为准。）

### 7.6 字体 payload

`dist/fonts` 21 MB（其中 `generated/` 16 MB = 6 种可选等宽 × regular+bold），整个 `dist` 29 MB。浏览器**按需**取，不进 JS bundle，但**全部随 `resources/fe-dist` 进 npm tarball**。这是安装/升级包体积的最大单项。要瘦只能做产品决策（减少内置字体数 / 只保留默认字体 + 其余按需从 release 拉），不是删死代码。

**重新测量方法**：`cd apps/fe && ANALYZE=1 bun run build` → `apps/fe/dist/stats.html`（`visualizer` 的 `filename` 写死为相对 `apps/fe` 的 `dist/stats.html`）。

---

## 8. 重复 / 并行实现（补充，含跨进程）

「谁是活的」的证明链统一如下：
- **PROD**：`packages/app/src/runtime/server.ts:30` → `runtime/assemble.ts:672 assembleTmex` → `runtime/gateway.ts:11` → `apps/gateway/src/runtime.ts createGatewayRuntime`
- **CLI**：`packages/app/bin/tmex.js:3` → `dist/cli-node.js`（`build:cli` 从 `src/cli-node.ts` 打）→ `src/index.ts:102 dispatchCli`
- **BROWSER**：`apps/fe/src/main.tsx` → `apps/fe/src/node/node-runtimes.ts:258`

> 关键作用域事实：开发入口 `apps/gateway/src/index.ts` **完全不接 mesh**（`apps/gateway/src/runtime.ts:19` 只 import 了 `./mesh/types`，types-only）。所有 mesh / transport / 升级代码只在打包后的 `packages/app` runtime 里活。

### 8.1 ⚠️ 最大发现：canonical WS feed 建好了、接好了，但**没有任何客户端会发起它**

| | 路径 | 行数 |
| --- | --- | ---: |
| A（**活**，承载 100% 线上流量） | `apps/gateway/src/ws/legacy-feed-broadcaster.ts` + `legacy-event-delivery.ts` + `shared/ws-borsh/{state-snapshot-diff,legacy-pane-fields,legacy-window-fields,legacy-snapshot-draft}.ts` | 1,064 |
| B（**建好但触达不到**） | `apps/gateway/src/ws/canonical-feed-session.ts` + `ws/canonical/*` + `shared/ws-borsh/canonical-{state,scan,state-validation}.ts` | 2,544 |

两者在同一文件里同时实例化：`apps/gateway/src/ws/index.ts:147 new LegacyFeedBroadcaster(this)` 与 `index.ts:332 new CanonicalFeedSession({...})`。

Legacy 的活路：`packages/stores/src/pane-subscriptions.ts:41` → `packages/ws-client/src/transport-command-encoder.ts:67`（`KIND_TMUX_SUBSCRIBE_PANES`）→ `apps/gateway/src/ws/tmux-kind-handlers.ts:97` → broadcaster。

Canonical 只在收到 `KIND_CANONICAL_COMMAND`（0x0901，`shared/ws-borsh/kind.ts:74`）时才激活。**我独立复核过**：`rg "KIND_CANONICAL_COMMAND|KIND_CANONICAL_EVENT"（排除测试）` 的全部非测试命中是
- 网关自己的接收侧：`ws/canonical-kind-handlers.ts:10`、`ws/borsh/codec-borsh.ts:70`
- mesh 的字节透传：`mesh/stream-replay-state.ts:114,146,201,216,349,415`
- 常量表本身：`kind.ts`、`ws-borsh/index.ts`
- 客户端**只有解码器**：`packages/ws-client/src/transport-message-decoder.ts:186` 注册了 `KIND_CANONICAL_EVENT` 的 decoder

**`transport-command-encoder.ts` 里没有任何 canonical 命令编码器**——客户端能收、不会发。`packages/ws-client/src/pane-sink-registry.ts:117` 还留着一句将来时注释「canonical 路径挂载后…」。

连带影响：`mesh/stream-replay-state.ts` 的失败切换回放有两个分支，`this.canonicalSub` 只在观察到 canonical 命令时才被设置，所以 `buildPostConnectFrames()`（:180-189）**永远**走 `buildLegacyHistoryRequests()`（:289-329）；canonical 分支（:331-353）只被它自己的测试用手搓帧覆盖过。

**这不是清理项，是给作者的问题**：是等客户端切换的分阶段上线，还是半途而废的迁移？答案决定这 ~2,700 行是「留」还是「删」。若继续切换，缝在 `packages/ws-client/src/transport-command-encoder.ts`，按 `client.serverCapabilities` 门控（该字段在 `packages/ws-client/src/client.ts:175,375` 已存但**从未被读过**）。置信 HIGH（可达性），决策 **BLOCKED on author**。

### 8.2 发布包下载与校验写了两遍（**字节级相同**）

| | 路径 | 行数 |
| --- | --- | ---: |
| A（活，网关进程） | `apps/gateway/src/system/release-download.ts` | 377 |
| B（活，CLI 进程） | `packages/app/src/lib/release-fetch.ts` + `upgrade-verify.ts` | 122 + 72 |

**已实测 `diff` 为空**：`parseSha256Sums`（`release-download.ts:79-87` ≡ `upgrade-verify.ts:16-24`）。同一个 `SUM_LINE` 正则（`:15` / `:8`）。同一个魔法常量两个名字：`CHECKSUMS_REQUIRED_SINCE='1.1.4'`（:12）vs `SHA256SUMS_REQUIRED_SINCE='1.1.4'`（:10）。另有三处独立 spawn `tar -xzf`：`system/upgrade.ts:1014`、`app/commands/upgrade.ts:130`、`tunnel/download.ts:51`。

「两个进程」不是理由——它们**已经**共用 `packages/shared/src/release/source.ts` 做 URL 拼接（`release-download.ts:9`、`upgrade-verify.ts:3`、`release-fetch.ts:7`）。**缝**：新增 Node-only 的 `packages/shared/src/release/verify.ts`，按相对路径 import——这正是 `packages/shared/src/env/load-env.ts` 已确立的模式（被 `apps/gateway/src/bootstrap-env.ts:4` 与 `packages/app/src/runtime/bootstrap-env.ts:3` 相对 import，刻意不进浏览器 barrel）。置信 HIGH，风险 MED（升级链路，要配测试）。

### 8.3 PID 文件归属判定在两个进程各写一遍（它们操作**同一个文件** `<installDir>/tmex.pid`）

| 网关 `apps/gateway/src/system/upgrade.ts` | CLI `packages/app/src/lib/` | 状态 |
| --- | --- | --- |
| `processStartIdentity` :870-891 | `upgrade-lock.ts:40-61` | **实测 diff 为空** |
| `processCommandLine` :847-868 | `upgrade-process.ts:48-66` | 同逻辑，`ps` 参数顺序不同 |
| `cmdlineOwnsInstallRuntime` :901-934 | `cmdlineOwnsRuntime` :117-144 + `ownedRuntimePaths` :163-168 | 同算法，结构重排 |
| `parsePidFileRecord` :938-960 | `parsePidRecord` :170-190 | **已经行为分叉**：CLI 解析 `runtimePath`，网关静默丢弃 |
| `pidIsAlive` :124-131 | `isPidAlive`（`upgrade-lock.ts:30-38`） | 相同 |

不修的风险：自升级交接时两边必须对「谁拥有这个 runtime」达成一致，而 `runtimePath` 的分叉已经是活的不对称。置信 HIGH，风险 MED-HIGH（改错会导致升级死锁）。

### 8.4 三份 semver（而正确的共享版本已经存在）

| 路径 | 导出 | 谁在用 |
| --- | --- | --- |
| `packages/shared/src/semver.ts:51`（64 行） | `compareSemver`（不可解析返回 `null`） | `apps/fe/.../upgrade-batch.ts:11`、`apps/gateway/src/hub/hub-authorization.ts:1`、`packages/ws-client/src/server-features.ts:7` |
| `apps/gateway/src/system/semver.ts:48`（61 行） | `compareVersions`（返回 `0`） | `release-download.ts:10`、`upgrade-service.ts:14`、`update-check.ts:3` |
| `packages/app/src/lib/semver.ts:22`（30 行） | `compareSemver`（抛异常，不支持 prerelease） | `upgrade-verify.ts:6`、`bun.ts:8` |

`apps/gateway/src/system/semver.ts:24-45` 的 `comparePrerelease` 与 `packages/shared/src/semver.ts:27-48` 逐行相同。网关那份的头注释说是为了不复用 **`packages/app`** 的 semver——但正确的家是 `packages/shared`，而网关在同一目录下已经在 import `@tmex/shared`。理由已失效。置信 HIGH，风险 MED（三者对「不可解析」的返回语义不同：`null` / `0` / 抛异常，合并时必须逐个调用点确认）。

### 8.5 拨号熔断器在网关和浏览器各一份

`apps/gateway/src/mesh/rtc/rtc-dial-breaker.ts`（322 行）vs `packages/ws-client/src/direct/direct-dial-breaker.ts`（179 行）。常量完全相同（`FAILS=3` / `BASE_MS=30_000` / `MAX_MS=30min` / `HEALTHY_MS=60_000`，`:4-7` vs `:1-4`），`maxLevel()` 函数体逐字相同（`:292-297` / `:173-178`），冷却阶梯公式相同（`:288` / `:119`）。两份内核都不碰 Bun/DOM 专有 API（`direct-dial-breaker.ts` 零 import）。两边都活：`mesh/peer-manager.ts:375`（PROD）、`direct-carrier-controller.ts:297`（BROWSER）。

**缝**：`DialBreaker` 内核提到 `packages/shared`；网关侧保留现有的 `createGatewayRtcDialBreaker`（`:300-321`，本来就只是 `envInt` + `rtcLog` 的包装）；`classify*DialFailure` 各自保留。置信 HIGH，风险 LOW-MED（返回类型不同：富对象 vs 布尔）。

### 8.6 六个「单行配置表」store，没有共享 helper

`tunnel/config-store.ts`(140) + `tunnel/access-store.ts`(263) + `tls/tls-config-store.ts`(224) + `auth/node-identity-store.ts`(109) + `db/domain-access.ts`(85) + `db/local-auth-settings.ts`(191) = **1,012 行**，每个都独立实现同一套：固定 id 取行 → 缺省回退 → 逐字段 `patch.x !== undefined` 合并 → `insert().values(V).onConflictDoUpdate({target, set: V 去掉 id})`（字段清单写两遍）。其中三个还各带一份手写的内存孪生（`MemoryTunnelConfigStore:47`、`MemoryTunnelAccessStore:131`、`MemoryLocalAuthStore:18`）。约 400-450 行是可吸收的样板。

已排除「有 helper 但没人用」的假设：`apps/gateway/src/db/kv.ts` 是无类型字符串 KV（只有 `mesh/node-operations.ts:6` 一个调用方）；`apps/gateway/src/api/config-field.ts` 是真正的泛型且**已被正确复用**（`api/watch-rule-config.ts:6`、`api/agent-session-config.ts:6`），但它解决的是 PATCH body 校验而非持久化。置信 HIGH，风险 MED（六处都是配置持久化，改错影响面广）。

### 8.7 小重复（低成本、低风险）

| A | B | 说明 |
| --- | --- | --- |
| `apps/gateway/src/ws/canonical/bytes.ts:10` | `apps/gateway/src/tmux-client/metadata/types.ts:60` | `defaultCreateEpoch()` 逐字相同，且两文件本来就都从 `apps/gateway/src/bytes.ts` re-export |
| `apps/gateway/src/mesh/rtc/native.ts:104` | `apps/gateway/src/bytes.ts:1` | `copyBytes` 重写（`bytes.slice()` vs `Uint8Array.from()`）；`native.ts` 零 import |
| `apps/gateway/src/mesh/ctl.ts:4,8,16` | `packages/shared/src/uplink/codec.ts:69,73,77` | `encodeJsonBytes` / `decodeJsonBytes` / `isRecord` 重复；网关别处已 import 该共享 codec |
| `apps/gateway/src/tunnel/access-jwt.ts:184` | `packages/shared/src/uplink/codec.ts:99` | `bytesToB64url` |
| `apps/gateway/src/config.ts:83` | `packages/app/src/lib/roles.ts:24` | `parseTmexRoles`，两者都已委托 `packages/shared/src/roles`，只差错误文案与空串处理 |
| `rtc-peer-manager.ts:137` / `rtc/dc-handshake.ts:33` / `ws-client/direct/fingerprint.ts:113` | — | `fingerprintsEqual` 写了三遍 |
| `apps/gateway/src/mesh/mesh-deps.ts:21` `STREAM_FAILOVER_BACKOFF_MS` | — | 同一张表，三个调用点，**两个不同的越界兜底**：`?? 200`（`forwarder.ts:305,576`）vs `?? 1600`（`forwarder-failover.ts:137`）。当前索引不会越界所以是潜伏问题，但是分叉陷阱 |
| `packages/ws-client/src/reconnect-controller.ts:38-40` | `direct-carrier-controller.ts:968-971` | 同包内两份指数退避，默认值相同（base 1000 / cap 30000），指数差一。**可合并** |

**退避实现盘点**：全仓 8 份。`mesh/ctl.ts:93 backoffDelayMs` 已经是正确的共享 helper（带抖动指数退避，被复用 3 次）。两张固定表（`PEER_DC_UPGRADE_RETRY_DELAYS_MS` @ `peer-manager.ts:118`、`STREAM_FAILOVER_BACKOFF_MS`）解决的是「活链路内亚秒级重试」，**不应**并进指数退避家族。

### 8.8 补充的删除候选（来自并行实现审计，我已复核）

| 路径:行 | 内容 | 证据 | 置信 |
| --- | --- | --- | --- |
| `packages/stores/src/default-runtime.ts`（16 行） | 与生产「按 node 建 runtime」工厂并列的模块级单例 `AppRuntime` | 仅三处动态 import，全是测试（`site-theme.test.ts:40`、`tmux-sync-theme.test.ts:42`、`site-refresh.test.ts:12`）。文件头注释（:3-6）自陈：把它移出主 barrel 就是为了防止有人误建第二个全局 runtime。生产走 `createAppRuntime`（`apps/fe/src/node/node-runtimes.ts:247,258`）+ `RuntimeProvider`（`main.tsx:167,321`） | HIGH（但删了要改 3 个测试；建议**保留**，它已经被隔离得很干净） |
| `packages/app/src/lib/native-datachannel.ts:70` | 第三份 `parseSdpFingerprint` | 零非测试调用方（只有 `native-datachannel.test.ts:85-88`）。同文件其它导出是活的（`assemble.ts:62`、`setup-service.ts:35`） | HIGH |

### 8.9 查过但**不是**重复（诚实负面结论）

- **三条升级路径不是并行，是分层**，没有死的第三条。全部汇聚到 `packages/app/src/lib/upgrade-apply.ts:846 applyUpgrade`：
  (a) Web UI：`packages/panels/src/settings/use-version-tab.ts:102` → `api/system.ts:62,179` → `upgrade-service.ts:212` → `import('./upgrade')` → `upgrade.ts:755-768` spawn `bun <stage>/package/bin/tmex.js upgrade --apply-current-package --txn <id>`；
  (b) `npx tmex-cli upgrade`：`index.ts:57` → `commands/upgrade.ts:206 delegateUpgrade` → 下载解压 → 同一个 `--apply-current-package`；
  (c) 远端节点：`mesh-routes.ts:297` → `upgrade-service.ts handleMeshNodeUpgradeStart` → `remote-upgrade-job.ts` 推 `PUT /api/system/upgrade/package` 再 `POST … source=staged` → 目标机的 `UpgradeController`。
  卸载路径同构。
- **前端 store**：没有重复的设备 store、设置表单、通知 sink。`terminal-settings-sheet.tsx:25` 直接渲染 `TerminalSettingsPanel`；`sonner-notification-sink.ts` 是 `NotificationSink` 的唯一适配器（挂在 `node-runtimes.ts:249`）。（小不一致：14 个文件直接 `toast()` 绕过 sink，但那是同步 UI 反馈 vs 后台通知，可能是刻意的。）
- **拨号路径**：只有一个 endpoint racer（`peer-ws-race.ts`），由 `peer-endpoint-backoff.ts` 门控、`peer-direct-attempt.ts`（47 行纯记账）记录。`stream-targets.ts` / `link-stream-carrier.ts` 是连上之后的多路复用层，不是竞争的拨号器。`forwarder.ts` → `mesh-http.ts` 是分层。
- **`data-channel-carrier.ts` ×2 / `carrier-switch.ts` ×2**：真·双环境（Bun 原生句柄 vs DOM `RTCDataChannel`）/ 双端协议，文本重叠仅 18%。**不要**合并类体。但已经悄悄分叉了一处：网关按帧数限背压（`DC_PRIORITY_QUEUE_CAP=16`），ws-client 按字节（`DC_MAX_QUEUED_BYTES=4MiB`）——至少把 `DC_HIGH_WATER_BYTES` / `DC_LOW_WATER_BYTES` 提到 shared。
- **`fragmenter.ts` ×2**：已经是**范本**——共享内核在 `packages/shared/src/link/fragment-core.ts`，两侧只是薄的错误策略包装。无需动。
- **`subscription-coordinator.ts` ×2**、**`viewport-policy.ts` ×2**、**`tmux-version.ts` ×2**、**`bytes.ts` ×3**、**`stream-replay-state.ts` vs `retention/replay-store.ts`**：全是正确分层或重名巧合。
- **`ws-borsh` / `uplink/codec` / `link/*`**：三个不相交的层（帧substrate / 浏览器↔网关 / 节点↔hub 控制面），不是一个格式三套 codec。
- **`packages/app/src/lib/upgrade-legacy.ts`（53 行）**：**是活的兼容 shim，不是死代码**——`upgrade-apply.ts:32` 每次升级都调 `convertLegacyLayout`，保护 ≤1.1.5 的旧安装。退役它是政策决定（宣布最低可升级版本），不是清理。
- **协议版本**：没有发现不可达的版本分支。`CURRENT_VERSION=1`（`ws-borsh/codec.ts:12`）、`CANONICAL_STATE_PROTOCOL_VERSION=1`、`API_VERSION=1`。**另一个观察（是 bug 不是冗余）**：`ws-borsh/codec.ts:105` 读了 wire 上的 `version` 字段但从不校验、不分支——一个不兼容的 v2 对端会被静默接受。

---

## 9. 建议执行顺序（按独立任务分组，文件集不重叠）

> 组内文件集互不重叠，可并行开 worktree；组间按序号推进。所有改动都要跑 `bun run test` + `bun run lint`（`lint` 含 `scripts/complexity/gate.ts`）。

### 第 0 组 — 先问，别动（BLOCKED）
- **canonical WS feed（~2,544 行）的去留**：见 §8.1。在作者答复前**任何一行都不要碰**，也不要把 `ws/canonical/*` 里的「0 引用导出」当死代码删（§1.2 里的 `canonicalEventFrameBytes` 属于此类，先跳过）。

### 第 1 组 — 纯删除，零行为变化（S，~1 人时）
文件集：6 个死 barrel + §1.2 的死符号 + §1.4 的 `@deprecated` 别名 + `scripts/health-check.sh` + `scripts/spike-theme/`（保留 `dump-tui.py`）。
- 删 `apps/gateway/src/{mesh,tls,tunnel}/index.ts`、`apps/fe/src/auth/index.ts`、`packages/app/src/tls/index.ts`、`packages/api-client/src/local/index.ts`
- 删 §1.2 表里除 `weixin/ilink/types.ts`（建议留）与 `canonical/encoded-size.ts`（等第 0 组）外的全部符号
- 删 `rtc-dial-breaker.ts` 的 4 个 `@deprecated` 成员 + 同步改 `rtc-dial-breaker.test.ts:138-146`
- 删 `packages/app/src/lib/native-datachannel.ts:70 parseSdpFingerprint` + 其测试
- 删 `scripts/health-check.sh`、`scripts/spike-theme/`（除 `dump-tui.py`）
- 修 `apps/fe/tests/mobile-keyboard-avoidance.spec.ts:2` 的坏 import（改 `@tmex/stores`）

**验收**：`bun run test` 全绿；`bun run lint` 全绿；`bun run build` 成功。收益 ~450 行 + 65 KB 脚本。

### 第 2 组 — 依赖瘦身（S，~1 人时；与第 1 组不重叠）
文件集：`package.json` × 3 + `apps/fe/tailwind.config.ts` + `apps/fe/components.json` + 5 个 gateway 路由文件。
- `apps/fe`：删 `shadcn`、`tw-animate-css`、`@fontsource-variable/geist`、`autoprefixer`、`postcss`；删 `tailwind.config.ts` 并清 `components.json:7` 的 `tailwind.config` 字段
- `apps/gateway`：5 处 `uuidv4()` → `crypto.randomUUID()`，删 `uuid` + `@types/uuid`
- `packages/panels`：删未使用的 `ghostty-terminal` 依赖
- （可选）删 `apps/fe` 里 14 条纯转发的重复 pin
- 补 `@types/node@^20` 到 `packages/app`；给 6 个包补 `bun-types`

**验收**：`bun install` 后 `bun run build:fe` 产物 hash 不变（这是关键回归——依赖删对了产物就不该变）；`bun run test`。收益 ~3 MB 安装体积、8 个依赖。

### 第 3 组 — 首屏包体积（M，~半天）
文件集：`packages/panels/src/device-tree/*`、`packages/panels/src/device-console/page-actions.tsx`、`packages/panels/src/code-viewer/code-viewer.tsx`。
1. `device-tree-dialogs.tsx:3` + `page-actions.tsx:6` → `lazy(() => import('../watch/watch-dialog'))`（最高性价比，行为零变化）
2. `device-tree-dnd.tsx` 的 `SortableVerticalList` 改首次 pointer-down 才 resolve
3. `code-viewer.tsx:8` 换 `highlight.js/es/...` 或改用 lowlight 实例，消掉双份 hljs

**验收**：`ANALYZE=1 bun run build:fe` 后对比 `dist/stats.html`；`index-*.js` 的 gzip 应从 366,749 B 下降；`apps/fe` e2e（含拖拽用例 `--project` 全跑）全绿。

### 第 4 组 — 跨进程去重（M-L，1-2 天，风险最高，单独一轮）
文件集：`apps/gateway/src/system/{release-download,semver,upgrade}.ts`、`packages/app/src/lib/{upgrade-verify,release-fetch,semver,upgrade-lock,upgrade-process}.ts`、新增 `packages/shared/src/release/verify.ts` + `packages/shared/src/semver.ts`。
1. §8.2 发布包校验提到 `packages/shared/src/release/verify.ts`（照 `env/load-env.ts` 的 Node-only 相对 import 模式）
2. §8.4 semver 三合一到 `packages/shared/src/semver.ts`，逐个调用点确认「不可解析」语义
3. §8.3 PID 归属家族收敛（**最后做**，且必须先补齐两侧的行为对齐测试，尤其 `runtimePath` 分叉）

**验收**：`bun run test:tmex` + gateway 全量测试；**必须**在临时实例上实测一次完整自升级（仓库内起临时实例，显式覆盖 `TMEX_FE_DIST_DIR`/`GATEWAY_PORT`/`TMEX_BIND_HOST`，绝不碰本机生产 9883）。

### 第 5 组 — 前端/网关内部去重（M，各自独立）
- 5a：`apps/fe/src/node/{mesh-hubs,mesh-nodes}.ts` 抽 `createThrottledPoller`（§2）
- 5b：`packages/api-client/src/download-transfer.ts` + `packages/panels/src/files/bulk-transfer.ts` 抽公共 `prepareDownload`（§2）
- 5c：六个单行配置 store 抽 `createSingletonRowStore`（§8.6，~400 行）
- 5d：`packages/ws-client` 内两份指数退避合一（§8.7）；`DC_HIGH/LOW_WATER_BYTES` 提到 shared
- 5e：§8.7 的小重复（`defaultCreateEpoch`、`copyBytes`、`encodeJsonBytes`、`bytesToB64url`、`fingerprintsEqual`、`STREAM_FAILOVER_BACKOFF_MS` 兜底统一）

### 第 6 组 — i18n 死 key（S，但必须走生成流程）
删 `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json` 里附录 A 的 76 条 → `bun run build:i18n` 重新生成 `resources.ts` / `types.ts` → **不要**对生成物跑 lint/format。
**验收**：`bun run test`（i18n 相关断言）+ `bun run build:fe` + 手动过一遍设置页 / 终端 / 微信 / Telegram / 文件页，确认无 `missingKey` 警告。

### 不做（结论）
- `prompt-archives/`（16 MB）：历史记录，**KEEP**。哪怕 4.2 MB 的 `.diff/.patch` 理论上可从 git 重建，也不动。
- `docs/`（1.9 MB）：结构清晰、55 个文件，**KEEP**。只有 `docs/images/screenshot.png`（1.4 MB）值得重压一次。
- `packages/theme/resources/fonts`（16 MB）/ `apps/fe/dist/fonts`（21 MB）：用户可见功能，只能做产品决策，不能当死代码删。
- `apps/gateway/drizzle/`：迁移是历史事实；`meta/*_snapshot.json` 打包时已被剔除。
- 888 个「仅测试引用」的导出：刻意的测试缝，**不要**用 knip 之类工具批量清。

---

## 附注：本报告的行号基准

调查期间该 worktree 有**其它 agent 在并行改动**（`git status` 显示 `apps/fe/src/pages/settings/nodes/https/acme-panel.tsx`、`.../management/node-detail-dialog.tsx`、`.../use-site-settings-form.ts`、`apps/gateway/src/mesh/auth-routes.ts` 已修改，并新增了 `acme-dns-fields.tsx`、`use-node-detail-state.ts`、`use-site-settings-save.ts`、`auth-key-log-routes.ts`）。本报告除本文件外**未改动任何仓库文件**。

涉及上述 4 个文件的行号（主要是 `auth-routes.ts` 的 `AUTH_LOCAL_PRESESSION_PATHS`/`resolveUser`/`requestOrigin`/`rpIdFromOrigin`，以及 `node-detail-dialog.tsx` 的 `domainAccessErrorText`/`NodeDetailInfo`）可能已经漂移，动手前请按符号名重新 grep 确认。其余文件在调查期间未被改动，行号可直接使用。
