# L1b 结果：gateway 下线 legacy 终端状态流、接入 canonical v1.1 尺寸语义、对旧对端设门槛

范围内全部完成，无 TODO、无降级分支、无 legacy 回退路径。

## 一、删除的 wire kind / handler

### 网关不再**发送**的 kind

`STATE_SNAPSHOT`、`STATE_SNAPSHOT_DIFF`、`TERM_HISTORY`、`TERM_OUTPUT`、`SWITCH_ACK`、`LIVE_RESUME`。

### 网关不再**接受**的 kind（落到既有 `ERROR_UNKNOWN_KIND` 路径）

`TMUX_FETCH_PANE_HISTORY`、`TMUX_SUBSCRIBE_PANES`、`TERM_RESIZE`、`TERM_SYNC_SIZE`。

> shared 里的 kind 常量本任务一行未动（由最后一个 agent 删）；网关只是不再引用。

### 整文件删除

| 文件 | 说明 |
|---|---|
| `apps/gateway/src/ws/borsh/switch-barrier.ts` (+`.test.ts`) | 选择屏障 / SWITCH_ACK / TERM_HISTORY 门控 |
| `apps/gateway/src/ws/terminal-output-batcher.ts` (+`.test.ts`) | 只为 legacy `TERM_OUTPUT` 批量下发而存在；canonical 侧只用到其中 3 个节流常量，已移到新文件 `ws/terminal-output-batching.ts` |
| `apps/gateway/src/ws/overlay-utils.ts` (+`.test.ts`) | `applyDeviceTreeOverlay` 被 shared 的 `sortSnapshotByCanonicalTreeOrder` 取代；`applyCustomNamesOverlay` 在 HEAD 上已无调用方（L3 删 `/api/tmux/tree` 后） |
| `apps/gateway/src/ws/legacy-observer-wiring.test.ts` | legacy pane observer 计数 |
| `apps/gateway/src/ws/switch-barrier.issue45.test.ts`、`ws/issue45-cross-bug.test.ts` | 全文件都在测 barrier / TERM_HISTORY 路由 |

### 重命名（仅限 `apps/gateway/src/ws/`）

- `legacy-feed-broadcaster.ts` → `device-feed-broadcaster.ts`（`LegacyFeedBroadcaster`/`LegacyFeedHost` → `DeviceFeedBroadcaster`/`DeviceFeedHost`）。留下的只有 tmux 事件（bell/notification 节流）、剪贴板、设备错误，以及**只写内存**的 `installStateSnapshot`（视口策略 / bell 上下文 / select 校验仍需要 `entry.lastSnapshot`）与 `noteTerminalOutput`（只记指标）。
- `legacy-event-delivery.ts` → `event-delivery.ts`（`LegacyEventSender` → `DeviceEventSender`）。

### 混合文件里删掉的段

- `ws/index.ts`：canonical 会话的 legacy `STATE_SNAPSHOT` overlay 补发、`sendTermOutput`、`encodeSnapshotWithOverlays`、observer wrapper（`syncLegacyPaneObservers`/`releaseLegacyPaneObservers`）、runtime listener 的 `onTerminalHistory` 转发与 legacy metadata diff 广播。
- `ws/borsh/codec-borsh.ts`：`encodeTermOutput` / `encodeTermHistory` / `encodeSwitchAck` / `encodeLiveResume`；`BorshSessionState` 去掉 `selectedPanes` / `subscribedPanes`，新增 `clientVersion: string | null`。
- `ws/borsh/session-state.ts`（588 → 331 行）：删「选择事务状态机」与「输出门控状态机」（含 `emitResourceExhaustedGap`）；保留 WS/设备状态与 bell / notification 节流。
- `ws/tmux-command-handlers.ts`：删 `handleSubscribePanes` / `handleFetchPaneHistory`；`renameWindow`/`renamePane`/`reorderWindows`/`reorderPanes` 不再补发快照，改为把变化推进 canonical metadata 投影。
- `ws/tmux-selection-handlers.ts`：删屏障事务、`selectedPanes` 记账、observer 同步、输出 flush；保留底层 tmux focus/select 与视口声明（canonical 命令枚举里**没有** SelectPane，故 `TMUX_SELECT` 保留，它不是 legacy STATE kind）。
- `ws/device-connection-registry.ts`：删 legacy observer、连接时的快照补发；新增断开时 `dropPaneSizeEpochs`。
- `ws/websocket-send-guard.ts`：`isScreenReconstructibleTerminalFrame` 只认 canonical `PaneData`。
- `ws/snapshot-overlays.ts`：删 `encodeSnapshotWithOverlays` / `applyWindowCustomNames`，改为 `pruneCustomNames(payload)`（快照安装时回收 stale 自定义名）。
- `ws/terminal-output-metrics.ts` / `ws/gateway-metrics-log.ts`：删 `legacyObserved*` / `batches` / `batchBytes` / `recipient*` 计数与 `queues.batch`，`[ws-metrics] terminal_output` 日志同步瘦身；`recordSource(bytes, { canonical })` 只剩一个维度。
- `tmux-client/runtime/output-materialization.ts`：legacy observer 状态整块删除，`materializeOutput` 只看 canonical retention。

## 二、canonical v1.1 尺寸：新回调签名

`CanonicalFeedSessionOptions.resizePane` 由 5 个位置参数改为单个对象（`apps/gateway/src/ws/canonical/types.ts`）：

```ts
export interface CanonicalResizeRequest {
  deviceId: string;
  paneId: string;
  cols: number;
  rows: number;
  reason: number;      // wsBorsh.CANONICAL_GEOMETRY_REASON_CHANGE | ..._RESEND
  sizeEpoch: bigint;
  runtime: CanonicalFeedRuntime;
}
resizePane?: (intent: CanonicalResizeRequest) => void;
```

- v1 `ResizePane` **继续接受**，归一为 `reason=change, sizeEpoch=0n`（过渡期用；L1c 切完 v1.1 后可删，归一逻辑集中在新文件 `ws/canonical/resize.ts` 的 `normalizeResizeCommand`）。
- 网关侧入口 `handleCanonicalResize(host, session, intent)`（`ws/tmux-geometry-handlers.ts`，取代原 `handleTermResize`）：
  - **epoch 丢弃**：`GatewaySession.paneSizeEpochs: Map<'deviceId\0paneId', bigint>`，`sizeEpoch < 已接受最大值` 直接忽略；`>=` 更新并处理（同 epoch 的 resend 必须放行）。设备断开 / 会话关闭时用 `dropPaneSizeEpochs` 清理。
  - `reason=resend` → `recordViewportClaim(..., { distrustLive: true })`（暖切换/重连语义，等价于旧 `TERM_SYNC_SIZE` + 提交 `4c7b5274` 的 `distrustLive` 路径）；`reason=change` → 现有 live 几何去重路径（等价于旧 `TERM_RESIZE`）。
- `BorshDispatchHost` / `TmuxCommandHost` 同步：删 `handleTermResize`、`handleSubscribePanes`、`handleFetchPaneHistory`、`syncLegacyPaneObservers`、`sendSnapshotToClients`、`terminalOutputBatcher`；`handleFocusPane` 去掉不再使用的 `session` 形参。

## 三、版本门槛与错误码

`packages/shared` 的错误码表不在本任务范围，**没有新增 kind**。新增 `apps/gateway/src/ws/canonical-gate.ts`：

```ts
export const ERROR_CANONICAL_V11_REQUIRED = wsBorsh.ERROR_UNSUPPORTED_PROTOCOL; // 1001
export const CANONICAL_V11_REQUIRED_PREFIX = 'canonical-state-v1.1 required';
export function clientTooOldMessage(v: string | null): string;   // "…: client 1.1.21 < 1.1.22"
export function peerNodeTooOldMessage(v: string | null): string;  // "…: node 1.1.21 < 1.1.22"
```

前端识别方式：**`code === 1001` 且 `message` 以 `canonical-state-v1.1 required` 开头**。

- **browser ↔ entry**：`handleHello` 记录 `HELLO_C2S.clientVersion` 到 `ws.borshState.clientVersion`，用 `wsBorsh.peerSupportsCanonicalV11()` 判定；不达标 → 发 ERROR（`refSeq` = HELLO 的 seq，`retryable=false`）并 `closeSession(1002, 'canonical-state-v1.1 required')`，**不设 `negotiated`**、不回退 legacy。`HELLO_S2C.capabilities` 已经是 `[...GATEWAY_CAPABILITIES]`，L1a 加了常量后自动带上 `canonical-state-v1.1`，无需改代码。
- **entry ↔ node**：`StreamReplayState.noteInbound` 在 HELLO_S2C 上解析 `serverVersion` 存 `peerVersion`，并在返回的 `InboundReplayNote` 上带 `peerUnsupported: boolean`。`Forwarder.handleRemoteBytes` 一行判定 `rejectStaleNodeStream(noted.peerUnsupported, pump, this)`：向浏览器发同一 ERROR 帧并 `closeBrowser(1002, 'node-too-old')`，**不转发 HELLO_S2C、不回退 legacy replay**。`rejectStaleNodeStream` 放在 `mesh/stream-replay-state.ts`（复用已有 import，避免 forwarder.ts 触碰复杂度门禁上限）。

## 四、legacy overlay → canonical metadata（设备树顺序）

自定义名在 v1 就已随 `SOURCE_FIELD_CUSTOM_NAME`(14) 走 canonical（L1a 已核对），本任务只补**树顺序**：

- `tmux-client/metadata/hierarchy-builder.ts`：`MetadataHierarchyHost` 新增 `getWindowTreeOrder(windowId)` / `getPaneTreeOrder(windowId, paneId)`，`buildWindow`/`buildPane` 写 `wsBorsh.SOURCE_FIELD_TREE_ORDER`(15)（`U32`，0 基；无序号则不写该字段）。新增 `setDefinedU32Field`（`metadata/hierarchy-fields.ts`）。
- `tmux-client/metadata-projection.ts`：新增 `setTreeOrder(order: DeviceTreeOrderInput)`。未 establish 时只记表；已 establish 时对比每条 window/pane 记录，**变化的写字段、退出自定义顺序的写 `Unset`**（不是「不写」），一次 revision bump 合并所有变更；顺序未变时不产生 patch。
- `tmux-client/device-session-runtime.ts`：暴露 `setTreeOrder`。
- `ws/index.ts`：
  - `storeDeviceTreeOrder()` 落库后立刻推给运行时投影（`reorderWindows`/`reorderPanes` 因此自动生效）。
  - 新增 `applyDeviceOverlaysToRuntime(deviceId, runtime)`，在 `attachRuntime` 里把**已保存的树顺序 + 内存里的自定义名**灌进新建的投影（旧实现靠 legacy overlay 补，运行时重建后不会丢）。
  - 删除 `onDeviceAttached` 里给 canonical 会话补发的 `KIND_STATE_SNAPSHOT` overlay（原 index.ts:350-362）与 registry 的同名分支。

## 五、mesh replay

`apps/gateway/src/mesh/stream-replay-state.ts`（826 → 673 行）：

- 删 `LegacyReplayStats` / `legacyReplayStats()`、`paneSubs`、`lastSelect`、`buildLegacyHistoryRequests()`、`allocateHistoryByteLimit()`、`FAILOVER_HISTORY_BYTES_*` 常量、`collectUniquePanes`、`encodeLegacyHistoryRequest`、`encodePaneResourceGap`、`paneSubPayloads()`，以及 `noteOutbound` 里 `TMUX_SUBSCRIBE_PANES` / `TMUX_SELECT` 的记录和 `noteInbound` 里的 `STATE_SNAPSHOT` resume 条件。
- `describeReplay().mode` 现在只有 `canonical` / `none`；`resumedPaneCount()` 只数 canonical 订阅；`buildPostConnectFrames()` = canonical resume + agent 订阅。
- 顺带（不改会编译不过）：`mesh/failover-log.ts` 的 `formatFailoverDone` / `formatFailoverSummary` 去掉 `replayBytes` 字段（canonical cursor replay 没有字节预算概念），`mesh/forwarder-failover.ts` 两处调用同步；`mesh/failover-log.test.ts` 断言更新。

**行为变化（需告知 L1c/L1d）**：failover 后不再重放 `TMUX_SELECT`，pane 焦点由 FE 自行维持；内容恢复完全靠 canonical `SetPaneSubscriptions` + cursor。

## 六、测试

新增 / 重写：

| 文件 | 内容 |
|---|---|
| `ws/canonical-gate.test.ts`（新，6 用例） | HELLO 门槛三态（≥1.1.22 放行且播报能力 / <1.1.22 ERROR+断开 / 无法解析一律 fail-closed）；epoch 丢弃；change 被 live 几何去重而同 epoch resend 强制重发；`dropPaneSizeEpochs` 按 device 清理 |
| `tmux-client/metadata-projection.test.ts`（+5 用例） | establish 前/后设顺序、退出顺序写 `Unset`、顺序未变不产 patch、重复 id 取首次序号 |
| `mesh/stream-replay-state.test.ts`（+2 用例） | `peerVersion` fail-closed；`noteInbound` 的 `peerUnsupported` 标记 |
| `mesh/forwarder.test.ts`（+2 用例） | 旧节点 → ERROR(1001)+close(1002)；达标节点正常转发 HELLO_S2C |
| `ws/index.test.ts` | 「自定义名与设备树顺序（canonical metadata）」整段重写为断言投影调用（`setCustomName`/`setTreeOrder`）+ stale 名回收，不再断言快照下发 |
| `ws/device-connection-registry.test.ts` | observer presence 用例改为断言断开时清 viewport claims / size epochs |
| `tmux-client/runtime/output-materialization.test.ts` | 只保留 predicate 发现语义（3 用例） |
| `ws/device-feed-broadcaster.test.ts`、`ws/event-delivery.test.ts` | 随文件重命名迁移 |
| `ws/websocket-send-guard.test.ts` | `termOutputFrame` → `paneDataFrame`；frame-kind 解码用例改用 `TMUX_EVENT` |
| `mesh/integration/stream-failover.integration.test.ts` | 删 legacy 0x305 用例；探针帧由 `TERM_OUTPUT` 改为 canonical `PaneData`，订阅改 canonical |

**全部 `clientVersion: 'test' / '0.0.1' / '1'` 的测试夹具已改为 `'1.1.23'`**：`mesh/stream-targets.test.ts`、`mesh/integration/direct-path.integration.test.ts`、`mesh/integration/mesh.integration.test.ts`（L3 名义 scope，只改了 1 个字符串字面量）、`mesh/forwarder.test.ts`、`mesh/stream-replay-state.test.ts`、`ws/inbound-frame.test.ts`、`ws/index.test.ts`。`encodeHelloS2CFrame` / `encodeHelloS2C` 的 `serverVersion` 默认值同样改为 `'1.1.23'` 并加了可选参数。

## 七、验证结果

- **targeted**：`bun test src/ws src/mesh/stream-replay-state.test.ts src/mesh/forwarder.test.ts src/mesh/forwarder-failover.test.ts src/mesh/failover-log.test.ts src/tmux-client` → **1095 pass / 0 fail（104 文件）**。
- **全量 gateway `bun test`**：**4074 tests / 4070 pass / 4 fail**（基线 4046+4 flake；本任务净删 5 个 legacy 测试文件、重写多段用例，其余增量来自并行的 relay agent）。4 个失败全部是既有 load flake，逐个隔离重跑均通过：
  - `stream failover integration > pane stream over dc …`（单跑 1 pass）
  - `large raw-body push over mesh` ×2（单跑 2 pass）
  - `RtcPeerManager > TTL sweep timer …`（`src/mesh/rtc` 单跑 169 pass）
- **`bunx tsc --noEmit -p apps/gateway`**：共 **51 个 error，全部不是本任务的**，逐条如下（均为 B1 的 `TmexRoles.relay` / B2 的 `hash-wasm` 依赖）：
  - `src/relay/relay-password.ts(2,26) TS2307 Cannot find module 'hash-wasm'` ×1
  - `src/auth/user-key-service.ts(241,5) TS2739 … missing relays, metaKeyEpoch, metaKeyEntries` ×1
  - `src/config.test.ts` ×4（`roles` 字面量少 `relay`）
  - `TmexRoles`/`{hub,node}` 缺 `relay` 的 TS2353/TS2741 共 45 处，分布在 `mesh/auth-routes.test.ts`、`mesh/mesh-http.test.ts`、`mesh/mesh-routes.test.ts`、`mesh/session-middleware.test.ts`、`mesh/effective-site-url.test.ts`、`mesh/uplink-pool.test.ts`、`mesh/integration/multi-hub*.ts`、`mesh/integration/large-push-harness.ts`
- **`bunx biome check <本任务全部改动文件>`**：干净（0 error）。
- **仓库根 `bun run lint`**：biome 20 处 format/organizeImports 错误 + 复杂度门禁 13 条违规，**全部在 B1/B2/B3/F1/F2 的 relay 文件**（`mesh/relay-*.ts`、`relay/*`、`mesh/mesh-routes.ts`、`mesh/uplink-pool.ts`、`mesh/mesh-runtime.ts`、`auth/user-key-service.ts`、`apps/fe/src/**/relay*`、`db/local-auth-settings.test.ts`）。本任务文件零违规。
  - 为守住复杂度门禁（禁止加/抬 allowlist）做了两处结构调整：`forwarder.ts` 保持 963 行（把拒绝逻辑放进 `stream-replay-state.ts`，并把 `handleRemoteBytes` 里 `DEVICE_CONNECTED` 的 4 行压成 3 行等价写法）；`canonical-feed-session.ts` 693 → 671 行（resize 归一/下发抽到 `ws/canonical/resize.ts`）。

## 八、L1c（ws-client + stores）必须知道的

1. **⚠️ 阻断项：`packages/ws-client/src/client.ts:90` 的 `DEFAULT_OPTIONS.clientVersion = '0.1.0'` 会被网关直接拒登。** 网关现在按 `HELLO_C2S.clientVersion` fail-closed，`'0.1.0'` → ERROR 1001 + close 1002。L1c 必须把它改成构建期注入的真实版本（≥ `1.1.23`）。在此之前前端连不上网关。
2. **发送侧**：`ResizePaneV11` 变体 discriminator = 5，`sizeEpoch` 是 `bigint` 且**必须 ≥ 1n**（0 是保留值，编码侧会拒）。`terminal-resize` → `reason=CHANGE` 且 epoch +1；`terminal-sync-size` → `reason=RESEND` 复用当前 epoch。网关按 `(session, deviceId, paneId)` 记录已接受的最大 epoch，**小于它的整条命令被丢弃**；同 epoch 的 RESEND 会放行。
3. 网关**不再接受** `TERM_RESIZE` / `TERM_SYNC_SIZE` / `TMUX_SUBSCRIBE_PANES` / `TMUX_FETCH_PANE_HISTORY`（会回 `ERROR_UNKNOWN_KIND`），也**不再发送** `STATE_SNAPSHOT` / `STATE_SNAPSHOT_DIFF` / `TERM_HISTORY` / `TERM_OUTPUT` / `SWITCH_ACK` / `LIVE_RESUME`。`TMUX_SELECT` 仍然接受（canonical 命令枚举里没有 SelectPane），但网关**不再回 `SWITCH_ACK`**，select 之后只会收到 `TERM_VIEWPORT_POLICY`。
4. **设备树顺序**：改从 canonical metadata 的 `SOURCE_FIELD_TREE_ORDER = 15` 读（`U32`，0 基序号；`Unset` = 退出自定义顺序，回落 tmux index）。按 L1a 的 `createCanonicalTreeOrder` / `applyCanonicalTreeOrderPatch` / `sortSnapshotByCanonicalTreeOrder` 消费，然后就能整体删掉 `canonical-metadata-overlay.ts` 与 `handleLegacyOverlaySnapshot`。
5. 版本门槛错误的识别：`ERROR` 帧 `code === 1001 (ERROR_UNSUPPORTED_PROTOCOL)` 且 `message` 以 `canonical-state-v1.1 required` 开头。前缀常量在 `apps/gateway/src/ws/canonical-gate.ts`（如果 FE 要复用，建议指挥官把这两个常量提到 `packages/shared`）。

## 九、L1d（terminal-ui + fe e2e）必须知道的

1. e2e helper `apps/fe/tests/helpers/ws-borsh.ts` 发的 HELLO 必须带 `clientVersion >= '1.1.22'`，否则整条连接被拒。同理 `apps/fe/tests/helpers/site-theme.ts:51` 现在写的是 `'0.0.0'`。
2. 网关不再下发 `STATE_SNAPSHOT` / `TERM_HISTORY` / `TERM_OUTPUT` / `SWITCH_ACK` / `LIVE_RESUME`，`ws-borsh-history.spec.ts` / `ws-borsh-switch-barrier.spec.ts` / `ws-borsh-pane-route.spec.ts` 必须改成 canonical screen/history transaction + cursor/rebase。
3. mesh failover 后不再重放 `TMUX_SELECT`；如果 e2e 依赖「切链路后焦点自动恢复」，需要改成由 FE 重新声明。

## 十、需要指挥官处理

1. **超出任务书 scope 但不改就做不成的文件**（均无其它 agent 认领，改动很小）：
   - `apps/gateway/src/tmux-client/metadata-projection.ts`、`metadata/hierarchy-builder.ts`、`metadata/hierarchy-fields.ts`、`device-session-runtime.ts`：任务书写的是 `runtime/event-bridge.ts` 是「metadata 投影生产者」，实际生产者是 hierarchy-builder + MetadataProjection（L1a 的结果文档也是这么写的）。
   - `apps/gateway/src/mesh/failover-log.ts`(+test)、`mesh/forwarder-failover.ts`：`legacyReplayStats()` 删掉后这三处编译不过，只做了删 `replayBytes` 字段的最小改动。
   - `apps/gateway/src/mesh/integration/mesh.integration.test.ts`（L3 的 scope）：只改了 1 处 `clientVersion: '1'` → `'1.1.23'`，否则该文件全挂。
   - `apps/gateway/src/mesh/forwarder.ts` 的 `log` / `sendToBrowser` / `closeBrowser` 由 `private` 改为公开（供 `rejectStaleNodeStream` 调用），行数不变。
2. **`git mv` 误操作**：重命名 `legacy-feed-broadcaster.ts` → `device-feed-broadcaster.ts` 时用了 `git mv`，该 rename 已进入 index（`git status` 显示 `R `）。工作区内容正确，提交前若要统一 `git add -A` 不受影响；如需干净的未暂存状态请自行处理。
3. **错误码建议**：本任务按任务书要求复用了 `ERROR_UNSUPPORTED_PROTOCOL (1001)` + 固定 message 前缀。若要给 FE 更稳的判定条件，建议后续在 `packages/shared/src/ws-borsh/errors.ts` 加一个专用码（如 `ERROR_CLIENT_TOO_OLD = 1006`）并把 `CANONICAL_V11_REQUIRED_PREFIX` 一并提到 shared。
4. **文档未动**：EX2 §A.5 列的 `docs/hub/*`、`docs/ws-protocol/2026021403-ws-state-machines.md`、`docs/terminal/*` 更新属于独立的「文档与 mesh 旧节点策略」分工，本任务未触碰。
5. **升级期风险**：1.1.23 的 entry 连 <1.1.22 的 node 会直接断流（这是设计要求，fail-closed 不回退）。发版时需保证 hub/node 同步升级，或在发布说明里写明。
