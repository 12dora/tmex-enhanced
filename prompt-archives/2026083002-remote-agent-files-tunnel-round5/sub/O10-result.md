# O10 结果 — 分屏关闭 pane 后卡在「连接设备中」

按诊断报告第 5 节的候选 1/2/3 实现，三处修复互相独立、任何一处失效另外两处仍能兜底。

## 1. 关闭前先回落路由（候选 1）

- 新增纯函数 `packages/panels/src/device-console/close-pane-fallback.ts` 的 `resolveCloseFallback({windows, routeWindowId, routePaneId, closingWindowId, closingPaneId})`：
  - 关的不是 URL 点名的 pane（window 或 pane 不匹配）→ `{kind:'none'}`，只发 `close-pane`；
  - 同窗还有剩余 pane → tmux active 优先，active 就是被关的那个则取第一个剩余 → `{kind:'pane'}`；
  - 同窗清空 → 其他窗口（active window 优先）的 active pane；
  - 都没有 → `{kind:'device-list'}`。
- 面板层动作 `handleClosePane(windowId, paneId)` 落在 `use-pane-selection-dispatch.ts`（与 `handleUserSelectPane` 同一出口），顺序是：先按上面的结论 `navigateToPane` / `navigateToDeviceList`（并写 `userInitiatedSelectionRef` 压制 tmux active 回声把路由弹回死 pane），再 `closePane`。
- `SplitPaneView` 不再直接读 tmux store，改为必传 prop `onClosePane(windowId, paneId)`；`SplitTerminalArea` 透传（这两个文件是同一条链路，`SplitTerminalArea.tsx` 只加了一个 prop 的透传）；`terminal-stage.tsx` 传 `selection.handleClosePane`。

## 2. 已确认关闭的 pane 不再挂 Terminal（候选 2）

- `pane-selection-rules.ts` 新增 `paneRouteKey()` 与 `resolveConfirmedPaneClosure()`：**曾在快照里出现过、随后从快照消失** 才算「已确认关闭」；从没出现过（深链、刚 split 出来的 pane）仍走 2.5s settle 宽限，宽限逻辑与文案未动。
- `use-pane-selection-state.ts` 用一个 effect 记账「见过该路由 pane」，导出 `isPaneConfirmedClosed`；并把两个语义拆开：
  - `isSelectionInvalid`（渲染「终端窗格已关闭」提示、`resolveSplitView`）仍只由 2.5s 宽限决定 —— 避免分屏区因一帧的 invalid 被卸载重挂；
  - `isSelectionSettledMissing`（喂给路由对账）= 宽限判定 **或** 已确认关闭，所以外部 kill 也不再等 2.5s，快照一到就回落。
  - `canInteractWithPane` 额外排除已确认关闭，避免那一帧把输入发向死 pane。
- `terminal-stage.tsx`：单终端分支在 `isPaneConfirmedClosed` 时返回 `null`（不挂 Terminal，也就不会 mount/subscribe 死 pane），`isResolvingSnapshot` 增加 `!isPaneConfirmedClosed` —— 用户关掉的 pane 不再显示「连接设备中」遮罩。遮罩文案本身未改。判定放在分屏分支之后，分屏区不受影响。

## 3. 快照删除选中 pane 时收尾 select 事务（候选 3）

- `packages/ws-client/src/state-machine.ts` 新增 `abandonPane(deviceId, paneId)`：只在事务目标就是该 pane 时 `cancelTransaction`（丢缓冲、清定时器、清 deferred），**不**走 `failTransaction`，因此不会触发 `onSelectFailed` → 250ms 重选。
- `tmux-selection-actions.ts` 新增 `handleSnapshotPaneRemoval(deviceId, previousSnapshot)`：选中 pane 在旧快照里有、新快照里（任意 window，跨窗移动不算消失）没有时，`cancelReselect` + `abandonPane` + 删掉 `selectedPanes[deviceId]`；旧快照里也没有则不动（刚建/深链的 pane 交给宽限期）。
- `tmux-event-router.ts` 的 `metadata-snapshot` / `metadata-patch` 在写入快照前先取旧快照，写入后调用它。

## 文件清单

新增：
- `packages/panels/src/device-console/close-pane-fallback.ts` / `close-pane-fallback.test.ts`
- `packages/panels/src/device-console/terminal-stage.test.tsx`
- `packages/stores/src/tmux-selection-drop.test.ts`
- `apps/fe/tests/split-close-pane.spec.ts`（未运行，见下）

修改：
- `packages/terminal-ui/src/components/split/SplitPaneView.tsx`、`packages/terminal-ui/src/components/SplitTerminalArea.tsx`
- `packages/panels/src/device-console/`：`terminal-stage.tsx`、`pane-selection-rules.ts`(+test)、`use-pane-selection-state.ts`、`use-pane-selection-dispatch.ts`、`use-device-pane-selection.ts`
- `packages/stores/src/`：`tmux-selection-actions.ts`、`tmux-event-router.ts`(+test)
- `packages/ws-client/src/state-machine.ts`

`device-console.tsx`、`command-input-collapse.tsx`、`editor-input-panel.tsx`、`device-console-toolbar.tsx` 均未改动（collapse 接线原样）。没有新增/修改 i18n key。

## 验证

| 包 | bun test | tsc --noEmit |
| --- | --- | --- |
| packages/panels | 580 pass / 0 fail | 0 |
| packages/stores | 321 pass / 0 fail | 1（`host-services.test.ts` 既有，基线一致） |
| packages/terminal-ui | 315 pass / 0 fail | 0 |
| packages/ws-client | 261 pass / 1 fail | 1 |
| apps/fe (`bun test src/`) | 786 pass / 0 fail | 0 |

`bunx biome check` 对全部改动文件通过（只对自己的文件跑过 `--write`）。

ws-client 的 1 fail / 1 tsc error 都在 `src/transport-message-decoder.test.ts`（`KIND_NODE_EVENT 带上 version / directCapable / name`），来自 commander 已改的 MeshNode `transport`/`rttMs` 契约，与本任务无关，属于对应 agent 的 fixture 更新范围。

## 未做 / 风险

- e2e `apps/fe/tests/split-close-pane.spec.ts` 按要求**没有运行**（其他 agent 在改 fe，HMR 会污染）。两个用例：4 pane 关焦点 pane（URL 换到幸存 pane、3s 内 `terminal-status-overlay` 计数恒为 0、tmux 剩 3 pane、焦点角标跟上）；2 pane 关焦点 pane（URL 落到另一 pane、无遮罩、退出分屏后单终端挂载）。写法对齐 `split-screen-desktop.spec.ts` / `split-selection-persistence.spec.ts`（同一套 `helpers/tmux`、`createDevice`、隔离 socket）。
- 没有为 `SplitPaneView` 加渲染测试：bun test 无 DOM，静态渲染它需要 `RuntimeProvider` + i18n 且要连带 SSR 整个 `Terminal`，测不到点击行为。关闭逻辑改由 `resolveCloseFallback`（单测）与 `TerminalStage` 静态渲染测试（遮罩/挂载分支）覆盖，`onClosePane` 是必填 prop，接线错会直接 tsc 报错。
- 「已确认关闭」依赖「该 pane 曾在快照里出现过」的记账（按 `deviceId:windowId:paneId` 身份）。切设备 / 切窗口会自然重置，跨窗 move-pane 由 `resolveRouteTarget` 的 relocated 分支先行处理，不会被误判为关闭。
- 分屏区在「焦点 pane 已确认关闭」的那一帧仍会渲染（`isSelectionInvalid` 未提前置真），只是不含该 pane —— 这是刻意的，避免 `SplitTerminalArea` 卸载重挂导致所有终端重建。
