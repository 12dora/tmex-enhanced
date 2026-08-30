# G2 result — windowed history load per turn

## What changed and why

每轮 turn 不再 `SELECT` 会话全部消息再对每条 `JSON.stringify` 做 200k 滑窗。新增 `listAgentMessagesForWindow`：按 `length(content)` 从新到旧分页（默认 200 行），累加到预算 + 10% 余量且落到一条 `user` 后停止，再只加载该 suffix；`buildRunRequest` 里原有 `applyMessageWindow` 仍跑在 suffix 上，user / tool-call 边界语义不变。

标题生成语义上只要**首条 user**，因此用 `getFirstAgentUserMessage`（`role=user ORDER BY seq LIMIT 1`），不再二次全表扫描。`run-deps.ts` 未改：消息查询与原来一样直接走 DB 模块，不进 deps。`build-run-request.ts` 未改：`applyMessageWindow` 仍是权威实现。

## Files

- `apps/gateway/src/db/agent.ts` — `listAgentMessagesForWindow`、`getFirstAgentUserMessage`
- `apps/gateway/src/db/agent-message-window.test.ts` — 短历史 / 超预算 / tool 对边界 与全量滑窗等价
- `apps/gateway/src/agent/run.ts` — turn 组装与标题改为窗口/首条 user
- `apps/gateway/src/agent/run.test.ts` — 标题只用首条 user 的回归
- 未改：`build-run-request.ts`、`run-deps.ts`

## Measurement（10k 条合成会话，~1.8KiB/条，预算 200_000）

Bench: `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/6c2fc705-32ec-470c-8790-255ad37938cd/scratchpad/g2-windowed-history.bench.ts`

| 路径 | hot ms | rows loaded | 滑窗后条数 |
|---|---|---|---|
| before：`listAgentMessages` + `applyMessageWindow` | 22.024 | 10_000 | 104 |
| after：`listAgentMessagesForWindow` + `applyMessageWindow` | 0.930 | 119 | 104 |

warm：before 33.637 ms / after 1.654 ms。`windowMatchesFull: true`。约 24× 加速，加载行数 10000 → 119。

## Verify

- `bun test src/agent src/db`：397 pass / 0 fail（含原有 `applyMessageWindow` 用例，未改）
- `bunx tsc --noEmit -p .`：22 errors，触及文件 0。相对 round 基线 21 多出的 1 条是并行 G1 的 `src/mesh/forwarder.test.ts`（`pendingForwardStreamCount`），与本任务无关
- biome：`agent.ts` / `agent-message-window.test.ts` / `run.ts` clean；`run.test.ts` 仅有改动前已存在的 `noNonNullAssertion`

## Left / risk

SQL `length(content)` 与 `JSON.stringify(ModelMessage)` 在极端 unicode 下可能略有偏差；用 10% 余量 + 继续扫到 user，再用现有 `applyMessageWindow` 做最终裁切。10k bench 结果与全量滑窗一致。无 user 的超预算会话会退化为全量加载（与「无合法截断点则原样返回」一致）。
