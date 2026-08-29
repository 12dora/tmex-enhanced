# plan-00 执行结果（2026-08-29）

worktree `../tmex-enhanced-wt-merge`，分支 `chore/merge-hub-tabs`，base `e977e2d`。

| commit | 内容 |
|---|---|
| `3c77518` | 后端：向导 API、本机状态/直连 API、内置 HTTPS（自签 CA / ACME）、join 串 v2 CA pin |
| `8264c7c` | 前端：设置页「节点」标签、侧边栏节点图标、向导、HTTPS 区块、审查修复 |
| `5204627` | 后端审查修复：CA 响应单证书校验、hub URL 规范化、TLS 串行与 ACME 生命周期、直连原子替换、env 写锁 |
| `a5b8b16` | 运行时 nodeEnv 改用 `readNodeEnv()`（打包产物误判 development） |
| `0636c71` | `cli-auth` / `cert-authority` 显式引入 `reflect-metadata`（打包后 `enroll` 报 tsyringe 缺 polyfill） |
| `dc4c555` | dns-01 TXT 可见性优先 DNS-over-HTTPS、每次查询有界超时、关闭 acme-client 本地预校验（UDP 53 被拦时卡死） |

## 分工与产物

| 角色 | 模型 | 产物（`sub/`） |
|---|---|---|
| 探索 | codex gpt-5.6-luna xhigh ×2 | `explore-backend.md`、`explore-frontend.md` |
| 后端 | grok 4.6 high ×6 | `b1`、`b2`、`b2b`、`b3`、`b1-fix`、`b-fix-a`、`b-fix-b` 的 prompt/result |
| 前端 | Opus 5 ×4 | `f1`、`f2`、`f3`、`f-fix` |
| 审查 | codex gpt-5.6-sol high ×3 | `review-frontend.md`、`review-backend1.md`、`review-backend2.md` |
| 指挥官 | Claude | 契约（`api-contract-batch1/2.md`）、集成接线、i18n 合并、审查判定、临时实例实测、commit |

事实核验（Bun 1.3.14 实测）见 `plan-00.md`「背景」。

## 落地内容

### 入口
- 设置页 `nodes` 标签（`apps/fe/src/pages/settings/nodes/`）；mesh 下侧边栏齿轮旁 `Network` 图标跳 `/nodes`，四个动作按钮收进 `gap-0.5` 簇。
- `NodesPage` 抽出 `NodesManagement`（`apps/fe/src/pages/nodes/`），`/nodes` 与设置页共用。

### 向导（standalone）
- `POST /api/setup/precheck|hub|join`（`packages/app/src/runtime/setup-*.ts`，仅 standalone 注册）。做 hub：`bootstrapUserWithSelfAdmit` → 可选直连下载（60 s 可中止）→ 写 env → 300 ms 后自退出（退出码恒 0）；加入 hub：`performHubJoin`（CLI 与向导共用）。事务锁 `setup_in_progress` / `setup_committed`；join 的 env 先 staged 再原子提升。
- 前端 `HubSetupWizard`：预检、v1/v2 join 串校验、`/healthz.startedAt` 变化判定重启完成、硬跳 `/login`。

### 本机 API
- `GET /api/local/status`、`POST /api/local/direct`（standalone 开放、mesh 需 self 会话）；直连改动后需重启，卡片提供"立即重启"（复用 `POST /api/settings/restart` + 统一的 `waitForRestart`）。

### HTTPS
- `tls_config` 单行表（0021 + 0023 `acme_account_directory`）；`TlsService`：本地 CA（P-256、10 年、剩余 < 30 天轮换）+ 叶子（398 天、SAN 自动分类、`notBefore` 回拨 5 分钟）；独立 `HttpsListener`（换证书 `stop(true)` 后重建）；ACME（`acme-client@5`，http-01 内存应答 / Cloudflare dns-01 等 TXT 可见 + `finally` 清理），单飞 `runAcme`，1h→24h 退避，启动恢复 pending/error，监听绑定计入完成，staging/production 账号目录分离；`mode=external` 写 `TMEX_TRUST_PROXY` 并要求重启。
- 路由 `/api/tls*`（`ca.crt` 免鉴权）、`/.well-known/acme-challenge/*` 在 SPA 与 mesh 守卫之前。
- 前端 `HttpsSection`：四选一、状态/证书摘要、CA 下载与五平台安装指引、ACME 表单与 pending 轮询、互斥锁、停监听前确认。

### CA pin
- join 串 v2 = `<128 base64url>.<64 hex SPKI sha256>`；hub 在 enrollment-created 与 `/api/auth/mode` 暴露 `ca_fingerprint`；加入端单次 `rejectUnauthorized:false` 拉 `ca.crt`（≤ 64 KiB、严格单张 PEM、要求 CA 约束），指纹相符才落 `hub_trust`（0022，键为 `canonicalHubUrl`）；hub-client 与 uplink 以 `tls.ca` 信任；CLI `enroll` / `hub join` 同步。

## 审查判定

三轮 codex 审查共 6 + 9 + 15 条，全部判定成立并修复（含 1 个 blocker：CA 响应多张证书只校验第一张）。未采纳项：无。前端审查建议的 `SettingsPage` 切换标签测试因 `bun test` 无 DOM 改为静态断言。

## 验证

| 包 | pass / fail | tsc | 基线 |
|---|---|---|---|
| apps/gateway | 2453 / 0 | 21 | 2441 / 21 |
| packages/app | 381 / 0 | 1 | 254 / 1 |
| apps/fe（`bun test src/`） | 453 / 0 | 0 | 333 / 0 |
| packages/shared | 344 / 0 | 0 | 335 / 0 |
| packages/api-client | 128 / 0 | 5 | 96 / 5 |

`drizzle-kit check` 通过；`bun run build` + `npm pack` 成功（tarball 烟测：standalone 起服务、自签签发、`curl --cacert` 通过）。

### 临时实例实测（仓库内起 `packages/app/src/runtime/server.ts`，端口 211xx / 294xx，独立 scratch 目录，未触碰生产）

| 场景 | 结果 |
|---|---|
| standalone → `POST /api/setup/hub` → 自退出 → 守护拉起 | `app.env` 变 `hub,node`，`/api/auth/mode` 为 mesh，setup 路由 404，本机 API 未登录 401 |
| `PUT /api/tls` selfsigned → `ca.crt` 下载 → `curl --cacert` 访问 https（localhost / 127.0.0.1 SAN） | 通过；challenge 未知 token 404；renew 通过；`mode=none` 停监听 |
| 自签 hub（公网地址 `https://127.0.0.1:29443`）→ CLI `enroll` 出 v2 串 → 另一 standalone 实例向导 `POST /api/setup/join` | `hub_trust` 落库、uplink 经 TLS 在线、hub 侧自动 admit；审查修复后（URL 规范化、单证书校验）复测仍通过 |
| Playwright 截图设置页「节点」标签（standalone 与登录后的 mesh） | 无控制台错误；四个侧边栏图标一行容纳 |

实测中发现并修掉：mesh 下 `ca.crt` 走了鉴权导致 join `ca_unavailable`；precheck 不信任本机自签 CA；多实例默认 peer 端口 39001 冲突（测试配置问题）。

### 远程与公网实测（2026-08-29，远程测试机 `ai.jiefakj.com`，本机经 Surge 代理）

| 场景 | 结果 |
|---|---|
| 远程 `init --role standalone`（tarball，离线安装 bun 1.3.14）| 服务起来，`/api/local/status` nodeEnv=production |
| `PUT /api/tls` acme **http-01**（nginx 默认站点把 `/.well-known/acme-challenge/` 转发到 tmex 明文端口，ufw 放行 18443）| staging 约 25 s 签出；切 production 后 `issuer=Let's Encrypt YE1`，本机系统信任链直接 `curl` 通过；`acme_account_directory` 随目录切换 |
| 远程向导 `precheck`（自身 LE URL）→ `setup/hub`（含直连插件下载）→ 自退出重启 | `isSelf=true`；重启后 https 监听恢复、`[uplink] online`、`native/` 已装 |
| 远程 `upgrade --apply-current-package` 两次 | 证书与监听保留 |
| 远程 CLI `enroll` → **本机 NAT 后** standalone 实例向导 `setup/join`（v1 串，系统信任）| uplink 在线、hub 侧 `node admitted`，`nodes` 表出现 `konata-mac` |
| 本机实例 acme **dns-01**（Cloudflare，`tmex-test.konata.tv`，staging）| 首次因本机 UDP 53 被拦卡在 pending → 修复为 DoH 优先后约 50 s 签出，`_acme-challenge` TXT 事后为 0 条 |
| 本机做 hub 走 **cloudflared 快速隧道**（外部反代模式，`trustProxy=true`）| 经隧道 `/api/auth/mode` 为 mesh 且 `passkeyAvailable=true`；另一本机实例通过隧道 URL 向导 join，uplink 经 Cloudflare 边缘在线、admit 成功 |

实测中修掉：打包后 `enroll` 缺 `reflect-metadata`；dns-01 在无 UDP DNS 的网络下卡死。

## 未验证 / 遗留

- dns-01 只在 staging 验证（production 路径与 http-01 相同，仅目录不同）；`konata.tv` 命名隧道未做（需 cloudflared 登录授权，token 仅 DNS 权限），用 trycloudflare 快速隧道验证了同一条链路。
- `acme-client` 无 `AbortSignal`，模式切换/关停只能在回调与提交守卫处中止，进行中的 HTTP 往返不可取消。
- Linux 用户级 systemd 无法绑 80/443，UI 只提示端口映射（远程实测即靠 nginx 转发 challenge）。
- CA 轮换（10 年后）会使已加入 node 的 pin 失效，需重新 join（已写入运维文档）。
- 前端三处重启轮询已合并为 `restart/wait-for-restart.ts`；`setup-api.ts` 的 `readHealthStartedAt` 仍保留供测试。

## 第二、三轮（2026-08-29 下午，测试反馈）

| commit | 内容 |
|---|---|
| `98c2c1e` | 直连插件安装/删除按钮与启用开关分离（`TMEX_DIRECT_ENABLED`），二者联动 |
| `100ef05` | 三语文案重写（`sub/f6-result.md` 含词汇表：join 串→加入码、Hub 保留英文等） |
| `fa7f91e` | 登录流程重构、品牌统一组件、设备管理按节点分组、修复切换节点面板的 React #185 |

- 登录：只登本机并立即进入；密码错误显示"密码错误"；登录页仅保留用户名/密码/验证码/登录/通行密钥登录；通行密钥注册只在账号安全页。其他节点在进入 `/n/:id` 或点击侧边栏"登录该节点"时静默登录（`useNodeLoginGate`，单飞）；TOTP 账号的按需登录需回登录页输码（浏览器不持有 TOTP 密钥）。
- React #185 根因：`/` 与 `/n/:id` 复用同一棵树，切换节点时 react-query 观察者仍绑定旧 `QueryClient`，两个 DeviceProvider 互相 connect/disconnect；修复为 `RuntimeProvider` 按运行时实例 key 重挂子树（`packages/stores/src/react.tsx`，回归测试 `react.test.tsx`）。
- 品牌：`@tmex/shared` `PRODUCT_NAME` / `BRAND_LOGO_SRC` + `apps/fe/src/components/brand.tsx`；无侧边栏页面顶栏显示 logo 与名称；`PageWrapper` 抽为 `page-wrapper.tsx`。
- 设备管理：mesh 下按节点分组（离线只读清单 / 未登录提示 / 已登录挂 `NodeRuntimeScope` 面板），只有 self 面板响应全局"添加设备"。
- 实测（本机生产 9883 已升级）：登录 192 ms 进入；点"登录该节点"约 10 s 完成并展开；打开远程 pane 正常渲染 xterm，无错误。遗留：节点静默登录期间运行时已开始连接，`/api/mesh/connection`、`/api/rtc/authorize` 先返回一次 401 后才成功（无功能影响，可在登录完成后再建连接）。
- 用户测试环境：远程 hub `https://ai.jiefakj.com:18443`（admin）、本机 `konata-mac`、容器 `docker-node`，三者均已升级到本轮构建。
