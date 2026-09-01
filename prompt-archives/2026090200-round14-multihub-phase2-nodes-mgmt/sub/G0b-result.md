# G0b result — Backend review fixes

## 做了什么

按 RV1 已采纳项修了 6 处：degraded 仍视为隧道存活、日志脱敏加强、metrics 端口归属、在途 probe 隔离、RTT 仅成功记录并序列化、卸载接口在 handler 内显式要求用户会话。

## 行为要点

1. **`processUp()`**（`running || degraded`）用于 last-protection 与所有「进程还在」门：`requireLastProtectionAck`、`status().processAlive`、`startProcess` 重启判定、`shouldProbeConnector`。degraded 下 `remove_access` / `set_access_enforce(false)` 仍要 `acknowledgeExposure`。
2. **`redactSecrets`**：URL userinfo、全部 query 值（保留 key）、匹配 `pass(word)?|secret|token|api[-_]?key|authorization|cookie|session|jwt|bearer|credential` 的 `key=value` / `"key":"value"`、`Bearer` / `Basic`；保留 ≥32 hex/base64/base64url。`extractLastError`、`readLogTail`、ring buffer、`connector.lastError` 均走它。
3. **metrics 归属**：`parseCloudflaredYml` 读 `metrics:`；无 argv `--metrics` 时用 YAML。`discoverMetricsAddr` 顺序 spawned → argv → config → log → 20241–20245。扫描且 **多于一个** `/ready` 应答时 `reachable: null`，`lastError` 为 `multiple cloudflared metrics endpoints answered; cannot attribute`（不再取第一个）。
4. **在途 probe**：每次 probe 打上 `connectorPollGen` + managed 的 pid/startedAt；gen 或进程变了则丢弃结果。`stop` / `remove` / `start` 走 `resetConnector()`（bump gen、清空 in-flight、`EMPTY_CONNECTOR`）。
5. **RTT**：`probeHealthzTimed` 仅成功写 `rttMs`/`rttAt`，失败清 null。`GET /api/mesh/hubs` `candidates[]` 序列化这两个字段（object 透传，string 分支 null）。
6. **卸载鉴权**（未加新签名方案）：
   - **直连** `GET/POST /api/system/uninstall`：外层 `mesh-http.localUiGuard` 对 `/api/*` 调 `authenticateRequest`。hub/node 要节点会话 cookie；**standalone 且 localAuth 未生效时** 该门会 open-bypass（原先的洞）。handler 内再用与 staged upgrade 相同的 `requestIsStagedAuthenticated` / `requireUninstallAuth`（dispatch `via≠self`，或 `dispatch.uid`，或 mesh ctx `sid+uid`），否则 401 `{ code: 'UNAUTHORIZED' }`。`startLocalUninstall` 再检一次并打审计 `[system] uninstall requested via=<self|peer nodeId> user=<uid>`。
   - **中继** `POST /api/mesh/nodes/:id/uninstall`：`requireSession` + `handleUninstallStart` 显式要求 `auth.userId`（挡住 standalone open-bypass）。forwarder 带 `requestDispatchContext.uid` + `viaNodeId`。目标节点按上述 predicate 认 peer dispatch，`via` 记入口 nodeId。

## 文件

- `apps/gateway/src/tunnel/redact.ts`
- `apps/gateway/src/tunnel/util.test.ts`
- `apps/gateway/src/tunnel/connector-health.ts`
- `apps/gateway/src/tunnel/connector-health.test.ts`
- `apps/gateway/src/tunnel/external-detect.ts`
- `apps/gateway/src/tunnel/external-detect.test.ts`
- `apps/gateway/src/tunnel/manager.ts`
- `apps/gateway/src/tunnel/manager.test.ts`
- `apps/gateway/src/system/uninstall.ts`
- `apps/gateway/src/system/uninstall.test.ts`
- `apps/gateway/src/api/system.ts`
- `apps/gateway/src/api/system.test.ts`
- `apps/gateway/src/mesh/mesh-routes.ts`（仅 `serializeHubCandidate` + uninstall relay 显式 userId）
- `apps/gateway/src/mesh/mesh-routes.test.ts`
- `apps/gateway/src/mesh/uplink-pool.ts`
- `apps/gateway/src/mesh/uplink-pool.test.ts`

## 验证

- 针对性：`bun test src/tunnel/util.test.ts src/tunnel/connector-health.test.ts src/tunnel/external-detect.test.ts src/tunnel/manager.test.ts src/system/uninstall.test.ts src/api/system.test.ts src/mesh/uplink-pool.test.ts src/mesh/mesh-routes.test.ts`：**287 pass / 0 fail**
- 整包 `bun test`（`apps/gateway`）：**3438 pass / 0 fail**（基线 ≈3408；含本任务新增用例，其他 agent 同期也可能加测）
- `bunx tsc --noEmit -p .`：**0 errors**（基线 0）
- `bunx biome check`（上述改动文件）：clean

## 未做

- 未引入卸载用户密钥签名 / nonce 防重放（任务明确禁止新签名方案）。
- 未改 `packages/shared` 契约与前端。
- standalone + localAuth 未生效时，其它 `/api/system/upgrade` 非 staged 路径仍可能只靠中间件；本任务只收口 uninstall。
