# supervisor-approval 执行结果

## 背景

`AgentSupervisor.appendApprovalResponsesIfReady` 原约 94 行、CC≈21，把扫描最后一条 assistant 的 `tool-approval-request`、识别后续 tool 消息中已决议的 call、按 confirmation 拼 approved/denied/cancelled parts、落库和广播揉在一起。

## 改动

新增纯模块 `apps/gateway/src/agent/approval-response-reconciler.ts`：

| 函数 | 职责 |
| --- | --- |
| `findApprovalRequests(messages)` | 找最后一条 assistant 的 approval-request；后续 tool 消息里已有 `tool-approval-response` / `tool-result` 的视为已决议。返回 `absent` / `complete` / `open`。 |
| `collectResolvedToolCalls(requests, confirmations)` | 按 approvalId 匹配 confirmation；任一 pending / 缺失则整批 `null`。同一 approvalId 多条 confirmation 取第一条。 |
| `buildApprovalResponseParts(resolved)` | approved/denied → `tool-approval-response`；cancelled → `tool-result` + `execution-denied`。 |

`appendApprovalResponsesIfReady` 只保留：读 messages / confirmations、调上述纯函数、`appendAgentMessage` + `broadcastPersisted`。调用点未改。

## 文件

- 修改：`apps/gateway/src/agent/supervisor.ts`（该方法 + import）
- 新建：`apps/gateway/src/agent/approval-response-reconciler.ts`
- 新建：`apps/gateway/src/agent/approval-response-reconciler.test.ts`

未改：`agent/supervisor.test.ts`、`agent/run.ts`、`agent/tools/**`、`api/**`

## Bug

无行为修复。这是结构抽取，对外语义保持原样。

## 测试

纯函数单测覆盖：mixed approved/denied/cancelled、unmatched tool calls、duplicate confirmations、已决议过滤、缺失 `toolCallId`。

- `bun test src/agent/approval-response-reconciler.test.ts src/agent/supervisor.test.ts`：38 pass / 0 fail（含 supervisor L400–542、L902–961 原用例）
- `bunx biome check --write` 上述 3 个文件：通过
- `bunx tsc --noEmit -p .`：27 errors，与基线一致；无 `approval-response-reconciler` / `supervisor.ts` 新增
- `bun test`（gateway 全量）：1607 pass / 2 fail（基线 1473）。失败均不在本任务范围，未修：
  - `agent query indexes > list pending confirmations uses (session_id, status, created_at) index`（`db-indexes`）
  - `LegacyFeedBroadcaster pane observer counts > skips batching when nobody observes...`（`legacy-broadcaster`，`feed.legacyPaneObserverCount` 未定义）

## 未做 / 等价差异

已决议 `tool-result` 匹配改为只用 request 上的 `toolCallId`，不再回退 `confirmation.toolCallId`。生产路径里 approval-request 与 confirmation 的 `toolCallId` 同源，supervisor 回归覆盖 approve / deny / stop-cancelled / crash 恢复。若 request 缺 `toolCallId` 且 confirmation 的 id 不同，理论上可能把已有 tool-result 再判成未决议；未改调用点去补 confirmation 回退。
