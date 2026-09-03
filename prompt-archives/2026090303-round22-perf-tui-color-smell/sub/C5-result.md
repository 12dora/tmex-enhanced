# C5 后端评审修复结果

## 完成内容

已完成 backend review finding 1–7：

1. WebSocket send guard 逐帧记录被跳过内容是否可由 screen 重建。仅 legacy `TERM_OUTPUT`（含其 chunk）和 canonical `PaneData` 全部可重建时发送 stream `SourceGap`；混入控制/元数据帧、废弃 stateful continuation 或 resync 被拒绝时终止连接并使用 `backpressure_gap`。`rejected` 当前帧也纳入缺口判定，4 MiB 硬限制保持不变。
2. 普通物化输出不再清除 cold-output dirty。成功存储 screen checkpoint 后才清；server epoch 变化、pane 删除继续清。每次 cold skip 都用当前 pane epoch 幂等更新 dirty，避免 pane epoch 轮换后漏报。已覆盖“seq 0 → cold 跳过 50 bytes → later 物化 → 旧 cursor 仍 `needsScreen=true`”回归。
3. 新增 `PeerReconnectWake` 小状态机。只有 breaker 已 disabled 后真实 live link 丢失、且没有同步 fallback，后续非 DC link 完成 quiesce 能力确认时才调用 `dcUpgrade.onPeerReconnected()`；首链、transport replacement、parked/retiring promotion 不误唤醒。同 endpoint 重连会立即重试；原 cooldown 不自动 redial 语义保持。
4. control-mode unescape 按活跃 line dispatch 深度租用 scratch，租约覆盖同步回调，修复 re-entry 将外层 `AB` 覆盖成 `AZ`。导出的 plain helper 每次返回 owned copy。
5. `canLoadNative` 从 app assemble 显式传到 mesh runtime 和 `RtcPeerManager`。`TMEX_DIRECT_ENABLED=false` 或无 nativeDir/注入 loader 时 `available` 立即为 false；启用但尚未加载时仍保持乐观。真实 RTC manager 可在 wake 前探测 native，结构型测试 fake 兼容缺少 `ready()` 的情况。
6. 共享 PID parser 新增显式 `allowNumericStringPid` 选项，默认 CLI 语义仍严格；gateway wrapper 开启兼容，重新接受 `{"pid":"1234"}`。
7. legacy/canonical leading-edge cooldown 表均增加一个 cooldown 后的惰性淘汰和 4096 key 上限；canonical device detach 同时清除对应 device 前缀时间戳。

相对评审“最小修复”的补强仍保持局部：finding 1 同时处理 legacy TERM_OUTPUT chunk、carrier `rejected` 与 SourceGap 拒绝；finding 3 将状态提取到独立文件并延迟至 quiesce ready 后唤醒，以满足复杂度门禁并保证“立即重试”不受旧 gate 影响。

## 变更文件

- WS：`apps/gateway/src/ws/websocket-send-guard.ts`、`websocket-send-guard.test.ts`、`index.ts`、`terminal-output-batcher.ts`、`terminal-output-batcher.test.ts`、`canonical/pane-stream.ts`、`canonical/pane-stream.test.ts`。
- tmux client：`runtime/event-bridge.ts`、`runtime/event-bridge.test.ts`、`device-session-runtime.ts`、`control-mode/unescape.ts`、`control-mode/unescape.test.ts`、`control-mode/notifications.ts`、`control-mode-subscription.test.ts`。
- mesh/RTC：`mesh/peer-manager.ts`、`mesh/peer-reconnect-wake.ts`、`mesh/rtc/rtc-dial-breaker.test.ts`、`mesh/mesh-runtime.ts`。
- PID/app 接线：`apps/gateway/src/system/upgrade.ts`、`upgrade.test.ts`、`packages/shared/src/process/pid-file.ts`、`pid-file.test.ts`、`packages/app/src/runtime/assemble.ts`、`assemble.test.ts`。
- 归档：`sub/C5-prompt.md`、`sub/C5-result.md`。

## 验收结果

- 指定测试命令：变更前 `1411 pass / 19 fail`；最终 `1424 pass / 19 fail`。通过数增加 13，失败数未增加。19 项均为受限执行环境中监听本地端口失败或被目录匹配带入的真实 tmux integration 无法建立临时 socket，与 C5 逻辑无关。
- C5 聚焦回归：send guard、event bridge、unescape、RTC breaker、PID、两套 cooldown 表全部通过；app direct-disabled 接线测试 `1/1`，shared PID parser 测试 `6/6`。
- `cd apps/gateway && bunx tsc --noEmit -p .`：0 errors。
- `bunx biome check <24 个变更文件>`：通过，0 findings。
- `bun scripts/complexity/gate.ts`：`complexity gate ok (1310 files, 12040 functions)`。
- 只读交叉审查完成，无剩余阻断 correctness/type/complexity 问题。

未执行任何 git 操作，未触碰生产 tmex、端口 9883 或默认 `tmex` tmux session。
