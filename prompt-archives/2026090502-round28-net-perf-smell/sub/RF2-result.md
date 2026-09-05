# RF2 结果：前端审查 4 项全部修复

## 1. P1 拆分改变 effect 顺序（`use-node-upgrade-controller.ts`）
- `useUpgradeBatchPlan` 从 `useUpgradeBatch` 里提出来单独导出（无 effect，内部算 `entryNodeId`），控制器改为 **runtime → plan → restore → batch** 的调用次序，恢复「先登记回读、回读收尾后再续跑」。`UpgradeBatchControl` 不再返回 `readPlan`，`useUpgradeBatch` 改收 `plan`。
- 新增 `use-node-upgrade-controller.test.ts`：latest 先回、节点列表后到的时序下，仍在升级的节点**零 POST**、只有回读 GET 接管；另补一条「计划里的节点已空闲 → 续跑照常发 POST」。把两个 hook 调回旧顺序后第一条用例立刻失败（已实测两次）。
- 测试用自建迷你 hooks 运行时（bun 无 DOM，跑不起 react-dom），`react` / `react-i18next` 的 mock 在 harness 未激活时转发真实实现。**坑**：`mock.module` 连已有 namespace 一起替换，转发目标必须在打桩前抓成 const，否则自调自死循环——踩过一次，表现为 `bun test src/` 100% CPU 挂死。

## 2. P1 缓存在 render 与 effect 之间落地（`use-page-module.ts`）
- effect 主体抽成导出的 `syncPageModuleState`：命中缓存时用函数式 `setState` 校准到 ready，已对上同一模块则返回原对象（React 跳过重渲染）。
- 三条回归用例：取消的加载在重新挂载后落地 → effect 校准为 ready；状态已 ready → 零重渲染；未命中缓存 → 照常发请求并返回取消函数。

## 3. P1 慢速推包被误判超时（`use-node-upgrade.ts`）
- 改为**按阶段的等待预算**（对齐后端 `REMOTE_UPGRADE_TIMEOUTS`）：download 10 min、push 15 min（各 +1 min 富余让后端先报结论）、start 沿用 6 min 基线（后端 60 s 之后还有重启与版本回传）；不报 progress 的旧入口维持 6 min；保留「有新进展就重新计时」与 30 min 硬上限，deadline 只前移不回退。
- 预算与进度记账拆到新文件 `upgrade-budget.ts`（`use-node-upgrade.ts` 因此从 883 行回到 821 行，复杂度门禁通过，**未改 allowlist**）。
- 测试：新增「push 阶段字节 8 分钟不动 → 继续等、最终 done」「一直停着 → 15~16 min 才 timeout」「旧入口无 progress → 6 min 基线」；原「每轮涨字节」用例保留。

## 4. P2 `readCodedError` 丢失 JSON `null` 兜底（`json-mutation.ts`）
- 读 `.error` 前加 `typeof body === 'object' && body !== null` 守卫，否则走原 fallback。
- 测试：HTTP 502 + `null` 回 fallback 三元组；裸标量同理；带 `pick` 的端点形态断言抛出类型（`FileApiError`）、code 与 status 502。

## 验收
`bun test src/`（apps/fe）2413 pass / 0 fail；`bun test`（packages/api-client）229 pass / 0 fail；`bunx tsc --noEmit -p apps/fe` 与 `-p packages/api-client` 无错；改动文件 `bunx biome check` 干净；`bun scripts/complexity/gate.ts` ok（1573 files）。未动 git 状态、未跑 e2e、未碰 RF1 的 tunnel / system / forwarder。
