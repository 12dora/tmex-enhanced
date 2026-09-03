# EX3 — 待机 / 后台的真实成本（服务端 + PWA）

范围：`/Users/konata/code/tmex-r22`（只读探查）+ 本机只读观测 + 隔离临时实例实测。
已读并据此避免重复：`prompt-archives/2026090302-round21-perf-idle-smell/sub/EX2-idle-standby-cost.md`（O1–O18）与
`plan-00-result.md` 第二、十节。

---

## 0. 结论先行（本轮最重要的三条，都推翻或修正了上一轮的判断）

1. **上一轮的核心归因是错的。** round 21 结论是「空闲 CPU 主因是终端输出管线，因为这台机器常年有 9 事件/秒的终端输出」。
   实测：以生产实际速率（**9 事件/秒、约 1 KB/s**）跑完整条 `%output` → 解析 → retention → borsh 编码 → 发送，
   微基准折算 **≈ 60 µs/s ≈ 0.006% 核**，比观测到的 4.9% 低三个数量级。**输出速率不是空闲 CPU 的主因。**

2. **真正的主因是「零客户端也常驻 tmux 控制模式，并且为没人看的 pane 跑完整解析」。**
   `apps/gateway/src/runtime.ts:86` 在网关启动时无条件 `pushSupervisor.start()`，
   而 `apps/gateway/src/push/supervisor.ts:139-146` 会对 **数据库里的每一个设备** 调 `upsert()` → `:251 acquireRuntime()` → `:276 runtime.connect()`，
   拉起 `tmux -C attach-session` 并**永不释放**。ws 层的 `RUNTIME_IDLE_GRACE_MS=5s` 空闲释放
   （`apps/gateway/src/ws/device-connection-registry.ts:90-96`、`ws/types.ts:51`）因此**从来不生效** ——
   push supervisor 持有一份独立的、永久的 runtime 引用。
   隔离实测（同一份 1.1.21 运行时、**零浏览器客户端、零 mesh**）：
   - 挂到**用户真实的忙 `tmex` 会话** → **20 ms/s ≈ 2.0–2.3% 核**
   - 挂到**安静会话**（隔离 socket `tmux -L tmex-e2e`）→ **2.5 ms/s ≈ 0.25% 核**
   - 裸 Bun（HTTP server + 若干定时器 + sqlite）→ **0.01% 核**
   ⇒ **约 1.8–2.1 个百分点的常驻 CPU，是「没有任何人连接、也没有任何人在看」的情况下解析 tmux 控制流烧掉的。**
   push supervisor 真正需要的只有 `bell` 与 `notification` 两类事件
   （`apps/gateway/src/push/tmux-push-events.ts:78-86` 的 handler 表只有这两项），其余全是纯浪费。

3. **所有定时器加起来不到 0.02% CPU。** 用 `--preload` 包住 `setTimeout/setInterval` 实测：
   一个连着 tmux 的网关，**30 秒窗口内所有定时器回调合计 2–7 ms**（最贵的一条是 `setTimeout(10000)` 的事件循环 lag 采样，1.9 ms/30s）。
   ⇒ **EX2 的 O10（合并 mesh 15 s 定时器族）在数据面前不成立，不要做**；round 21 已做的 O11/O12/O15/O17 收益同样在噪声内。
   「定时器多 = 空闲费电」这个直觉在这个进程上是错的，唯一还值得管的是**唤醒次数**（见 §3 的 SCTP 线程）。

---

## 1. 实测数据与完整命令

### 1.1 进程级 CPU（120 s 窗口，取累计 CPU 时间差）

测量脚本（只读）：

```bash
# /tmp/.../cpu-delta.sh
secs() { ps -o time= -p "$1" | tr -d ' ' | awk -F: '{s=0;m=1;for(i=NF;i>=1;i--){s+=$i*m;m*=60} print s}'; }
# 采两次 ps -o time= 差值 / 窗口秒数
```

| 进程 | 说明 | 窗口 | CPU 增量 | 占单核 |
|---|---|---|---|---|
| 18950 | **生产网关**（1 个浏览器客户端 canonical、2 个 hub 上行、RTC 反复重拨） | 120 s | 6.11 s / 5.36 s / 4.37 s（三次） | **3.64% ~ 5.09%** |
| 96603 | 临时 1.1.21 实例，**0 客户端、0 mesh**，控制模式挂在**真实忙 `tmex` 会话** | 120 s ×2 | 2.85 s / 2.73 s | **2.27% ~ 2.38%** |
| 11168 | 临时 1.1.21 实例，**0 客户端、0 mesh**，控制模式挂在**安静会话**（`-L tmex-e2e`） | 40 s 逐秒 | 合计 0.10 s | **0.25%** |
| 87944 | 裸 Bun：`Bun.serve` + ws handler + `setInterval` | 120 s | 0.05 s | **0.04%** |
| 87945 | 裸 Bun + `bun:sqlite`(WAL) + 6 个 3–30 s 定时器 | 120 s | 0.03 s | **0.03%** |
| 19001 | cloudflared（独立进程） | 120 s | 0.39 s | 0.32% |
| 2049 | 生产 tmux server | 120 s | 0.12 s | 0.10% |

临时实例的启动方式（**完全隔离，未写入安装目录、未碰 9883**）：

```bash
I="$HOME/Library/Application Support/tmex"
env -i HOME="$HOME" PATH="$PATH" NODE_ENV=production \
  TMEX_INSTALL_DIR="$S/tmpinst" TMEX_FE_DIST_DIR="$I/current/resources/fe-dist" \
  TMEX_MIGRATIONS_DIR="$I/current/resources/gateway-drizzle" TMEX_NATIVE_DIR="$I/current/native" \
  DATABASE_URL="$S/tmpinst/data/tmex.db" GATEWAY_PORT=19993 TMEX_PEER_PORT=39991 \
  TMEX_BIND_HOST=127.0.0.1 TMEX_BASE_URL=http://127.0.0.1:19993 \
  TMEX_TMUX_SOCKET=tmex-e2e \
  TMEX_ROLES=node TMEX_MASTER_KEY="$(openssl rand -base64 32)" \
  bun "$I/current/runtime/server.js"
```

> ⚠️ 踩坑记录（对后续实验很重要）：**不设 `TMEX_TMUX_SOCKET` 时，临时实例会自动 `tmux -C attach-session -t tmex` 挂到本机生产会话**
> （新库 seed 的设备会话名就是 `tmex`，且 push supervisor 启动即连）。我第一次实验触发了这一点，
> 发现后立刻 `kill` 掉临时实例及其 tmux 客户端并核对无残留（`ps ax | grep "tmux -C attach-session"` 只剩生产网关自己的 18985）。
> **以后任何临时实例必须先设 `TMEX_TMUX_SOCKET`。**

CPU 是否突发（判断是不是定时器）：

```bash
# 逐秒采 CPU 增量，40 次
for i in $(seq 1 40); do sleep 1; ...; done
# 96603（忙会话）：20 20 20 30 20 20 30 10 20 40 20 20 ... ms  → 完全平稳，不是定时器
# 11168（安静会话）：10 0 0 0 0 10 0 0 0 0 0 10 ... ms
```

### 1.2 定时器剖析（`bun --preload` 包住全局定时器）

```bash
bun --preload /tmp/.../probe.ts "$I/current/runtime/server.js"
# probe.ts: 用 wrap() 包 globalThis.setTimeout/setInterval，记录每个调用点的触发次数与耗时，30 s 打一次
```

一个挂着 tmux 的网关，**30 s 窗口全部定时器回调**：

```
1.9ms  0.1/s  setTimeout(10000) arm <- tick            # event-loop lag 采样（round21 已降到 10 s）
0.5ms  0.0/s  setInterval(30000)                       # 指标窗口
0.1ms  0.1/s  setInterval(15000) new RtcPeerManager    # RTC 授权表清扫
0.1ms  0.0/s  setInterval(30000) startHeartbeat        # tmux control-mode 心跳
4.8ms  0.1/s  setTimeout(8) finishMutation <- applySourceEvent   # 元数据 patch-buffer flush
```

合计 **2–7 ms / 30 s = 0.007%–0.023% 核**。

### 1.3 线程级归因（生产网关 18950）

```bash
ps -M 18950
```

进程累计 `1:30.10` user + `0:13.61` sys。逐线程 user 时间：`2.32 / 4.72 / 4.36 / 3.83`（4 条 JSC 堆线程）
+ 其余 ≈ 1.4 s，主线程 ≈ 69 s。
⇒ **GC / libpas 线程占网关 user CPU 的 16.9%**，其余基本都在主线程。GC 压力来自 §2 的每事件分配。

```bash
sample 18950 15 1 -f gw.sample.txt
```

线程清单里有 `RTC poll` / 10 条 `RTC worker` / `SCTP iterator` / **`SCTP timer`**：

```
12790 Thread: SCTP timer
  + 12789 user_sctp_timer_iterate  (in node_datachannel.node)
  + ! 12786 nanosleep  → __semwait_signal
```

即 usrsctp 的定时线程**以 10 ms 粒度 `nanosleep` 常驻**（≈100 次唤醒/秒），只要 `node_datachannel` 被 dlopen 就一直在，
与是否真的有 DataChannel 无关。CPU 极小（采样里只有 1/12790 落在 `sctp_handle_tick`），但**对 macOS/iOS 的深度空闲是硬伤**。

### 1.4 生产日志实测（只读 `tail`/`grep`）

```bash
L="$HOME/Library/Application Support/tmex/tmex.log"
grep 'ws-metrics] terminal_output' "$L" | tail -4
```

最近四条（round 21 的轮转已生效，活动文件 89 KB / 44 min）：

| interval_ms | source_events | source_bytes | **dropped_events** | canonical_observed | canonical_recipient_deliveries |
|---|---|---|---|---|---|
| 968 643 | 3072 | 273 408 | **293** | 2779 | 148 |
| 118 393 | 1024 | 89 377 | **446** | 578 | 37 |
| 111 055 | 1024 | 114 219 | **77** | 947 | 118 |
| 309 206 | 1024 | 94 961 | **926** | 98 | 0 |

三条关键读数：

- 速率 ≈ **9.2 事件/秒、约 1 KB/s**，平均每事件 ~90 B。
- `legacy_observed_events=0` 全为 0 —— 浏览器已经全走 canonical，**legacy 批处理路径在生产上是死代码路径**。
- **`dropped_events` 最高 926/1024 = 90%**：`dropped` 的定义是「既没有 legacy 观察者、pane 也没被 canonical retain」
  （`apps/gateway/src/ws/terminal-output-metrics.ts:121-135`）。
  也就是说 **九成的终端输出事件，是为「没有任何人在看的 pane」跑完整条解析流水线的**。

```bash
awk '{for(i=1;i<=NF;i++){if($i ~ /^\[/){print $i; break}}}' "$L" | sort | uniq -c | sort -rn
#  129 [ws-metrics]   77 [mesh][rtc]   10 [uplink]   4 [mesh][peer]   2 [tmex]
```

RTC 与 uplink 的现场（见 §4）。

### 1.5 微基准（组件级，M 系列，`Bun.nanoseconds()`）

**borsh 编解码**（直接从 bun 缓存加载 `@zorsh/zorsh@0.4.0`，复刻 `TermOutputSchema`/`EnvelopeSchema`）：

| payload | encodePayload | encodeEnvelope | 编码合计 | 吞吐 | 解码 | 同尺寸 `Uint8Array.set` 基线 | 倍数 |
|---|---|---|---|---|---|---|---|
| 64 B | 1.37 µs | 1.07 µs | 2.44 µs | 26 MB/s | 1.57 µs | 0.06 µs | **43×** |
| 1 KiB | 5.25 µs | 4.93 µs | 10.2 µs | 101 MB/s | 7.28 µs | 0.27 µs | **38×** |
| 8 KiB | 30.9 µs | 30.9 µs | 61.8 µs | 133 MB/s | 48.5 µs | 0.85 µs | **72×** |
| 64 KiB | 226 µs | 223 µs | **449 µs** | **146 MB/s** | **416 µs** | 4.08 µs | **110×** |

**tmux 控制流解析**（真跑仓库源码 `control-mode-subscription.ts` + `pane-stream-parser.ts`，4 KB `%output` 行）：

| 内容形态 | 端到端 push | 其中 unescape | 其中 paneStream | 折合 |
|---|---|---|---|---|
| 纯文本（无 ESC） | 5.59 µs | 0.22 µs | 2.88 µs | **1.4 ns/B** |
| SGR 密集（每 12 B 一个 CSI） | 88.96 µs | 6.11 µs | 80.5 µs | **21.7 ns/B** |
| 光标定位密集 | 76.3 µs | 5.06 µs | 64.7 µs | **18.6 ns/B** |

**retention ingest**：0.20–0.26 µs/事件（与长度无关），**这块设计得很好，不是问题**。

⇒ 服务端每字节成本 ≈ 解析 1.4–22 ns + borsh 编码 7 ns；浏览器再付 6 ns 解码。
**TUI（vim/htop/agent TUI/带时钟的 prompt）比纯文本贵 15×**，这才是「终端卡」和「大量输出时 CPU 飙升」的真身。

---

## 2. 输出管线：每事件到底做了多少事

一条 `%output` 从 tmux 到浏览器的全部分配与拷贝（按顺序）：

| 步骤 | file:line | 每事件代价 |
|---|---|---|
| 行切分 | `tmux-client/control-mode/framing.ts:47-84` | 零拷贝（`subarray`），✅ 好 |
| paneId 解码 | `control-mode/notifications.ts:59` `decodeRange` | **每事件一个字符串分配**（`%12` 之类，完全可以做 intern 缓存） |
| 八进制反转义 | `control-mode/unescape.ts:16` | 只要行内含任一 `\`（TUI 输出必然有，ESC 被 tmux 转义成 `\033`）就 **`new Uint8Array(line.length-start)` 全长分配** |
| pane 流解析 | `pane-stream-parser.ts:300-316` | 每次 `push` 新建 `ctx` 对象 + `createParserOutput(data.length)` **全长输出缓冲** + `stack` 数组 + `pendingPassthrough` 数组 |
| CSI 逐字节 | `pane-stream-parser.ts:191-232` | CSI 参数逐字节 `state.csiBytes.push(byte)`（JS number 数组），SGR 密集流里大部分字节走这条 |
| retention 入库 | `tmux-client/runtime/event-bridge.ts:49-52` → `pane-retention.ts:137-152` | `replay-store.ts:100-113`：**`copyBytes(data)` 全量拷贝** + `copyBytes(paneEpoch)` + segment 对象 + replay 条目；cold pane 提前返回（✅ 好） |
| replay 修剪 | `retention/policy-scheduler.ts:110-125` | `state.replay.shift()` 循环（数组头删，O(n) memmove） |
| 扇出 | `retention/replay-store.ts:124-131` | 每消费者一个闭包分配 `safeCallback(() => …)` |
| 广播 | `ws/index.ts:692-694` → `ws/legacy-feed-broadcaster.ts:222-237` | 指标 + `isPaneTerminalRetained` 查表；**`if (!legacyObserved) return`——legacy 门控在这里，但上面所有工作已经做完了** |
| legacy 合帧 | `ws/terminal-output-batcher.ts:126-146` | 每个新批：**1 个 `setTimeout` + 1 个 1 KiB `Uint8Array` + 闭包 + 2 次 Map 写**；9 ev/s 且间隔 >16 ms 时 ≈ **每事件一个定时器** |
| canonical 合帧 | `ws/canonical/pane-stream.ts:112-144` | 同上，且**每个 canonical 会话各一份**；`paneKey()` 每事件一次字符串拼接 |
| borsh 编码 | `ws/borsh/codec-borsh.ts:86-101` → `packages/shared/src/ws-borsh/codec.ts:37-57` | 见 §1.5：**逐字节写**（zorsh `bytes` handler 是 `for (i…) writer.writeUint8(value[i])`）+ `new TextEncoder()` **每个字符串字段一个** + `getBuffer()` 的 `slice()` 全量拷贝；payload 与 envelope **各来一遍** |

**没有发现的问题（澄清）**：热路径上**没有 `JSON.stringify`**（全仓 ws/tmux 目录只有 `theme-settings-broadcaster.ts:119` 一处，非热路径）；
没有 base64；没有每事件的日志行；`generateChunkStreamId()`（`shared/ws-borsh/chunk.ts:285`）是自增计数器不是 crypto。

---

## 3. 服务端常驻定时器 / 线程清单（当前代码，round 21 之后）

| # | 项 | file:line | 周期 | 0 客户端时 | 实测代价 |
|---|---|---|---|---|---|
| T1 | 事件循环 lag 采样 | `ws/event-loop-lag.ts:3-4`（1 s 忙 / **10 s 闲**） | 10 s | ✅ | 1.9 ms/30 s（定时器里最贵的一条） |
| T2 | 元数据 patch flush | `tmux-client/metadata/types.ts:5` `DEFAULT_FLUSH_INTERVAL_MS=8` | 事件驱动 8 ms | ✅（因为 T13 常驻） | 4.8 ms/30 s |
| T3 | tmux control-mode 心跳 | `tmux-client/external/control-mode-lifecycle.ts:100`，30 s | 30 s/设备 | ✅ | 0.1 ms/30 s；round21 已加「有输出即跳过」 |
| T4 | RTC 授权表清扫 | `mesh/rtc/rtc-peer-manager.ts:193`，15 s | 15 s | ✅ | 0.1 ms/30 s |
| T5 | peer ping | `mesh/peer-manager.ts:87` `PEER_PING_INTERVAL_MS=15_000`，`:1534` | 15 s×N_peer | ✅ | 噪声内 |
| T6 | peer DC 升级扫描 | `mesh/peer-dc-upgrade.ts:14,79`，15 s | 15 s | ✅ | 噪声内（round21 已加 `os.networkInterfaces()` TTL 缓存） |
| T7 | uplink ping | `mesh/uplink-client.ts:42,685`，15 s | 15 s×N_hub | ✅ | 噪声内 |
| T8 | uplink failback probe | `mesh/uplink-pool.ts:1120`，60 s | 60 s | ✅ | 每次一次完整 TLS 握手（见 §4） |
| T9 | uplink RTT probe | `mesh/uplink-pool.ts:1143`，300 s | 5 min | ✅ | 小 |
| T10 | TLS 指纹轮询 | `mesh/mesh-runtime.ts:148`，10 min | 10 min | ✅ | 可忽略 |
| T11 | 文件传输 GC | `files/transfer-session.ts:234`，5 min | 5 min | ✅ | 可忽略 |
| T12 | 微信保活扫描 | `weixin/service.ts:259`，30 min | 30 min | 配置后 | 可忽略 |
| T13 | **push supervisor 常驻 runtime** | `runtime.ts:86` + `push/supervisor.ts:139-146,251,276` | **常连** | ✅ **这是最贵的一项** | **1.8–2.1% 核**（忙会话） |
| T14 | **usrsctp 定时线程** | `node_datachannel.node`，由 `mesh/rtc/rtc-peer-manager.ts:202-206` 无条件 dlopen 触发 | **10 ms `nanosleep`** | ✅ | CPU ≈0，但 **≈100 次唤醒/秒**，阻止深度空闲 |
| T15 | hub 角色心跳 / attachment keepalive | `hub/uplink-server.ts:1801,1809`（15 s / 2 min） | 仅 hub | ✅ | 本机非 hub |

**空闲期 DB 写**：round 21 已把 `node_sessions` 续期改成「剩余寿命过半才写」（`auth/node-session-store.ts:6-7`）。
未见 VACUUM / 定期 checkpoint，`wal_autocheckpoint` 用默认值（`db/client.ts:9-14` 只设了 `WAL / NORMAL / busy_timeout`，
未设 `cache_size` / `mmap_size` —— 另一路探查用 `vmmap` 实测 SQLite page cache 仅 **240 KB resident**，**不是问题，不要动**）。

---

## 4. mesh / RTC 空闲实况（生产日志实测）

```bash
grep '\[mesh\]\[rtc\]' "$L" | ... | sort | uniq -c | sort -rn
```

44 分钟窗口内：

```
13× state peer=X state=connecting / checking / closed
11× failed peer=X reason=datachannel open timeout count=1
 3× failed peer=X cause=breaker_trip
 熔断级别爬升：fails=3 cooldown=30s → fails=9 level=5 cooldown_ms=960000（16 min 封顶）
```

- **WebRTC 从来没连通过**，每 ~3.4 分钟就有一轮完整的 PeerConnection 建立：ICE gathering（枚举本地地址 + STUN 往返）
  → DTLS 上下文 → 等 `datachannel open timeout` → 关闭。这是持续的、100% 无效的开销，且拉着 `node_datachannel` 的
  10 条 RTC worker + poll + SCTP 两条线程常驻（T14）。
- 熔断器（`mesh/rtc/rtc-dial-breaker.ts`）工作正常，已经爬到 16 min 冷却；节奏就是设计上限，不是 bug。
  **问题是「永远失败还永远重试」这个策略本身**——没有「连续 N 轮全失败就本会话内彻底停用 DC 升级，直到网络环境变化事件」的终止条件。

```bash
grep '\[uplink\]' "$L" | tail -12
```

```
08:34:30 offline reason=missed-pong
08:34:51 candidate failed hub=tmexhub-sh err=The operation was aborted. fails=1
08:34:51 failover → ai.jiefakj.com:18443
08:34:56 failback probe triggered by node.list
08:35:01 probe fail hub=tmexhub-sh
08:45:00 probe ok  → switch-back
```

即 **主 hub 掉线一次 → 切备 → 10 分钟里每 60 s 一次 HTTPS 探测 → 切回**。
round 21 的「node.list 事件驱动即时探测」已经在跑（`failback probe triggered by node.list`），这块行为正确。

**RTC liveness（3 s）在本机实际不产生开销**，因为 DC 从来没建立；O13 的收益前提在这台机器上不存在。

---

## 5. PWA 侧（前台空闲 / 后台）

round 21 的三个大头（光标闪烁 `setInterval`、键盘 follow 60 Hz 强制布局、WebRTC `getStats()` 无限期轮询）
**逐行核对确实已修，且实现比文档更严谨**：

| 项 | 现状 file:line | 结果 |
|---|---|---|
| 光标闪烁 | `packages/ghostty-terminal/src/cursor-layer.ts:24-33` 改 CSS `@keyframes`；保活池不可见槽用 `[data-tmex-terminal-hidden] … {animation:none}`（接线 `packages/panels/src/device-console/terminal-stage.tsx:278`） | **JS 唤醒 0**（原 60×N/min） |
| 键盘 follow | `packages/terminal-ui/src/hooks/use-keyboard-avoidance.ts:73-90,197-201` + `utils/follow-loop.ts:9-10,46-49,145-150` | 60 Hz → 收敛后 250 ms→1000 ms 探测，`inset<=0` 完全停 |
| WebRTC getStats | `packages/ws-client/src/direct/direct-carrier-controller.ts:102,992-1017` | 隐藏即停 + 去重 + `busy` 防并发 |
| hub 节点表轮询 | `apps/fe/src/node/hub-polling.ts:1-6,44-74` | 隐藏跳过 + 回前台补拉 |
| WS 心跳 | `packages/ws-client/src/heartbeat-controller.ts:77-83`、`client.ts:68,72-73,730` | 可见 5 s / 隐藏 30 s |
| 终端渲染 rAF | `packages/ghostty-terminal/src/terminal-render-loop.ts:9-17` | 无脏数据不排帧，✅ |
| Service Worker / wakeLock / BroadcastChannel / EventSource | 全仓无 | 0 |

**本轮新发现（都很小）**：

1. `apps/fe/src/index.css:189-194` `.kb-floating-shortcuts` 的 `will-change: transform` 在 direct 输入模式下**常驻**，
   即使 `--tmex-kb-shortcut-lift` 恒为 0 也一直占一个合成层。
2. React Query 的 `refetchInterval`（`pages/settings/nodes/https/use-tls-status.ts:39`、
   `pages/settings/remote-access/use-tunnel-status.ts:42`、`packages/panels/src/files/use-directory-listing.ts:33-37`、
   `packages/panels/src/watch/use-watch-rules.ts:81`）隐藏时**底层 `setInterval` 仍会醒来判一次 `focusManager.isFocused()`**，
   不发请求。只出现在设置子页 / 文件树 / watch 详情，主终端屏不受影响。
3. `apps/fe/src/index.css:47`（`--animate-scroll`）与 `:56`（`pulse-dot`）两个 `@keyframes` **零引用**，是死代码。
4. `apps/fe/src/node/mesh-events.ts:255-296` + `mesh-nodes-resident.tsx:14-17` 是**第二条常驻 WS**（`/mesh/ws`），
   无自建心跳、无 JS 唤醒，只是多一条 TCP —— 记录，非缺陷。

**结论：PWA 侧待机成本已经收敛，没有值得单独立项的剩余问题。** 本轮前端的力气应该花在 §1.5 的
**解码侧**（borsh 逐字节解码 158 MB/s，与终端渲染抢主线程）而不是再找定时器。

---

## 6. 进程与内存

| 观测 | 数值 | 命令 |
|---|---|---|
| 生产网关 RSS | 183–257 MB（波动）；`vmmap` physical footprint 126.8 MB | `ps -o rss -p 18950`、`vmmap --summary 18950` |
| **冷启动临时实例 RSS** | **启动即 204 MB**，稳定后 157 MB | `ps -o rss -p 96603` |
| 裸 Bun physical footprint | 10.2 MB | `bun -e 'Bun.serve(...)'` + `vmmap --summary` |
| 主要占用 | WebKit Malloc 78.7 MB dirty 67.6 MB（JS 堆）、JS VM Gigacage 42.9 MB、JIT code 7.0 MB | `vmmap --summary` |
| SQLite page cache | **240 KB resident** | 同上 |
| 前端 dist | `packages/app/src/runtime/serve-frontend.ts` 走 `Bun.file`，**不进 JS 堆** | 代码 |
| retention 上限 | 每 pane replay 2 MB / checkpoint 512 KB / 全局 64 MB（`tmux-client/retention/types.ts:8-10`） | 代码 |
| 子进程 | `tmux -C attach-session`（RSS 2.3 MB，每个本地设备一个）+ cloudflared（RSS 40.7 MB，独立进程） | `pgrep -P 18950` |
| 线程数 | 25（含 10 RTC worker + RTC poll + SCTP×2） | `top -pid 18950 -l 6 -stats th` |
| 上下文切换 | 空闲约 **800–860 次/秒** | `top -stats csw` 差值 |

**关键修正**：「310 MB 是历史峰值」的说法只对一半 —— **冷启动就是 200 MB**，说明大头是打包后的 JS 模块图 + 字节码 + JIT，
不是运行时累积。`--smol` 值得一试，但真正的结构性手段是 §7 的 R11（按角色动态 import）。

---

## 7. 提案清单（按性价比排序）

> 硬约束沿用 round 21：**不得削弱 mesh 存活判定、failover 语义、重连语义**。
> 下表里唯一触碰判定阈值的是 R9，已单独标注。

### 第一梯队 —— 直接砍掉实测到的 CPU

| # | 提案 | file:line | 根因 | 改法 | 预期收益 | 风险 | 角色 |
|---|---|---|---|---|---|---|---|
| **R1** | **push supervisor 不再无条件常驻所有设备的 tmux 连接** | `runtime.ts:86`；`push/supervisor.ts:139-146`（`start()` 遍历 `listDevices()`）、`:251`、`:276` | 启动即为每个设备建立永久 runtime 引用，`ws/device-connection-registry.ts:90-96` 的 5 s 空闲释放因此永不生效 | 只在「该设备至少有一个**启用中的**通知落地点」时才连：webhook 端点非空 / telegram 已配 / 微信已授权 / 存在浏览器 push 订阅，且未落在 `settings.disabledNotificationChannels`。配置变更时 `upsert`/`remove`。给出一个显式开关（如 `TMEX_PUSH_ALWAYS_ON`）兜底 | **−1.8~2.1% 核（≈ 全部空闲 CPU）**，同时省掉一个 tmux 客户端进程与 tmux server 的解析开销 | 中：会改变「没开客户端时还能收到 bell 推送」的行为——**必须确认这是不是产品承诺**。若是，走 R2 而不是 R1 | backend |
| **R2** | **无客户端时把 runtime 降级为「只要通知」模式** | `tmux-client/runtime/event-bridge.ts:49-52`；`control-mode-subscription.ts:103-110`；`pane-stream-parser.ts:300-316` | push supervisor 只消费 `bell` / `notification` 两类事件（`push/tmux-push-events.ts:78-86`），却要付整条输出流水线 | 给 `PaneStreamParser.push` 加 `materializeOutput: boolean`：为假时不建 `createParserOutput`、不 `writeRun`，只跑状态机触发 title/bell/OSC/主题订阅回调；`event-bridge` 在 `paneRetention` 无消费者且无 legacy 观察者时传 false，并跳过 `ingest` | 与 R1 同数量级，但**保留通知能力**（更稳妥的等价方案）；对纯文本省掉约 40% 解析 + 每事件一次全长分配 | 低-中：需保证 OSC/CSI 状态机在不物化输出时行为不变（有 golden 测试 `pane-stream-parser.golden.test.ts` 可复用） | backend |
| **R3** | **有客户端时，零观察者 pane 同样走 R2 的短路** | `ws/legacy-feed-broadcaster.ts:222-237`（判据已在这里：`legacyObserved` / `isPaneTerminalRetained`） | 生产实测**90% 的 `%output` 事件属于没人看的 pane**，判据在流水线**末端**，前面全做完了 | 把 `legacyObserved || canonicalObserved` 这个判据**前置**成 `control-mode-subscription` 的每 pane 布尔（由 runtime 在订阅/退订时推下去），驱动 R2 的 `materializeOutput` | 在有客户端场景下同样吃掉九成的解析物化成本 | 低：判据来源已存在，只是提前求值；需注意 pane 从「无人看」变「有人看」时必须能立刻切回（订阅变更是事件驱动的，天然可行） | backend |

### 第二梯队 —— 吞吐 / 延迟（有输出时才显现，但幅度最大）

| # | 提案 | file:line | 根因 | 改法 | 预期收益 | 风险 | 角色 |
|---|---|---|---|---|---|---|---|
| **R4** | **替换 borsh `bytes` 字段的逐字节编解码** | `@zorsh/zorsh@0.4.0` `dist/src/registry.js:377-402`（`for (i…) writer.writeUint8(value[i])` / 读同理）；入口 `packages/shared/src/ws-borsh/codec.ts:37-57` | 64 KiB 帧编码 449 µs、解码 416 µs，比 `Uint8Array.set` 慢 **110×**；服务端与浏览器各付一次 | 不改协议、不改 schema：为 `bytes` 提供自定义 handler（`writer.buffer.set(value, offset)` 批量写 / `value.subarray()` 批量读），或在 `ws-borsh` 里为终端数据帧走手写编解码绕过 zorsh。同时把 `BinaryWriter` 的 `new TextEncoder()`（`binary-io.js:97-104`）提成模块单例、`getBuffer()` 的 `slice()` 改 `subarray()`、初始容量按预估给 | 终端吞吐上限 **146 MB/s → 数 GB/s**；1 MB/s 输出时服务端省 ≈0.7% 核、浏览器省 ≈0.6%；大量输出（`cat` 大文件、build 日志）时是数量级改善，同时直接缓解 round 17 的终端延迟 | 低：纯编码实现替换，**必须有字节级 golden 测试**对拍新旧输出完全一致（协议兼容性是硬要求） | **复杂性能 → codex** |
| **R5** | **CSI 参数解析去掉逐字节 JS 数组 push** | `tmux-client/pane-stream-parser.ts:191-232`（`state.csiBytes.push(byte)`）、`pane-stream/parser-state.ts:128+` | SGR 密集流 **21.7 ns/B**，纯文本 **1.4 ns/B**，15× 差距全在这里；TUI 就是 SGR 密集 | `csiBytes` 改成复用的定长 `Uint8Array` + 长度游标（`MAX_CSI_BYTES` 已存在），消除每序列的数组分配与逐元素 push；`maybeEmitThemeSubscription` 改成读该视图 | TUI 场景解析成本预计降 40–60%；直接改善「TUI 重绘卡」 | 低：解析行为不变，有 golden 测试 | backend / codex |
| **R6** | **每事件的分配削减** | `control-mode/unescape.ts:16`（全长分配）；`control-mode/notifications.ts:59`（paneId 字符串）；`pane-stream-parser.ts:304-312`（ctx/stack/数组）；`retention/replay-store.ts:100-113`（`copyBytes`）；`retention/replay-store.ts:124-131`（每消费者闭包） | 实测 GC/libpas 线程占网关 user CPU **16.9%** | ① `unescape` 复用一块按需增长的 scratch 缓冲；② paneId 做 `Map<string,string>` intern（pane 数量有限）；③ `ctx`/`stack`/`pendingPassthrough` 提到 parser 实例上复用；④ `fanout` 改成 `try/catch` 包整个循环而不是每消费者一个闭包 | GC 线程占比预计从 17% 降到个位数 | 低（③ 要注意 `processInput` 的重入：tmux passthrough 是栈式的，复用对象前要确认无嵌套 push） | backend |
| **R7** | **replay 修剪从 `Array.shift()` 改环形缓冲** | `retention/policy-scheduler.ts:110-125`、`retention/types.ts:8`（`maxReplayBytesPerPane=2 MiB`） | 头删是 O(n) memmove；高吞吐时 replay 数组可达数千条 | 用已有的 `retention/min-heap.ts` 同款思路，或 head 游标 + 定期紧缩 | 高吞吐场景消除一个 O(n²) 隐患 | 低 | backend |
| **R8** | **合帧定时器复用** | `ws/terminal-output-batcher.ts:126-146`；`ws/canonical/pane-stream.ts:112-144` | 低速率（9 ev/s，间隔 >16 ms）时**几乎每事件一个 `setTimeout`+`clearTimeout`+1 KiB 分配**；canonical 还是**每客户端一份** | 每设备一个 16 ms 对齐的共享 tick，批次挂在 tick 上；批缓冲池化复用 | 唤醒次数从 ≈9/s/pane 降到 ≈62/s 上限且与 pane 数无关；分配显著下降 | 低-中：要保证 pane 内事件全序不被破坏（canonical 侧对 flush 顺序有硬要求，见 `pane-stream.ts:105-111` 注释） | backend |

### 第三梯队 —— 电池 / 唤醒 / 无效工作

| # | 提案 | file:line | 根因 | 改法 | 预期收益 | 风险 | 角色 |
|---|---|---|---|---|---|---|---|
| **R9** | **RTC DC 升级加「彻底放弃」终止条件** | `mesh/rtc/rtc-dial-breaker.ts:5-7`；`mesh/peer-dc-upgrade.ts:13-18`；现场日志见 §4 | 熔断已到 16 min 封顶，但**永远不停**；每轮一次完整 ICE gathering + DTLS + 15 s 超时，100% 无效 | 连续 N 轮（如 10 轮）全失败后进入 `disabled` 态，只由**明确的环境变化事件**唤醒：本机网络接口指纹变化（`syncLocalFingerprint` 已有）、peer 端点变化、hub 切换、手动触发 | 每 ~3.4 min 一次的无效 ICE 归零；日志噪声从 77 行/44 min 降到近 0 | **中：直接影响「网络恢复后能否自动升级到 P2P」**。必须保证列出的唤醒源覆盖真实场景，并保留手动重试入口 | backend |
| **R10** | **`node_datachannel` 惰性加载** | `mesh/rtc/rtc-peer-manager.ts:202-206`（构造函数里无条件 `loadNative()`） | dlopen 之后 usrsctp 的定时线程就以 **10 ms 粒度常驻 `nanosleep`（≈100 唤醒/秒）**，外加 10 条 RTC worker 线程 | 只在「确实要发起/接受一次 DC 拨号」时才 load；`available`/`ready()` 已是异步接口，改造面可控。与 R9 配合：进入 `disabled` 态后可以完全不 load | **−100 唤醒/秒**（笔记本深度空闲的关键指标）+ 少 12 条线程；空闲 CSW 800/s 预计明显下降 | 低：需确认所有调用方容忍 native 延迟到位 | backend |
| **R11** | **按角色动态 import 装配** | `packages/app/src/runtime/assemble.ts`（无条件 import 全部 gateway/mesh/hub/tunnel 子系统） | 冷启动 RSS 就 200 MB，大头是模块图 + 字节码 + JIT | hub-only / mesh-RTC-only 的子系统改动态 `import()` | 纯本地节点预估 −10~40 MB RSS，启动更快 | 中：装配逻辑默认假设两者都在，需覆盖角色矩阵测试 | backend |
| **R12** | **`ws-metrics` 的窗口检查改成真的 30 s** | `ws/legacy-feed-broadcaster.ts:230-234`（每 1024 个 source event 才检查一次窗口）；`ws/terminal-output-metrics.ts:13` | 生产实测 `interval_ms` 在 **111 s ~ 969 s** 之间乱跳，指标完全失去「每 30 s 一格」的可比性，做前后对比时会误导 | 保留 1024 计数作为快路径，另外挂一个 30 s 的低频兜底检查（或直接用 `nowMs - windowStart` 判断，反正 `Date.now()` 很便宜） | 指标可用性；这是本轮做 A/B 的前提 | 无 | backend |
| **R13** | **`[tmux-metrics]` 从 `isManagedExternally()` 门控改成日志级别门控** | `tmux-client/local-external-connection.ts:516-531`；`system/managed.ts:96-98` | `raw_bytes` vs `terminal_output_bytes` 的比值是判断「控制流里有多少是非 `%output` 噪声」的唯一手段，但生产上永远打不开 | 改成 `TMEX_LOG_LEVEL=debug` 时输出（round 21 已引入分级） | 让下一次归因不需要起临时实例 | 无 | backend |
| **R14** | 前端边角料 | `apps/fe/src/index.css:189-194`（常驻 `will-change`）、`:47`/`:56`（零引用 keyframes）、settings 子页的 `refetchInterval` | 见 §5 | `will-change` 改成只在键盘实际弹起时加；删死 keyframes；`refetchInterval` 套 `visibility` 门（复用 `node/hub-polling.ts` 范式） | 极小，顺手做 | 极低 | frontend |

---

## 8. 明确「不要做」清单

| 项 | 理由（都有实测支撑） |
|---|---|
| **EX2 O10：合并 mesh 的 15 s 定时器族到共享 ticker** | 实测**全部定时器合计 2–7 ms / 30 s = 0.02% 核**。合并的收益在噪声里，却要动 mesh 的相位与抖动。**不做。** |
| **EX2 O13：RTC liveness 3 s → 15 s** / **O14：零客户端时挂起 mesh 快节奏** | round 21 已判定不做；本轮补充证据：本机 DC **从未建立**，liveness 根本没在跑；而「零客户端」这个状态在 R1/R2 修好之前根本不存在（push supervisor 一直连着）。两条的收益前提都不成立。**继续不做。** |
| 调 SQLite `cache_size` / `mmap_size` | `vmmap` 实测 page cache 仅 **240 KB resident**，不是瓶颈。 |
| 再去前端找定时器 / rAF | round 21 已把三个大头连根拔掉，逐行复核确认；本轮新找到的三项都是边角料。前端本轮的收益点在 **R4 的解码侧**。 |
| 下调 `DEFAULT_MAX_RETENTION_BYTES` / `DEFAULT_MAX_ACTIVE_PANES` | 空闲期 retention 因 cold 模式几乎不占内存（`replay-store.ts:95-99`），下调只会缩短重连回放深度，换不到实际收益。 |
| 为「日志量」再做优化 | round 21 的轮转已生效（82 MB 滚成 `.1`，活动文件 44 min 只有 89 KB）。剩余量在 R9/R13 里顺手解决。 |
| 用 `--smol` 当性能手段 | 可以试，但它是**内存**手段且可能引入 GC 停顿；本轮 CPU 的大头是 R1/R2/R4，先做那三个。 |

---

## 9. 建议的执行顺序

1. **先做 R12**（指标窗口修正）——否则后面所有 A/B 都没法量。
2. **R2 + R3**（无观察者不物化输出）——不改产品语义，吃掉实测 90% 的无效解析；如果产品确认「无客户端时不需要后台推送」，再叠加 **R1** 把连接本身也省掉。
3. **R4**（borsh `bytes` 批量编解码）——交给 codex，配字节级 golden 对拍；这是终端吞吐/延迟的数量级改善，服务端与 PWA 双端受益。
4. **R5 + R6 + R7 + R8**（解析与分配）——可与 R4 并行。
5. **R9 + R10**（RTC 无效拨号与原生库惰性加载）——电池/唤醒向，需要谨慎设计唤醒源。
6. R11 / R13 / R14 视余力。

**验收方法**（沿用本报告的命令）：

```bash
# 1) 起隔离临时实例（务必带 TMEX_TMUX_SOCKET，否则会挂到生产 tmex 会话）
TMEX_TMUX_SOCKET=tmex-e2e ... bun <runtime>/server.js
# 2) 逐秒 CPU 增量，40 次，看是否从 20ms/s 降到个位数 ms/s
# 3) 微基准：borsh 编解码 µs/op 与 MB/s；pane-stream 解析 ns/B（脚本见 §1.5）
# 4) 生产侧只读核对 ws-metrics 的 dropped_events / source_events 比例是否仍是九成
```
