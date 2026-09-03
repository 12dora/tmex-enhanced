基于当前 HEAD `3627047b` 的只读检查，以下路径和行号均为当前工作区现状；未修改任何文件。

## A. 下线 legacy terminal state stream

### 1. v1 无法区分尺寸补发与尺寸变更

三层代码目前都丢失了语义：

- legacy 两个 schema 完全相同：  
  `packages/shared/src/ws-borsh/schema.ts:249-256`  
  `TERM_RESIZE` 和 `TERM_SYNC_SIZE` 都只有 `deviceId / paneId / cols / rows`。
- canonical `ResizePane` 也只有相同几何字段：  
  `packages/shared/src/ws-borsh/canonical-state.ts:116-121`。
- FE/store 仍产生两种逻辑命令：  
  `packages/stores/src/tmux-viewport-actions.ts:23-33`。
- ws-client 在 canonical 模式下明确把两个尺寸命令排除在 canonical 外：  
  `packages/ws-client/src/websocket-transport.ts:37-41,237-251`。
- legacy 编码器仍分别生成两个 kind：  
  `packages/ws-client/src/message-builder.ts:178-205`。
- gateway 两个 handler 最终都调用同一个 `handleTermResize`：  
  `apps/gateway/src/ws/tmux-viewport-handlers.ts:31-40`；  
  `apps/gateway/src/ws/tmux-geometry-handlers.ts:107-127`。
- canonical gateway 回调只有四个尺寸参数，没有 reason/epoch：  
  `apps/gateway/src/ws/index.ts:370-374`；  
  `apps/gateway/src/ws/canonical-feed-session.ts:438-466`。

因此“无法区分”不是尺寸值无法区分，而是 wire payload 和 gateway callback 中没有表达“这是新的浏览器视口”还是“暖切换/重连后的尺寸补发”。当前暖切换仅通过 `wantHistory=false` 间接触发：

- `apps/gateway/src/ws/tmux-selection-handlers.ts:117-136`
- `apps/gateway/src/ws/tmux-selection-handlers.ts:128`
- `apps/gateway/src/ws/tmux-geometry-handlers.ts:266-280`

对应近期提交：

- `39318f94`：canonical v1 暂不能表达两类 resize，所以保留 legacy。
- `4c7b5274`：通过 `skipResize`、`distrustLive` 区分浏览器视口声明和暖切换。
- `b220286d`：`liveWindowGeometry` 已迁移到 `apps/gateway/src/ws/viewport-policy.ts:195-209`。

### 2. canonical v1.1 建议

保留 v1 schema 不变，在同一文件增加独立 v1.1 schema：

`packages/shared/src/ws-borsh/canonical-state.ts:116-147`

建议：

```ts
CanonicalResizePaneV11Schema = b.struct({
  requestId: b.bytes(16),
  pane: CanonicalPaneTargetSchema,
  rows: b.u16(),
  cols: b.u16(),
  geometryReason: b.u8(), // 0=change，1=resend/reconcile
  sizeEpoch: b.u64(),
});
```

语义：

- `geometryReason=change`：真实浏览器/布局尺寸变化。
- `geometryReason=resend`：暖切换、重连、重新声明当前尺寸。
- `sizeEpoch`：真实尺寸变化时递增；同一次补发/重试复用原 epoch。
- gateway 按 epoch 丢弃过期尺寸；`resend` 才允许采用“不信任旧快照几何”的逻辑。

不要把 `1.1` 直接编码进现有 `u16 protocolVersion`。建议使用：

- canonical wire version `1`：现有 v1。
- canonical wire version `2`：canonical v1.1。
- 外层 envelope 版本仍保持 `CURRENT_VERSION=1`：  
  `packages/shared/src/ws-borsh/schema.ts:8-15`、`packages/shared/src/ws-borsh/codec.ts:25-27`。

需要同步修改：

- schema、类型、encode/decode、fast peek：  
  `packages/shared/src/ws-borsh/canonical-state.ts:12,136-147,264-388`
- barrel export：  
  `packages/shared/src/ws-borsh/index.ts:70-124`
- canonical gateway session：  
  `apps/gateway/src/ws/canonical-feed-session.ts:438-466`
- gateway viewport policy：  
  `apps/gateway/src/ws/index.ts:370-374`、  
  `apps/gateway/src/ws/tmux-geometry-handlers.ts:251-280`
- 规范文档：  
  `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md:709-747`  
  应新增 v1.1 小节，旧 v1 小节保持冻结。

现有协商机制：

- C2S 已发送 `clientVersion`：  
  `packages/shared/src/ws-borsh/schema.ts:24-30`、  
  `packages/ws-client/src/client.ts:510-525`
- S2C 已发送 `serverVersion / selectedVersion / capabilities`：  
  `packages/shared/src/ws-borsh/schema.ts:32-39`、  
  `apps/gateway/src/ws/index.ts:519-553`
- canonical capability 当前只有：  
  `packages/shared/src/capabilities.ts:1-6`
- 客户端根据 capability 选择 canonical：  
  `packages/ws-client/src/client.ts:425-445`
- 现有版本门槛只有 `TERM_VIEWPORT_MIN_SERVER_VERSION=1.1.7`：  
  `packages/ws-client/src/server-features.ts:1-15`

建议：

1. 新增 `canonical-state-v1.1` capability。
2. gateway 只有自身版本 `>=1.1.22` 时才播报该 capability。
3. gateway 保存并校验 `HELLO_C2S.clientVersion`；客户端版本 `<1.1.22` 直接拒绝 canonical session。
4. `selectedVersion` 继续表示外层 WS 协议版本，不复用它表达 canonical 版本。
5. 若必须显式广告支持版本，再新增独立的 HELLO 扩展字段或 feature kind；不要破坏旧 `HelloC2SSchema` 的字段顺序。
6. `server-features.ts` 中对 canonical 版本应 fail-closed；当前“无法解析版本则按新版处理”的策略只适合旧 `TERM_VIEWPORT` 兼容，不适合 legacy 删除后的 canonical v1.1。

### 3. legacy 删除/改造清单

#### shared

需要删除 wire kind、schema 和发送侧：

- `packages/shared/src/ws-borsh/kind.ts`，210 行  
  kind 定义：`26-27,45-48,54-55`；  
  `VALID_KINDS`：`103-104,119-122,126-127`；  
  名称表：`168-169,184-187,191-192`。
- `packages/shared/src/ws-borsh/index.ts`，293 行  
  legacy kind export：`26-27,42-50`。
- `packages/shared/src/ws-borsh/schema.ts`，652 行  
  `TMUX_FETCH_PANE_HISTORY`：`148-175`；  
  `TermResize/TermSyncSize/TermHistory`：`249-293`；  
  `SwitchAck/LiveResume`：`303-316`；  
  `StateSnapshot/StateSnapshotDiff`：`362-373`。
- `packages/shared/src/ws-borsh/codec.ts`，338 行  
  `TERM_OUTPUT` fused encoder：`20-21,126-142`。
- `packages/shared/src/ws-borsh/codec-fused.test.ts`，230 行  
  `TERM_OUTPUT` 测试：`16,32`。

不要直接删除：

- `packages/shared/src/ws-borsh/state-snapshot-diff.ts`，144 行
- `packages/shared/src/ws-borsh/convert.ts:234-322`

这些仍被内部 metadata projection 使用：

- `apps/gateway/src/tmux-client/runtime/event-bridge.ts:33-45`
- `packages/ws-client/src/canonical-metadata-identity.ts:41-96,181-203`
- `packages/stores/src/tmux-event-router.ts:169-188`

应先将其内部类型重命名为 canonical metadata projection，或改为 canonical record 结构，再删除 legacy wire encode/decode。

#### gateway

可整文件删除：

- `apps/gateway/src/ws/borsh/switch-barrier.ts`，482 行
- `apps/gateway/src/ws/borsh/switch-barrier.test.ts`，430 行

混合文件中的删除段：

- `apps/gateway/src/ws/legacy-feed-broadcaster.ts`，437 行  
  observer：`70-117,393-437`；  
  snapshot/diff/output/history：`201-289,312-354`。  
  通用事件、错误、剪贴板逻辑仍需保留。
- `apps/gateway/src/ws/tmux-command-handlers.ts`，381 行  
  subscribe/history：`22-50,248-313`。
- `apps/gateway/src/ws/tmux-kind-handlers.ts`，166 行  
  subscribe/history handler：`10-20,97-102`。
- `apps/gateway/src/ws/tmux-selection-handlers.ts`，179 行  
  屏障和 observer：`75-100`；保留底层 tmux focus/select，或迁移到 canonical SelectPane。
- `apps/gateway/src/ws/tmux-viewport-handlers.ts`，49 行  
  `TERM_RESIZE/TERM_SYNC_SIZE`：`31-40`。
- `apps/gateway/src/ws/tmux-geometry-handlers.ts`，356 行  
  继续保留 viewport policy；将 `reason/epoch` 接入 `143-192,251-280`。
- `apps/gateway/src/ws/device-connection-registry.ts`，394 行  
  `syncLegacyPaneObservers`、legacy snapshot、释放 observer：`237-250,257-271`。
- `apps/gateway/src/ws/index.ts`，870 行  
  canonical 仍接收 legacy overlay snapshot：`342,350-362`；  
  resize callback：`370-374`；  
  legacy output：`609-640`；  
  legacy metadata/snapshot runtime listener：`729-744`；  
  observer wrapper：`770-775`。
- `apps/gateway/src/ws/borsh/codec-borsh.ts`，116 行  
  `TERM_OUTPUT/TERM_HISTORY/SWITCH_ACK/LIVE_RESUME`：`36-61`。
- `apps/gateway/src/ws/websocket-send-guard.ts`，442 行  
  legacy `TERM_OUTPUT` recoverable 分支：`400-406`。
- `apps/gateway/src/ws/borsh/session-state.ts`，588 行  
  只删除 select transaction/output buffering；bell/notification throttle 状态需保留：`59-109,280-462`。

mesh：

- `apps/gateway/src/mesh/stream-replay-state.ts`，826 行  
  legacy subscribe/select/replay：`107-120,168-223,587-626`。
- `apps/gateway/src/mesh/stream-replay-state.test.ts`，848 行  
  mixed legacy snapshot：`750-796`。
- `apps/gateway/src/mesh/integration/stream-failover.integration.test.ts`，840 行  
  legacy failover：`293-305,804-835`。
- `apps/gateway/src/mesh/forwarder.test.ts`，1968 行  
  legacy snapshot helper/断言：`814-834,1762-1764`。

需删除或重写的 gateway 测试：

- `apps/gateway/src/ws/legacy-observer-wiring.test.ts`，338 行：整个测试集。
- `apps/gateway/src/ws/switch-barrier.issue45.test.ts`，129 行：整个测试集。
- `apps/gateway/src/ws/issue45-cross-bug.test.ts`，230 行：`134-230`。
- `apps/gateway/src/ws/tmux-command-handlers.test.ts`，293 行：history/selection 部分 `93-205,226-293`。
- `apps/gateway/src/ws/device-connection-registry.test.ts`，237 行：observer 断言。
- `apps/gateway/src/ws/borsh/index.test.ts`，402 行：history/transaction 部分 `110-124,157-201,257`。
- `apps/gateway/src/ws/index.test.ts`，2067 行：legacy selection/output 部分 `520,635-758,1014`。
- `apps/gateway/src/ws/websocket-send-guard.test.ts`，447 行：`TERM_OUTPUT` 相关 `339`。
- `apps/gateway/src/ws/legacy-feed-broadcaster.test.ts`，77 行：snapshot/output 测试需重写或删除。
- `apps/gateway/src/ws/legacy-event-delivery.test.ts`，78 行：通用事件 throttle 测试保留并去掉 legacy 命名。

#### ws-client

可整文件删除：

- `packages/ws-client/src/state-machine.ts`，781 行
- `packages/ws-client/src/pane-history-gate.ts`，131 行

混合/改造：

- `packages/ws-client/src/websocket-transport.ts`，392 行  
  `LEGACY_STATE_KINDS` 和 legacy overlay：`28-41,207-235`；  
  canonical-only send path：`237-259`。
- `packages/ws-client/src/transport-message-decoder.ts`，227 行  
  删除 `STATE_SNAPSHOT/DIFF/SWITCH_ACK/TERM_HISTORY/LIVE_RESUME/TERM_OUTPUT` 解码：`73-137`。
- `packages/ws-client/src/transport-types.ts`，278 行  
  删除 `selection-ack/legacy-history/live-resume/terminal-data`：`85-103`；保留 canonical screen/history。
- `packages/ws-client/src/message-builder.ts`，380 行  
  删除 `buildTermResize/buildTermSyncSize`：`178-205`。
- `packages/ws-client/src/transport-command-encoder.ts`，136 行  
  删除旧 resize/history/subscribe 编码；`select-pane` 当前仍退回 `TMUX_SELECT`：`61-127`，需先决定 canonical SelectPane。
- `packages/ws-client/src/canonical-state-client.ts`，740 行  
  resize 映射：`300-302,385-395`；  
  legacy overlay snapshot：`248-255`。  
  overlay 必须先迁移到 canonical metadata。
- `packages/ws-client/src/pane-sink-registry.ts`，420 行  
  删除 `onReset/onApplyHistory/historyGates` legacy 部分：`4-7,13,22-43,107-174,289-342`；保留 canonical screen/history：`213-269`。
- `packages/ws-client/src/connection.ts`，202 行  
  删除 `selectMachine`：`120,159-192`。
- `packages/ws-client/src/index.ts`，134 行  
  删除 `state-machine` export：`82-100`，以及旧 message builder export：`102-134`。
- `packages/ws-client/src/client.ts`，825 行  
  去掉 `legacy` feed mode 和 canonical kill switch 的兼容分支：`88-102,127-139,197-225,425-445`。

对应测试：

- `packages/ws-client/src/state-machine.test.ts`，561 行：整文件删除。
- `packages/ws-client/src/pane-sink-registry.test.ts`，669 行：legacy gate/reset/history 部分删除，canonical screen/history 部分保留。
- `packages/ws-client/src/transport-message-decoder.test.ts`，309 行：`39-120,180-196,300-309`。
- `packages/ws-client/src/protocol-dispatcher.test.ts`，154 行：legacy output/history：`66-69,109,142-149`。
- `packages/ws-client/src/client.test.ts`，1362 行：`TERM_HISTORY` chunk：`360-411`。
- `packages/ws-client/src/pending-send-queue.test.ts`，112 行：legacy resize kind：`95`。
- `packages/ws-client/src/websocket-canonical-gate.test.ts`，345 行：重写为 canonical v1.1 reason/epoch：`300-332`。

#### stores / terminal-ui / FE

虽然用户将其归类为 FE，实际状态层在 `packages/stores`：

可整文件删除：

- `packages/stores/src/pane-stream-gaps.ts`，169 行
- `packages/stores/src/select-transaction-observers.ts`，58 行

混合改造：

- `packages/stores/src/tmux-event-router.ts`，322 行：legacy history/live/output：`194-243`。
- `packages/stores/src/tmux-selection-actions.ts`，209 行：`72-83,100-195`。
- `packages/stores/src/select-pane-dispatch.ts`，81 行：`52-67`。
- `packages/stores/src/pane-subscriptions.ts`，121 行：legacy gate fallback：`78-105`。
- `packages/stores/src/runtime.ts`，354 行：`29-33,93-120,167-173,265-316`。
- `packages/stores/src/tmux.ts`，222 行：select machine 初始化：`88-109`。
- `packages/stores/src/tmux-device-actions.ts`，109 行：select machine cleanup：`66`。
- `packages/stores/src/tmux-device-events.ts`，177 行：select cleanup：`87`。

stores 测试需重写：

- `packages/stores/src/pane-stream-gaps.test.ts`，163 行
- `packages/stores/src/tmux-event-router.test.ts`，749 行
- `packages/stores/src/tmux-selection-warm.test.ts`，506 行
- `packages/stores/src/tmux-selection-drop.test.ts`，232 行
- `packages/stores/src/tmux-reselect-retry.test.ts`，199 行
- `packages/stores/src/tmux-device-events.test.ts`，376 行
- `packages/stores/src/tmux-reorder.test.ts`，175 行
- `packages/stores/src/runtime-core-resolution.test.ts`，255 行

terminal-ui：

- `packages/terminal-ui/src/components/terminal-snapshot.ts`，198 行  
  删除 legacy 类型、几何恢复和 `writeRestoredHistory`：`136-192`；  
  保留 canonical `writeCanonicalSnapshot` 及其 `forceFullRepaint`：`115-134`。
- `packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts`，162 行  
  删除远端 legacy geometry、`onReset/onApplyHistory`：`24-87`；  
  保留 canonical screen/history：`88-161`。
- `packages/terminal-ui/src/components/terminal-snapshot.test.ts`，341 行  
  删除/改写 legacy 测试：`281-341`。
- `packages/terminal-ui/src/components/SplitTerminalArea.tsx`，255 行  
  只更新旧 `TERM_RESIZE` 语义注释：`39`。

`forceFullRepaint` 不能全局删除；canonical 快照仍需要它，真正应删除的是 legacy `writeRestoredHistory` 的调用和 `terminal-snapshot.ts:191`。

FE 生产源码没有直接引用 `TERM_HISTORY/LIVE_RESUME`。需要改写的是 e2e：

- `apps/fe/tests/helpers/ws-borsh.ts`，422 行：删除 kind 常量和处理逻辑：`44-47,276,309-319`。
- `apps/fe/tests/ws-borsh-history.spec.ts`，92 行：`69-90` 改为 canonical screen/history transaction。
- `apps/fe/tests/ws-borsh-pane-route.spec.ts`，88 行：`86` 改为 canonical target/metadata/PaneData。
- `apps/fe/tests/ws-borsh-switch-barrier.spec.ts`，252 行：`82-181` 改为 canonical generation、subscription、cursor/rebase 测试。

### 4. legacy snapshot overlay 风险

当前 canonical 客户端仍会收到 legacy `STATE_SNAPSHOT`：

- gateway：`apps/gateway/src/ws/index.ts:350-362`
- client：`packages/ws-client/src/websocket-transport.ts:221-230`
- consumer：`packages/ws-client/src/canonical-state-client.ts:248-255`

它用于补充 tree order/custom names。必须先把这些信息完整纳入 canonical `SourceMetadataRecord/Patch`，否则删除 `STATE_SNAPSHOT` 后设备树顺序和自定义名称会回归。

### 5. mesh 旧节点风险

`entry↔node` 当前仍支持两套 replay：

- canonical cursor replay：`apps/gateway/src/mesh/stream-replay-state.ts:628-688`
- legacy `TMUX_FETCH_PANE_HISTORY → TERM_HISTORY → TERM_OUTPUT`：`587-626`
- 设计文档也明确写了两套：  
  `docs/hub/2026082800-hub-node-operations.md:232`

1.1.22 entry 连接旧 node 时，旧 node 无法理解 canonical v1.1；而 legacy stream 又将被删除，不能静默降级。建议在 browser↔entry 和 entry↔node 两层都执行最低版本门槛：

- 对端 `<1.1.22`：拒绝 canonical stream，标记 peer 不可用。
- 不要回退到 legacy state stream。
- 更新 `stream-replay-state` 的状态机和 failover 测试。
- 更新以下旧文档：  
  `docs/hub/2026082700-hub-node-architecture.md:11,239`、  
  `docs/ws-protocol/2026021403-ws-state-machines.md:29-35,106-195`、  
  `docs/terminal/2026021404-terminal-switch-barrier-design.md:31-38,77-90,113-118`、  
  `docs/terminal/2026090101-viewport-policy.md:5-30`。

建议 A 的非重叠分工：

1. shared schema + capability/version：`packages/shared/src/ws-borsh/*`、`packages/shared/src/capabilities.ts`、WS spec。
2. gateway feed/replay：`apps/gateway/src/ws/*`、`apps/gateway/src/mesh/*`。
3. ws-client/stores：`packages/ws-client/src/*`、`packages/stores/src/*`。
4. terminal-ui + FE e2e：`packages/terminal-ui/src/*`、`apps/fe/tests/*`。
5. 文档与 mesh 旧节点策略：`docs/hub/*`、`docs/ws-protocol/*`、`docs/terminal/*`。

## B. 替换 `tailwind-merge`

### 1. 使用量和定义位置

当前 HEAD 扫描结果：

| 包 | `cn()` 原始出现次数 | 扣除定义后的调用次数 |
|---|---:|---:|
| `packages/ui` | 99 | 98 |
| `packages/panels` | 74 | 74 |
| `packages/terminal-ui` | 1 | 1 |
| `apps/fe` | 22 | 22 |
| 合计 | 196 | 195 |

round22 归档记录的是 194 个调用点；当前树比归档多 1 个调用点。

定义只有一处：

- `packages/ui/src/utils.ts:1-5`
- `packages/ui/src/utils.test.ts:4-7`
- `packages/ui/package.json:14-20`

实现为 `twMerge(clsx(inputs))`，且测试明确依赖后者覆盖前者：

```ts
cn('p-2', 'p-4') === 'p-4'
```

`twMerge`/`clsx` 没有其他独立实现或调用。

### 2. 完整命中文件

`packages/ui`：

`alert-dialog-impl.tsx`、`badge.tsx`、`button.tsx`、`card.tsx`、`checkbox.tsx`、`collapsible.tsx`、`context-menu.tsx`、`dialog-impl.tsx`、`dropdown-menu-impl.tsx`、`icon-tooltip.tsx`、`input.tsx`、`motion.tsx`、`otp-input.tsx`、`progress.tsx`、`scroll-area.tsx`、`select.tsx`、`separator.tsx`、`sheet-impl.tsx`、`sidebar/sidebar-layout.tsx`、`sidebar/sidebar-menu.tsx`、`sidebar/sidebar-primitives.tsx`、`sidebar/sidebar-provider.tsx`、`skeleton.tsx`、`switch.tsx`、`tabs.tsx`、`textarea.tsx`、`tooltip-impl.tsx`、`utils.ts`。

`packages/panels`：

`agent/agent-binding-status.tsx`、`agent/chat-thread.tsx`、`agent/messages/assistant-message.tsx`、`agent/messages/reasoning-block.tsx`、`agent/messages/tool-call-card.tsx`、`agent/messages/user-message.tsx`、`agent/model-picker.tsx`、`code-viewer/code-viewer.tsx`、`device-console/command-input-collapse.tsx`、`device-folders/device-folder-tree.tsx`、`device-folders/draggable-item.tsx`、`device-folders/folder-section.tsx`、`device-management/device-card-connect-toggle.tsx`、`device-management/device-card.tsx`、`device-management/device-grid.tsx`、`device-management/device-management-panel.tsx`、`device-status-badge.tsx`、`device-tree/device-actions-menu.tsx`、`device-tree/device-connection-control.tsx`、`device-tree/device-row-header.tsx`、`device-tree/device-row.tsx`、`device-tree/device-tree-row-shell.tsx`、`device-tree/node-badge.tsx`、`device-tree/pane-row-content.tsx`、`device-tree/window-row-header.tsx`、`files/directory-node-view.tsx`、`files/files-node-roots.tsx`、`files/files-node-section.tsx`、`files/files-tab.tsx`、`markdown/markdown-preview.tsx`、`markdown/streaming-markdown.tsx`、`settings/ShortcutButtonRow.tsx`、`settings/directory-picker-modal.tsx`、`settings/shortcut-add-panel.tsx`、`settings/shortcut-list.tsx`、`settings/terminal-settings-panel.tsx`、`settings/weixin-account-row.tsx`、`watch/watch-rule-form.tsx`。

`packages/terminal-ui`：

- `packages/terminal-ui/src/components/TerminalPreview.tsx`

`apps/fe`：

- `apps/fe/src/components/page-layouts/components/agent-session-row.tsx`
- `apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx`
- `apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx`
- `apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx`
- `apps/fe/src/node/device-node-badges.tsx`
- `apps/fe/src/page-wrapper.tsx`
- `apps/fe/src/pages/SettingsPage.tsx`
- `apps/fe/src/pages/settings/nodes/management/hub-strip.tsx`

### 3. 体积

当前工作区没有 `node_modules`，也没有 `apps/fe/dist/stats.html`，无法现场读取包体积。

round22 的实测记录：

- `tailwind-merge@3.4.0`：约 94 KB rendered。
- 删除后的 gzip 节省：`7,756 B`。
- 证据：`prompt-archives/2026090303-round22-perf-tui-color-smell/sub/EX5-slimming.md:80,102,284`。
- FE treemap 配置：`apps/fe/vite.config.ts:49-57`。
- 当前入口 JS gzip 预算：`apps/fe/scripts/check-bundle-budget.ts:7-8`。

### 4. 是否依赖冲突合并语义

依赖，不能直接替换成裸 `clsx`。明确高风险点：

- `packages/ui/src/utils.test.ts:5-6`：`p-2` 与 `p-4`。
- `packages/ui/src/components/card.tsx:73`：`px-4` 与 `className`。
- `packages/ui/src/components/select.tsx:13,101,135`：padding/margin 与调用方覆盖。
- `packages/ui/src/components/sheet-impl.tsx:94,104,114,124`：padding、text/color 覆盖。
- `packages/ui/src/components/sidebar/sidebar-primitives.tsx:14,25,36,47,72,131`。
- `packages/ui/src/components/sidebar/sidebar-menu.tsx:16,27,73,165,201`。
- `packages/ui/src/components/dialog-impl.tsx:79,112`、`tabs.tsx:16,46`、`dropdown-menu-impl.tsx:231`。
- `packages/panels/src/code-viewer/code-viewer.tsx:74,81`：`py-2`/container 覆盖。
- `packages/panels/src/markdown/markdown-preview.tsx:107,170`、`streaming-markdown.tsx:185,243`。
- `packages/panels/src/agent/chat-thread.tsx:191,201`。
- `apps/fe/src/pages/SettingsPage.tsx:160`：`px-3.5` 覆盖基础 tab padding。
- `apps/fe/src/components/page-layouts/components/agent-session-row.tsx:83,95`：移动端 `h-5/w-5` 覆盖 `h-4/w-4`。

建议：

- 不采用只做“同前缀后者覆盖”的不完整自定义 merge。
- 优先保留一个极小、明确测试过的 merge 实现，覆盖 padding/margin/color/background/border/gap/width/height、variant、负值、任意值和 `!important`。
- 或逐调用点消除冲突后改为 `clsx`；但这是更大的人工审计。

最高风险页面检查清单：

1. Settings tabs、dialog、alert-dialog、sheet、dropdown、select。
2. Sidebar、设备树、window/pane tree、文件树。
3. Agent chat、Markdown、code viewer。
4. TerminalPreview。
5. 移动端 sidebar、node badges、agent session row。

## C. 删除三个仅测试使用的路由

### 1. `GET /api/tmux/tree`

handler：

- `apps/gateway/src/api/tmux-tree.ts`，75 行
- 路由入口：`20-29`
- 树查询：`32-75`
- 挂载：`apps/gateway/src/api/system-routes.ts:11,57-63`
- 聚合：`apps/gateway/src/api/index.ts:18,24-28`

测试：

- `apps/gateway/src/api/tmux-tree.test.ts`，235 行
- 路由测试：`115-235`
- 直接请求：`117,132,147,161,170,174,180-188,220`

额外调用者：

- `scripts/hub-e2e/driver/files.ts:34-43` 的 `tmux-tree` 命令也依赖它，应删除该 e2e driver 命令或改用 WS/canonical metadata。
- `packages/api-client`：无对应函数。
- `apps/fe/src`：无生产调用者。
- `apiError.deviceNotFound` 不能删除，仍被其他 API 使用：  
  `apps/gateway/src/api/device-routes.ts:64,113,155` 等。

### 2. `/api/settings/theme`

实际方法是 `GET` 和 `POST`，不是 PUT：

- handler：`apps/gateway/src/api/theme.ts`，52 行
- GET：`9-15,22-25`
- POST：`16-18,27-52`
- 路由挂载：`apps/gateway/src/api/settings-routes.ts:23,114-118`

测试：

- `apps/gateway/src/api/theme.test.ts`，122 行
- route tests：`31-104`
- DB constraint 测试：`106-122`，删除 route 时应迁移到 DB 测试，不能丢失。

当前 FE e2e 直接请求：

- `apps/fe/tests/theme-broadcast.spec.ts:9,77,101,113,133,173,191,217`
- `apps/fe/tests/theme-notify-2031.spec.ts:71,118`
- `apps/fe/tests/ws-borsh-theme-resize.spec.ts:111,147`
- `apps/fe/tests/theme-propagation.spec.ts:18,74,98,110,130,148,168,205,241,264,279,286`
- `apps/fe/tests/theme-presets.spec.ts:54,84,94,118`

这些测试应统一通过 UI theme menu 或 WS `KIND_SITE_THEME_UPDATE` 完成 setup/cleanup；`theme-broadcast.spec.ts` 当前还专门断言 HTTP 不触发广播，删除路由后该负向测试应删除。

服务逻辑不能删除：

- `broadcastThemeChange`
- `broadcastSiteThemeUpdateS2C`
- `broadcastSettingsUpdate`
- `getSiteSettings`
- `updateSiteSettings`

它们仍被 WS theme broadcaster、site settings 和其他设置路由使用。

i18n 不需要删除：

- `packages/shared/src/i18n/core-keys.ts:22-24`
- FE 使用：`apps/fe/src/components/page-layouts/components/theme-menu.tsx:65-122`

文档需更新：

- `docs/ws-protocol/2026070402-site-theme-update.md:9`  
  删除“HTTP POST + 轮询”的历史方案描述，改为当前 WS 方案。

### 3. `POST /api/hub/nodes/:id/revoke`

handler：

- 路由：`apps/gateway/src/hub/hub-runtime.ts:790-795`
- forwarded dispatch：`573-586,625-630`
- 实际 handler：`908-941`

测试：

- `apps/gateway/src/hub/hub-runtime.test.ts`，2131 行  
  route suite：`1282-1361`；  
  writer rejection：`1944-1960`
- `apps/gateway/src/hub/writer-forward.test.ts`，304 行  
  route inventory：`122-129`
- `apps/gateway/src/mesh/integration/mesh.integration.test.ts`，1433 行  
  direct route：`684-715,905-946`

这些测试中 revoke-node 的业务覆盖不应全部删除；应改为调用现有：

- `POST /api/auth/keylog?hub=sync`
- `packages/api-client/src/auth/auth-api.ts:327-356`

生产 FE 没有直接调用该 hub revoke route：

- `apps/fe/src/pages/settings/nodes/management/use-node-row-actions.ts:38-75`
- `apps/fe/src/pages/settings/nodes/membership/self-revoke.ts:1-64`
- `apps/fe/src/node/enrollment.ts:525-559`

`revokeNodeRecord`、`revoke-node` key-log 类型、hub authorization、节点撤销状态都必须保留。

i18n revoke keys 仍被 UI 使用，不删除：

- `packages/shared/src/i18n/types.ts:1703-1704,1883,1893,1983-1993`
- FE 使用：`apps/fe/src/pages/settings/nodes/management/*`

文档需更新：

- `docs/hub/2026082700-hub-node-architecture.md:200`
- `docs/hub/2026090104-multi-hub-standby.md:133`

建议 C 的非重叠分工：

1. system/theme API：`apps/gateway/src/api/{tmux-tree,theme,system-routes,settings-routes}.ts`。
2. hub revoke：`apps/gateway/src/hub/hub-runtime.ts` 及 hub tests。
3. FE/e2e：`apps/fe/tests/*theme*`、`scripts/hub-e2e/driver/files.ts`。
4. 文档：`docs/hub/*`、`docs/ws-protocol/2026070402-site-theme-update.md`。

## D. bench 文件清理

当前共发现 15 个 benchmark 文件：

```text
apps/gateway/bench/control-output-pipeline.bench.ts       144
apps/gateway/bench/envelope-view.bench.ts                  42
apps/gateway/bench/frame-sizer.bench.ts                   127
apps/gateway/bench/pane-retention.bench.ts                 97
apps/gateway/bench/pane-stream-parser.bench.ts            195
packages/ghostty-terminal/bench/canvas.bench.mjs           365
packages/ghostty-terminal/bench/render-bridge.bench.ts    286
packages/ghostty-terminal/bench/write-vt.bench.ts           84
packages/panels/src/files/files-tree-render.bench.tsx     136
packages/shared/bench/canonical-validation.bench.ts        97
packages/shared/bench/legacy-snapshot-diff.bench.ts        76
packages/shared/bench/ws-wire-path.bench.ts               144
packages/stores/bench/agent-thread.bench.ts                96
packages/terminal-ui/bench/history-paging.bench.ts        181
packages/terminal-ui/bench/normalization.bench.ts          87
```

已有 package script、应保留：

- `apps/gateway/bench/pane-stream-parser.bench.ts`
- `apps/gateway/bench/frame-sizer.bench.ts`
- `apps/gateway/bench/pane-retention.bench.ts`
- scripts：`apps/gateway/package.json:12-14`

round22 新增、按 `.bench.ts/.bench.mjs` 口径应保留的 4 个：

- `apps/gateway/bench/control-output-pipeline.bench.ts`，144 行
- `apps/gateway/bench/envelope-view.bench.ts`，42 行
- `packages/ghostty-terminal/bench/canvas.bench.mjs`，365 行
- `packages/shared/bench/ws-wire-path.bench.ts`，144 行

round22 还新增了一个 `.tsx` benchmark：

- `packages/panels/src/files/files-tree-render.bench.tsx`，136 行
- commit：`4dbeb7b9`

它不匹配用户写的 `*.bench.ts`，但确实是 benchmark，当前没有 script/README 引用，应单独决定是否保留。

归档列出的 7 个旧无 script 文件，共 907 行：

- `packages/ghostty-terminal/bench/render-bridge.bench.ts`，286 行
- `packages/ghostty-terminal/bench/write-vt.bench.ts`，84 行
- `packages/shared/bench/canonical-validation.bench.ts`，97 行
- `packages/shared/bench/legacy-snapshot-diff.bench.ts`，76 行
- `packages/stores/bench/agent-thread.bench.ts`，96 行
- `packages/terminal-ui/bench/history-paging.bench.ts`，181 行
- `packages/terminal-ui/bench/normalization.bench.ts`，87 行

证据：

- `prompt-archives/2026090303-round22-perf-tui-color-smell/sub/EX5-slimming.md:183-185`
- 旧 bench 文档引用：`docs/performance/2026082700-hot-path-optimizations.md:18-27`

存在一个需求算术冲突：

- “删除 7 个旧文件”包括 `render-bridge.bench.ts`。
- “保留 render-bridge bench dir”又要求保留 `packages/ghostty-terminal/bench/` 中的 render-bridge。
- 当前 round22 实际新增文件是 5 个，而不是 4 个，因为还包括 `files-tree-render.bench.tsx`。

推荐最终执行口径：

- 保留 3 个已有 gateway scripted bench。
- 保留 4 个 round22 新 bench。
- 额外保留 `packages/ghostty-terminal/bench/render-bridge.bench.ts` 作为 render-bridge 例外。
- 删除其余 6 个旧无 script 文件：  
  `write-vt`、`canonical-validation`、`legacy-snapshot-diff`、`agent-thread`、`history-paging`、`normalization`。
- 对 `files-tree-render.bench.tsx` 单独拍板。

若严格执行“删除旧 7 个”，则 render-bridge 文件和该 bench 目录例外无法同时成立。