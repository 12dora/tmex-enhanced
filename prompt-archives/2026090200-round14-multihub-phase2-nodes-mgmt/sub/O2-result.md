# O2 结果 — 批量升级的断点续跑（刷新不丢）

## 做了什么

「全部升级」的编排原先只活在页面里，一次刷新（本机升级必然带来一次）就会丢掉「还没开始的组」「hub → 本机的次序」与最后那条汇总。现在把计划落到 `localStorage`，刷新后按同一份 `order` 接着跑。

### 1. 新增 `upgrade-batch-storage.ts`

键 `tmex.nodes.upgrade-batch.<entryNodeId>`，结构：

```ts
{ schema: 1, batchId, entryNodeId, targetVersion, order: string[][], done: [{nodeId, outcome}],
  startedAt, updatedAt, summaryEmitted, ownerTabId }
```

- `loadBatchPlan(entryNodeId, now)` / `saveBatchPlan` / `clearBatchPlan` / `planRemaining` / `createBatchPlan` / `canAdoptBatchPlan` / `currentTabId` / `createBatchPlanSink`。
- 所有 `localStorage` / `sessionStorage` 访问（含取 `globalThis.localStorage` 这一步本身）都包 try/catch：隐私模式、配额耗尽只会退化成「刷新即丢」，绝不把升级带塌。
- TTL 2 小时（按 `updatedAt`）；`summaryEmitted`、`entryNodeId` 不匹配、schema/字段/结论值不合法的一律作废并顺手清掉（存储内容一律当不可信输入解析）。
- `ownerTabId` 存在 `sessionStorage`（跨刷新不变，所以原标签页刷新后立刻认得自己的批量）；别的标签页要等心跳停摆 30 秒才接管（`UPGRADE_BATCH_OWNER_STALE_MS`），推进期间每 10 秒 `touch()` 一次心跳。限制已写在文件头注释里：两个页面同时开批量仍会互相干扰，真正的互斥要靠后端。

### 2. `upgrade-batch.ts`：编排全部收拢到这里

- `runUpgradeBatch` 新增 `groups?`（按持久化顺序推进，缺省仍按 `orderUpgradeGroups`）、`settled?`（上次会话已跑完的机器直接进汇总与进度）、`onSettled?`（每台落定回调）。
- 从 `use-node-upgrade.ts` 迁入 `Translate` / `UpgradeToasts` / `SILENT_UPGRADE_TOASTS` / `reportBatchSummary` / `launchUpgradeBatch`（`use-node-upgrade.ts` 原样再导出，`nodes-management.test.tsx` 等既有 import 不受影响）。这样 `types.ts` 完全不用动，避开与 O1 的冲突。
- `launchUpgradeBatch` 新增 `openPlan(order, targetVersion)` 落盘口，`onStart(total, completed)`。
- 新增 `resumeUpgradeBatch`：按 `planRemaining` 的分组续跑，`joinRunning` 命中的行只等结论（不重发 POST），已经升到目标版本的行按 `alreadyLatest` 计成功（本机自己重启回来必然走这条），已离开列表的节点不计入；最后仍然只有一条汇总 toast，然后清计划。
- **卸载打断的那台机器不记账**（`recordSettled`：`outcome === 'cancelled' && signal.aborted` 时跳过）——它多半还在目标机上跑，记成 cancelled 会让下次挂载直接跳过并谎报「已取消」。用户主动按停止（signal 未 abort）照常记 `cancelled`。
- 计划里的机器一台都不在列表里时静默作废，不弹「0 成功 0 失败」这种废话。

### 3. `use-node-upgrade.ts` hook 接线

- `inFlightRef`：每行在途的那次升级，续跑靠它 `joinRunning`。
- `readPlan()`：挂载后第一次拿到节点列表（有 `isSelf` 行）时读一次计划，同时把计划里的行记进 `planIdsRef` —— 这些行被回读接管时用静音 toast，结论留给汇总。
- 回读收尾（`restoreActiveRef` 归零）+ `latest` 已知 → `tryResumeBatch()`：目标版本与当前 `latest` 不符即判过期、清计划、不跑；否则把 `ownerTabId` 换成本标签页接管，`batch` 状态按 `total = 已完成 + 剩余`、`completed = 已完成` 立刻显示进度。只尝试一次。
- 用户亲手开新批量时 `openPlan` 会把待续接的旧计划标记为已处理，避免新批量跑完后又去续跑一份已被覆盖的计划。
- 批量推进期间 `setInterval` 心跳；`NodeUpgradeController` 接口零改动（O1 侧不受影响）。

### 4. 文案

新增 `nodes.upgrade.allResumed`（zh_CN「已续接上次的批量升级。」/ en_US / ja_JP），已跑 `bun run --filter @tmex/shared build:i18n`（`resources.ts` / `types.ts` 是生成产物，未手改）。

## 与需求的两处偏差（有意）

1. 需求 2 写的是 `runUpgradeBatch` 收 `skip: Set<nodeId>`；实际实现成 `groups`（已由 `planRemaining` 滤掉 done）+ `settled` 种子，效果等价且少一份重复状态。
2. 需求 7 的刷新用例里写「同一组内没开始的那台要等在途那台落定后才 POST」——这与「组内并发 3」冲突。实现按既有并发语义：同组的 `c` 立刻补上，`hub` / `self` 才要等整组收尾。测试按真实语义断言（`posted` 先是 `['c']`，`b` 落定后才出现 `hub`）。

## 文件

- 新增 `apps/fe/src/pages/settings/nodes/management/upgrade-batch-storage.ts`
- 新增 `apps/fe/src/pages/settings/nodes/management/upgrade-batch-storage.test.ts`
- 改 `apps/fe/src/pages/settings/nodes/management/upgrade-batch.ts`
- 改 `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts`
- 改 `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.test.ts`
- 改 `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`（只加 `nodes.upgrade.allResumed`）+ 生成物 `resources.ts` / `types.ts`
- `types.ts` 未改动（`Translate` / `UpgradeToasts` 放进了 `upgrade-batch.ts`）。

## 验证

- `cd apps/fe && bun test src/pages/settings/nodes/management` → **162 pass / 0 fail**（4 个文件；其中 `use-node-upgrade.test.ts` 70 pass，本轮新增 11 个用例；新文件 `upgrade-batch-storage.test.ts` 16 pass）。基线：进场时该目录 139 pass / 3 fail，那 3 个失败全在 `nodes-management.test.tsx`（O1 的勾选框 / 卸载 / 「更多」菜单，与本任务无关），期间已被 O1 修好。
- `cd apps/fe && bun test src` → **1331 pass / 0 fail**（79 个文件）。
- `cd apps/fe && bunx tsc --noEmit -p .` → **0 error**（进场时 3 个，全在他人正在改的 `nodes-management.test.tsx` 与 `packages/shared/src/auth/key-log.ts`，现已归零）。
- `bunx biome check <改动文件>` → clean（9 个文件，无待修）。
- `packages/shared` i18n 用例：2 pass / 0 fail。

## 遗留 / 需要指挥者知道的

- **复杂度门禁**：`apps/fe/.../use-node-upgrade.ts` 在本轮之前就已超标且不在 allowlist 里（1205 行 > 900、`useNodeUpgrade` 306 行 > 120）。本轮把它推到 **1261 行 / hook 433 行**，更差了。彻底的解法是把 hook 拆成独立文件（如 `use-upgrade-batch-resume.ts`），但那超出了本任务给定的文件范围，没动。请指挥者决定：拆文件，还是给这两条加 allowlist 条目。
- 多标签页保护是最弱的一层：计划被别的标签页占着（心跳新鲜）时，本页本次挂载就不再续跑，也不会反复重试。
- 未做真机实测（本任务只跑单测；生产实例严禁触碰）。刷新续跑的端到端行为建议在临时开发实例上再验一次。
