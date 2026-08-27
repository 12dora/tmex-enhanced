# metadata-plan 结果

## 改了什么

从 `MetadataProjection.reconcile` 抽出纯函数 `planReconcile`：desired-state diff、revision/baseRevision 冲突判定、增删改计划都在 planner 里完成。projection 只保留首次 `establish` 和一次 revision 的原子提交（`beginDirtyRevision` → 升 revision → apply → `finishMutation`）。

`planReconcile({ current, desired, removedAt, baseRevision })` 返回：

- `additions` / `fieldChanges` / `parentChanges` / `removals`
- `conflicts`：因 stale `baseRevision` 跳过的变更（`addition` 墓碑、`field`、`parent`、`removal`）
- `reconcilePlanHasWork`：仅四类变更为空时不算 work，纯冲突不 bump revision（与原语义一致）

`reconcile` 从约 CC 23 / 74 行降到 CC 4 / 16 行。planner 各函数 CC ≤ 7、≤ 20 行。

## 文件

- `apps/gateway/src/tmux-client/metadata-projection.ts`（reconcile 改为 plan + commit）
- `apps/gateway/src/tmux-client/metadata/reconcile-plan.ts`（新建）
- `apps/gateway/src/tmux-client/metadata/reconcile-plan.test.ts`（新建，表驱动 9 条）

未改：`metadata/hierarchy-builder.ts` 及其他文件。

## 修的 bug

无。本次是行为保持的拆分。

## 测试 / tsc

TDD：planner 先空实现，8/9 断言失败（`preserves projection-owned custom name` 期望空计划，stub 碰巧绿），实现后全绿。

- `bunx biome check --write`：上述 3 个文件通过
- `bun test src/tmux-client/metadata-projection.test.ts src/tmux-client/metadata/reconcile-plan.test.ts`：**22 pass / 0 fail**（原 projection L141–418 的 13 条 + planner 9 条）
- `bun test`（整个 gateway）：**1607 pass / 1 fail**。失败是并行任务 `db-indexes` 的 `src/db/agent-watch.test.ts`：`list pending confirmations uses (session_id, status, created_at) index` 在 `DROP INDEX` 时 `database table is locked`，与本任务无关。基线 1473；本任务新增 9 条，其余增量来自并行 agent
- `bunx tsc --noEmit -p .`：**28 errors**（基线 27）。新增 1 条是并行任务 `history-reader` 的 `src/tmux-client/pane-history-page.ts` 找不到 `./pane-history-session`。本次文件 0 条 tsc 错误

## 没做的 / 原因

- 首次建立（`established === false`）仍走 `establish()` 全量写入 revision 1，不是 diff plan。原逻辑就不是 reconcile 计划，拆进去只会把「无 current」和「tombstone 冲突」缠在一起
- `conflicts` 是规划结果上的显式判定，commit 路径不消费它；stale 字段/父/增/删被省略后若无其余 work，revision 不前进
- 未改 `hierarchy-builder.ts`（任务明确排除）
