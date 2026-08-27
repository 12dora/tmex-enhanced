# hub / node 多节点架构 — 实施计划 plan-00（对应设计 v3）

设计：`docs/hub/2026082700-hub-node-architecture.md`（须先读，v3：mesh + 用户自持密钥 + hub 不作信任根）。审查：`design-review-00.md`（v1）、`security-review-01.md`、`design-review-01.md`（v3）。

## 背景与注意事项（无上下文时从这里开始）

- 工作在 worktree `../tmex-enhanced-wt-hub`（分支 `feat/hub-node`，基于 main）。主仓不改代码。
- 分工：grok-4.6(high) 后端；Claude Opus 5 前端；codex gpt-5.6-luna(xhigh) 只读探索；codex gpt-5.6-sol(high) 审查（偏过度防御，是否修由指挥官判断）。所有 prompt 用英文。
- 并行原则：同一批次内 agent 文件范围互不重叠；agent 不 commit；每批由指挥官跑 `bun test`（包内）+ `bunx tsc --noEmit -p .` + `bunx biome check <改动文件>` 后 commit。
- 禁止触碰生产 tmex（9883 / `~/Library/Application Support/tmex/`）与 `tmex` tmux session；测试用 test env 与独立 tmux socket。
- 前端改动期间不跑 e2e；`apps/fe` 单测用 `bun test src/`。生成文件（i18n resources、fe-dist）不 lint。
- 存量行为（standalone）必须全程不变：每批 commit 前跑 gateway / ws-client / stores 现有测试。
- 新依赖（实现前用 Context7/源码核对 API）：`hash-wasm`（argon2id，浏览器与 Bun 共用）、`@noble/curves`（Ed25519 / X25519）、`@noble/hashes`（HKDF/sha256）、`@simplewebauthn/server|browser`、`node-datachannel`（仅 JS 层内联）。

## 阶段划分

### Phase 0 — 探索与基线（codex luna，只读，1 批并行）

- E0-1 `ws/index.ts` 及 handler 文件中所有 `ServerWebSocket` 引用清单（按文件/行、用途分类：身份键 / 发送 / 状态），产出 `GatewaySession` + `Carrier` 拆分的精确改动清单。
- E0-2 前端所有未经 `ApiClient` 的 URL 构造点（`fetch('/api`、`file-urls.ts`、`src=`、`href=`、`new WebSocket`）清单，供 F4-2 迁移。
- E0-3 `packages/app` 的 `server.ts` / `install.ts` / `init.ts` / `install-layout.ts` / `service.ts` 启动与安装流程摘要，产出角色矩阵落地点。
- E0-4 `hash-wasm` argon2id 与 `@noble/curves` ed25519 在 Bun 1.3.x 与浏览器的 API 核对（含 wasm 内联进单文件 runtime 与 vite bundle 的方式），`@simplewebauthn/server` 在 Bun 下的可用性。
- 基线：各包 `bun test` 与 `tsc` 错误数记录在 `sub/baseline.md`。

### Phase 1 — 地基（grok 3 个并行，文件不重叠）

- B1-1 **载体抽象**（`apps/gateway/src/ws/**`）：按 E0-1 清单引入 `GatewaySession` 与 `Carrier`（`BunSocketCarrier`），`websocket-send-guard` 面向 `Carrier`，所有以 socket 为键的 Map 改为以 session 为键。不引入新协议。验收：ws 目录现有测试全绿、行为不变。
- B1-2 **link 编解码与流控**（新 `packages/shared/src/link/`）：帧编解码、流状态机、窗口流控、`LinkSession` 接口、`InMemoryLink`、`WebSocketLink`（Bun 客户端与服务端）、`SecureChannelLink`（X25519 + HKDF + AES-GCM 逐帧，方向位 ‖ 计数器 nonce）。单测覆盖流控、RST、加密向量。
- B1-3 **身份原语**（新 `packages/shared/src/auth/` 浏览器/Bun 共用 + `apps/gateway/src/auth/`）：规范编码（Borsh schema + `domain`）、根钥派生（NFKC + argon2id 固定参数，固定测试向量）、`delegation` 签发/验签（根钥与 passkey 两种）、登录对象构造与验签、challenge 登记与原子消费、`node-session`（opaque sid、`via`、`delegation_method`/`credential_id`；18 小时滑动 + 7 天绝对上限，5 分钟节流续期与 `x-tmex-session-renewed` 头）、`mesh reset-root` 本地恢复、node Ed25519/X25519 密钥生成与 `TMEX_MASTER_KEY` 加密落库、节点证书链（`authorization` → `certificate` → `admit-node` / `revoke-node`）、`user_key_log` 链（seq/prev_hash/epoch、分叉硬失败、`rotate-root` 新 epoch 清理）、TOTP 加解密（HKDF `k_totp`、随机 nonce、AAD）与校验、peer 握手 transcript 签名与 HKDF 会话密钥、drizzle 迁移（§2 全部表）、cookie 解析与 `Set-Cookie` 生成。不接路由。

### Phase 2 — hub 与 mesh 运行时（grok 3 个并行）

- B2-1 **HubRuntime**（新 `apps/gateway/src/hub/`）：`/hub/uplink` 握手、`NodeRegistry`（重复连接替换旧连接）、`node.list` 广播（元数据 + `key_log_head` + rtc 配置）、`key.log` 服务、`relay` 流（校验 `user_id`、双向拷贝、不解析内层）、`rtc.signal` 转发与 `rtcSession` 归属校验、`enrollments/redeem`（核对 `enroll_pk` 与授权、验证书签名、回传全量日志与证书）、redeem 结果推送给发起 enrollment 的 entry 以便签 `admit-node`、hub 管理 API（`nodes` list/rename/revoke、`enrollments` create，挂在 hub 机 node 的 `/api/hub/*` 下、鉴权 `node-session`）、`user_key_log` 存储。Borsh 新 kind `NODE_EVENT` / `RTC_SIGNAL` / `CARRIER_SWITCH` / `CARRIER_SWITCH_ACK` 定义在 `packages/shared/src/ws-borsh/kind.ts` + schema，由 B2-1 负责。
- B2-2 **MeshRuntime**（新 `apps/gateway/src/mesh/`）：`UplinkClient`（退避、auth、心跳、`node.status`、`node.list` → `peer_cache` 元数据、`key.log` 拉取与 `node_certs` 应用）、`PeerManager`（peer 监听端口签名信令、双向握手 + 会话密钥、`DataChannelLink` / relay `SecureChannelLink` 选择、缓存地址轮询、空闲关闭）、`/api/auth/*`（challenge / login 密码与 passkey / logout / mode / passkey 注册仪式）、`/api/mesh/*`、`/mesh/ws`、`/n/:id/*` 转发（前缀剥离、header 过滤、`auth` 注入、响应头 allowlist + CSP sandbox + MIME 覆盖、half-close 与 RST ↔ abort）、`http` 流 → `GatewayRuntime.dispatchHttp(Request, {uid})`（新增于 `runtime.ts`）、`ws` 流 → `LinkStreamCarrier` + `GatewaySession`、本地 UI 鉴权中间件（standalone 旁路）。
- B2-3 **角色装配**（`packages/app/src/runtime/server.ts`、`apps/gateway/src/runtime.ts` 构造选项）：`TMEX_ROLES` 解析（`standalone | node | hub,node`）、请求分发顺序（hub → mesh → gateway → 静态）、`InMemoryLink` 双角色接线、关停顺序。与 B2-2 在 `runtime.ts` 的分界：B2-2 只加 `dispatchHttp`，B2-3 只加构造选项与角色分支。

集成测试（Phase 2 末，grok 单独一个 agent）：同进程 hub + 两个 gateway/mesh（`InMemoryLink`），覆盖登录 fan-out → `/n/:id/api/devices` → `/n/:id/ws` HELLO/DEVICE_CONNECT 透传 → relay → 上传取消 → 吊销 → **失陷模拟三用例**（设计"测试策略"）。

### Phase 3 — 直连（grok 2 个 + Opus 1 个并行）

- B3-1 **RtcPeerManager + DataChannelCarrier + DataChannelLink**（`apps/gateway/src/mesh/rtc/`）：node-datachannel 动态加载（`<installDir>/native/` 探测、缺失降级）、浏览器↔node 与 node↔node 信令（字典序 offerer）、`sess` 首帧 nonce 鉴权（`/api/rtc/authorize`，双向 DTLS 指纹绑定）、64 KiB 分片重组、背压、`CARRIER_SWITCH` 屏障与入站缓冲、断开回切。integration 测试用回环 PeerConnection。
- B3-2 **bulk 协议**（`apps/gateway/src/mesh/rtc/bulk.ts` + `files.ts` 最小改动）。
- F3-1 **前端 DirectCarrierController**（`packages/ws-client/src/direct/`）：`RTCPeerConnection` 生命周期、信令、nonce、分片、屏障、回退重试、`getStats` 路径判定；`GatewayConnection` 暴露 `activeCarrier` 与诊断。单测 mock 两条载体验证屏障顺序。

### Phase 4 — 前端（Opus，3 个并行，文件不重叠）

- F4-1 **登录与账号安全**（`apps/fe/src/pages/Login*`、`packages/api-client` 的 auth/mesh 端点、401/4401/`NODE_LOGIN_REQUIRED` 拦截、`delegation` + 浏览器临时钥内存持有与登录 fan-out、passkey 注册/登录（`@simplewebauthn/browser`，`isSecureContext` 且域名 origin 门控）、修改密码（新 epoch 提示）/ TOTP / passkey 管理生成签名记录）。
- F4-2 **每 node 运行时与路由**（`packages/stores` 的 `NodeConnectionManager`、`apps/fe/src/main.tsx` 路由、`global-device-provider.tsx`、`resolveNodeUrl` 与 E0-2 清单迁移、`file-urls.ts`）。
- F4-3 **Nodes 页、侧边栏聚合与路径徽标**（`apps/fe/src/pages/Nodes*`、`packages/panels/src/device-tree/**`、enrollment（生成 enroll 密钥对与授权、join 完成后自动签 `admit-node`、"待确认"）、吊销签 `revoke-node`、设备页头部双徽标、ICE 诊断弹层、bulk 接线到文件面板）。
- i18n key 由各 agent 加到源文件后，指挥官统一 `bun run build:i18n`。

### Phase 5 — CLI 与打包（grok，2 个并行）

- C5-1 `hub user add|passwd|totp`、`enroll`（enroll 密钥对、等待 join 后签 `admit-node`）、`hub join`（仅 HTTPS、join 串解析、生成节点证书、根钥一致性校验、`key.log` 链验签）、`hub leave`、`init --role`、`app.env` 新变量（`TMEX_PEER_PORT`、`TMEX_PUBLIC_URL`）、service 重启接线。
- C5-2 `direct enable|disable`、pinned manifest、libc 探测、integrity 校验、`install-layout.nativeDir`、`upgrade` 重下；`build-runtime` 内联 node-datachannel JS 层与 `hash-wasm` wasm；验证 tarball 体积增量。

### Phase 6 — 收尾

- codex sol 分 backend / frontend / cli 三路 review（把 `git diff main...` 写文件喂它），指挥官判断后修复。
- e2e：standalone 基线 + mesh 新用例（passkey 用 Playwright virtual authenticator）。
- 两台真实内网机器验证 `lan` 路径、hub 停机后互操作、直连中途断开不丢字。
- 文档：重写 `docs/2026021000-tmex-bootstrap/deployment.md` 的鉴权/部署部分；新增 `docs/hub/…-operations.md`（join / enroll / passkey / direct / 排障）。
- `plan-00-result.md` 存档。

## 验收（对应设计文档"验收标准"1–6）

每阶段结束：包内测试全绿、tsc 不高于基线、standalone e2e 基线不退化。Phase 2 结束必须通过失陷模拟三用例；Phase 3 结束必须在两台真实内网机器上验证。
