# G1 结果 — Remote-node agent sessions (backend)

## 做了什么

Entry gateway（self）持有并执行全部 agent session（含绑定远端 pane 的）。LLM 仍用 self 的 provider；pane I/O 经 mesh 内部 RPC。

1. **DB**：`agent_sessions.node_id TEXT NULL`（null = self）+ index。去掉 `device_id → devices.id` FK（远端 device 不在本机表）。`create`/`list`（`nodeId=self` → `IS NULL`）写入 DTO。
2. **API**：`POST` 接受 `nodeId`（undefined/null/`self` → null）。远端：`listReach` 校验 known+trusted；无 peer → 404 `NODE_NOT_FOUND`，offline → 503 `NODE_UNREACHABLE`，online 跳过本机 device 校验；origin 走 `RemotePaneRuntime.getPaneInfo`。`GET ?nodeId=` 过滤。`PATCH` 不改 node。
3. **Mesh 内部 RPC**：`POST /api/mesh-internal/tmux/{pane-info,capture,send-input}`。仅 `acceptHttpStream` 打上的 `x-tmex-mesh-peer` 可进；外部入口剥标记；浏览器 `/n/:id/api/mesh-internal` → 403。无标记 403，不要求 cookie。`RemotePaneRuntime` + `acquireRuntime(nodeId, deviceId)`；`NODE_UNREACHABLE` 映射为工具/会话错误。
4. **Offline**：`mesh-runtime.emitNodeEvent` 在 offline/revoked 时 `notifyNodeOffline` → `supervisor.stopSessionsForNode`（abort 活动 run；running/waiting → `error` + `lastError=NODE_OFFLINE` + WS broadcast）。

## 文件

**新建**

- `apps/gateway/drizzle/0026_acoustic_roughhouse.sql` + `meta/0026_snapshot.json`（`node_id` 列）
- `apps/gateway/drizzle/0028_magical_doctor_doom.sql` + `meta/0028_snapshot.json`（重建表，去掉 `device_id` FK；CHECK 手改为未限定列名，避免 SQLite RENAME 后约束仍引用 `__new_*`）
- `apps/gateway/src/db/agent-sessions-node-id.migration.test.ts`
- `apps/gateway/src/mesh/peer-request-marker.ts` + test
- `apps/gateway/src/mesh/mesh-internal-tmux-routes.ts` + test
- `apps/gateway/src/mesh/mesh-agent-bridge.ts`
- `apps/gateway/src/agent/remote-pane-runtime.ts` + test
- `apps/gateway/src/agent/node-offline-bus.ts` + test

**修改（G1 范围）**

- `apps/gateway/src/db/schema.ts`（仅 `agentSessions`：`nodeId`、去掉 device FK、index）
- `apps/gateway/src/db/agent.ts`
- `apps/gateway/src/api/agent-session-routes.ts`、`agent-dtos.ts`、`agent.test.ts`
- `apps/gateway/src/agent/supervisor.ts` + test、`run.ts`、`run-deps.ts`、`run-resource-scope.ts`、`run-finish.ts` + test、`outcome-resolver.ts` + test
- `apps/gateway/src/agent/tools/{pane-info,send-input,terminal-context,run-command,run-command-spawn}.ts`（及 spawn test）
- `apps/gateway/src/mesh/stream-targets.ts` + test、`mesh-http.ts` + test、`forwarder.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts`（hook：`notifyNodeOffline`、`setMeshAgentBridge`；该文件同时有 G2 的 reach/rtt 改动，未改 G2 文件）
- `apps/gateway/drizzle/meta/_journal.json`（追加 0026/0028；0027 为 G4）

未改 G2：`peer-manager.ts`、`node-list-projection.ts`、`mesh-routes.ts`、`mesh-deps.ts`、`types.ts`。未改 shared 契约形状。

## 验证

| 项 | 结果 |
|---|---|
| `cd apps/gateway && bun test` | **2581 pass / 0 fail**（基线 2500；他组并行加了测试） |
| `bunx tsc --noEmit -p .` | **21 errors**（= 基线 21；G1 范围内 0 条新错误） |
| `bunx biome check`（G1 源文件，不含原有 `supervisor.test.ts` / `agent.test.ts` 的 `noNonNullAssertion`） | **clean** |

原有 `supervisor.test.ts` / `agent.test.ts` 的 `noNonNullAssertion` 未改。

## 风险 / 未做

- **`device_id` 无 FK**：远端 session 的 device 不在本机 `devices`。本机删设备时远端行不会级联。
- **0028 CHECK 手改**：drizzle-kit 生成的 `"__new_agent_sessions"."write_mode"` 在 RENAME 后 SQLite 报错；已改为 `CHECK("write_mode" in …)`（同 0016 写法）。
- **`schema.ts` 同文件有 G4 的 `tunnelConfig`**：未动其形状；`db:generate` 时 0027 已存在，故 FK 拆除落在 0028。
- **`mesh-runtime.ts` 与 G2 交错**：G1 只加了 offline bus + agent bridge；G2 的 `onLinkInfo` / `rttMs` / `isPeerReachable` 是并行改动。
- **RemotePaneRuntime 无 live stream / emulator**：远端 `run_command` 仍会因无 subscribe 而要求改用 `send_input` + `read_screen`（与无流 stub 一致）。`sendInput` 已改为可 await，避免远端 RPC 竞态。
- **`setMeshAgentBridge` 进程单例**：`createMeshRuntime` → `wireMeshHttp` 时设置；仅 `bootMesh()` 且不走该路径的测试需自行 stub（`agent.test.ts` 已 stub）。
- **trusted 判定**：`lookupNode` 用 `peers.listReach()`（内部已跳过 untrusted）；不在 map → unknown。
