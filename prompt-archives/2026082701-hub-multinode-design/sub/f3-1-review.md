## Blocker

1. `packages/ws-client/src/direct/fingerprint.ts:23` — 只取 SDP 中第一条 `a=fingerprint`，不一定是 DataChannel 实际采用的指纹。

   - 问题：fingerprint 可同时出现在 session 层和 media 层，且 media 层会覆盖 session 层。当前正则返回首条匹配。
   - 影响：失陷 hub 可保留合法 `fp_node` 作为 session-level fingerprint，再给 `m=application` 注入攻击者 fingerprint。比较会通过，但浏览器 DTLS 实际使用攻击者证书，从而绕过本功能用于阻止 hub 中间人的核心绑定。[RFC 8122](https://www.rfc-editor.org/rfc/rfc8122.html) 明确允许两种层级。
   - 建议修复：按 SDP section 解析 `m=application` 的有效 fingerprint；对于本协议，要求唯一的有效 SHA-256 fingerprint 且严格等于授权值，拒绝冲突或额外的有效 fingerprint。解析本地 SDP 时使用同一规则。

## Major

1. `packages/ws-client/src/direct/direct-carrier-controller.ts:247` — 异步 attempt 在第一次 `await` 前没有登记，`retry()` 可以启动多个并发 attempt。

   - 问题：`this.attempt` 直到 `fetchRtcConfig()` 返回并创建 PeerConnection 后才赋值。网络事件在请求期间触发 `retry()` 时，第二次 `connect()` 会同时运行；后返回者覆盖 `this.attempt`，前一个 PeerConnection 不会关闭。旧 attempt 随后抛错时，公共 `failAttempt()` 还会拆掉当前的新 attempt。
   - 影响：RTC 配置请求较慢时切换网络，会产生两个 PeerConnection、重复授权和相互干扰的同 session 信令；至少一个 PeerConnection 泄漏，新连接也可能被旧请求的错误关闭。
   - 建议修复：在任何异步操作前建立带 generation/token 的 attempt；所有回调、catch 和 teardown 只允许操作对应 generation。为 fetch/authorize 使用 AbortController，并确保被替换 attempt 的 PeerConnection 必定关闭。

2. `packages/ws-client/src/direct/direct-carrier-controller.ts:147` — 所有重试复用同一个 `rtcSession`。

   - 问题：`rtcSession` 在控制器构造时生成一次，之后每个新 PeerConnection 都使用相同值。
   - 影响：node 端按 `rtcSession` 缓存 BrowserRecord 和 PeerConnection。第一次连接超时或直连断开后，浏览器用新 PeerConnection 发新 offer，node 却取回旧的、甚至已关闭或 `used=true` 的 PeerConnection，导致自动重试和网络切换恢复无法成功。
   - 建议修复：每个 attempt 生成新的 rtcSession，并将其存入 Attempt；授权、信令过滤和清理都使用 attempt 自己的值。

3. `packages/ws-client/src/client.ts:466` — switch-back 的 resume 钩子只被定义，从未在生产接线中设置。

   - 问题：仓库内除测试外没有 `setResumeSubscribedPanes()` 调用，`GatewayConnection` 也未暴露设置入口。
   - 影响：直连断开时 node→browser 已写入但未送达的终端输出不会通过 `LIVE_RESUME`、重新订阅或画面快照补齐。例如持续输出期间 Wi‑Fi 中断，页面回到 primary 后终端会永久缺一段内容。同时设计要求的“最近输入可能未送达”提示也没有实现。
   - 建议修复：由每 node runtime 把当前 pane 订阅管理器接入该钩子；切回时重新发送订阅并请求必要的 screen/history，同时触发一次用户提示。primary 会话整体关闭时不要执行这条恢复路径。

4. `packages/ws-client/src/carrier-switch.ts:129` — 用 `active === 'primary'` 同时表示“尚未切入 direct”和“已经切回 primary”，导致错误缓冲和错误排空。

   - 问题：切换前的 direct 帧应该缓冲，但切回 primary 后迟到的 direct 帧应该丢弃并依赖 resume。当前两种状态都会进入同一个 `buffered.push()`；`handleDirectClose()` 又无条件排空缓冲。
   - 影响：若 direct 帧先到、primary 上的 switch 帧尚未到时通道关闭，`handleDirectClose()` 会先交付 direct 帧，随后才交付在 primary 中排在 switch 前的旧帧，造成乱序。切回 primary 后迟到的 direct 帧还可能在恢复结果之后被再次排空，造成重复终端输出。
   - 建议修复：建立明确阶段，例如 `primary / pending-direct / direct / pending-primary`。仅在 `pending-direct` 缓冲；只有接受对应的 `to:direct` epoch 时才排空。关闭或 `to:primary` 后丢弃 direct 缓冲，并触发 resume。

5. `packages/ws-client/src/carrier-switch.ts:131` — 屏障缓冲没有字节或帧数上限。

   - 问题：primary 上的切换帧尚未送达时，所有完整 direct 帧都会无限加入数组。
   - 影响：primary 经拥塞 relay、direct 已高速传输大量终端输出时，浏览器可以在等待切换通知期间积累无界内存；恶意目标 node 也可直接令页面 OOM。
   - 建议修复：按总字节数实施与协议 frame 上限一致的硬限制；超限时关闭该 direct attempt、丢弃缓冲并保持 primary，随后执行恢复流程。

6. `packages/ws-client/src/direct/fragmenter.ts:96` — 重组器未落实 64 KiB 分片和 1 MiB sess 帧边界。

   - 问题：只检查 `total !== 0` 和 `idx < total`，接受最多 65535 片、任意尺寸的单片，并且不限制累计重组字节数；发送端也未拒绝超过 1 MiB 的 payload。
   - 影响：目标 node 可发送 `total=65535` 并持续投递大分片，在单个 frameId 下占用数百 MiB；`maxInFlight=32` 只限制 frame 数，不能限制内存。最终还可能分配超大连续 ArrayBuffer。
   - 建议修复：发送和接收双方都强制 frame ≤1 MiB、payload fragment ≤64 KiB、`total ≤ 16`，并跟踪每帧及全局累计字节数；协议违规应关闭 direct carrier，而不是静默等待超时。

7. `packages/ws-client/src/direct/data-channel-carrier.ts:97` — backpressure 状态没有真正暂停发送，且异常可留下半帧。

   - 问题：carrier 在已经发送完整帧后才检查高水位；`CarrierSwitchBarrier.send()` 把 `backpressure` 当作成功直接返回，后续消息继续发送。若 `channel.send()` 在分片中途抛错但通道仍 open，则仅返回 `backpressure`，已经发送的前几片无法撤回或补发。
   - 影响：大段 terminal paste 会继续把所有 Borsh chunk 压入 DataChannel，突破 4 MiB 高水位；平台缓冲区耗尽时可能留下永远无法完成的分片帧，后续协议流被破坏。
   - 建议修复：在整帧发送前检查水位并维护待发帧队列；通过 `onbufferedamountlow` 恢复。一个逻辑帧必须全发或在失败时关闭 carrier，不能返回可恢复的半帧状态。

8. `packages/ws-client/src/direct/direct-carrier-controller.ts:281` — ICE 信令没有排队或顺序屏障。

   - 问题：本地 candidate 在授权完成、offer 发送和 entry 登记 rtcSession 前就直接发送；远端 candidate 到达时也立即调用 `addIceCandidate()`，即使 `setRemoteDescription()` 尚未完成。异常被统一吞掉，candidate 永久丢失。
   - 影响：只存在一个可用 host/srflx candidate 时，该 candidate 若在 authorize HTTP 请求期间生成，就可能被 entry 丢弃，导致本可建立的直连超时；answer 与 candidate 紧邻到达而 `setRemoteDescription()` 尚未完成时，也会丢失远端 candidate。
   - 建议修复：每 attempt 缓存本地 candidate，授权且 offer 成功发出后按序发送；缓存远端 candidate，待已验证的 answer 完成 `setRemoteDescription()` 后再逐个添加。信令处理应串行化。

9. `apps/fe/src/node/node-runtimes.ts:37` — 默认信令适配器丢弃 `sendRtcSignal()` 的失败结果。

   - 问题：`MeshEventSource.sendRtcSignal()` 在 `/mesh/ws` 未连接时返回 `false`，适配器将结果忽略；控制器只把抛异常视为发送失败。
   - 影响：页面首次打开或 `/mesh/ws` 正在指数退避时，offer 和 candidate 会静默丢失。控制器最多尝试若干次后停在 failed；之后 mesh WS 恢复不会触发新的直连尝试，只能等待额外的 `online` 事件或刷新页面。
   - 建议修复：让 `DirectSignalingTransport.send()` 返回成功状态或 Promise，并暴露连接状态订阅；未连接时排队本 attempt 的信令，或等待 signaling ready 后再开始 attempt。mesh WS 恢复应重置直连退避并触发重试。

10. `packages/ws-client/src/direct/direct-carrier-controller.ts:414` — DataChannel 一 open 就被标记为 active 并清零重试次数，早于 nonce 验证和载体切换完成。

   - 问题：此时 node 尚未确认 nonce，浏览器也尚未收到 `CARRIER_SWITCH` 或发送 ACK，但连接超时已经被取消，诊断显示 direct，失败计数归零。
   - 影响：node 因 nonce/session 绑定失败而迅速关闭通道时，每次都会重新从 1 秒开始退避，永远达不到最大尝试次数；若通道保持 open 但 node 无法挂载到逻辑 WS，会永久卡在“显示 direct、实际仍走 primary”的状态。
   - 建议修复：挂载 carrier 后仍保持 `connecting` 和超时；监听 `GatewayConnection.onCarrierChange('direct')`，仅在浏览器处理 switch 并发送 ACK 后设为 active、清零次数并启动 stats。

11. `packages/ws-client/src/direct/direct-carrier-controller.ts:288` — 网络切换期间不会及时回落 primary。

   - 问题：只处理 PeerConnection 的 `failed/closed`，忽略 `disconnected`；网络事件也只监听 window 的 `online`，没有监听 `navigator.connection.change`。
   - 影响：从 Wi‑Fi 切到蜂窝网络通常不会产生新的 `online` 事件，PeerConnection 可能长期停留在 `disconnected`。屏障仍把终端输入发送到已失效的 direct 通道，直到浏览器最终宣告 failed，期间输入会丢失。
   - 建议修复：监听 Network Information API 的 `change`（可用时）并做去抖重启；对持续一定时间的 `disconnected` 主动关闭旧 PeerConnection、立即回落 primary，再以全新 attempt/rtcSession 重连。

## Minor

1. `packages/ws-client/src/direct/ice-stats.ts:49` — legacy fallback 会在明确的 `selected` 候选对之前选择任意 succeeded 候选对。

   - 问题：缺少 `transport.selectedCandidatePairId` 和 nominated 信息时，代码先取第一条 succeeded，最后才看 `selected === true`。
   - 影响：兼容性浏览器同时保留多个 succeeded pair 时，可能显示未实际承载流量的候选类型和 RTT，例如实际走 TURN 却显示 `v4-p2p`。
   - 建议修复：顺序应为 `selectedCandidatePairId`、`nominated && succeeded`、`selected === true`，最后才是任意 succeeded。[WebRTC Stats](https://www.w3.org/TR/webrtc-stats/) 将 transport 的 `selectedCandidatePairId` 定义为当前承载候选对。

2. `packages/ws-client/src/direct/direct-carrier-controller.ts:566` — 已推导出的 `lan/v6/v4-p2p/turn` 路径没有进入实际挂给 UI 的诊断快照。

   - 问题：`pollStats()` 写入 `this.route`，但 `diagnosticsSource` 只发布 `path: 'primary'|'direct'`；生产 UI 只消费该 source，公开的 `controller.path` 没有消费者。
   - 影响：即使 getStats 正确识别 TURN 或 IPv6，设备页仍只能显示“直连”，无法实现设计要求的浏览器→node 网络路径诊断。
   - 建议修复：在 `DirectDiagnostics` 中增加独立 `route` 字段并发布 `this.route`，避免与 carrier 的 `primary/direct` 状态共用同一个 `path` 名称。

## 结论

该 diff 的首帧 nonce 和基本 ACK 载体选择方向正确，但 DTLS fingerprint 解析存在可实际绕过 hub-MITM 防护的 blocker；此外重试生命周期、rtcSession 更新、切换回退补齐、缓冲边界、背压及网络变化恢复均有会导致连接失败、数据乱序或丢失、PeerConnection 泄漏的问题。当前版本不应合入，需先修复 blocker 和全部 major，并补充相应竞态及恶意分片测试。