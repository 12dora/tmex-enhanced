# 计划：通知事件发射面补齐

- 1a `tmux-client/snapshot-diff.ts` 纯函数 diff + local/ssh 两连接类在快照刷新后发射
  window/pane close（门槛：首帧/无效快照/断开路径跳过；元数据取自旧快照）。
- 1b `push/connection-alerts.ts` 在 classify 后桥接：`tmux_unavailable`→
  device_tmux_missing；连接级错误族→device_disconnect；auth/agent/config 不发；
  source 限 close|connect|probe；`${deviceId}:${eventType}` 5 分钟去重；
  session gone（runtime status tmuxAvailable=false）时跳过 device_disconnect；
  `setEventEmitter`/`setRuntimeStatusProvider` 注入 seam，runtime 启动接线。
- 1c `ensureSession` 回传 created，connect 成功后发 session_created；三处
  session/server gone 检测点发 session_closed（once 守卫）；连接类经构造 options
  注入 `notifyEvent`，registry 接线 eventNotifier。
- 1d stores runtime features 加 `hostManagedNotifications`，tmux store 的
  notification 分支入口短路。
- 1e 测试：diff 矩阵、桥映射矩阵、session/window/pane 发射、抑制开关，
  关键守卫全部变异验红。
