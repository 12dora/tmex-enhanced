# EX3 网络栈深度勘察（Opus 探索报告摘要）

## 现状

- 传输：浏览器↔网关 WS（Borsh，无压缩，无 cork；客户端退避 1s·2^n≤30s 无抖动最多 5 次）；浏览器↔node 直连 DataChannel；node↔node dc（node-datachannel + fragmenter 64 KiB + LinkMux，liveness 3 s/10 s）、ws-secure/relay（ctl ping 15 s×3=45 s）；node↔hub uplink（带抖动退避）。
- 终端输出合帧：网关 16 ms/64 KiB leading-edge（`ws/canonical/pane-stream.ts:118-150`），客户端 4 ms/32 KiB（`pane-output-coalescer.ts`）。无 rAF、无固定 tick。没便宜可捡。
- RTC：`mesh/rtc/ice.ts:143-145` 只填 `iceServers`；`enableIceTcp/enableIceUdpMux/bindAddress/portRange/mtu` 全未用；默认单 STUN；TURN 需三 env 齐备默认关；trickle；角色字典序（小 id offerer）；`rtcSession = dc:<lo>:<hi>` 常量无代次；`CONNECT_TIMEOUT_MS=15 s` 串行用于 4 阶段（最坏 60 s）；熔断 30 s·2^level（level 3/4 = 240/480 s 与生产日志吻合），10 次后永久禁用只靠 rearm 源复活。
- 弱网：前端 5 次即永久 CLOSED，只有 `visibilitychange` 自愈，无 `online` 监听；forwarder failover 7 次 ~3.15 s 用尽即关浏览器 WS；dc 10 s vs ws-secure/relay 45 s 检测割裂；`link-stream-carrier` 逐帧 slice+await 不合并；ws 逐帧 send 无 cork；粘贴 1024 字符块串行等回执。
- 测试：RTC 全是 fake，`test-fakes.ts:237-247` `setRemoteDescription` 不校验 signaling state；真回环 `rtc-loopback.integration.ts` 不在 `bun test` 内。

## 根因

- **P0 陈旧信令重放**：offerer 拨号失败后 `releaseRtcAttempt` 注销 listener；answerer 按 5/15/30/60 s 重试产生新 answer → 进 `rtcInbox`（`peer-manager.ts:548-551`，无 TTL、不按类型过滤）；熔断中 `shouldTryDc=false` 不消费；cooldown 后新 PC（stable）`bindSignaling`（`rtc-peer-manager.ts:276`）同步重放 inbox → `setRemoteDescription(answer)` 抛 `Unexpected remote answer description in signaling state stable`。并发变体：多 answer 第二个被 `catch {}` 吞，PC 绑错 ufrag → 15 s 后 `datachannel open timeout`。
- **P0 双泄漏**：`bindSignaling` 在 try 之外，抛错时 `untrackAndClose` 不执行（PC 留在 livePcs）；`signalingFor.onMessage`（`peer-rtc-wake.ts:97-103`）在 `set.add` 后重放抛错，`unsub` 未赋值 → listener 永久残留；之后每次拨号所有僵尸 listener 同时收信令，自我放大。
- P1 无 TURN 硬 NAT 每 4-8 min 白烧 15-60 s；P1 前端 WS 永久放弃；P2 检测节奏割裂；P2 队头阻塞/写放大；P2 候选面过宽（docker0/utun）；P3 粘贴串行。

## 建议（按收益/风险）

- R1 修重放 + 泄漏：`bindSignaling` 移入 try；`apply` 加 expect 类型过滤 + answer 一次性 + try/catch；`onMessage` 重放 try/finally 或 microtask；inbox 不收 offerer 侧 answer/无 PC 的 candidate + 30 s TTL；fake 加 signaling 状态机 + 回归用例。
- R2 SDP/candidate JSON 信封加 `epoch`（不动 `rtcSession`，旧端忽略字段）。
- R3 RtcConfig：`enableIceTcp`、`enableIceUdpMux`、`bindAddress`/接口过滤（复用 `address-class.ts`）、`mtu 1200`、`TMEX_RTC_PORT_RANGE` env；打进 dial start 日志。
- R4 ws-client：抖动、去硬上限（只 fatal 才停）、`online`/`connection.change` 监听。
- R5 熔断 `skipKinds` 排除本地信令错误；禁用后周期 `forceProbe`。
- R6 拨号总 deadline；`waitLocalFingerprint` 改回调。
- R7 ws-secure/relay ping 5 s×3；failover 退避尾部加 3200/6400。
- R8 ws cork（不做全局压缩）；R9 发送分片 16 KiB（向后兼容）；R10 TURN 先量化；R11 粘贴流水线化。
- 不做：unordered DC、rtcSession 后缀、缩 16 ms 合帧、更激进心跳。
