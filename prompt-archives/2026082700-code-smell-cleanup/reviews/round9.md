## [high][confident] 显式停止会被 stale-run 自动恢复覆盖

[supervisor.ts:494](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/supervisor.ts:494)

`stop()` 超时后，旧 run 已记录 `shutdown`。重新 `start()` 后，若用户在旧 run settle 前调用 `stopSession()`，或设备断开触发 `stopSessionsForDevice()`，`requestStop('manual'/'pane_lost')` 无法替换已有停止原因。旧 run 最终仍按 `shutdown` 结束、保留 `status=running`，随后 `finally` 无条件调用 `resumeSessionIfNeeded()`，第 513–516 行因此启动新 run。

结果是显式停止已经返回，但 LLM／工具执行又继续运行。现有测试仅覆盖自动恢复，没有覆盖恢复窗口中的 manual/pane-lost stop。

验证序列：`start → stop timeout → start → stopSession → stale settle`。最小复现输出为：

```json
{"runCount":2,"active":true,"status":"running"}
```

## [high][confident] fatal-streak 仍会强制销毁其他 run 持有的共享 emulator

[run.ts:391](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/run.ts:391)

普通收尾已改为仅在最后一个引用释放时销毁，但 `recordTerminalFailure()` 仍直接调用 `destroyPaneEmulator()`。该调用最终进入 [pane-emulator.ts:293](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/pane-emulator.ts:293)，无视 `refCount` 删除并 dispose 整个 entry。

两个 session 绑定同一 device/pane 时，一个 run 达到 fatal streak 会销毁另一个 run 正在使用的实例；后者的 `liveEmulator()` 随即返回 `null`，后续 terminal tool 失败。当前共享-scope 测试只覆盖正常 release，没有经过 fatal 路径。

直接验证两个引用后调用 `destroy()`，结果为：

```json
{"same":true,"disposed":true,"size":0}
```

## [medium][confident] connect 期间先收到 close、随后 reject 时跳过全部 runtime 清理

[device-session-runtime.ts:216](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/device-session-runtime.ts:216)

若底层 connection 在 `connect()` 尚未 reject 前先触发 `onClose`，`handleUnexpectedClose()` 会先把 `terminated` 设为 `true`。随后第 217 行条件失败，不再调用 `disconnect()`，也不再 dispose `metadataProjection`、`paneRetention` 和 `paneHistoryReader`。这相较原版本是回归：原 catch 无条件释放这三个 runtime 资源。

该顺序符合 connection 回调接口，也可能发生在 SSH 建连后段的 channel/transport 关闭。新增测试只覆盖相反顺序——connect 先 reject，随后 `disconnect()` 触发 close——因此会漏掉此分支。

用 connection 在 `connect()` 内先调用 `onClose()` 再返回 rejected promise，实测：

```json
{
  "disconnects": 0,
  "metadataDisposes": 0,
  "retentionDisposes": 0,
  "historyDisposes": 0,
  "closes": 1,
  "terminated": true
}
```