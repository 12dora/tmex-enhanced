# L1c 结果：ws-client + stores 下线 legacy 状态流，尺寸命令走 canonical v1.1

只改 `packages/ws-client/src/**` 与 `packages/stores/src/**`，外加一处必须的
`scripts/complexity/allowlist.json` **删除**（见第六节）。gateway / shared / terminal-ui / apps/fe 一行未动。

## 一、改动文件

### 删除

- `packages/ws-client/src/state-machine.ts`（781 行）、`state-machine.test.ts`
- `packages/ws-client/src/pane-history-gate.ts`
- `packages/ws-client/src/canonical-metadata-overlay.ts`、`canonical-metadata-overlay.test.ts`
- `packages/stores/src/pane-stream-gaps.ts`、`pane-stream-gaps.test.ts`
- `packages/stores/src/select-transaction-observers.ts`
- `packages/stores/src/reselect-retry.ts`（任务书没点名，但 250 ms 重选只由 select 状态机的
  `onSelectFailed` 与 `!atomicScreen` 分支触发，两者一起消失后整条链路不可达）
- `packages/stores/src/tmux-selection-warm.test.ts`（整文件跑在真实 SelectStateMachine 上）
- `packages/stores/src/tmux-reselect-retry.test.ts`

### 新增

- `packages/ws-client/src/canonical-size-epochs.ts`（35 行，sizeEpoch 账本）
- `packages/stores/src/tmux-selection-actions.test.ts`（canonical 选择面 6 用例，替代 warm 测试）
- `packages/stores/src/tmux-device-connect.test.ts`（原 reselect-retry 测试里与重试无关的 2 条）

### 修改（ws-client）

`client.ts`、`websocket-transport.ts`、`transport-types.ts`、`transport-message-decoder.ts`、
`transport-command-encoder.ts`、`message-builder.ts`、`canonical-state-client.ts`、
`canonical-metadata-identity.ts`、`canonical-state-helpers.ts`、`pane-sink-registry.ts`、
`connection.ts`、`index.ts` + 对应测试。

### 修改（stores）

`tmux.ts`、`runtime.ts`、`tmux-event-router.ts`、`tmux-selection-actions.ts`、
`select-pane-dispatch.ts`、`pane-subscriptions.ts`、`tmux-device-actions.ts`、
`tmux-device-events.ts` + 对应测试。

## 二、删掉的导出 / 契约变更（下游按此改）

### `@tmex/ws-client` 主入口不再导出

| 符号 | 说明 |
|---|---|
| `SelectStateMachine`、`getSelectStateMachine` | 选择状态机整体删除 |
| `SelectTransactionState`、`SelectTransaction`、`OutputGateState`、`OutputGate` | 同上 |
| `SelectStartEvent`、`SwitchAckEvent`、`HistoryEvent`、`LiveResumeEvent`、`OutputEvent`、`SelectFailedEvent`、`SelectEvent` | 同上 |
| `SelectCallbacks`、`SelectFailureReason`、`SelectTimerScheduler`、`SelectStateMachineOptions` | 同上 |
| `PaneResetOrigin` | reset 只由 legacy select 触发，已删 |
| `buildTermResize`、`buildTermSyncSize` | 尺寸走 canonical `ResizePaneV11` |
| `buildTermInput`、`buildTermPaste` | 输入/粘贴只走 canonical `TerminalInput` |
| `buildTmuxSubscribePanes`、`buildTmuxFetchPaneHistory` | 订阅/截屏/历史只走 canonical |

### `@tmex/ws-client/pane-sink-registry` 不再导出 / 不再有的方法

`dispatchPaneReset`、`dispatchPaneApplyHistory`、`dispatchPaneOutput`、
`dispatchPaneHistory`、`beginPaneHistoryGate`（模块级函数与 `PaneSinkRegistry` 方法都删）。
`PaneSinkRegistryOptions.historyGate` 一并删除。

`PaneSink` 现在是：

```ts
export interface PaneSink {
  onOutput(data: Uint8Array, frame?: GatewayTerminalData): void;
  onScreenSnapshot?(snapshot: GatewayPaneScreenSnapshot): void;
  onHistoryPage?(page: GatewayPaneHistoryPage): unknown;
  onRebase?(reason: GatewayRebaseReason): void;
}
```

`onReset` / `onApplyHistory` 已删（canonical 链路下它们从未被触发：
`dispatchPaneReset`/`dispatchPaneApplyHistory` 的唯一调用方是 select 状态机回调，
而状态机只在 `!capabilities.atomicScreen` 时才跑）。
`registerPaneSink` 的重放基线现在只有 `screen`，没有画面基线的流中片段仍然直接丢弃。

### 其它契约

- `GatewayConnection` 去掉 `selectMachine`；`GatewayConnectionOptions` 去掉 `selectCallbacks`。
- `RuntimeCore` 去掉 `selectMachine`；`PaneSinkRouting` 只剩
  `registerPaneSink / dispatchPaneTerminalData / dispatchPaneScreenSnapshot /
  dispatchPaneHistoryPage / dispatchPaneRebase / cleanupDevicePaneState`。
- `BorshClientOptions` 去掉 `canonicalStateEnabled`（canonical kill switch）。
- `GatewayTransportCommand` 的 `select-pane` 去掉 `wantHistory`（wire 上恒为 `false`，
  由 `buildTmuxSelect` 内部写死；schema 字段保留，不动 wire 布局）。
- `TmuxSelectParams` 同步去掉 `wantHistory`。
- `encodeGatewayTransportCommand(command)` 只剩一个参数（`GatewayCommandEncodingOptions` 删除）；
  新增导出 `CANONICAL_ONLY_COMMANDS`（7 个 canonical 覆盖的命令类型），
  对它们调用 `encodeGatewayTransportCommand` 会抛
  `[gateway-transport] command has no control frame: <type>`（不静默回退）。
- `TmuxSelectionActions` 去掉 `maybeReselectCurrentPane` / `handleSelectFailed` /
  `cancelReselect` / `handleDeviceStreamInterrupted` / `observeSelectHistory` /
  `observeSelectLiveResume`；只剩 `selectPane / selectWindow / focusPane /
  handleSnapshotPaneRemoval / recordTerminalSize / dispose`。
  `SelectPaneOptions.warm` **保留**（`packages/panels` 在传），但已不改变下发内容——
  canonical 之前它也只是决定 legacy `wantHistory`，而 canonical 会话下 `wantHistory` 恒为 false，
  所以行为无变化。

### transport 事件面（`GatewayTransportEvent`）

删除：`selection-ack`、`legacy-history`、`live-resume`、`terminal-progress`。

- `terminal-progress` 唯一的发出点是 `TERM_HISTORY`/`TERM_OUTPUT` 的 chunk 进度，随 legacy 一起消失。

**保留 `terminal-data`**（与 EX2 §A.3 的清单不同）：它是 canonical `PaneData` 的落点
（`canonical-state-client.handlePaneData` 直接 emit），删掉会把 canonical 终端字节流一起砍断。
stores 侧去掉了「`seqStart === undefined` → 丢给 select 状态机」的分支，一律进 `dispatchPaneTerminalData`。

新增：

```ts
| { type: 'server-too-old'; minVersion: string; serverVersion: string | null }
```

`minVersion` 恒为 `wsBorsh.CANONICAL_V11_MIN_PEER_VERSION`（`'1.1.22'`），
`serverVersion` 取 HELLO_S2C 的原样值（拿不到为 `null`）。在 `WebSocketGatewayTransport`
进入 `READY` 且 `client.stateFeedMode !== 'canonical'` 时发一次。

`metadata-patch` 改形：

```ts
// 旧：{ type: 'metadata-patch'; deviceId: string; patch: wsBorsh.LegacyStateSnapshotDiff }
{ type: 'metadata-patch'; deviceId: string; snapshot: StateSnapshotPayload }
```

理由：设备树顺序（TREE_ORDER）在 ws-client 侧才有完整的顺序表；如果继续下发 diff，
stores 自己再 `applyLegacyStateSnapshotDiff` 一次会把顺序掉回 tmux index 顺序
（L1a 结果第三节 ws-client 第 3 条点名的坑）。现在 ws-client 排好整棵快照直接下发，
stores 只做替换。引用稳定性不变——ws-client 内部的 `state.snapshot` 正是 store 手里那一份的派生。

### `StateFeedMode`

```ts
export type StateFeedMode = 'pending' | 'canonical' | 'unsupported';
```

`'legacy'` 删除，新增 `'unsupported'` = 已连上但网关不满足 canonical v1.1 门槛。
门槛（fail-closed，三条全中才建会话）：

1. `hello.capabilities` 含 `GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1`；
2. `wsBorsh.peerSupportsCanonicalV11(hello.serverVersion)`；
3. `effectiveMaxFrameBytes >= CANONICAL_STATE_MAX_FRAME_BYTES`。

不满足时：canonical 会话不激活、canonical 待发队列丢弃、`state-feed-mode` 事件报
`'unsupported'`、`server-too-old` 事件发一次，**不回退 legacy**。此时 canonical 覆盖的
7 类命令编码会抛错并转成一次 `transport-error` + `'overflow'` 返回值。

## 三、canonical v1.1 尺寸映射

`canonical-state-client.sendResize` 现在发 `ResizePaneV11`：

| store 动作 | 命令 | geometryReason | sizeEpoch |
|---|---|---|---|
| `resizePane`（真实视口变化） | `terminal-resize` | `CANONICAL_GEOMETRY_REASON_CHANGE` (0) | 自增后的新值 |
| `syncPaneSize`（焦点恢复/暖切换补发） | `terminal-sync-size` | `CANONICAL_GEOMETRY_REASON_RESEND` (1) | 复用该 pane 上一次 change 的值 |

账本在 `canonical-size-epochs.ts`：

- 计数器 `next` 按**连接**自增（不是按 pane），`change()` 自增后写进
  `(deviceId, paneId)`；这样 pane 条目被 `clearPaneStateForDevice` 清掉后，
  下一次 change 仍拿到比网关记住的更大的值，不会被当成过期尺寸丢弃。
- `resend()` 取该 pane 的值；没有过 change 时回落到当前计数（至少 `1n`，
  因为 `sizeEpoch <= 0n` 会被 shared 的语义校验拒绝）。
- 类型是 `bigint`（`7n`），已按 L1a 的要求。
- `dispose()` 清空；`clearPaneStateForDevice(deviceId)` 按前缀清该设备的条目。

`websocket-transport.ts` 的 `isLegacySizeCommand` 白名单与 `LEGACY_STATE_KINDS` 已删，
两类尺寸命令统一走 canonical。

## 四、canonical metadata 承载设备树顺序

- `DeviceMetadataState` 新增 `treeOrder: wsBorsh.CanonicalTreeOrder`。
- 快照路径 `assembleDeviceMetadata`：`createCanonicalTreeOrder(deviceRecords)` +
  `sortSnapshotByCanonicalTreeOrder(...)`（不再接 `applyOverlay` 回调，签名从 5 参降到 4 参）。
- patch 路径 `ingestMetadataPatch`：`applyCanonicalTreeOrderPatch(state.treeOrder, upserts, removals)`
  后再排一次，然后 `emitPatch(deviceId, state.snapshot)`。
- `MetadataLiveCaches.applyOverlay` 删除；`emitPatch` 签名改为 `(deviceId, snapshot)`。
- `CanonicalStateClient.handleLegacyOverlaySnapshot` 与 `websocket-transport` 里
  `KIND_STATE_SNAPSHOT` 的 overlay 分支一并删除。自定义名（field 14）本来就走 canonical，无需额外处理。

**注意**：本轮之后客户端只从 canonical metadata 的 `SOURCE_FIELD_TREE_ORDER` 取顺序。
L1b 必须按 L1a 结果第三节 gateway 第 4 条把 `hierarchy-builder` 的 tree order 写进 field 15
（含 `Unset` 表示退出自定义顺序），否则设备树会回落到 tmux index 顺序。

## 五、select-pane 的落点（任务书第 1 条的确认）

`packages/shared/src/ws-borsh/canonical-state.ts` 的 `CanonicalCommandSchema` **没有** SelectPane 变体
（0 SetPaneSubscriptions / 1 TerminalInput / 2 ResizePane / 3 RequestScreen / 4 RequestHistory /
5 ResizePaneV11）。因此 `select-pane` / `select-window` / `focus-pane` 继续编成
`KIND_TMUX_SELECT` / `KIND_TMUX_SELECT_WINDOW` / `KIND_TMUX_FOCUS_PANE`——它们是 tmux 控制面，
不属于被删除的状态流 kind。`selectToken` 仍随 wire 发（schema 要求），但客户端已不再用它对账。

## 六、验证

| 项 | 结果 |
|---|---|
| `packages/ws-client` `bun test` | **379 pass / 0 fail**（29 文件；基线 408，净 −29：删掉 state-machine 全套与 pane-sink 的 gate/reset/history 用例，新增 canonical v1.1 门槛/尺寸 epoch/tree order 用例） |
| `packages/stores` `bun test` | **411 pass / 0 fail**（41 文件；基线 440，净 −29：删掉 warm/gap/reselect 全套，新增 canonical 选择面 6 条 + 设备连接 2 条） |
| `bunx tsc --noEmit -p packages/ws-client` | **0 error** |
| `bunx tsc --noEmit -p packages/stores` | **1 error，非本任务**：`host-services.test.ts(93,23)`，`helpers` 数组的声明类型缺 `value` 字段。该文件 `git status` 干净、`git log` 最后一次改动是 `ec301259`，与本任务无关（基线里就有） |
| `bunx biome check packages/ws-client/src packages/stores/src` | 干净 |
| `bun scripts/complexity/gate.ts` | 本任务文件零违规。`canonical-state-client.ts` 740 行（allowlist 741）、`client.ts` 826 行（allowlist 826），均**只降不升**；为此把 sizeEpoch 账本拆到新文件 `canonical-size-epochs.ts` |
| 仓库根 `bun run lint` | 失败，14 个 biome 错误 **全部在其他 agent 的文件**：`apps/fe/src/node/mesh-relay.ts`、`apps/gateway/src/{db,mesh,relay,tmux-client,ws}/*`、`packages/api-client/src/relay/tenant-api.ts`、`packages/app/src/commands/relay-admin.ts`。复杂度门禁另有 3 条违规也都在 gateway：`mesh/forwarder.ts`、`auth/user-key-service.ts`、`ws/canonical-feed-session.ts` |

## 七、给 L1d 的破坏清单（只读检测，未修）

### `packages/terminal-ui`（`bunx tsc --noEmit -p packages/terminal-ui`，4 条，全在一个文件）

`packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts`

- `:69` `onReset: (origin) => {...}` —— `PaneSink.onReset` 已删。
  它做两件事：`target.terminal.reset()` + `origin !== 'history-refresh'` 时 `runPostSelectResize()`。
  canonical 链路下这个回调从来不会被调用（reset 只由 select 状态机发），直接删整段即可；
  `runPostSelectResize` 若仍需要，应挂到 `onScreenSnapshot` 之后由 `TerminalSurface.replace` 触发。
- `:79` `onApplyHistory: (data, alternateScreen, modes) => writeRestoredHistory(...)` ——
  `PaneSink.onApplyHistory` 已删，连同 `terminal-snapshot.ts` 的 `writeRestoredHistory`
  与 `remotePaneGeometry()` 辅助函数一并可删（EX2 §A.3 terminal-ui 已点名）。
- 顺带：`import type { PaneSink } from '@tmex/ws-client/pane-sink-registry'` 仍有效，
  `PaneResetOrigin` 已不再导出（该文件没直接 import 它）。

### `apps/fe`（`bunx tsc --noEmit -p apps/fe`，除上面 4 条外还有 2 条）

- `apps/fe/src/node/node-runtimes.ts:319` —— `clientOptions: { canonicalStateEnabled: ... }`，
  该选项已删，直接去掉这一项。
- `apps/fe/src/node/node-runtimes.test.ts:40` —— `connection.selectMachine`，`GatewayConnection`
  已无该字段；同文件 `:31` 的 `stateFeedMode: 'canonical' | 'legacy' = 'legacy'` 也要改
  （`'legacy'` 已从 `StateFeedMode` 移除，改 `'pending' | 'canonical' | 'unsupported'`）。
- `apps/fe/tests/**`（e2e，tsc 不覆盖）：`helpers/ws-borsh.ts` 仍解码 `TMUX_SELECT` 的
  `wantHistory`（wire 字段还在，恒 false，可留可改）；`ws-borsh-history.spec.ts`、
  `ws-borsh-pane-route.spec.ts`、`ws-borsh-switch-barrel.spec.ts` 按 EX2 §A.3 改写。

### `packages/panels`（不在任何人的 scope 里，需要指挥官指派）

`bunx tsc --noEmit -p packages/panels` 有 3 条，全在
`packages/panels/src/device-console/keep-alive-subscription.test.ts`：

- `:52` `paneSink()` 返回的对象里有 `onReset` / `onApplyHistory`（`PaneSink` 已删这两项）；
- `:108` `runtime.paneSinks.dispatchPaneReset('device-a', paneId, 'select')`（`PaneSinkRouting` 已删）。

该测试断言的是「退订期间的输出补不回来 → 必须冷 select」，这条语义随 legacy 一起消失。
建议改写成「退订期间 sink 仍注册、重新订阅后由 `dispatchPaneScreenSnapshot` 重建画面」，
或直接删掉那两条与 reset 相关的断言（其余 keep-alive 断言与本轮无关）。

## 八、需要指挥官处理

1. **`scripts/complexity/allowlist.json` 我删了一条**：
   `packages/ws-client/src/state-machine.ts`（fileLines 782）。该文件已删除，门禁会报
   `allowlist entry no longer matches anything` 并失败。这是删除不是新增，符合「不加 allowlist」的约束，
   但文件不在我的 scope 里，特此报备。
2. **`server-too-old` 目前没有用户可见提示**：`packages/stores/src/tmux-event-router.ts` 的
   handler 只 `console.error`，因为新增 i18n key 要动 `packages/shared/src/i18n/locales/*.json`
   （不在我的 scope）。建议加 `websocket.serverTooOld`（zh_CN/en_US/ja_JP）后把
   `ctx.core.notifications.error(ctx.core.t('websocket.serverTooOld'))` 补回来；
   `stateFeedMode === 'unsupported'` 也已进 tmux store，UI 可据此常驻横幅。
3. **L1b 必须发 tree order**（见第四节末尾）：field 15 不发的话设备树自定义顺序会静默丢失，
   ws-client 侧已经没有 legacy overlay 兜底了。
4. **L1b 的网关侧必须播报 `canonical-state-v1.1`**：客户端现在 fail-closed，缺能力就整条状态流不建。
   本地起临时实例联调时注意 gateway 自报版本要 ≥ `1.1.22`（`1.1.22_dev` 也认）。
5. `packages/panels` 的 3 条 tsc 错误（第七节）没有归属 agent。
6. `packages/stores/src/host-services.test.ts(93,23)` 是基线里就有的 tsc 错误（与本任务无关），
   如果验收要求 stores tsc 为 0，需要单独修一行类型声明。
