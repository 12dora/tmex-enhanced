# AgentRun 行为保持拆分（续）

日期：2026-08-27

## 背景

`apps/gateway/src/agent/run.ts` 上一轮已抽出 `outcome-resolver.ts` / `stream-accumulator.ts` / `stream-part-router.ts` / `run-resource-scope.ts`，但仍有 921 行。`runOnce` ~180 行、`execute` ~90 行，超出「单函数 ≤80 / 文件 ≤450」目标。

工作目录：`/Users/konata/code/tmex-enhanced-wt-smell`（git worktree）。只改 `apps/gateway/src/agent/` 下 `run.ts` 及相关新文件与测试。禁止 git commit/stash/checkout/add。禁止碰 `tools/*`、`supervisor.ts`、生成文件、生产 tmex。

## 目标

行为保持地继续拆 `AgentRun`：

1. `runOnce` 请求组装（system prompt、历史滑窗、tools、`wrapLanguageModel`）→ 纯函数模块 `build-run-request.ts` + 单测。
2. step 落库（`onStepFinish` / message persistence）→ 小 persister。
3. steer + idle 看门狗 → `run-watchdog.ts`（start/reset/clear，fake timers 测试）。
4. for-await 循环体抽出，使 `runOnce` 读作：build request → open stream → route parts → resolve outcome。
5. `execute` 保留编排，retry/backoff 策略抽成纯函数 + 表格测试。

硬指标：`run.ts` ≤ 450 行；无函数超过 80 行。重试规则、delta flush 时机、资源释放顺序、outcome 优先级（`outcome-resolver.test.ts` 锁定）必须保持。`run.test.ts` / `supervisor.test.ts` / 已有 `*.test.ts` 除 import 外行为不变。

## 约束

- Bun only（`/Users/konata/.bun/bin/bun`），不跑 repo-wide lint --write。
- 只修有把握的 bug，并显式说明。
- 不改对外 API / 导出名（可 additive）。`applyMessageWindow` / `isRetryableLlmError` / `AgentRunDeps` 仍从 `run.ts` 再导出。
- 基线：tsc error 数不升高；`bun test` 无新增失败（已知 `src/tmux-client/local-external-connection.test.ts` 硬编码 `/Users/krhougs` 可忽略，除非在范围内）。
