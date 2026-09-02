# 第十九轮计划：设置联动 / 接入面板崩溃与二维码 / 本机盒子与 HTTPS 精简 / 域名访问开关 / 节点详情弹窗 / 延迟测量 / 直连探测退避 / WebRTC 熔断 / known-issues

## 背景

- 分支 `feat/round19-settings-mesh-ux`，worktree `/Users/konata/code/tmex-r19`（主仓外），基于 main `2c2d13f9`（1.1.18）。
- 探索报告（codex luna）在 scratchpad `ex/EX-{A..H}-report.md`，关键结论摘录在本文；会话结束即失。
- 分工：grok 4.6（后端，`grok` CLI headless）、Opus（前端，Agent 工具）、codex sol（审查）、指挥官自跑实测与分批 commit。所有 agent 在同一 worktree 并行，文件集互不重叠，agent 不 commit。
- hub B（上海，`tmexhub-sh.jiefakj.com`）现状：80/443 由 LXD 容器 `web` 的宝塔 nginx 占用（另有 7 个站点，不能让出 443）；域名 DNS 在 **DNSPod**（不是 Cloudflare）；tmex 的 `tls_config` 为空（mode none），`TMEX_TRUST_PROXY=true`，云防火墙已放 9443。

## 现状要点（来自探索）

- 站点名/访问 URL 存在 `site_settings` 单行（`site_name`/`site_url`），首次由 `TMEX_SITE_NAME`/`TMEX_BASE_URL` 种子，之后 env 不再覆盖；`siteName` 被标题、PWA manifest、品牌、通知使用，`siteUrl` 被通知/pane 链接使用。mesh 节点名在 hub 的 `nodes.name`，改名走 `POST /n/<hub>/api/hub/nodes/<id>/rename` → node.list 广播 → 各节点 `peer_cache`/前端 store；不是 key-log 事件。前端「hub 模式」= `/api/auth/mode.mode==='mesh'` 且本机 `role` 含 hub。
- 「接入设备」面板由 `SidePanelHost` 用裸 `React.lazy` + `Suspense` 挂载，无 ErrorBoundary，路由也无 `errorElement`，任何 chunk 加载失败/渲染异常都落到 React Router 默认页「Unexpected Application Error! … 👋 Hey developer 👋」。`qrcode.react` 已在依赖里（TOTP 面板用 `QRCodeSVG`）。移动 tab 三步（open/add/launch），地址列表全部平铺无选择。
- 本机盒子三处地址：`加入地址`（`TMEX_HUB_URL` 种子，行内「更换 Hub」按钮）、`Hub 公开地址`（本机作为 hub 的 `TMEX_HUB_PUBLIC_URL`）、`当前 Hub`（`/api/mesh/hubs.attached` 实际挂靠的 hub，含 URL）。直连插件 pill 逻辑：supported/installed(+version)/active(=installed&&capable，非 enabled)/disabled，开关在下方。
- HTTPS：模式 none/external/selfsigned/acme；`https:{source,verified,publicUrl}`；ACME 支持 http-01（走 9883 的 `/.well-known/acme-challenge/`）与 dns-01（仅 Cloudflare）；证书存 `tls_config`；续期 12h 检查、提前 30 天；内置监听端口 `tls_config.tls_port` 默认 9443；无 HTTP→HTTPS 跳转。
- 节点管理：`HubStrip` 主 hub pill = 名称 + 「主 Hub」 + 「写入」；表格行动作 升级/重命名（行内输入，不比较是否改动即调 API）/移除（签名 revoke-node key-log）。
- 左上角延迟 = 浏览器 ↔ 当前入口网关 WebSocket 的 Borsh PING/PONG 往返（5s 一次，`Date.now()` 差，最新单样本，无平滑，PONG 不校验 nonce、允许重叠探测），PONG 走普通 `sendEnvelope` 与终端输出同队列（背压时可被拒/排队）。不含目标节点或 hub↔node 链路。

## 契约（前后端共同遵守）

### C1 站点设置联动
- `GET /api/settings/site` 增加：`effectiveSiteUrl: string | null`、`siteUrlEditable: boolean`、`siteNameLinkedToNode: boolean`、`nodeId: string | null`。
- mesh 模式下响应里的 `siteUrl` 即有效地址：hub 角色 = writer hub `publicUrl` ?? `hubPublicUrl` ?? 存储值；纯 node = `${attached hub publicUrl}/n/${nodeId}`（无 hub 地址时回退存储值）。standalone 不变。所有 `siteUrl` 消费方（通知、pane 链接）自动联动。
- mesh 模式 `PATCH /api/settings/site` 若带与当前不同的 `siteUrl` → `400 {error:'site_url_managed'}`；若带与当前不同的 `siteName` → `400 {error:'site_name_managed'}`（前端改走 hub rename）。
- hub `handleRename` 命中自身时同步本地 `site_settings.site_name`；节点收到 node.list 中自己的名字与本地不同时同步本地 `site_settings.site_name`（并广播 settings 更新）。首次加入 mesh 时若 hub 端节点名与 siteName 不同，以 hub 端为准。

### C2 允许域名访问（见任务 3.4，D 报告后定稿）
- `GET /api/local/status` 增加 `domainAccess: { allowed: boolean; viaDomain: boolean; hosts: string[] }`。
- `POST /api/local/domain-access { allowed: boolean }` → `{ ok: true }`，即时生效、无需重启。
- 关闭后：Host 命中「配置的公开域名集合」（hub publicUrl / baseUrl / siteUrl / tunnel hostname 的主机名，非 IP 字面量）的请求，除 mesh 服务路由（peer/uplink/hub 集群同步/forwarder 入站/healthz/ACME challenge）外，`/api/*` 返回 `403 {error:'domain_access_disabled'}`、SPA/静态返回 403 文本页、`/ws` 与 `/n/:id/ws` 拒绝升级（403）。IP 字面量、localhost、`.local` 不受影响。
- hub 端节点详情弹窗对远端节点读写走 `/n/<id>/api/local/status` 与 `/n/<id>/api/local/domain-access`（forwarder 透传）。

### C3 延迟
- ws-client：PING 带 nonce，PONG 按 nonce 匹配；同一时刻只允许一个在途探测；`performance.now()` 计时；`latencyMs` 改为最近 5 个有效样本的中位数（`latencyRawMs` 保留最新样本供 tooltip）。
- 网关：PONG 走保留控制通道（绕过终端输出的背压队列，直接 `ws.send`，仅当 socket 缓冲 < 阈值），并按 30s 聚合日志 `[ws-metrics] ping` 记录 `server_handle_ms`（收到到发出的服务端耗时）与 `event_loop_lag_ms`。

### C4 ACME DNS 提供商
- `tls_config` 新增 `acme_dns_provider text null`（`cloudflare` | `dnspod`）与 `acme_dns_secret_enc text null`（通用加密凭证 JSON）；旧 `acme_cf_token_enc` 迁移为 provider=cloudflare + secret。
- `PUT /api/tls` acme 分支：`challenge:'dns-01'` 时需 `dnsProvider` 与 `dnsCredentials`（cloudflare: `{ token }`；dnspod: `{ id, token }`，即 DNSPod 旧版 `login_token=ID,Token`，API `https://dnsapi.cn/Record.Create|Record.Remove`，`record_type=TXT`，`record_line=默认`）。响应 `acme.dns: { provider, hasCredentials }`（保留 `hasCloudflareToken` 兼容旧前端）。

## 任务与分工

| 编号 | 角色 | 内容 | 文件范围 |
|---|---|---|---|
| G1 | grok | C1 后端：settings 路由/site-settings 有效地址提供者、mesh 模式写保护、rename 自身投影、node.list 投影、assemble 接线；测试 | `apps/gateway/src/api/settings-routes.ts`、`apps/gateway/src/api/site-settings.ts`、`apps/gateway/src/db/site-settings.ts`、`apps/gateway/src/hub/hub-runtime.ts`（仅 handleRename）、`apps/gateway/src/mesh/mesh-runtime.ts`（仅 node.list 处理）、`packages/shared/src/contracts/site-settings.ts`、`packages/api-client/src/site.ts`、`packages/app/src/runtime/assemble.ts`（接线段） |
| G2 | grok | C4：DNS 提供商抽象（cloudflare/dnspod）、迁移、tls-service/acme-service/tls-routes、api-client tls-types；测试 | `packages/app/src/tls/*`、`packages/app/src/runtime/tls-routes.ts`、`apps/gateway/src/tls/*`、`apps/gateway/src/db/schema.ts`（tls_config 列）、`apps/gateway/drizzle/00xx_*.sql`、`packages/api-client/src/local/tls-types.ts` |
| G3 | grok | C2 后端：域名访问策略（存储、判定、拦截点、local 路由）；测试 | 待 D 报告定（预计 `packages/app/src/runtime/{local-routes,setup-service,assemble}.ts`、`apps/gateway/src/mesh/session-middleware.ts` 或新 `domain-access.ts`、`packages/api-client/src/local/*`） |
| G4 | grok | C3：ws-client 心跳修正 + 网关 PONG 保留通道 + ping 指标日志；测试 | `packages/ws-client/src/{heartbeat-controller,client,protocol-dispatcher,transport-types,shared-transport,websocket-transport}.ts`、`packages/stores/src/{tmux-state,tmux,tmux-event-router}.ts`（加 `wsLatencyRawMs`）、`apps/gateway/src/ws/index.ts`（handlePing）、`apps/gateway/src/ws/websocket-send-guard.ts`、`apps/gateway/src/ws/gateway-metrics-log.ts` |
| G5 | grok | 直连探测负向缓存与退避（待 F 报告） | `apps/gateway/src/mesh/*`（peer 拨号相关） |
| G6 | grok | WebRTC 熔断重做（待 G 报告） | `apps/gateway/src/mesh/rtc/*`、`packages/ws-client/src/direct/*`（视报告） |
| G7 | grok | KI-2 真 tmux run_command 集成测试（待 H 报告） | 新 `*.integration.test.ts` |
| O1 | opus | 设置-通用联动（只读有效地址、名称改走 hub rename、无改动不保存）；节点管理：hub pill 去「写入」、行按钮 升级/更多/移除、节点详情弹窗（名称 + 允许域名访问 + 只读信息；dirty 比较，仅提交有变化项） | `apps/fe/src/pages/settings/{general-settings-tab,use-site-settings-form,site-settings-form}.ts(x)`、`apps/fe/src/pages/settings/nodes/management/*`、locale `settings.general.*`、`nodes.hubs.*`、`nodes.management.*`、`nodes.actions.*` |
| O2 | opus | 应用级错误边界（路由 errorElement + 侧栏面板级边界 + 面板 lazy 重试）；接入设备-移动 tab 重排（地址选择 → 二维码 → 添加主屏 → 启动）；延迟徽标 tooltip | `apps/fe/src/main.tsx`、新 `apps/fe/src/components/app-error-boundary.tsx`、`apps/fe/src/components/side-panels/*`、`apps/fe/src/components/side-panels/connect-devices/*`、`apps/fe/src/components/page-layouts/components/sidebar-title.tsx`、locale `connectDevices.*`、新 `appError.*`、`nav.latency*` |
| O3 | opus | 本机盒子：地址两行化（本机地址 / 当前 Hub + 更换 Hub）、直连插件单状态 pill + 「启用」开关上移、底部「通用设置」行含允许域名访问开关（关闭前警告，viaDomain 时强警告）；HTTPS 区标题「HTTPS 设置」+ 状态三行化 + 文案统一 + DNS 提供商选择（cloudflare/dnspod） | `apps/fe/src/pages/settings/nodes/{local-machine-card,direct-section,nodes-tab}.tsx`、`apps/fe/src/pages/settings/nodes/https/*`、`apps/fe/src/pages/settings/nodes/*.test.tsx`、locale `nodes.machine.*`、`nodes.https.*` |
| O4 | opus | known-issues 前端：改密后账号安全面板无反馈（去 fixme）、KI-3 三组 e2e spec 修复（待 H 报告） | `apps/fe/src/components/side-panels/account-security-panel.tsx`、`apps/fe/tests/e2e/{mobile-settings,mobile-terminal-interactions,agent-session,mesh-passkey}.spec.ts` |
| 指挥官 | — | ja_JP 同步、`build:i18n`、分批 commit、codex sol 审查、临时实例实测、发版、hub B 运维切换（需用户提供 DNSPod 凭证并确认） | — |

## 追加任务要点（EX-F / EX-G / EX-H）

- **直连探测（G5）**：探测在 `PeerManager.dialWsSecure()` → `raceWsSecureEndpoints()`：每个 URL 一个任务、250ms 错开并行、3s open 超时 + 10s 握手超时；广播端只过滤 loopback/link-local/multicast，Docker 网桥 172.17.x、CGNAT 100.64/10、IPv6 ULA 全部被广播并被接收端按「私网」排前；`peer_cache` 无失败状态，只有整节点升级退避（10s→5min）。改法：内存负向缓存 `(nodeId,host,port)` 指数退避 1min→6h（仅传输类失败计入，协议/信任失败不缓存；成功/广播集合变化/本机网络变化清零）、LAN 候选总预算 4s、全局并发 4、广播端过滤容器网卡（docker*/veth*/br-*/lxdbr* 等）与 ULA/CGNAT（本机自身在 100.64/10 时保留）、`forceProbe`、退避日志。
- **WebRTC 熔断（G6）**：现熔断器只在 `dialDc()` catch 计数（8 次、6h），成功即清零、peer 元数据变化也清零；通道建立后的 `datachannel closed/error`、`liveness timeout`、missed pong 全部不计数，`dropPeer` 直接排升级重试（5/15/30/60/120s），所以「开了就死」的通道永远不触发熔断。改法：3 次连续失败触发，冷却 30s→30min 指数、level 跨过期保留，健康 ≥60s 才重置，所有失败类型按 attempt 计一次，冷却期不自动拨号仅到期一次探测，`forceProbe`；浏览器侧 `DirectCarrierController` 增加同策略熔断 + `retryDirect()`；熔断状态进 `PeerLinkDetail`/`MeshNode.dcBreaker`。UI 展示（节点徽标/诊断）留待后续小任务。
- **known-issues（O4/G7）**：改密无反馈真因是 `onDone()`→`reloadMode()` 同步 `setLoading(true)` 使 `AccountSecurityPanel` 只渲染 pending、整棵 `AccountSecurity` 卸载丢掉本地 feedback；修法把反馈状态提升到 loading 边界之上。KI-3：`settings-tab-devices`→`settings-tab-devicesAndFiles`；`editor-shortcut-*`→`terminal-shortcut-*` 且需要显式切编辑模式；agent-session:538 在等错误横幅前重新选中 Agent tab。KI-2：新 `apps/gateway/src/agent/tools/run-command.integration.test.ts` 用 `-L` 临时 socket 走真实 tmux control-mode → parser → PaneEmulator → run_command，断言长输出完整、退出码、vim 进入 TUI 被拒。

## hub B 运维方案（代码发版后执行，需用户确认）

1. B 升到新版本；HTTPS 设置：模式 Let's Encrypt，域名 `tmexhub-sh.jiefakj.com`，验证 DNS-01（DNSPod，ID+Token），监听 0.0.0.0:9443；签发成功后 `https://tmexhub-sh.jiefakj.com:9443` 可用。
2. 把 hub 公开地址改为 `https://tmexhub-sh.jiefakj.com:9443`（`TMEX_HUB_PUBLIC_URL`，重启），A 与各节点通过 hub 列表刷新到新地址；`TMEX_TRUST_PROXY` 关闭。
3. 面板侧仅拆该域名：删站点 `tmexhub-sh.jiefakj.com`（vhost、`well-known`、`proxy` 目录、cert 目录），续期 cron 是全局的，不动，该域名从其证书清单移除。
4. 通行密钥按 origin 注册，端口变化 = 新 origin；若已在旧地址注册过 passkey，需在新地址补注册（先从本机 localhost 登录添加）。

## 验收

- 各包 `bun test`/tsc 不低于基线（见 scratchpad `base-*.txt`）。
- 临时实例实测：设置-通用改名同步到节点管理；hub 模式访问 URL 只读；接入设备移动 tab 二维码；本机盒子两行地址与单 pill；HTTPS 设置文案；关闭域名访问后域名 403、IP 正常、mesh 路由正常。
- 发版 1.1.19 并 `tmex upgrade` 替换本机。
