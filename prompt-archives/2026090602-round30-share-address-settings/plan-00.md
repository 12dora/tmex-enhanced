# Round 30 计划（plan-00）

## 背景
本机（node，经中继 `tmexhub-sh.jiefakj.com` 接入 hub B，B 角色为 `relay,node`）同时拥有 Cloudflare Tunnel `tmex.konata.tv`。实测（只读 GET）`https://tmexhub-sh.jiefakj.com/n/<本机id>/api/auth/mode` 返回本机 nodeId，`/n/<id>/s/x` 返回 SPA：**`relay,node` 主机可作为本机入口**；纯 `relay` 主机不能（无 `/n/` 转发）。

探索报告见 `sub/EX1`–`EX6`。基线：四包 tsc 0 错；bun test fe 2598/0、shared 793/0、app 936/0，gateway 4774 pass/10 fail（不带 `TMEX_TMUX_SOCKET`；失败集中在 mesh phase-2 integration，环境性；带该变量时 57 fail，勿设）。

## 任务与设计

### T1 分享地址候选（后端）
1. `ShareOriginCandidate` 增 `accessUrl`（origin + 前缀）。
2. `share-origins.ts` 新增来源 `uplinkKind()`、`relays()`（`mesh_relays` 未 kicked，按 priority；attached 者优先）。`uplinkKind==='relay'` 时产出 kind=`relay`、prefix=`/n/<self>` 候选，但**仅当探测通过**。
3. 新增 `RelayEntryProbe`：GET `<relay>/n/<self>/api/auth/mode`，200 且 `nodeId===self` 视为可用；缓存 10 分钟，`listOrigins()`/启动时惰性触发；unknown/失败不产出。
4. 存储 `site_url` 与隧道地址相同（normalize 后）时不当作 `site`，改为 tunnel 候选。
5. custom 前缀继承放宽到任意匹配主机的 raw 候选（hub 或 relay）。
6. 测试与 `docs/share/2026090503-terminal-share.md` 修正。

### T2 站点访问 URL（后端 + 前端）
- 后端：`SiteSettingsLinkProvider` 拆出 `siteUrlManaged()` = `roles.hub || (roles.node && uplinkKind==='hub')`；relay 模式 `effectiveSiteUrl()` 返回 null（存储值生效、可编辑）。`/api/settings/site` 新增 `siteAccessOrigins`（= 分享候选，同源同序）。
- 前端 `SiteUrlField`：可编辑时显示「可用地址」列表（种类 · 主机，点选填入、复制）；托管（hub）时只读并列出其它可用地址；无候选提示。
- 分享对话框与分享设置候选项标签带种类前缀（「中继 · host」「隧道 · host」）。

### T3 分享设置一行布局 — 已完成（0eab323f）

### T4 AI 默认模型 — 进行中
`LlmModelSelect` 分组 Select；删 provider 同时清默认模型；不加 PATCH 交叉校验。

### T5 节点升级：下载缓存 + 应用内弹窗 — 待 EX5
### T6 通知触发多节点适配 — 待 EX6（先出结论再定是否改）

## 分工
Opus 子代理编码/探索；codex gpt-6-astra high 审查；指挥官分批 commit、实测、发版并替换本机。
