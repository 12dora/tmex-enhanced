# 诊断结论

最符合现象的因果链是：

```text
浏览器或远端 GatewaySession 读取变慢
  → LinkStreamCarrier / WebSocketSendGuard 出现背压
  → 发送帧被跳过，触发 backpressure_gap
  → carrier 被 terminate，mux stream 收到 RST
  → Forwarder 感知 stream close，重新建立 ws-secure 或 relay
  → 重新发送 HELLO、设备连接、snapshot、legacy history
  → 输入在 failover 期间排队，用户看到数秒级停顿
```

另一条独立但相同结果的路径是：

```text
ws-secure / relay 链路被 keepalive 判定失效
  → LinkMux 关闭整条 peer link，所有 stream 被 abort
  → terminal Forwarder failover
```

`replay_byte_limit` 本身不是当前代码中的 failover 触发器，而是 retention replay 缓存淘汰原因。它可能间接导致重新 snapshot 或 replay miss，但不能单独解释 `[mesh][stream] failover`。

RTC 失败重试可能增加 CPU、日志和控制信令压力，但按照当前代码，失败的 DataChannel dial 不会抢占仍工作的 ws-secure 链路。对 `direct_capable=false` 的 peer，当前 `PeerManager` 理应跳过 RTC；日志中仍出现大量 `reason=datachannel`，说明需要重点检查 capability 状态是否过期、为空或来自另一条 RTC 路径。

---

## 1. Stream failover 的触发和停顿时间

### 1.1 直接触发条件

`Forwarder` 为每个浏览器到远端节点的转发流维护一个 `ForwardPump`。流创建、当前 transport 和 stream 状态见：

- `apps/gateway/src/mesh/forwarder.ts:76-98`
- `apps/gateway/src/mesh/forwarder.ts:203-230`

远端 stream 关闭时会触发 failover：

- `apps/gateway/src/mesh/forwarder.ts:362-384`

其中 `onClose` 只要发现当前没有处于 failover，就调用：

```text
void this.failover(pump, info)
```

发送失败也会触发：

- `apps/gateway/src/mesh/forwarder.ts:560-579`

因此，下列事件都可能导致 failover：

1. ws-secure peer link 被关闭或替换；
2. relay link 被关闭；
3. mux stream 收到 RST；
4. `stream.send()` 失败；
5. 远端 `GatewaySession` 因 carrier terminate 而关闭。

需要注意：`Forwarder.failover()` 接收了 `_info`，但当前实现没有使用它：

- `apps/gateway/src/mesh/forwarder.ts:437-440`

所以现有 failover 日志无法准确区分是 `onClose`、send failure、peer link reset 还是 backpressure 引起的。

### 1.2 `from=ws-secure to=ws-secure` 的含义

这里不是同一条物理连接继续工作，而是：

```text
旧的 LinkSession / mux stream 失效
  → 重新获取 peer link
  → 新 link 仍被选择为 ws-secure
```

transport 选择逻辑在：

- `apps/gateway/src/mesh/peer-manager.ts:1276-1367`
- `apps/gateway/src/mesh/peer-manager.ts:1370-1442`

transport 优先级为：

- DataChannel：3
- ws-secure：2
- relay：1

定义见：

- `apps/gateway/src/mesh/peer-manager.ts:101-105`

因此：

- `ws-secure → ws-secure`：旧的 ws-secure 断开或 stream 被 reset，新建的仍是 ws-secure；
- `ws-secure → relay`：ws-secure 建立失败，降级到 hub relay；
- `relay → relay`：relay stream 断开，但重新获取到的仍是 relay。

在 jiefa-app 与 konata-mac 的 LAN RTT 约 6 ms 的情况下，`ws-secure → ws-secure` 的 TCP/WebSocket 建链通常不应自身造成数秒延迟；真正可能占用秒级时间的是后续 replay 等待和重试退避。

### 1.3 failover 的重试退避

定义在：

- `apps/gateway/src/mesh/mesh-deps.ts:21-23`

退避为：

```text
0、50、100、200、400、800、1600 ms
```

最多 7 次尝试。

如果每次连接立即失败，单纯退避时间累计约：

```text
0 + 50 + 100 + 200 + 400 + 800 + 1600 = 3150 ms
```

实际还要加上 `getLink()`、WebSocket 建连、认证和 mux open 的耗时。

如果成功建立新 stream，replay 仍可能等待：

- HELLO 响应最多 2 秒：`apps/gateway/src/mesh/forwarder.ts:518-533`
- 设备和 legacy pane 恢复就绪最多 8 秒：`apps/gateway/src/mesh/forwarder.ts:534-547`
- 常量定义：`apps/gateway/src/mesh/mesh-deps.ts:25-28`

因此一次成功的 failover 也可能出现：

```text
重新建链耗时
+ HELLO 等待最多 2 秒
+ DEVICE_CONNECTED / snapshot 等待最多 8 秒
```

如果链路建立成功且目标很快回复，实际耗时会低于上限；但代码路径明确允许数秒甚至约 10 秒的等待。

### 1.4 `resumed=0 mode=none` 与 `resumed=2 mode=legacy`

日志在这里生成：

- `apps/gateway/src/mesh/forwarder.ts:496-516`

replay 状态来自：

- `apps/gateway/src/mesh/stream-replay-state.ts:199-232`

含义是：

| 日志 | 含义 |
|---|---|
| `resumed=0 mode=none` | 当前 `StreamReplayState` 没有 canonical subscription，也没有 legacy pane subscription |
| `resumed=2 mode=legacy` | 保存了 legacy 模式的两个 pane ID，failover 后重新发送这两个 pane 的订阅 |
| `mode=canonical` | 保存的是 canonical pane subscription，并带有 cursor 信息 |

`resumed=2` 不是“恢复了 2 个终端输出帧”，而是恢复状态中有两个 legacy pane。它也不代表两个 pane 的历史数据已经全部发送完毕。

`resumed=0 mode=none` 可能表示：

- 该流不是 terminal subscription；
- subscription 尚未被 `StreamReplayState` 识别；
- failover 发生得非常早；
- 旧协议帧没有留下可 replay 的状态。

因此日志中大量 `resumed=0` 不能直接证明大量终端都没有恢复。

### 1.5 replay 做了什么

`replaySubscription()` 的流程见：

- `apps/gateway/src/mesh/forwarder.ts:518-547`

大致顺序：

1. 等待新连接的 HELLO；
2. 重新发送设备连接帧；
3. 等待 `DEVICE_CONNECTED`；
4. legacy 模式等待 snapshot；
5. 发送 pane subscribe、select、agent 等状态；
6. legacy 模式为每个 pane 生成 history request；
7. 清空 failover 期间积累的输入队列。

legacy history request 的生成见：

- `apps/gateway/src/mesh/stream-replay-state.ts:257-283`

这会在 failover 后为每个订阅 pane 重新请求历史。于是即使实时终端流量只有 20–40 KB/30 秒，failover 后仍可能突然产生一批 snapshot/history 数据，造成短时突发背压。

### 1.6 failover 是否阻塞输入和输出

输入在 failover 期间明确会被暂停：

- `apps/gateway/src/mesh/forwarder.ts:164-175`
- `apps/gateway/src/mesh/forwarder.ts:549-558`

输入会放入队列，限制为：

- 最多 256 帧；
- 最多 4 MiB。

定义见：

- `apps/gateway/src/mesh/mesh-deps.ts:25-28`

所以用户键入的字符可能在 failover 完成前暂不发送。超过限制后，浏览器会被关闭，而不是静默丢弃。

输出不是在 `Forwarder` 中显式等待 replay 完成后才发送；新 stream 收到的数据可直接进入：

- `apps/gateway/src/mesh/forwarder.ts:386-404`

但远端 session 通常要先完成 HELLO、设备恢复和 snapshot，用户真正看到的 terminal output 仍会出现停顿。此外，旧 stream 与新 stream 之间没有持续 TCP 语义，输出可能经历重放、去重、补 snapshot 或顺序重建。

---

## 2. `backpressure_gap` 和 `replay_byte_limit`

### 2.1 `backpressure_gap` 的准确状态机

限制定义：

- `GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES = 1 MiB`
- 超时：5 秒

见：

- `apps/gateway/src/ws/websocket-send-guard.ts:3-4`

发送逻辑见：

- `apps/gateway/src/ws/websocket-send-guard.ts:98-152`

当 carrier 返回 backpressure：

1. 当前帧之前的内容视为已接受；
2. 后续发送被跳过；
3. 设置 5 秒 timer；
4. 如果 drain 到来时发现中间跳过了帧，立即以 `backpressure_gap` terminate；
5. 如果 5 秒内没有 drain，则以 `backpressure_timeout` terminate。

关键代码：

- `apps/gateway/src/ws/websocket-send-guard.ts:155-172`
- `apps/gateway/src/ws/websocket-send-guard.ts:210-223`

因此，`backpressure_gap` 本身不是“等待了 5 秒后才发生”。通常是：

```text
超过 1 MiB
→ 某个发送返回 backpressure
→ 后续有帧被跳过
→ drain 到来
→ 立即 terminate，原因 backpressure_gap
```

`ws_queue_bytes=0` 也不能排除此前发生过背压。terminate 会清理 carrier 队列：

- `apps/gateway/src/mesh/link-stream-carrier.ts:60-77`

### 2.2 为什么可见吞吐很小仍可能触发

`terminal_output` 的 30 秒统计主要反映实时输出：

- `apps/gateway/src/ws/terminal-output-metrics.ts:13`
- `apps/gateway/src/ws/gateway-metrics-log.ts:21-80`

但导致 1 MiB 阈值的内容可能来自短时间突发：

1. **failover 后的 legacy history replay**

   每个 pane 都可能重新请求历史：

   - `apps/gateway/src/mesh/stream-replay-state.ts:257-283`

2. **snapshot / screen transaction**

   canonical 路径会传输 snapshot、history 和 metadata：

   - `apps/gateway/src/ws/canonical/transaction-sender.ts:80-186`
   - `apps/gateway/src/ws/canonical-feed-session.ts:536-603`

3. **后台标签页或 iOS PWA 不再及时读取 WebSocket**

   浏览器端 heartbeat 仍可能运行，但读取终端内容的消费速度下降，服务端发送缓冲区持续增长。

4. **多个浏览器 tab**

   每个 session 都是独立 recipient。相同终端输出会被分别编码、发送和排队。

5. **单个大帧或集中 burst**

   30 秒平均只有几十 KB，不代表单个 100 ms 时间片没有几百 KB 到数 MiB 的 snapshot/history burst。`dropped_events` 只统计被跳过的帧，不统计触发阈值之前已经进入发送缓冲区的全部数据。

6. **背压发生在 mesh carrier 而不是物理浏览器 socket**

   这是本项目中特别重要的架构细节。

### 2.3 当前 topology 中 guard 可能不在 konata-mac 的物理浏览器 socket 上

普通本地 WebSocket session 使用：

- `apps/gateway/src/ws/index.ts:161-169`
- `apps/gateway/src/ws/carrier.ts:14-27`

但远程 node 转发路径是：

```text
浏览器 WS（konata-mac）
  → Forwarder
  → ws-secure mux stream
  → jiefa-app 的 LinkStreamCarrier
  → jiefa-app GatewaySession
```

jiefa-app 侧通过 mesh stream 创建的 session 见：

- `apps/gateway/src/mesh/stream-targets.ts:475-553`
- `apps/gateway/src/ws/index.ts:194-221`

这条路径上的 `WebSocketSendGuard` 保护的 carrier 可能是 `LinkStreamCarrier`，而不是 jiefa-app 本地浏览器 socket。

因此：

- 如果日志中的 `ws-metrics` 来自 konata-mac 本地物理 browser session，它代表浏览器 socket 背压；
- 如果日志来自 jiefa-app 的远端 GatewaySession，它代表远端 session 向 mesh stream 写入时的背压；
- 当前日志没有 node、session、cid、mux stream ID，无法区分这两种情况。

远端 carrier 的队列和 mux 窗口还会叠加：

- `apps/gateway/src/mesh/link-stream-carrier.ts:35-58`
- `packages/shared/src/link/types.ts:49-65`
- `packages/shared/src/link/mux.ts:201-250`

mux 的接收窗口初始为 1 MiB，只有应用持续读取时才会通过 WINDOW 重新开放。因此目标端 session 读取变慢，会反向阻塞 mesh stream。

### 2.4 gap 之后会发生什么

Guard terminate carrier：

- `apps/gateway/src/ws/websocket-send-guard.ts:210-223`

`LinkStreamCarrier.terminate()` 会 reset mux stream：

- `apps/gateway/src/mesh/link-stream-carrier.ts:60-77`

随后：

- 远端 GatewaySession 关闭；
- mux 记录 `rst send/recv`；
- konata-mac 的 Forwarder 收到 stream close；
- Forwarder 启动 failover；
- failover replay 可能再次发送 snapshot/history。

这可以解释日志中：

```text
backpressure_gap
→ [mesh][mux] rst recv reason=relay-rst/offline
→ [mesh][stream] failover
```

canonical 路径本身已经避免了在同一个拥塞 socket 上自动重新 snapshot：

- `apps/gateway/src/ws/canonical-feed-session.ts:301-315`

代码注释明确说明，自动 re-snapshot 会在同一条拥塞连接上形成正反馈；由客户端请求 `RequestScreenSnapshot`。

但 legacy failover replay 会重新发送设备状态和 history，因此不能直接套用 canonical 的行为。

### 2.5 `replay_byte_limit` 的真实含义

retention 配置：

- 每个 pane replay 上限：2 MiB；
- replay TTL：15 秒；
- checkpoint：512 KiB；
- 全局 retention：64 MiB。

见：

- `apps/gateway/src/tmux-client/retention/types.ts:3-10`

`replay_byte_limit` 在 retention scheduler 中产生：

- `apps/gateway/src/tmux-client/retention/policy-scheduler.ts:91-125`

它表示 replay store 删除了最老的 chunk，因为：

```text
replayBytes > maxReplayBytesPerPane
```

这不是 WebSocket 1 MiB backpressure，也不是 `Forwarder.failover()` 的直接条件。当前代码中没有：

```text
replay_byte_limit → failover()
```

这样的调用链。

它的间接影响是：

```text
replay cache 被淘汰
  → cursor 不在 retained 范围
  → replay miss / gap
  → needsScreen=true
```

相关代码：

- `apps/gateway/src/tmux-client/retention/replay-store.ts:247-315`

因此：

- 如果当前日志中的 `canonical_runtimes=0`、`canonical_sessions=0`、`canonical_observed_events=0` 属实，那么本次 terminal 数据面更可能是 legacy 路径；
- `replay_byte_limit` 很可能是同一进程中其他 pane/session 的 retention 统计，不能直接当作这次 failover 的原因；
- 需要用 pane、session、stream ID 关联后才能确认。

---

## 3. RTC dial churn

### 3.1 `direct_capable=false` 理应跳过 DataChannel

当前判断是：

- `apps/gateway/src/mesh/peer-manager.ts:819-820`

```text
this.rtc?.available === true
&& this.userStore.getPeer(nodeId)?.directCapable !== false
```

所以已知 `direct_capable=false` 的 peer 不应拨打 DataChannel。

但这里对“未知状态”的处理是允许尝试：

```text
directCapable !== false
```

因此：

- `true`：尝试；
- `false`：跳过；
- `undefined` / 旧缓存：仍尝试。

`direct_capable` 来源于 peer status：

- `apps/gateway/src/mesh/mesh-runtime.ts:922-934`
- `apps/gateway/src/mesh/peer-manager.ts:1745-1776`

在本 topology 中，jiefa-app 明确为 false，却仍出现大量 `reason=datachannel`，应重点检查：

1. konata-mac 上保存的 peer status 是否是旧值；
2. `direct_capable=false` 是否在当前 PeerManager 实例已经生效；
3. 这些日志是否来自其他 peer；
4. 是否来自浏览器 RTC 路径而非 node-to-node `RtcPeerManager`；
5. 是否存在 capability 变更后尚未清理的 pending wake/signal。

### 3.2 单次失败会阻塞多久

`RtcPeerManager.connectToPeer()` 的默认连接/握手超时为 15 秒：

- `apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:59-64`
- `apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:253-323`

流程包含：

1. 创建 native PeerConnection；
2. 创建或等待 DataChannel；
3. 等待 channel open；
4. 完成 fingerprint/datachannel handshake；
5. 失败时关闭 PC 并抛错。

因此，在“没有可用 live link、需要 `getLink()` 现拨”的路径上，一次失败的 DC dial 可能先耗时约 15 秒，之后才继续尝试 ws-secure：

- `apps/gateway/src/mesh/peer-manager.ts:1276-1367`

而在已有 ws-secure 的升级路径上，RTC 通常运行在后台 upgrade 流程中，失败后工作中的 ws-secure 会保留。

### 3.3 重试策略

升级失败后的 retry delay：

```text
5 秒、15 秒、30 秒、60 秒，之后 120 秒尾部重试
```

见：

- `apps/gateway/src/mesh/peer-manager.ts:945-1013`

这不是每几百毫秒无限忙循环，但如果 peer 数量多，仍会持续产生：

- PeerConnection 创建/关闭；
- SDP 和 ICE candidate 信令；
- WebSocket/hub 控制消息；
- 大量未限流的 `dial failed` 日志。

RTC candidate 日志只有部分限流：

- `apps/gateway/src/mesh/rtc/rtc-log.ts:48-84`

但 `dial failed` 本身通过普通 `rtcLog` 输出，没有同等级别的频率限制。

### 3.4 是否会抢占工作中的 ws-secure

总体上是 make-before-break。

transport 排序和 link 替换逻辑见：

- `apps/gateway/src/mesh/peer-manager.ts:1495-1538`
- `apps/gateway/src/mesh/peer-manager.ts:2098-2158`

当前 ws-secure 仍工作时：

- 新失败的 DC dial 只关闭自己的 PeerConnection；
- 不会因为失败而关闭现有 ws-secure；
- 成功的高优先级 DC 才会进入替换流程；
- 旧 link 会先 quiesce，等待确认或安静期；
- 最长可能保留 retiring link 约 30 秒。

所以“每个失败的 DataChannel dial 都直接撕掉 ws-secure”与当前代码不符。

但是，如果当前没有 live ws-secure，`getLink()` 可能在 DC 失败期间没有可用终端链路；这会让 Forwarder 处于 failover/reconnect 状态，表现为输入输出停顿。

### 3.5 ICE 诊断是否在 terminal 热路径

ICE gathering、connection state 和 failed summary 是事件回调：

- `apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:533-624`

它们不在 terminal stream 的每一帧发送路径上，也没有代码显示会同步等待 ICE summary 完成。

但 RTC dial 本身确实处于 peer link 获取路径，且 `connectToPeer()` 会等待 DataChannel，因此：

- 对既有 ws-secure 的后台升级：一般不阻塞当前 terminal stream；
- 对没有 live link 的首次 dial/failover：会延迟取得可用 transport；
- native ICE 主要在底层运行，但 JS 仍会处理 candidate、信令、日志和状态回调。

### 3.6 是否足以阻塞 Bun event loop

仅凭 1957 次 `reason=datachannel` 不能证明 Bun event loop 被阻塞数秒。

可能的开销包括：

- 每次 PC 生命周期；
- JSON/SDP/candidate 处理；
- 控制信令排队；
- 每次失败的多条 `console.log`；
- PeerManager 的 Map/Set 和状态更新。

hub uplink 的控制消息还会串行处理：

- `apps/gateway/src/hub/uplink-server.ts:1180-1213`

但 terminal data 走 mux data stream，并不等于会直接等待 RTC 控制队列。

结论是：RTC churn 是可疑的额外压力源，但当前证据更支持它“增加调度和 I/O 压力”，尚不能认定它是数秒 terminal stall 的主因。必须加入 event-loop lag 指标验证。

---

## 4. Keepalive、heartbeat 和链路失效

### 4.1 ws-secure peer link

PeerManager 的 peer heartbeat：

- 间隔：15 秒；
- 连续 3 次未收到 pong 后丢弃 peer。

见：

- `apps/gateway/src/mesh/peer-manager.ts:72-94`
- `apps/gateway/src/mesh/peer-manager.ts:1859-1880`

丢弃动作：

- `apps/gateway/src/mesh/peer-manager.ts:1938-1977`

`dropPeer()` 会关闭当前 LinkMux。LinkMux 的 `finishClose()` 会 abort 所有 stream：

- `packages/shared/src/link/mux.ts:773-787`

因此一个 ws-secure keepalive 失败会同时影响该 peer 上的所有 terminal stream，并让 Forwarder 逐个进入 failover。

代码没有针对 macOS sleep、Wi-Fi power save、TCP suspend 的特殊处理。系统睡眠或无线省电可能造成：

- pong 延迟；
- TCP socket 暂停；
- peer 误判 missed-pong；
- 恢复后重新建链。

这是合理的平台层推断，但代码本身没有 macOS-specific evidence。用户摘录中仅约 3 个 missed-pong，暂时不像主要触发源。

### 4.2 Hub uplink

uplink client：

- 心跳间隔 15 秒；
- missed pong 达到 3 后 teardown；
- 重新连接退避 1–60 秒。

见：

- `apps/gateway/src/mesh/uplink-client.ts:41-50`
- `apps/gateway/src/mesh/uplink-client.ts:681-729`
- `apps/gateway/src/mesh/uplink-client.ts:716-729`

server 端也使用 15 秒 heartbeat，并在连续未收到 pong 后关闭：

- `apps/gateway/src/hub/types.ts:61-68`
- `apps/gateway/src/hub/uplink-server.ts:1821-1836`

hub uplink 断开会使通过该 uplink 承载的 relay stream 失效。之后：

```text
relay stream close
→ Forwarder failover
→ 重新获取 relay 或尝试 ws-secure
```

如果 konata-mac 只有一个可用 hub，且 relay link 正好处于 heartbeat/reconnect 窗口，恢复时间可能明显长于 LAN ws-secure 重连。

UplinkPool 新 hub 切换通常是 make-before-break：

- `apps/gateway/src/mesh/uplink-pool.ts:916-947`

但如果当前唯一 live uplink 真的断开，仍需要执行 reconnect backoff。

### 4.3 浏览器 heartbeat

浏览器客户端 heartbeat：

- 前台：5 秒发送，10 秒 pong timeout；
- 隐藏：30 秒发送，60 秒 timeout。

见：

- `packages/ws-client/src/client.ts:68-85`
- `packages/ws-client/src/client.ts:584-617`

连接关闭后客户端采用指数重连：

```text
1、2、4、8、16 秒
```

最多 5 次，见：

- `packages/ws-client/src/reconnect-controller.ts:1-63`
- `packages/ws-client/src/client.ts:397-415`

浏览器关闭的是整个 session，重新建立后走全新的 HELLO、设备连接和 snapshot 流程；它不是 Forwarder 内部的 stream failover。

---

## 5. 现有诊断能力和缺口

### 5.1 可直接使用的现有指标

#### `/api/mesh/nodes`

路由：

- `apps/gateway/src/mesh/mesh-routes.ts:146-150`
- `apps/gateway/src/mesh/mesh-routes.ts:224-234`

可观察：

- `transport`
- `rttMs`
- `linkSinceAt`
- `directFailure`
- peer address

投影和字段：

- `apps/gateway/src/mesh/node-list-projection.ts:145-153`
- `apps/gateway/src/mesh/node-list-projection.ts:185-220`
- `apps/gateway/src/mesh/peer-manager.ts:427-443`

局限：

- `rttMs` 是 peer control ping RTT，不是 terminal stream RTT；
- 它只能代表当前采样时刻；
- event loop 堵塞时，ping timer 和 pong 处理本身也可能延迟；
- 没有历史 link replacement 记录。

建议在问题发生时每秒采样，关注：

```text
transport: ws-secure → relay → ws-secure
linkSinceAt 是否突然改变
rttMs 是否先升高
directFailure 是否出现
```

#### `[ws-metrics] terminal_output`

实现：

- `apps/gateway/src/ws/gateway-metrics-log.ts:21-80`

可观察：

- `source_events/source_bytes`
- `dropped_events/dropped_bytes`
- `ws_queue_bytes`
- `ws_queue_limit_bytes`
- `ws_backpressured`
- `ws_unavailable`
- `ws_terminations_by_reason`
- recipient 数量
- snapshot/history 活动

用户摘录中的：

```text
dropped_events=31 dropped_bytes=2772
```

不代表只产生了 2772 字节的发送压力；它可能是一个较大的 burst 使 queue 进入背压状态后，只有少量后续帧被跳过。

此外，terminate 后队列会清空，所以后续看到 `ws_queue_bytes=0` 不能否定此前发生过 backpressure。

#### mux RST

实现：

- `packages/shared/src/link/mux.ts:531-543`
- `packages/shared/src/link/mux.ts:726-736`

`rst recv reason=offline|relay-rst` 说明具体 mux stream 被远端或本地重置，但当前日志缺少：

- node ID；
- browser cid；
- Forwarder stream ID；
- mux stream ID；
- failover cause；
- failover duration。

因此目前无法把某一个 RST 精确对应到某一次 terminal failover。

#### stream failover

日志位置：

- `apps/gateway/src/mesh/forwarder.ts:496-516`

当前已有：

- Forwarder stream ID；
- from/to transport；
- resumed 数量；
- replay mode；
- pane 信息。

缺少最关键的时间和原因。

### 5.2 当前没有发现专用 debug flag

相关代码中未发现类似：

```text
TMEX_MESH_TRACE
TMEX_WS_TRACE
TMEX_EVENT_LOOP_DEBUG
```

的专用追踪开关。

现有 RTC 环境变量主要是调参：

- `RTC_LIVENESS_INTERVAL_MS`
- `RTC_LIVENESS_TIMEOUT_MS`

见：

- `apps/gateway/src/mesh/rtc/liveness.ts:27-39`

它们不是诊断开关。建议新增 debug flag 时必须限流，否则 RTC 失败日志本身可能成为负载。

---

## 6. 最小 instrumentation 建议

优先增加时间戳和关联 ID，而不是先扩大日志量。

### 6.1 Forwarder failover

在 `apps/gateway/src/mesh/forwarder.ts:362-579` 增加：

```text
failover_start
  nodeId
  cid
  pumpId
  muxStreamId
  cause=stream_close|send_failed
  close_reason
  from_transport
  linkSinceAt
  queued_input_bytes
```

每次尝试记录：

```text
attempt
getLink_ms
open_stream_ms
replay_hello_wait_ms
replay_resume_wait_ms
replay_mode
```

完成或失败记录：

```text
failover_done
duration_ms
to_transport
resumed
replay_bytes
```

这可以直接回答“连接慢”还是“replay 等待慢”。

### 6.2 WebSocketSendGuard / LinkStreamCarrier

在：

- `apps/gateway/src/ws/websocket-send-guard.ts:98-223`
- `apps/gateway/src/mesh/link-stream-carrier.ts:35-130`

记录：

```text
sessionId/cid/nodeId
buffered_before
buffered_after
frame_kind
frame_bytes
first_backpressure_at
skipped_frames
skipped_bytes
drain_at
terminate_reason
```

特别要区分：

```text
physical_browser_ws
mesh_link_stream
```

否则 `ws_queue_bytes` 很容易被误读。

### 6.3 mux 流关联

在 mux RST 日志中加入：

```text
nodeId
transport
muxStreamId
forwarderPumpId
cid
```

并记录：

```text
send_window
recv_window
recv_buffer_bytes
write_wait_ms
```

重点观察 RST 前是否存在：

- recv window 长时间不归还；
- `stream.write()` 长时间等待；
- carrier pending bytes 增长。

### 6.4 Bun event-loop lag

在 gateway 进程加入低频 event-loop lag 采样，例如 1 秒 tick：

```text
event_loop_lag_ms
max_lag_ms
```

同时在以下回调记录当前 lag：

- browser WS message/send；
- mux `drainIncoming`；
- secure-channel decrypt callback；
- RTC dial failure；
- peer pong；
- uplink pong。

没有这个指标，无法区分“网络真的慢”和“Bun 主线程没有及时调度”。

### 6.5 RTC dial

在：

- `apps/gateway/src/mesh/peer-manager.ts:1220-1367`
- `apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:253-323`

记录：

```text
dial_id
peerId
direct_capable
current_live_transport
attempt_number
start_at/end_at
ice_state
channel_state
failure_reason
was_live_link_preserved
```

同时对 `dial failed` 做采样或聚合计数，避免每次失败都打印完整日志。

### 6.6 heartbeat

在 peer 和 uplink heartbeat 记录：

```text
ping_sent_at
pong_at
missed_count
transport
linkSinceAt
drop_reason
uplink_generation
hub
```

这样可以判断 failover 是否发生在 missed-pong 之前，还是 backpressure/RST 之后。

---

## 7. 修复优先级

### P0：先修 capability gate 和可观测性

当前代码已经有：

```text
directCapable !== false
```

的 gate，但建议确认 jiefa-app 的状态是否真正同步到 konata-mac。若业务语义是“只有明确支持 RTC 才允许拨号”，应考虑改为明确 `=== true`，并清理旧 capability 缓存。

同时优先加入带时间戳的 failover、backpressure、mux RST 和 event-loop lag 日志。没有关联 ID，后续修复无法验证。

### P1：限制 legacy failover replay

当前 legacy failover 会对所有 pane 重新生成 history request：

- `apps/gateway/src/mesh/stream-replay-state.ts:257-283`

建议：

- 限制单次 failover history 总字节数；
- 只恢复订阅状态，不自动拉取完整 history；
- history 改为客户端显式请求；
- 对多个 pane 合并、去重和分批发送；
- 缩短不必要的 replay 等待，但保留协议正确性。

这是最可能直接减少“failover 后再次触发 backpressure”的措施。

### P1：对 backpressure 做分层恢复

当前任何 gap 都会 terminate carrier：

- `apps/gateway/src/ws/websocket-send-guard.ts:155-223`

可以考虑：

- snapshot/history 与实时 terminal output 分离预算；
- 对历史数据限速或丢弃，而不是让整个 session 断开；
- 为慢客户端设置独立输出预算；
- 保留 canonical 的“记录 gap、等待客户端请求 snapshot”策略；
- 对 mesh LinkStreamCarrier 增加显式流控和超时统计。

不建议简单地把 1 MiB 阈值无限调大；这可能把可见停顿变成长时间内存堆积。

### P1：给 Forwarder failover 增加明确原因和预算

建议为 failover 设置独立的：

- 建链预算；
- replay 预算；
- 总时长；
- 最大 replay bytes；
- 最大输入队列。

失败时立即报告具体阶段，而不是只记录 `from/to/resumed/mode`。

### P2：减少 RTC 无效重试

如果确认 capability 状态正确，建议：

- 永久跳过 `direct_capable=false`；
- 对 unknown capability 默认不拨号，只有明确 true 才拨号；
- 对连续失败 peer 增加更长尾部退避或暂时熔断；
- 当 ws-secure 稳定存在时降低 upgrade 频率；
- 限制失败日志频率。

当前已有 5/15/30/60/120 秒退避，因此是否继续加长应以 event-loop lag、控制队列长度和 CPU 数据为依据。

### P3：检查 heartbeat 和系统休眠路径

不要先简单缩短 heartbeat timeout。当前 15 秒 × 多次 miss 的策略已经偏向容忍短暂网络抖动。

应先确认：

- macOS 睡眠/唤醒期间 missed-pong 是否与 failover 同时发生；
- Wi-Fi power save 是否造成 TCP 暂停；
- relay uplink 是否在同一时间 reconnect；
- ws-secure 断开时是否有 backpressure 先兆。

---

## 最终判断

按当前代码和提供的日志，优先级如下：

1. **高概率：backpressure 或 mesh carrier 读取停顿导致 `backpressure_gap`，继而 RST 和 failover。**
2. **高概率：failover 后 legacy snapshot/history replay 形成 burst，并延长恢复时间。**
3. **中概率：ws-secure 或 relay 链路实际 reset；keepalive 是可能触发器。**
4. **中低概率：大量 RTC 失败造成 Bun event-loop 或 hub 控制信令压力。它不会按当前代码直接抢占工作的 ws-secure。**
5. **低概率作为直接原因：`replay_byte_limit`。它是 retention 淘汰原因，不是当前 Forwarder 的 failover 条件。**

最先应确认的是：`[ws-metrics]` 所属的是 konata-mac 的物理浏览器 WebSocket，还是 jiefa-app 侧通过 `LinkStreamCarrier` 建立的远程 GatewaySession。随后用带时间戳的 `cid → pumpId → muxStreamId → nodeId` 关联日志，基本可以在一次故障中确定到底是网络断链、carrier 背压，还是 Bun event loop 延迟。