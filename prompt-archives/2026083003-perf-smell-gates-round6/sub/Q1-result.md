# Q1 结果 — stores：非活跃 agent 会话历史的有界保留

## 结论

Y1 报告第 1 条属实，已在代码中复核：

- `loadSessionsRequest()` 只把消失的会话从 `sessions` 里摘掉（`mergeFetchedSessions`），`messages` / `historyLoaded` / `inProgress` / `queued` / `pendingConfirmations` 全部留在内存；只有 `deleteSession()` 走 `pruneSessionState` 做完整清理。
- `setActiveSession()` 只对上一个会话退订，历史一律不清；打开过的每个会话的完整历史长期驻留。

两项都已修复，并补齐真实 store 上的回归测试与前后测量。

## 改动

### 1. 别端删除的会话走与本端删除相同的清理

`packages/stores/src/agent-session-crud-actions.ts`

- `withoutKey(record, key)` → `dropKeys(record, keys)`，`pruneSessionState(prev, sessionIds)` 改成批量（`deleteSession` 传单元素数组，行为不变）。
- 新增 `forgetSessions(sessionIds)`：`clearSessionRuntime` + `pruneSessionState`（messages / historyLoaded / inProgress / pendingConfirmations / queued / sessions / sessionOrder）。
- `loadSessionsRequest()` 在写回列表后对比前后 `sessions`，对消失的会话调用 `forgetSessions`。
- 订阅的处理：store 里只有「选中会话」会被 `subscribe`（`setActiveSession` 与 `ensureInitialized`），退订仍由既有的 `clearActiveSession` / `pruneMissingActiveSessions` 负责；`forgetSessions` 不再重复退订，避免对同一 id 发两次 unsubscribe（`agent-node-state.test.ts` 断言的正是「只退订一次」）。

### 2. 非活跃历史的保留预算（LRU + 体积双预算）

新增 `packages/stores/src/agent-history-budget.ts`（71 行）：

- `selectEvictableHistories(state, recent)`：纯函数，返回应清空历史的会话 id。
- 固定保留（pin）：`activeSessionIdByNode` 里各 node 的当前会话；`status === 'running' | 'waiting_confirmation'`；`inProgress` 有任一流式段（注意 `TURN_FINISHED` 会写入空 `inProgress`，所以按段数判定而不是按 key 存在判定）；`queued` 或 `pendingConfirmations` 非空。
- 预算：`HISTORY_SESSION_BUDGET = 8` 份、`HISTORY_SIZE_BUDGET = 4 MiB`（消息 `content` 序列化后的字符数），先到先触发；按 `recent`（最近激活在前）排序，超预算的一律淘汰。
- 体积按消息数组引用做 `WeakMap` 缓存：合并消息会换新数组，未变的会话不重复 `JSON.stringify`；且淘汰一旦开始，后面的会话直接淘汰不再量体积——每次切会话最多量 8 份。

`agent-session-crud-actions.ts` 侧：

- 闭包内维护 `recentSessions`（最近激活在前），`setActiveSession` 命中真实会话时置顶；会话被淘汰或被删除时从表里摘掉，避免这个数组本身无界增长。
- `setActiveSession` 末尾调用 `evictHistories()`：对被淘汰的会话先 `history.clearSession(id)` 作废在途请求令牌（否则在途响应会把「半截历史 + `historyLoaded=true`」写回来，重开时按 `afterSeq` 增量拉只会补回一截），再删掉 `messages` / `historyLoaded` 两个 key。
- 重开被淘汰的会话时 `historyLoaded[id]` 为空 → `loadHistory` 的 `afterSeq = -1` → 全量重拉，路径与首次打开完全一致。

侧栏与面板不受影响：`packages/panels/src/agent/use-agent-tab-state.ts` 只读「本 node 当前会话」的 `messages`（该会话恒为 pinned），侧栏读的是 `sessions` / `sessionOrder` 元数据，淘汰不碰这两处。

## 测量（真实 store，200 会话 × 1 KiB 历史）

bench 脚本：`/private/tmp/claude-501/.../scratchpad/history-retention-bench.ts`（复现 Y1 的场景，用真实 `createAgentStore` + 假 transport）。

| 场景 | 之前（Y1 实测同场景） | 之后 |
|---|---:|---:|
| 依次打开 200 个会话后保留的历史数组 | 200 | 9（8 份预算 + 当前会话） |
| 对应保留字节（`JSON.stringify(messages)`） | 228,400 | 10,341（−95.5%） |
| 列表刷新为空后保留的历史数组 | 200 | 0 |
| 列表刷新为空后残留的 sessions / historyLoaded / inProgress / queued | 均非空 | 均为 0 |

代价：200 次切换的同步耗时合计 11–18 ms（约 0.06–0.09 ms/次，含 persist 写盘门控），淘汰逻辑本身可忽略；被淘汰的会话重开时多一次全量历史请求。

## 测试

新增 `packages/stores/src/agent-history-budget.test.ts`（6 个用例）：

- 真实 store：打开 200 个会话后 `messages` 数组数 ≤ 预算 + 1，且 `sessions`/`sessionOrder` 仍是 200（侧栏不受影响）。
- 真实 store：被淘汰的会话重开只多拉一次历史，且 URL 不带 `afterSeq`（全量重拉）。
- 真实 store：列表刷新为空后 sessions / messages / historyLoaded / inProgress / queued / pendingConfirmations 全空，选中态归零。
- 纯函数：当前会话（多 node）、running、queued 三类不被淘汰；按最近激活顺序淘汰最久未用；体积预算先于份数预算触发。

## 验证数字

- `cd packages/stores && bun test`：**333 pass / 0 fail**（基线 327/0，新增 6 个用例）。
- `bunx tsc --noEmit -p .`：**1 error**，即基线里既有的 `src/host-services.test.ts(93,23)`，未新增。
- `bunx biome check src/agent-history-budget.ts src/agent-history-budget.test.ts src/agent-session-crud-actions.ts`：clean。
- 附带跑了 `packages/panels`（未改动）：616 pass / 0 fail。

## 文件

- 改：`packages/stores/src/agent-session-crud-actions.ts`（+60 / −13）
- 新增：`packages/stores/src/agent-history-budget.ts`（71 行）
- 新增：`packages/stores/src/agent-history-budget.test.ts`（242 行，测试）

源码净增约 +118 行，高于 Y1 估的 +12——那个估值只覆盖了「删掉时清理」，没有包含 pin 判定、体积预算与 LRU 顺序维护。`agent-history-sync.ts`、`agent-state.ts`、`agent-session-message-actions.ts` 未改动（不需要）。

## 风险与遗留

- 预算是「非活跃会话 8 份 / 4 MiB」的常量，没有做成可配置项（本轮不引入无用抽象）。极端场景：8 个非活跃会话各自 3 MiB 时，实际只留 1 份，切回去要重拉——符合体积优先的取舍。
- 淘汰只清 `messages` / `historyLoaded`；被淘汰会话残留的空 `inProgress` 记录（`TURN_FINISHED` 写入的空对象）不清，量级可忽略，且清掉会影响 `agent-thread` 的 liveTail 语义。会话真正消失时由 `forgetSessions` 全清。
- 淘汰只在 `setActiveSession` 触发（含取消选中）。若用户长期停在同一个会话不切换，历史不会被淘汰——那份历史正是当前视图需要的，符合预期。
