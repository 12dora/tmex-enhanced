定向测试共 66 项，全部通过；现有测试未覆盖下面两个竞态场景。

## 1. Blockers

1. **立即发送 `LIVE_RESUME` 不兼容 DataChannel 的分片背压语义，会丢失 resume 并触发断链。**

   - 位置：[switch-barrier.ts:231](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/borsh/switch-barrier.ts:231)、[data-channel-carrier.ts:112](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/rtc/data-channel-carrier.ts:112)
   - 问题：`DataChannelCarrier.send()` 在只发出首个 64 KiB 分片、其余分片仍保存在 `remainder` 时返回 `sent`。因此 history 被认为发送完成，紧接着的 `LIVE_RESUME` 遇到 `remainder` 后返回 `backpressure`。但 `sendLiveResume()` 已先切到 `LIVE`、停止输出缓冲，发送失败后又完成事务。
   - 失败场景：通过真实 `DataChannelCarrier` 发送 70 KiB history，并让通道在首个分片后背压。实测 gateway 立即变为 `STABLE`、buffering=false；drain 后客户端只收到 `TERM_HISTORY`，没有 `LIVE_RESUME`，send guard 仍处于 backpressured，最终会因 gap/超时终止 carrier。客户端则停在 `ACKED/HISTORY_APPLIED`，直到断线重选。
   - 最小修复：使 history→`LIVE_RESUME` 成为 drain-aware 的有序发送序列。只有 `LIVE_RESUME` 确认进入 carrier 队列后才能停止输出缓冲并完成事务；DataChannel 的发送契约也必须区分“整帧已接受”和“仅部分分片已接受”。补充真实 DataChannel carrier 的背压回归测试，fake socket 全部返回 `sent` 无法覆盖该问题。

2. **cold A 尚未完成时切到 warm B，再 warm 回 A，会留下无法被新 token 清除的客户端 A gate。**

   - 位置：[tmux-selection-actions.ts:118](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/tmux-selection-actions.ts:118)、[tmux-command-handlers.ts:104](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/tmux-command-handlers.ts:104)、[switch-barrier.ts:92](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/borsh/switch-barrier.ts:92)
   - 问题：`wantHistory:false` 的 warm select 不向客户端状态机发送 `SELECT_START`，所以不会取消已有事务；gateway 却会为每次 select 启动新事务并取消旧事务。
   - 失败场景：A 的 cold select 已收到 ACK、history 尚未返回；用户切到已保活的 B，再立即切回已保活的 A。gateway 的 A 事务已被 B 取消，后续不会下发旧 A history；客户端仍保留旧 A token 和输出 gate，并忽略 B/A 新 token 的 ACK、resume。A 的持续输出会被旧 gate 缓冲，且每帧都会刷新 progress deadline，画面可无限期冻结。
   - 最小修复：计算 warm select 前检查客户端是否已有未完成事务。若存在，应标记旧事务 pane 为 gapped 并取消/abandon 旧事务，或强制本次请求走 cold history。增加 `cold A ACKED → warm B → warm A` 回归测试，断言旧事务被清理且 A 最终通过 cold history 恢复。

## 2. Should fix

1. **链路切换事件会保留上一条链路的 REST 现场字段。**

   - 位置：[mesh-nodes.ts:57](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/mesh-nodes.ts:57)
   - 问题：在线 `NODE_EVENT` 即使明确改变了 `transport`，仍无条件保留 `peerAddress`、`linkSinceAt` 和 `directFailure`。
   - 失败场景：REST 状态为 `ws-secure`、地址 `10.0.0.7`；随后事件切换为 `relay`。浮层会把旧地址显示成“中转地址”，并显示旧链路的持续时间，直到下一次 REST 刷新。
   - 最小修复：事件明确改变 transport/reach 时清空这些关联字段；更完整的方案是把链路现场加入 `NODE_EVENT` 并原子更新。补充 ws-secure→relay、relay→dc 测试。

2. **诊断行仍会混用浏览器直连与 entry↔node 两种链路的数据。**

   - 位置：[device-node-badges.tsx:157](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/device-node-badges.tsx:157)、[device-node-badges.tsx:194](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/device-node-badges.tsx:194)
   - 问题：当 `path='primary'`、entry transport 为 `dc`，而浏览器直连仍在 connecting 且已有 ICE 快照时，`detailRows()` 会显示浏览器 ICE，而非 node↔node 的对端地址。反过来，当 `path='direct'` 时，“已连接”却仍使用 entry↔node 的 `linkSinceAt`。
   - 失败场景：浏览器正在尝试 WebRTC，同时 entry↔node 已走 DC，浮层把两条不同链路的 RTT、ICE 和持续时间拼在一起，诊断结论不可信。
   - 最小修复：`browser-direct` 才使用浏览器 ICE/RTT；`dc/ws-secure/relay` 只使用 REST 链路字段。浏览器直连若需要持续时间，应在 `DirectDiagnostics` 中单独提供，否则该行应省略。

## 3. Nits

无。

`reorderFileRoots` 的读取、未列出项计算和全量 `sortOrder` 重编号均位于同一个 SQLite transaction 内；部分列表及未知 ID 的行为也与新增 API 测试一致，未发现事务正确性问题。未发现新增的鉴权、mesh peer 信任或 key-log 边界破坏。