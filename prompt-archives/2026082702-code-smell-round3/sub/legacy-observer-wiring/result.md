# legacy-observer-wiring 结果

## 改了什么

把 `LegacyFeedBroadcaster` 已有的 per-(deviceId, paneId) observer 计数接到 select / subscribe / close / disconnect 路径。未接线时，设备只要从没调过 `sync`/`add`，`broadcastTerminalOutput` 仍会扫全部 client。接上之后该设备进入 tracked 集合，只看计数：>0 才 `batcher.push`。

接线点：

1. **`TmuxCommandHost.syncLegacyPaneObservers`**（`feed` 是 `WebSocketServer` 的 private 字段，由 host 转发）
   - `handleTmuxSelect` / `handleFocusPane`：写完 `selectedPanes` 后 `sync`
   - `handleSubscribePanes`：写入或删除 `subscribedPanes` 后 `sync`（空列表也 sync，把旧订阅 diff 掉）
2. **`WebSocketServer.handleClose`**：在删除 `selectedPanes` / `subscribedPanes` **之前** `this.feed.releaseLegacyPaneObservers(ws)`
3. **`DeviceConnectionRegistryHost.releaseLegacyPaneObservers`**
   - `handleDeviceDisconnect`：删除 selected/subscribed 之前按 `(ws, deviceId)` release
   - `finalizeReconnectFailure`：清空 `entry.clients` 之前对每个 client release

`WebSocketServer` 实现两个 host 方法，转发给 `this.feed`。

broadcaster API 未改，不需要动 `legacy-feed-broadcaster.ts`。

## 文件

- `apps/gateway/src/ws/tmux-command-handlers.ts` — host 加 `syncLegacyPaneObservers`，三处 handler 调用
- `apps/gateway/src/ws/index.ts` — `handleClose` release；转发 `sync` / `release`
- `apps/gateway/src/ws/device-connection-registry.ts` — host 加 `releaseLegacyPaneObservers`；disconnect / reconnect-fail 调用
- `apps/gateway/src/ws/legacy-observer-wiring.test.ts`（新）

未改：`ws/index.test.ts`、`legacy-feed-broadcaster.ts`。

## 修的问题

select / subscribe 之后计数不更新，close / disconnect 后计数残留；tracked 设备会继续给已经没人看的 pane 建 batch。

## 测试 / tsc / biome

接线前：新文件 8 fail，原因是 select 后 `legacyPaneObserverCount` 仍为 0。

接线后：

```
cd apps/gateway && bun test src/ws/legacy-observer-wiring.test.ts
# 8 pass / 0 fail

cd apps/gateway && bun test src/ws
# 187 pass / 0 fail

cd apps/gateway && bun test
# 1826 pass / 0 fail（基线 1473；其它 agent 增测，本包全绿）

bunx tsc --noEmit -p .
# 25 个既有错误（基线 27，无本任务文件；其它 agent 可能消掉 2 个）
# 本任务文件 0 新增

bunx biome check --write <上述 4 个文件>
# 无问题
```

覆盖：

- select → count 1 → output batched
- focus pane → 同上
- unsubscribe / 改选其它 pane → count 0 → 不再 batch
- close socket → count 0
- device disconnect → count 0
- 两 client 同 pane → count 2 → 关一个 → 1
- `finalizeReconnectFailure` → count 0

## 留下的

- `device-connection-registry.test.ts` 的 mock host 没有 `releaseLegacyPaneObservers`（范围外，不能改）。生产路径用 `?.` 调用，避免那些 test double 运行时崩。后续给 mock 补空实现即可去掉 `?.`。
- broadcaster 无需改 API。
