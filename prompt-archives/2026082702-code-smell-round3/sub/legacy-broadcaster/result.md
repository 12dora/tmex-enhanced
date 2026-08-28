# legacy-broadcaster 执行结果

## 改了什么

1. **拆分 `broadcastTmuxEvent` 投递策略**  
   新增 `apps/gateway/src/ws/legacy-event-delivery.ts`，抽出 `isEmptyNotification`、`deliverBell`、`deliverNotification`、`deliverGenericEvent`。  
   `LegacyFeedBroadcaster.broadcastTmuxEvent` 只负责：扩展事件 → 过滤空 notification → **编码一次** → 按 type 选择策略 → 记 metrics。  
   原函数约 70 行 / CC≈21，现约 40 行 / CC≈4。

2. **per-(deviceId, paneId) legacy observer 计数**  
   在 broadcaster 上维护：
   - `addLegacyPaneObserver` / `removeLegacyPaneObserver`（增减计数）
   - `legacyPaneObserverCount`
   - `syncLegacyPaneObservers(ws, deviceId)`（按当前 selected ∪ subscribed 做 diff）
   - `releaseLegacyPaneObservers(ws, deviceId?)`（断开时清零该 client 的计数）

   `broadcastTerminalOutput` 在计数 > 0 时直接视为有观察者；该 device 一旦被 hook 跟踪且计数为 0，**跳过 batcher.push，不再扫 clients**。`sendTerminalOutput` 仍按 client 检查 backpressure。

   为保持现有测试/未接线路径的公开行为：某 device **从未** 调用过 add/remove/sync 时，仍回退扫描 `selectedPanes`/`subscribedPanes`。一旦对该 device 做过 hook，即以计数为准。

## 文件

- `apps/gateway/src/ws/legacy-feed-broadcaster.ts`（改）
- `apps/gateway/src/ws/legacy-event-delivery.ts`（新）
- `apps/gateway/src/ws/legacy-event-delivery.test.ts`（新）
- `apps/gateway/src/ws/index.test.ts`（仅末尾新增 `describe('LegacyFeedBroadcaster pane observer counts')`）

## 修了哪些 bug

无行为 bug。这是结构拆分 + 热路径优化；公开行为保持不变（bell/notification 节流、空通知丢弃、未接线时的扫描兴趣判断）。

## 测试 / tsc

- `bun test src/ws/index.test.ts src/ws/legacy-event-delivery.test.ts`：65 pass / 0 fail（含原 L760–888 bell/notification 用例，未改）
- `bun test`（gateway 整包）：**1615 pass / 0 fail**（基线 1473；本任务新增 4 条；其余增量来自并行 agent）
- `bunx tsc --noEmit -p .`：27 errors，与基线一致，本任务文件无新增
- `bunx biome check --write`：本任务 4 个文件通过

新增回归：无人观察时不建 batch；`sync` 后 count=1 会 batch；`release`（模拟 disconnect）后 count 回到 0，即使 `selectedPanes` 仍指向该 pane 也不再 batch（证明走计数而非扫描）。

## 未做与原因（需要其它文件的一行接线）

`ws/borsh/session-state.ts` **并不** 管理 pane subscribe/unsubscribe，只做 bell/notification 节流。真正改 `selectedPanes` / `subscribedPanes` 的位点在范围外，因此 **没有改那些文件**，只在 broadcaster 上暴露 hook。

接线（`feed` 目前是 `WebSocketServer` 的 private 字段，需要先转发到 host，或把 `feed` 暴露给 handlers）：

1. `tmux-command-handlers.ts` `handleTmuxSelect` / `handleFocusPane`，在赋值 `selectedPanes` 之后：

   ```ts
   host.syncLegacyPaneObservers(ws, deviceId);
   ```

2. 同文件 `handleSubscribePanes`，在写入/删除 `subscribedPanes` 之后：同一行。

3. `ws/index.ts` `handleClose`，在 `delete selectedPanes/subscribedPanes` **之前**：

   ```ts
   this.feed.releaseLegacyPaneObservers(ws);
   ```

4. `device-connection-registry.ts` `handleDeviceDisconnect`，在 delete 之前：

   ```ts
   this.host.releaseLegacyPaneObservers(ws, deviceId);
   ```

5. 同文件 `finalizeReconnectFailure`，清空 `entry.clients` 之前：

   ```ts
   for (const client of entry.clients) this.host.releaseLegacyPaneObservers(client, deviceId);
   ```

未接线前，生产路径仍走扫描（与改前一致）；接上后该 device 的零计数会完全跳过 batch。同一 client 对同一 pane 既 selected 又 subscribed 只计 1（集合并集）。
