# Phase 0 结果：探索与基线（2026-08-27）

worktree：`../tmex-enhanced-wt-hub`，分支 `feat/hub-node`，base `4a14ff2`（main，含设计 v3.2）。原始报告在 `sub/`：`e0-1-result.md`（载体拆分）、`e0-2-result.md`（前端 URL/运行时）、`e0-3-result.md`（启动/安装/打包/env/DB）、`e0-4-result.md`（库验证）、`baseline.md`。本文件是给下一个会话的摘要与决策；细节看原始报告。

## 基线（`sub/baseline.md`）

所有包 `bun test` 全绿（gateway 1472、shared 141、ws-client 75、stores 101、api-client 34、panels 196、app 90、terminal-ui 205、fe 9）。`tsc --noEmit` 既有错误数：gateway 27、theme 10、api-client 5、stores 1、app 1，其余 0。每批 commit 前不得高于这些数。

## E0-1 载体拆分（B1-1 的输入）

- 现状：`ServerWebSocket` 同时承担传输、协议协商状态（`ws.data.borshState`：`seqGen / negotiated / clientImpl / maxFrameBytes / chunkReassembler / selectedPanes / subscribedPanes`）与业务状态；另有 `SessionStateStore`（`session-state.ts:103`）以 socket 为键存设备状态、选择事务、输出门控、频控，`SwitchBarrier.pendingTransactions`、`WebSocketSendGuard` 的 WeakMap、`AgentWsHub` 的 Set、`managed-entry.socketOwners` 也都以 socket 为键。完整清单见报告 §1（约 170 处）。
- 发送路径：`websocket-send-guard.ts` 消费 Bun `send()` 数值（>0 sent / -1 backpressure / 0 dropped），5 s 背压超时、drain 后若跳帧则 `backpressure_gap` 终止；`getBufferedAmount()` 只用于统计。Canonical sender 依赖三态结果（`sent / backpressured / dropped`）。**Carrier 映射**：`>0→'sent'`、`-1→'backpressure'`、`0/异常→'closed'`；Guard 状态改为按 Carrier 存（背压属于传输），逻辑流缺口仍属会话。
- 未使用：`ws.readyState`、`remoteAddress`（仅测试 fake）、Bun topic/publish。没有 `ws === other` 字面比较，但大量 Set/Map 依赖引用身份。
- **注意两套 seq**：`borshState.seqGen`（真正的 envelope seq）与 `session-state.ts:20` 的 `wsConnection.seq`，实现时不要合并，也不要让第二载体重置任一。
- attach 第二载体时必须复用：`seqGen`、协商结果、未完成的 chunk 重组、selected/subscribed、`SessionState`、pending 事务、`CanonicalFeedSession`、agent 订阅；新载体只拥有自己的发送队列/背压/drain/生命周期，**不重发 HELLO**（`index.ts:380` 的 `agentWsHub.registerClient` 不能重复调用）。
- 九步重构计划（报告 §5）：新增 `ws/carrier.ts`（`Carrier` + `BunSocketCarrier`）与 `ws/gateway-session.ts`（`id / borshState / state / primary / direct / activeCarrier / closed` + `attachCarrier / detachCarrier / switchActiveCarrier / handleCarrierDrain`）→ `BorshClientState` 改名 `BorshSessionState`，Bun socket data 只剩 `{session, carrier}` → Guard/`sendToClient` 面向 Carrier，`maxFrameBytes` 显式传入 → `ws/index.ts` 内部签名全部 session 化，`connectedClients: Set<GatewaySession>`、`canonicalSessions: Map<GatewaySession, …>` → switch-barrier / session-state 改 session 键，定时器闭包捕获 session、发送时动态取 `activeCarrier` → registry / legacy / theme / metrics / dispatcher / tmux handlers 机械替换 → `agent/ws-hub.ts` 改 `Set<GatewaySession>` → `runtime.ts` / `managed-entry.ts` 保留为 Bun 适配边界，`socketOwners` 改 `Map<GatewaySession, …>` → 测试 fixture 改为 `createGatewaySession()` + `createFakeCarrier()`。
- 风险（报告 §7）：`CanonicalFeedSession.awaitingSocketDrain` 假设单一 drain 来源，切换载体时必须校验 drain 来自当前 `activeCarrier`；`switch-barrier.ts:132/194-204/270-273` 与 `websocket-send-guard.ts:125-131` 的闭包捕获 `ws`；受影响测试约 25 个文件（报告 §6 有表）。

## E0-2 前端（F4-1/F4-2/F4-3 的输入）

- **绕过 `ApiClient` 的点**（必须迁移）：`SettingsPage.tsx:128`（`/api/settings/restart`）、`use-site-settings-form.ts:37,56-62`（`/api/settings/site`，且用默认 `useSiteStore`）、`file-urls.ts:16,22`（`fileRawUrl / fileDownloadUrl` 直接进 DOM）、`FilePage.tsx:98/116/123/129/177/279`（img/audio/video/iframe/markdown 图片/`<a href>`）、`FilePage.tsx:141/193/293`（`fetchFileContent / fetchFileStat / triggerDownload` 未传 client，落到 `defaultApiClient` 与 `defaultRuntime.host`）、`file-node-actions.tsx:52-53`（拖拽下载 URL）、`ws-client/client.ts:12-13`（默认 `/ws`）。其余 `/api/...` 字面量都已经过 `ApiClient.fetch()`。无 EventSource / service worker / push subscription。
- `ApiClient(baseUrl)` 已支持 `'/n/<id>'` 前缀（纯字符串拼接，要求 baseUrl 不以 `/` 结尾）；`createGatewayConnection({ wsUrl })` 可注入 WS 地址；两者都不知道 nodeId，需要 `NodeConnectionManager` 计算并注入。前端不读 cookie（唯一 cookie 是 `sidebar_state`）。
- **多运行时碰撞点**（报告 §3 表）：`defaultRuntime` 与默认 store 导出、`react.tsx:15` 的默认 Context、`setDefaultNotificationSink`、`flow-bridges.ts` 的导航/侧栏 bridge 互相覆盖、`site-fallback.ts` / `use-pane-agent-state.ts` 硬读默认 runtime、全局 `QueryClient`（query key 无 nodeId，如 `['devices']`）、`main.tsx` 直接读 `localStorage['tmex-ui']`、`tmex_sidebar_width`、bell store 以 paneId 为键、ws-client 全局 client / state machine / pane registry、selection / jump / add-device 全局事件不带 nodeId、`document.title` 互相覆盖。**当前 FE 根本没用 `RuntimeProvider`**（`main.tsx:125-132` 直接 import 默认 store）。
- 路由：现有 `/`、`/devices`、`/devices/:deviceId[/windows/:windowId/panes/:paneId]`、`/settings`、`/file/:ref`；`global-device-provider.tsx:55-60` 只匹配 `^/devices/`；`device-tree-navigation.ts:10-11,46-72` 与 `page-actions.tsx:128-140` 写死旧路径。建议 `/n/:nodeId` 作为 `NodeRuntimeBoundary`（取 nodeId → `NodeConnectionManager.get` → `RuntimeProvider`），旧路由映射到 `self`，`GlobalDeviceProvider` 移入 Provider 内。
- 设置页里大量 panel 已用 `useRuntime().apiClient`，只要处在正确 Provider 下即可（报告 §6 列表）。
- 缺的测试：`resolveNodeUrl`、`/n/:id/api|ws`、`NodeConnectionManager` 与 Provider 并存、FilePage 媒体 URL、多 node query key 隔离、事件携带 nodeId。

## E0-3 启动 / 安装 / 打包 / env / DB（B2-3、C5-1、C5-2 的输入）

- 启动链：`server.ts` 先 import `bootstrap-env`（`loadEnv()`），读 `TMEX_BIND_HOST / GATEWAY_PORT / TMEX_FE_DIST_DIR`，`createTmexGatewayRuntime()` → `createGatewayRuntime({ systemApiHandler })`；`GatewayRuntime` 构造时无条件跑迁移、seed 本地设备、初始化站点/agent 设置、`primeLocalShellPath()`（探测 tmux）、清理上传临时目录、建 `WebSocketServer`、注册各 bridge、刷新 Telegram/微信、启动 push/agent/watch supervisor。`Bun.serve` 只有 `hostname/port/fetch/websocket`；请求顺序 `gateway.handleRequest → serveFrontend`。无 SIGINT/SIGTERM 处理，重启靠 `process.exit` + service manager 拉起。
- `handleRequest`：`/ws` → upgrade（需真实 Bun `Server`）；`/api/*` 与 `/healthz` → 路由表，未命中 API 404；其余 `undefined`。`ApiRouteContext.server` 必填但 handler 都不用 → **`dispatchHttp(Request, {uid})` 落点**：与 `handleRequest` 并列，复用路由表，不做 upgrade，顺便把 `server` 改可选。远程 `ws` 流不能走 `handleUpgrade`，直接建 `GatewaySession` + `LinkStreamCarrier`。
- 安装：`InstallLayout` 无 native 字段（加 `nativeDir = <installDir>/native`）；`app.env` 由 `buildAppEnvValues()` 写 7 个键，`run.sh` 逐行 export 后强制 `TMEX_FE_DIST_DIR / TMEX_MIGRATIONS_DIR`；production 的 `loadEnv()` 不读文件只校验。**`upgrade` 不重写也不备份 `app.env`**，新增变量要有缺省策略。CLI 只有 `init / doctor / upgrade / uninstall`，自定义 `parseArgs`（无子命令结构，`hub user add x` 会解析为 command=`hub`、positionals=`[user, add, x]`）→ 需要加嵌套分派。`InitConfig` 无角色字段。service：systemd user unit / launchd plist，重启 = restart/bootstrap。
- 打包：`build-runtime.ts` 用 Bun bundler 打 `dist/runtime/server.js`（esm、target bun、无 external）；资源 `resources/fe-dist` + `resources/gateway-drizzle`；WASM 先例是 ghostty（`copy-runtime-assets.sh` 复制到 runtime 旁）；native 先例只有 `--external cpu-features`。**尚无 node-datachannel 装载方案**，需新写 loader 让 bundler 只见 JS 层、`.node` 走运行时绝对路径。工作区无构建产物，tarball 体积需构建后测。
- env：`loadEnv()` 无集中 schema；新变量落点 `load-env.ts` + `apps/gateway/src/config.ts`；`TMEX_MASTER_KEY` 目前只检查非空。**命名统一**：设计与实现一律用 `TMEX_HUB_PUBLIC_URL`（plan 中原写的 `TMEX_PUBLIC_URL` 已删，passkey origin 取自请求）。
- DB：schema 全在 `apps/gateway/src/db/schema.ts`，迁移 `apps/gateway/drizzle/0000–0017`，`bun run db:generate`；**managed build 有硬编码迁移文件列表**（`db/managed-migrations.ts:7-26`）新增 SQL 时必须同步。hub,node 只构造一个 `GatewayRuntime`、迁移只跑一次。
- 角色矩阵落点：`server.ts:23-36` 组装 + `fetch` 顺序；`runtime.ts:164-178` 的 stop 需接 peer/uplink/hub 分层关停。
- 测试：无 `server.ts` 启动链单测；`install.test.ts`、`env-file.test.ts`、`load-env.test.ts`、`args.test.ts`、`service.test.ts`、`api/index.routing.test.ts`、`ws/index.test.ts` 可作为扩展基础。

## E0-4 库验证（B1-2/B1-3/B3-1 的输入，详见 `sub/e0-4-result.md`）

版本锁定：`hash-wasm 4.12.0`、`@noble/curves 2.3.0`、`@noble/hashes 2.3.0`、`@simplewebauthn/server|browser 13.3.x`（锁具体版本）、`node-datachannel 0.33.1`、`@zorsh/zorsh 0.4.0`（仓库已有）。**仓库当前是 noble 1.x**，2.x 为 ESM-only 且必须用 `.js` 子路径（`@noble/curves/ed25519.js`、`@noble/hashes/hkdf.js`、`@noble/hashes/sha2.js`）。

- **hash-wasm**：`argon2id({password, salt, parallelism, iterations, memorySize(KiB), hashLength, outputType:'binary'})`，Argon2 v0x13；WASM 以 base64 内嵌在 `dist/index.esm.js`，vite 与 Bun 单文件打包都不需要资产处理；无 `exports` 字段（`main` UMD / `module` ESM）。`validateOptions()` 会就地改写入参，不要传冻结对象。**未实际在 Bun 运行包本身**（探索时 registry DNS 不可用）；用独立 Argon2id 实现算出向量 `password="tmex-test", salt=16×0x01, m=65536,t=3,p=1,len=32 → c309e52473a3209eb21f065c873725f397a79dc8de84d30b078f95c2a3ae8c85`，B1-3 第一件事是用 hash-wasm 复核并写成测试向量。
- **noble**：`ed25519.getPublicKey(seed) / sign(msg, seed) / verify(sig, msg, pk)`，32 字节 seed 直接当私钥（内部做 SHA-512 + clamp）；`x25519.keygen() / getSharedSecret(sk, pk)` 默认拒绝低阶点；`hkdf(sha256, ikm, salt, info, 32)`。Ed25519 默认 ZIP-215 宽松验证，协议要 RFC 8032 严格则传 `{zip215:false}`。不要把 Ed25519 seed 当 X25519 标量用。
- **SimpleWebAuthn**：server 的 `generateRegistrationOptions / verifyRegistrationResponse / generateAuthenticationOptions / verifyAuthenticationResponse` 签名与返回结构见报告 §3；`credential.publicKey` 是 COSE CBOR 字节；`expectedChallenge` 必须是 base64url 字符串或一次性消费回调；浏览器端 `startRegistration({optionsJSON}) / startAuthentication({optionsJSON})`。**Bun 风险**：server 依赖 `@peculiar/x509 → tsyringe → reflect-metadata`，Bun 单文件构建可能报 `tsyringe requires a reflect polyfill`（上游 discussion #744），B1-3 需在 `bun build` 产物上实测，必要时 `import 'reflect-metadata'`。
- **node-datachannel**：主包 `main` CJS / `module` ESM，依赖 `detect-libc`，平台包 `@node-datachannel/<platform>` 内只有 `node_datachannel.node` + `package.json`（`main` 指向 `.node`），N-API 8，engines node ≥ 18.20；loader 顺序为本地 build 路径 → `require('@node-datachannel/<platform>')`，与设计的绝对路径装载不同，C5-2 需改写 loader。`remoteFingerprint()` 返回 `{value:'AA:BB:…', algorithm:'sha-256'}`（PC 销毁后返回数字 0）；本地指纹从 `onLocalDescription` / `localDescription().sdp` 的 `a=fingerprint` 行解析；背压 API `bufferedAmount() / maxMessageSize() / setBufferedAmountLowThreshold() / onBufferedAmountLow()`，`sendMessageBinary()` 返回 false 不一定是背压。**PoC 缺陷**：C++ 入口要求 `IsBuffer()`，`sendMessageBinary(Uint8Array)` 不合规，必须 `Buffer.from(...)`；B3-1 第一件事是补回环 PoC（Buffer、指纹、背压、`maxMessageSize`）。
- **Zorsh**：`b.struct / b.string / b.u32 / b.u64(bigint) / b.bytes(N)（固定长度，解码 Uint8Array）/ b.bytes()（u32 长度前缀）/ b.enum（u8 index）/ b.option（null）`，`schema.serialize()` 可直接用于独立签名对象，不经 envelope；示例 schema 见报告 §5。enum 变体顺序即编码，不可重排；`u64` 必须 `bigint`。
- **WebCrypto**：Bun 1.3.14 实测 AES-256-GCM（12B IV、128-bit tag、AAD；输出为 `ciphertext‖tag`，需自行切末尾 16 字节）与 HKDF-SHA-256 `deriveBits` 可用；浏览器 WebCrypto 需安全上下文（https / localhost）——这与 passkey 的限制一致，但**密码派生路径在 `http://<内网 IP>` 下也要能用**：argon2（hash-wasm）与 Ed25519（noble）不依赖 WebCrypto；SecureChannel 只在 node 侧；浏览器只在 TOTP `k_totp` 的 HKDF 上用到 WebCrypto → B1-3 把 HKDF 也用 `@noble/hashes/hkdf.js` 实现，浏览器侧完全不依赖 `crypto.subtle`。

实现前必须补的三项验证：hash-wasm 与独立实现向量一致；node-datachannel 回环（Buffer/指纹/背压）；SimpleWebAuthn server 在 `bun build` 产物上可运行。

## 对 plan-00 的修正

- C5-1 的 env 变量改为 `TMEX_PEER_PORT`、`TMEX_HUB_PUBLIC_URL`、`TMEX_ROLES`、`TMEX_HUB_URL`（已改）。
- B1-1 的验收补一条：`ws/index.ts`、`switch-barrier.ts`、`websocket-send-guard.ts` 中捕获 `ws` 的闭包改为捕获 session / carrier，并新增"旧载体 drain 不推进 canonical 状态"的测试。
- B2-2 转发 `ws` 流时不经 `handleUpgrade`（E0-3），`ApiRouteContext.server` 改可选（B2-2 顺手做）。
- F4-2 范围明确包含：`main.tsx` 改用 `RuntimeProvider`、`GlobalDeviceProvider` 入 Provider、`flow-bridges` / `site-fallback` / `use-pane-agent-state` 去默认 runtime、QueryClient key 加 nodeId、`device-tree-navigation` / `page-actions` 路径带 nodeId。
- C5-2 需先写 node-datachannel loader 的 PoC（bundler 只见 JS 层）再定 manifest 格式。

## 下一步（Phase 1）

按 plan-00 派 grok ×3：B1-1（按 E0-1 §5 九步）、B1-2（`packages/shared/src/link/`）、B1-3（`packages/shared/src/auth/` + `apps/gateway/src/auth/`，API 用法以 e0-4 为准）。三者文件不重叠；每个 agent 先读本文件与对应 `sub/e0-*-result.md`。commit 前跑对应包 `bun test` + `tsc` 不高于基线 + `biome check`。
