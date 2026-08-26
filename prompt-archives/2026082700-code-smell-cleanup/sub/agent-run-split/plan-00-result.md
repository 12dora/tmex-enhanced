# AgentRun 拆分执行结果

日期：2026-08-27

## 完成情况

`apps/gateway/src/agent/run.ts` 从 921 行压到 **450 行**，最长函数 `runOnce` 61 行（目标 ≤80）。`runOnce` 现为：assemble request → open stream → consume/route parts → resolve outcome。`execute` 只负责 acquire / `runLoop`（retry+steer）/ release。

## 抽出文件

| 文件 | 职责 |
| --- | --- |
| `retry-policy.ts` | `isRetryableLlmError`、`decideRunRetry`、`toErrorMessage` |
| `build-run-request.ts` | `applyMessageWindow`、`wrapRunModel`、`buildRunRequest`、`buildRunTools` |
| `run-watchdog.ts` | idle watchdog start/reset/clear |
| `step-persister.ts` | 累积 messages 只落新增后缀 |
| `run-stream-handlers.ts` | stream part → delta/broadcast/approval |
| `stream-part-router.ts` | 新增 `consumeAgentStream` |
| `run-deps.ts` | `AgentRunDeps` + 默认实现 |
| `title-generation.ts` | 标题提取/规范化/`maybeGenerateSessionTitle` |
| `run-notify.ts` | `notifyAgentEvent` |
| `run-finish.ts` | idle / waiting / abort / error 收尾 |

对外导出名不变：`AgentRun`、`AgentRunDeps`、`AgentRunOutcome`、`applyMessageWindow`、`MESSAGE_WINDOW_CHAR_BUDGET`、`isRetryableLlmError`、`AgentStopReason` 仍从 `run.ts` 再导出。

## 类型修复

原 `run.ts:421` tsc：`LanguageModelV3 | LanguageModelV2` 不能赋给 `wrapLanguageModel` 的 `LanguageModelV3`。抽出 `wrapRunModel` 时在 adapter 上断言（string 模型仍不 wrap）。运行时与原来一致，tsc 全包 error 从 35 → 34。

## 验证

- tsc `error TS`：基线 35 → 现在 34（run.ts 无 error）
- `bun test`（apps/gateway）：基线 1187 pass / 0 fail → **1269 pass / 0 fail**（新增模块测试）
- `bunx biome check`：本次改动/新建文件干净
- `run.ts` 450 行，函数均 ≤80

未跑 git commit（orchestrator 负责）。
