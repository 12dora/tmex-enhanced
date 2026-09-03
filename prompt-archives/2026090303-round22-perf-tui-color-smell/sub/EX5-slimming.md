# EX5 — 第二轮代码库精简（只读调查）

工作区：`/Users/konata/code/tmex-r22`（分支 `feat/round22-perf-tui-color-smell`，base = main @ `c462f3bd` / 1.1.21）
日期：2026-09-03　　全程只读，未改动任何源文件。脚本在 scratchpad。

> 前置：本报告承接 `prompt-archives/2026090302-round21-perf-idle-smell/sub/EX4-slimming.md`。第 21 轮已删约 1600 行死代码、8 个依赖，首屏 gzip 376 → 346 KB。**第 21 轮明确保留的项**（canonical 全部符号、rtc `@deprecated` 别名、weixin 逆向协议常量表、内置字体）本轮继续保留，不再复述。
> 本轮方法：重建 import 图（含 workspace `exports` 映射与 `@/` alias）、导出符号引用计数、12 行滑窗克隆检测、`ANALYZE=1` 构建 + `rollup-plugin-visualizer` 解析，以及**用 `manualChunks` 做的 6 次对照构建**——首屏收益全部是实测数字，不是折算。

---

## 0. 体积普查

### 0.1 代码行数（`git ls-files`，排除 `vendor/`）

| 包 | 源码行 | 源码文件 | 测试行 | 测试文件 | 生成物行 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `apps/gateway` | 90,096 | 441 | 115,940 | 364 | 0 |
| `apps/fe` | 35,653 | 178 | 41,133 | 142 | 0 |
| `packages/panels` | 25,426 | 197 | 10,674 | 68 | 0 |
| `packages/app` | 17,398 | 96 | 17,035 | 64 | 0 |
| `packages/shared` | 12,747 | 76 | 9,328 | 45 | **9,828** |
| `packages/ws-client` | 10,438 | 43 | 9,902 | 28 | 0 |
| `packages/ghostty-terminal` | 9,763 | 34 | 9,671 | 37 | 0 |
| `packages/terminal-ui` | 7,370 | 62 | 5,883 | 32 | 0 |
| `packages/stores` | 6,451 | 52 | 9,369 | 42 | 0 |
| `packages/api-client` | 3,289 | 31 | 2,394 | 15 | 117 |
| `packages/ui` | 3,011 | 36 | 572 | 8 | 0 |
| `packages/theme` | 1,140 | 9 | 353 | 2 | 862 |
| `packages/notifications` | 217 | 6 | 175 | 3 | 0 |
| **合计** | **222,999** | **1,261** | **232,429** | **850** | **10,807** |

测试行数已略超源码行数（比值 1.04），压力集中在 `apps/gateway`（1.29）与 `packages/stores`（1.45）。

网关内部分布（源码 / 测试）：`mesh` 23,848 / 38,345 · `tmux-client` 12,255 / 16,866 · `ws` 9,201 / 10,232 · `hub` 7,299 / 9,579 · `api` 5,975 / 8,104 · `agent` 5,653 / 7,240 · `tunnel` 5,111 / 4,698。

### 0.2 依赖安装体积

`node_modules` 全部 hoist 到仓库根，各 workspace 的 `node_modules` 均为 0 B。

| 项 | 大小 |
| --- | ---: |
| `node_modules` 合计 | **566 MB** |
| `.bun/node-datachannel@0.33.1` | 88 MB（`packages/app` devDep，只用于重生成 vendor 层） |
| `.bun/mermaid@11.15.0` | 75 MB |
| `.bun/lucide-react@0.564.0` | 45 MB |
| `.bun/typescript` / `@swc/core-darwin-arm64` / `@biomejs/cli-darwin-arm64` | 各 23 MB |
| `.bun/drizzle-orm` | 16 MB |
| `.bun/es-toolkit`（mermaid 传递依赖） | 15 MB |
| `.bun/@base-ui/react@1.2.0` | 13 MB |
| **`.bun/katex@0.17.0` + `.bun/katex@0.16.47`** | **4.3 + 4.3 MB（同一库装了两份，见 §3.2）** |

### 0.3 构建产物（`apps/fe`，`ANALYZE=1 bun run build`，18.15 s，exit 0）

| 项 | raw | gzip |
| --- | ---: | ---: |
| `dist` 合计 | **32 MB** | — |
| └ `dist/fonts` | 21 MB（`generated/` 15 MB + Geist Mono NF 2.2 MB + Noto Symbols2 160 KB） | — |
| └ `dist/assets` | 7.9 MB（js 6.1 MB / wasm 544 KB / **ttf 540 KB + woff 336 KB + woff2 292 KB 全是 KaTeX** / css 188 KB） | — |
| **首屏 JS**（`index.html` 唯一 `<script>`：`assets/index-D9pq0VPd.js`） | 1,134,271 | **347,649** |
| **首屏 CSS**（`assets/index-DflXGMdH.css`） | 147,046 | **23,050** |
| **首屏语言包**（`main.tsx` 渲染前 `await i18nReady`，阻塞首绘） | 99,615 (zh_CN) | **33,868** |
| **首屏合计** | ~1.35 MB | **≈ 404 KB** |
| 产物 chunk 总数 | 125 个 js | — |

首屏之外的重块（gzip）：`ghostty-vt.wasm` 157 KB · `mermaid.core` 148 KB · `wardley` 147 KB · `cytoscape.esm` 141 KB · `markdown-preview` 90 KB · **`hljs-terminal-theme` 49 KB** · `ShortcutButtonRow` 47 KB · `nodes-tab` 41 KB · `select` 11 KB · `sortable.esm` 17 KB。
（第 21 轮已把 `@base-ui select` 与 `@dnd-kit` 移出首屏——本轮实测复核确认，两者分别落在 `select-*.js` 与 `sortable.esm-*.js`。）

### 0.4 首屏 chunk 构成（visualizer `gzipLength` 按包聚合，Top）

| gzip | rendered | 模块数 | 归属 |
| ---: | ---: | ---: | --- |
| **131,357** | 424,362 | 185 | **`@base-ui/react`** |
| 98,073 | 561,395 | 10 | `react-dom` |
| 46,078 | 213,154 | 1 | `react-router` |
| 20,782 | 60,685 | 27 | `ws:panels/device-tree` |
| 19,534 | 74,237 | 17 | `@tanstack/query-core` |
| **19,423** | 61,905 | 11 | **`ws:ws-client/direct`（WebRTC 直连栈）** |
| 18,255 | 80,865 | 1 | `i18next` |
| 17,600 | 58,798 | 24 | `ws:ui/components` |
| **15,904** | 94,067 | 1 | **`tailwind-merge`** |
| 15,078 | 61,535 | 14 | `ws:shared/ws-borsh` |
| 14,492 | 43,285 | 4 | `@noble/hashes` |
| 14,369 | 37,709 | 29 | `@base-ui/utils` |
| **13,222** | 64,267 | 1 | **`sonner`** |
| 12,933 | 20,626 | 43 | `lucide-react`（43 个图标，tree-shaking 正常） |
| 8,304 | 27,293 | 1 | `tabbable` |
| 6,772 / 5,477 / 2,915 / 2,390 | — | 4 | `@floating-ui/{dom,core,utils,react-dom}` |

`@base-ui/react` 内部拆解（gzip）：`floating-ui-react` **44,624** · `utils` 17,916 · `menu` 16,639 · `scroll-area` 10,276 · `composite` 7,870 · `dialog` 6,910 · `tooltip` 6,801 · `collapsible` 5,580 · `tabs` 5,485 · 其余 < 3 K。
`floating-ui-react` 的重头是 `FloatingFocusManager` 6.1 K、`useDismiss` 4.2 K、`useListNavigation` 4.1 K、`useHoverReferenceInteraction` 2.5 K、`safePolygon` 2.4 K——**全部只被 menu / tooltip / dialog / select / popover 需要**；`tabs`/`scroll-area`/`composite`/`context-menu` 只 import `floating-ui-react/utils.js`（约 3 K）。

### 0.5 首屏收益实测（6 次对照构建，同一 vite 配置只改 `manualChunks`）

用 `manualChunks` 把某一组模块强行切出入口 chunk，读**入口 chunk 的 gzip 差**。这是可直接换算成「懒加载后首屏少下多少字节」的硬数字。

| 场景 | 入口 chunk gzip | Δ vs 基线 |
| --- | ---: | ---: |
| 基线（无 manualChunks） | 347,655 | — |
| **切出 base-ui overlay 组**（menu/dialog/tooltip/alert-dialog/context-menu/popover/composite + floating-ui-react + tabbable + `@floating-ui/*`） | 284,979 | **−62,676（−18.0%）** |
| **切出 `packages/ws-client/src/direct/`** | 330,264 | **−17,391（−5.0%）** |
| **切出 `sonner`** | 334,307 | **−13,348（−3.8%）** |
| **切出 `tailwind-merge`** | 339,899 | **−7,756（−2.2%）** |
| 切出 `packages/panels/src/device-tree/` | 99,372 | −248,283（级联，非真实收益：device-tree 是 panels/stores/ws-client 整棵图的入口，不可懒加载） |

另测 **i18n 首屏语言包核心/其余拆分**（把 `nodes` `settings` `weixin` `telegram` `watch` `agent` `files` `connectDevices` 等只在懒路由用到的顶层命名空间移出核心包）：

| | raw | gzip |
| --- | ---: | ---: |
| 现状（zh_CN 全量） | 99,512 | 33,596 |
| core（17 个首屏命名空间） | 25,626 | 9,590 |
| rest | 73,887 | 25,406 |
| **首屏可省** | — | **−24,006（−7.1% of 337 KB 首屏 JS，占语言包 71%）** |

**四项叠加后的首屏预估**：347.6 → **≈ 246 KB gz**（JS），加 CSS 23 KB + core 语言包 9.6 KB = **≈ 279 KB gz**，对比现状 404 KB gz，**−31%**。

### 0.6 docs / prompt-archives

| 目录 | 大小 | 文件数 |
| --- | ---: | ---: |
| `docs/` | 1.9 MB | 55 |
| └ `docs/images/screenshot.png` | **1.37 MB（占 72%）** | 1 |
| └ 全部 `.md` | 0.52 MB / 6,158 行 | 54 |
| `prompt-archives/` | 16 MB | 1,289（30 个轮次目录） |
| └ `.md` | 9.5 MB | 1,161 |
| └ **`.diff` 2.3 MB + `.patch` 1.8 MB + `.png` 1.9 MB** | **6.0 MB（37.5%）** | 73 |

`prompt-archives` 里**没有**混入 `node_modules` / `dist` / `*.db` / `*.log`；完全重复（md5 相同）的只有 4 组共 44 KB。

---

## 1. 死代码（本轮新增，第 21 轮未清）

### 1.1 真死导出（全仓仅一处出现 = 声明本身）

脚本口径：`nonTestOthers === 0 && selfCount <= 1 && testRefs === 0`，逐条 `grep -c` 复核。全仓 7,620 个导出中命中 **22 个**（另有 869 个「仅测试引用」的注入缝，按第 21 轮结论**不动**）。

| 文件:行 | 符号 | 类型 | 备注 |
| --- | --- | --- | --- |
| `apps/gateway/src/mesh/peer-protocol.ts:521` | `openWebSocketLink` | function | 唯一的代码型死函数 |
| `apps/gateway/src/tunnel/access-guard.ts:42` | `guardTunnelAccess` | const | 同文件 `setAccessGuardFetch`/`resetAccessGuardForTests` 有引用，这个没有 |
| `apps/gateway/src/log/rotate.ts:327` | `logGenerationPath` | function | |
| `apps/gateway/src/mesh/mesh-log.ts:32` | `infoLine` | function | 第 21 轮报告列过，未删 |
| `apps/gateway/src/mesh/peer-ws-race.ts:92` | `resetSharedDirectDialLimiter` | function | 同上 |
| `apps/gateway/src/ws/canonical/encoded-size.ts:274` | `canonicalEventFrameBytes` | function | 同上 |
| `apps/gateway/src/ws/event-loop-lag.ts:192` | `demandGatewayEventLoopLagFast` | function | |
| `packages/panels/src/device-console/terminal-keep-alive.ts:269` | `readKeepAlivePool` | function | 同上 |
| `apps/gateway/src/mesh/mesh-runtime.ts:354` | `NetworkInterfacesFn` | type | |
| `apps/gateway/src/mesh/types.ts:62,69,107,109` | `DataChannelLinkSlot` `EstablishedPeerLink` `LookupPeerCert` `RelayOpenPayload` | type | |
| `apps/gateway/src/tunnel/platform.ts:1` | `TunnelOsArch` | type | |
| `apps/gateway/src/tunnel/provider.ts:89` | `CloudflaredEnv` | type | |
| `apps/gateway/src/hub/hub-role-transitions.ts:6` | `HubRoleTransitionRow` | type | |
| `packages/api-client/src/auth/types.ts:205` | `NodeLoginRequiredBody` | interface | |
| `packages/api-client/src/local/tls-types.ts:120` | `TlsErrorCode` | type | |
| `packages/api-client/src/local/types.ts:97` | `ApiErrorBody` | interface | |
| `packages/panels/src/agent/messages/tool-call-card.tsx:25` | `ToolCardConfirmation` | interface | |
| `packages/ui/src/components/motion.tsx:13` | `MotionDurationName` | type | |
| `apps/gateway/src/weixin/ilink/types.ts:13,18,19,20` | `MESSAGE_STATE_GENERATING` `ITEM_TYPE_{VOICE,FILE,VIDEO}` | const | **保留**（逆向协议常量表，第 21 轮决策） |

### 1.2 `apps/gateway/src/db/schema.ts:849-864` —— 16 个 `*Row` 类型里 15 个零引用

只有 `NodeRow` 有 10 处消费者。`UserRow` `UserKeyRow` `UserKeyLogRow` `NodeSessionRow` `NodeCertRow` `EnrollmentTokenRow` `NodeIdentityRow` `PeerCacheRow` `TlsConfigRow` `HubTrustRow` `MeshHubRow` `TunnelConfigRow` `TunnelAccessRow` `LocalAuthSettingsRow` `NodeAccessPolicyRow` 全部 0 引用（15 行）。

### 1.3 `packages/shared/src/contracts/` 残余僵尸类型（7 个）

第 21 轮已清掉 34 个，`contracts/websocket.ts` 从满屏 JSON 信封类型缩到 22 行。仍剩：

| 文件 | 符号 |
| --- | --- |
| `contracts/tunnel.ts` | `TunnelJobState` `TunnelAuthStatus` `TunnelConfigStatus` `TunnelProcessStatus` |
| `contracts/system.ts` | `UninstallState` |
| `contracts/files.ts` | `FileContentEncoding` |
| `contracts/llm.ts` | `LlmModelSource` |

### 1.4 死文件（tightened orphan 扫描，2,139 个 TS 文件里只剩 2 个真死）

| 路径 | 行数 | 证据 |
| --- | ---: | --- |
| `packages/app/scripts/poc/node-datachannel-loader.ts` | 217 | 文件头自述 "PoC: prove node-datachannel's JS layer can be bundled by Bun.build"。零 importer、无 package.json script、无 shell 引用。真正在跑的是 `packages/app/scripts/vendor-node-datachannel.ts` |
| `scripts/health-check.sh` | 190 | 全仓零引用。硬编码 `localhost:3000` / `localhost:8080` / `TMEX_ADMIN_PASSWORD=test123`——都不是本项目端口（9663/9883、dev 19663/19883）。第 21 轮列过，未删 |

其余「零 importer」全部为构建入口 / 配置 / 按路径 spawn，已逐条排除：`apps/fe/{vite,playwright}.config.ts`、`apps/fe/scripts/run-e2e.ts`、`apps/fe/tests/{global-setup,helpers/mesh-boot}.ts`、`apps/gateway/{drizzle.config,test-preload}.ts`、`apps/gateway/scripts/run-managed-smoke.ts`、`packages/app/scripts/{build-artifacts,vendor-node-datachannel}.ts`、`packages/app/src/cli-auth-entry.ts`、`packages/shared/scripts/build-i18n.ts`、`scripts/{complexity/gate,fonts/build-fonts,theme/build-*,release}.ts`、`packages/panels/src/settings/*-tab.tsx`（经 `@tmex/panels/settings/*` 子路径导出）。

### 1.5 无 script 挂载的 bench（907 行）

`apps/gateway/bench/*` 三个都有 `bench:parser` / `bench:frame-sizer` / `bench:retention` 脚本。以下 7 个没有：`packages/ghostty-terminal/bench/{render-bridge,write-vt}.bench.ts`（370）、`packages/shared/bench/{canonical-validation,legacy-snapshot-diff}.bench.ts`（173）、`packages/stores/bench/agent-thread.bench.ts`（96）、`packages/terminal-ui/bench/{history-paging,normalization}.bench.ts`（268）。**需用户决定**：是补 script 还是删。

---

## 2. 死表面（路由 / WS kind / DB 列 / env / flag）

### 2.1 无调用方的 HTTP 路由

路由不是框架注册，是 7 层手写分发（`packages/app/src/runtime/{tls,local,setup}-routes.ts` → `apps/gateway/src/hub/hub-runtime.ts:758` → `mesh/{auth-routes,mesh-routes}.ts` → `apps/gateway/src/api/index.ts:apiRoutes[]` → `serve-frontend.ts`）。全量比对 `packages/api-client`、`apps/fe`、`packages/panels`、`packages/app`、`scripts`、e2e 之后：

| METHOD | PATH | 定义 | 判定 |
| --- | --- | --- | --- |
| GET / PUT | `/api/devices/:id/tree-order` | `api/tree-order.ts:165,170` | **零调用方** |
| PATCH | `/api/devices/:id/windows/:windowId/name` | `:175` | **零调用方** |
| PATCH | `/api/devices/:id/panes/:paneId/name` | `:185` | **零调用方** |
| POST | `/api/settings/weixin/accounts/:accountId/users/:userId/test` | `weixin-routes.ts:305` | **零调用方**（账号级 `/test` 是活的，别删错） |
| DELETE | `/api/settings/weixin/accounts/:accountId/users/:userId` | `:311` | **零调用方** |
| GET | `/api/capabilities` | `api/capabilities.ts` | 仅测试（客户端 `FeatureSet` 从不被读，见 §2.4） |
| GET | `/api/tmux/tree` | `api/tmux-tree.ts` | 仅 `scripts/hub-e2e/driver/files.ts:38` |
| GET / POST | `/api/settings/theme` | `api/theme.ts` | 仅 6 个 e2e spec；产品走 WS `KIND_SITE_THEME_UPDATE` |
| POST | `/api/hub/nodes/:id/revoke` | `hub-runtime.ts:926` | 仅测试；产品吊销走 `POST /api/auth/keylog` |

**不要误删**（仓内看不到调用方但活着）：`/api/system/upgrade/package`、`/api/system/uninstall`、`/api/mesh-internal/tmux/*`（全部由 **mesh 对端节点**调用）；`/api/hub/status`（hub 互探 `hub-peer-poller.ts:597`）；`/api/tls/ca.crt`（浏览器下载 + `uplink-pool-http.ts:80`）；`/api/manifest.webmanifest`（`apps/fe/index.html:18`）。全仓 `packages/*` / `apps/*` 无任何 `@deprecated` 标记，所以「只经废弃客户端方法可达的路由」为 0。

### 2.2 WS kind

58 个 `KIND_*` **没有一个是完全无发送者/无处理者的**。三点需标注：
- `KIND_TMUX_EVENT 0x0207` / `KIND_STATE_SNAPSHOT_DIFF 0x0209` / `KIND_CLIPBOARD_WRITE 0x0307` 只由 legacy state feed 产生 → **兼容路径，不删**（见 §4.1）。
- `KIND_CHUNK 0x0501` 的 **C2S 方向无编码器**（只有 S2C 分片）。
- `KIND_NOTIFY_EVENT 0x0803` 的客户端消费只在 `packages/ws-client/src/client.test.ts` 出现，值得复核。

### 2.3 DB

40 张表**全部**有非测试查询，无死表。列级只有两条「写了从不读」：

| 列 | 写入点 | 读取点 |
| --- | --- | --- |
| `user_key_log.prev_hash` | `auth/user-key-persistence.ts:123`、`auth/key-log-store.ts:84` | 无（`key-log-store.ts:160` 只取 `recordBytes`+`sig`；哈希链在内存由 `users.keyLogHeadHash` 维护） |
| `user_key_log.payload_json` | `user-key-persistence.ts:129`、`key-log-store.ts:90` | 无 |

**建议不动**：`prev_hash` 是密钥日志哈希链的冗余副本，停写等于放弃一条离线取证能力。加注释即可。`apps/gateway/drizzle/**` 39 个迁移永不删。

### 2.4 `GATEWAY_CAPABILITIES` 四选一：三个字符串无消费者

```
GATEWAY_CAPABILITIES = ['tmex-ws-borsh-v1','tmex-agent-v1','tmex-split-v1', GATEWAY_CAPABILITY_CANONICAL_STATE_V1]
```
`canonical-state-v1` **活**（`ws-client/client.ts:406`，走 WS `HELLO_S2C`，不经 REST）。另外三个只在测试里出现。链路：`GET /api/capabilities` → `api-client/capabilities.ts:fetchCapabilities` → `stores/site.ts:136` `set({capabilities: new FeatureSet(...)})` → **全仓无任何产品调用 `.has()/.hasAll()/.hasAny()/.list()`**。`main.tsx:184` 的注释「落 site store 供按 featureset 渲染」是过期承诺。
（注意区分：`packages/panels|terminal-ui|stores` 里的 `capabilities.atomicScreen/cursorHistory/serverSelection` 是 **transport capabilities**，源头 `ws-client/shared-transport.ts:41-43`，与 REST FeatureSet 无关。）

### 2.5 恒真的版本门

| 常量 | 值 | 位置 | 判定 |
| --- | --- | --- | --- |
| `CHECKSUMS_REQUIRED_SINCE` | 1.1.4 | `system/release-download.ts:12,114` | **else 分支不可达**（下载目标恒 ≥ 1.1.21） |
| `SHA256SUMS_REQUIRED_SINCE` | 1.1.4 | `packages/app/src/lib/upgrade-verify.ts:9,12` | 同上 |
| `TERM_VIEWPORT_MIN_SERVER_VERSION` | 1.1.7 | `ws-client/server-features.ts:9` | 低于生态实际下限 1.1.13，**建议提阈值不建议删** |
| `MIN_REMOTE_UPGRADE_VERSION` | 1.1.0 | `fe/.../upgrade-batch.ts:16` | 同上 |
| `canonicalStateEnabled` option | — | `ws-client/client.ts:85,115` | 产品从不传 `false`（唯一 false 在测试）。它是 canonical feed 的应急 kill switch，**保留有运维价值** |

`MIN_HUB_TOKENS_VERSION` / `MIN_HUB_AUTH_RECORD_VERSION` / `MIN_ROTATE_ROOT_KEEP_RECORD_VERSION` / `MIN_REMOTE_UNINSTALL_VERSION`（均 1.1.13+）是活的入网兼容门，**不动**。

### 2.6 env

**「设了没人读」为空集**（`development.env` / `test.env` 每个键都有读取点）。反过来「读了没文档」有约 20 个，其中安全相关的两个尤其应补文档：`TMEX_GATEWAY_OWNER_TOKEN`（`config.ts:66` → `/healthz` owner proof）、`TMEX_MANAGEMENT_MODE` / `TMEX_UPDATE_OWNER`（`config.ts:28-30`，managed 判定核心）。其余：整套 `TMEX_LOG_*`（7 个）、`TMEX_TUNNEL_DIR`、`TMEX_TMUX_BIN`、`TMEX_RELEASE_*`（3 个）、`TMEX_MANAGED_ENDPOINT_*`、`TMEX_CLI_LANG`、`TMEX_GHOSTTY_WASM_PATH`、`TMEX_EVENT_LOOP_LAG_DIAG`、`TMEX_DIRECT_ENABLED`（有 app.env 模板无文档）。

---

## 3. 依赖

### 3.1 零本地引用的声明（`apps/fe` 15 个，第 21 轮 §6.3 提过，未处理）

`@base-ui/react` `@dnd-kit/{core,sortable,utilities}` `class-variance-authority` `clsx` `ghostty-terminal` `highlight.js` `katex` `mermaid` `react-markdown` `rehype-highlight` `rehype-katex` `remark-gfm` `remark-math` `tailwind-merge` —— 真正的 owner 是 `packages/{ui,panels,terminal-ui}`，它们各自也声明了同一依赖。bun workspace 每包一份 `node_modules`，**一旦版本漂移就会在 bundle 里出现两份拷贝**（§3.2 的 katex 就是活生生的例子）。删掉这 15 条纯转发声明。

其余「未引用」项全是 `typescript` / `@types/*` / `bun-types` / `@biomejs/biome` 这类工具型声明，属误报。`packages/app` 的 `node-datachannel` 也是误报（`packages/app/scripts/vendor-node-datachannel.ts` 需要它重生成 vendor 层）。

### 3.2 ★ katex 装了两份，且 CSS/JS 版本不一致

| | 版本 | 来源 | 进 bundle 吗 |
| --- | --- | --- | --- |
| JS | **0.16.47** | `rehype-katex@7.0.1` 的 `"katex": "^0.16.0"` | ✅ `markdown-preview` chunk 全部 katex 字节都来自它 |
| CSS | **0.17.0** | `apps/fe` + `packages/panels` 显式声明 `katex@^0.17.0`；唯一用法是 `packages/panels/src/markdown/markdown-preview.tsx:8` 的 `import 'katex/dist/katex.min.css'` | ✅ CSS 走 0.17 |

即：**KaTeX 0.17 的样式表配 KaTeX 0.16 的渲染器**。类名/字体族一旦在 0.17 变过就会渲染错位。同时白白多装 4.3 MB。
修法：把两处 `katex` 声明改成 `^0.16.0`（与 `rehype-katex` 对齐），或直接删掉显式声明、改从 `rehype-katex` 传递依赖里取 CSS。

### 3.3 KaTeX 字体三份格式全打进包

`dist/assets` 里 **59 个 KaTeX 字体文件 / 1.1 MB**：ttf 540 KB + woff 336 KB + woff2 292 KB。woff2 自 2016 年起被所有支持 WASM/WebRTC 的浏览器支持（本应用本来就要求这些），ttf/woff 是纯粹的死重量，且**随 npm tarball 分发到每一台安装机**。KaTeX 的 `@font-face` `src` 顺序是 woff2 → woff → ttf，删掉后两者不会产生任何请求。

### 3.4 `highlight.js` 38 个语言全部急注册

`packages/panels/src/code-viewer/code-viewer.tsx:16-51` 静态 import 38 个语言，产出独立 chunk `hljs-terminal-theme-*.js` **49,348 B gzip**，其中语言模块占绝大部分（`lib/core.js` 之外 36 个语言，per-module gzip 合计 92 KB）。文件查看器打开任意文件都要先下这 49 KB，而实际每次只用得上 1 个语言。
（第 21 轮已解决「hljs 被打两份」的问题：现在 markdown 侧只剩 6 KB 的 lowlight core 复用。）

### 3.5 重复用途依赖 / 可替代的重库

| 依赖 | 首屏 gzip | 说明 |
| --- | ---: | --- |
| `tailwind-merge@3.4.0` | **7,756（实测）** | 单模块 94 KB rendered，全部是 Tailwind class-group 表。只服务 `packages/ui/src/utils.ts` 的 `cn()`（194 处调用）。**替换需产品/前端决策**（见 §5） |
| `react-router@7.13.0` | **32,794（实测切出成本）** | 用了 `createBrowserRouter` + `RouterProvider` 数据路由，实际只需 `Link/useNavigate/useLocation/matchPath/useParams/useSearchParams/Outlet/Navigate/MemoryRouter` + 一处 `useRevalidator`。**已核查过一个常见误判**：RR 7.13 的 `exports` 映射所有条件都指向 `dist/development`，但 `dist/production` 与 `dist/development` 的 chunk **字节数完全相同**（355,054 vs 355,055），并非「生产环境误打 dev 构建」。真要瘦只能换路由库或降到声明式路由，属大改造 |
| `@ai-sdk/openai` + `@ai-sdk/openai-compatible` + `ai` | — | 网关侧，三者是同一 SDK 的适配层，不是重复；`ai@6` 安装 7.6 MB |
| `sonner` | **13,348（实测）** | `main.tsx:6` 静态挂 `<Toaster>`；`toast()` 在 20+ 处命令式调用。可用「Toaster 懒挂 + toast 队列转发」拆掉 |
| `@base-ui/react` overlay 组 | **62,676（实测）** | 见 §5 头号项 |

---

## 4. 并行 / 重复实现

### 4.1 canonical vs legacy 状态流：**canonical 已接通并成为默认**，legacy 变成纯兼容层

第 21 轮之后事实已变（EX4 §8.1 的结论已过期）：
- 客户端已有编码器（`packages/ws-client/src/transport-command-encoder.ts:50` 发 `KIND_CANONICAL_COMMAND`），并由 `client.ts:404-409` 按 `GATEWAY_CAPABILITY_CANONICAL_STATE_V1` + 帧长门控自动选 `stateFeedMode`。
- `apps/fe/src/node/node-runtimes.ts:93` 有 localStorage kill switch `tmex.disable-canonical-state`，默认关闭（即默认走 canonical）。
- **仍走 legacy 的残留**：`packages/ws-client/src/websocket-transport.ts:49,282` 的 `isLegacySizeCommand`——尺寸补发/尺寸变更两条语义 canonical v1 分不开，仍走 legacy 控制面（commit `39318f94`）。

因此 legacy 侧这 1,071 行源码 + 671 行测试**暂不可删**：

| 文件 | 行数 |
| --- | ---: |
| `apps/gateway/src/ws/legacy-feed-broadcaster.ts` | 429 |
| `apps/gateway/src/ws/legacy-event-delivery.ts` | 77 |
| `packages/shared/src/ws-borsh/legacy-snapshot-draft.ts` | 244 |
| `packages/shared/src/ws-borsh/state-snapshot-diff.ts` | 144 |
| `packages/shared/src/ws-borsh/legacy-pane-fields.ts` | 101 |
| `packages/shared/src/ws-borsh/legacy-window-fields.ts` | 76 |
| 对应测试（`legacy-event-delivery` `legacy-observer-wiring` `legacy-pane-fields` `legacy-snapshot-draft`） | 671 |

**可删的触发条件（需用户拍板）**：(a) canonical v1 补齐「尺寸补发 vs 尺寸变更」的区分，`isLegacySizeCommand` 消失；(b) mesh 最低可入网版本提到「首个带 `canonical-state-v1` 的版本」（当前 1.1.21 刚发，现网几乎没有）。两条都满足后可一次性删掉上表 + `KIND_TMUX_EVENT`/`KIND_STATE_SNAPSHOT_DIFF`/`KIND_CLIPBOARD_WRITE` 的发送侧，约 **1,740 行**。

### 4.2 semver 三份（第 21 轮未处理）

| 路径 | 行数 | 导出 | 不可解析时 |
| --- | ---: | --- | --- |
| `packages/shared/src/semver.ts` | 64 | `parseSemver` / `compareSemver` | 返回 `null` |
| `apps/gateway/src/system/semver.ts` | 61 | `compareVersions` | 返回 `0` |
| `packages/app/src/lib/semver.ts` | 30 | `compareSemver` | 抛异常，不支持 prerelease |

`apps/gateway/src/system/semver.ts` 的 `comparePrerelease` 与 shared 版本**逐行同构**（已 diff 确认），其文件头注释「gateway 不复用 packages/app 的 semver，避免对 CLI 包形成反向依赖」——理由早已失效：正确的家是 `packages/shared`，而网关同目录已经在 import `@tmex/shared`。合并可省 **91 行**，但**必须逐个调用点确认「不可解析」的三种返回语义**。

### 4.3 发布包下载与校验写了两遍（EX4 §8.2，未处理）

`apps/gateway/src/system/release-download.ts`(377) ↔ `packages/app/src/lib/{release-fetch,upgrade-verify}.ts`(122+72)。`parseSha256Sums` 两侧 **diff 为空**，同一个 `SUM_LINE` 正则，同一个魔法常量两个名字。两者**已经**共用 `packages/shared/src/release/source.ts`，缝是显然的：新增 Node-only 的 `packages/shared/src/release/verify.ts`，按相对路径 import（与 `packages/shared/src/env/load-env.ts` 同一套模式）。约 **100 行**。

### 4.4 TOTP URI 两份（本轮新增）

`apps/fe/src/auth/totp-uri.ts`(66) ↔ `packages/app/src/lib/totp-uri.ts`(31)。后者的 `encodeBase32` 与前者的 `base32Encode` 是同一实现，`totpOtpauthUri` 的 URI 拼装也一致。前者已经 import `@tmex/shared/auth`，说明 shared 就是共同家。约 **30 行**。

### 4.5 PID 文件归属判定两份（EX4 §8.3，未处理）

`apps/gateway/src/system/upgrade.ts:847-960` ↔ `packages/app/src/lib/{upgrade-lock,upgrade-process}.ts`。两者操作**同一个文件** `<installDir>/tmex.pid`，且 `parsePidFileRecord` vs `parsePidRecord` **已经行为分叉**（CLI 解析 `runtimePath`，网关静默丢弃）。这是活的不对称，改错的代价是升级半途死锁——**优先级低于收益，但风险是真的**。

### 4.6 前端两处仍未抽取的重复（EX4 §2，未处理）

| A | B | 重复窗口数（12 行滑窗） | 内容 |
| --- | --- | ---: | --- |
| `apps/fe/src/node/mesh-hubs.ts:187-235` | `apps/fe/src/node/mesh-nodes.ts:557-610` | 13 | `startPolling()` 整套骨架：默认值、`schedule`/`delay` 注入、节流窗口、`events.onStatusChange`/`onNodeEvent` 挂载、可见性补拉 |
| `packages/api-client/src/download-transfer.ts:94-` | `packages/panels/src/files/bulk-transfer.ts:345-` | 18 | `DownloadPrepareEvent` 接口逐字重复、`prepareDownload()` NDJSON 进度流解析、leg2 读流计速循环 |

### 4.7 同一实现被测三遍（本轮新增）

`apps/gateway/src/api/http.ts`(24 行) 与 `packages/app/src/runtime/http.ts`(22 行) **都只是 re-export** `packages/shared/src/http/read-body`：

```
apps/gateway/src/api/http.ts:1        export { JSON_BODY_MAX_BYTES, readJsonObjectBody } from '../../../../packages/shared/src/http/read-body';
packages/app/src/runtime/http.ts:3    export { JSON_BODY_MAX_BYTES, readJsonBody }       from '../../../../packages/shared/src/http/read-body';
```

而 `apps/gateway/src/api/http.test.ts`(65) 与 `packages/app/src/runtime/http.test.ts`(65) **测试标题重叠率 86%**（全仓两两比对 868 个测试文件，超过 60% 重叠的**只有这一对**）。可合并进 shared 侧，省 ~110 行测试 + 2 个 wrapper。

### 4.8 三个设置弹窗共用表单壳（EX4 §2，未处理）

`packages/panels/src/settings/{llm-provider-form-modal,telegram-bot-form-modal,weixin-account-form-modal}.tsx` 共享字段布局、保存/取消按钮排布、错误行。抽 `SettingsFormModal` 壳。

### 4.9 **有意重复，不要动**

- `packages/ghostty-terminal/src/selection-clipboard.ts` ↔ `packages/shared/src/browser-clipboard.ts`（ghostty-terminal 是零依赖的独立发布包，源码里写了理由）
- `packages/ghostty-terminal/src/types.ts` ↔ `packages/shared/src/appearance.ts`（同上）
- `apps/fe/src/pages/settings/nodes/https/parts.tsx` ↔ `.../setup/form-parts.tsx`（文件头写明「刻意各自独立」）
- `packages/shared/src/ws-borsh/index.ts` ↔ `kind.ts`（barrel 逐条 re-export，克隆检测假阳性）

---

## 5. i18n / CSS / motion（子调查结论摘要）

### 5.1 i18n 死 key：**82 条**（第 21 轮 76 条一条未删，本轮新增 6 条）

新增 6 条来自「标识符边界匹配」修正了第 21 轮的子串误判：`sidebar.currentWindow`（被 `currentWindowId` 掩盖）、`terminal.deviceError`（被 `deviceErrors` 掩盖）、`watch.rules.lastTriggered`（被 `lastTriggeredAt` 掩盖）、`nodes.upgrade.allHint` + `_one` + `_other`（被 `getInstallHint` 掩盖）。

分布：`weixin` 13 · `terminal` 12 · `telegram` 10 · `settings` 8 · `device` 7 · `sidebar` 6 · `nodes` 6 · `agent` 4 · `apiError` 4 · `common` 3 · 其余 9。收益：en_US −3,541 B / zh_CN −3,410 B / ja_JP −4,595 B（合计 **11.5 KB raw**，每语言 chunk 约 −1.1 KB gz）。

已穷举全部模板前缀并从名单排除（`auth.errors.*`、`auth.credential.purpose.*`、`connectDevices.{mobile,computer,tabs}.**`、`files.error.*`、`nodes.https.{selfsigned.guide,mode,acme.status}.**`、`nodes.setup.result.direct.*`、`nodes.reach.*`、`nodes.upgrade.${UpgradeBlockReason}`、`nodes.hubs.role.errors.*`、`nodes.membership.*Confirm.*`、`settings.remoteAccess.**`、`notification.eventType.*`）；全仓无 `<Trans>`、无 `as TranslationKey`、无 `keyPrefix`。复数变体 12 条里 10 条属活 key，只有 `nodes.upgrade.allHint*` 3 条进名单。

**执行硬约束**：只能改 `packages/shared/src/i18n/locales/*.json` 再跑 `bun run build:i18n`；`resources.ts` / `types.ts` 不得手改、不得 lint。

顺带两处一致性问题：
- `sshError.sshConfigRefNotSupported` 是拼错的孤儿 key（代码用 `sshError.configRefNotSupported`，`apps/gateway/src/ws/error-classify.ts:11`）——第 21 轮已报，至今未修。
- zh_CN / ja_JP 的 6 组 count 相关 key 写的是裸 key 而非 `_other`，依赖 i18next 的「缺复数形态回退基础 key」行为，**建议实测确认**。

### 5.2 未用 CSS token（16 个 + 2 个 keyframes + 1 个类）

| 项 | 位置 | 证据 | 产物字节 |
| --- | --- | --- | ---: |
| **`--fc-*` 11 个** | `packages/theme/src/tokens.css:57-67` + `preset-css.ts:51-61` → `themes.css` **154 行** | **FullCalendar 根本不是本项目依赖**（全仓 `fullcalendar` 0 命中，含所有 package.json）；`var(--fc-*)` 消费者 0 处 | **6,284 raw** |
| **`--chart-1..5`** | `tokens.css:38-42` + `.dark` + `preset-css.ts:38-42` → `themes.css` **95 行** | 无 `bg-chart-*`/`text-chart-*` 等工具类使用；产物 CSS 里 0 条 `.bg-chart-N` 规则 | **2,459 raw** |
| `--base-1000` / `--tmex-motion-slow` / `--tmex-ease-in-out` / `--terminal-shortcut-bg` | `tokens.css:23` / `motion.css:8,12` / `tokens.generated.css:6,11` | 逐条 0 消费者 | < 200 raw |
| `--font-display` / `--display-weight`（`@theme inline` 内） / `@keyframes scroll` + `--animate-scroll` / `@keyframes pulse-dot` / `.font-display` | `apps/fe/src/index.css:47-68,105-107,143-145` | `--display-family` **全仓从未定义**（悬空引用）；`--animation-duration`/`--animation-direction` 同样未定义；`pulse-dot` 无对应 `--animate-*` token 所以 Tailwind 永不输出 | 0（本就没进产物） |

实测去除 `--fc-*` + `--chart-N`：首屏 CSS 147,046 → 142,308 raw（−3.2%），gzip 23,128 → 22,734（**−394 B**）；`themes.css` 生成物 791 → 约 540 行。
**执行注意**：`themes.css` 是生成物，改 `preset-css.ts` + `tokens.css` 后跑 `scripts/theme/build-theme-presets.ts`；`presets.test.ts:20-31` 会自动跟随，无需改测试。`--terminal-shortcut-bg` 需同步改 `terminal-shortcut-tokens.ts` 真源 + `presets.test.ts:278,280`。

### 5.3 `packages/ui/src/components/motion.tsx` 5 个死导出

`fadeClassName`、`scaleInClassName`、`staggerClassName`（三者只被 `motion.test.ts` 引用；真实使用点全部直接写字符串字面量，如 `device-grid.tsx:131` 的 `'tmex-stagger'`）、`MotionDurationName`（全仓 0）、`Stagger` + `StaggerProps`（全仓 0 import，唯一文本命中是 `nodes-tab.tsx:44` 一句注释）。约 30 行 + 对应断言。
`motionDurations.slow` / `.fast`：TS 侧无消费者，但 `--tmex-motion-fast` 在产物里有 47 处 —— **只删 `slow`，`fast` 要留**。

---

## 6. 测试

- **测试债务健康度很高**：全仓 `toMatchSnapshot` / `__snapshots__` **0 个**；`.only` **0 个**；无条件 skip **0 个**（7 处条件 skip 全部有明确环境守卫）；不可解析导入 **0 条**（2 条命中是写入临时 shim 的字符串字面量，误报）；零引用 helper **0 个**（`mesh-boot.ts` 是按路径 spawn）。
- **重复度极低**：868 个测试文件两两比对，标题重叠 > 60% 的只有 §4.7 那一对。
- 8 处 > 100 行的内联 fixture 全是表驱动 `CASES`/`STEPS`/`SCENARIOS`，是期望写法。
- 真正的膨胀是**体量本身**：52 个文件 > 800 行，合计 76,900 行（占测试总量 33%）；`apps/gateway/src/mesh/` 一个目录 21,300 行。头部：`peer-manager.test.ts` 3,851 · `auth-routes.test.ts` 3,676 · `uplink-server.test.ts` 2,982 · `terminal.canvas.test.ts` 2,971 · `uplink-client.test.ts` 2,474 · `hub-runtime.test.ts` 2,339 · `uplink-pool.test.ts` 2,327 · `mesh-routes.test.ts` 2,319。
- 命名错位（不是膨胀，但影响可维护性）：`apps/gateway/src/api/agent.test.ts` 605 行测的是 18 行的组合器 `agent.ts`，实际覆盖 `agent-{session,message,confirmation}-routes.ts` 三个无独立测试的文件（比值 33.6×）。建议拆分改名。

---

## 7. docs / archives

- **没有一篇整篇废弃的文档**（54/54 全部对应现存模块，`docs/README.md` 索引与磁盘一一对应，无孤儿）。
- 需更新的（含死引用）12 篇，最严重两篇：
  - `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`（654 行）自称「wire 格式**唯一真源**」，但 kind 表只覆盖 37/57，**缺 20 个**：`0x020b–0x0215`（11 个 tmux 操作）、`0x0307` CLIPBOARD_WRITE、`0x0801–0x0803`、`0x0a01–0x0a05`（整个 mesh 组）。
  - `docs/ws-protocol/2026021403-ws-state-machines.md`：`RESYNCING` `PENDING_DEBOUNCE` `CLOSING` `ws_open` `hello_s2c` `backoff_timeout` **6/6 全部 0 命中**，是纯概念图。
  - 一行级死符号：`outputBuffer`(2026021404) · `htmlFormatterHandle`/`plainFormatterHandle`(2026041600) · `preferredNotifChannel`(2026061101) · `maxRequestBodySize`(2026061500) · `row_dirty`(2026082700) · `handleLlmApiRequest`(2026061302-testing) · `prompts.ts`→`prompts/`(2026061302-agent) · `/api/agent/settings`(2026062400-prd，路由全树不存在) · `handleRenameWindow`/`handleReorderPanes`/`handleReorderWindows`(device-tree/2026061400)。
- **`AGENTS.md` 逐条核对与代码完全一致，无需改动。**
- ★ **README 安全声明与代码严重矛盾**：`README.md` §Security 与 `README.zh-CN.md:81` 写「tmex 未内置用户鉴权，请在受信网络内运行，不要直接暴露到公网」，但仓库有完整鉴权栈（`apps/gateway/src/auth/` 20+ 文件、`mesh/auth-routes.ts` 766 行、passkey/OPAQUE/key-log、`/api/auth/mode`），并有 5 篇 `docs/operations/2026090*` 专讲公网登录加固。同时 README 通篇无 hub/node/mesh 多机能力（那是第 5–21 轮的主线）。这是**安全误导**，不是体积问题。
- `prompt-archives/` 很干净：无 node_modules/dist/db/log 混入；完全重复只有 4 组 44 KB（`2026083101-.../sub/E{1,3,4}-codex-out.md` ≡ `E{1,3,4}-result.md`、`2026083100-.../sub/lint-final-tests.txt` ≡ `final-tests.txt`）。二进制负载 6.0 MB（diff 2.3 + patch 1.8 + png 1.9），12 个 ≥128 KB 的 review diff 合计 2.1 MB。

---

## 8. 排序后的可执行清单（22 项）

收益列：`gz` = 首屏 gzip 实测；`行` = 源码行；`MB` = 磁盘/安装包。角色：**FE** = 前端 / **BE** = 后端 / **BUILD** = 构建脚本 / **DOC** = 文档。

| # | 项 | 收益 | 精确位置 | 验证 | 风险 | 角色 |
| ---: | --- | --- | --- | --- | --- | --- |
| **1** | **base-ui overlay 组懒加载** —— 把 menu/tooltip/dialog/alert-dialog/sheet 从首屏静态图上摘掉，`floating-ui-react`+`tabbable`+`@floating-ui/*` 会跟着走 | **−62,676 gz（−18.0% 首屏）** | 首屏静态边共 7 处：① `packages/ui/src/components/sidebar/sidebar-menu.tsx`→Tooltip ② `packages/ui/src/components/sidebar/sidebar-layout.tsx`→Sheet→Dialog（仅移动端渲染） ③ `apps/fe/src/page-wrapper.tsx` / `.../sidebar-title.tsx` / `.../theme-menu.tsx`→IconTooltip+Tooltip ④ `.../theme-menu.tsx` / `.../agent-session-row.tsx` / `packages/panels/src/device-tree/device-actions-menu.tsx`→DropdownMenu ⑤ `.../agent-session-dialogs.tsx`→Dialog+AlertDialog ⑥ `packages/panels/src/device-tree/{rename-dialog,close-confirm-dialog,device-tree-dialogs}.tsx` ⑦ `apps/fe/src/components/side-panels/side-panel-host.tsx`→Sheet。**现成范式**：`packages/panels/src/watch/deferred-watch-dialog.tsx`（显式 loader + 有限重试 + 整页刷新兜底，刻意不用 `React.lazy`）与 `apps/fe/src/lazy-chunk.tsx` | `bun run --filter @tmex/fe build` 后按 §0.3 方法量首屏 gzip；`apps/fe/tests/` 里覆盖侧栏菜单/主题菜单/重命名对话框/移动端侧栏的 spec 必过 | 中 —— 触发后晚 1 帧挂载；发版后旧 index.html 指向的 chunk 404 必须走 `deferred-*` 的兜底路径，不能用裸 `React.lazy` | FE |
| **2** | **i18n 首屏语言包拆 core/rest** —— `build:i18n` 额外产出 `<lng>.core.json` + `<lng>.rest.json`，`i18nReady` 只 await core，首帧后空闲用 `i18n.addResourceBundle` 补 rest | **−24,006 gz（−7.1%）** | `packages/shared/scripts/build-i18n.ts` + `apps/fe/src/i18n/index.ts:9-19`（`import.meta.glob`）。core 建议含 `common nav sidebar device devices deviceStatus window appError wsError auth apiError sshError terminal notification validation websocket file`（25.6 KB raw / 9.6 KB gz）；rest 含 `nodes settings weixin telegram watch agent files connectDevices webhook` 等（73.9 KB raw） | 切三种语言各跑一遍 e2e；人工确认首帧无 raw key 闪烁；`bun run build:i18n` 后 `resources.ts`/`types.ts` 不得手改 | 中 —— core 漏放一个首屏 key 会短暂显示裸 key；缓解：rest 在首帧后立即预取（窗口 ~200 ms） | FE + BUILD |
| **3** | **`ws-client/direct` WebRTC 栈懒加载** | **−17,391 gz（−5.0%）** | 根因是 `packages/ws-client/src/index.ts:56,67,85,93,100,108,115,123,133` 把整个 `direct/` 从 barrel 里 re-export；唯一真实消费者是 `apps/fe/src/node/node-runtimes.ts` 的 `createController`。改成首次为**远端 node** 建连时 `await import('@tmex/ws-client/direct/direct-carrier-controller')` | `bun test packages/ws-client`；mesh e2e 的直连/中转切换用例；本地单机场景确认零回归（本地根本不建直连） | 中 —— 直连建立多一次 import 往返（发生在 WS 已连上之后，不影响首屏可用） | FE |
| **4** | **删 `/api/devices/:id/tree-order` 四联路由** | ~480 行 | 删 `apps/gateway/src/api/tree-order.ts`(190) + `tree-order.test.ts`(286)，摘 `api/device-routes.ts:25` import 与 `:199` 的 `...treeOrderRoutes` | `bun test apps/gateway`；`rg -n "tree-order" apps packages scripts` 只应剩 `settings/broadcaster.ts:14` 的事件命名空间、`db/{schema,devices}.ts`、`ws/tmux-command-handlers.ts` 的 4 处 `broadcastSettingsUpdate('tree-order')`、`panels/settings/settings-events-init.tsx:36`；跑侧栏改名/排序 e2e。**注意** `api/route.test.ts:130` 拿 `/api/devices/dev-1/tree-order` 当通配匹配样例，要换路径 | 低 —— 表与 WS 写路径完全不受影响（REST 只是 WS bridge 的并行前门） | BE |
| **5** | **`sonner` 懒加载** | **−13,348 gz（−3.8%）** | `apps/fe/src/main.tsx:6` 的 `<Toaster>` 改懒挂；`toast()` 的 20+ 处命令式调用（`apps/fe/src/lib/sonner-notification-sink.ts` 是集中点）改经一层 `await import('sonner')` 的转发队列 | 逐个 toast 触发点手测（登录失败、升级、节点操作、文件传输）；`bun test apps/fe` | 中 —— 首个 toast 会晚一帧；要保证 import 期间的 toast 不丢（队列） | FE |
| **6** | **删 REST `/api/capabilities` 全链** | ~140 行 | 服务端：`apps/gateway/src/api/capabilities.ts`(21) + `capabilities.test.ts`(42)、`system-routes.ts:58-64`、`api/index.ts` 接线。客户端：`packages/api-client/src/capabilities.ts`(50，`FeatureSet`+`fetchCapabilities`) 与 barrel 导出、`packages/stores/src/site.ts:1,15,125,135-136` 的 `capabilities` 字段与 `loadCapabilities`、`apps/fe/src/main.tsx:184` 调用、`stores/site-theme.test.ts:397-432`、`api-client/client.test.ts:103-115`。**保留** `packages/shared/src/capabilities.ts` 的 `GATEWAY_CAPABILITY_CANONICAL_STATE_V1`（WS HELLO 仍用） | `bun test packages/api-client packages/stores apps/gateway`；`rg -n "FeatureSet\|fetchCapabilities\|api/capabilities"` 只剩 docs；同步改 `docs/frontend/packages.md:98`、`docs/ws-protocol/2026021402-*.md:205` | 低-中 —— `/api/capabilities` 可能被外部监控探测；保守做法是只删客户端消费（~90 行）保留服务端路由 | BE + FE |
| **7** | **`highlight.js` 语言按需注册** | FilePage chunk **49 KB gz → ~10 KB**，每次实际只多下 1–2 KB | `packages/panels/src/code-viewer/code-viewer.tsx:16-51` 的 38 个静态 import 改成 `Record<string, () => Promise<LanguageFn>>`，按 `:99` 的扩展名映射按需 `hljs.registerLanguage` | 打开 `.ts/.py/.go/.rs/.md/.json/.sh` 等各一遍看高亮；`bun test packages/panels` | 低 —— 首次高亮晚一帧（`:55` 那句「顺序与 `lib/common.js` 逐行一致，勿随手排序」的约束改后自然失效，要更新注释） | FE |
| **8** | **katex 版本对齐（0.17 → 0.16）** | 安装 **−4.3 MB**，且修掉 CSS/JS 版本错配 | `apps/fe/package.json` 与 `packages/panels/package.json` 的 `katex` 改 `^0.16.0`（或直接删声明，让 `packages/panels/src/markdown/markdown-preview.tsx:8` 的 CSS 从 `rehype-katex` 的传递依赖解析）。之后 `bun install` 应只剩一份 katex | `du -sh node_modules/.bun/katex@*` 只剩一条；打开含公式的 markdown 目视对比 | 低 | FE |
| **9** | **剔除 KaTeX 的 ttf/woff（只留 woff2）** | npm tarball **−876 KB** | 在 `packages/app/scripts/bundle-resources.sh` 已有 `find … -name '*.map' -delete` 的位置加一条 `find "${TARGET_FE_DIR}" \( -name 'KaTeX_*.ttf' -o -name 'KaTeX_*.woff' \) -delete`。katex CSS 的 `src` 顺序是 woff2→woff→ttf，删后不产生请求 | `bun run build` 后 `ls resources/fe-dist/assets/KaTeX_*` 只剩 woff2；浏览器打开公式页看 Network 无 404 | 低 | BUILD |
| **10** | **删 `apps/fe/package.json` 里 15 条纯转发依赖** | 0 字节，但消除同库双份进 bundle 的隐患（§3.2 就是活案例） | `@base-ui/react` `@dnd-kit/{core,sortable,utilities}` `class-variance-authority` `clsx` `ghostty-terminal` `highlight.js` `katex` `mermaid` `react-markdown` `rehype-highlight` `rehype-katex` `remark-gfm` `remark-math` `tailwind-merge` | `bun install && bun run --filter @tmex/fe build` 通过，产物 hash 与首屏 gzip 不变 | 低 | FE |
| **11** | **i18n 82 条死 key** | locale −11.5 KB raw，每语言 chunk −1.1 KB gz | 只改 `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json`，再 `bun run build:i18n`。名单见 §5.1 与子调查全表。顺手修 `sshError.sshConfigRefNotSupported` 拼写 | `bun run build:i18n` 后 `bun test packages/shared`；三语言各跑一遍 e2e；**严禁**手改/lint `resources.ts`/`types.ts` | 低-中 —— 模板前缀已穷举排除，但 `nodes.upgrade.allHint` 这类要再确认一次 | FE |
| **12** | **删 `--fc-*` 11 个 + `--chart-1..5`** | 首屏 CSS **−394 B gz** / −4.7 KB raw，`themes.css` −249 行 | `packages/theme/src/tokens.css:38-42,57-67`（`:root` + `.dark`）与 `packages/theme/src/preset-css.ts:38-42,51-61`，再跑 `scripts/theme/build-theme-presets.ts` | `bun test packages/theme`（`presets.test.ts` 的 `semanticTokensFromRoot()` 自动跟随，无需改断言）；切各 preset 目视 | 低（chart token 若打算做图表则属「预留」，**需产品确认**） | FE |
| **13** | **22 个死导出 + 15 个 schema `*Row` + 7 个 contracts 僵尸类型** | ~120 行 | 见 §1.1 / §1.2 / §1.3 逐条。`weixin/ilink/types.ts` 的 4 个常量**保留** | `bun run lint`（`biome check` + `scripts/complexity/gate.ts`）；`bun test` 全量 | 极低（纯类型 + 零引用函数） | BE + FE |
| **14** | **删 `packages/app/scripts/poc/node-datachannel-loader.ts` + `scripts/health-check.sh`** | 407 行 | 见 §1.4 | `rg -n "node-datachannel-loader\|health-check"` 归零；`bun run build:tmex` 通过 | 极低 | BE |
| **15** | **`docs/images/screenshot.png` 重压** | **−1.0～1.2 MB**（占 docs 总量 55%+） | 1.37 MB 的 README 首屏截图，`pngquant`/`oxipng` 或转 WebP，目标 200–350 KB。README 里本来就按 640 px 显示 | 目视 | 无 | DOC |
| **16** | **README 安全声明纠正 + 补 hub/mesh 能力段** | 0 行，但是**安全误导修正** | `README.md` §Security、`README.zh-CN.md:81`。同步补 hub/node 多机（`tmex init --role`、`hub join`）能力介绍 | 人工复核 | 无 —— 收益最高的零风险项 | DOC |
| **17** | **补齐 `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md` 的 20 个缺失 kind + 加 CI 比对** | ~25 行文档 | 缺 `0x020b–0x0215`、`0x0307`、`0x0801–0x0803`、`0x0a01–0x0a05`。建议加一个把 `packages/shared/src/ws-borsh/kind.ts` 与文档表做比对的脚本，挂到 `bun scripts/complexity/gate.ts` 旁 | 新脚本自检 | 无 | DOC + BE |
| **18** | **semver 三合一 → `packages/shared/src/semver.ts`** | ~91 行 | 删 `apps/gateway/src/system/semver.ts`(61) 与 `packages/app/src/lib/semver.ts`(30)，改 5 个调用点：`system/{release-download,upgrade-service,update-check}.ts`、`app/lib/{upgrade-verify,bun}.ts` | **必须逐个调用点确认「不可解析」语义**（`null` vs `0` vs 抛异常）；`bun test apps/gateway packages/app`；跑一次真实升级演练 | 中 —— 语义差异是真的，改错会让版本比较静默走错分支 | BE |
| **19** | **发布包下载/校验合并到 `packages/shared/src/release/verify.ts`** | ~100 行 | `apps/gateway/src/system/release-download.ts:79-87` ≡ `packages/app/src/lib/upgrade-verify.ts:16-24`（diff 为空）；`CHECKSUMS_REQUIRED_SINCE` ≡ `SHA256SUMS_REQUIRED_SINCE`。新文件按相对路径 import（同 `packages/shared/src/env/load-env.ts` 的 Node-only 模式，**不进浏览器 barrel**）。顺手删掉恒真的 `< 1.1.4` 跳过校验分支（§2.5） | `bun test apps/gateway/src/system packages/app/src/lib`；**必须做一次完整升级演练**（本地临时实例，绝不碰生产） | 中 —— 升级链路 | BE |
| **20** | **`http.ts` wrapper + 重复测试合并** | ~110 行测试 + 2 个 wrapper | `apps/gateway/src/api/http.ts`(24) 与 `packages/app/src/runtime/http.ts`(22) 都只 re-export `packages/shared/src/http/read-body`；两个 65 行测试标题重叠 86%。改调用点直接 import shared，测试并入 shared 侧 | `bun test apps/gateway packages/app packages/shared` | 低（需先确认 shared 侧覆盖等价，不足先补） | BE |
| **21** | **TOTP URI 合并 + `mesh-hubs`/`mesh-nodes` 轮询器抽取 + `download-transfer`/`bulk-transfer` 合并 + 三个设置弹窗抽壳 + motion 5 个死导出** | ~300 行 | §4.4 / §4.6 / §4.8 / §5.3 逐条 | 各自包的 `bun test`；文件传输要跑 REST 与 direct 两条路径 | 低-中（`bulk-transfer` 的取消/清理语义要逐条对齐；轮询节流语义不能改） | FE + BE |
| **22** | **prompt-archives 二进制负载治理** | −44 KB（确定）～ **−5.1 MB**（含 gzip diff + 压 png） | (a) 删 4 组完全重复文件 44 KB（`2026083101-.../sub/E{1,3,4}-codex-out.md`、`2026083100-.../sub/lint-final-tests.txt`）；(b) 39 个 diff/patch **gzip**（4.1 MB → ~0.4 MB，内容零丢失）；(c) 34 张 png `pngquant --quality 60-80`（1.9 MB → ~0.5 MB） | 解压抽检 | (a) 极低；(b)(c) **需用户确认**（归档即历史） | DOC |

---

## 9. 需用户拍板的项

| 项 | 问题 | 影响面 |
| --- | --- | --- |
| **legacy 状态流下线** | canonical 已是默认，但 (a) `isLegacySizeCommand`（`websocket-transport.ts:49,282`）仍把「尺寸补发 vs 尺寸变更」压回 legacy 控制面；(b) 1.1.21 刚发，现网 mesh 节点几乎都还没有 `canonical-state-v1`。两条都解决后可删 **1,742 行**（源码 1,071 + 测试 671）+ 三个 kind 的发送侧 | 破坏与未升级节点的兼容 → **必须先定「最低可入网版本」** |
| **`tailwind-merge` 替换** | 实测 **7,756 B gz**，全部是 class-group 表，只服务 `cn()`。替换成「后写覆盖同前缀」的极简实现或 `clsx` 单用，需审 194 处调用点 | 视觉回归风险；收益中等 |
| **`react-router` 替换** | 实测切出成本 **32,794 B gz**。已排除「误打 dev 构建」的可能（dev/prod 产物字节相同）。真要瘦得换库或降到声明式路由 | 大改造；建议先不做，记录即可 |
| **chart token 是否预留** | `--chart-1..5` 当前 100% 未用。若近期要做图表则保留 | 产品 |
| **7 个无 script 的 bench（907 行）** | `packages/{ghostty-terminal,shared,stores,terminal-ui}/bench/*` 无 package.json 挂载，只能手工 `bun xxx.bench.ts` | 是补 script 还是删 |
| **`/api/tmux/tree` 与 `/api/settings/theme` 下线** | 各 ~316 / ~180 行，但前者要先改 `scripts/hub-e2e/driver/files.ts:38`，后者要改写 6 个 e2e spec（其中 `theme-broadcast.spec.ts:9` 测的正是「HTTP 改主题**不**触发 WS 广播」这条负向断言，删路由等于删该断言） | 收益/成本比不高 |
| **`POST /api/hub/nodes/:id/revoke` 下线** | 仅测试调用，产品走 `/api/auth/keylog`。但这是 hub 管理面公开 API，**旧版本入口节点上跑的旧 FE bundle 可能仍在调**。建议先保留路由回 410 一个 release 周期 | 兼容 |
| **prompt-archives 的 diff/patch/png 压缩** | 6.0 MB / 37.5%。gzip 方案内容零丢失，但改变了「打开即读」的归档体验 | 归档策略 |
| **内置字体（21 MB）** | 第 21 轮已决定保留，本轮无新证据推翻 | 已决 |

---

## 10. 诚实记录：查过但没有发现的

- **注释掉的代码块**：0（与第 21 轮一致）。
- **`TODO` / `FIXME` / `HACK`**：`apps/` + `packages/` 下 0 命中。
- **`@deprecated`**：`apps/` + `packages/` 下 0 命中（rtc 的那批第 21 轮已清）。
- **快照测试 / `__snapshots__` / `.only`**：全仓 0。
- **两侧都死的 feature flag**：无。所有布尔 env flag 两分支可达；`TMEX_MANAGED_BUILD` 的单侧不可达是**构建期有意 DCE**。
- **死表**：40 张全活。
- **死 WS kind**：0。
- **零引用测试 helper**：0。
- **测试针对已删除模块**：0。
- **`scripts/complexity/allowlist.json`（145 条）陈旧项**：0 个文件缺失，3 个 `<anon>` 是正常匿名函数。
- **`react-router` 误打 development 构建**：**已排除**（7.13.0 的 `dist/development` 与 `dist/production` chunk 字节数相同，exports 映射本就只指向前者）。
- **`packages/ui` 死组件**：24 个子路径出口全部有消费者。
- **`packages/panels` 死出口**：19 个子路径出口全部有消费者。
- **孤儿源文件**：2,139 个 TS 文件里只有 §1.4 那 2 个（其余全是构建入口/配置/按路径 spawn）。
