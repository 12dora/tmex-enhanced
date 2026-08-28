# review2-backend-fixes

## 背景

Round 2 后端 review 确认四处缺陷：输出门溢出发的 canonical `SourceGap` 被 legacy decoder 忽略；`finalizeReconnectFailure` 后手动重连不重新挂 observer；通知节流 TTL prune 在调大窗口时提前放行；LLM provider create/update 在模型缓存刷新前广播，其它客户端会缓存空列表。

TDD：先写回归（RED），再改生产代码（GREEN）。

## 改动

### 1. 输出门溢出：legacy 客户端能解码并 rebase

输出门只服务 legacy 客户端（`legacy-feed-broadcaster` 跳过 `canonicalClients`）。wire 上没有独立的 pane-rebase kind；客户端已经处理的恢复通道是 `rebase-required` → `dispatchPaneRebase(..., 'resource_exhausted')`。canonical `SourceGap(resource_exhausted, Stream)` 就是这条信号，只是 `transport-message-decoder` 原先没有 `KIND_CANONICAL_EVENT` 分支。

- `session-state.ts`：仍发既有 `SourceGap`（输出门路径本身就是 legacy；没有第二套 wire 帧）。
- `transport-message-decoder.ts`（测试贯通所必需，见下方「范围外」）：登记 `KIND_CANONICAL_EVENT`，`SourceGap` 映射为 `{ type: 'rebase-required', reason }`；Pane scope 带上 `deviceId`/`paneId`。其它 canonical 事件解码后不 emit（与原先忽略行为一致）。
- 回归：gateway 溢出帧经 `decodeGatewayTransportMessage` 得到 `rebase-required` / `resource_exhausted`。

### 2. 手动重连后重新挂 legacy observer

`handleDeviceConnect` 在把 client 加入 entry、补 `selectedPanes` 之后调用 `host.syncLegacyPaneObservers(ws, deviceId)`。`finalizeReconnectFailure` 释放 observer 但保留 `subscribedPanes`；重连后计数从订阅集恢复，`broadcastTerminalOutput` 再进 batcher。

### 3. 通知节流调大窗口不再被 prune 提前放行

`pruneNotificationThrottles` 跳过正在检查的 key；拒绝时也把 `throttleSeconds` 更新为本次值。10s → 60s、31s 仍拒绝。

### 4. LLM 广播移到模型缓存刷新之后

create：`await refreshModelsCache` 后再 `broadcastSettingsUpdate('llm')`。update：可选 refresh 完成后再广播一次。每个请求一条广播；延迟 fetch 期间 list 仍是旧/空列表，广播时已是最终 models。

## 文件

生产：

- `apps/gateway/src/ws/borsh/session-state.ts`
- `apps/gateway/src/ws/device-connection-registry.ts`
- `apps/gateway/src/api/llm.ts`
- `packages/ws-client/src/transport-message-decoder.ts`（见「范围外」）

测试：

- `apps/gateway/src/ws/borsh/session-state.test.ts`
- `apps/gateway/src/ws/legacy-observer-wiring.test.ts`
- `apps/gateway/src/api/llm.test.ts`
- `packages/ws-client/src/transport-message-decoder.test.ts`

未改 `ws/index.test.ts`（append only，本任务不需要）。

## 修复的 bug

1. **溢出后 legacy 终端永久缺输出**：溢出帧现在能被 `decodeGatewayTransportMessage` 解成 `rebase-required`，stores 路由到 `dispatchPaneRebase(..., 'resource_exhausted')`。
2. **重连失败后手动重连丢输出**：subscribe → finalizeReconnectFailure → connect 后 observer 计数恢复，输出再投递。
3. **节流从 10s 调到 60s 在 31s 放行**：prune 不再删正在检查的 key；31s 仍拒绝。
4. **LLM 广播抢跑**：延迟 models fetch 时广播发生在 list 已能返回最终 models 之后，且每请求一次。

## 测试 / tsc

TDD：四条回归先红后绿。

- 相关：`bun test src/ws src/api/llm*` → **219 pass / 0 fail**
- `packages/ws-client bun test` → **100 pass / 0 fail**
- 全量 gateway `bun test` → **1873 pass / 0 fail**（基线 1826；增量来自本任务 + 并行 agent）
- `bunx tsc --noEmit -p .`（gateway）→ **25 errors**，与基线一致，无落入本任务文件
- `packages/ws-client tsc` → **0 errors**
- `bunx biome check --write <scoped files>` → clean

## 未做 / 原因

- **未发明新的 legacy rebase kind**：`kind.ts` 不在范围；客户端已有的恢复事件是 `rebase-required`，对应 wire 就是 canonical `SourceGap`。输出门只打 legacy，因此继续发 `SourceGap`，同时让 decoder 认识它。
- **未按 session 分发两套帧**：`SessionStateStore` 看不到 `canonicalSessions`；输出门本身不会给 canonical client 用。
- **decoder 只接线 `SourceGap`**：`SubscriptionApplied` / `PaneData` 等仍不 emit。完整 canonical websocket 解码不在本次范围。
- **`transport-message-decoder.ts` 原不在 Scope**：任务要求回归必须走 `decodeGatewayTransportMessage` 得到 rebase/gap 事件，而 decoder 原先对 `KIND_CANONICAL_EVENT` 直接忽略。不改 decoder 则该测试无法变绿。这是原 review「让 legacy transport 解码该 gap」的落地。
- **未改 `ws/index.test.ts`**：observer 回归已写在指定的 `legacy-observer-wiring.test.ts`。
