## Blocker

- `apps/gateway/src/managed-entry.ts:56`：重启时把 `GatewaySession` 强转成原始 WebSocket 传给 `websocket.close()`，随后关闭 `session.activeCarrier`。当当前活跃载体是 `direct` 时，`WebSocketServer.handleClose(session)` 会把它误判为“direct 断开”，只执行 detach 后返回；接着第 65 行关闭切回后的 primary。由于 `socketOwners` 已删除该 session，primary 的 Bun close 回调无法再调用旧 runtime 清理逻辑，导致 `connectedClients`、`sessionStateStore`、`agentWsHub` 等残留，且被 detach 的 direct 载体未关闭。建议提供显式的 session 关闭入口，由其同步清理会话并关闭 primary 和 direct；managed-entry 不应伪造 `ServerWebSocket`，也不应只关闭活跃载体。

## Major

- `apps/gateway/src/ws/index.ts:319`：`handleClose()` 在只收到 `GatewaySession` 时通过 `activeCarrier` 猜测实际关闭的载体，无法正确处理非活跃载体事件。例如 direct 刚挂载但尚未切换为 active 时断开，调用 `handleClose(session)` 会把 primary 当成关闭源并结束整个会话；反过来，primary 关闭而 direct 活跃时会被误判为 direct 关闭。建议改为 `handleCarrierClose(session, carrier)`，所有载体适配器必须传入触发事件的确切 carrier，禁止从当前 active 状态反推事件来源。

- `apps/gateway/src/ws/index.ts:330`：primary 关闭后的 `closeSession()` 只清理 send guard 状态，没有关闭或移除 direct；同时 `handleMessage()` 也未拒绝 `session.closed` 的会话。实际场景是浏览器直连处于 active 时 primary WebSocket 断开：会话虽从各 Map/Set 删除，DataChannel 仍保持打开，其回调仍可把 `TERM_INPUT` 等消息交给旧 `WebSocketServer` 执行，违反设计中“primary 断开则会话整体结束，direct 随之关闭”。建议在会话终止时关闭并 detach 所有载体、清空引用，并在所有入站入口拒绝已关闭 session。

- `apps/gateway/src/ws/gateway-session.ts:34`：再次挂载 direct 会无条件覆盖已有 `this.direct`，旧载体既不关闭也不从 send guard 注销；若旧 direct 正是 active，`activeCarrier` 还会继续指向一个已不属于 `primary/direct` 的载体。网络变化重新建立 WebRTC 时即可触发，之后旧载体的 close/drain 会被错误路由，甚至结束整个会话。建议禁止重复挂载，或实现原子 replacement：先处理旧载体的 active 状态、关闭并 forget，再安装新载体。

## Minor

- `apps/gateway/src/ws/gateway-metrics-log.ts:27`：背压状态已按 carrier 独立存储，但指标只采集每个 session 的 `activeCarrier`。例如 primary 发送切换帧后进入背压、会话随即切到 direct，指标会报告零背压和零排队字节，尽管 primary 仍有未清除的背压定时器。建议展开每个会话当前附着的 primary/direct 载体后传给 `snapshotStats()`，并相应将统计字段明确为 carrier 数量。

结论：该重构在主要业务状态、序列号和发送背压的键选择上方向正确，现有定向测试也能通过，但载体关闭事件缺少明确来源，导致 managed restart 和 primary/direct 生命周期存在严重错误及状态泄漏。当前版本不建议合并，应先统一 session 终止语义并补齐“direct 活跃时重启”“非活跃 direct 关闭”“primary 关闭后 direct 不再可入站”等测试。