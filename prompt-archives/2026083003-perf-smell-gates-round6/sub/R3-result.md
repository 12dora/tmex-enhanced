# R3 结果 — Gateway watch 共享 pane capture、no-read upsert、REST N+1

## 做了什么

### 1. Watch：按 (deviceId, paneId) 分组，每 tick 只 capture 一次
`WatchRuleScheduler` 不再给每条规则单独 `setInterval`，而是按 pane 分组，timer 间隔取组内 `effectiveIntervalSeconds` 最小值。每个 polling tick 只回调一次 `(deviceId, paneId)`；`WatchService.tickPane` 对该 pane `capturePaneText` 一次，再把快照交给所有 **到期** 规则。长 interval 规则用 accrued ms 跳过中间 tick（例如 5s 组里的 30s 规则第 6 拍才评）。

`tickRule(ruleId)` 仍走单规则 capture，供测试/强制 tick，语义不变。生产路径只走 pane timer。

### 2. `writeWatchRuleState`：upsert 不再回读
抽出 `writeWatchRuleState`（INSERT … ON CONFLICT，无 SELECT）。`WatchService.upsertState` 改为 `void` 并指向它。`upsertWatchRuleState` 仍 write + SELECT，给 `agent-watch` / API 测试等需要返回行的调用方。

### 3. REST 列表去 N+1
- `listDevicesWithRuntimeStatus()`：devices LEFT JOIN `device_runtime_status`，缺行用默认（`lastSeenAt/lastError/lastErrorType = null`，`tmuxAvailable = false`）。
- `getDeviceTreeOrders(ids)`：`WHERE device_id IN (...)` 一次取回，缺行 `{ windows: [], panes: {} }`。
- `GET /api/devices` 与 reorder 响应用 join；`GET /api/tmux/tree` 用 `getAllDevices` + batched tree-order。单设备 GET 仍走 `getDeviceRuntimeStatus`。
- 列表路径额外调用一次 `getAllDevices().length === 0` 短接，是为了兼容 `index.routing.test.ts` 对 `getAllDevices` 的 spy（该文件不在本任务 scope）。非空时实际 2 次 SELECT，仍 ≤ 3。

## 文件

- `apps/gateway/src/watch/scheduler.ts` / `scheduler.test.ts`
- `apps/gateway/src/watch/service.ts` / `service.test.ts`
- `apps/gateway/src/db/watch.ts` / `watch-upsert.test.ts`（新）
- `apps/gateway/src/db/devices.ts` / `devices.test.ts`（新）
- `apps/gateway/src/api/device-routes.ts` / `device-routes.test.ts`（新）
- `apps/gateway/src/api/tmux-tree.ts` / `tmux-tree.test.ts`

## 测量

| 场景 | 之前 | 之后 |
| --- | --- | --- |
| 100 规则同一 pane，每 tick capture | 100 | **1**（测试断言） |
| 100 规则同一 pane，timer 数 | 100 | **1** |
| `upsertWatchRuleState` 5000 次（in-memory SQLite） | 10.47 ms（write+SELECT） | **6.04 ms**（只 write），约 1.74× |
| 100 设备 list+status + list+tree-order（微基准，200 round） | 202 queries / 0.197 ms | **3 queries / 0.151 ms** |
| `GET /api/devices` 100 设备（spy+prepare 计数） | 203 SELECT | **≤ 3**（实为 getAllDevices + left join） |
| `GET /api/tmux/tree` 100 设备 | N+1 `getDeviceTreeOrder` | **0** 次单条 order 查询，IN 一批 |

## 校验

- `cd apps/gateway && bun test src/watch src/api src/db`：**536 pass / 0 fail**（55 files）
- `bunx tsc --noEmit -p .`：**21**（= baseline，本任务文件 0 新增）
- `bunx biome check` 上述 12 个文件：**clean**

## 风险 / 未做

- pane 级 capture 失败会作用到该 tick 所有到期规则（pane gone 会删组内到期规则，不再等各自 timer）。比原先“谁先 tick 谁先删”更一致。
- 组内最短 interval 变化会重臂 timer（清旧 interval、开新 interval），与“最短间隔决定 capture 频率”一致，但会重置当前等待窗口。
- `GET /api/devices` 非空时仍先 `getAllDevices` 再 join，多 1 次设备表扫描；若以后能改 routing spy，可收成单条 left join。
- 未改 `tickRule` 热路径：单规则强制 tick 仍各自 capture，这是有意保留的测试 API。
