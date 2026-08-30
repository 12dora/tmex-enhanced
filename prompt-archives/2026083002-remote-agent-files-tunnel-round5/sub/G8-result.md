# G8 result — Cloudflare Access + JWT 强制校验 + 外部隧道探测（backend）

## 做了什么

Access 成为可选保护层；G6 的 `auth_required` 硬拒绝已去掉（契约码仍保留，网关不再发出）。未保护实例（`exposureProtected === false`）暴露动作必须 `acknowledgeExposure: true`，否则 409 `exposure_ack_required`。

`exposureProtected = loginEnforced || (access.configured && access.enforceJwt && access.hostname && access.hostname === config.hostname)`。

### Access 管理
- `set_access_credentials`：立即 `GET /accounts/{id}/access/organizations` 取 `auth_domain`（teamDomain）；API token 用与 TLS 相同的 `encrypt` / `decryptWithContext` 落库。失败 → `access_api_failed`（脱敏）。
- `configure_access`：异步 job `access`，步骤 `create_app` → `policy` → `verify`；默认 `enforceJwt=true`。至少一条合法 email / email_domain 规则。
- `remove_access`：best-effort 删 CF 应用，清本地 app 状态，保留凭证。
- `sync_access`：分页列出 Access 应用，按 `domain` 匹配 `config.hostname`（未 adopt 时用 `external.hostnames[0]`），读 allow 策略 include → `rules`。
- `set_access_enforce`：仅已配置时可切换。

### JWT 强制校验
当 `enforceJwt && configured` 且请求带 `cf-connecting-ip`（经 cloudflared）时，校验 `Cf-Access-Jwt-Assertion` 或 cookie `CF_Authorization`：RS256 + JWKS（未知 kid 刷新，TTL ≤ 10 min，fetch 可注入）、`iss`、`aud` 含存储 AUD、`exp`/`nbf`。失败 403 `{ error: { code: 'access_denied' } }`。无该头的 LAN/loopback 不碰。永不 log token。

Hook：`mesh-http.ts` `handleRequest` 开头一处；`packages/app/src/runtime/assemble.ts` 的 `meshHttp` 同样一处（WS upgrade 发生在 fetch 内、早于 mesh handleRequest）。

### 暴露门控
替换 G6 `auth_required`。`quick_start` / `create` / `start` / `set_auto_start(true)` 在未保护时要求 ack，并写入 `exposure_acknowledged_at`。boot auto-start：未保护且未 ack 则 skip + warn；`externallyManaged` 不拉起子进程。

### 外部隧道
探测（缓存 ~30s，依赖可注入）：进程 / launchd plist / systemd / `~/.cloudflared/config.yml` + `cert.pem` / token 旁 `hostname` / CF API ingress+name / logfile `"ingress":[...]`。只接受 origin 端口匹配的 hostname。launchd argv 按数组解析（路径可含空格，如 `Application Support`）。token 只解析 `{a,t}`，永不暴露 `s`。

`adopt_external { hostname }`：hostname 必须在 `external.hostnames`；`mode=named`、`externallyManaged=true`、`autoStart=false`。期间 `start`/`stop`/`remove` → 409 `invalid_request`（"managed by the system service"）。`process.state` 镜像 `external.running`，`publicUrl = https://<hostname>`，`check` 可用。

## Cloudflare API 依据

基址 `https://api.cloudflare.com/client/v4`，`Authorization: Bearer <token>`。

| 用途 | Method / path | 字段 |
|---|---|---|
| 校验凭证 / team 域 | `GET /accounts/{account_id}/access/organizations` | `result.auth_domain`（如 `team.cloudflareaccess.com`） |
| 创建/改/读/删应用 | `POST/PUT/GET/DELETE /accounts/{account_id}/access/apps[/{app_id}]` | body：`type: self_hosted`、`name`、`domain`、`session_duration: 24h`；响应 `id`、`aud` |
| 列出应用（分页） | `GET /accounts/{account_id}/access/apps?page=&per_page=100` | `result_info.total_pages` / `total_count`；匹配 `domain` |
| 策略 | `GET/POST /accounts/{id}/access/apps/{app_id}/policies`；`PUT/DELETE .../policies/{policy_id}` | `decision: allow`，`include: [{email:{email}} \| {email_domain:{domain}}]` |
| 远程隧道 ingress | `GET /accounts/{a}/cfd_tunnel/{t}/configurations` | `result.config.ingress[].hostname/service` |
| 隧道名 | `GET /accounts/{a}/cfd_tunnel/{t}` | `result.name` |
| JWKS | `GET https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` | `keys[]` kid/n/e |
| JWT | 头 `Cf-Access-Jwt-Assertion` 或 cookie `CF_Authorization` | alg RS256；`aud` 数组含 app AUD；`iss = https://<team>.cloudflareaccess.com`；`exp`/`nbf` |

文档：
- Apps create：https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/
- JWT：https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- Tunnel config：https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/configurations/

仍发 legacy `domain`（文档仍接受；`destinations` 为较新替代，未改契约）。

## 本机只读探测（sanitized `external`）

originPort=9883。未读 token 明文、未写任何文件、未碰 `~/Library/Application Support/tmex`。

```json
{
  "detected": true,
  "source": "launchd",
  "configPath": null,
  "tunnelId": "96715b69-21be-4d03-9600-7f15ed6f910c",
  "tunnelName": null,
  "hostnames": ["tmex.konata.tv"],
  "hasOriginCert": false,
  "running": true
}
```

来源：`~/Library/LaunchAgents/com.tmex.cloudflared.plist` + token 旁 `hostname` / `tunnel-id`。远程托管（无本地 config.yml / origin cert）。

## 文件

- `apps/gateway/src/db/schema.ts`（`tunnel_config.externally_managed` / `exposure_acknowledged_at`；表 `tunnel_access`）
- `apps/gateway/drizzle/0029_tunnel_access.sql` + `drizzle/meta/0029_snapshot.json` + journal idx 29
- `apps/gateway/src/tunnel/access-client.ts` + test
- `apps/gateway/src/tunnel/access-jwt.ts` + test
- `apps/gateway/src/tunnel/access-guard.ts` + test
- `apps/gateway/src/tunnel/access-store.ts`
- `apps/gateway/src/tunnel/access-rules.ts` + test
- `apps/gateway/src/tunnel/access-sanitize.ts`
- `apps/gateway/src/tunnel/external-detect.ts` + test
- `apps/gateway/src/tunnel/config-store.ts` + test
- `apps/gateway/src/tunnel/manager.ts` + test
- `apps/gateway/src/tunnel/errors.ts`
- `apps/gateway/src/tunnel/index.ts`
- `apps/gateway/src/api/tunnel-routes.ts` + test
- `apps/gateway/src/mesh/mesh-http.ts`（一处 hook）
- `packages/app/src/runtime/assemble.ts`（WS 路径 hook）

未改 shared 契约形状。

## 验证

| 项 | 结果 |
|---|---|
| `cd apps/gateway && bun test src/tunnel src/api/tunnel-routes.test.ts` | **69 pass / 0 fail** |
| `cd apps/gateway && bun test` | **2646 pass / 0 fail** |
| `bunx tsc --noEmit -p .`（apps/gateway） | **21 errors**（= 基线；G8 文件 0 条） |
| `packages/app` tsc | 预存 `Cannot find type definition file for 'node'` |
| `bunx biome check`（上表 TS 文件） | **clean** |
| 0029 迁移 round-trip | `config-store.test.ts` 含 `tunnel_access` 表与加密 token |

## 风险 / 未做

- 契约无 un-adopt：`externallyManaged` 时 `remove` 被拦，无法从 UI 清掉接管状态（只能改库）。
- `set_access_enforce` 在未配置时 400 `not_configured`。
- `process.pid` 在 externallyManaged 时为 `null`（系统服务 pid 不写入 status）。
- Access 创建仍用 `domain` 而非新 `destinations`；与当前 CF 文档兼容，但长期可能需迁移。
- 无反向动作把 Access `enforceJwt` 与 dashboard 策略保持双向同步（仅 `sync_access` 拉取）。
