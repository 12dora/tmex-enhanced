# AgentRun 行为保持拆分 Implementation Plan

> 工作树：`/Users/konata/code/tmex-enhanced-wt-smell`。禁止 git commit。只碰 `apps/gateway/src/agent/`（不含 `tools/*`、`supervisor.ts`）。

**Goal:** 把 `run.ts` 从 921 行压到 ≤450，且 `runOnce`/`execute` 及所有函数 ≤80 行，行为不变。

**Architecture:** 纯函数抽策略（retry、request 组装、step 落库、idle watchdog、stream 分发），`AgentRun` 只做编排与副作用。对外导出名保持：`AgentRun`、`AgentRunDeps`、`AgentRunOutcome`、`applyMessageWindow`、`isRetryableLlmError`、`MESSAGE_WINDOW_CHAR_BUDGET`、`AgentStopReason`。

**Tech Stack:** Bun + TypeScript + AI SDK `streamText` / `wrapLanguageModel`。测试用 `bun:test`。

## 抽出模块

| 文件 | 职责 |
| --- | --- |
| `retry-policy.ts` | `isRetryableLlmError`、`decideRunRetry`、`toErrorMessage` |
| `build-run-request.ts` | `applyMessageWindow`、`wrapRunModel`、`buildRunRequest`、`buildRunTools` |
| `run-watchdog.ts` | idle watchdog：`start` / `reset` / `clear`，超时回调 abort+stall |
| `step-persister.ts` | 累积 `step.response.messages` 只落新增后缀 |
| `run-stream-handlers.ts` | `createRunStreamHandlers`（delta / tool / approval / error / abort） |
| `stream-part-router.ts` | 增加 `consumeAgentStream`（for-await + watchdog） |
| `run-deps.ts` | `AgentRunDeps` + `defaultAgentRunDeps`（为压行数） |
| `title-generation.ts` | 标题纯函数（提取 user 文本 / 规范化）+ `maybeGenerateSessionTitle` |
| `run-notify.ts` | `safeNotify` 抽出 |

`runOnce` 目标形态：build request → open stream → consume/route parts → resolve outcome。

`execute` 保留 acquire/loop/release；catch 里用 `decideRunRetry`。steer drain 抽成 `persistDrainedQueue`。

## 验收

- `run.ts` ≤ 450 行；无函数 >80 行。
- `apps/gateway` tsc error 数 ≤ 基线；`bun test` 无新增失败。
- 新模块 `bunx biome check` 干净。
- `run.test.ts` / `supervisor.test.ts` / `outcome-resolver.test.ts` 继续绿。
