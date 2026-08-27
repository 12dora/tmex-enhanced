# F3-1-fix 结果 — 浏览器侧直连控制器评审整改

对应任务：`sub/f3-1-fix-prompt.md`（评审 `sub/f3-1-review.md`，原实现 `sub/f3-1-result.md`）。
worktree `/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。

## 一、验证

| 项 | 结果 |
|---|---|
| `cd packages/ws-client && bun test` | **209 pass / 0 fail**（改前 164） |
| `bunx tsc --noEmit -p packages/ws-client` | 0 error |
| `bunx biome check`（本次改动的 19 个文件） | 干净 |
| `packages/stores` / `packages/panels` 测试 | 123 pass / 212 pass，0 fail（回归） |
| `apps/fe`（`bun test src/node/`） | node-runtimes 9 pass；另有 2 个失败在 `mesh-events.test.ts` / `enrollment.test.ts`（**F4-fix 在改的文件，与本次改动无关**） |
| `tsc -p apps/fe` | 只剩 `enrollment.test.ts` 的 2 个既有错误（F4-fix 的文件） |

## 二、逐条整改

### 1. 指纹解析（blocker）— `direct/fingerprint.ts`

按 RFC 8122 的作用域重写 `parseSdpFingerprint`：切 SDP section → 只看 `m=application` 段，
该段有 `a=fingerprint` 就**覆盖** session 级、没有才回落；有效集合去重后必须**恰好一条 sha-256**，
否则返回 `null`（冲突、多算法并存、多个 `m=application`、只有音视频段、缺指纹都拒绝）。
本地 offer 与远端 answer 走同一个解析器；比较仍用归一化后的 `fingerprintsEqual`。

- 测试：`fingerprint.test.ts` 11 个用例，含攻击向量「session 级放合法 `fp_node`、
  `m=application` 段注入攻击者指纹」→ 解析结果是攻击者那条 → 与 `fp_node` 不等 → 拒绝；
  `direct-carrier-controller.test.ts` 新增同形 answer 的端到端拒绝用例。
- **与 `@tmex/shared/auth` 的 `parseSdpFingerprint` 刻意不再等价**（后者是宽松首条匹配），
  原对拍用例改为只对 `normalizeFingerprint` 对拍，模块头注释写明理由。
  ⚠️ node 侧 `apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:396` 仍用 shared 的宽松版校验
  浏览器 SDP —— 归 b3-1-fix，建议同样收紧（见「五」）。

### 2. attempt 生命周期 — `direct/direct-carrier-controller.ts`

`beginAttempt()` 在**任何 await 之前**登记 attempt（generation id + `AbortController` +
**每次尝试新生成的 `rtcSession`** + 信令订阅 + 连接超时）。所有回调/catch/teardown 一律
先过 `stale(attempt)`（`cancelled || this.attempt !== attempt || !started`）。
`fetchRtcConfig` / `authorize` 传 `attempt.abort.signal`；`teardownAttempt` 必定
`abort()` + 摘回调 + `carrier.close()` + `pc.close()`；`runAttempt` 里 factory 之后紧跟一次
stale 检查，过期就地 `close()` 新建的 PC。`rtcSession` 从只读字段改成 `get rtcSession(): string | null`
（当前 attempt 的值），options 里的 `rtcSession` 降级为**仅测试用**的固定值。

- 测试：`retry()` 关掉被替换 attempt 的 PC；rtc-config 在途时 `online` 触发 retry
  → 不会并发两个 attempt、只发一次 authorize；旧 attempt 迟到的 `failed` 不拆当代；
  「每次尝试换新 rtcSession + 旧 session 的 answer 不被接受」。

### 3. resume 钩子真正接线

- `packages/ws-client/src/connection.ts`：`GatewayConnection` 新增
  `setResumeSubscribedPanes(fn | null)`（转发给 client，纯加法）。
- `apps/fe/src/node/node-runtimes.ts`：非 self 的连接建好后接上钩子，切回 primary 时
  1) 对每个已连接 device 重发整份 pane 订阅；2) 对**挂载中**的 pane 逐个 `requestPaneScreen`；
  3) 用 runtime 的通知出口弹 `直连已断开，最近输入可能未送达`。
  「挂载中」由 `connection.paneSinks.hasPaneSink()` 对着快照里的 pane 判定。
- 测试：`node-runtimes.test.ts` 三个用例（重发+重取+提示、无挂载 pane 时只提示、runtime 未建好时不抛）。
- ⚠️ 两处取舍见「五」：重发订阅用的是 `mountPane()` 立刻 release 的等价手法；toast 文案走
  `t(key, {defaultValue})`，i18n key 还没进 locale 文件。

### 4. 屏障四阶段 — `carrier-switch.ts`

`primary | pending-direct | direct | pending-primary`（`activeCarrier` 由阶段推导，对外不变）。
**只有 `pending-direct` 缓冲**；只有收到匹配 epoch 的 `to:'direct'` 才 `flushBuffered()`；
`to:'primary'` 与载体关闭一律**丢弃**缓冲并触发 resume（不再在 close 时排空——那会把直连帧
插到 primary 旧帧之后造成乱序，切回后再排空还会重复写终端）。`pending-primary` 里迟到的直连帧
直接丢弃。resume 的触发条件收紧为「确实丢了数据」：`phase === 'direct'` 或缓冲里有帧。

- 测试：四阶段迁移、切回后迟到帧被丢弃、关闭时不排空且触发 resume、`to:'primary'` 丢弃并 resume。

### 5. 屏障缓冲上限

`maxBufferedBytes` 1 MiB（与协议单帧上限一致）/ `maxBufferedFrames` 64，超限即
`abortDirect()`：关掉直连载体、丢缓冲、保住 primary、触发 resume（控制器随后按退避重连）。

- 测试：字节超限与帧数超限各一个用例。

### 6. 分片双向边界 — `direct/fragmenter.ts`

常量按 node 侧契约重新定义：`MAX_DC_MESSAGE_BYTES = 65536`（**含 8 字节头**）、
`FRAGMENT_PAYLOAD_SIZE = 65528`、`MAX_FRAME_BYTES = 1 MiB`、
`MAX_FRAGMENTS_PER_FRAME = ceil(1048576 / 65528) = **17**`；
`effectiveFragmentPayloadSize(maxMessageSize) = min(65528, maxMessageSize - 8)`。

- 发送端 `fragmentFrame()`：帧 > 1 MiB、载荷参数越界、分片数 > 17 一律抛 `FragmentBoundsError`。
- 接收端 `FrameReassembler`：单条消息 > 64 KiB、`total === 0 || total > 17`、`idx >= total`、
  长度不足头长、**单帧累计字节** > 1 MiB、**全局累计字节** > 4 MiB 全部上报
  `onViolation(reason)` 并丢弃；载体据此关闭直连（不再静默等超时）。新增 `bufferedBytes` 诊断。
- 测试：`fragmenter.test.ts` 新增 6 个边界用例（含 `total=65535` 的经典手法）；
  载体侧与控制器侧各一个「协议违规 → 关闭直连 → 退避重连」的用例。

### 7. 背压 — `direct/data-channel-carrier.ts` + `carrier-switch.ts` + `client.ts`

- 载体：**整帧**队列。`bufferedAmount > 4 MiB` 或队列非空时整帧入队（保序），
  `bufferedamountlow` 按序写出；队列上限 4 MiB，超限关闭载体（回落 primary 好过无限攒内存）。
- 分片中途 `channel.send()` 抛错 → **关闭载体**，不再返回可恢复的 `backpressure`
  （已写出的分片撤不回来，留着就是对端永远集不齐的半帧）。
- `CarrierSwitchBarrier.send()` 返回 `'sent' | 'backpressure'`，`backpressure` 表示
  「已排进直连队列、暂停」——**不再往 primary 补发一份**（否则重复且乱序）。
- `client.ts`：`sendRaw()` 返回是否真正写出，`send()` 在背压时返回 `false`
  （语义与「未就绪时进 pendingMessages」一致：数据没丢，调用方不该重发；仓库内没有按返回值重发的调用方）。
- 测试：整帧入队 + 排水后按序写出、队列超限关闭、出站帧 > 1 MiB 关闭、半帧失败关闭、
  屏障背压不落 primary、`client.send()` 背压返回 false 且不走 primary。

### 8. ICE 信令顺序

每 attempt 一个 FIFO `outbox`：offer 先入队，之后的候选自然排在其后；
送不出去就留在队头等信令 ready 再泵（`pumpOutbox` 单飞，不并发）。
offer 入队前产生的本地候选先攒在 `pendingLocalCandidates`。
入站信令用 `attempt.chain` **串行**处理：answer 校验指纹 → `setRemoteDescription` →
`remoteReady = true` → 逐个补发排队的远端候选；`remoteReady` 之前的远端候选一律排队。

- 测试：信令断开期间候选排队、恢复后按序补发（offer 在候选之前）、answer 后远端候选被 `addIceCandidate`。

### 9. 信令 transport 契约

`DirectSignalingTransport.send()` 改为 `boolean | Promise<boolean>`，新增可选
`isReady()` / `onReady(cb)`（没实现即视为恒就绪，老实现零改动）。控制器：未就绪不开 attempt、
信令排队；`onReady(true)` 时**重置退避计数**，有在途 attempt 就泵 outbox，否则立刻重连。

fe 侧适配器在 `node-runtimes.ts` 的 `MeshRtcSignalHub` 里实现：`send` 如实返回
`MeshEventSource.sendRtcSignal()` 的结果，`isReady = source.connected`，
`onReady = source.onStatusChange(...)`。
**`mesh-events.ts` 无需改动**——`connected` 与 `onStatusChange` 已经有了（F4-fix 不受影响）。

- 测试：未就绪不开 attempt / 恢复后重连；中途断开的排队与补发。

### 10. `active` 只在切换完成后

通道 open 只做「发首帧 nonce + 建载体 + `attachDirectCarrier`」，**保持 `connecting` 与连接超时**；
订阅 `connection.onCarrierChange`，收到 `'direct'`（屏障排空缓冲并回过 ACK 之后）才
清零重试计数、撤销超时、置 `active`、起 stats 轮询。收到 `'primary'` 视为该直连失效，
按载体失效退避重连。`GatewayConnectionLike` 因此新增可选 `onCarrierChange`
（宿主没实现时退化成「挂上即生效」）。

- 测试：open 后仍是 connecting 且超时未撤销；node 挂载后立刻关通道时退避从 1 s → 2 s
  继续增长（原实现每次都从 1 s 重来、永远到不了上限）；切回 primary 触发退避重连。

### 11. 网络变化

`iceConnectionState === 'disconnected'` 给 5 s 宽限（`iceDisconnectGraceMs`），
期间恢复 `connected/completed` 就取消；到期即回落 primary 并以全新 attempt/rtcSession 重来。
`failed/closed` 立即失败。除 `online` 外新增 `navigator.connection` 的 `change` 监听
（默认 800 ms 去抖，`connectionEvents` 可注入/关闭），`stop()` 一并注销。

- 测试：宽限到期回落 + PC 关闭 + 退避 1 s；宽限内恢复不回落；`change` 连发三次去抖后只重连一次。

### 12. Minor

- `ice-stats.ts` 选中候选对顺序改为 `selectedCandidatePairId → nominated&&succeeded →
  selected === true → 任意 succeeded`（原来「任意 succeeded」排在 `selected` 之前）。
  测试：多 succeeded 时取 `selected` 那对（实际走 TURN 不再显示 v4-p2p）、nominated 优先于 selected。
- `DirectDiagnostics` 新增 `route: DirectRoute | null`（`lan/v6/v4-p2p/turn/relay`），
  与 `path: 'primary'|'direct'` 分开发布；`PRIMARY_ONLY_DIAGNOSTICS` 同步加 `route: null`。
  测试：active 时 `diagnostics().route === 'lan' / 'turn'`，stop 后为 null。

### 附加项（协调者补充）— F3-2 的 bulk 接线

- 保留控制器上 F3-2 加的 `createDataChannel(label, init?)`（改成读 `attempt.pc`，语义不变：
  只有 `state === 'active'` 才允许），并补了单测（未 active 抛错、active 时在同一 PC 上开出第二条通道）。
- `node-runtimes.ts`：建控制器时 `registerBulkClient(nodeId, new BulkClient(controller))`，
  `dispose()` 时 `registerBulkClient(nodeId, null)`。测试：`getBulkClient(nodeId)` 建后非空、dispose 后为空。
- `packages/ws-client/src/index.ts` 的 bulk 导出未动。

## 三、改动文件

| 文件 | 改动 |
|---|---|
| `packages/ws-client/src/direct/fingerprint.ts` | RFC 8122 section 解析，只认 `m=application` 的唯一 sha-256 |
| `packages/ws-client/src/direct/fragmenter.ts` | 尺寸常量重定义、收发双向边界、`onViolation`、累计字节跟踪 |
| `packages/ws-client/src/direct/data-channel-carrier.ts` | 整帧背压队列、半帧失败即关闭、按 `maxMessageSize` 缩分片、协议违规自毁 |
| `packages/ws-client/src/direct/direct-carrier-controller.ts` | attempt 生命周期 / 每次新 rtcSession / 信令 outbox / 串行入站 / 切换后才 active / ICE 宽限 / 网络变化 / route 诊断 |
| `packages/ws-client/src/direct/ice-stats.ts` | 选中候选对顺序 |
| `packages/ws-client/src/direct/rtc-types.ts` | `send` 返回布尔、可选 `isReady/onReady`、`sctp.maxMessageSize` |
| `packages/ws-client/src/direct/types.ts` | `DirectDiagnostics.route` |
| `packages/ws-client/src/direct/test-fakes.ts` | 假通道分片中途失败、假 PC 的 ICE 状态、假信令的就绪开关、假连接的 `onCarrierChange/switchTo` |
| `packages/ws-client/src/carrier-switch.ts` | 四阶段、缓冲上限、关闭不排空、`send()` 返回背压 |
| `packages/ws-client/src/client.ts` | `sendRaw/send` 透出背压 |
| `packages/ws-client/src/connection.ts` | `setResumeSubscribedPanes` 转发（加法） |
| `apps/fe/src/node/node-runtimes.ts` | 信令就绪适配、resume 钩子接线与提示、bulk 登记/注销 |
| 对应 `*.test.ts` ×7 | 新增/改写回归用例 |

## 四、需要 F4-fix / 其他任务配合的点

1. **`apps/fe/src/node/mesh-events.ts` 不需要改动**：控制器要的就绪订阅用现成的
   `MeshEventSource.connected` + `onStatusChange()` 就够了，适配器写在 `node-runtimes.ts`。
   若 F4-fix 要重构这两个成员，请保留语义（`connected` 反映 `/mesh/ws` 是否可发送）。
2. **`packages/ws-client/src/connection.ts` 有一处加法**（`setResumeSubscribedPanes`），
   与 F4-fix 可能加的 `onClose` 选项不在同一处，合并无冲突（`onClose` 目前已在文件里）。
3. `apps/fe/src/node/device-node-badges.tsx`（不在本任务 scope）现在可以消费
   `diagnostics.route` 显示 `lan / v6 / v4-p2p / turn` 徽标——设计 §1 的「网络路径诊断」还差这一步。

## 五、两处取舍（复审请重点看）

1. **重发订阅用了 `mountPane()` + 立刻 release**。`PaneSubscriptionManager`（`packages/stores`）
   没有对外暴露「按当前集合重发一次」的入口，而 `subscribePanes()` 会覆盖手动订阅集合。
   mount+release 引用计数一加一减回到原值，副作用只是多下发一次相同集合（generation 递增），
   语义上等价且不改 stores。**更干净的做法**是在 `PaneSubscriptionManager` 上加一个
   `resendSubscriptions(deviceId)` 并经 tmux store 暴露——`packages/stores` 不在本任务 scope，未动。
2. **toast 文案走 `t('device.directFallbackToast', { defaultValue: '直连已断开，最近输入可能未送达' })`**。
   locale 文件与 `i18n/resources.ts`（生成物）不在本任务 scope，key 还没落地，
   目前 en/ja 也会显示中文兜底串。需要后续统一补 `zh_CN/en_US/ja_JP` 三份并跑 `bun run build:i18n`。

## 六、与 node 侧（b3-1-fix）的契约确认

- 单条 DataChannel 消息 ≤ 64 KiB **含 8 字节头** → 分片载荷 65528，实际取
  `min(65528, maxMessageSize - 8)`；重组帧 ≤ 1 MiB；`total ≤ 17`。浏览器侧收发双向都已强制。
- node 在发出 `CARRIER_SWITCH{to:'direct'}` 之后立刻把出站切到直连：这些帧落在浏览器的
  `pending-direct` 阶段，被缓冲、并在收到 primary 上的切换帧时按序排空——本次整改后
  这条路径只在**匹配 epoch 的 `to:'direct'`** 上排空，其余情况一律丢弃 + resume。
