# Round 32 计划（三）：非标端口（80/443 被封时架设中继 / Hub / 直连 HTTPS）

前置：读 `sub/EX4-nonstandard-ports.md`。结论：URL 规范化（`canonicalHubUrl` / `normalizeRelayUrl`）、uplink 签名（绑定 `URL.host` 含端口）、`r3.` join 串（内嵌完整 URL）、分享 / 站点地址、HTTPS 监听（默认 9443，`PUT /api/tls` 可改）、ACME dns-01 均已支持非默认端口；**不改任何令牌格式与规范化语义**。缺口只在人机层。

## 设计
### 共享
- `packages/shared/src/net/port-candidates.ts`（浏览器安全，经 `@tmex/shared/net` 导出）：
  - `SUGGESTED_HIGH_PORTS = [2053, 2083, 2087, 2096, 8443, 13443, 23443, 31443]`（前五个是 Cloudflare 代理接受的非 443 HTTPS 端口，后三个 IANA 未分配且避开各系统临时端口范围 32768+ / 49152+）。
  - `pickSuggestedPort(rng?)`、`pickSuggestedPortAvoiding(used)`。
  - `probeAddressPorts(hostOrUrl, { kind: 'relay' | 'hub', timeoutMs, fetchImpl, signal })`：显式端口 → 只确认不改；无端口 → 先探 443（约 800 ms 宽限），随后候选端口 150 ms 交错并发，443 迟到仍可胜出；relay 探 `GET /api/relay/health`（`ok === true`），hub 探 `GET /healthz`（`status === 'ok'`）；`redirect: 'error'`、每次 `AbortSignal.timeout`、败者中止。返回 `{ url, port, explicit, triedPorts } | null`。
### 后端（Bun 侧探测，浏览器不跨域）
- `POST /api/setup/precheck`（hub）：无端口时调用探测，`PrecheckResult` 增 `resolvedUrl: string | null`、`triedPorts: number[]`、`probed: boolean`。
- 新 `POST /api/mesh/relay/resolve { url }` → `{ url: string | null, port: number | null, explicit: boolean, triedPorts: number[] }`（node-session 鉴权）；前端在 `proof-material` 之前调用（proof 绑定 host，端口必须先定）。
- HTTPS 卡片：`GET /api/tls` 的 `https` 段在直连 HTTPS 生效且已知域名时给出 `publicUrl = https://<domain>[:port]`（非 443 带端口）。
- 修 bug：`fetchPinnedHubCa` 加超时；`tmex init` 的 hub 公网地址走同一校验（https / 回环）；`relay join` 死参数 `--url` 处理；端口映射保留端口补 TLS 监听端口（指挥官在 P3 之后处理）。
### CLI
- `tmex init`：在公网地址提问前增「公网 HTTPS 端口」选择（443 / 建议 NNNN / 自定义），建议值避开 gateway / peer / tls 端口，结果预填地址提示。
- `tmex relay enroll <url>` / `tmex hub join <url>` / 密码加入：无端口时探测候选并打印「已在 <port> 端口探测到中继，使用 <url>」；回环 / `--insecure-local` 跳过。
### 前端
- 「本机作为 Hub」「本机作为中继」表单：端口选择器（标准 443 / 建议 {{port}} / 自定义），只改写 URL 的端口部分。
- 「加入 Hub」「接入中继 / 追加中继 / 迁移」表单：地址失焦或提交前无端口 → 调探测；提示「已在 {{port}} 端口探测到 Hub / 中继，地址已更新。」、「正在探测常用端口…」、失败「443 及内置候选端口均无响应。请确认端口已放行，或直接填写带端口的地址。」
- 远程访问 → HTTPS 区显示对外地址（含端口）。
### 文档
- 新 `docs/deployment/2026090605-nonstandard-ports.md`：三种部署形态谁绑公网端口（反代 / tmex 自带 HTTPS + dns-01 / 纯 HTTP）、Cloudflare 橙云端口限制、内置候选端口、探测行为、防火墙提醒；`docs/relay/2026090304-relay-role.md`、onboarding 文档补一段。

## 分工
- N1（Opus）：shared `port-candidates.ts` + 测试；`setup-service.ts` precheck 扩展与 `setup-api` 类型；`mesh/relay-routes.ts` resolve 路由 + `packages/api-client/src/relay/tenant-api.ts` 客户端；`runtime/tls-routes.ts` publicUrl；CLI（`commands/relay.ts`、`commands/hub.ts`、`lib/relay-password-join.ts`、`commands/init.ts`、`lib/hub-client.ts` 超时）；文档。范围外：apps/fe、locale、portmap。
- N2（Opus）：四个 setup 表单 + 端口选择器组件 + 远程访问 HTTPS 地址显示 + i18n（`nodes.setup.*` / `remoteAccess.*` 子树）+ 单测。依赖 N1 的接口形状（上文已定）。

## 验收
- 中继起在 13443：网页与 CLI 输入 `https://host`（无端口）都能探到并接入；显式 `:13443` 直接用。
- Hub 同上；`tmex init --role hub,node` 交互能选建议端口。
- 既有 join 串 / 分享 / 站点 URL 行为不变；八包 tsc 0、门禁通过、单测不低于基线。
