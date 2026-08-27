# subscription-plan 结果

## 改了什么

从 `PaneSubscriptionCoordinator.apply`（原 112 行、CC≈18）抽出不可变计划：去重、generation 判定、请求校验、容量准入、replay 构造都在 planner 里完成。`apply()` 只编排「关闭检查 → 判定 → sweep → 计划 → 原子提交」。

`decideSubscription(consumer, generation, requestedActive, requestedHot)` 返回：

- `reuse`：stale generation，或同代且 fingerprint 一致（不重新准入、不 sweep）
- `conflict`：同代但内容不同（`apply` 仍抛 `PaneSubscriptionGenerationConflictError`）
- `commit`：已 unique 的 active/hot 列表与 fingerprint

`planSubscription({ generation, requested*, panes, otherActive/otherHot, max*, buildReplay })` 返回不可变 `{ accepted, rejected, replay }`：

- `accepted.active` / `accepted.hot`：校验通过且未超容的克隆请求
- `rejected`：带 `not_found` / `epoch_changed` / `resource_exhausted` 原因
- `replay`：按 active-then-hot 顺序对已接受请求调用 `buildReplay`

`commit()` 只写 consumer.generation/fingerprint/active/hot、touch 时间戳、`policy.refreshModes`。

`apply` 现约 20 行 / CC 4。planner 各函数均 ≤ 25 行、CC ≤ 6。

## 文件

- `apps/gateway/src/tmux-client/retention/subscription-coordinator.ts`（apply 改为 decide + sweep + plan + commit）
- `apps/gateway/src/tmux-client/retention/subscription-plan.ts`（新建）
- `apps/gateway/src/tmux-client/retention/subscription-plan.test.ts`（新建，表驱动 10 条：判定 5 + 计划 5）

未改：`subscription-coordinator.test.ts`、kernel / policy-scheduler / replay-store。

## 修的 bug

无。本次是行为保持的拆分。

## 测试 / tsc

TDD：planner 测试先写，模块缺失时 1 fail（`Cannot find module './subscription-plan'`）；实现后全绿。原 `subscription-coordinator.test.ts` 与 `pane-retention.test.ts` 行为锁定未动。

表驱动覆盖：

- 去重：active/hot 同 pane 取先者；hot 中与 active 重复的 id 直接丢掉（不进 rejected）
- stale generation / 同代幂等 reuse / 同代冲突 / 更高代 commit / 首次 0n
- 非法请求：`not_found`（缺失、`known=false`）、`epoch_changed`
- 容量：active union 共享不占新槽；hot 独立上限；`not_found` 不占槽
- replay 范围：null cursor 需 screen；区间内后缀；越过 latest → `pane_gap`；前缀被逐出 → `cache_evicted`

命令：

```
cd apps/gateway
bun test src/tmux-client/retention/subscription-plan.test.ts src/tmux-client/retention/subscription-coordinator.test.ts
# 12 pass / 0 fail（原 coordinator 2 + planner 10）

bunx biome check --write src/tmux-client/retention/subscription-plan.ts \
  src/tmux-client/retention/subscription-plan.test.ts \
  src/tmux-client/retention/subscription-coordinator.ts
# 通过

bunx tsc --noEmit -p .
# 25 error TS（基线 25），本任务文件 0 条

bun test
# 1867 pass / 0 fail（任务基线 1826；本任务 +10；其余增量来自并行 agent）
```

## 没做的 / 原因

- 未把 `policy.sweep` 放进 planner：sweep 有副作用，且 reuse/conflict 路径原本不 sweep，放进去会改变幂等 apply 的 eviction/mode 行为
- `validateRequest` 随准入逻辑迁到 `laneRejection`，coordinator 不再保留该 public 方法；仓库内无调用方，`pane-retention` 也未再导出
- 未改 kernel / policy-scheduler / replay-store（任务明确排除；replay 通过 `buildReplay` 回调接现有 `PaneReplayStore.buildReplayPlan`）
