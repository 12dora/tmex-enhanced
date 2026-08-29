# plan-00：hub/node 图形化入口 + 内置 HTTPS（自签 / Let's Encrypt）

## 背景

`chore/merge-hub-tabs`（`../tmex-enhanced-wt-merge`）已合并 hub/node mesh 与 3-tab 侧边栏并上线本机。但 hub 功能在 UI 里没有入口：

- `/nodes`、`/account/security` 只能手敲 URL，且 standalone 整页不渲染；
- 从 standalone 变 hub / 加入 hub / 直连插件全部只能走 CLI（`init --role`、`hub user add`、`hub join`、`direct enable`），要改 `app.env` 并重启；
- tmex 不终止 TLS，`hub join` 只认系统信任链，https 完全依赖外部反代 / tunnel。

设计文档：`docs/hub/2026082700-hub-node-architecture.md`（v3.2）、运维 `docs/hub/2026082800-hub-node-operations.md`。决策记录见同目录 `plan-prompt.md`。

已核实的技术事实（Bun 1.3.14 实测）：`Bun.serve` 的 `tls` 不能 `reload` 热换，需停掉重建该监听；一个 `Bun.serve` 只能 http 或 https，需要两个实例；Bun `fetch` / 原生 `WebSocket` 支持 `tls.ca`；`acme-client@5` 在 Bun 下 http-01 / dns-01 可用（无内置 DNS provider）；`@peculiar/x509` 已在 lock 中可生成证书；Linux 用户级 systemd 无法绑 80/443（只提示）；密钥加密复用 `apps/gateway/src/crypto/index.ts` 的 `encrypt/decrypt`（`TMEX_MASTER_KEY`）。

## 目标

1. 设置页新增"节点"标签；mesh 下侧边栏齿轮旁加节点图标并收紧顶部按钮间距。
2. standalone 图形化"开启 hub"向导（做 hub / 加入 hub），后端同进程完成用户/证书/join，写 `app.env` 后自退出由守护拉起，前端轮询 `/healthz` 后跳登录。不加额外门槛。
3. 直连插件：向导默认勾选下载；节点页可启用/停用。
4. mesh 下"节点"标签嵌入完整节点管理（`NodesPage` 抽共享组件）+ 本机区块 + 账号安全入口。
5. HTTPS 区块（所有角色）：外部反代 / 自签（本地私有 CA）/ Let's Encrypt（HTTP-01、DNS-01 Cloudflare，自动续期）。独立 https 监听 `TMEX_TLS_PORT`（默认 9443）/ `TMEX_TLS_BIND_HOST`，明文保留。
6. join 串可选携带 CA 指纹；node 侧 hub-client / uplink 以 `tls.ca` 信任该 CA（仅 hub 地址）；CLI `hub join` 同步。

不做：`hub leave` / `mesh reset-root` UI、TLS-ALPN-01、Cloudflare 以外 DNS 服务商、端口自动检测。

## 设计要点

### 后端

- **配置写入**：新增 `app.env` 读写 helper（保留其它键与注释），gateway 进程通过安装布局 env（探索报告确认变量名）定位；dev 环境写仓库根 `development.env.local`。
- **自退出**：响应后 `setTimeout(() => process.exit(0), 200)`；`apps/gateway/src/index.ts` 已有 `onRestartRequested` 循环——纯角色变更走 exit（角色装配在 `packages/app/src/runtime/server.ts`）。
- **向导 API**（standalone 才注册，mesh 下 404）：
  - `POST /api/setup/hub` `{ hubPublicUrl, username, password, directEnable }` → 复用 `bootstrapUserWithSelfAdmit` → 可选 direct enable（30 s 超时）→ 写 env（`TMEX_ROLES=hub,node`、`TMEX_HUB_PUBLIC_URL`）→ `{ ok, fingerprint, direct: 'enabled'|'failed'|'skipped', restarting: true }`。
  - `POST /api/setup/join` `{ hubUrl, token, name, directEnable, insecureLocal? }` → 复用 join 提交逻辑（含 CA pin）→ 写 env → 同上。
  - `POST /api/setup/precheck` `{ url }` → 服务端 `GET <url>/healthz`（系统信任链 + 已配置 CA）返回可达性与是否本机。
- **本机 API**（mesh 需登录；standalone 开放）：`GET /api/local/status`（角色、hub url、直连状态、TLS 状态）、`POST /api/local/direct { enable: boolean }`。
- **TLS**：
  - 表 `tls_config`（单行）：`mode` none|external|selfsigned|acme、`trustProxy`、`tlsPort`、`bindHost`、`sans`、`caCertPem`、`caKeyEnc`、`certPem`、`keyEnc`、`acme{email,domain,challenge,cfTokenEnc,staging,accountKeyEnc,accountUrl}`、`expiresAt`、`lastError`。迁移 `0020_tls_config`。
  - `TlsService`：`ensureCa()`、`issueSelfSigned(sans)`、`acmeIssue()`（acme-client；http-01 由明文监听在 `/.well-known/acme-challenge/*` 应答，dns-01 调 Cloudflare API 增删 TXT）、`renewLoop`（每 12 h 检查，剩 < 30 d 续）、`caFingerprint()`（SPKI sha256）。
  - `HttpsListener`：读 `tls_config` 起第二个 `Bun.serve`（复用同一 `fetch`/`websocket` handler）；证书变更 `stop()` 后重建。
  - API：`GET /api/tls`、`PUT /api/tls`（mode + 参数；自签立即签发；acme 触发签发并返回任务状态）、`POST /api/tls/renew`、`GET /api/tls/ca.crt`（`application/x-x509-ca-cert`，standalone 与已登录 mesh 均可下载）。
- **CA pin**：join 串 v2 = `"2." + base64url(enroll_sk ‖ root_pk ‖ head_hash ‖ ca_spki_sha256)`；无前缀 128 字符视为 v1。hub 生成 enrollment 时若 `tls_config.mode=selfsigned` 附指纹。node 侧存 `peer_cache`/新列 `hub_ca_pem`（join 时用指纹从 hub `GET /api/tls/ca.crt` 取 PEM 并校验指纹后落库）；hub-client `fetcher` 与 uplink `wsFactory` 注入 `tls.ca`。

### 前端

- `SettingsPage` 新增 `nodes` 标签（独立于站点设置 form）。
- `sidebar-title.tsx`：mesh 时渲染节点图标 Link `/nodes`；按钮 gap 收紧。
- 新组件（`apps/fe/src/pages/settings/nodes/`）：`NodesTab`（按 mode 分派）、`HubSetupWizard`（HTTPS 步骤 → 角色步骤 → 提交/等待重启）、`HttpsSection`（三选一表单 + 状态 + 续签 + CA 下载 + 平台说明）、`LocalMachineCard`（角色/hub 地址/直连开关）、`RestartWaiter`（轮询 `/healthz`，恢复后跳 `/login`）。
- `NodesPage` 抽 `NodesManagement`，页面与标签共用。
- api-client 新增 setup / local / tls 端点；i18n 三语补 key 后 `bun run build:i18n`。

## 任务清单（三批）

### 批次 1：入口 + 向导 + 直连

| id | 角色 | 范围 |
|---|---|---|
| B1 | grok | env 写 helper、setup API（hub/join/precheck）、local status/direct API、自退出；测试 |
| F1 | opus | SettingsPage 标签、sidebar 图标与间距、`NodesManagement` 抽取、`NodesTab`/`LocalMachineCard`/`RestartWaiter`、api-client、i18n；测试 |
| F2 | opus | `HubSetupWizard`（步骤 2 角色表单 + 提交 + 等待重启；HTTPS 步骤留插槽） |
| R1 | codex-sol ×2 | backend / frontend review |

### 批次 2：自签 + https 监听 + CA pin

| id | 角色 | 范围 |
|---|---|---|
| B2 | grok | `tls_config` 迁移、`TlsService`（CA/自签）、`HttpsListener`、`/api/tls*`、CA 下载 |
| B3 | grok | join 串 v2、hub 侧 enrollment 附指纹、node 侧取 CA 与落库、hub-client / uplink `tls.ca`、CLI `hub join` |
| F3 | opus | `HttpsSection`（external / selfsigned 部分）接入向导与标签 |
| R2 | codex-sol ×2 | review |

### 批次 3：Let's Encrypt

| id | 角色 | 范围 |
|---|---|---|
| B4 | grok | acme-client 集成、http-01 应答路由、Cloudflare dns-01、续期循环、错误状态 |
| F4 | opus | `HttpsSection` 的 acme 表单与状态（签发进度、错误、续期按钮） |
| R3 | codex-sol ×2 | review |

每批：指挥官跑包内 `bun test` + tsc（不高于基线）+ biome → commit。批次 1 后临时实例实测向导（仓库内起实例，显式覆盖端口/DIST），批次 2/3 用临时实例 + 自签实测 `hub join` CA pin、LE 用 staging。

## 验收标准

- standalone 打开设置页 → 节点标签 → 向导完成"做 hub"后自动回到登录页可登录；节点页可生成 join 命令。
- 另一台/另一实例通过向导"加入 hub"成功出现在节点列表。
- 直连开关可下载/删除插件并反映 `direct_capable`。
- 自签：https 监听可用，CA 可下载，join 串 v2 被 CLI 与 UI 双方接受，node 经自签 hub uplink 在线。
- LE staging：http-01 与 dns-01（Cloudflare）各签发成功；续期逻辑单测覆盖。
- 全包测试通过数不低于基线，tsc 错误不高于基线，e2e 基线不回退。

## 风险

- 自退出在裸 `bun run start` 下不会回来：前端提示"若 30 s 未恢复请手动启动"。
- LE 生产环境限频：UI 默认 staging 关，但失败重试指数退避；文档提醒。
- Linux 低端口：只提示映射方案。
- join 串格式变更：v1 保持兼容，旧 CLI 遇到 v2 前缀报明确错误。

## 注意事项

- 严禁触碰本机生产 tmex 与名为 `tmex` 的 tmux session；测试实例显式覆盖 `GATEWAY_PORT`、`TMEX_FE_DIST_DIR`、`TMEX_BIND_HOST`、`DATABASE_URL`。
- 生成文件（i18n `resources.ts`/`types.ts`）不 lint，只由脚本重建。
- agent 不做 git 操作；同一 worktree 并行，文件范围互斥。
