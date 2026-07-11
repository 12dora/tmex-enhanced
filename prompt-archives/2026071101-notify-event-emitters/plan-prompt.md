# Prompt 存档：通知事件发射面补齐

## 背景

事件系统定义了 14 种 `EventType`，但 gateway 只有 8 种有实际发射点。
`device_disconnect`、`device_tmux_missing`、`session_created`、`session_closed`、
`tmux_window_close`、`tmux_pane_close` 六种只有渠道文案、没有产生逻辑。
本批次补齐发射面，并为嵌入宿主提供通知呈现接管开关。

## 任务

1. 设备错误告警（ConnectionAlertNotifier）桥接进事件系统：连接级错误映射
   device_disconnect、tmux 不可用映射 device_tmux_missing；source 门控 + 去重。
2. tmux session 真实新建/消失时发射 session_created / session_closed
   （session gone 与连接断开区分，不双发）。
3. 快照 diff 产生 tmux_window_close / tmux_pane_close（整窗关闭不逐 pane 连发）。
4. stores runtime features 增加 hostManagedNotifications：宿主接管通知呈现时
   跳过包内 notification toast（bell 声与高亮不变）。
