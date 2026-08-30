# G5 结果 — 审查修复（remote agent / mesh-internal RPC）

## 做了什么

按 `review-be-1-report.md` 六项全部落地，并补回归测试。

1. **鉴权绕过**：`acceptHttpStream` 先 `new URL()` 规范化，再用 `url.pathname` 决定是否跳过 session 鉴权。明文 `..`、`%2e%2e`、多级 `..` 均 401；真正的 `/api/mesh-internal/` 仍跳过。
2. **0028 迁移**：在 DROP 父表前把 `agent_messages` / `agent_queued_messages` / `agent_confirmations` 拷到 `__bk_*`，重建父表后再插回。测试从 0027 状态塞满子表，在事务内升级，断言行还在且 `PRAGMA foreign_key_check` 干净。
3. **内部 tmux RPC**：`acquire` 后若未连接则 `connect()`；未连接返回 502 而不是 `{ok:true}`；`sendInputAndWait` 等到 tmux write 完成再 release。无预存 runtime 时三条 RPC 都能 connect 且输入到达 pane。
4. **生命周期**：`start()` 只恢复本机 session；`restoreRemoteSessions()` 在 mesh `start()` 之后由 `GatewayRuntime.restoreRemoteAgentSessions` 调用。关闭时先 `stopAgentSessions()` 再停 mesh；supervisor `stopping` 时忽略 `notifyNodeOffline`。
5. **在线语义**：`lookupRemoteNode` / `isRemoteNodePresent` = `hubOnline || isPeerReachable(reach)`，创建校验与 node.list 离线事件共用。hub 在线+空闲链路 → create 允许；hub 离线+直连仍在 → 不发 offline。
6. **输入校验**：`paneId` 走 `isTmuxPaneId()`（不 trim，换行/空格拒绝）；`deviceId` 须存在；`historyLines` 整数 0..2000。

范围外但为实现「可等待的 tmux 写入」所必需：`local-external-connection.ts` / `ssh-external-connection.ts` 的 `sendInput` 改为返回写入 Promise。

`assemble.ts` 的 start/stop 钩子在本分支已调用 `restoreRemoteAgentSessions` / `stopAgentSessions`（optional）；本次补上 `GatewayRuntime` 实现，使钩子生效。

## 文件

**新建**

- `apps/gateway/src/db/agent-sessions-fk-rebuild.migration.test.ts`
- `apps/gateway/src/mesh/mesh-agent-bridge.test.ts`
- `apps/gateway/src/mesh/mesh-runtime-node-presence.test.ts`

**修改**

- `apps/gateway/drizzle/0028_magical_doctor_doom.sql`
- `apps/gateway/src/mesh/stream-targets.ts` + test
- `apps/gateway/src/mesh/mesh-internal-tmux-routes.ts` + test
- `apps/gateway/src/mesh/mesh-agent-bridge.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts`（仅 lookupNode + node.list 在线判定）
- `apps/gateway/src/agent/supervisor.ts` + test
- `apps/gateway/src/runtime.ts`
- `apps/gateway/src/tmux-client/device-session-runtime.ts`
- `apps/gateway/src/tmux-client/local-external-connection.ts`
- `apps/gateway/src/tmux-client/ssh-external-connection.ts`
- `packages/app/src/runtime/assemble.test.ts`

未改 `0028_snapshot.json`（表形状不变）。未改 generated i18n。`supervisor.test.ts` 原有 `noNonNullAssertion` 未动。

## 验证

| 项 | 结果 |
|---|---|
| `cd apps/gateway && bun test` | **2617 pass / 0 fail** |
| `bunx tsc --noEmit -p .`（apps/gateway） | **21 errors**（= 基线 21） |
| `bunx biome check`（本次源文件，不含原有 supervisor.test.ts 的 noNonNullAssertion） | **clean** |
| `packages/app` assemble.test.ts | **27 pass / 0 fail** |

## 风险 / 未做

- **deviceExists** 包了 try/catch：bootMesh 的 auth-only 库没有 `devices` 表，查询会抛错；失败视为不存在并 404，避免把「缺 cookie」测成未捕获异常。
- **内部 RPC 每次 acquire/release**：refCount 归零会 shutdown runtime，下一次 RPC 再 connect。无浏览器持有时可行，但比长驻连接更重。
- **gateway-only 入口**（不走 assemble）不会调用 `restoreRemoteSessions()`；远端 running session 会保持 running 直到有人调用该钩子。生产路径走 assemble。
- SSH `sendInput` 现在会把 chunk 写入 Promise.all 后再 resolve；控制通道失败会 reject，内部路由返回 502。
