# TASK F 结果：清掉本轮可结构拆分的 complexity-gate 违规

纯机械搬运，行为不变。未改 allowlist。门禁 18 → 9，本任务名下条目全部从违规列表消失。

## 清掉的条目

### 1. `apps/gateway/src/ws/index.ts` 941 → 829 行

- 新文件 `apps/gateway/src/ws/tmux-command-facade.ts`：基类 `WebSocketServerTmuxFacade`，收走全部 `tmuxCommands.*` 一行委托（含 `handleTmux*` / term / viewport / reorder / subscribe / history / split / focus / `onStateSnapshotInstalled`）。
- `WebSocketServer extends WebSocketServerTmuxFacade`，构造函数补 `super()`。签名、调用点、`handleOpen` 的 connect 日志均未改。
- 主题 / overlay / feed 方法留在子类。

### 2. `isQuietTerminalOutputSnapshot` CC 23 → ~2

- 计数器改成字段列表 + `allZero()` 循环；队列空闲条件同样走 `allZero`。
- 语义不变：所有计数器为 0 **且** 所有队列为空才 quiet；limit / terminations / carriers 仍不参与。窗口复位仍在 `takeIfDue` 路径，谓词不碰。
- 既有 quiet-suppression 测试通过，并补了直接针对谓词的用例。

### 3. `direct-carrier-controller.ts` 1200 → 1113 行（≤ allowlist 1118），`publish` CC ~3

- `buildDirectDiagnostics` / `sameDirectDiagnostics`（RTT 仍按 5 ms 量化，`sameDiagnosticsForPublish` 作别名）以及 ICE 快照拼装进 `direct-diagnostics.ts`。
- 文件底部的 `DirectAuthorizeError` / `DirectPrimaryWaitError` / `throwIfPrimaryWait` 原样搬到 `direct-carrier-errors.ts`；`buildIceServers` 搬到 `direct-ice-servers.ts` 并由 controller 再导出，调用方零改动。

### 4. `createTmuxStore` 333 → 文件 301 行

- 新文件 `packages/stores/src/tmux-device-actions.ts`，形状对齐 `tmux-viewport-actions.ts`：`connectDevice` / `disconnectDevice` / `reorderWindows` / `reorderPanes` + `reorderById`。
- 宿主按原位置挂方法（不提前 spread），`shouldSkipDuplicateConnect` / `handleReady` 留在 `tmux.ts`。

### 5. ghostty-terminal：做了纯计算抽取，未动绘制热路径

`canvas-renderer.ts` 926 → 897（< 900），`render` / `resize` CC 降到阈值内：

- `canvas-renderer-draw-plan.ts`：effective dirty、scroll blit 判定、邻行扩展。`blitRows` 仍在 `render()` 里按原顺序调用。
- `canvas-renderer-metrics.ts`：表面几何比较、advance residual → `maxTextRun`、`sameSelectionRects` / `toDeviceCell` / `colorToCss`。
- 行 run 批处理（`drawRowBackground` / `drawRowForeground` 的 fillRect/fillText 合并）**留在类内**，避免扰动画序。

`render-state.ts` 987 → 952（≤ allowlist 967），`iterateRows` CC 降到阈值内：

- `render-state-shift.ts`：shift baseline、上一帧行查找、dirty 降级。`previousRows = null` → 消费 dirty → 完整轮才写回缓存，这一序列仍在 `iterateRows` 里。
- `render-state-color.ts`：颜色 intern / `readColorAt`（签名改为直接吃 `colorCache`，调用点机械替换）。

`bun bench/render-bridge.bench.ts`（120×40，200 frames）：

```
scroll +1 line/frame  dirtyRows/frame=1.0  full=0/200
scroll +3 lines/frame dirtyRows/frame=3.0  full=0/200
scroll -1 line/frame  dirtyRows/frame=1.0  full=0/200
```

## 有意未动 / 仍须 allowlist 收紧

本任务文件里，gate 已不再报警。commander 收紧 allowlist 时：

- `packages/ghostty-terminal/src/render-state.ts` 仍 952 行（> 900），应保留/下调 `fileLines`（现 pin 967）。行 run 批处理与 dirty 消费序列不宜再拆。
- `packages/ws-client/src/direct/direct-carrier-controller.ts` 1113 行，可将 pin 从 1118 下调。

其余 9 条违规均不在本任务文件内（fe 设置页、mesh breaker/race、`canonical-state-client.ts`、`direct-dial-breaker.ts`、`test-fakes.ts` 等）。

## 验收

| 包 | tsc | bun test |
|---|---|---|
| gateway | 0（baseline 21） | 3808 pass / 2 fail；失败为已知 flake（PeerManager replay cache、multi-hub token redeem）。metrics + viewport-claims 26 pass。 |
| ws-client | 0 | 363 pass / 0 fail |
| stores | 1（baseline 1：`host-services.test.ts`） | 与本抽取相关的 tmux-reorder / selection / reselect 30 pass。全量 9 fail 全部是 `websocket-transport.ts` 里 `pendingCommandLimits` 为 undefined（该文件由其他 agent 持有，本任务禁止改）。 |
| ghostty-terminal | 0 | 272 pass / 0 fail；bench 见上 |
| terminal-ui | — | 379 pass / 0 fail |
| panels | — | 765 pass / 0 fail |

`bunx biome check` 本任务改动/新增文件：通过。
`bun scripts/complexity/gate.ts`：18 → 9 violation，0 stale；本任务条目全部消失。
