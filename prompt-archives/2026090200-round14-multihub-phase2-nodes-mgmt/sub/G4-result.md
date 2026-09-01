# G4 结果 — Standby 写入转发 + enrollment token best-effort 复制

## 做了什么

写者可达时，standby 不再对管理写入一律 409，而是转发到当前 writer；enrollment token 经新的 hub-only 控制帧 `hub.tokens` 复制到 ≥1.1.13 的已授权 hub。redeem 仍只在当前写者上执行。

### A. 写入转发（`apps/gateway/src/hub/writer-forward.ts`）

HTTP（standby 收到写请求时）：

- 覆盖：`POST /api/hub/enrollments`、`redeem`、`nodes/:id/rename`、`nodes/:id/revoke`、`POST /api/auth/keylog`（hub 为 standby 时）。
- HTTPS 打到 writer `publicUrl`，CA pin 与 peer poller / uplink 相同（`HubTrustStore` + `uplinkWebSocketTls`），超时 10 s。
- 透传调用方 cookie / content-type / `X-Tmex-Force-Keylog` 等，不另签发凭证。
- 响应原样回写者 status + body，并加 `X-Tmex-Forwarded-By: <standbyHubId>`。
- 已带该头的请求不转发（环路守卫）。
- writer 未知或 fetch 失败 / 超时 → 今日的 409 `HUB_NOT_WRITER`。

Uplink `key.log.append`（standby 收到 attached node 的追加）：

- 经 standby 自己的 writer uplink 复用 `UplinkKeyLogSync.appendAndAck`，ack/error 回传给源 node。
- 仅当 attached hub `mode=active` 时转发，避免挂到自己后循环。
- 无活的写者 uplink → 今日的 `HUB_NOT_WRITER` ack。

转发成功后立刻 `requestCatchUpNow()`，不等下一轮 `node.list`。

### B. Enrollment token 复制（`hub.tokens`）

- `UPLINK_CTL_TYPES` 末尾追加 `hub.tokens`。payload：token 全行 + `{ epoch, seq }` revision + `op: upsert|tombstone`；`legacy: true` 剥成 `{ t: 'hub.tokens' }`（旧 TYPE_SET 仍 unknown，所以必须版本门控）。
- 只发给 advertised version ≥ 1.1.13 的已授权 hub（复用 `normalizeReportedNodeVersion` / `_dev` 剥离）。
- 写者：已授权 hub 首次 `node.status` 后发快照；create / redeem 发增量。`POST /api/hub/enrollments` 增加 `replicatedTo: string[]`（2 s 内 ack 的 hub id）。
- Standby 按 `(id, revision)` 幂等 apply；`used_at` 从有不会改回 null。未授权节点发来的帧打日志并丢弃。
- revision 存在 sidecar 表 `enrollment_token_repl` / `_meta`（user-store 内 `CREATE TABLE IF NOT EXISTS`，未改 drizzle schema）。

## 文件

新建：

- `apps/gateway/src/hub/writer-forward.ts`、`writer-forward.test.ts`
- `apps/gateway/src/hub/hub-tokens.ts`、`hub-tokens.test.ts`

修改：

- `packages/shared/src/uplink/codec.ts`、`codec.test.ts`
- `apps/gateway/src/auth/user-store.ts`、`user-store.test.ts`
- `apps/gateway/src/hub/{hub-runtime,uplink-server,uplink-protocol,index}.ts`、`uplink-server.test.ts`
- `apps/gateway/src/mesh/{auth-routes,uplink-key-log-sync,uplink-client,mesh-runtime}.ts`、`uplink-key-log-sync.test.ts`
- `apps/gateway/src/mesh/integration/{multi-hub-harness,multi-hub.integration.test}.ts`
- `docs/hub/2026090104-multi-hub-standby.md`

`uplink-client.ts` 不在原始 scope 列表里，但 standby 作为 node 收 `hub.tokens` 以及立刻 catch-up 必须走这里；未改 `uplink-pool.ts`（用 `createClient` 注入 `onHubTokens`）。

## 测试 / tsc

| 包 | bun test | tsc `--noEmit` |
|---|---|---|
| `packages/shared` | **419 pass / 0 fail**（基线 416+） | **0** |
| `apps/gateway` | **3448 pass / 0 fail** | **0** |

Biome：已对变更源文件 `biome check --write`，随后 `biome check` 干净。

单元：HTTP 转发（各路由、cookie 透传、环路守卫、writer 未知、超时）、uplink append 转发 + ack、token codec 往返 + legacy 剥离、apply 幂等 / tombstone / 不 unset `used_at`、版本门控、`requestCatchUpNow`。

集成：经 B 创建 enrollment（A 为写者，带 `X-Tmex-Forwarded-By`）并可 redeem；A 上建 token → 复制到 B → takeDown A → role API promote B → 在 B 上 redeem 成功。

## 未做 / 注意

- 生产环境里 standby 与 writer 的 `tmex_s_self` 会话库不共享。转发会原样带 cookie；跨 origin 的浏览器会话不能直接在 writer 上验证。集成 harness 用 `HubRouter.cookies` 把打到 writer 的请求换成 writer 本机已登录的 cookie。真正的跨 hub session 共享不在本任务。
- `hub.tokens` 快照若超过 64 KiB ctl 上限会失败；当前按全量一帧发送，token 很多时需要以后分页。
- 未改 `apps/fe`、`uplink-pool.ts`、`mesh-routes.ts`、drizzle 正式迁移。
