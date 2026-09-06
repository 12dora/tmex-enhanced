# EX1 — 分享地址候选探索报告（Opus 子代理，要点）

## 结论
1. `apps/gateway/src/share/share-origins.ts:117-141` `collectRaw()` 只产出 site/hub/tunnel/ip，**没有 relay 分支**（测试 `share-origins.test.ts:48-51` 甚至断言不产生）。
2. relay uplink 模式下 `mesh_hubs` 被清空（`mesh/relay-wiring.ts:64`、`relay-node-list.ts:105`），hub 分支也为空。
3. 本机 `site_settings.site_url = https://tmex.konata.tv`（隧道域名），以 `site`（优先级 1）进入候选，真正的 tunnel 候选被去重；因此即便加上 relay 也会被 site 压住。
4. 本机数据：`node_identity.uplink_kind=relay`，`mesh_relays.url=https://tmexhub-sh.jiefakj.com`，`share_settings` 无行（auto）。

## 节点已知的中继地址
- `mesh_relays.url`（`auth/mesh-relay-store.ts:36-51 listRelayRows`）；`UplinkPool.attachedHub()`（`mesh/uplink-pool.ts:513-515`）relay 模式返回 `{hubNodeId:null, publicUrl:<relay>}`。
- 已有正确拼接：`mesh/effective-site-url.ts:62-84` `effectiveSiteUrl()` → `<relay>/n/<localNodeId>`；share-origins 刻意读 `getStoredSiteSettings()`（原始值）而非 effective。

## 中继链路是否可用
- 纯 relay 角色主机：HTTP 面只有 `/relay/uplink` 与 `/api/relay/*`，**不能**转发 `/n/<id>`。
- `relay,node` 主机（hub B 即此）：node 角色的 `MeshHttpRuntime` 总是构造 Forwarder（`mesh/mesh-http.ts:156`），`/n/<id>/s/<share>` → SPA、`/n/<id>/api/share-access/*` 与 `/n/<id>/ws?share=` 均可转发，cookie 翻译 `forwarder-auth-policy.ts:31-44` 与入口无关。受 B 自身「域名访问」开关门控。
- 节点无法可靠探知对端是否有 node 角色（`/healthz` 只回 ok；relay health 无角色/URL）。
- 现有手工绕过（自定义填中继域名）也坏：前缀只在匹配 **hub** raw 候选时继承（`share-origins.ts:150-158`），得到 `<relay>/s/<id>` → SHARE_NOT_FOUND。

## 建议
A. `ShareOriginSources` 增 relays()（`mesh_relays` 未 kicked 按 priority + attachedHub 标记），`uplinkKind==='relay'` 时产出 kind=relay、prefix=`/n/<self>` 的候选。
B. 存储 site_url 等于隧道域名时不当作 site（或仅 standalone 可编辑时才算 site）。
C. custom 前缀继承放宽到任意匹配主机的 raw 候选。
D. 可选：探测 `<relay>/n/<self>/api/auth/mode` 缓存数分钟，纯中继主机不推荐。
E. FE 标签带 kind：「中继 · host」「隧道 · host」（i18n `share.origin.kind.*`）。
F. 测试与文档 `docs/share/2026090503-terminal-share.md` 修正。
