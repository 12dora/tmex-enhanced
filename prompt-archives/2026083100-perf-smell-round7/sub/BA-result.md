# Task BA 结果：agent persistence batching + ws-hub subscription leak

## 证据核对

两条 exploration 主张均成立，已对照源码后实施。

### 1. step 边界逐条 SQLite 写入

- `apps/gateway/src/agent/run.ts`：`StepMessagePersister` 回调对每条 message 调 `appendAgentMessage`，并立刻 `broadcast(AGENT_EVENT_MESSAGE_PERSISTED)`。
- `apps/gateway/src/agent/step-persister.ts`：`persistNewMessages` 对 suffix 做 per-message 循环。
- `apps/gateway/src/db/agent.ts`：`appendAgentMessage` 每次 `insert().returning().get()`，seq 用 `max(seq)+1` 子查询。bun:sqlite 同步，tool-heavy turn 会连续阻塞 event loop。

### 2. 不存在 session 的订阅泄漏

- `ws-hub.ts`：`subscribe` 先把 client 写入 `Map<sessionId, Set>`，再 `await syncProvider`。
- `sync === null` 直接 `return`，不删除条目。
- `catch` 只 `console.error`，同样不删除。
- `removeClient` 遍历整个 Map，垃圾条目会让断开扫描变慢。

## 改动

仅触及声明范围：`apps/gateway/src/agent/**`、`apps/gateway/src/db/agent.ts` 及其测试。

### 批量落库

- 新增 `appendAgentMessages(sessionId, messages)`：空数组直接 `[]`；否则 **一条事务** 内读一次 `max(seq)`、连续分配 seq、一次 `insert().values(rows).returning().all()`。
- `appendAgentMessage` 改为单元素包装，对外 API 不变（supervisor / run-finish / 既有调用方仍走单条）。
- `StepMessagePersister` 回调改为整批 `readonly T[]`；`persist` 成功后才推进 `persistedResponseCount`（事务失败可重试同一批，避免半写入后重复计数）。
- `AgentRun.persistAndBroadcast`：事务提交后才按序广播 `MESSAGE_PERSISTED`。step 边界与 `persistDrainedQueue` 都走这条路径。

### 订阅泄漏

- 先校验 `sessionId` 长度（`1..128`）和单客户端订阅上限（`64`，已订阅的 session 可重新 sync）。
- 仍先登记再 sync（保留「等待 sync 期间退订则不回发」）。
- `null` / 异常路径调用 `unsubscribe` 回滚；空 Set 从 Map 删除。

导出常量：`AGENT_WS_MAX_SESSION_ID_LENGTH`、`AGENT_WS_MAX_SUBSCRIPTIONS_PER_CLIENT`。

## 设计决策

1. **单条 API 复用批量实现**：seq 分配只保留一条路径，避免子查询与 `max()+assign` 两套语义。SQLite 写锁串行化事务，跨 session 互不抢 seq；同 session 的单条/批量交错由事务顺序决定。
2. **先登记再回滚，而不是先 sync 再登记**：否则 `unsubscribe` 发生在 pending sync 期间会变成空操作，sync 成功后仍会写入订阅并回发。任务允许 “or roll back”。
3. **`syncProvider === null` 视为 session 不存在**：与 `dbSyncProvider` / supervisor 注入的 provider 一致。原先部分测试用 `() => null` 表示「不发 sync 但要订阅」，已改为返回 `stubSync` 再清空 sent。
4. **上限 64 / 长度 128**：生产 sessionId 是 UUID（36）。拒绝空串和超长串，避免 Map 被垃圾 key 撑爆。已订阅 id 在满额后仍允许 refresh sync。
5. **排队用户消息也批量写**：同在 `run.ts`，同一「提交后再广播」语义；不是 step 边界，但是同一类同步写放大。

## 风险

- **语义变化**：自定义 `syncProvider` 返回 `null` 现在会取消订阅。仓库内生产路径（缺 session → null）符合预期。
- **并发超限**：两个 subscribe 同时通过 cap 检查，可能短暂超过 64。best-effort，可接受。
- **`returning().all()`**：bun-sqlite + drizzle 多行 insert 已由测试覆盖（顺序、条数）。若驱动只返回最后一行，断言会失败；当前通过。
- **崩溃恢复**：step 内从「可能写了一半」变为「整批提交或整批回滚」。进程在广播前崩溃时，DB 已有记录、客户端未收到 persisted 事件，重连走 sync/`lastMessageSeq`，与原先单条写入后崩溃的窗口同类。
- **全量测试中 `ws/canonical/*` 失败**：不在本任务范围，见下方测试计数。未改那些文件。

## 测试

新增/扩展：

- `appendAgentMessages`：空批 no-op、连续 seq + 顺序、与单条交错、跨 session 独立 seq（`agent-watch.test.ts`）。
- `StepMessagePersister`：suffix 整批一次交给 persist；空/等长 no-op。
- `AgentWsHub`：null / 缺 session / 异常均不留条目；cap；满额后已订阅可 re-sync；过长 sessionId 拒绝。

范围内（改动直接相关的 7 个文件）：

```
bun test src/db/agent-watch.test.ts src/db/agent-message-window.test.ts \
  src/agent/step-persister.test.ts src/agent/ws-hub.test.ts \
  src/agent/run.test.ts src/agent/supervisor.test.ts src/agent/run-finish.test.ts
→ 102 pass / 0 fail
```

全量 `cd apps/gateway && bun test`：

- 任务基线：2800 pass / 0 fail。
- 本次：2814 pass / 8 fail / 1 error（2822 tests / 291 files）。
- 8 fail + 1 error 全部在 `src/ws/canonical/*`（`canonical-feed-session`、`transaction-sender`、`pane-stream`、`encoded-size`），超出 BA 范围，应为并行 agent 改动。范围内文件无失败。

`bunx tsc --noEmit -p .`（apps/gateway）：

- 范围内文件 **0** 条错误。
- 全量 25 条 `error TS`，均不在 `src/db/agent.ts` / `src/agent/**`。任务写 21 条既有；多出的来自并行改动（ws/canonical、push、tmux 等）。

`bunx biome check`（7 个改动文件）：通过。

复杂度：`appendAgentMessages` CC 2 / 32 行；`subscribe` CC 7 / 23 行；`runOnce` CC 2 / 56 行；相关文件均 < 900 行。未改 allowlist。
