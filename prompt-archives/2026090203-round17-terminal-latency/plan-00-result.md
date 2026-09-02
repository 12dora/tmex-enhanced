# 第十七轮执行结果：jiefa-app 终端延迟突增排查（v1.1.17）

## 现象与证据

- 拓扑：浏览器 → 本机 konata-mac 网关 → 局域网 `ws-secure` 直连 jiefa-app（RTT 约 6 ms，`direct_capable=false`），hub 中转为兜底。
- 本机网关日志（无时间戳）：109 次 `[mesh][stream] failover`（`ws-secure→ws-secure` / `→relay`），附近反复出现 `backpressure_gap`（发送缓冲超 1 MiB 后跳帧并切断该流）、`[mesh][mux] rst recv reason=offline|relay-rst`；`[ws-metrics] terminal_output` 有 `dropped_events`；1921 次到 hub A 的 WebRTC 拨号失败（A 所在 VPS 屏蔽 UDP，`direct_capable=1` 于是被无限重拨，尾部退避 120 s）、42 次到 B。
- 诊断（codex luna，`sub/EX5-diagnosis.md`）：最符合的因果链是「浏览器/远端会话读取变慢 → 发送背压 → 跳帧触发 `backpressure_gap` → carrier 被切断、mux 流 RST → Forwarder failover 重建流 → 重发 HELLO/设备连接/快照/legacy 历史 → 输入排队、输出停顿数秒（代码允许 HELLO 2 s + 恢复 8 s 上限）」；legacy failover 对每个 pane 重拉历史会再次撑爆缓冲形成循环。`replay_byte_limit` 只是回放缓存淘汰，不是触发器。RTC 失败不会抢占直连，但制造信令/日志压力。缺时间戳与关联 ID 是归因的最大障碍。

## 本轮改动（v1.1.17）

1. 可观测性：mesh/ws 日志加 ISO 时间戳（`mesh-log.ts`）；failover 记录 `failover_start`（node/cid/pump/muxStreamId/起因/关闭原因/链路建立时间/排队输入字节）、每次尝试的 getLink/open/hello/resume 耗时、`failover_done` 与一行 `failover_summary`（含回放字节与事件循环延迟）；背压日志区分 `physical_browser_ws`/`mesh_link_stream`，只在进入/排空/终止/每 5 s 采样时输出；mux RST 带 `muxStreamId` 与 nodeId/transport；事件循环延迟采样器（`event_loop_lag_ms`/`max_lag_ms`，`TMEX_EVENT_LOOP_LAG_WARN_MS` 默认 250）。
2. WebRTC 拨号熔断：同一对端连续失败 8 次后 6 h 内不再拨 DataChannel（`TMEX_RTC_DIAL_BREAKER_MS`），成功或对端 endpoint/能力变化即复位；拨号失败日志每对端 60 s 一条并聚合计数。
3. failover 历史回放封顶：`TmuxFetchPaneHistory` 带 `byteLimit`（旧目标兼容），每 pane ≤256 KiB、每次 ≤1 MiB，按剩余预算在 pane 间分配（下限 16 KiB），实在分不到的 pane 发 `SourceGap(resource_exhausted)` 让客户端刷新首屏，而不是悄悄漏输出。

审查（codex sol RV5）8 条全部采纳并修复（上限端到端生效、无静默跳过、热路径只计数、日志永不抛异常、帧类型解码修正、限频单点记账、采样器生命周期、PeerManager 级熔断测试）。

## 门禁与上线

gateway 3593 pass（4 个负载 flake 隔离复跑 154/0）/ shared 442 / ws-client 306 / fe 1570 / panels 747 / terminal-ui 358；tsc 0；lint 通过。发版 v1.1.17（`fd0f8d8a`），六节点全部升级（本机/A/B `tmex upgrade`，jiefa×2 入口推包，docker-node 手动）。

## 下一步

真因需在生产上用新日志确认：下次卡顿后在本机 `~/Library/Application Support/tmex/tmex.log` 中查看带时间戳的 `failover_summary`（cause / 各步耗时 / replay_bytes / lag）与 `backpressure` 行（carrier 类型、跳过字节），据此决定是继续压低历史回放、还是处理浏览器侧读取停顿（后台标签页 / PWA）或链路心跳。
