# EX2 — 设置 → 通用 → 站点访问 URL 探索报告（Opus 子代理，要点）

- FE：`apps/fe/src/pages/settings/general-settings-tab.tsx:58-91` `SiteUrlField`，仅依据 `linkage.siteUrlEditable`（`site-settings-form.ts:70-97`）；无角色分支。`use-node-rename-channel.ts:49-80` 已持有 `relay.relayMode`。
- i18n：`settings.siteUrl`、`settings.general.urlManagedHint`（「由 Hub 公开地址决定，请在「多节点互联」中修改。」）位于 `locales/*.json:389-394`。
- 后端根因：`apps/gateway/src/mesh/effective-site-url.ts:63` `linked = roles.hub || roles.node`，一个布尔同时决定「站点名=节点名」与「URL 由 hub 决定」；relay 模式下 `attachedHub()` 返回中继 URL（`uplink-pool.ts:898-904`），`effectiveSiteUrl()` 合成 `<relay>/n/<id>`，`projectSiteSettings`（`api/site-settings-link.ts:29-46`）置 `siteUrlEditable:false`。
- 覆盖面：`getSiteSettings()` overlay 全局生效，影响通知深链、`listDomainAccessHosts()`（`api/domain-access-routes.ts:84-108`）。
- 地址来源：中继 `mesh_relays.url`；hub `mesh_hubs.public_url`；隧道 `TunnelConfigStore` + `tunnelManager.status()`（已在 `share-origins.ts:71-95` 合并）；LAN `/api/system/addresses`；uplink 模式 `GET /api/mesh/relay/status`。
- 四处各自为政的「可达地址」：effective-site-url / share-origins / connect-devices access-addresses（FE）/ domain-access hosts。
- 测试：`effective-site-url.test.ts` 无 relay 用例；`settings-site-link.test.ts:32-131`；`site-settings-form.test.ts:121-203`。
- 建议：拆分 `linked()` 与 `siteUrlManaged()`（= hub 角色或 node+hub uplink）；`/api/settings/site` 附带候选地址列表；UI 按模式展示；新增文案 `settings.general.url*`。
- **指挥官修正**：EX2 断言「中继只转发加密流量不能作访问地址」对纯 relay 成立，但实测 B 为 `relay,node`，`<relay>/n/<self>` 可用（见 plan-00）。
