# T1 结果（Opus 子代理）：分享地址中继候选 + 站点 URL 托管语义

- 新增 `apps/gateway/src/share/relay-entry-probe.ts`：GET `<relay>/n/<self>/api/auth/mode`，200 且 nodeId 相符为 ok；ok 10 min / bad 2 min；单飞；启动 `primeShareRelayOrigins()` + `listOrigins` 惰性 ensure。
- `share-origins.ts`：sources 增 `siteUrlManaged/uplinkKind/relays/relayProbe`；relay uplink 且探测 ok 才产出 kind=relay、prefix=`/n/<self>`；site 被 hub 托管或等于隧道 origin 时不产出；custom 前缀继承匹配 hub 或 relay；`accessUrl` 在排序后计算。
- `effective-site-url.ts`：`siteUrlManaged = hub || (node && uplink!=='relay')`；relay 模式 `effectiveSiteUrl()` 返回 null（不碰 attachedHub）。`site-settings-link.ts` 增 `setSiteAccessOriginsProvider`；`settings-routes.ts` 按 siteUrlManaged/linked 分别门控。
- `assemble.ts` 接线（attached uplink 解析器、uplinkKind、启动 prime）。
- 测试：share-origins 14、relay-entry-probe 6、share-service/routes、effective-site-url、settings-site-link 增补；gateway 全量 4805/13（10 mesh phase-2 环境性 + 3 属 T5-BE 在途）；app 936/0。
- 文档：`docs/share/2026090503-terminal-share.md` 增「中继候选与入口探测」与已知限制 7。
