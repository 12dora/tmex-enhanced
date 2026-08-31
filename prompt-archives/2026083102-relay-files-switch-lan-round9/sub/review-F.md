结论：发现 3 个 blocker、1 个 should-fix。现有相关测试为 50 pass / 0 fail，但未覆盖以下事件序列。

## 1. Blockers

### B1. 自动重连没有被视为流中断，隐藏 pane 仍可 warm，当前 pane 也可能跳过重建

位置：[terminal-stage.tsx:243](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/terminal-stage.tsx:243)、[tmux-device-events.ts:71](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/tmux-device-events.ts:71)、[tmux-event-router.ts:102](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/tmux-event-router.ts:102)、[tmux-selection-actions.ts:97](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/tmux-selection-actions.ts:97)

`KeepAliveTerminalStack` 只用 `!deviceConnected` 调用 `invalidateKeepAliveStream`，但网关自动重连开始时只发送 `device-event(errorType: reconnecting)`；store 仅写入 `deviceReconnecting`，保留 `deviceConnected=true`。因此实际流已经断开时：

- 隐藏 pane 不会被移出池，仍保有 warm 资格。
- 旧 select transaction 没有被清理。
- 重连成功后，`maybeReselectCurrentPane` 遇到旧 transaction 会直接返回。

具体场景：A 可见、B 隐藏且已保活；SSH 控制连接断开并在 1 秒后重连。重连期间 A/B 都漏掉输出，但池仍认为二者有效。重连后即使 A 得到冷修复，切回 B 仍发送 `wantHistory:false`，直接显示断线前缓冲；若旧 transaction 尚在，A 也不会被重新 select。

最小修复：在收到 `reconnecting` 时统一执行设备流中断处理：清理 select machine、取消 retry/reset gap ledger，并让 UI 的 `deviceConnected` 进入 false，或显式把 `isReconnecting` 传入 `invalidateKeepAliveStream`。最终 `device-event(disconnected)` 也必须调用 `selection.handleDeviceDisconnected` 并清空 reconnecting 状态。增加真实事件链测试：`connected → reconnecting → reconnected`，断言隐藏池被丢弃且 legacy 当前 pane 必定冷 select。

### B2. `settleRepair` 会把 output-gapped transaction 误判为修复成功

位置：[select-pane-dispatch.ts:43](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/select-pane-dispatch.ts:43)、[pane-stream-gaps.ts:95](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/pane-stream-gaps.ts:95)、[state-machine.ts:362](/Users/konata/code/tmex-enhanced-wt-r9/packages/ws-client/src/state-machine.ts:362)、[state-machine.ts:417](/Users/konata/code/tmex-enhanced-wt-r9/packages/ws-client/src/state-machine.ts:417)

“transaction 消失且没有 `onSelectFailed`”并不等价于权威 history 已落地。输出门控溢出时，状态机会：

1. 设置 `outputGapped` 并请求异步 rebase。
2. 跳过 history reset/apply。
3. 收到 `LIVE_RESUME` 后正常删除 transaction，不触发失败回调。

下一次 select 执行 `settleRepair(deviceId, false)` 时会立即清除 gap，即使 rebase snapshot 尚未返回。

具体场景：A 已有 gap并进行冷修复；修复期间输出门控溢出；transaction 完成但 rebase 仍在途；切到 B 时 A 的 gap 被清除，马上切回 A 会走 warm，显示尚未修复的残缺屏幕。直接状态机复现得到：`rebase:resource_exhausted`、transaction 为 null，同时 `settleRepair` 将 gap 从 true 清成 false。

最小修复：不要从 transaction 是否存在推断成功。增加显式的成功结果回调/token，只有 clean history commit 后才清 repair；`outputGapped`、`cancelTransaction`、`cleanup`、`abandonPane` 都保留 gap。保守方案也可以在 rebase-required 时中止 repair并保持 gap，直到后续冷 select 成功。

### B3. 快照删除不会淘汰隐藏终端，死 pane 可以重新获得 warm 资格

位置：[terminal-keep-alive.ts:39](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/terminal-keep-alive.ts:39)、[terminal-stage.tsx:185](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/terminal-stage.tsx:185)、[terminal-stage.tsx:139](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/terminal-stage.tsx:139)

池只根据导航和设备 ID 更新，从不接收当前快照的 live pane 集合。`handleSnapshotPaneRemoval` 仅裁剪 gap ledger；隐藏 Terminal、sink、subscription、binder 和 warm 状态都继续存在。

具体场景：单屏模式依次查看 A、B、A，然后 B 被 tmux 侧关闭。B 仍挂载并被认为 retained。之后深链回 B 时，`retainKeepAlivePane` 将它标成 warm，旧终端内容立即可见且发送 `wantHistory:false`；路由失效宽限期内会展示陈旧内容。若 tmux 重启后 `%B` 被新 pane 复用，旧 buffer 会继续用于新 pane，legacy 路径不会 history reset。

最小修复：把确认过的 pane 删除和 session/stream generation 纳入池身份；快照确认删除时必须卸载对应槽位并让再次出现的同 ID 使用新 React key、冷启动。不要仅按字符串 pane ID 复用。补充“隐藏 pane 删除后深链”和“session 变化后 pane ID 复用”测试。

## 2. Should fix

### S1. 已排队的 report-mode resize 可在实例隐藏后继续发送

位置：[useTerminalResize.ts:103](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/useTerminalResize.ts:103)、[terminal-stage.tsx:264](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/terminal-stage.tsx:264)

调度器保存的回调闭包捕获旧 `gate.sizingMode='report'`；切换后改成 `local` 不会同步取消该任务，handlers ref 也只在 passive effect 更新。若旧 RAF 在 passive effects 前执行，隐藏 pane 仍会调用原来的 `handleResize`/`handleSync`，产生一次 tmux resize。

最小修复：执行时从同步更新的 latest ref 读取 gate 和 handlers，或在 visibility/sizingMode 变化的 layout phase 取消旧调度。增加 fake scheduler 测试：report 模式排队、切为 local、再触发任务，断言不发送任何 handler。

## 3. Nits

无。