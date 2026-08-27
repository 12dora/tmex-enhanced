# watch-evaluator 执行结果

## 背景

`evaluateWatchRule` 原 85 行、CC≈20，把规则类型分发、正则编译、match 命中、unchanged 无命中 reset、值变化计时和 cooldown 闸门揉在一起。本任务只拆分求值器，不改 `watch/service.ts` 与 `api/watch*`。

## 改了什么

`apps/gateway/src/watch/evaluator.ts` 只保留编排：llm 拒绝、按 rule 缓存的正则编译、`findLastMatch`、`passesTriggerGate`，再按 `triggerType` 分发。

| 文件 | 职责 |
| --- | --- |
| `watch/evaluator.ts` | 类型、`compileWatchPattern` / `findLastMatch`、触发闸门、按 rule.id 缓存正则、分发 |
| `watch/evaluator-match.ts` | match 型：无命中 miss；有命中则 `hit = canTrigger` |
| `watch/evaluator-unchanged.ts` | unchanged 型：无命中 reset/ignore、首次观测/值变化重置计时、卡住阈值 + 闸门 |

公开行为不变：`evaluateWatchRule` 签名与返回值结构未改，`service.ts` 无需动。

正则缓存：`Map<ruleId, { pattern, flags, regex }>`。pattern/flags 变化则重编译；编译失败不写入缓存。`findLastMatch` 仍会把 `lastIndex` 置 0，缓存的全局正则可连续求值。

复杂度（抽后，阈值 12 / 80 行）：

| 函数 | CC | 行数 |
| --- | --- | --- |
| `evaluateWatchRule` | 4 | 25（原 ≈20 / 85） |
| `compileCachedRuleRegex` | 8 | 23 |
| `passesTriggerGate` | 6 | 21 |
| `evaluateMatchRule` | 2 | 13 |
| `evaluateUnchangedRule` | 6 | 25 |

## Bug 修复

无行为 bug。cooldown 边界、非法 flags、unchanged 首次观测原先就按现语义工作，本次补的是表征/回归用例，并加上按 rule 的正则缓存（pattern 变更必须失效）。

## 测试

原 `evaluator.test.ts` L42–282（match / unchanged 主用例）未改，仍通过。

新增：

- `evaluator.test.ts`「evaluateWatchRule 边缘」
  - cooldown 刚好到期（`elapsed === cooldown`）hit；`lastTriggeredAt === now` 不 hit
  - unchanged + repeat 同样的 cooldown 边界
  - 非法 flags → `invalid pattern`，不 hit
  - unchanged 首次观测：已有空 state 记录只记值不 hit
  - 同 rule id 换 pattern 不复用旧正则；缓存正则连续求值不因 `lastIndex` 漏命中
- `evaluator-match.test.ts`：无命中 / 命中 + canTrigger / 命中但闸门关闭
- `evaluator-unchanged.test.ts`：首次观测、reset、ignore、卡住时长刚好等于阈值、闸门关闭、`unchangedMinutes === 0`

抽出模块测试先因文件不存在失败，实现后转绿。

## 文件清单

- 修改：`apps/gateway/src/watch/evaluator.ts`、`apps/gateway/src/watch/evaluator.test.ts`
- 新建：`apps/gateway/src/watch/evaluator-match.ts`、`evaluator-match.test.ts`、`evaluator-unchanged.ts`、`evaluator-unchanged.test.ts`
- 未改（按 scope）：`watch/service.ts`、`api/watch*`

## 验证

- `bunx biome check --write` 上述 6 个文件：通过。
- `bun test src/watch/evaluator.test.ts src/watch/evaluator-match.test.ts src/watch/evaluator-unchanged.test.ts`：40 pass / 0 fail。
- `bun test src/watch/`：73 pass / 0 fail。
- `cd apps/gateway && bun test`：1599 pass / 3 fail / 1 error（基线 1473）。失败均不在本任务文件：
  - error：`tmux-client/pane-history-page.test.ts` 找不到 `./pane-history-page`（并行 history-reader）
  - fail：`db/agent-watch.test.ts` 两条 query index 断言（并行 db-indexes）
- `bunx tsc --noEmit -p .`：33 个 error，**均不在 watch/evaluator***。基线 27；增量来自并行任务（`screen-frame-source.test.ts`、`push/supervisor.test.ts`、`issue45-cross-bug.test.ts` 等）。

## 未做 / 为何

- 未把 `passesTriggerGate` 导出：闸门仍是 evaluator 内部实现，分支只收 `canTrigger: boolean`。
- 未清缓存 API：测试通过「同 id 换 pattern」覆盖失效；生产侧规则更新会带新 pattern/flags。
- 未改 service 编排或 llm 型求值（范围外）。
