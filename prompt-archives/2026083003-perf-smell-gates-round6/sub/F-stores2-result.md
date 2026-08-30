# F-stores2：历史预算淘汰只在 setActiveSession 触发（review-fe2 发现 1）

## 问题
`evictHistories()` 只在 `setActiveSession` 末尾跑一次。首次拉历史是异步的，激活时 `state.messages[id]` 还不存在，
该会话不进入淘汰候选；等响应回来时没有任何一处再检查预算，于是多个延迟返回的首拉会把历史全部写回，
份数/体积预算被绕过（复现：20 个会话全部激活后再放行响应 ⇒ 保留 20 份）。
退订后迟到的事件调度的补拉同理，会把已淘汰会话的历史重新写回并一直留着。

## 改动
- `packages/stores/src/agent-history-sync.ts`：`AgentHistorySyncDeps` 新增可选 `onWriteback`，在 `loadHistory`
  成功写回 store 之后调用（token 校验失败提前 return 的路径不触发）。
- `packages/stores/src/agent-session-crud-actions.ts`：`AgentSessionCrudActions` 增加 `evictHistories`，把已有的
  淘汰函数暴露给组合根（逻辑本身未改）。
- `packages/stores/src/agent-session-actions.ts`：组合根类型同步带上 `evictHistories`。
- `packages/stores/src/agent.ts`：`createAgentHistorySync` 接 `onWriteback: () => evictHistories()`，会话动作创建后
  把真正的实现回填给该可变引用；`evictHistories` 从展开进 store 的动作里解构掉，不进 `AgentState`。

效果：任何一次历史写回（首拉、去抖增量补拉、重连补史）之后都会跑一遍预算淘汰，延迟返回的首拉最多短暂占用，
落地后立刻被淘汰回预算内。被淘汰会话的在途请求仍由 `history.clearSession()` 作废令牌（`evictHistories` 里原有逻辑），
其响应不会写回；`clearSession` 同时清掉 `reloadPending`，被淘汰的会话也不会自动补跑重拉。

busy→idle：agent 事件只对已订阅（即当前激活）会话下发，忙碌会话必然同时被"当前会话"钉住；`handleTurnFinished`
若有新消息会 `scheduleFetch` ⇒ 写回 ⇒ 触发淘汰，没有新消息时该会话仍是激活态（钉住），等它被切走时
`setActiveSession` 里的淘汰会处理。因此没有为状态跃迁单独加钩子，避免多余接线。

## 测试
`agent-history-budget.test.ts` 新增「首次历史响应集中延迟返回时，写回后仍不超预算」：harness 加 `deferHistory`
选项挂起所有 `/messages` 响应与 `releaseHistory()`，先激活 20 个会话、一份历史都不放行，再统一放行。
修复前保留 20 份（断言 `<= 9` 失败），修复后保留 ≤ `HISTORY_SESSION_BUDGET + 1` 且含最后激活的 `s19`，
`sessions` 元数据 20 条不受影响。

## 验证
- `cd packages/stores && bun test` ⇒ 334 pass / 0 fail（基线 333，+1 新增）。
- `bunx tsc --noEmit -p .` ⇒ 1 error（`src/host-services.test.ts(93,23)`，既有基线，与本次无关）。
- `bunx biome check` 改动的 5 个文件 ⇒ 无问题。

## 风险
`evictHistories` 现在会在每次历史写回时跑一遍，开销为遍历保留中的（≤ 预算份数）消息数组，体积按数组引用走
WeakMap 缓存，仅新写回的那份重新序列化，可忽略。
