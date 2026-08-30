# G7 结果 — watch scheduler：空组重臂、绝对 deadline、pending tick

## 做了什么

对照 `review-be2-report.md` finding 2/5/6，已在源码确认后修复。

### 1. Blocker：空组立即删除，in-flight 单独跟踪

最后一条规则在 pane tick 进行中被 detach 时，旧逻辑会清 timer 但把空 group 留在 map 里。随后同 pane 再 attach（interval ≥ 残留 `minIntervalMs`）不会重臂，新规则永久得不到调度。

现在：空组立刻 `delete`；pane 级 in-flight 放到独立 `inflight` map。`waitForTick` 等的是 inflight，不再依赖已删除的 group。无 timer 的 group 在 attach 时无条件武装。

### 2. 绝对 per-rule deadline（可注入 `now()`）

去掉 `accruedMs += minIntervalMs` / 归零。每条规则 `deadline = now + intervalMs`；组 timer 打在最近 deadline；tick 取出所有 `deadline ≤ now` 的规则，把它们的 deadline 设为 `now + intervalMs`，再重臂到下一最近 deadline。增删其它规则不改动已有 deadline。

`WatchService` 把 `deps.now().getTime()` 注入 scheduler；生产 `scheduleInterval` 改为 `setTimeout`（每次 tick 后按下一 deadline 重臂，不再用固定 `setInterval`）。

### 3. 不丢 timer：pending 合并后再跑（Option A）

未采用「capture 后释放 pane 排他、规则并行评估」。仍是一次 capture + 组内到期规则串行评估。`runPaneExclusive` 进行中再入只把 `pending=true`（有界一个 flag，不排队），结束后 `do/while` 把积压的 timer 补成一次（若补跑期间又有 timer 则继续排空）。

因此：30s LLM 评估会挡住同 pane 后续 5s regex 的即时 tick，但结束后会补跑，regex 不会被永久饿死。同一拍里若 LLM 与 regex 同时到期，仍按 Set 插入序串行（regex 可能排在 LLM 后面）。

## 文件

- `apps/gateway/src/watch/scheduler.ts` / `scheduler.test.ts`
- `apps/gateway/src/watch/service.ts` / `service.test.ts`

## 测量

scratchpad：`g7-watch-scheduler-bench.ts`

| 场景 | 之前（accrue + 丢 tick） | 之后 |
| --- | --- | --- |
| 5s+7s 规则触发时刻 | 7s 规则在 10、20… | **7、14、21** |
| t=25s 去掉 5s 规则后，30s 规则剩余等待 | 重臂 30s（合计 55s） | **5s**（deadline 仍是 30s） |
| 100 规则 × 6000 次 `takeDue` | — | **8.6–14.1 ms**（min 8.58） |

## 校验

- `cd apps/gateway && bun test src/watch`：**82 pass / 0 fail**
- `bunx tsc --noEmit -p .`：**21**（= baseline）
- `bunx biome check` 上述 4 个文件：**clean**

## 风险

- 慢评估仍占用 pane exclusive；regex 只能在其结束后靠 pending 补跑，不是并发。
- 过期很久的规则每个 tick 只评一次（`deadline = now + interval`），不追赶中间漏拍。
- 空组删除后，旧 tick 的 `fn` 若再因 pending 重入，会读到当前 group（可能已是新规则），这是期望行为。
