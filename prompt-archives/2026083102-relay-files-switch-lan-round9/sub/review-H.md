## 1. Blockers

### 1. Gateway WebSocket 重连没有标记所有 pane 的流缺口

位置：[packages/stores/src/tmux-event-router.ts:75](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/tmux-event-router.ts:75)

`connection-state` 离开 `READY` 时只更新连接状态，没有调用 `handleDeviceStreamInterrupted`。当前修复只覆盖 SSH 设备自身的 `error/reconnecting`，没有覆盖浏览器到 gateway 的 WebSocket 重连。

具体失败序列：

1. legacy WebSocket 模式下，pane A 可见、pane B 在保活池中隐藏。
2. gateway WebSocket 进入 `RECONNECT_BACKOFF`，期间 A、B 都漏掉输出。
3. 回到 `READY` 后订阅被重放；`device-connected` 只对当前 A 执行冷重选。
4. B 不在 gap ledger 中，重连后的新 live 输出直接追加到 B 的旧缓冲。
5. 切回 B 时 `isRetainedPane` 为真、`targetGapped` 为假，因此发送 `wantHistory:false`，展示缺少中间字节的非连续终端。

最小修复：记录前一连接状态，在已连接过的 transport 从 `READY` 离开时，遍历 `connectedDevices` 调用 `handleDeviceStreamInterrupted`，并清理对应 `paneSinks` 的 pending/gate。补一个 `READY → RECONNECT_BACKOFF → READY`、含隐藏 pane 的回归测试，断言隐藏 pane 再次选择必须请求 history。

### 2. 池级 generation 会重挂未变化的可见 Terminal

位置：

- [packages/panels/src/device-console/terminal-keep-alive.ts:91](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/terminal-keep-alive.ts:91)
- [packages/panels/src/device-console/terminal-keep-alive.ts:104](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/terminal-keep-alive.ts:104)
- [packages/panels/src/device-console/terminal-keep-alive.ts:130](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/terminal-keep-alive.ts:130)
- [packages/panels/src/device-console/terminal-stage.tsx:281](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/terminal-stage.tsx:281)

`generation` 属于整个池，却进入每个 pane 的 React key。因此删除一个隐藏 pane 或流恢复，都会重挂当前可见 pane。

具体失败序列：

- **隐藏 pane 删除：**移动端正在显示 B，A 隐藏保活；快照删除 A 后 generation 增加，B 的 key 也变化。路由身份未变，[select 去重直接跳过](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/use-pane-route-reconciliation.ts:77)，而 legacy Terminal 重挂后[不会主动请求首屏](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts:111)。B 因此丢失已有画面，只能从中途 live 字节继续，可能长期空白或乱码。

- **重连恢复：**重连期间旧内容确实保留，但 `isReconnecting` 清除后立即增加 generation，旧画面在冷 history 到达前被卸载，必然出现空白。更坏情况下 history 先落到尚未注销的旧 sink，新实例之后挂载时拿不到基线，会持续空白。

最小修复：删除隐藏 pane 时使用 pane 级 incarnation，只改变被删除/复用 ID 的 key；流恢复时保持当前 Terminal 挂载，让冷 select 的 reset/history 原子替换旧画面。若必须防止 tmux ID 复用，应在权威 history/snapshot 已暂存后换代，而不是在连接状态翻转时换代。现有纯函数测试反而明确断言了可见 key 改变，需要改成 DOM 生命周期测试。

## 2. Should fix

### 1. 观察器没有验证事务 token，且 overflow 完成后会遗留 repair 记录

位置：

- [packages/stores/src/select-transaction-observers.ts:21](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/select-transaction-observers.ts:21)
- [packages/stores/src/pane-stream-gaps.ts:131](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/pane-stream-gaps.ts:131)

观察器只检查事务状态和 `outputGapped`，没有验证事件 token 等于 `transaction.selectToken`。此外，history 已提交后若门控溢出，LIVE_RESUME 观察器直接返回，状态机正常结束且不会触发 `abortRepair`，对应 repair 记录会一直保留。

若之后另一个事务处于 `HISTORY_APPLIED`，重复或迟到的旧 LIVE_RESUME 可借用新事务的状态判定，匹配旧 repair token 并错误清除仍有缺口的 pane。

最小修复：两个观察器都显式比较事务 token；对 token 匹配但 `outputGapped` 的 LIVE_RESUME，执行 token-aware abort，只删除 repair 记录而保留 gap。

### 2. atomicScreen 路径创建的 gap 永远无法完成修复

位置：

- [packages/stores/src/tmux-selection-actions.ts:176](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/tmux-selection-actions.ts:176)
- [packages/stores/src/select-pane-dispatch.ts:56](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/select-pane-dispatch.ts:56)

流中断会无条件把所有 pane 加入 gap ledger，但 atomicScreen 路径不创建 select transaction，也不会经过 history/live observers。因此即使 canonical snapshot 已恢复画面，这些 gap 仍保留，之后所有 warm 请求都会永久退化成 `wantHistory:true`。

最小修复：atomicScreen 不使用 legacy gap ledger，或在 canonical snapshot 成功提交时显式清除对应 pane 的 gap。应补一次 atomic reconnect 后再次 warm 切换的测试。

## 3. Nits

无。

验证：相关 9 个测试文件共 134 个测试全部通过；上述失败路径目前均未被这些测试覆盖。