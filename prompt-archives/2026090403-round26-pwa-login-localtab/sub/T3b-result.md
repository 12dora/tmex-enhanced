# T3b 执行结果 — 过期 stale per-node cookie / NODE_UNREACHABLE reason / 过滤未准入成员 / 显式 relay dial

## 1. Forwarder：401 `NODE_LOGIN_REQUIRED` 时过期 `tmex_s_<target>`

`applyAuthPolicy` 把目标 401 改写成 `NODE_LOGIN_REQUIRED`（`via_mismatch` 与 missing/expired auth 都走这条）时，在入口响应上追加 `Set-Cookie`：`tmex_s_<targetNodeId>=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`，HTTPS 再加 `Secure`（与 login 设 cookie 的 `buildSetCookie` 属性对齐）。`buildClearCookie` 增加可选 `{ secure }`。

登录公开路径（`AUTH_SKIP`，如 `/api/auth/login`）仍不 rewrite，也不清 cookie。

**WebSocket：** 只有 upgrade **失败**、退回 HTTP 401 `NODE_LOGIN_REQUIRED` 时能挂 `Set-Cookie`（无 cookie 的 4401 回退）。upgrade **成功**后走 `MESH_REJECT_4401_KIND` 关 4401，此时已经没有 HTTP 响应可附 cookie——跳过。带 stale cookie 的 WS 仍会先 upgrade，via_mismatch 发生在对端校验之后，同样没有 HTTP 响应。刷新页面时 HTTP 的 node-list / API 401 会清 cookie，`loggedIn` 才会变成 false。

## 2. `NODE_UNREACHABLE` 带安全 `reason`

`forwardHttp`（以及 `forwardInternalHttp` / `forwardAuthorizedHttp` / WS 503）在 503 体里加 `reason`，由 `safeUnreachableReason()` 从错误类别映射，只允许：

`not_admitted` | `no_link` | `handshake_failed` | `timeout` | `relay_reset:{self-target,unknown-target,offline,quota-streams,open-failed}`

未知错误一律 `no_link`，不回传 message / stack / 主机名 / token。`packages/shared` 新增 `NodeUnreachableReason` 与 `NodeUnreachableErrorBody`。

## 3. `relayListToNodeList` 过滤非 admitted

`node.status !== 'admitted'` 的成员（pending / revoked）不再投影进可达 `node.list`。中继 `buildRelayList` 下发的就是 `status: RelayNodeStatus`。待审批 UI 走 `/api/mesh/relay/enrollments*`，不依赖这份可达列表。

## 4. `acceptRelay()` catch 结构化日志

握手失败时在 `stream.reset('handshake-failed')` 之前打一行：

`[mesh][relay] accept failed node=<id> reason=<safe message>`

`reason` 取 `Error.message`（去换行、截断 240），例如 `no node_certs for <id>`。未改 `peer-manager.test.ts`（范围仅允许改 catch 那一行）。

## 5. 显式 `RelayDialContext`

`relayUplinkOverrides` 在构造时快照一份 dial（`opts.dial ?? relayDialContextFromEnv()`），传给 `RelayUplinkClient` 和 `probeRelayHealth`，不再在每次 `connectOnce` 里读 `process.env`。未传 `dial` 时行为与「env 是唯一来源」时一致。`relayDialContextFromRuntime()` 与 `fromEnv` 共用同一形状。`mesh-runtime.ts` 不在范围内，启动时仍靠 env 快照（与运行时 config 同源）。

## 改动文件

- `apps/gateway/src/auth/cookies.ts`
- `apps/gateway/src/auth/cookies.test.ts`
- `apps/gateway/src/mesh/forwarder.ts`
- `apps/gateway/src/mesh/forwarder.test.ts`
- `apps/gateway/src/mesh/relay-node-list.ts`
- `apps/gateway/src/mesh/relay-node-list.test.ts`
- `apps/gateway/src/mesh/relay-wiring.ts`
- `apps/gateway/src/mesh/relay-wiring.test.ts`（新增）
- `apps/gateway/src/mesh/relay-uplink-client.test.ts`
- `apps/gateway/src/mesh/relay-dial.ts`
- `apps/gateway/src/mesh/relay-dial.test.ts`
- `apps/gateway/src/mesh/peer-manager.ts`
- `packages/shared/src/contracts/system.ts`

未改 `relay-uplink-client.ts`（已支持 `opts.dial`，缺省仍回落 `relayDialContextFromEnv()`）。未改 `auth-routes.ts` / `relay-hardening.test.ts` / `apps/fe`。

## 验证

| 项 | 之前 | 之后 |
| --- | --- | --- |
| `cd apps/gateway && bun test src/mesh src/relay src/auth` | 任务书：0 fail（T1 修 relay-hardening 的 2 errors）；本任务中途 wiring 测试超时曾 1417 pass / 2 fail | **1419 pass / 0 fail**（116 文件） |
| 本任务相关单测（forwarder / wiring / dial / node-list / uplink-client / cookies） | — | 140 pass / 0 fail |
| `cd apps/gateway && bunx tsc --noEmit -p .` | ≤ 1（已知 TS5097） | **0 error** |
| `cd packages/shared && bunx tsc --noEmit -p .` | — | 0 error |
| `bunx biome check` 触及文件 | — | clean |

## 遗留

- WS upgrade 成功后的 4401：没有 HTTP 响应可清 cookie（见上）。HTTP 401 rewrite 覆盖刷新后的 `loggedIn:false`。
- `acceptRelay` 失败日志没有单独单测（范围不允许改 `peer-manager.test.ts`）。
- `mesh-runtime` 未接线 `config.roles` / `relayPublicUrl` / `port` 到 `relayUplinkOverrides({ dial })`；当前是 overrides 构造瞬间的 env 快照，与 boot 时 runtime config 等价。
