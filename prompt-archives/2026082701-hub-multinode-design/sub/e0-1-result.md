# E0-1：GatewaySession / Carrier 只读代码探索报告

## 结论

当前 WebSocket 实现把三类职责全部放在 `ServerWebSocket` 上：

1. Bun 传输能力：`send`、背压、`drain`、关闭。
2. 会话协议状态：`HELLO` 协商、序列号、分片重组、客户端实现信息。
3. 用户逻辑状态：选中 pane、订阅 pane、设备连接、切换事务、输出门控和频控。

当前没有第二载体 attach 能力。`GatewaySession` 应承载第 2、3 类状态，`Carrier` 仅承载第 1 类能力。当前仓库未修改，以下结论来自静态读取。

---

## 1. 完整引用清单

### 1.1 `ServerWebSocket<...>` 引用

| 位置 | 类别 | 用途 |
|---|---|---|
| `apps/gateway/src/ws/legacy-feed-broadcaster.ts:3` | type-only | 导入 Bun WebSocket 类型。 |
| `apps/gateway/src/ws/legacy-feed-broadcaster.ts:22` | send | Host 的 `sendEnvelope` 签名。 |
| `apps/gateway/src/ws/legacy-feed-broadcaster.ts:23` | send | Host 的 `sendChunked` 签名。 |
| `apps/gateway/src/ws/legacy-feed-broadcaster.ts:29` | state-access | 旧版广播按客户端状态筛选目标。 |
| `apps/gateway/src/ws/index.ts:9` | type-only | 导入 `Server`、`ServerWebSocket`。 |
| `apps/gateway/src/ws/index.ts:82` | identity-key | `connectedClients` 使用 socket 作为 Set 元素。 |
| `apps/gateway/src/ws/index.ts:83` | identity-key | `canonicalSessions` 使用 socket 作为 Map key。 |
| `apps/gateway/src/ws/index.ts:150` | state-access | `handleOpen` 接收新 socket。 |
| `apps/gateway/src/ws/index.ts:156` | state-access | `handleMessage` 接收 socket 和消息。 |
| `apps/gateway/src/ws/index.ts:210` | backpressure | `handleDrain` 接收发生 drain 的 socket。 |
| `apps/gateway/src/ws/index.ts:211` | backpressure | 将 socket 转交发送保护器。 |
| `apps/gateway/src/ws/index.ts:215` | identity-key | 按 socket 获取或创建 canonical session。 |
| `apps/gateway/src/ws/index.ts:252` | send | canonical 事件发送函数接收 socket。 |
| `apps/gateway/src/ws/index.ts:262` | send | canonical 发送保护器调用。 |
| `apps/gateway/src/ws/index.ts:279` | lifecycle | `handleClose` 接收断开的 socket。 |
| `apps/gateway/src/ws/index.ts:284` | lifecycle | 清理发送保护器中的 socket 状态。 |
| `apps/gateway/src/ws/index.ts:317` | state-access | Borsh 消息处理接收 socket。 |
| `apps/gateway/src/ws/index.ts:358` | state-access | HELLO 处理接收 socket。 |
| `apps/gateway/src/ws/index.ts:395` | send | PING 处理接收 socket并回发 PONG。 |
| `apps/gateway/src/ws/index.ts:415` | send | `sendEnvelope` 接收 socket。 |
| `apps/gateway/src/ws/index.ts:419` | send | `sendChunked` 接收 socket。 |
| `apps/gateway/src/ws/index.ts:420` | backpressure | 发送前调用 `canSend`。 |
| `apps/gateway/src/ws/index.ts:425` | send | 将 socket 交给 `sendToClient`。 |
| `apps/gateway/src/ws/index.ts:431` | send | `sendError` 接收 socket。 |
| `apps/gateway/src/ws/index.ts:448` | state-access | 按 socket 获取设备连接 entry。 |
| `apps/gateway/src/ws/index.ts:455` | state-access | 按 socket 创建设备连接 entry。 |
| `apps/gateway/src/ws/index.ts:514` | state-access | 设备连接处理接收 socket。 |
| `apps/gateway/src/ws/index.ts:518` | state-access | 设备断开处理接收 socket。 |
| `apps/gateway/src/ws/index.ts:523` | state-access | tmux select 处理接收 socket。 |
| `apps/gateway/src/ws/index.ts:585` | state-access | 主题更新处理接收 socket。 |
| `apps/gateway/src/ws/index.ts:628` | state-access | pane 订阅处理接收 socket。 |
| `apps/gateway/src/ws/index.ts:636` | state-access | pane history 处理接收 socket。 |
| `apps/gateway/src/ws/index.ts:657` | state-access | focus pane 处理接收 socket。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:5` | type-only | 导入 Bun WebSocket 类型。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:44` | identity-key | `pendingTransactions` 的外层 Map 以 socket 为 key。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:63` | identity-key | 获取 socket 对应的设备事务 Map。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:78` | identity-key | 获取 socket 的 pending transaction。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:83` | identity-key | 设置 socket 的 pending transaction。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:94` | identity-key | 删除 socket 的 pending transaction。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:107` | state-access | 启动选择事务。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:150` | send | 发送 `SWITCH_ACK`。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:215` | send | 发送 `TERM_HISTORY`。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:281` | send | 发送 `LIVE_RESUME`。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:362` | state-access | 获取事务目标 pane。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:373` | state-access | 获取事务 token。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:380` | state-access | 校验事务 token。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:394` | state-access | 查询输出是否应缓冲。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:401` | state-access | 缓冲输出。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:409` | lifecycle | 超时处理闭包接收 socket。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:445` | lifecycle | 取消事务。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:464` | lifecycle | 完成事务。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:477` | lifecycle | 清理事务。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:484` | lifecycle | 清理客户端全部事务。 |
| `apps/gateway/src/ws/borsh/codec-borsh.ts:5` | type-only | 导入 Bun WebSocket 类型。 |
| `apps/gateway/src/ws/borsh/codec-borsh.ts:106` | send | `sendToClient` 接收 socket。 |
| `apps/gateway/src/ws/borsh/session-state.ts:4` | type-only | 导入 Bun WebSocket 类型。 |
| `apps/gateway/src/ws/borsh/session-state.ts:103` | identity-key | `SessionStateStore.states` 以 socket 为 key。 |
| `apps/gateway/src/ws/borsh/session-state.ts:105` | state-access | 创建 socket 状态。 |
| `apps/gateway/src/ws/borsh/session-state.ts:124` | state-access | 获取 socket 状态。 |
| `apps/gateway/src/ws/borsh/session-state.ts:128` | lifecycle | 删除 socket 状态。 |
| `apps/gateway/src/ws/borsh/session-state.ts:134` | state-access | 转移 WebSocket 状态机。 |
| `apps/gateway/src/ws/borsh/session-state.ts:164` | state-access | 更新 socket 活跃时间。 |
| `apps/gateway/src/ws/borsh/session-state.ts:171` | state-access | 增加 socket 状态机 seq。 |
| `apps/gateway/src/ws/borsh/session-state.ts:181` | state-access | 获取 socket 的设备状态。 |
| `apps/gateway/src/ws/borsh/session-state.ts:202` | state-access | 转移设备状态。 |
| `apps/gateway/src/ws/borsh/session-state.ts:244` | state-access | 获取 socket 的选择事务状态。 |
| `apps/gateway/src/ws/borsh/session-state.ts:269` | state-access | 启动 socket 的选择事务。 |
| `apps/gateway/src/ws/borsh/session-state.ts:295` | state-access | 转移选择状态。 |
| `apps/gateway/src/ws/borsh/session-state.ts:345` | state-access | 获取 socket 的输出门控。 |
| `apps/gateway/src/ws/borsh/session-state.ts:363` | state-access | 开始输出缓冲。 |
| `apps/gateway/src/ws/borsh/session-state.ts:371` | state-access | 停止输出缓冲。 |
| `apps/gateway/src/ws/borsh/session-state.ts:381` | state-access | 写入输出缓冲。 |
| `apps/gateway/src/ws/borsh/session-state.ts:394` | state-access | 查询输出门控状态。 |
| `apps/gateway/src/ws/borsh/session-state.ts:402` | state-access | Bell 频控。 |
| `apps/gateway/src/ws/borsh/session-state.ts:433` | state-access | Notification 频控。 |
| `apps/gateway/src/ws/borsh/session-state.ts:466` | lifecycle | 清理 socket 的设备状态。 |
| `apps/gateway/src/ws/borsh/session-state.ts:488` | lifecycle | 清理 socket 的全部状态。 |
| `apps/gateway/src/ws/gateway-metrics-log.ts:1` | type-only | 导入 Bun WebSocket 类型。 |
| `apps/gateway/src/ws/gateway-metrics-log.ts:13` | identity-key | Metrics Host 暴露 socket Set。 |
| `apps/gateway/src/ws/gateway-metrics-log.ts:15` | identity-key | Metrics Host 暴露以 socket 为 key 的 canonical Map。 |
| `apps/gateway/src/ws/gateway-metrics-log.ts:28` | backpressure | 将 socket Set 传给发送保护器统计。 |
| `apps/gateway/src/ws/websocket-send-guard.ts:1` | type-only | 导入 Bun WebSocket 类型。 |
| `apps/gateway/src/ws/websocket-send-guard.ts:40` | state-access | 从 socket 的 data 中读取协商帧上限。 |
| `apps/gateway/src/ws/websocket-send-guard.ts:51` | identity-key | 背压状态 WeakMap 以 socket 为 key。 |
| `apps/gateway/src/ws/websocket-send-guard.ts:52` | identity-key | unavailable WeakSet 保存 socket。 |
| `apps/gateway/src/ws/websocket-send-guard.ts:71` | backpressure | 判断 socket 是否可发送。 |
| `apps/gateway/src/ws/websocket-send-guard.ts:83` | backpressure | 判断 socket 是否处于背压。 |
| `apps/gateway/src/ws/websocket-send-guard.ts:87` | send | 向 socket 发送多帧并返回 boolean。 |
| `apps/gateway/src/ws/websocket-send-guard.ts:92` | send | 向 socket 发送并返回详细状态。 |
| `apps/gateway/src/ws/websocket-send-guard.ts:116` | send | 调用 Bun `ws.send`。 |
| `apps/gateway/src/ws/websocket-send-guard.ts:146` | backpressure | 处理 socket drain。 |
| `apps/gateway/src/ws/websocket-send-guard.ts:158` | backpressure | 标记 socket 存在流缺口。 |
| `apps/gateway/src/ws/websocket-send-guard.ts:165` | lifecycle | 忘记 socket 的发送状态。 |
| `apps/gateway/src/ws/websocket-send-guard.ts:174` | backpressure | 统计 socket 队列和背压。 |
| `apps/gateway/src/ws/websocket-send-guard.ts:201` | lifecycle | 终止 socket。 |
| `apps/gateway/src/ws/device-connection-registry.ts:3` | type-only | 导入 Bun WebSocket 类型。 |
| `apps/gateway/src/ws/device-connection-registry.ts:19` | identity-key | Host 暴露以 socket 为 key 的 canonical Map。 |
| `apps/gateway/src/ws/device-connection-registry.ts:22` | state-access | 创建设备 entry 接收 socket。 |
| `apps/gateway/src/ws/device-connection-registry.ts:26` | send | Registry Host 的 `sendEnvelope`。 |
| `apps/gateway/src/ws/device-connection-registry.ts:27` | send | Registry Host 的 `sendChunked`。 |
| `apps/gateway/src/ws/device-connection-registry.ts:94` | state-access | `getOrCreate` 接收 socket。 |
| `apps/gateway/src/ws/device-connection-registry.ts:146` | state-access | `createEntry` 接收 socket。 |
| `apps/gateway/src/ws/device-connection-registry.ts:192` | state-access | 设备连接处理接收 socket。 |
| `apps/gateway/src/ws/device-connection-registry.ts:218` | state-access | 设备断开处理接收 socket。 |
| `apps/gateway/src/ws/types.ts:2` | type-only | 导入 Bun WebSocket 类型。 |
| `apps/gateway/src/ws/types.ts:13` | type-only | `SwitchBarrierSocket` 类型别名。 |
| `apps/gateway/src/ws/types.ts:15` | type-only | `asSwitchBarrierSocket` 类型转换。 |
| `apps/gateway/src/ws/types.ts:22` | identity-key | `DeviceConnectionEntry.clients` 保存 socket Set。 |
| `apps/gateway/src/ws/types.ts:28` | identity-key | `canonicalClients` 保存 socket Set。 |
| `apps/gateway/src/ws/tmux-command-handlers.ts:3` | type-only | 导入 Bun WebSocket 类型。 |
| `apps/gateway/src/ws/tmux-command-handlers.ts:26` | send | Host 的 `sendError`。 |
| `apps/gateway/src/ws/tmux-command-handlers.ts:32` | send | Host 的 `sendChunked`。 |
| `apps/gateway/src/ws/tmux-command-handlers.ts:95` | state-access | tmux select 处理。 |
| `apps/gateway/src/ws/tmux-command-handlers.ts:382` | state-access | pane 订阅处理。 |
| `apps/gateway/src/ws/tmux-command-handlers.ts:411` | state-access | pane history 处理。 |
| `apps/gateway/src/ws/tmux-command-handlers.ts:505` | state-access | focus pane 处理。 |
| `apps/gateway/src/ws/theme-settings-broadcaster.ts:3` | type-only | 导入 Bun WebSocket 类型。 |
| `apps/gateway/src/ws/theme-settings-broadcaster.ts:9` | identity-key | Host 暴露 connected socket Set。 |
| `apps/gateway/src/ws/theme-settings-broadcaster.ts:11` | send | Host 的 `sendEnvelope`。 |
| `apps/gateway/src/ws/theme-settings-broadcaster.ts:13` | send | Host 的 `sendError`。 |
| `apps/gateway/src/ws/theme-settings-broadcaster.ts:38` | state-access | 主题更新处理。 |
| `apps/gateway/src/ws/borsh-dispatcher.ts:2` | type-only | 导入 Bun WebSocket 类型。 |
| `apps/gateway/src/ws/borsh-dispatcher.ts:14` | state-access | 设备连接 handler 签名。 |
| `apps/gateway/src/ws/borsh-dispatcher.ts:15` | state-access | 设备断开 handler 签名。 |
| `apps/gateway/src/ws/borsh-dispatcher.ts:17` | state-access | tmux select handler 签名。 |
| `apps/gateway/src/ws/borsh-dispatcher.ts:28` | state-access | pane 订阅 handler 签名。 |
| `apps/gateway/src/ws/borsh-dispatcher.ts:30` | state-access | pane history handler 签名。 |
| `apps/gateway/src/ws/borsh-dispatcher.ts:39` | state-access | focus pane handler 签名。 |
| `apps/gateway/src/ws/borsh-dispatcher.ts:51` | state-access | 主题更新 handler 签名。 |
| `apps/gateway/src/ws/borsh-dispatcher.ts:54` | identity-key | canonical session 获取函数签名。 |
| `apps/gateway/src/ws/borsh-dispatcher.ts:56` | send | `sendError` handler 签名。 |
| `apps/gateway/src/ws/borsh-dispatcher.ts:67` | state-access | 通用 Borsh handler 回调签名。 |
| `apps/gateway/src/ws/borsh-dispatcher.ts:121` | state-access | dispatcher 接收 socket。 |
| `apps/gateway/src/ws/host-interfaces.test.ts:3` | type-only | 测试导入 Bun WebSocket 类型。 |
| `apps/gateway/src/ws/host-interfaces.test.ts:13` | type-only | 测试 socket 工厂返回类型。 |
| `apps/gateway/src/ws/host-interfaces.test.ts:22` | type-only | 测试 fake socket 类型断言。 |
| `apps/gateway/src/ws/test-helpers.ts:3` | type-only | 测试导入 Bun WebSocket 类型。 |
| `apps/gateway/src/ws/test-helpers.ts:8` | type-only | `BorshTestWs` 类型。 |
| `apps/gateway/src/runtime.ts:44` | type-only | Gateway runtime 的 open callback 类型。 |
| `apps/gateway/src/runtime.ts:45` | type-only | Gateway runtime 的 message callback 类型。 |
| `apps/gateway/src/runtime.ts:46` | type-only | Gateway runtime 的 drain callback 类型。 |
| `apps/gateway/src/runtime.ts:47` | type-only | Gateway runtime 的 close callback 类型。 |
| `apps/gateway/src/managed-entry.ts:23` | type-only | Managed runtime 的 open callback 类型。 |
| `apps/gateway/src/managed-entry.ts:24` | type-only | Managed runtime 的 message callback 类型。 |
| `apps/gateway/src/managed-entry.ts:25` | type-only | Managed runtime 的 drain callback 类型。 |
| `apps/gateway/src/managed-entry.ts:26` | type-only | Managed runtime 的 close callback 类型。 |
| `apps/gateway/src/managed-entry.ts:42` | identity-key | `socketOwners` 的 Map 类型。 |
| `apps/gateway/src/managed-entry.ts:64` | identity-key | `retireRuntime` 接收 socketOwners。 |
| `apps/gateway/src/managed-entry.ts:142` | identity-key | 创建 socketOwners Map。 |
| `apps/gateway/src/agent/ws-hub.ts:11` | type-only | 导入 Bun WebSocket 类型。 |
| `apps/gateway/src/agent/ws-hub.ts:28` | type-only | `AgentHubClient` 类型别名。 |
| `apps/gateway/src/agent/ws-hub.ts:177` | backpressure | Agent 广播前调用 `canSend`。 |
| `apps/gateway/src/agent/ws-hub.ts:182` | send | Agent 广播交给 `sendToClient`。 |

### 1.2 `ws.data` / `borshState` 状态访问

| 位置 | 类别 | 用途 |
|---|---|---|
| `apps/gateway/src/ws/index.ts:183` | state-access | 读取 Borsh 客户端状态。 |
| `apps/gateway/src/ws/index.ts:219` | state-access | 创建 canonical session 时读取 `maxFrameBytes`。 |
| `apps/gateway/src/ws/index.ts:259` | state-access | canonical 事件获取 `seqGen`。 |
| `apps/gateway/src/ws/index.ts:260` | state-access | canonical 事件获取 `maxFrameBytes`。 |
| `apps/gateway/src/ws/index.ts:293` | state-access | 断开时删除选中 pane。 |
| `apps/gateway/src/ws/index.ts:294` | state-access | 断开时删除订阅 pane。 |
| `apps/gateway/src/ws/index.ts:323` | state-access | Borsh handler 读取协商状态。 |
| `apps/gateway/src/ws/index.ts:377` | state-access | 写入 `negotiated`。 |
| `apps/gateway/src/ws/index.ts:378` | state-access | 写入 `clientImpl`。 |
| `apps/gateway/src/ws/index.ts:379` | state-access | 写入协商后的帧上限。 |
| `apps/gateway/src/ws/index.ts:423` | state-access | 读取 seq 生成器和帧上限。 |
| `apps/gateway/src/ws/legacy-feed-broadcaster.ts:34` | state-access | 读取选中 pane。 |
| `apps/gateway/src/ws/legacy-feed-broadcaster.ts:35` | state-access | 读取订阅 pane。 |
| `apps/gateway/src/ws/legacy-feed-broadcaster.ts:234` | state-access | 判断输出是否为当前焦点 pane。 |
| `apps/gateway/src/ws/legacy-feed-broadcaster.ts:269` | state-access | 判断 clipboard 目标 pane。 |
| `apps/gateway/src/ws/legacy-feed-broadcaster.ts:306` | state-access | 判断 history 目标 pane。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:161` | state-access | 读取 `borshState` 后发送 ACK。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:233` | state-access | 读取 `borshState` 后发送 history。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:296` | state-access | 读取 `borshState` 后发送 resume。 |
| `apps/gateway/src/ws/gateway-metrics-log.ts:113` | state-access | 读取 `clientImpl` 统计客户端类型。 |
| `apps/gateway/src/ws/device-connection-registry.ts:198` | state-access | 初始化设备的 selected pane。 |
| `apps/gateway/src/ws/device-connection-registry.ts:227` | state-access | 删除设备的 selected pane。 |
| `apps/gateway/src/ws/device-connection-registry.ts:228` | state-access | 删除设备的 subscribed pane。 |
| `apps/gateway/src/ws/device-connection-registry.ts:342` | state-access | 重连失败时删除 selected pane。 |
| `apps/gateway/src/ws/tmux-command-handlers.ts:129` | state-access | 写入 selected pane。 |
| `apps/gateway/src/ws/tmux-command-handlers.ts:402` | state-access | 写入 subscribed pane。 |
| `apps/gateway/src/ws/tmux-command-handlers.ts:404` | state-access | 删除 subscribed pane。 |
| `apps/gateway/src/ws/tmux-command-handlers.ts:514` | state-access | 写入 selected pane。 |
| `apps/gateway/src/agent/ws-hub.ts:180` | state-access | 读取 seq 生成器和帧上限。 |
| `apps/gateway/src/ws/websocket-send-guard.ts:40-47` | state-access | 从 socket data 中读取协商帧上限。 |
| `apps/gateway/src/ws/index.ts:141-145` | state-access | upgrade 时把新建的 `BorshClientState` 写入 socket data。 |
| `apps/gateway/src/ws/test-helpers.ts:19` | type-only | 测试 fake socket 初始化 `borshState`。 |
| `apps/gateway/src/ws/host-interfaces.test.ts:16` | type-only | 测试 fake socket 初始化 `borshState`。 |
| `apps/gateway/src/ws/websocket-send-guard.test.ts:10` | type-only | 测试用 data 提供 `maxFrameBytes`。 |
| `apps/gateway/src/ws/borsh/index.test.ts:390` | state-access | 测试故意将 `borshState` 置为 undefined。 |
| `apps/gateway/src/ws/switch-barrier.issue45.test.ts:111` | state-access | 测试修改 selected pane。 |
| `apps/gateway/src/ws/issue45-cross-bug.test.ts:132` | state-access | 测试修改 selected pane。 |
| `apps/gateway/src/ws/issue45-cross-bug.test.ts:158` | state-access | 测试修改客户端 A 的 selected pane。 |
| `apps/gateway/src/ws/issue45-cross-bug.test.ts:161` | state-access | 测试修改客户端 B 的 selected pane。 |
| `apps/gateway/src/ws/issue45-cross-bug.test.ts:214` | state-access | 测试修改 selected pane。 |
| `apps/gateway/src/ws/index.test.ts:50` | state-access | 校验 HELLO 写入的 `clientImpl`。 |
| `apps/gateway/src/ws/index.test.ts:156` | state-access | 写入 selected pane。 |
| `apps/gateway/src/ws/index.test.ts:213` | state-access | 设置已协商状态。 |
| `apps/gateway/src/ws/index.test.ts:241` | state-access | 设置已协商状态。 |
| `apps/gateway/src/ws/index.test.ts:255` | state-access | 设置已协商状态。 |
| `apps/gateway/src/ws/index.test.ts:309` | state-access | 设置 watchdog selected pane。 |
| `apps/gateway/src/ws/index.test.ts:313` | state-access | 修改 watchdog selected pane。 |
| `apps/gateway/src/ws/index.test.ts:333` | state-access | 设置 selected pane。 |
| `apps/gateway/src/ws/index.test.ts:340` | state-access | 设置 subscribed pane。 |
| `apps/gateway/src/ws/index.test.ts:354` | state-access | 设置 selected pane。 |
| `apps/gateway/src/ws/index.test.ts:374` | state-access | 设置 selected pane。 |
| `apps/gateway/src/ws/index.test.ts:402` | state-access | 设置慢客户端 selected pane。 |
| `apps/gateway/src/ws/index.test.ts:435` | state-access | 设置较小的 `maxFrameBytes`。 |
| `apps/gateway/src/ws/index.test.ts:580` | state-access | 设置 selected pane。 |
| `apps/gateway/src/ws/index.test.ts:597` | state-access | 读取 selected pane。 |
| `apps/gateway/src/ws/index.test.ts:620` | state-access | 校验 selected pane 被删除。 |
| `apps/gateway/src/ws/index.test.ts:645` | state-access | 读取 selected pane。 |
| `apps/gateway/src/ws/index.test.ts:652` | state-access | 设置 selected pane。 |
| `apps/gateway/src/ws/index.test.ts:682` | state-access | 设置 subscribed pane。 |
| `apps/gateway/src/ws/index.test.ts:695` | state-access | 读取 subscribed pane。 |
| `apps/gateway/src/agent/ws-hub.test.ts:230` | state-access | 测试较小的 `maxFrameBytes`。 |

### 1.3 发送、背压、生命周期 API

| 位置 | 类别 | 用途 |
|---|---|---|
| `apps/gateway/src/ws/websocket-send-guard.ts:116` | send | 调用 `ws.send`，消费 Bun 数值返回值。 |
| `apps/gateway/src/ws/websocket-send-guard.ts:184` | backpressure | 调用 `socket.getBufferedAmount()` 统计队列。 |
| `apps/gateway/src/ws/websocket-send-guard.ts:209` | lifecycle | 调用 `ws.terminate()`。 |
| `apps/gateway/src/managed-entry.ts:50` | lifecycle | 通过 runtime callback 关闭旧 runtime 的 socket。 |
| `apps/gateway/src/managed-entry.ts:55` | lifecycle | 直接调用 `ws.close(code, reason)`。 |
| `apps/gateway/src/managed-entry.ts:168` | lifecycle | runtime 不可用时关闭 socket。 |
| `apps/gateway/src/managed-entry.ts:177` | lifecycle | 找不到 socket owner 时关闭 socket。 |
| `apps/gateway/src/managed-entry.ts:188` | lifecycle | 将 Bun close callback 转交给 runtime。 |
| `apps/gateway/src/runtime.ts:145-147` | backpressure | 设置 Bun `backpressureLimit=1MiB` 和 `closeOnBackpressureLimit=true`。 |
| `apps/gateway/src/runtime.ts:154-159` | backpressure/lifecycle | 将 Bun drain/close 回调转交到 `WebSocketServer`。 |

未发现生产代码使用：

- `ws.readyState`。
- `ws.remoteAddress`。
- `ws.publish(...)`、Bun topic `ws.subscribe(...)`、`ws.unsubscribe(...)`。

`remoteAddress` 仅出现在测试 fake 对象中：

- `apps/gateway/src/ws/borsh/index.test.ts:129`
- `apps/gateway/src/ws/borsh/index.test.ts:138`
- `apps/gateway/src/ws/borsh/index.test.ts:157`
- `apps/gateway/src/ws/borsh/index.test.ts:186`
- `apps/gateway/src/ws/borsh/index.test.ts:213`
- `apps/gateway/src/ws/borsh/index.test.ts:262`
- `apps/gateway/src/ws/borsh/index.test.ts:312`
- `apps/gateway/src/ws/borsh/index.test.ts:318`
- `apps/gateway/src/ws/borsh/index.test.ts:364`

这些值没有被业务代码读取；测试仅用于证明相同远端地址不能造成不同客户端事务冲突，测试名称见 `apps/gateway/src/ws/borsh/index.test.ts:310`。

### 1.4 以 socket 为元素或 key 的 Map / Set / WeakMap

| 位置 | 类别 | 当前结构 |
|---|---|---|
| `apps/gateway/src/ws/index.ts:82` | identity-key | `Set<ServerWebSocket<ClientState>>`，所有已连接客户端。 |
| `apps/gateway/src/ws/index.ts:83` | identity-key | `Map<ServerWebSocket<ClientState>, CanonicalFeedSession>`。 |
| `apps/gateway/src/ws/types.ts:22` | identity-key | `DeviceConnectionEntry.clients`。 |
| `apps/gateway/src/ws/types.ts:28` | identity-key | `DeviceConnectionEntry.canonicalClients`。 |
| `apps/gateway/src/ws/borsh/session-state.ts:103` | identity-key | `Map<ServerWebSocket<unknown>, SessionState>`。 |
| `apps/gateway/src/ws/borsh/switch-barrier.ts:43-53` | identity-key | socket → deviceId → pending transaction。 |
| `apps/gateway/src/ws/websocket-send-guard.ts:51` | identity-key | socket → `BackpressureState`。 |
| `apps/gateway/src/ws/websocket-send-guard.ts:52` | identity-key | `WeakSet` 保存 unavailable socket。 |
| `apps/gateway/src/ws/gateway-metrics-log.ts:13` | identity-key | Metrics Host 镜像 `connectedClients`。 |
| `apps/gateway/src/ws/gateway-metrics-log.ts:15` | identity-key | Metrics Host 镜像 `canonicalSessions`。 |
| `apps/gateway/src/ws/device-connection-registry.ts:19` | identity-key | Registry Host 镜像 `canonicalSessions`。 |
| `apps/gateway/src/ws/theme-settings-broadcaster.ts:9` | identity-key | Theme Host 镜像 `connectedClients`。 |
| `apps/gateway/src/agent/ws-hub.ts:68` | identity-key | `Set<AgentHubClient>`。 |
| `apps/gateway/src/agent/ws-hub.ts:69` | identity-key | `Map<agentSessionId, Set<AgentHubClient>>`，Map key 是 agent sessionId，Set 元素仍是 socket。 |
| `apps/gateway/src/managed-entry.ts:42` | identity-key | `Map<Bun.ServerWebSocket, ManagedGatewayRuntime>` 类型。 |
| `apps/gateway/src/managed-entry.ts:64` | identity-key | `retireRuntime` 接收 socketOwners。 |
| `apps/gateway/src/managed-entry.ts:142` | identity-key | 实际创建 socketOwners。 |

---

## 2. 当前 `ClientState` 中的状态

`ClientState` 只有一个字段：`borshState`，定义于 `apps/gateway/src/ws/types.ts:9-11`。其具体字段定义和初始化位于 `apps/gateway/src/ws/borsh/codec-borsh.ts:8-28`。

| 字段 | 写入位置 | 读取位置 | 应归属 |
|---|---|---|---|
| `seqGen` | `apps/gateway/src/ws/borsh/codec-borsh.ts:21` 初始化；之后没有重新赋值。 | `apps/gateway/src/ws/borsh/codec-borsh.ts:92,102`、`apps/gateway/src/ws/index.ts:259`、`apps/gateway/src/ws/borsh/switch-barrier.ts:174,314,332`、`apps/gateway/src/agent/ws-hub.ts:183`。 | 逻辑会话。必须跨 carrier 保持单调递增。 |
| `negotiated` | `apps/gateway/src/ws/borsh/codec-borsh.ts:22` 初始化为 false；`apps/gateway/src/ws/index.ts:377` 写为 true。 | `apps/gateway/src/ws/index.ts:326` 判断是否允许非 HELLO 消息。 | 逻辑会话。 |
| `clientImpl` | `apps/gateway/src/ws/borsh/codec-borsh.ts:23` 初始化为 null；`apps/gateway/src/ws/index.ts:378` 写入截断后的值。 | `apps/gateway/src/ws/gateway-metrics-log.ts:113-122` 用于客户端类型统计。 | 逻辑会话/客户端身份。 |
| `maxFrameBytes` | `apps/gateway/src/ws/borsh/codec-borsh.ts:24` 默认 1MiB；`apps/gateway/src/ws/index.ts:379` 写入协商后的最小值。 | `apps/gateway/src/ws/index.ts:219,260,423`、`apps/gateway/src/ws/websocket-send-guard.ts:40-47`、`apps/gateway/src/agent/ws-hub.ts:180,183`、canonical/switch barrier 的编码路径。 | 逻辑会话的协议协商状态，不是传输状态。 |
| `chunkReassembler` | `apps/gateway/src/ws/borsh/codec-borsh.ts:25` 初始化。 | `apps/gateway/src/ws/index.ts:188` 接收 CHUNK 时调用 `addChunk`。 | 逻辑会话。carrier 切换后仍需保留未完成的入站分片。 |
| `selectedPanes` | `apps/gateway/src/ws/borsh/codec-borsh.ts:26` 初始化；`apps/gateway/src/ws/tmux-command-handlers.ts:129,514`、`apps/gateway/src/ws/device-connection-registry.ts:198` 写入；多处删除。 | `apps/gateway/src/ws/legacy-feed-broadcaster.ts:34,234,269,306`、`apps/gateway/src/ws/device-connection-registry.ts:342`、多个 `index.test.ts` 测试。 | 逻辑会话。 |
| `subscribedPanes` | `apps/gateway/src/ws/borsh/codec-borsh.ts:27` 初始化；`apps/gateway/src/ws/tmux-command-handlers.ts:402` 写入、`:404` 删除。 | `apps/gateway/src/ws/legacy-feed-broadcaster.ts:35`、`apps/gateway/src/ws/index.ts:294`、测试中的订阅筛选。 | 逻辑会话。 |

### 同样依赖 socket、但不在 `ws.data` 中的状态

`apps/gateway/src/ws/borsh/session-state.ts:82-100` 的 `SessionState` 还包含：

- `wsConnection`：状态、连接时间、最近活跃时间、另一套 `seq`，见 `:16-21`。
- `deviceConnections`：按 deviceId 的设备状态。
- `selectTransactions`：按 deviceId 的选择事务。
- `outputGates`：按 deviceId 的输出门控和缓冲。
- `bellThrottles`：按 deviceId/paneId 的 Bell 频控。
- `notificationThrottles`：按 deviceId/paneId/source 的通知频控。

其中 `wsConnection.seq` 是独立于 `BorshClientState.seqGen` 的第二套序号状态，定义和修改位于 `apps/gateway/src/ws/borsh/session-state.ts:20,112,171-175`。它也应归入 `GatewaySession`，并需要确认是否仍被生产路径使用。

### 传输状态

以下状态不应放入 `GatewaySession`：

- 当前 Bun socket。
- 当前 active carrier。
- carrier 的 `bufferedAmount`。
- carrier 的 drain 回调。
- carrier 级别的背压定时器和 unavailable 状态。
- Bun `remoteAddress` 等传输属性。

`WebSocketSendGuard` 当前的 `BackpressureState` 位于 `apps/gateway/src/ws/websocket-send-guard.ts:6-9`，应按 carrier 保存，而不是按 session 保存。

---

## 3. 当前发送路径和 Carrier 要求

### 3.1 当前 `WebSocketSendGuard` 行为

实现位于 `apps/gateway/src/ws/websocket-send-guard.ts`。

1. 帧大小检查：

   - `frameByteLength` 位于 `:33-38`。
   - 协商帧上限从 `ws.data.borshState.maxFrameBytes` 读取，位于 `:40-47`。
   - `sendFramesStatus` 在 `:99-106` 发送前检查每一帧，超限调用 `terminate(ws, 'oversized_frame')`。

2. 发送前置检查：

   - `canSend` 位于 `:71-81`。
   - unavailable socket 直接返回 false。
   - 已经处于背压时，将 `skippedFrame` 设为 true，并拒绝新帧。

3. Bun 数值返回值：

   - Bun 类型定义中，`send()` 返回正数表示发送的字节数，`-1` 表示背压，`0` 表示丢弃，见 `node_modules/bun-types/serve.d.ts:3-8,66-77`。
   - 生产调用位于 `apps/gateway/src/ws/websocket-send-guard.ts:114-120`。
   - 正数继续发送后续帧。
   - `-1` 创建背压状态，见 `:122-135`。
   - `0` 立即以 `dropped_frame` 原因终止，见 `:137-139`。
   - 抛异常也以 `dropped_frame` 终止，见 `:117-120`。

4. 背压状态：

   - `states` 和 `unavailable` 位于 `:51-52`。
   - 如果当前 `-1` 后仍有剩余帧，`skippedFrame` 为 true，见 `:123-125`。
   - 设置 `timeoutMs` 定时器，默认 5 秒，见 `:62-68,125-131`。
   - 超时仍未 drain 时清理状态并终止，原因是 `backpressure_timeout`。

5. drain：

   - `handleDrain` 位于 `:146-156`。
   - 清除背压定时器并移除状态。
   - 如果期间跳过了帧，则以 `backpressure_gap` 终止。
   - `markStreamGap` 位于 `:158-163`，供有状态发送者额外标记流缺口。

6. 清理：

   - `forget` 位于 `:165-172`，清除定时器、状态和 unavailable 标志。
   - `terminate` 位于 `:201-213`，具有幂等保护，只调用 `ws.terminate()`，不调用 graceful `close()`。

7. 队列统计：

   - `snapshotStats` 位于 `:174-198`。
   - `getBufferedAmount()` 只用于统计，不参与发送决策，见 `:183-187`。
   - 统计上限是 `sessions * 1MiB`，见 `:189-196`。
   - 实际 Bun 队列限制由 `apps/gateway/src/runtime.ts:145-147` 的 `backpressureLimit` 和 `closeOnBackpressureLimit` 执行。

因此，当前有两个不同的“阈值”：

- 单帧协议上限：`borshState.maxFrameBytes`。
- Bun 传输队列上限：1MiB `backpressureLimit`。

Guard 本身没有按照 `getBufferedAmount()` 主动比较阈值。

### 3.2 调用方依赖的返回值

| 调用方 | 位置 | 依赖 |
|---|---|---|
| `sendToClient` | `apps/gateway/src/ws/borsh/codec-borsh.ts:105-110` | 将 Guard 状态压缩为 boolean。 |
| 普通 Gateway 发送 | `apps/gateway/src/ws/index.ts:415-443` | `sendEnvelope` 忽略 boolean；`sendChunked` 返回 boolean。 |
| Switch barrier | `apps/gateway/src/ws/borsh/switch-barrier.ts:185-188,324-327,342-345` | false 时标记流缺口；关键 ACK 失败会完成事务，flush 中断。 |
| Legacy feed | `apps/gateway/src/ws/legacy-feed-broadcaster.ts:181-184,218-224,249-252` | boolean 用于 delivery 计数或控制流程。 |
| Agent hub | `apps/gateway/src/agent/ws-hub.ts:174-187` | 只使用 `canSend`，`sendToClient` 的 boolean 被忽略。 |
| Canonical feed | `apps/gateway/src/ws/index.ts:251-276` | 使用详细状态：`backpressured` 映射为 canonical `'backpressured'`，`sent` 映射为 true，其余为 false。 |
| Canonical sender | `apps/gateway/src/ws/canonical/types.ts:37-45`、`transaction-sender.ts:47-61,159-160` | `true` 才能继续严格有序发送；`backpressured` 表示帧已被接受但后续发送暂停。 |
| Canonical session | `apps/gateway/src/ws/canonical-feed-session.ts:88-96,229-264` | `backpressured` 设置 `awaitingSocketDrain`，由 drain 或低频 sweep 推进。 |

### 3.3 Carrier 必须提供的语义

建议保持接口与架构文档一致：

```ts
interface Carrier {
  send(bytes: Uint8Array): 'sent' | 'backpressure' | 'closed';
  bufferedAmount(): number;
  onDrain(cb: () => void): void;
  close(code: number, reason: string): void;
  terminate(): void;
}
```

`BunSocketCarrier` 应在 `apps/gateway/src/ws/` 内完成如下映射：

| Bun 行为 | Carrier 状态 |
|---|---|
| `ws.send(...) > 0` | `'sent'` |
| `ws.send(...) === -1` | `'backpressure'` |
| `ws.send(...) === 0` | `'closed'` |
| `ws.send(...)` 抛异常 | `'closed'` |

为了保持现有行为，Guard 可以继续保留自己的公开状态：

- Carrier `'sent'` → Guard `'sent'`。
- Carrier `'backpressure'` → Guard `'backpressured'`，创建相同的 `skippedFrame` 和超时逻辑。
- Carrier `'closed'` → Guard `'dropped'`，沿用 `dropped_frame` 的终止和统计语义。

对应替换关系：

| 当前 Bun API | Carrier API |
|---|---|
| `ws.send` | `carrier.send` |
| `ws.getBufferedAmount` | `carrier.bufferedAmount` |
| runtime 的 `drain(ws)` | `carrier.onDrain(cb)` |
| `ws.close` | `carrier.close` |
| `ws.terminate` | `carrier.terminate` |

Guard 的状态应改为 `WeakMap<Carrier, BackpressureState>` 和 `WeakSet<Carrier>`。背压属于具体传输，不应跟随 session 迁移；逻辑流缺口仍属于 session/canonical 状态。

---

## 4. HELLO 与 attach 流程

### 4.1 当前 fresh socket 流程

1. `/ws` upgrade：

   `apps/gateway/src/ws/index.ts:135-147` 校验路径并调用 `server.upgrade`。

2. upgrade data 初始化：

   `apps/gateway/src/ws/index.ts:141-145` 创建新的 `BorshClientState`，其中：

   - `seqGen` 新建。
   - `negotiated=false`。
   - `clientImpl=null`。
   - `maxFrameBytes=1MiB`。
   - 新建 `ChunkReassembler`。
   - selected/subscribed 为空。

3. socket open：

   `apps/gateway/src/ws/index.ts:150-154` 创建 socket 状态并加入 `connectedClients`。

4. 收到消息：

   `apps/gateway/src/ws/index.ts:156-208` 解码 envelope；CHUNK 使用该 socket 的 `chunkReassembler` 重组。

5. HELLO gate：

   `apps/gateway/src/ws/index.ts:316-355` 中，除 `KIND_HELLO_C2S` 外的消息在 `state.negotiated` 为 false 时返回 `HELLO required`，见 `:326-329`。

6. HELLO 解码：

   `apps/gateway/src/ws/index.ts:358-393` 使用 `HelloC2SSchema`。

### 4.2 当前协商内容

客户端 HELLO schema 位于 `packages/shared/src/ws-borsh/schema.ts:23-29`：

- `clientImpl`
- `clientVersion`
- `maxFrameBytes`
- `supportsCompression`
- `supportsDiffSnapshot`

当前实现实际使用：

- `clientImpl`：截断到 64 字节，`apps/gateway/src/ws/index.ts:378`。
- `maxFrameBytes`：与服务端 1MiB 取最小值，`:374-379`。
- `clientVersion`：当前只解码，不做版本校验。
- `supportsCompression`：当前未使用。
- `supportsDiffSnapshot`：当前未使用。

HELLO 响应位于 `apps/gateway/src/ws/index.ts:382-392`：

- `serverImpl='tmex-gateway'`
- 当前 server version
- `selectedVersion=wsBorsh.CURRENT_VERSION`
- server max frame bytes
- heartbeat 15 秒
- `GATEWAY_CAPABILITIES`

协议常量：

- `CURRENT_VERSION=1`：`packages/shared/src/ws-borsh/codec.ts:11-13`。
- 默认帧上限 1MiB：同上。
- `seqGen` 从 1 开始递增：`packages/shared/src/ws-borsh/codec.ts:136-139`。
- 能力列表：`packages/shared/src/capabilities.ts:6-10`。

HELLO 响应本身通过 `sendEnvelope` 发送，因而会消耗 session 的 `seqGen`，调用链为：

`apps/gateway/src/ws/index.ts:391-392` → `:415-427` → `apps/gateway/src/ws/borsh/codec-borsh.ts:86-103`。

### 4.3 第二 carrier attach 必须复用的状态

当前代码没有 attach 流程；第二个 socket 只能被当成一个新的 fresh socket。实现 attach 后，以下内容必须从既有 `GatewaySession` 复用，不能重新初始化：

- `seqGen`，避免切换 carrier 后序号回到 1。
- `negotiated`、`clientImpl`、有效 `maxFrameBytes`。
- `chunkReassembler` 中尚未完成的入站分片。
- `selectedPanes` 和 `subscribedPanes`。
- `SessionState` 中的设备状态、选择事务、输出门控和频控。
- `SwitchBarrier.pendingTransactions`。
- `CanonicalFeedSession` 及其设备 attachment、pane gap、screen job、输入去重状态。
- `AgentWsHub` 中该逻辑客户端的订阅关系。
- 当前的 session 关闭状态和生命周期。
- 尚未发送完的逻辑流缺口状态。

新 carrier 只应拥有：

- 自身的发送队列。
- 自身的背压状态。
- 自身的 Bun/link/datachannel 生命周期。
- 自身的 drain 回调。

新的 carrier 不应重新发送 HELLO，也不应创建新的 Borsh 状态。未来 `CARRIER_SWITCH` 协议属于后续阶段；B1-1 本身不应引入新协议，计划要求见 `prompt-archives/2026082701-hub-multinode-design/plan-00.md:27`。

---

## 5. 精确重构计划

### 第一步：新增载体和会话类型

新增：

- `apps/gateway/src/ws/carrier.ts`
- `apps/gateway/src/ws/gateway-session.ts`

`carrier.ts`：

- 定义 `Carrier`。
- 实现 `BunSocketCarrier`。
- Bun 类型只出现在此适配层和 WS ingress 边界。
- `onDrain` 由 runtime 的 Bun drain callback 驱动。

建议的最小 `GatewaySession`：

```ts
interface GatewaySession {
  readonly id: string;
  readonly borshState: BorshSessionState;
  readonly state: SessionState;

  readonly primary: Carrier;
  direct: Carrier | null;
  activeCarrier: Carrier;

  closed: boolean;
}
```

会话还应提供以下最小操作：

- `attachCarrier(carrier, role)`
- `detachCarrier(carrier)`
- `switchActiveCarrier(carrier)`
- `isActiveCarrier(carrier)`
- `handleCarrierDrain(carrier)`

`activeCarrier` 切换时必须拒绝旧 carrier 的 drain 回调继续推进 canonical 状态。

### 第二步：重命名并迁移状态类型

修改：

- `apps/gateway/src/ws/borsh/codec-borsh.ts`
- `apps/gateway/src/ws/types.ts`
- `apps/gateway/src/ws/borsh/session-state.ts`

建议：

- `BorshClientState` 重命名为 `BorshSessionState`。
- `ClientState` 不再表示业务状态。
- 新增 `GatewaySocketData`，仅保存 Bun 边界元数据，例如：

  ```ts
  interface GatewaySocketData {
    session: GatewaySession;
    carrier: BunSocketCarrier;
  }
  ```

- 删除 `SwitchBarrierSocket` 和 `asSwitchBarrierSocket`，见 `apps/gateway/src/ws/types.ts:13-17`。
- `DeviceConnectionEntry.clients` 改为 `Set<GatewaySession>`。
- `canonicalClients` 改为 `Set<GatewaySession>`。

`SessionStateStore` 的外层 `Map<ServerWebSocket, SessionState>` 位于 `apps/gateway/src/ws/borsh/session-state.ts:103`。建议让 `GatewaySession` 直接持有 `state`，将 `SessionStateStore` 改为以 session 为参数的状态操作 façade，并删除 socket-keyed outer Map。

### 第三步：改造发送编码和发送保护器

修改：

- `apps/gateway/src/ws/websocket-send-guard.ts`
- `apps/gateway/src/ws/borsh/codec-borsh.ts`

具体签名：

- `WebSocketSendGuard.canSend(carrier)`
- `WebSocketSendGuard.sendFrames(carrier, frames)`
- `WebSocketSendGuard.sendFramesStatus(carrier, frames)`
- `WebSocketSendGuard.handleDrain(carrier)`
- `WebSocketSendGuard.markStreamGap(carrier)`
- `WebSocketSendGuard.forget(carrier)`
- `snapshotStats(carriers)`

`sendToClient` 建议重命名为 `sendToCarrier`，参数从 `ServerWebSocket` 改为 `Carrier`。

`maxFrameBytes` 应显式从 `GatewaySession.borshState` 传入或由 session-level send wrapper 传入，不能再由 guard 从 `ws.data` 反射读取。

### 第四步：改造 `WebSocketServer` ingress 和主状态

修改：

- `apps/gateway/src/ws/index.ts`

保留 Bun 适配边界：

- `handleUpgrade(req, server)` 仍接收 Bun `Server`。
- `handleOpen(rawWs)` 内部构造 `BunSocketCarrier`。
- 以 upgrade data 或 Bun socket data 完成 raw socket → `{session, carrier}` 的解析。
- `connectedClients` 改为 `Set<GatewaySession>`。
- `canonicalSessions` 改为 `Map<GatewaySession, CanonicalFeedSession>`，或直接成为 session 字段。

内部签名应改为 session-oriented：

- `handleMessage(session, carrier, message)`
- `handleDrain(session, carrier)`
- `handleClose(session, carrier)`
- `handleBorshMessage(session, kind, refSeq, payload)`
- `handleHello(session, refSeq, payload)`
- `handlePing(session, refSeq, payload)`
- `sendEnvelope(session, kind, payload)`
- `sendChunked(session, kind, payload)`
- `sendError(session, refSeq, code, message, retryable)`

`getOrCreateCanonicalSession(session)` 中当前闭包：

- `apps/gateway/src/ws/index.ts:220`
- `apps/gateway/src/ws/index.ts:222`
- `apps/gateway/src/ws/index.ts:225`
- `apps/gateway/src/ws/index.ts:237`
- `apps/gateway/src/ws/index.ts:243`

全部改为捕获 `session`，不能捕获 raw `ws`。

`sendCanonicalEvent` 当前在 `apps/gateway/src/ws/index.ts:251-276`，应从 session 的 `activeCarrier` 发出，但 seq、frame limit 和 canonical session 都从 session 获取。

### 第五步：改造 Switch Barrier 和 Session State

修改：

- `apps/gateway/src/ws/borsh/switch-barrier.ts`
- `apps/gateway/src/ws/borsh/session-state.ts`

替换：

- `pendingTransactions: Map<ServerWebSocket, ...>` → `Map<GatewaySession, ...>`，或直接移动到 session。
- 所有 `startTransaction`、`sendSwitchAck`、`sendTermHistory`、`sendLiveResume`、`validateToken`、`cleanupClient` 参数改为 `GatewaySession`。
- 所有发送通过 `session.activeCarrier`。
- 所有 `ws.data.borshState` 改为 `session.borshState`。
- 所有 `sessionStateStore.*(ws, ...)` 改为 `sessionStateStore.*(session, ...)`。

Switch barrier 的定时器目前捕获 socket：

- `apps/gateway/src/ws/borsh/switch-barrier.ts:132`
- `apps/gateway/src/ws/borsh/switch-barrier.ts:194-204`
- `apps/gateway/src/ws/borsh/switch-barrier.ts:270-273`

这些闭包应捕获 session，而不是 carrier；发送时动态读取 `session.activeCarrier`。

### 第六步：改造 registry、legacy、theme、dispatcher

修改：

- `apps/gateway/src/ws/device-connection-registry.ts`
- `apps/gateway/src/ws/legacy-feed-broadcaster.ts`
- `apps/gateway/src/ws/theme-settings-broadcaster.ts`
- `apps/gateway/src/ws/gateway-metrics-log.ts`
- `apps/gateway/src/ws/borsh-dispatcher.ts`
- `apps/gateway/src/ws/tmux-command-handlers.ts`

统一替换：

- `ServerWebSocket<ClientState>` → `GatewaySession`
- `entry.clients` → `Set<GatewaySession>`
- `entry.canonicalClients` → `Set<GatewaySession>`
- `client.data.borshState` → `client.borshState`
- `sendEnvelope(ws, ...)` → `sendEnvelope(session, ...)`
- `sendChunked(ws, ...)` → `sendChunked(session, ...)`

`BorshDispatchHost` 的所有 handler 签名和通用 handler 回调位于 `apps/gateway/src/ws/borsh-dispatcher.ts:14-67`，全部改为 `GatewaySession`。

### 第七步：改造 Agent hub

修改：

- `apps/gateway/src/agent/ws-hub.ts`

删除：

- `AgentHubClientState`
- `AgentHubClient = ServerWebSocket<...>`

替换为：

- `Set<GatewaySession>`
- `Map<string, Set<GatewaySession>>`

修改：

- `registerClient(session)`
- `removeClient(session)`
- `subscribe(session, agentSessionId)`
- `unsubscribe(session, agentSessionId)`
- `sendPayload(session, ...)`

Agent hub 的逻辑订阅关系应跨 carrier 保留；第二 carrier attach 不应重复调用当前 HELLO 路径中的 `agentWsHub.registerClient`，该调用当前位于 `apps/gateway/src/ws/index.ts:380`。

### 第八步：改造 runtime 和 managed entry

修改：

- `apps/gateway/src/runtime.ts`
- `apps/gateway/src/managed-entry.ts`

`runtime.ts:44-47` 和 `managed-entry.ts:23-26` 仍是 Bun callback 的边界，但内部业务不应继续暴露 `ServerWebSocket`。

建议：

- runtime callback 只负责把 raw Bun socket 转交给 WS adapter。
- `BunSocketCarrier` 在 `WebSocketServer.handleOpen` 构造，位置对应当前 `apps/gateway/src/ws/index.ts:150`。
- `message`、`drain`、`close` 通过 Bun socket data 找到 `{session, carrier}`。
- `runtime.ts:148-159` 不再把 socket 传入业务 handler，而是调用 adapter 的 raw callback。

`managed-entry.ts` 当前的 `socketOwners` 是一个 socket-keyed Map：

- 定义：`apps/gateway/src/managed-entry.ts:42,64`
- 创建：`:142`
- 写入：`:171`
- 读取：`:175,183,186`
- 删除：`:48,187`

建议用 `Map<GatewaySession, ManagedGatewayRuntime>` 替代。`open` 调用 runtime 后从 socket data 得到 session，再建立 session owner；后续 message/drain/close 也通过 socket data 找 session。这样 `socketOwners` 不再是逻辑状态 Map，也不必保留 socket-keyed Map。

旧 runtime 关闭时改为遍历 session，并调用：

```ts
session.activeCarrier.close(
  RUNTIME_RESTART_CLOSE_CODE,
  RUNTIME_RESTART_CLOSE_REASON
);
```

### 第九步：改造测试 fixture

修改：

- `apps/gateway/src/ws/test-helpers.ts`
- 所有使用 `createBorshTestWs` 的测试。
- `apps/gateway/src/agent/ws-hub.test.ts`
- `apps/gateway/src/ws/canonical-feed-session.test.ts`
- `apps/gateway/src/ws/websocket-send-guard.test.ts`

测试 fixture 应从 raw fake socket 改为：

- `createGatewaySession()`
- `createFakeCarrier()`
- 必要时单独测试 `BunSocketCarrier` 的数值映射。

---

## 6. 测试清单与 fixture 影响

### 直接覆盖 socket / session / carrier 路径的测试

| 文件 | 覆盖内容 | fixture 影响 |
|---|---|---|
| `apps/gateway/src/ws/index.test.ts:30-167` | HELLO 客户端诊断、设备连接 entry 去重、多个客户端共享 runtime。 | 需要把 fake socket 改为 session；entry Set 改为 session Set。 |
| `apps/gateway/src/ws/index.test.ts:199-288` | malformed Borsh、canonical decode error、handler runtime error。 | `ws.data.borshState` 改为 session state。 |
| `apps/gateway/src/ws/index.test.ts:290-444` | snapshot polling、慢客户端隔离、发送背压、分片帧大小。 | 需要 fake Carrier；drain 从 socket callback 改为 carrier callback。 |
| `apps/gateway/src/ws/index.test.ts:447-699` | tmux select、selected/subscribed pane、switch barrier。 | 需要 session fixture。 |
| `apps/gateway/src/ws/index.test.ts:699-890` | Bell、Notification 和 per-client 频控。 | 需要 session fixture。 |
| `apps/gateway/src/ws/index.test.ts:891-1110` | overlay、connection entry 重建。 | 使用 session Set/entry。 |
| `apps/gateway/src/ws/index.test.ts:1119-1679` | 主题广播、resize/theme 去重。 | connectedClients 改为 session Set。 |
| `apps/gateway/src/ws/borsh/index.test.ts:9-125` | Borsh state、HELLO/PING、seq 和 chunk 编码。 | state 由 session 持有；增加 session seq 复用测试。 |
| `apps/gateway/src/ws/borsh/index.test.ts:127-208` | SessionStateStore 的设备、选择事务、输出缓冲。 | fake socket 改为 `GatewaySession`；删除无意义 `remoteAddress`。 |
| `apps/gateway/src/ws/borsh/index.test.ts:210-400` | Switch barrier 生命周期、history、相同 remoteAddress 下的独立事务、状态缺失兜底。 | 改为两个 session + fake Carrier；增加 carrier 切换后事务仍存在的测试。 |
| `apps/gateway/src/ws/websocket-send-guard.test.ts:28-144` | `-1` 背压、部分 chunk、drain、stream gap、5 秒超时、status 0、超大帧、统计。 | 主要改为 fake Carrier；增加 Bun 数值到 Carrier 状态的单元测试。 |
| `apps/gateway/src/ws/canonical-feed-session.test.ts:131-170` | canonical sender 与 Guard 的 backpressure/drain 集成。 | `createGuardedSender` 当前 fake socket 改为 fake Carrier。 |
| `apps/gateway/src/ws/canonical-feed-session.test.ts:173-599` | canonical snapshot、pane gap、screen job、pending sweep、drain 顺序。 | canonical 主体可基本不变；发送注入改为 Carrier/session 适配器。 |
| `apps/gateway/src/ws/canonical/pane-stream.test.ts:32-104` | pane gap 和 backpressure 语义。 | 不需要 raw socket；发送结果接口可保持。 |
| `apps/gateway/src/ws/canonical/transaction-sender.test.ts:10-61` | 分片和发送 backpressure。 | 不需要 raw socket。 |
| `apps/gateway/src/ws/switch-barrier.issue45.test.ts:77-111` | selected pane 改变后按事务 pane 路由 history。 | `ws.data` 改为 session state。 |
| `apps/gateway/src/ws/issue45-cross-bug.test.ts:112-227` | 两个客户端的并发 ACKED transaction 不串路由。 | 两个 fake session 替代两个 fake socket。 |
| `apps/gateway/src/ws/device-connection-registry.test.ts:24-130` | close generation、重连耗尽、客户端 Set 清理。 | entry 的 client Set 改为 session；`canonicalSessions` Map 改为 session key。 |
| `apps/gateway/src/ws/borsh-dispatcher.test.ts:15-126` | dispatcher unknown kind、schema decode、handler error。 | dispatcher 参数由 socket 改为 session。 |
| `apps/gateway/src/ws/host-interfaces.test.ts:25-42` | Host 接口和 `asSwitchBarrierSocket`。 | 删除 `asSwitchBarrierSocket` 测试；改测 session identity。 |
| `apps/gateway/src/ws/event-notify-broadcast.test.ts:49-125` | connected clients 广播、EventNotifier 注册桥。 | connected Set 改为 session；Borsh fake 改为 session。 |
| `apps/gateway/src/ws/settings-broadcast.test.ts:44-99` | settings 广播和 timestamp。 | connected Set 改为 session。 |
| `apps/gateway/src/ws/site-theme-update.test.ts:29-126` | 主题更新、广播、last-writer-wins。 | connected Set 改为 session。 |
| `apps/gateway/src/agent/ws-hub.test.ts:70-298` | agent sync、订阅、watch 广播、分片、错误隔离。 | `MockWs` 改为 `GatewaySession + FakeCarrier`；`maxFrameBytes` 从 session 读取。 |

### 只覆盖逻辑、预计无需 carrier fixture 的测试

- `apps/gateway/src/ws/borsh/canonical-state.test.ts:13-267`
- `apps/gateway/src/ws/canonical/frame-sizer.test.ts:14-...`
- `apps/gateway/src/ws/canonical/subscription-coordinator.test.ts:30-...`
- `apps/gateway/src/ws/overlay-utils.test.ts:17-...`
- `apps/gateway/src/ws/error-classify.test.ts:4-...`
- `apps/gateway/src/ws/terminal-output-batcher.test.ts:39-...`
- `apps/gateway/src/ws/terminal-output-metrics.test.ts:5-...`
- `apps/gateway/src/ws/gateway-activity-metrics.test.ts:5-...`

### Watch / messaging 相关测试

Watch 和 messaging 没有直接持有 WebSocket：

- `apps/gateway/src/watch/service.ts:60-66` 只定义抽象 broadcast。
- 默认实现位于 `apps/gateway/src/watch/service.ts:85-87`，调用 `agentWsHub.broadcastWatchEvent`。
- `apps/gateway/src/events/channels/ws-broadcast.ts:5-17` 通过注册桥调用 `broadcastEventNotify`。
- `apps/gateway/src/events/index.test.ts:220-307` 覆盖 ws-broadcast 注册桥和 no-op 行为。
- `apps/gateway/src/watch/service.test.ts:204-768` 覆盖 WatchService 的通知、广播和规则生命周期。

这些测试预计不需要 carrier fixture；只要 `AgentWsHub` 的公开广播接口保持不变即可。

未发现直接测试 `runtime.ts` Bun websocket callback 或 `managed-entry.ts` socket owner 路由的测试，应新增 runtime adapter / managed restart 相关测试。

---

## 7. 风险和非机械改动点

### 7.1 闭包捕获 raw socket

最重要的闭包位于：

- `apps/gateway/src/ws/index.ts:220`
- `apps/gateway/src/ws/index.ts:222-245`
- `apps/gateway/src/ws/borsh/switch-barrier.ts:132`
- `apps/gateway/src/ws/borsh/switch-barrier.ts:194-204`
- `apps/gateway/src/ws/borsh/switch-barrier.ts:270-273`
- `apps/gateway/src/ws/websocket-send-guard.ts:125-131`

这些闭包当前捕获 `ws`。改造后：

- 逻辑闭包应捕获 `GatewaySession`。
- 传输闭包应捕获具体 `Carrier`。
- drain 回调必须验证该 carrier 仍是 session 的 active carrier。
- 旧 carrier 的延迟事件不能推进新 carrier 的 canonical 状态。

### 7.2 canonical session 的 drain 语义

`CanonicalFeedSession` 使用 `awaitingSocketDrain`，见：

- `apps/gateway/src/ws/canonical-feed-session.ts:74`
- `apps/gateway/src/ws/canonical-feed-session.ts:90-96`
- `apps/gateway/src/ws/canonical-feed-session.ts:229-264`

当前假设一个 socket 对应一个 drain 来源。拆分后必须解决：

- primary 背压期间切换到 direct。
- 旧 primary drain 到达时是否忽略。
- direct 关闭后切回 primary 时，pending gap 是否继续。
- `pendingSweepTimer` 与 carrier drain 谁拥有推进权。

### 7.3 per-socket Borsh 状态突变

以下状态目前通过原地突变实现：

- `negotiated`
- `clientImpl`
- `maxFrameBytes`
- `selectedPanes`
- `subscribedPanes`

如果 attach 时创建了第二份 state，会产生：

- seq 重复。
- selected/subscribed 不一致。
- 新 carrier 认为尚未 HELLO。
- CHUNK 在不同 carrier 上无法重组。
- Agent/canonical 看到不同的 frame limit。

因此必须保证 `GatewaySession.borshState` 是唯一实例，所有 carrier 只引用它。

### 7.4 两套 seq 状态

Borsh seq：

- `apps/gateway/src/ws/borsh/codec-borsh.ts:21`
- `packages/shared/src/ws-borsh/codec.ts:136-139`

Session state machine seq：

- `apps/gateway/src/ws/borsh/session-state.ts:20,112,171-175`

需要在实现时确认两者的职责。不能因为迁移而意外把二者合并，也不能让第二 carrier 重新初始化其中任意一个。

### 7.5 socket identity 的引用比较

未发现字面上的 `ws === other`。但以下 Set/Map 操作依赖对象引用身份：

- `apps/gateway/src/ws/index.ts:231`：`entry.clients.has(ws)`。
- `apps/gateway/src/ws/index.ts:243`：`canonicalClients.delete(ws)`。
- `apps/gateway/src/ws/index.ts:247`：`canonicalSessions.set(ws, session)`。
- `apps/gateway/src/ws/index.ts:282-292`：按 socket 清理多个集合。
- `apps/gateway/src/ws/device-connection-registry.ts:196,200,209,219,222`。
- `apps/gateway/src/ws/device-connection-registry.ts:306-309,338-342`。
- `apps/gateway/src/agent/ws-hub.ts:85-106,113-118`。
- `apps/gateway/src/managed-entry.ts:46-48,175,183,186-188`。

`apps/gateway/src/ws/host-interfaces.test.ts:39-42` 还明确测试 `asSwitchBarrierSocket` 返回同一个 socket 引用。该测试应改为验证 GatewaySession identity，而不是类型转换保留 socket 引用。

`apps/gateway/src/ws/device-connection-registry.ts:272` 的 `current !== entry` 和 `apps/gateway/src/ws/canonical-feed-session.ts:162,235` 的 runtime 比较是 runtime/entry identity，不是 socket identity，但也应避免在 session 迁移时误改。

### 7.6 Bun API 泄漏范围

Bun-specific API 当前泄漏到以下业务边界：

- `apps/gateway/src/ws/index.ts:9,135,141-147`
- `apps/gateway/src/ws/websocket-send-guard.ts:1,116,184,209`
- `apps/gateway/src/ws/borsh/*.ts`
- `apps/gateway/src/ws/legacy-feed-broadcaster.ts`
- `apps/gateway/src/ws/device-connection-registry.ts`
- `apps/gateway/src/ws/theme-settings-broadcaster.ts`
- `apps/gateway/src/ws/tmux-command-handlers.ts`
- `apps/gateway/src/ws/borsh-dispatcher.ts`
- `apps/gateway/src/agent/ws-hub.ts:11,28,177,182`
- `apps/gateway/src/runtime.ts:44-47,145-159`
- `apps/gateway/src/managed-entry.ts:23-26,42,50,55,64,142,168,171,175,177,183,186-188`

其中 `runtime.ts`、`managed-entry.ts` 和 `ws/index.ts` 可以保留为 Bun adapter 边界；其余业务模块应只依赖 `GatewaySession`、`Carrier` 和中立的消息类型。

外围直接使用 Bun.serve、但没有持有业务 socket 类型的文件：

- `apps/gateway/src/index.ts:15-29`
- `packages/app/src/runtime/server.ts:25-37`

这些文件只需要继续接收 runtime 暴露的 websocket adapter，不应重新引入 `ServerWebSocket`。

### 7.7 publish/topic

当前没有 Bun topic API 使用。`subscribe` 相关代码全部是：

- Agent session 订阅：`apps/gateway/src/agent/ws-hub.ts:94-120`
- Watch / messaging 逻辑订阅：`apps/gateway/src/watch/service.ts:60-87`

因此这部分不是 Bun carrier 迁移风险，但 Agent hub 的订阅集合仍必须从 socket 改为 session。