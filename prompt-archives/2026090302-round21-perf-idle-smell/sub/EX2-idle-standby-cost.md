# EX2 — 常驻/待机成本盘点（服务端 + PWA）

范围：`/Users/konata/code/tmex-r21`（只读探查）。所有结论均带 `file:line`。
已读并规避重复提案：`prompt-archives/2026090102-round12-leftovers/plan-00-result.md`（隐藏页心跳 5s/10s→30s/60s、mesh 兜底轮询 30s→5min + 事件驱动、KeepAlive coldPanes 60s）与 `prompt-archives/2026090101-round11-pwa-files-auth/plan-00-result.md`（视口策略、远端运行时按需创建、静态资源缓存）。

指挥官现场观测（生产节点，只读）：网关空闲 **5.65% 单核**（30 s 采样，RSS 310 MB）；`~/Library/Application Support/tmex/tmex.log` **81 MB / 96k 行且无任何轮转**；日志成分以 `[ws-metrics]`（≈64k 行）与 `[mesh][rtc]`（≈20k 行）为主。下文把这些逐条落到代码。

---

## 0. 先给结论（TL;DR）

1. **日志是第一现场，也是最容易砍的**：全仓没有日志分级、没有轮转、没有采样。`[ws-metrics]` 三条巨行每 30 s 一发且全零也发；macOS launchd 用 `StandardOutPath` 直写 `tmex.log`（`packages/app/src/lib/service.ts:110`），永不截断。写日志是同步 `console.log` → stdout → 文件 fd，直接计入网关 CPU 与磁盘唤醒。
2. **5.65% 空闲 CPU 的最大嫌疑不是定时器数量，而是"空闲时仍有终端输出在流"**：`[ws-metrics]` 只由终端输出批次刷新驱动（`apps/gateway/src/ws/index.ts:87`、`apps/gateway/src/ws/legacy-feed-broadcaster.ts:228`），它能稳定每 30 s 出现，说明 control-mode 一直在收字节并走完整条 parse→retention→batch→ws 管线。这条必须先量（见 §4）。
3. **每 15 s 一次的 mesh "upgradeScan" 是隐藏的重活**：`os.networkInterfaces()` 系统调用 ×(1+N_peer)、每个 live peer 一次 `users` 表 SELECT、每个 peer 一次状态 JSON 序列化——全部在没有任何客户端时照跑。
4. **对着一个坏证书的 hub 每 60 s 敲一次 TLS**，无上限退避、每次都打一行 info 日志。
5. **PWA 端最贵的两件事**：每个终端实例 1 Hz 的光标闪烁 `setInterval`（保活隐藏实例也在跑，且不看 `document.hidden`），以及手机键盘弹起时**每帧强制同步布局**的 follow rAF 循环。

---

## 1. 服务端空闲清单

图例：**0-client** = 没有任何浏览器/PWA 连接时是否仍然跑。

### 1.1 无条件常驻（进程活着就跑）

| # | 定时器 | file:line | 周期 | 每拍工作 | 0-client | 代价 |
|---|---|---|---|---|---|---|
| S1 | 事件循环 lag 采样 | `apps/gateway/src/ws/event-loop-lag.ts:96`（由 `apps/gateway/src/runtime.ts:83` 启动，`:250` 才停） | **1 s**（递归 setTimeout，`unref` 但照样触发） | push 一个 `{at,lag}` 样本、`prune()` 用 `Array.shift()` 裁 30 s 窗口、超阈值 `console.warn` | ✅ 跑 | 60 唤醒/min，纯 CPU。样本只被 `forwarder-failover.ts:231` 与 `gateway-metrics-log.ts:113/242` 读，**都是事件驱动的读点** |
| S2 | 传输会话 GC | `apps/gateway/src/files/transfer-session.ts:234` | 5 min | `sweepStale()` 遍历内存会话表 | ✅ 跑 | 0.2 唤醒/min，可忽略（已 `unref`，`:235`） |

### 1.2 mesh 常驻（节点已入网即跑，与客户端无关）

| # | 定时器 | file:line | 周期 | 每拍工作 | 0-client | 代价 |
|---|---|---|---|---|---|---|
| S3 | **peer upgradeScan（全局）** | `apps/gateway/src/mesh/peer-manager.ts:406` | **15 s** | ① `syncLocalFingerprint()`→`os.networkInterfaces()`（`:369`,`:1554`）；② `endpointBackoff.prune()`；③ `refreshAdvertisedStatus()`→**每个 live peer** 走 `sendPeerStatus`（`:2059`）：调 `statusProvider()`（`mesh-runtime.ts:963` 内**再来一次** `os.networkInterfaces()`）+ `jsonStable()` 序列化 + **`keyLogApplier.head(userId)`→`users` 表 SELECT**（`auth/key-log-store.ts:44`）；④ `notifyPeerEndpointsChanged()`→对每个 peer 跑 `maybeUpgrade(cooldown)` | ✅ 跑 | 4 唤醒/min，但每拍 syscall 数 = 1+N_peer，DB 查询数 = N_peer。**网络零字节**（`:2064` 按编码串去重） |
| S4 | peer ctl ping（每 peer） | `apps/gateway/src/mesh/peer-manager.ts:2095`，常量 `:100`=15 s | 15 s/peer | 发 `{t:'ping'}`，`missedPongs` 计数，超 limit 掉线 | ✅ 跑 | N_peer × 4 唤醒/min + N_peer × 4 小包/min（含对端 pong = ×2） |
| S5 | peer idle 判定（每 peer） | `apps/gateway/src/mesh/peer-manager.ts:2153`，`PEER_IDLE_MS`=5 min（`:96`） | 5 min/peer | 无 stream 且超时 → `dropPeer('idle')` | ✅ 跑 | 极小 |
| S6 | **RTC DataChannel liveness（每 DC 链路）** | `apps/gateway/src/mesh/rtc/liveness.ts:139`（interval）+ `:154`（timeout），常量 `:4`=3 s / `:5`=10 s | **3 s** | 距上次入站 ≥3 s 就发 liveness ping（`data-channel-carrier.ts:194`），对端回 pong（`:69`）；两侧对称 | ✅ 跑 | 每链路 ≈20 ping + 20 pong/min，走 DTLS/SCTP → **两端进程都被唤醒**、都要 AEAD 解包。笔记本待机耗电大户 |
| S7 | uplink 心跳（每 hub 上行） | `apps/gateway/src/mesh/uplink-client.ts:685`，`UPLINK_PING_INTERVAL_MS`=15 s（`:42`） | 15 s | 发 ping + `sendStatusIfChanged()`（`:357`）→ 又一次 `statusProvider()` → 又一次 `os.networkInterfaces()` | ✅ 跑 | 4 唤醒/min + 4 包/min + 4 syscall/min |
| S8 | **uplink failback 探测** | `apps/gateway/src/mesh/uplink-pool.ts:1120`，`UPLINK_POOL_PROBE_INTERVAL_MS`=60 s（`:55`） | **60 s**（仅当当前挂的不是首选 hub） | `probePreferred()`（`:1342`）对每个更优候选做 HTTPS `/healthz`（`:1382`），**成功/失败各打一行 info 日志且无速率限制**（`:1358`,`:1361`） | ✅ 跑 | 1 唤醒/min + 1 次完整 TCP+TLS 握手/min + **1440 行日志/天**。这就是现场看到的 `[uplink] candidate failed … TLS handshake failed` 永不停 |
| S9 | uplink RTT 探测 | `apps/gateway/src/mesh/uplink-pool.ts:1143`，`UPLINK_POOL_RTT_PROBE_INTERVAL_MS`=300 s（`:59`） | 5 min（≥2 候选时） | 串行对**所有**候选做 HTTPS `/healthz`（`:1162`），再 `considerNearestSwitch()` | ✅ 跑 | 每 5 min N_hub 次 HTTPS。坏证书 hub 也照打 |
| S10 | RTC 授权表清扫 | `apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:193`，`RTC_AUTHORIZE_SWEEP_INTERVAL_MS`=15 s（`:61`） | 15 s | `sweepBrowser()` 遍历授权 Map 删过期 | ✅ 跑 | 4 唤醒/min，工作量 O(授权数)，通常为 0 |
| S11 | TLS 指纹轮询 | `apps/gateway/src/mesh/mesh-runtime.ts:1201`，`TLS_STATUS_POLL_MS`=10 min（`:143`） | 10 min | 重读 CA 指纹 | ✅ 跑（配了 TLS 时） | 可忽略 |
| S12 | peer 停用/park 定时器 | `peer-manager.ts:2279`（park 30 s 上限）、`:2382`（retire） | 一次性居多 | 状态收敛 | 仅切换期 | 可忽略 |

### 1.3 hub 角色额外（本机若是 hub）

| # | 定时器 | file:line | 周期 | 每拍工作 | 0-client | 代价 |
|---|---|---|---|---|---|---|
| S13 | 每上行连接心跳 | `apps/gateway/src/hub/uplink-server.ts:1801`，`HUB_HEARTBEAT_INTERVAL_MS`=15 s（`hub/types.ts:64`） | 15 s × N_node | `beat()` 发 ping/查 miss | ✅ 跑 | N_node × 4 包/min |
| S14 | attachment keepalive | `apps/gateway/src/hub/uplink-server.ts:1809`，`ATTACHMENT_KEEPALIVE_MS`=2 min（`hub/attachment-router.ts:2`） | 2 min | `publishLocalAttachments()`（`:696`）：`listAuthenticated()` 遍历两遍 + 向所有对端 hub 广播全量 attachment 列表 | ✅ 跑 | 每 2 min 一次跨 hub 广播；多 hub 下是真实带宽 |

### 1.4 tmux 侧（有设备 runtime 时）

| # | 定时器 | file:line | 周期 | 每拍工作 | 0-client | 代价 |
|---|---|---|---|---|---|---|
| S15 | tmux control-mode 心跳 | `apps/gateway/src/tmux-client/external/control-mode-lifecycle.ts:97`，`HEARTBEAT_INTERVAL_MS`=30 s（`external/constants.ts:7`） | 30 s/设备 | 向 control 通道写 `display-message -p "tmex-hb"`，**唤醒 tmux server 进程**做命令解析 + 回包 + 网关侧 block 解析；同时武装 10 s 超时 timer | ❌ 不跑（见下） | 2 唤醒/min/设备 + **tmux server 进程 2 次唤醒/min** |
| S16 | pane 保留策略截止 | `apps/gateway/src/tmux-client/retention/policy-scheduler.ts:161` `scheduleNextDeadline` | 事件驱动（按最近截止武装） | trim replay / 降级模式 | 随 runtime | 设计良好，无固定周期 |

**0-client 时 runtime 是否存在**：`apps/gateway/src/ws/device-connection-registry.ts:91` 在最后一个客户端断开后 `RUNTIME_IDLE_GRACE_MS`=5 s（`ws/types.ts:51`）释放整个 entry，因此 **真·零客户端时 tmux control-mode 会被断开**，S15 不跑。反过来说：现场 5.65% 的空闲 CPU 是"有客户端挂着（手机 PWA 后台 / 浏览器标签）"这一常态下的成本，而不是零客户端成本。

### 1.5 可选服务（配置后才跑）

| # | 定时器 | file:line | 周期 | 备注 |
|---|---|---|---|---|
| S17 | 微信保活扫描 | `apps/gateway/src/weixin/service.ts:259`，`KEEPALIVE_SWEEP_MS`=30 min（`:26`） | 30 min | 遍历授权用户，≥8 h 无交互发保活；已 `unref`（`:260`） |
| S18 | 微信 iLink 长轮询 | `apps/gateway/src/weixin/ilink/update-loop.ts`，`DEFAULT_LONGPOLL_TIMEOUT_MS`=60 s（`:26`） | 60 s 长连 | 每分钟一次 HTTP 往返 |
| S19 | watch 规则 | `apps/gateway/src/watch/scheduler.ts:230`，下限 5 s / LLM 30 s（`:3`,`:4`） | 用户配置 | 已按 pane 分组合并到一个 timer（`armGroup`，`:216`），设计良好 |
| S20 | push 重连 | `apps/gateway/src/push/supervisor.ts:343` | 退避一次性 | 无常驻轮询 |
| S21 | 版本更新检查 | `apps/gateway/src/system/update-check.ts:40` | **无后台轮询**（仅 API 触发） | 好 |

### 1.6 空闲期的 DB 写 / 日志写 / 网络

**DB 写（SQLite WAL，`journal_mode=WAL` + `synchronous=NORMAL`，`apps/gateway/src/db/client.ts:11-13`）**

- `apps/gateway/src/auth/node-session-store.ts:103-110`：跨节点会话每次校验若距上次续期 > `NODE_SESSION_RENEW_THROTTLE_MS`=5 min（`:8`），就在**事务里 UPDATE** `node_sessions`。校验点 `mesh-runtime.ts:920` 由 `WS_SESSION_VERIFY_MS`=5 min（`mesh-deps.ts:19`）节流。→ **每个远端会话每 5 min 一次写事务**，纯待机也发生，WAL 增长 + 潜在 checkpoint。
- 未见任何 VACUUM / 定期 checkpoint / 清理任务，`wal_autocheckpoint` 用默认值（1000 页）。

**DB 读（空闲）**

- S3 每 15 s × N_peer 次 `users` 表 SELECT（`key-log-store.ts:44`）。
- `apps/gateway/src/events/channels/webhook.ts:22` 每次 `notify` 都 `getSiteSettings()`；`:12` 的 60 s 节流只挡住 `getAllWebhookEndpoints()`，**且 webhook 数为 0 时照样打印 `[events] refreshed config: 0 webhooks`**（`:19`）——现场 240 行就是这么来的。它不是轮询，是"每次事件通知"，说明空闲期事件通知本身有 240 次。

**日志写（空闲）— 这是 81 MB 的来源**

- 全仓**没有日志级别系统**：`apps/gateway/src/mesh/mesh-log.ts` 只有 `stamp()/logLine()/warnLine()`，无 level、无开关；`rtcLog()`（`mesh/rtc/rtc-log.ts:52`）直接 `console.log`。
- **没有轮转**：macOS 走 launchd `StandardOutPath` → `packages/app/src/lib/service.ts:110` 直接 append `<installDir>/tmex.log`，`:111` 同理 `tmex.err.log`。Linux 走 `StandardOutput=journal`（`:62`）由 journald 轮转——**只有 macOS 无上限**。全仓 grep 无 `logrotate` / 大小上限 / truncate 逻辑。
- 三条 `[ws-metrics]` 巨行（`gateway-metrics-log.ts:116`、`:168`、`:245`）每 30 s 同时发出（`:198` 串联 activity，`:135` 串联 ping），**没有"全零跳过"判断**，`takeIfDue` 只看时间窗（`:67`、`:81`）。单条 `terminal_output` 约 30 个字段、`gateway_activity` 约 25 个字段，估算 3 行 ≈ 1.2–1.8 KB → **≈2.5 MB/天**，与 81 MB / 96k 行 + "ws-metrics 占 64k 行"完全吻合。
- 更糟的是这条路径**顺手做了实活**：`gateway-metrics-log.ts:205` 对每个连接调 `getPaneRetentionStats()` → `retention/policy-scheduler.ts:55` `snapshotStats()` 的第一句就是 **`this.sweep()`**（`:56`），会遍历所有 pane 做 `trimPaneReplay` + `advanceModeDeadlines` + `enforceBounds` + 重排 timer。即"读一次指标 = 全量清扫一次"。同时 `:141` `gatewayWebSocketSendGuard.snapshotStats()` 会 flat 出所有 carrier。
- `[ws] client connected` / `client disconnected`（`ws/index.ts:199`、`ws/session-close.ts:32`）**不带任何标识**（无 session id、无 client kind、无 close code/reason），既没法诊断又是纯噪声。

**网络（空闲）**

- peer ping 15 s × N_peer（双向）、uplink ping 15 s、RTC liveness 3 s × N_dc（双向）、failback probe 60 s HTTPS、RTT probe 300 s × N_hub HTTPS、hub attachment 广播 120 s。
- `sendPeerStatus` 与 `sendStatusIfChanged` 都做了内容去重（`peer-manager.ts:2064`、`uplink-client.ts:359`），**状态不变则零字节**——这块已经很干净。

---

## 2. 现场四条观测的代码归因

### 2.1 `[mesh][rtc]` ≈20k 行，同两台 peer 每 ~15 min 一轮，WebRTC 永不成功

**熔断器确实在生效，观测到的节奏就是它的设计上限，不是 bug**：

- `apps/gateway/src/mesh/rtc/rtc-dial-breaker.ts:288` `cooldownMs = min(breakerMs·2^level, maxMs)`，`RTC_DIAL_BREAKER_BASE_MS_DEFAULT`=30 s（`:5`）、`RTC_DIAL_BREAKER_MAX_MS`=**30 min**（`:6`）。`noteFailure`（`:186`）每次 trip 后 `cooldownLevel++`（`:218`），几轮后钉死在 30 min。两台 peer 各自 30 min 一轮 → 宏观上"每 ~15 min 一次"。
- **wake 信号不会复位熔断**：`peer-manager.ts:920` 之后立刻 `if (live?.transport==='dc' || !this.shouldTryDc(fromNodeId)) return;`（`:921`），`shouldTryDc`（`:888`）含 `dcBreaker.shouldTry().allow`。发送侧 `dispatchRtcWake`（`:1238`）同样在 `:1244` 检查 `shouldTryDc`。**结论：wake 不是复位源。**
- **cooling 期间不做 ICE**：`armDcUpgradeRetry`（`:1055`）在 `!decision.allow` 时直接转 `scheduleDcBreakerProbe`（`:1125`）——只 sleep 到 cooldown 到期，不建 PeerConnection。`rtcLog('upgrade retry', {cause:'breaker_cooling'})`（`:1140`）就是现场那行，**它是"我在等"的一次性日志，不是重试**。
- 唯一的复位路径是真的健康 60 s：`RTC_DIAL_BREAKER_HEALTHY_MS`=60 s（`rtc-dial-breaker.ts:7`）+ `armDcHealthTimer`（`peer-manager.ts:1026`）。`notePeerChanged`（`:254`）已按注释明确**不再**复位计数。

**那 20k 行是怎么来的？** 每轮解冻后的一次真实拨号，全程 info 级无差别输出：`dial start`、`signal send/recv`（SDP）、`datachannel created`、每类候选每秒一行（`rtc-log.ts:115` 的 key 是 `peer:dir:type`，`:90` 限速 1 s——**gathering 期一个类型就能出好几行**）、`gathering`、`ice failed`（`:99`）、`dial failed`（`:71` 限速 60 s）。一轮 ≈30–60 行 × 2 peer × 每 30 min ≈ **150–200 行/小时 ≈ 4–5k 行/天**，5 天就 20k。每轮还伴随一次完整 ICE gathering：向 STUN 发包、枚举所有本地地址、建 DTLS 上下文，以及经 hub 中转的 SDP 信令往返。

### 2.2 `[ws-metrics]` ≈64k 行

见 §1.6。触发点是终端输出批次（`ws/index.ts:87`）或每 1024 个 source event（`legacy-feed-broadcaster.ts:228`），**不是定时器**。它能稳定每 30 s 出现 ⇒ **系统"空闲"时终端仍在持续产生输出**（TUI 重绘 / agent / 带时钟的 prompt）。这同时是 5.65% CPU 的最大解释项，必须先用 §4 的方法确认。

### 2.3 `[ws] client connected/disconnected` ≈700、`refreshed config:` 240

- 连接日志：`ws/index.ts:199`、`ws/session-close.ts:32`，无内容。350 对连断在数天里，来源包括手机 PWA 前后台切换（`ws-client/src/client.ts:657` 可见即重连）、网络切换，以及 §2.4 的每次 stream failover 都会重建网关侧 session。
- `refreshed config:`：`events/channels/webhook.ts:19`，**不是轮询**（`:12` 60 s 节流的是 DB 查询），是 240 次事件通知的副产品；0 个 webhook 也照打。

### 2.4 `failover_start … cause=stream_close close_reason=reset from=ws-secure` 每小时数次 + `max_lag_ms=56675`

- 退避表 `STREAM_FAILOVER_BACKOFF_MS = [0,50,100,200,400,800,1600]`（`apps/gateway/src/mesh/mesh-deps.ts:21`）——正好 7 次尝试，与现场"5–7 次"吻合。
- **每次成功 failover 的代价是真实的重放**：`forwarder-failover.ts:199` `replaySubscription()` 重发订阅并等 hello/resume（`STREAM_FAILOVER_RESUME_WAIT_MS`=8 s，`mesh-deps.ts:23`），`:224` 统计 `replayBytes`，`:228` 把整段历史重灌给浏览器。即：**一次 failover = 一次重订阅 + 一次历史重放**，并再打 4 行日志（`:200`、`:236`、`:240`、`:252`）。
- `max_lag_ms=56675` 来自 `event-loop-lag.ts:107` `maxLag()`，窗口 30 s（`:4`）。**56 s 的"滞后"几乎不可能是纯 JS 阻塞**——最可能是 macOS 整机睡眠 / App Nap 导致 1 Hz timer 长时间不触发，醒来后第一拍算出巨大 lag。它同时也解释了 failover 突发：机器睡醒后所有 peer 链路同时判定超时。
  - 若要排查真·阻塞，候选点：`system/upgrade.ts` 的 `readdirSync`/`readFileSync`（`:402`,`:478`,`:550`,`:573`）、`files/transfer-session.ts:246` 启动期 `readdirSync`+`statSync`、`tmux-client/ssh-auth-resolvers.ts:48` 与 `tmux/local-shell-path.ts:71` 的 `Bun.spawnSync`、以及大 JSON `jsonStable()`。但这些都是启动期/操作期，**不解释稳态 56 s**。
  - **建议**：把"lag 采样"与"系统睡眠"区分开——记录 wall-clock 与 `performance.now()` 的漂移差，漂移大的样本标记为 `suspend` 而不是 `lag`，否则这个指标会持续误导。

### 2.5 坏证书 hub 的无上限重试

`uplink-pool.ts:1120` 的 failback probe 固定 60 s（仅带 `probeJitter` 抖动，`:1124`），**没有随失败次数增长的退避、没有次数上限、没有"连续 N 次 TLS 失败就降级为 5 min/30 min"**。`probePreferred` 的 `[uplink] probe fail hub=…`（`:1358`）**完全没有速率限制**（`logCandidateEvent` 的 60 s 去重只作用于 `candidate failed` 一类，`:1477`）。→ 1440 次 TLS 握手 + 1440 行日志/天，永远。

---

## 3. PWA / 浏览器侧空闲清单

| # | 项 | file:line | 周期 | 每拍工作 | 标签页隐藏时是否跑 | 代价 |
|---|---|---|---|---|---|---|
| P1 | **光标闪烁** | `packages/ghostty-terminal/src/cursor-layer.ts:224`，`BLINK_INTERVAL_MS`=1000（`:24`） | **1 s / 每个终端实例** | 翻转 `canvas.style.opacity` | ✅ 跑（无 visibility 判断） | **每实例 60 唤醒/min**。保活池隐藏实例的 slot 只是 `opacity:0`（`panels/src/device-console/terminal-stage.tsx:277`），实例仍挂载 → **看不见的 pane 也在闪**。3 个保活 pane = 180 唤醒/min |
| P2 | WS 心跳 | `packages/ws-client/src/heartbeat-controller.ts:83`；可见 5 s / 隐藏 30 s（`client.ts:68`,`:72`，round 12 已做） | 5 s（可见） | 编码 borsh PING 帧 + 武装 pong 超时（`:111`） | ✅ 跑（已降到 30 s） | **每个 ws client 12 ping/min**。多节点时 `stores/src/node-connection-manager.ts` 每个远端 runtime 一条连接 → ×N。服务端每个 PING 触发 `recordPingProbe`→`logPingMetricsIfDue`（`gateway-metrics-log.ts:107`） |
| P3 | **hub 节点表轮询** | `apps/fe/src/node/mesh-nodes.ts:844`，`HUB_POLL_MS`=30 s（`:506`） | 30 s | `GET /n/<hub>/api/hub/nodes` —— **跨节点 REST，走 peer 链路或 hub 中转** | ✅ 跑（**没有任何 visibility 判断**，对比 `mesh-hubs.ts:169` 与 `mesh-nodes.ts:539` 都有） | 设置-节点页留在后台标签页 → 每 30 s 一次跨网 mesh 往返，永远 |
| P4 | mesh nodes 兜底轮询 | `apps/fe/src/node/mesh-nodes.ts:574`，`MESH_NODES_POLL_MS`=300 s（`:497`） | 5 min | 隐藏时跳过这一拍（round 12 已做） | timer 仍触发，但不发请求 | 可忽略 |
| P5 | mesh hubs 轮询 | `apps/fe/src/node/mesh-hubs.ts:198`，`MESH_HUBS_POLL_MS`=30 s（`:22`） | 30 s | 隐藏时跳过 | timer 仍触发 | 仅 hub 管理面 |
| P6 | **键盘 follow rAF 循环** | `packages/terminal-ui/src/hooks/use-keyboard-avoidance.ts:205` `startFollowLoop` ← `:189` 无条件重排 | **每帧（~60 Hz）** | 每帧：`document.querySelector` ×2（`:110`,`:121`）、`getComputedStyle`+`DOMMatrix`（`:89`,`:94`）、`getBoundingClientRect` ×2（`:114` + `readActiveCursorRect`）、`offsetHeight`（`:122`）→ **每帧强制同步布局**；并且 `setShortcutLift`（`:101`）**每帧都往 `documentElement` 写 CSS 自定义属性** → 整文档样式失效 | 键盘收起才停（`:148` `inset<=0`） | 手机上键盘弹起且终端聚焦 = **持续 60 fps 的 layout thrash**。`commit()` 有去重（`:71`）但 `setShortcutLift` 没有 |
| P7 | 选区自动滚动 | `packages/ghostty-terminal/src/terminal-selection.ts:224` | 拖拽期间 | 滚动 | ❌ | 交互期，合理 |
| P8 | 批量升级心跳 | `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:1259` | 升级期间 | 保活计划 | ❌ | 合理 |
| P9 | 入网轮询 | `apps/fe/src/node/enrollment-engine.ts:420`，5 s（`enrollment-watch.ts:17`） | 入网期间 | 轮询 | 仅在有待处理入网时 | 合理 |
| P10 | 终端渲染 rAF | `packages/ghostty-terminal/src/terminal-render-loop.ts:14` | 按需（一次一帧，`:10` 合并） | paint | ❌ 无数据不排帧 | **设计良好，无常驻 rAF** |
| P11 | 无限 CSS 动画 | `apps/fe/src/index.css:47`（`--animate-scroll`）、`:56`（`pulse-dot`）、`agent-session-row.tsx:26` 的 `motion-safe:animate-pulse` | 持续 | 合成层动画 | 浏览器在页面隐藏时暂停渲染 | 影响小于 JS timer；`agent-session-row` 的脉冲点只在有 running 会话时出现 |
| P12 | Service Worker | 全仓无注册（`grep serviceWorker` 无命中，`apps/fe/public` 无 sw） | — | — | — | 没有后台 sync / periodic sync 的额外开销 |

**每个打开的标签页的量化**（终端页 + 3 个保活 pane + 1 条 WS）：
`P1 3×60 + P2 12 = 192 次 JS 唤醒/min ≈ 3.2 Hz`；若停在设置-节点页再 +2/min 的跨网 REST；手机键盘弹起时再叠加 **60 Hz 的强制布局**。

---

## 4. 优化提案（按性价比排序）

> 硬约束：**不得削弱 mesh 存活判定、failover 语义与重连语义**。凡触碰 ping/liveness/heartbeat 的，超时判定必须与发送节奏同比例放大，且必须保留"有事件时立刻恢复快节奏"。

### P0 —— 立刻、低风险、直接砍掉现场看到的量

| 编号 | 提案 | 机制 | file:line | 预期收益 | 风险 | 规模 |
|---|---|---|---|---|---|---|
| **O1** | **`[ws-metrics]` 全零不发** | `takeIfDue` 返回的 snapshot 若所有计数器为 0 且队列均为空，直接 return 不 `console.log`；窗口照常重置 | `gateway-metrics-log.ts:110`(ping)、`:134`(terminal_output)、`:201`(gateway_activity)；判空点 `ping-metrics:67`、`TerminalOutputMetrics.takeIfDue`、`GatewayActivityMetrics.takeIfDue` | 空闲日志量 **−60%~−90%**（64k/96k 行）；同时省掉每 30 s 一次的 `snapshotStats()` 全量 pane sweep | 极低。指标只用于事后排查，"没输出"本身就是信息 | **S** |
| **O2** | **指标读取不再触发清扫** | `RetentionPolicyScheduler.snapshotStats()` 去掉首行 `this.sweep()`，改为纯读；清扫仍由 `afterIngest`/`nudgePaneDeadline` 的既有 deadline timer 负责 | `retention/policy-scheduler.ts:56` | 每次指标发射省一次 O(pane) 全量遍历 + timer 重排 | 低：需确认无调用方依赖"读即清扫"的副作用（跑 `policy-scheduler.test.ts`） | **S** |
| **O3** | **日志分级 + 轮转** | ① 在 `mesh-log.ts` 加 `TMEX_LOG_LEVEL`（error/warn/info/debug，默认 info），把 `rtcLog`（`rtc-log.ts:52`）、`[ws-metrics]`、`[uplink] probe ok/fail`、`[ws] client connected/disconnected` 降到 debug；② macOS 侧在 `run.sh` 用 `exec … 2>&1 \| <轮转器>` 或在网关内实现按大小切分并保留 N 份 | `packages/app/src/lib/service.ts:110-112`（plist）、`mesh-log.ts`、`rtc-log.ts:52` | `tmex.log` 从无界变成有界；空闲磁盘写 ≈ 0 | 低。注意 launchd 的 `StandardOutPath` 是 fd 直写，**外部 truncate 会留空洞**，正确做法是网关自己写文件或用 `newsyslog`/`copytruncate` 感知的方案 | **M** |
| **O4** | **连接日志带上下文** | `[ws] client connected` 补 session id / carrier kind / remote；`disconnected` 补 code+reason | `ws/index.ts:199`、`ws/session-close.ts:32` | 350 对连断从噪声变成可诊断线索 | 无 | **S** |
| **O5** | **坏 hub 候选的指数退避 + 日志限速** | failback probe 从固定 60 s 改为"按该候选连续失败次数指数退避（60 s → 2/4/8… 封顶 30 min）"，成功一次即复位；`probe ok/fail` 两行走 `candLogAt` 同款 60 s 去重（或降 debug） | `uplink-pool.ts:1120`（interval）、`:1342-1362`（probePreferred）、`:1467-1499`（logCandidateEvent 去重范式可复用） | 坏证书 hub：**1440 → ~50 次 TLS 握手/天**，日志同比例下降 | **中**：failback 是主备切回的唯一通路，退避拉长会推迟"首选 hub 修好后自动切回"。必须保留 `requestFailbackProbeFromNodeList`（`:1266`）与 `scheduleProbe(failbackDebounceMs)` 的事件驱动即时探测，让 node.list 变化能立刻打断退避 | **M** |
| **O6** | **RTC 拨号日志降级** | `dial start`/`signal send/recv`/`datachannel created`/每候选行 全部降到 debug，只保留 `breaker trip`/`breaker reset`/`dial failed`(已 60 s 限速) 在 info | `rtc-log.ts:52`、`:107`（候选）、`peer-manager.ts:920`（wake recv，且该行在熔断判定**之前**打，应移到 `:921` 之后） | `[mesh][rtc]` 20k 行 → 数百行 | 极低 | **S** |

### P1 —— 中等收益，需要小心

| 编号 | 提案 | 机制 | file:line | 预期收益 | 风险 | 规模 |
|---|---|---|---|---|---|---|
| **O7** | **PWA 光标闪烁改 CSS 动画 + 隐藏即停** | 用 `@keyframes` + `animation: blink 1s steps(2) infinite` 替代 `setInterval`（浏览器在标签页隐藏时自动暂停合成动画）；同时在 KeepAlive slot 不可见时 `stopBlink()` | `ghostty-terminal/src/cursor-layer.ts:220-236`；可见性来源 `panels/src/device-console/terminal-stage.tsx:277` 的 `data-visible` | 每标签页 **−60×N 次 JS 唤醒/min**（N=终端实例数），后台标签页归零 | 低。需确认 tmux 报的 `blinking=false` 时仍能立刻停（`:110`） | **S** |
| **O8** | **键盘 follow 循环加"稳态退出"** | ① `setShortcutLift` 在 `Math.round` 后与 `appliedShortcutLift` 相等时**不写** CSS 变量（`:101`）；② 连续 N 帧（如 3 帧）测量结果无变化则 `stopFollowLoop()`，改由 `selectionchange`/键入/`viewport` 事件重新 `startFollowLoop()` | `terminal-ui/src/hooks/use-keyboard-avoidance.ts:101`、`:189`、`:199-211` | 手机键盘弹起时从 **60 Hz 强制布局 → ~0**；这是 PWA 端最大的单点耗电 | **中**：光标移动不发事件正是当初上 rAF 轮询的原因（`:47` 注释）。稳态退出必须挂上"任意按键/输出后重启循环"的钩子，否则光标跟随会失灵。建议先只做 ①（零风险），②做成可开关 | **S**(①) / **M**(②) |
| **O9** | **`useHubNode` 轮询加 visibility 门** | 复用 `mesh-nodes.ts:537` 的 `browserVisibility()`，隐藏时跳过这一拍、回前台若过期立即补拉 | `apps/fe/src/node/mesh-nodes.ts:843-846` | 后台标签页的跨网 mesh REST 归零 | 极低（与 P4/P5 已有范式一致） | **S** |
| **O10** | **合并 mesh 的 15 s 族到一个共享 ticker** | S3/S4/S7/S10 全是 15 s，各自独立 timer。改为一个 15 s 主 ticker 分发（`ctl.ts:76` 的 `defaultScheduler.interval` 是唯一入口，适合在此加一层"对齐到 15 s 网格"的复用） | `mesh/ctl.ts:76`；消费点 `peer-manager.ts:406/2095`、`uplink-client.ts:685`、`rtc/rtc-peer-manager.ts:193` | 唤醒次数不变但**唤醒时刻对齐**，让 CPU 有更长的连续空闲窗（macOS timer coalescing 友好），实测通常能降 10–20% 空闲功耗 | 低。但要给 ping 保留少量抖动，避免 N 个 peer 同时发包造成毛刺 | **M** |
| **O11** | **`statusProvider()` 结果缓存** | `os.networkInterfaces()` 每 15 s 被调用 1+N_peer+1 次。加 5–10 s TTL 缓存（或改为由 `syncLocalFingerprint` 变更时才失效），`sendPeerStatus` 复用同一份 | `mesh-runtime.ts:963-976`；调用点 `peer-manager.ts:2060`、`uplink-client.ts:342/359` | syscall 数从 O(N_peer)/15 s 降到 1/15 s | 低。指纹变化本来就由 `syncLocalFingerprint`（`peer-manager.ts:1554`）在同一拍检测 | **S** |
| **O12** | **`keyLogApplier.head()` 缓存** | `users` 表 SELECT 每 15 s × N_peer。key log head 只在 `notifyKeyLogHeadChanged()`（`peer-manager.ts:670`）时变，改为进程内缓存 + 该回调失效 | `peer-manager.ts:2078-2088`、`auth/key-log-store.ts:44` | 空闲 DB 读 −N_peer×4/min | 低：已有明确的失效信号 | **S** |

### P2 —— 需要设计，收益大但动语义

| 编号 | 提案 | 机制 | file:line | 预期收益 | 风险 | 规模 |
|---|---|---|---|---|---|---|
| **O13** | **RTC liveness 自适应节奏** | 3 s 是"交互中"的节奏。链路无业务流量超过 T（如 60 s）后降到 15 s ping / 45 s timeout；任一方向出现真实数据帧立即恢复 3 s。两端节奏由发起方在 hello 里协商或各自独立（对称降速天然一致） | `mesh/rtc/liveness.ts:136-149`（armInterval）、`:151-169`（armTimeout）、`:129` noteInbound 已是恢复钩子 | 每 DC 链路 **40 → 8 次唤醒/min**（双向），DTLS 解包同比例下降；笔记本待机功耗可感 | **中高**：直接改故障检测延迟（10 s → 45 s）。必须与 `PEER_MISSED_PONG_LIMIT`、`rtc-dial-breaker` 的 `liveness-timeout` 归因（`rtc-dial-breaker.ts:92`）一起评估；建议只在"该 peer 无任何活跃 stream"时降速，`peer-manager` 已有 `live.streams` 计数（`:2159`）可直接用作门闸 | **M** |
| **O14** | **零客户端时挂起 mesh 快节奏** | 网关已知 `connectedClients.size`（`ws/index.ts:92`）与 `connections.size`。当两者皆 0 且无 agent run 时，把 S3(15 s)/S4(15 s)/S6(3 s) 降到 60 s 档；任一客户端接入立即恢复 | 门闸源 `ws/index.ts:92`；作用点同 O10 列表 | 真·无人时几乎零唤醒 | **中高**：hub 侧要能容忍节点心跳变慢（`HUB_HEARTBEAT_MISS_LIMIT`=3 × 15 s = 45 s 才判死）。**必须同步放大 hub 侧的 miss 判定**，否则会被 hub 踢下线 → 反而触发重连风暴。这条如果做，必须配 e2e 覆盖 | **L** |
| **O15** | **事件循环 lag 采样按需启停** | 只在"有活跃 stream / 有 failover 在途 / 显式开启诊断"时跑 1 Hz；平时 10 s 一拍或完全停。同时区分"suspend 漂移"与"真 lag"（见 §2.4） | `ws/event-loop-lag.ts:57` start / `:96` arm；启停点 `runtime.ts:83`/`:250`；消费点 `forwarder-failover.ts:231` | 60 → 6 唤醒/min | 低，但会让 failover 日志里的 lag 字段在冷启动时不可用（可在 failover 开始时临时提速） | **S** |
| **O16** | **tmux control-mode 心跳降频/事件化** | 30 s 一次 `display-message -p` 会唤醒 tmux server。有终端输出流入时可跳过这一拍（有输出即证明通道活着），只在"静默 ≥30 s"时才真发 | `tmux-client/external/control-mode-lifecycle.ts:97`、`:112`；静默判据可复用 `ControlStreamMetrics.recordRawChunk`（`control-stream-metrics.ts:46`） | 忙时省掉 2 次/min 的 tmux 进程唤醒；闲时不变 | 低（等价于"有流量即视为存活"，是标准做法） | **S** |
| **O17** | **`node_sessions` 续期改懒写** | 5 min 一次写事务改为：只有当 `expiresAt - now < TTL/2` 时才 UPDATE（现在是"距上次续期 >5 min 就写"，与到期时间无关） | `auth/node-session-store.ts:103-110`，`NODE_SESSION_TTL_MS`=18 h（`:6`） | 每会话每 5 min 一次写事务 → 每 9 h 一次；WAL 增长基本归零 | 低。语义等价（TTL 18 h，半程续期足够） | **S** |
| **O18** | **重新评估"按 pane 订阅 control-mode 输出"** | round 12 以"需求协调器 650–1000 行"为由否决（见该轮结果表）。现在有了 5.65% 空闲 CPU 的实测，值得重估：没人看的 pane 的输出目前要走完 parse→retention→batch 全程 | 决策文档 `prompt-archives/2026090102-round12-leftovers/plan-00-result.md`；实现面 `tmux-client/control-mode-subscription.ts`、`retention/subscription-coordinator.ts` | 若空闲期 CPU 确实由终端输出主导（§4 待验证），这是**唯一能根治的手段** | 高：会影响 bell/OSC 推送与 agent headless ghostty 的 OSC 133 | **L** |

---

## 5. 怎么量（macOS，验证 before/after）

### 5.1 网关进程

```bash
# 0) 找到生产网关（只读，不要 kill / 不要碰 ~/Library/Application Support/tmex/）
pgrep -fl 'bun.*server.js'

# 1) 30s CPU 占比基线（-l 采样，取最后一行）
top -pid <PID> -l 31 -stats pid,cpu,mem,th,csw | tail -5

# 2) 唤醒次数（这才是电池指标，比 %CPU 更能反映"定时器多"）
#    Idle Wake Ups 一列；对比优化前后
top -pid <PID> -l 31 -stats pid,cpu,idlew,csw,syscall | tail -5

# 3) 谁在烧 CPU —— 采样调用栈（10s，1ms 间隔）
sample <PID> 10 1 -f /tmp/tmex-gateway.sample.txt
open -a TextEdit /tmp/tmex-gateway.sample.txt   # 看 Heaviest stack

# 4) 系统调用/文件写归因（需要 sudo，SIP 下 dtrace 可能受限）
sudo fs_usage -w -f filesys <PID> | head -200      # 看 tmex.log 的 write 频率与大小
sudo fs_usage -w -f network  <PID> | head -200     # 看空闲期网络往返

# 5) 定时器唤醒的直接证据（powermetrics，需 sudo）
sudo powermetrics --samplers tasks -n 3 -i 5000 | grep -A3 -i bun
#    看 "Intr Wakeups" / "Idle Wakeups" 每秒次数；预期基线 ≈ 2–4/s（见 §1 算术）
```

**判定"空闲 CPU 是不是终端输出造成的"**（最重要的一步）：

```bash
# 观察 30s 内 ws-metrics 的 source_events / source_bytes 是否非零
tail -f "$HOME/Library/Application Support/tmex/tmex.log" \
  | grep --line-buffered 'ws-metrics] terminal_output' \
  | awk '{for(i=1;i<=NF;i++) if($i ~ /^(source_events|source_bytes|batches|clients|devices)=/) printf "%s ", $i; print ""}'
```
- `source_events` 持续 >0 → **空闲 CPU 主因是终端输出管线**，优先做 O18 / 找出是哪个 pane 在刷（`tmux list-panes -a -F '#{pane_id} #{pane_current_command}'`，注意**不要碰名为 `tmex` 的 session 之外的任何操作**，只读列表是安全的）。
- 全零却仍每 30 s 打印 → 说明是 ping 路径在驱动（`recordPingProbe`），那 CPU 就来自 §1 的定时器族 + 日志写。

**日志写量**：
```bash
LOG="$HOME/Library/Application Support/tmex/tmex.log"
S=$(stat -f%z "$LOG"); sleep 300; E=$(stat -f%z "$LOG")
echo "5min 增长 $(( (E-S)/1024 )) KiB → $(( (E-S)*288/1024/1024 )) MiB/day"
```

### 5.2 PWA

1. **Chrome DevTools → Performance**：勾 “Screenshots” 关掉、开 “Memory” 关掉，录 **20 s 完全不操作**的终端页。
   - 看 Main 轨道的周期性小块：1 Hz 一簇 = 光标闪烁（P1）；5 s 一簇 = WS 心跳（P2）。
   - 看 “Experience” 轨道的 Layout Shift / “Rendering” 的 forced reflow 警告——手机键盘场景（P6）会刷屏。
2. **`chrome://tracing`**（或 DevTools → Performance → “Timer Fired” 统计）：
   Console 里跑一段计数器，最直观：
   ```js
   // 粘到目标页面 console，统计 20s 内的 timer 与 rAF 次数
   let t=0,r=0; const oi=setInterval, ot=setTimeout, oraf=requestAnimationFrame;
   window.setInterval=(f,d,...a)=>oi(()=>{t++;f();},d,...a);
   window.setTimeout=(f,d,...a)=>ot(()=>{t++;f();},d,...a);
   window.requestAnimationFrame=(f)=>oraf((x)=>{r++;f(x);});
   setTimeout(()=>console.log({timerFires:t, rafFires:r}), 20000);
   ```
   基线预期（终端页 + 3 保活 pane）：`timerFires ≈ 64`（20 s）、`rafFires ≈ 0`；键盘弹起时 `rafFires ≈ 1200` → 即 P6。
3. **后台标签页验证**：切到别的标签页 30 s 再切回，看上面计数器是否仍在涨——P1/P3 会涨，P2/P4/P5 不会（round 12 已修）。
4. **移动端功耗**：iOS 用 Safari → 开发 → Web Inspector 的 Timelines；Android 用 `adb shell dumpsys batterystats` 对比同一页面开/关键盘 5 min 的 CPU 时间。

---

## 6. 风险总表（给指挥官拍板用）

| 提案 | 会不会影响 mesh 存活判定 | 会不会影响 failover | 会不会影响重连 | 备注 |
|---|---|---|---|---|
| O1–O4, O6, O11, O12, O15, O17 | 否 | 否 | 否 | 纯日志/缓存/读路径，可直接做 |
| O5 | 否 | **是**（切回首选 hub 变慢） | 否 | 必须保留 node.list 事件驱动的即时探测 |
| O7, O8①, O9 | 否 | 否 | 否 | 纯前端 |
| O8② | 否 | 否 | 否 | 但会影响光标跟随体验，需实机验证 |
| O10 | 否（节奏不变，只对齐相位） | 否 | 否 | 保留抖动 |
| O13 | **是**（故障检测 10 s → 45 s） | **是**（failover 触发变晚） | 否 | 建议以 `live.streams===0` 为门闸 |
| O14 | **是** | 是 | **是**（判死阈值必须两端同改） | 风险最高，需 e2e |
| O16 | 是（tmux 通道存活判定改为"有流量即活") | 否 | 否 | 标准做法，风险可控 |
| O18 | 否 | 否 | 否 | 但影响 bell/OSC/agent，工作量大 |

**建议执行顺序**：先做 O1+O2+O3+O4+O6（一天内可完成，直接把 81 MB 日志和一半空闲写 IO 干掉），同时用 §5 的方法拿到"终端输出是否在流"的结论；再按结论决定是走 O18（输出主导）还是 O10+O11+O12+O13（定时器主导）。前端 O7+O8①+O9 可完全并行。
