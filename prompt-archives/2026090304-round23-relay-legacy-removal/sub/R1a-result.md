# R1a 执行结果 — 网关侧 code review 六条 finding

worktree：`/Users/konata/code/tmex-r23`，分支 `feat/round23-relay-legacy-removal`。
只改了下面这些文件（其余 `git status` 里的改动来自并发的 B5 等批次，未触碰）：

| 文件 | 性质 |
| --- | --- |
| `apps/gateway/src/ws/tmux-selection-handlers.ts` | 生产代码 |
| `apps/gateway/src/ws/tmux-geometry-handlers.ts` | 生产代码 |
| `apps/gateway/src/mesh/stream-replay-state.ts` | 生产代码 |
| `apps/gateway/src/mesh/stream-replay-state-viewport.ts` | 生产代码（新增） |
| `apps/gateway/src/mesh/forwarder.ts` | 生产代码 |
| `apps/gateway/src/mesh/forwarder-failover.ts` | 生产代码 |
| `apps/gateway/src/ws/tmux-command-handlers.test.ts`、`viewport-claims.test.ts`、`canonical-gate.test.ts` | 测试 |
| `apps/gateway/src/mesh/stream-replay-state.test.ts`、`forwarder.test.ts`、`forwarder-failover.test.ts` | 测试 |
| `apps/gateway/src/mesh/integration/stream-failover.integration.test.ts` | 测试（重写） |

---

## Finding 1 — `TMUX_SELECT` 绕过实时几何去重

**判定：属实。**

`dispatchTmuxSelection` 传的是 `distrustLive: !data.wantHistory`。canonical 客户端的 `wantHistory` 恒为 false
（`packages/ws-client/src/message-builder.ts:47`，注释明确说该字段随 legacy 历史流失效），
所以每一次 select 都会 `distrustLive: true` → `applyWinnerGeometry` 拿不到 live 几何 → 恒定 `force: true` 重下 resize。
v1.1 契约里只有 `ResizePaneV11(geometryReason=resend)` 允许不信任快照几何
（`apps/gateway/src/ws/tmux-geometry-handlers.ts:144-168` 的注释即如此写）。

**修复：** `apps/gateway/src/ws/tmux-selection-handlers.ts:102` 去掉 `distrustLive`，只留 `{ applyUnknown: false, skipResize: data.wantHistory }`。
tmux 侧的 select/focus 行为一行未动。

**测试：**
- `apps/gateway/src/ws/tmux-command-handlers.test.ts`「wantHistory:false 带与快照相同的尺寸时不 resize；随后的 resend 强制下发」——
  原用例断言的是「仍 resize」，按新契约改写：select 同尺寸 → 无 resize；紧接的 `ResizePaneV11(resend)` → 强制下发。
- `apps/gateway/src/ws/viewport-claims.test.ts` 两处随之改写（新增 `termResend()` 辅助）：
  「sized warm select 与快照一致时不 resize；随后的 resend 强制下发」、
  「warm select onto a second window follows the snapshot; the resend forces the resize」。

**副作用说明：** 顺带确认了 `resend` 的语义边界——`distrustLive` 只是不看 live 几何，仍会和 `entry.lastAppliedViewport` 去重；
所以「视口声明刚把窗口拉到目标尺寸 → 同尺寸 resend」不会重复下发（见 Finding 4 的用例注释）。

---

## Finding 2 — 切换重协商在 HELLO 缺失/损坏时 fail-open

**判定：两条都属实。**

(a) `replaySubscription()` 用 `Promise.race([helloWait, sleep(2000)])` 等 HELLO，超时后无差别继续
`buildConnectFrames()` / `buildPostConnectFrames()`，`completeFailover()` 随后 `flushQueue()`——
一条身份未知的流上会被灌进设备连接、订阅和排队的浏览器输入。
(b) `beginResume()` 不清 `peerVersion`；`noteInbound` 里 HELLO_S2C 的 `decodePayload` 失败被空 `catch` 吞掉，
`peerVersion` 保留上一条流的值，于是坏 HELLO 直接继承旧的「达标」判定。

**修复：**
- `apps/gateway/src/mesh/stream-replay-state.ts:200` `beginResume()` 先 `this.peerVersion = null`（每次续流都要对端重新自证）。
- `apps/gateway/src/mesh/stream-replay-state.ts:173` HELLO_S2C 解包失败时 `peerVersion = null`（fail-closed）。
- `apps/gateway/src/mesh/forwarder-failover.ts:296-306` HELLO 等待结束后用 `pump.replay.peerSupportsCanonical()` 判定；
  不达标就带 `helloOk: false` 直接返回，**不发** connect/订阅/agent 帧。
- `apps/gateway/src/mesh/forwarder-failover.ts:226-233` `completeFailover()` 在 `pumpDead` 检查之后、
  续流成功路径之前拦截 `!helloOk`，复用 `rejectStaleNodeStream()`：向浏览器发 ERROR，然后整条拆解，
  **不 flush 队列、不发 browserSignalFrames**。

因为 `peerVersion` 在 `beginResume()` 已清空，这一条同时覆盖了「新流没答 HELLO」「新流答了坏 HELLO」
「新流答了过旧版本」三种情况，判定只依赖本条流自己播报的版本。

错误码沿用网关既有的 `ERROR_CANONICAL_V11_REQUIRED`（= `ERROR_UNSUPPORTED_PROTOCOL`）+
`canonical-state-v1.1 required: node <version|unknown> < 1.1.22` 前缀，关闭码 1002 / `node-too-old`。
**客户端侧的展示映射不在本批次**（`packages/shared` / `packages/ws-client` / `apps/fe` 按规则未动），留给后续批次。

**测试（`apps/gateway/src/mesh/forwarder.test.ts`）：**
- 新增测试夹具 `answerHelloOnNewStreams(streams, reply)`：让此后新开的转发流像真节点一样应答 HELLO_S2C，
  `reply(index)` 可按开流序号给出「正常 / 损坏 / 不答」。原有 8 个 failover 用例在触发切换前挂上该夹具
  （此前它们靠 fail-open 才能过，现在走的是真实的「新流答 HELLO → 续流」路径）。
- 「切换后的新流不答 HELLO 时报错断流，不补订阅也不冲队列」：第一条流答 1.1.23、第二条静默；
  断言浏览器收到唯一一条 `ERROR_UNSUPPORTED_PROTOCOL`（message 含 `canonical-state-v1.1 required`）、
  关闭码 1002/`node-too-old`、上游第二条流 `closedOnce`、**第二条流上只发了 HELLO 一帧**
  （订阅没重放、切换期间排队的浏览器帧也没冲进去）。
- 「切换后的新流回了坏 HELLO 时不沿用上一条流的版本判定」：第一条流答 1.1.23、第二条答 payload 损坏的 HELLO_S2C；
  断言 message 落在 `node unknown` 分支（证明没继承 1.1.23）、上游流被关。

**测试（`apps/gateway/src/mesh/stream-replay-state.test.ts`）：**
- 「HELLO_S2C 解不出 payload 时判定为不支持，不沿用旧版本」。
- 「beginResume 清空 peerVersion：新流必须自己重新证明版本」。

---

## Finding 3 — 拒绝旧节点时泄漏上游 mesh 流与远端 GatewaySession

**判定：属实。**

`rejectStaleNodeStream()` 只调 `io.closeBrowser()`；`Forwarder.closeBrowser()` 做的是
`browserClosed = true` + `this.pumps.delete(ws)` + 关浏览器 socket，**从不碰 `pump.stream`**。
随后浏览器 WS 的 close 回调 `handleForwardSocketClose()` 用 `this.pumps.get(ws)` 已经取不到 pump，
直接走 `discardPendingStream(token)` 分支返回——上游 mesh 流始终没人关，节点侧的 GatewaySession 也就一直挂着。

**修复：** 把 pump 的完整拆解提成 `Forwarder.closePump(pump, info)`（`apps/gateway/src/mesh/forwarder.ts:489`）：
abort failover → 释放 hello/resume 等待 → 关 inflight 流 → 关当前流并置空 → 再 `closeBrowser`。
`failPump()`（:484）与 `handleForwardSocketClose()`（:192）都改为复用它（后者原本是同一段逻辑的第三份拷贝）。
`rejectStaleNodeStream` 的 io 契约把 `closeBrowser` 换成 `closePump`
（`apps/gateway/src/mesh/stream-replay-state.ts:28,49`），`StreamFailoverHost` 同步新增 `closePump`
（`apps/gateway/src/mesh/forwarder-failover.ts:49`，`forwarder.ts:442` 接线）。

注：`forwarder.ts` 在 allowlist 里记着 `fileLines: 964`，复用拆解后是 962 行，没有变差、也没有新增 allowlist 条目。

**测试：** `apps/gateway/src/mesh/forwarder.test.ts`「对端节点低于 canonical v1.1 门槛时向浏览器报错并断流」
补断言 `streams.lastWs?.closedOnce === true`；Finding 2 的两个新用例也各自断言了上游流被关。

---

## Finding 4 — entry↔node 切换后视口 claim / 最新几何没有恢复

**判定：属实。**

切换会在节点侧新建 GatewaySession，`session.viewportClaims` / `paneSizeEpochs` 随旧会话消失；
而 `buildConnectFrames()` / `buildPostConnectFrames()` 只重放 DEVICE_CONNECT、canonical 订阅、AGENT_SUBSCRIBE。
浏览器的物理 WS 没断，不会自己重发 `TERM_VIEWPORT` / `TMUX_SELECT` / `ResizePaneV11`，
于是切换后该浏览器在新会话上「没有任何 claim」——窗口几何被其余客户端（或空集）重新仲裁。

**修复：** 新增 `apps/gateway/src/mesh/stream-replay-state-viewport.ts`（`ViewportReplayCache`，86 行）：
- 一张按「最后写入」排序的 Map（同 key 覆盖时移到队尾），key 为
  `v\0<device>\0<pane>`（TERM_VIEWPORT）、`s\0<device>\0<window|pane>`（TMUX_SELECT）、
  `r\0<device>\0<pane>`（ResizePaneV11）。补发时按同一顺序下发，最后一次写入仍然是最后生效的那条，
  节点侧仲裁出的赢家因此与切换前一致。
- `ResizePaneV11` 缓存的永远是改写后的 **`geometryReason=resend`** 版本，`sizeEpoch` 原样保留
  （新会话的 `paneSizeEpochs` 是空的，同 epoch 会被接受；`acceptSizeEpoch` 只拒更小的 epoch）。
- 上限 64 条，超出丢最旧的；`DEVICE_DISCONNECT` 时按设备清（`stream-replay-state.ts:548`）。

接线：`noteOutbound()` 的 canonical 分支多认一个 `ResizePaneV11`（`stream-replay-state.ts:154`），
`default` 分支收 TERM_VIEWPORT / TMUX_SELECT（:158）；`buildPostConnectFrames()` 在 canonical 订阅之后、
agent 订阅之前插入补发帧（:222）。

关于 TMUX_SELECT：legacy 时代它还写 `session.borshState.selectedPanes`，legacy 删除后它在节点侧只剩两件事——
tmux 焦点 + `recordViewportClaim`。焦点是 tmux 自己的状态、切换不会丢；但「只发过 select、没发过 viewport/resize」的
pane，它的 claim 只能靠 select 恢复，所以按 finding 要求一并补发。

**测试：**
- `apps/gateway/src/mesh/stream-replay-state.test.ts` 新增 describe「StreamReplayState 视口/几何补发」三例：
  ① 补发最新视口声明 + 焦点 + 尺寸，尺寸被改写成 resend 且 epoch 不变、同 pane 只留最后一条；
  ② 补发顺序按最后一次写入排列；③ 设备断开后不再补发该设备的几何。
- `apps/gateway/src/ws/viewport-claims.test.ts`「切换后补发视口 + resend 尺寸：owner 与几何回到切换前」：
  两个浏览器（160×48 / 80×24）→ 小的那个会话消失（claim/epoch 清掉，几何被抢回 160×48）→
  新会话补发 TERM_VIEWPORT + resend → 断言新会话重新成为 owner（80×24）、另一个浏览器收到的策略帧与切换前**逐字段相同**。
  这里用节点侧的两会话仲裁面来验「owner/几何不变」，比拉一整套 mesh 双浏览器 e2e 更直接也更稳。

---

## Finding 5 — `paneSizeEpochs` 随 pane 增删无界增长

**判定：属实。** 该表只在 `dropPaneSizeEpochs()` 被调时清（设备断开 / 会话关闭，
`device-connection-registry.ts:247,362`、`session-close.ts:102`），pane 被删掉后条目一直留着。

**修复：** `apps/gateway/src/ws/tmux-geometry-handlers.ts:137` 新增 `pruneMissingPaneSizeEpochs()`，
在 `reconcileDeviceViewportSnapshot()`（:309，由 `installStateSnapshot → onStateSnapshotInstalled` 每次快照落地时触发）
按最新快照里的 pane 集合清掉该设备下已消失的 pane。没有快照时不动（不拿空快照误删）；别的设备前缀不受影响。
选快照对账而不是 canonical metadata 钩子，是因为前者已经是「pane 集合发生变化」的既有统一入口，不需要在 tmux-client 侧加钩子。

**测试：** `apps/gateway/src/ws/canonical-gate.test.ts`「pane 增删后快照对账清掉已消失 pane 的尺寸 epoch」：
四个 pane 各留一条 epoch → 装入只含 `%0` 的快照 → 只剩 `device-a\0%0`；另一台设备的条目不受影响。

---

## Finding 6 — `stream-failover.integration.test.ts` 绕过被测的 canonical 数据面

**判定：属实，且比描述的更糟。** 旧用例里 `fakePaneRuntime` / `paneSnapshot` / `encodeDeviceConnect` / `hasKind`
根本没被使用：它从不发 DEVICE_CONNECT，节点侧没有任何设备挂载，订阅落到空设备集合上（等于没订阅），
数据由测试自己 `wsServerB.sendChunked(client, PaneData)` 直推给所有已协商的会话。于是
pane 保留区、订阅接受/拒绝、游标重放**一条都没被覆盖**。而且计数器只在「存在已协商会话」时才自增，
切换窗口内根本不产数，所谓「连续性」是自证的；末尾还先折叠相邻重复序号再断言连续，等于放过了重复投递。

**重写（`apps/gateway/src/mesh/integration/stream-failover.integration.test.ts`）：**
- 新增 `FailoverPaneRuntime`：`getServerEpoch/getPaneIdentity/getMetadataSnapshot/attachPaneConsumer/subscribe/…`
  背后是真正的 `PaneRetention`，`emit()` 把 `SEQ_n\n` **ingest 进保留区**；节点 B 的 `WebSocketServer`
  用 `deps.acquireRuntime` 拿到它。浏览器侧按真实顺序发 HELLO → DEVICE_CONNECT → SetPaneSubscriptions
  （`serverEpoch` 必须与运行时一致，否则会被判 `EPOCH_CHANGED` 拒绝）。
- 断言：切换前后各有一次 `SubscriptionApplied`，`rejected` 为空、`activePanes` 含目标 pane
  （= 只有订阅被接受的会话才拿得到数据）；按到达顺序核对 `PaneData` 的 `seqStart` 必须接上一帧的 `seqEnd`——
  **往回走 = 重复投递**（`duplicates`），**往前跳且此前没有 `SourceGap` = 静默丢数据**（`silentGaps`），两者都必须为空；
  没有任何 gap 时还额外断言重放游标严格等于切换前收到的最后一个字节（`resumeAt.seqStart === cursorBeforeKill`）
  以及 `SEQ_n` 严格 1,2,3,…；失败切换日志里 `resumed=1`（真的按游标续上了）。
- 保留区在测试夹具里放宽了 `routeGraceMs`（默认 2s）与 `replayTtlMs`：慢切换（DC 熔断退到 relay，实测可达 12s）
  会超过默认窗口而合法丢数据，放宽后「按游标重放」这条真实路径在慢机器上也能被覆盖；真丢数据时仍会报 gap 并被上面的断言接住。
- 断 DC 之前补了一次 `waitUntil(transportOf === 'dc')`：机器繁忙时 dc 会短暂退化，等它回来再断，保证断的确实是 dc 这条路。

---

## 验证

- `cd apps/gateway && bun test src/ws src/mesh/stream-replay-state.test.ts src/mesh/forwarder.test.ts src/mesh/forwarder-failover.test.ts src/mesh/integration/stream-failover.integration.test.ts src/tmux-client`
  → **1103 pass / 0 fail**。
- 全量 `cd apps/gateway && bun test` → 见下「全量与并发干扰」。
- `bunx tsc --noEmit -p apps/gateway` → **0 error**。
- `bunx biome check`（改动文件）→ 干净（有一处格式化由 `--write` 修正）。
- `bun run lint`（`biome check .` + `scripts/complexity/gate.ts`）→ 全绿，`complexity gate ok`。
  文件行数：`forwarder.ts` 962（allowlist 964，未变差）、`stream-replay-state.ts` 691（allowlist 827，未变差）、
  新增的 `stream-replay-state-viewport.ts` 86、`tmux-geometry-handlers.ts` 421，均未新增/放宽 allowlist。

### 全量与并发干扰

全量跑了 5 次，每次的失败集合都不同——B5 等批次正在并发改 `mesh/relay-*`、`hub/*`、`auth/*`，
`auth-routes` / `hub authorization` / `relay *` 系列用例在这期间反复红绿。属于我这批的只有 gateway 侧那批用例，
上面的定向命令 1103 pass / 0 fail 是可复现的稳定结果。

最后一次全量（机器相对空闲时）：**4114 pass / 0 fail / 4114 across 364 files**，全绿。
上一次（19:19，其他 agent 正在跑重活）：**4110 pass / 4 fail**，4 条全部落在既有的 load flake 集合里：
`large raw-body push over mesh` ×2、`RtcPeerManager > ice failed summary`、`stream failover integration`。

关于最后这条要说清楚（**留给指挥者判断**）：重写后的用例单跑 10 次全绿，
在「后台并行跑整个 mesh+ws 套件」的压力下再跑 7 次也全绿；只有在**整仓全量**里偶发（6 次里 3 次，且都发生在其他 agent 同时压机器的时段；机器空闲的那次全量 0 fail）。
抓到的失败现场不是我的断言，而是一条无归属的未捕获异常被算到当前用例头上：

```
RangeError: Cannot use a closed database
    at list (apps/gateway/src/auth/mesh-hub-store.ts:94)
    at authorizedHubRecords (apps/gateway/src/hub/uplink-server.ts:2028)
    at emitAttachments (apps/gateway/src/hub/uplink-server.ts:777)
    at publishLocalAttachments (apps/gateway/src/hub/uplink-server.ts:704)
    at <anonymous> (apps/gateway/src/hub/uplink-server.ts:1797)
```

即**前面某个 integration 文件**（同一次里是 multi-hub 一带）teardown 关库后，hub uplink 的定时任务还在跑并炸掉；
谁当时是活跃用例谁背锅。同一次日志里还能看到 `failover_attempt … getLink_ms=11723`——
整机被并发 agent 压满时 RTC 重拨要十几秒，我的用例因此长时间存活，正好成了这颗流弹的靶子。
根因在 `apps/gateway/src/hub/uplink-server.ts` 的定时器没跟随 db 关闭取消，不在 R1a 的改动范围（也不在授权范围内），
建议单独开一条「integration 用例 teardown 泄漏定时器」的清理项。

## 留给指挥者

1. **客户端错误映射**：Finding 2/3 的 ERROR 现在仍是 `ERROR_UNSUPPORTED_PROTOCOL` +
   `canonical-state-v1.1 required: node …` 前缀（按规则没动 `packages/shared` / `ws-client` / `fe`）。
   若要让「新流没答 HELLO」在前端有区分度更好的文案，需要在后续批次里做前端映射。
2. **`failover-exhausted` 路径同类泄漏**：`runStreamFailover` 在重试用尽时仍只 `closeBrowser`；
   若最后一次 `completeFailover` 是以 `return false` 收场（流已绑定但未确认），那条流也不会被关。
   与 Finding 3 同一类问题，但 finding 没点到、按「不做超出范围的加固」没改——若要收口，
   把那行换成 `closePump` 即可（一行）。
3. **上面那条 hub uplink 定时器泄漏**，会持续污染全量的失败清单。
