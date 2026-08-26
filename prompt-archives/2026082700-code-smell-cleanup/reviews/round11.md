## 1. `pane_lost` 仍可能让 stale run 重新消费队列

**严重度：中；置信度：高**

[`supervisor.ts:388`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/supervisor.ts:388) 仅从数据库状态为 `running` 或 `waiting_confirmation` 的会话中调用 `suppressResume()`。但 `AgentRun` 会先把状态更新为 `idle`/`error`，随后才在 [`run.ts:139`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/run.ts:139) 异步释放资源；这段时间 run 仍存在于 `activeRuns`。

因此以下顺序仍会复活排队消息：

1. run 已置 `idle`，但卡在资源释放中；
2. 此时提交的新消息因 run 仍 active 而进入队列；
3. `stop()` 超时并在 `start()` 后保留 stale entry；
4. 设备触发 `pane_lost`，但该会话因状态为 `idle` 未被选中，无法设置 `resumeSuppressed`；
5. run 最终 settle，执行 [`supervisor.ts:508`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/supervisor.ts:508)；[`resumeSessionIfNeeded()`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/supervisor.ts:518) 看到队列非空后启动新 run。

这会重新引入“设备已丢失但 stale run 复活队列”的问题。

验证方式：让测试 run 先将 session 置为 `idle`，再阻塞其 `execute()` 完成；入队消息后执行 `stop()`、`start()`、`stopSessionsForDevice(..., 'pane_lost')`，最后解除阻塞。当前实现的 `createRunCount` 会从 1 变为 2。

## 2. fatal-streak 测试没有覆盖 `AgentRun` 的实际释放路径

**严重度：低；置信度：高**

[`run-resource-scope.test.ts:291`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/run-resource-scope.test.ts:291) 虽名为“fatal streak 只释放本 run 引用”，但测试仅直接调用 [`releaseHeldPaneEmulator()`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/run-resource-scope.test.ts:327)，没有实例化 `AgentRun`、触发连续两次工具失败，也没有经过 [`run.ts:385`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/run.ts:385) 和最终资源清理。

现有 `run.test.ts` 的 runtime 又不实现 `subscribe()`，因此不会获取 emulator。即使 `recordTerminalFailure()` 仍直接销毁共享实例，或者忘记在 finally 前将 `this.emulator` 置空导致重复释放，这个新增测试仍会通过。

验证方式：临时将 [`run.ts:394`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/run.ts:394) 改回直接 `destroyPaneEmulator()`；该“fatal streak”测试仍然保持通过。