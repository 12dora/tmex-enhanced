# G9 result — Fix review findings: Cloudflare Access / tunnel discovery (backend)

## 做了什么

按 `review-be-3-report.md` 全部 10 项 + `review-fe-3-report.md` 第 1、3 项的后端半边修完。契约形状未改（仅补充 `set_access_credentials` 注释）。

### 1. 守卫放到每个 Bun `fetch` 最外层

`guardEntryAccess` / `guardedGatewayFetch`：无 `cf-connecting-ip` 跳过；peer inbound（`isPeerInboundRequest`）跳过；机器路径豁免；否则校验 JWT。

入口：
- `apps/gateway/src/index.ts` — `guardedGatewayFetch` 包住 `handleRequest`（含 `/ws` upgrade）
- `apps/gateway/src/managed-entry.ts` — 同上（runtime 为空仍先 503）
- `packages/app/src/runtime/assemble.ts` — `createHttpDispatch` 在 TLS/local/setup/hub 之前调用 `guardEntryAccess`；已从 `meshHttp` 去掉内层守卫
- `mesh-http.ts` 去掉 hook，避免远端再验入口 JWT

### 机器路径枚举（origin 守卫豁免 + CF bypass）

读自 `hub-runtime.handleRequest`、`HUB_UPLINK_PATH`、`mesh-http` / gateway `/healthz`：

| 路径 | 调用方 | origin JWT | CF bypass app |
|---|---|---|---|
| `/hub/uplink` | 节点常驻 WS | 豁免 | `<host>/hub/` |
| `/api/hub/enrollments/redeem` | CLI redeem（无 withAuth） | 豁免 | `<host>/api/hub/` |
| `/api/hub/enrollments` POST、GET `:id` | withAuth | 豁免（同前缀） | 同上 |
| `/api/hub/nodes`、rename、revoke | withAuth | 豁免（同前缀） | 同上 |
| `/healthz` | jobCheck / 匿名健康 | 豁免 | 否（check 把 Access 拦截记为 `access_protected`） |

前缀不共享，因此 **两个** bypass 应用。`bypass_app_id` 列存 JSON 数组；契约 `bypassAppId` 为第一项（`/hub/` 的 `tmex-bypass-hub`）。

### 2–11 摘要

- **2** `forwarder.ts` 转发前丢掉 `cf-connecting-ip`、`cf-access-jwt-assertion`、`cf-access-authenticated-user-email`、`cf-ray`（cookie 本就整段丢弃，含 `CF_Authorization`）。远端不再跑守卫。
- **3** hub 或 node 角色下 `configure_access` 另建 bypass 应用（`decision: bypass` + `everyone`）；`remove_access` 删除；`sync_access` 按 path domain 识别。
- **4** 只管理名为 `tmex-allow` 的策略；其它 allow/bypass/service-auth 不删，job 以 `access_api_failed` 列出名字失败；写回前重读校验。
- **5** header/payload 须为普通对象；`alg === 'RS256'`；`exp` 有限且未过期；`nbf` 若出现须有限；一切异常 → `false`。
- **6** `effective = configured && enforceJwt && mode==='named' && access.hostname === config.hostname`；quick/off 不生效。守卫看 `effective`。
- **7** 按进程 / launchd / systemd / config 独立候选，以 tunnel id / token file / config path 合并；读候选自己的 `--config`；`running` 仅当该候选进程活着；hostname 只接受 origin 端口 ingress（yml / API / 日志 JSON）；单独 `hostname` 文件不够。优先 running 且有 origin 证据的候选。
- **8** `check`：`redirect: 'manual'`；302/303 到 `*.cloudflareaccess.com` 或 403 带 `cf-access-*` → job `done` / `step: 'access_protected'`；origin `/healthz` 200 + startedAt → `ok`。
- **9** DELETE 仅确认 404 视为已删；其它错误失败并保留本地。`remove_access` 与 `set_access_enforce(false)` 在隧道运行且 `!loginEnforced` 时要 `acknowledgeExposure`，否则 409 `exposure_ack_required`。
- **10** 凭证错误信息与契约注释同时写明 `Access: Apps and Policies — Edit` **和** `Access: Organizations, Identity Providers, and Groups — Read`；仍调用 organizations。
- **11** `configure_access` / `sync_access` 接受 RFC 1123 `hostname`；默认 `config.hostname`；`mode==='off'` 时 configure 必须显式 hostname 并写入 access 记录，之后同名 `create` 为 `exposureProtected`。`sync_access` 默认 `config.hostname ?? external.hostnames[0]`。

## 文件

- `apps/gateway/src/tunnel/access-paths.ts`（新）
- `apps/gateway/src/tunnel/access-guard.ts`、`access-jwt.ts`、`access-client.ts`、`access-store.ts`、`manager.ts`、`external-detect.ts`、`index.ts`
- 对应 `*.test.ts` + `access-entry.test.ts`（新）
- `apps/gateway/src/api/tunnel-routes.ts` + test
- `apps/gateway/src/index.ts`、`managed-entry.ts`
- `apps/gateway/src/mesh/mesh-http.ts`、`forwarder.ts` + test
- `apps/gateway/src/db/schema.ts`、`drizzle/0030_tunnel_access_bypass.sql`、`drizzle/meta/0030_snapshot.json`、journal idx 30
- `packages/app/src/runtime/assemble.ts` + test
- `packages/shared/src/contracts/tunnel.ts`（仅 `set_access_credentials` 注释）

未改 i18n JSON（UI 文案归 O13）。

## 验证

| 项 | 结果 |
|---|---|
| `cd apps/gateway && bun test src/tunnel src/api/tunnel-routes.test.ts` | **94 pass / 0 fail** |
| `cd apps/gateway && bun test` | **2671 pass / 0 fail** |
| `packages/app` `bun test src/runtime/assemble.test.ts` | **30 pass / 0 fail** |
| `bunx tsc --noEmit -p .`（apps/gateway） | **21 errors**（= 基线；本轮文件无新增） |
| `packages/app` tsc | 预存 `Cannot find type definition file for 'node'` |
| `bunx biome check`（上表 TS 文件） | **clean** |

## 风险 / 未做

- Access 应用仍发 legacy `domain`（含 path：`hostname/hub/`），未改 `destinations`。
- `bypassAppId` 只暴露数组第一项；两个 id 都在 `bypass_app_id` JSON 里。
- i18n `apiTokenHint` 未改（不在 G9 文件范围；O13 前端）。
- 无 un-adopt 契约，与 G8 相同。
