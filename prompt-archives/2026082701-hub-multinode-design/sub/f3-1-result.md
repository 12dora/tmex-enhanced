# F3-1 结果：浏览器侧 DirectCarrierController 与载体切换屏障

对应任务：`sub/f3-1-prompt.md`。设计依据：`docs/hub/2026082700-hub-node-architecture.md` §3「直连授权」「载体切换屏障」「DataChannel 消息尺寸与背压」、§4「连接层」「可见性」。

## 一、交付文件

### 新增（`packages/ws-client/`）

| 文件 | 作用 |
|---|---|
| `src/direct/fragmenter.ts` | 64 KiB 分片 / 重组，头部 `[frameId u32][idx u16][total u16]`（全部小端），与 node 侧逐字节一致 |
| `src/direct/data-channel-carrier.ts` | 浏览器 `RTCDataChannel` 载体：分片发送、重组接收、4 MiB 高水位 / 1 MiB 低水位背压 |
| `src/direct/direct-carrier-controller.ts` | 直连生命周期：ICE 配置 → PC/`sess` 通道 → 指纹鉴权 → 信令 → 首帧 nonce → 挂载载体；退避重试、`online` 重连、诊断 |
| `src/direct/rtc-types.ts` | `RTCPeerConnection` / 信令 / REST 的最小结构子集（测试可注入假件，不依赖 lib.dom 的完整 WebRTC 接口） |
| `src/direct/ice-stats.ts` | `getStats()` → 选中候选对 → 路径徽标 `lan / v6 / v4-p2p / turn / relay` 与 RTT |
| `src/direct/fingerprint.ts` | `parseSdpFingerprint / normalizeFingerprint / fingerprintsEqual` |
| `src/direct/test-fakes.ts` | 测试共用假件（假 PC / DataChannel / 信令 / ApiClient / 手工时钟） |
| `src/carrier-switch.ts` | `CarrierSwitchBarrier`：四步切换协议里浏览器负责的第 2、3 步 |

### 修改

| 文件 | 改动（全部**加法**，未挂直连时行为与改前完全一致） |
|---|---|
| `src/client.ts` | 懒建屏障；`socket.onmessage` 在有屏障时先过屏障；`sendRaw` 经屏障路由；`handleClose / disconnect / reconnect` 调 `barrier.closeDirect()`；新增 `attachDirectCarrier / detachDirectCarrier / activeCarrier / onCarrierChange / setResumeSubscribedPanes` |
| `src/connection.ts` | `GatewayConnection` 新增 `attachDirectCarrier / detachDirectCarrier / activeCarrier / onCarrierChange / directDiagnostics`（后者为可写字段，缺省 `null`） |
| `src/index.ts` | 导出上述新模块 |
| `apps/fe/src/node/node-runtimes.ts` | 新增 `createNodeConnection(nodeId, wiring)` 与 `MeshRtcSignalHub`（`/mesh/ws` 单 handler 槽的扇出层）；`appNodeRuntimes` 用它作 `createConnection` |
| `apps/fe/src/node/direct-diagnostics.ts` | 仅更新注释（F3-1 落地，桩说明改成真实来源）；代码零改动即取到真实诊断 |

`packages/ws-client/src/direct/types.ts`（F4-3 的契约）**未改动**，控制器按原样实现 `DirectDiagnosticsSource`。

## 二、公开 API

### `DirectCarrierController`

```ts
new DirectCarrierController({
  nodeId,                 // 目标 node（self 由调用方保证不建）
  apiClient,              // 已带 /n/<nodeId> 前缀，只用 fetch()
  signaling,              // { send(signal), onSignal(cb): () => void }
  connection,             // { attachDirectCarrier(carrier), detachDirectCarrier?() }
  rtcFactory?,            // 缺省 new RTCPeerConnection(config)
  rtcSession?,            // 缺省随机 `br:<32 hex>`
  retryBaseMs? = 1000, retryMaxMs? = 30000, maxAttempts? = 5,
  connectTimeoutMs? = 15000, statsIntervalMs? = 2000,
  setTimeoutFn?, clearTimeoutFn?, networkEvents?, onStateChange?,
})

start() / stop() / retry()
getState(): 'idle' | 'connecting' | 'active' | 'failed'
path: 'lan' | 'v6' | 'v4-p2p' | 'turn' | 'relay' | null   // 非 active 恒为 null
rtt: number | null
reason: string | null                                      // 最近一次失败原因
diagnostics(): DirectDiagnostics                           // direct/types.ts 的契约
diagnosticsSource: DirectDiagnosticsSource                 // get/subscribe，供 useSyncExternalStore
pollStats(): Promise<void>                                 // 立刻抓一次（测试/手动刷新）
retryDelay(attempt): number
```

生命周期与设计 §3 一一对应：`GET /api/mesh/rtc-config` → 建 PC + `sess`（`ordered: true`，可靠）→ `createOffer` + `setLocalDescription` → 从 `localDescription.sdp` 解 `fp_browser` → `POST /api/rtc/authorize {rtcSession, fp_browser}` → `{nonce, fp_node}` → 发 offer / ICE 候选 → 收到 answer 时**先核对远端 SDP 指纹等于 `fp_node`**，不一致立即放弃且**不重试** → 通道 open 时写裸 JSON `{"nonce":"..."}` → 用该通道建 `DirectDataChannelCarrier` 并 `connection.attachDirectCarrier(carrier)`。

失败分级：指纹不匹配、`authorize` 返回 4xx → 终态 `failed` 不重试（等 `retry()` 或 `online`）；5xx / 超时 / 通道关闭 → 退避 1 s → 2 s → 4 s …上限 30 s，最多 5 次。

### `CarrierSwitchBarrier`

```ts
new CarrierSwitchBarrier({ deliver, sendPrimary, nextSeq?, onCarrierChange?, resumeSubscribedPanes? })
attachDirect(carrier) / handlePrimaryInbound(bytes) / handleDirectInbound(bytes)
send(bytes) / handleDirectClose(carrier?) / closeDirect() / reset()
activeCarrier / hasDirect / bufferedCount
peekEnvelopeKind(bytes): number | null   // 从 envelope 第 4、5 字节读 kind，不做完整反序列化
```

### `DirectDataChannelCarrier`

`send(bytes) → 'sent' | 'backpressure' | 'closed'`、`onMessage / onClose / onDrain / bufferedAmount() / close() / isClosed`。

### `GatewayConnection` 新增面

`attachDirectCarrier(carrier)`、`detachDirectCarrier()`、`activeCarrier`（getter）、`onCarrierChange(cb)`、`directDiagnostics: DirectDiagnosticsSource | null`。

### `apps/fe`

`createNodeConnection(nodeId, wiring?)`：非 self 时建控制器、`start()`、把 `diagnosticsSource` 挂到 `connection.directDiagnostics`，并包装 `dispose()` 以在运行时回收时 `controller.stop()`。`wiring` 只用于测试注入。

## 三、测试

### `packages/ws-client`（`bun test`）

| 文件 | 覆盖 |
|---|---|
| `direct/fragmenter.test.ts` | 头部字节序、空载荷、切分边界、顺序/乱序/交错重组、重复片与畸形头、超时清理、在途上限淘汰 |
| `direct/fingerprint.test.ts` | 解析与规范化；**与 `@tmex/shared/auth` 同一批向量对拍**（重写实现不漂移） |
| `direct/data-channel-carrier.test.ts` | 低水位设置、分片发送、4 MiB 背压与 `bufferedamountlow` 排水、closed 判定、send 抛异常降级为背压、重组后才回调、close 只回调一次 |
| `direct/ice-stats.test.ts` | `transport.selectedCandidatePairId` 优先 / nominated 回落、rtt 秒转毫秒、lan / v6 / v4-p2p / turn 推导、缺数据回 null |
| `direct/direct-carrier-controller.test.ts` | ICE 配置归一；happy path（鉴权体 = 本地 SDP 指纹、offer 上行、answer 落地、首帧裸 JSON nonce、载体挂载、state=active）；ICE 候选双向；异 `rtcSession` / `from:'browser'` 忽略；**指纹不匹配放弃且不排重试**；4xx 不重试 / 5xx 重试；退避 1s→2s→4s 与上限、`retry()` 重置；`online` 重连与 `stop()` 注销监听；通道关闭后退避重连；连接超时；stats 推 path/rtt/ICE 明细；诊断快照引用稳定 |
| `carrier-switch.test.ts` | `peekEnvelopeKind`；挂载后仍走 primary；**跨切换不乱序**（缓冲→排空→改活跃源）；ACK 走旧载体且 epoch 一致；**陈旧 epoch 忽略且不回 ACK**；无直连时不切换；切回 primary 触发一次 resume；直连自关回落且不重复 resume；出站遇 closed 就地回落重发；`closeDirect()` 归零 epoch 后可再切；重复 attach 关旧载体；入站 ACK 丢弃 |
| `client.test.ts`（追加一节） | 未挂直连时收发路径不变；`CARRIER_SWITCH` 到达后 ACK 走 WS、出站改走直连、缓冲排空；切回触发 `resumeSubscribedPanes`；primary 断开关直连；`detachDirectCarrier()`；`createGatewayConnection` 透出新面 |

### `apps/fe`

`src/node/node-runtimes.test.ts`：`self` / 空串不建控制器且不挂诊断源；非 self 建控制器、`start()`、挂 `directDiagnostics`；`dispose()` 先停控制器再走原 dispose；控制器工厂返回 `null` 时连接照常可用。

### 数据

| 包 | 测试（前 → 后） | tsc（前 → 后） | biome |
|---|---|---|---|
| `packages/ws-client` | 75 pass / 0 fail → **140 pass / 0 fail** | 0 → **0** | clean |
| `apps/fe`（`bun test src`） | 101 pass / 0 fail → **91 pass / 15 fail**（新增 5 个全 pass） | 0 → **0** | clean |

**`apps/fe` 的 15 个失败与本任务无关**：全部是 `InvalidNodeIdError: invalid node id: <非 hex>`，来自并发进行中的 `packages/api-client/src/node-url.ts` 新增 `assertNodeId()`（只接受 `self` 或 32 位小写 hex），而 `node-runtime-boundary.test.tsx` / `sidebar-device-list.test.tsx` / `FilePage.test.tsx` / 登录相关测试的夹具仍用 `'remote'`、`'node-a'` 这类 id。已单独验证：把本任务对 `node-runtimes.ts` 的改动移除后，同一批用例照样失败。这些文件不在本任务 scope 内，需由 api-client / F4-x 的负责人更新夹具。

## 四、B3-1（node 侧）必须对齐的点

1. **首帧格式**：`sess` 通道的第一条消息是**裸的、未分片**的 UTF-8 JSON `{"nonce":"<base64url>"}`，**不带分片头、不是 Borsh envelope**。原因：`RtcPeerManager.acceptBrowser` 在构造 `DataChannelCarrier` 之前用 `waitFirstMessage` 直接读通道原始消息（`apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:294`），此时重组器还没接管。浏览器发完 nonce 后**同一个 tick 内**构造载体并接管 `onmessage`，中间不会漏帧。node 侧若改成"nonce 也走载体"，浏览器必须同步改。
2. **分片头**：`[frameId u32 LE][idx u16 LE][total u16 LE]`，分片载荷 64 KiB，空载荷也产出 1 片（`total=1`）。与 `apps/gateway/src/mesh/rtc/fragmenter.ts` 完全一致，`frameId` 从 1 起自增、回绕跳过 0。
3. **epoch**：node 的 `CarrierSwitchController` 从 0 起、每次 `sendSwitch` 先 `+1`，因此首次切换 epoch = 1。浏览器只接受 `epoch > 已应用 epoch` 的 `CARRIER_SWITCH`，陈旧的直接丢弃**且不回 ACK**（node 的 `handleAck` 也要求 `epoch === state.epoch`，两侧一致）。
4. **ACK 的传输方向**：浏览器在**旧载体（primary WS）**上回 `CARRIER_SWITCH_ACK{epoch}`，作为标准 Borsh envelope（kind `0x0a04`）。node 必须在 primary 载体的入站路径上识别该 kind 并调 `RtcPeerManager.handleCarrierSwitchAck(session, epoch)`。
5. **`CARRIER_SWITCH` 必须是带 magic `TX` 的标准 envelope**：浏览器用 `peekEnvelopeKind()` 只读头 6 字节判定，magic 不符的帧会被当成普通数据帧上抛。
6. **切回 primary**：node 在直连断开时发 `CARRIER_SWITCH{epoch+1, to:'primary'}`，浏览器据此切回并触发一次 pane resume；浏览器本地先感知到通道关闭时也会自行回落并 resume，随后到达的切回帧**不会重复 resume**（按活跃载体是否真的从 direct 变 primary 判定）。
7. **primary 断开**：浏览器在 WS `onclose` / `disconnect()` / `reconnect()` 时主动 `closeDirect()` 并把 epoch 归零，与设计「primary 断开则会话整体结束」一致；重连后是全新会话，node 的 epoch 也从 1 重新开始。
8. **信令编码**：`sdp` 为 `JSON.stringify({type, sdp})`、`candidate` 为 `JSON.stringify({candidate, mid})`，与 `apps/gateway/src/mesh/rtc/ice.ts` 的 `encodeSdpSignal / encodeCandidateSignal` 同形；浏览器把 `RTCIceCandidate.sdpMid` 映射为 `mid`（缺省 `'0'`）。
9. **鉴权接口**：`POST /api/rtc/authorize` 请求体 `{rtcSession, fp_browser:{algorithm, value}}`，响应 `{nonce: base64url, fp_node:{algorithm, value}}`；4xx 被浏览器当作终态（不重试），5xx（含 `DIRECT_UNAVAILABLE`）才退避重试。指纹一律按"小写算法名 + 去冒号大写十六进制"比较。

## 五、遗留与开放点

1. **node 侧尚未接线 `sendControl`**：`RtcPeerManagerOptions.sendControl / deliverInbound` 目前无人传入（`grep` 全仓只在 `rtc/` 内出现），因此 `CarrierSwitchController` 还不会真的发出 `CARRIER_SWITCH`。B3-1 需要把它接到 `GatewaySession` 的出站与 `ws/` 入站 demux 上，浏览器侧才会真正切换。
2. **`resumeSubscribedPanes` 钩子尚无消费者**：`client.setResumeSubscribedPanes(fn)` 已就位，但"对已订阅 pane 触发一次 resume"的具体实现在 `packages/stores`（本任务 scope 外）。切回时目前只回落载体、不补齐历史。同样，设计里「切回时提示"直连已断开，最近输入可能未送达"」的 UI 提示也未做（需要 i18n key 与 toast，属 F4-x）。
3. **`bulk:*` 通道未实现**：本任务只做 `sess` 载体。文件传输走 bulk 的部分（设计 §3「bulk 协议」）留给后续任务；控制器目前只在 PC 上开一个 `sess` 通道。
4. **路径徽标只显示 `primary / direct`**：`DirectDiagnostics` 契约（F4-3）没有承载 `lan / v6 / v4-p2p / turn` 的字段，控制器把它放在 `controller.path` 上，UI 层若要显示需扩展契约或读 `ice.selectedPair`（形如 `host → srflx`）。为不越界改 `device-node-badges.tsx`，本任务没有动契约。
5. **`rtcSession` 由浏览器自行生成**（`br:<32 hex>`）：设计 §3 提到 entry 转发信令时要校验 `rtcSession` 登记的 `(浏览器会话, 目标 nodeId)`。目前登记发生在 `authorize` 时（node 侧 `ensureBrowser`），entry 侧的登记/校验由 mesh-routes 负责，浏览器不做额外约定。若后续改成由服务端下发 `rtcSession`，控制器已留 `rtcSession` 选项，改一处即可。
6. **`self` 永不建直连**由 `createNodeConnection` 保证；`direct_capable=false` 的 node 目前仍会尝试一次（`authorize` 会返回 503 `DIRECT_UNAVAILABLE`，退避 5 次后停在 `failed`）。可优化为读 `/api/mesh/nodes` 的 `direct_capable` 先行短路，但那要求控制器依赖 mesh 列表，暂未做。
7. **`test-fakes.ts` 随包发布**：与 `apps/gateway/src/mesh/rtc/test-fakes.ts` 同样的做法，只被测试引用，打包时会被 tree-shake。
