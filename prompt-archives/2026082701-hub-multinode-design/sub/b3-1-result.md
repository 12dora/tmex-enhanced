# B3-1 结果 — RtcPeerManager / DataChannelCarrier / DataChannelLink / CARRIER_SWITCH

worktree：`/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。  
范围仅 `apps/gateway/src/mesh/rtc/**`（新目录）。未改 `peer-manager.ts`、`peer-protocol.ts`、`mesh-runtime.ts`、`mesh-routes.ts`、`ws/**`、`packages/**`。

## 做了什么

落地 node 侧 WebRTC 数据面：64 KiB 分片、`DataChannelCarrier` / `DataChannelLink`、node↔node `path:'dc'` 握手（指纹绑定、DTLS 上不再加密）、browser↔node `sess` nonce 授权、`CARRIER_SWITCH` 屏障、B2-2b `rtc.fingerprint` / `rtc.signals` 钩子实现。native 通过注入的 `loadNative()` 装载（gateway 不 import `packages/app`）。

## 文件清单

| 文件 | 职责 |
|---|---|
| `native.ts` | `NodeDatachannelModule` / `PeerConnectionLike` / `DataChannelLike` |
| `fragmenter.ts` | `[frameId u32][idx u16][total u16]` + 重组（超时 / 在途上限） |
| `data-channel-carrier.ts` | `Carrier` over DC；4 MiB 背压、1 MiB low watermark |
| `data-channel-link.ts` | `ByteTransport` over DC，供 `LinkMux` |
| `dc-handshake.ts` | DC hello/sig，`path:'dc'`，`remoteFingerprint()` 核对 |
| `ice.ts` | STUN/TURN → `iceServers`；sdp/candidate JSON 编解码 |
| `rtc-peer-manager.ts` | 装载、建 PC、node↔node、authorize/acceptBrowser、attachDirect |
| `carrier-switch.ts` | `CARRIER_SWITCH` / `ACK` 屏障 |
| `signaling.ts` | `MeshRtcSignalRouter`（B2-2b `rtc.signals`） |
| `index.ts` | barrel |
| `test-fakes.ts` | 单测用 FakePC / FakeDC（不从 barrel 导出） |
| `*.test.ts` | 单测 |
| `rtc-loopback.integration.ts` | 真 native 回环（`bun test` 不自动发现） |

## 公开 API

```ts
import {
  RtcPeerManager, DataChannelCarrier, DataChannelLink,
  CarrierSwitchController, MeshRtcSignalRouter,
  fragmentFrame, FrameReassembler,
} from './mesh/rtc'

type LoadNative = () => Promise<NodeDatachannelModule | null>

new RtcPeerManager({
  loadNative,                                          // assembler 传入 C5-2 loadNodeDatachannel
  iceConfigProvider: () => ({ stun: string[], turn: unknown }),
  identity: MeshIdentity,
  userStore: UserStore,
  now?: () => number,
  sendControl?: (session, kind, payload) => void,      // → WebSocketServer.sendEnvelope
  deliverInbound?: (session, bytes) => void,           // → WebSocketServer.handleMessage
  handshakeTimeoutMs?: number,                         // 默认 15s
})

get available: boolean
ready(): Promise<boolean>
fingerprintProvider(): RtcFingerprintProvider          // 即 this
getFingerprint(): Promise<DtlsFingerprint>             // 探测 PC，B2-2b 现钩子已不用
createPeerConnection(role: 'offerer'|'answerer', label?: string): Promise<{
  pc: PeerConnectionLike; fingerprint: DtlsFingerprint; channel: DataChannelLike | null
}>
connectToPeer(peerNodeId, signaling: { send(msg), onMessage(cb) }): Promise<{
  link: DataChannelLink; pc: PeerConnectionLike; peerNodeId: string; role: 'initiator'|'acceptor'
}>
authorizeBrowser({ rtcSession, uid, via, fpBrowser }): Promise<{ nonce: Uint8Array; fpNode } | null>
  // 对齐 mesh-deps RtcFingerprintProvider；2 min 登记；native 未装载 → null
acceptBrowser(rtcSession, signaling): Promise<{ carrier: DataChannelCarrier; pc; uid }>
  // 节点为 answerer；sess 首帧 {nonce} b64url 必须匹配；remoteFingerprint() == fpBrowser
attachDirect(session: GatewaySession, carrier: Carrier): void
handleCarrierSwitchAck(session, epoch: number): void
handleDirectClose(session, carrier?: Carrier): void
close(): void

class DataChannelCarrier implements Carrier {
  constructor(channel: DataChannelLike)
  send(bytes): 'sent'|'backpressure'|'closed'   // 分片 + sendMessageBinary(Buffer.from(u8))
  onMessage(cb): void
  onClose(cb): void
  // bufferedAmount > 4MiB → backpressure；setBufferedAmountLowThreshold(1MiB)
}

class DataChannelLink implements ByteTransport { constructor(channel: DataChannelLike) }

class CarrierSwitchController {
  constructor({ sendControl, deliverInbound })
  attachDirect(session, carrier): void          // 发 CARRIER_SWITCH{epoch, to:direct}，缓冲入站
  handleAck(session, epoch): void               // 匹配才 switchActiveCarrier + flush；过期 ACK 忽略
  handleDirectInbound(session, bytes): void
  handleDirectClose(session, carrier?): void    // 切回 primary，发 CARRIER_SWITCH{epoch+1, to:primary}
}

class MeshRtcSignalRouter implements RtcSignalRouter {
  constructor({ selfNodeId, sendCtl: (nodeId, msg) => void })
  register(rtcSession, { browserSessionId, targetNodeId }): void
  send(signal, owner?: { uid, sid }): void      // owner.sid 必须等于登记的 browserSessionId
  subscribe(cb): () => void                     // node→browser，给 /mesh/ws 广播
  onLocal(rtcSession, cb): () => void           // 目标是 self 时交给 acceptBrowser
  receiveFromNode(fromNodeId, signal): void     // 只接受登记的 target node
}

// 分片
fragmentFrame(frameId: number, payload: Uint8Array): Uint8Array[]
class FrameReassembler { constructor(opts?: { timeoutMs?, maxInFlight?, now? }); push(chunk): Uint8Array | null }
```

常量：`SESS_CHANNEL_LABEL='sess'`、`PEER_CHANNEL_LABEL='peer'`、`RTC_AUTHORIZE_TTL_MS=120_000`、`FRAGMENT_PAYLOAD_SIZE=64KiB`、`DC_HIGH_WATER_BYTES=4MiB`、`DC_LOW_WATER_BYTES=1MiB`。

信令 SDP/candidate 编码：`sdp` 字段为 `JSON.stringify({type,sdp})`，`candidate` 为 `JSON.stringify({candidate,mid})`。空 candidate 不 `addRemoteCandidate`。

node↔node：字典序小的 nodeId 为 ICE offerer 且 LinkMux `initiator`。握手 JSON `{t:'hello'|'sig'}` 走裸 DC（hello 40ms 重传直到对端 hello），成功后再包 `DataChannelLink`。hello 带规范化指纹（小写算法 + 去冒号大写 hex）；比对前对 `remoteFingerprint()`（带冒号）做 `normalizeFingerprint`。

## 测试

`cd apps/gateway && bun test src/mesh/rtc`：

```
 30 pass
 0 fail
 99 expect() calls
Ran 30 tests across 7 files. [170.00ms]
```

覆盖：分片/乱序重组/超时/在途上限；Carrier 分片往返与背压；LinkMux over DC；屏障有序交付 + 过期 ACK + 直连断开切回；信号所有权；node↔node 握手 + mux；指纹不匹配拒绝；browser sess nonce 正/反。

集成（不自动发现；需 `TMEX_NATIVE_DIR` 指向含 `node_datachannel.node` 的目录）：

```
cd apps/gateway && bun test ./src/mesh/rtc/rtc-loopback.integration.ts
```

本机用 bun 缓存 addon 跑通：

```
 4 pass
 0 fail
 9 expect() calls
Ran 4 tests across 1 file. [182.00ms]
```

含：真 node-datachannel 的 node↔node LinkMux、指纹 mismatch（Proxy 掉 `remoteFingerprint`）、browser-style sess nonce、GatewaySession + fake primary 的 carrier switch。`TMEX_NATIVE_DIR` 未设时打印 `skipping rtc-loopback.integration.ts: TMEX_NATIVE_DIR is unset` 并 `describe.skipIf` native 组（carrier switch 组仍跑）。

## tsc / biome

| | 数量 |
|---|---|
| 任务基线 `apps/gateway` | 23 |
| 本次全量 | **24**（增量 1 条在 `src/auth/user-key-service.test.ts`，**非本 scope**） |
| `src/mesh/rtc/**` | **0** |

`bunx biome check apps/gateway/src/mesh/rtc`：**clean**。

## 协调者必须接的钩子

### 1. Assembler（`packages/app` runtime / `mesh-runtime.ts`）

```ts
import { loadNodeDatachannel } from 'packages/app/src/lib/native-datachannel'
import { MeshRtcSignalRouter, RtcPeerManager } from './mesh/rtc'

const rtc = new RtcPeerManager({
  loadNative: () => loadNodeDatachannel({ nativeDir: installLayout.nativeDir }),
  iceConfigProvider: () => lastRtc ?? { stun: [], turn: null },
  identity: { nodeId: identity.nodeIdHex, edSecretKey: identity.edPrivateKey },
  userStore,
  sendControl: (session, kind, payload) => gateway.wsServer.sendEnvelope(session, kind, payload),
  deliverInbound: (session, bytes) => gateway.wsServer.handleMessage(session, Buffer.from(bytes)),
})
await rtc.ready()
statusProvider().direct_capable = rtc.available

const signals = new MeshRtcSignalRouter({
  selfNodeId: identity.nodeIdHex,
  sendCtl(nodeId, msg) {
    // peer link ctl 优先，否则 uplink.sendCtl({ t:'rtc.signal', ...msg })
  },
})

// MeshHttpRuntime rtc:
rtc: { fingerprint: rtc, signals, config: { getRtcConfig: () => lastRtc } }
```

`authorizeBrowser` 成功后还要 `signals.register(rtcSession, { browserSessionId: sid, targetNodeId })`。目标为本机时 `signals.onLocal(rtcSession, …)` 接到 `rtc.acceptBrowser(rtcSession, signaling)`；成功后 `rtc.attachDirect(gatewaySession, carrier)`。`pc` 留给 B3-2 `createDataChannel('bulk:…')`。

### 2. `ws/index.ts` — sendControl 已基本够用

`WebSocketServer.sendEnvelope(session, kind, payload)` **已经是 public**。不必再包一层，assembler 直接传入即可。

仍需的小改（本任务不能动 `ws/**`）：

```ts
// handleBorshMessage 里：
if (kind === wsBorsh.KIND_CARRIER_SWITCH_ACK) {
  const { epoch } = wsBorsh.decodePayload(wsBorsh.schema.CarrierSwitchAckSchema, payload)
  rtc.handleCarrierSwitchAck(session, epoch)
  return
}
```

直连入站**不要**再走 `handleMessage`：`CarrierSwitchController.attachDirect` 已经 `carrier.onMessage → handleDirectInbound`，ACK 后经 `deliverInbound` 交给 `handleMessage`。直连 `onClose` 同样已接到 `handleDirectClose`（发 `to:'primary'`）。`handleCarrierClose` 对 active direct 只切回、不发 SWITCH——屏障补上这一帧。

### 3. `peer-manager.ts` `'dc'` 槽

B2-2a `DataChannelLinkSlot = { transport:'dc'; session: LinkSession | null }`。在 LAN 信令通、双方 `direct_capable` 时：

```ts
const { link, role, pc } = await rtc.connectToPeer(peerNodeId, {
  send: (msg) => ctlSend({ t: 'rtc.signal', ...msg }),
  onMessage: (cb) => ctlOnRtcSignal(cb),
})
const session = new LinkMux(link, { role })
slot.session = session
// 保留 pc 供 bulk
```

signaling 来源：peer 口 WS ctl 或 hub `rtc.signal`。`connectToPeer` 自己做 ICE + DC 握手，返回的 `DataChannelLink` 已过指纹校验，可直接交给 `LinkMux`。

当前 `PeerTransportKind` 含 `'dc'`。LAN 明文 WS mux（`ws-secure`）仍是现网路径；B3-1 只提供 DC 实现，切换由 PeerManager 后续接线。

### 4. `mesh/index.ts`

未 re-export `./rtc`。assembler 从 `apps/gateway/src/mesh/rtc` 直接 import。

### 5. `/api/rtc/authorize`

`mesh-routes.ts` **已经**调用 `rtc.fingerprint.authorizeBrowser({ rtcSession, uid, via, fpBrowser })` 并 `encodeBase64url(nonce)`。只要把 `RtcPeerManager` 实例注入 `rtc.fingerprint` 即可，**不必再改 routes**。

## 未做 / 注意

- **bulk:\*** 留给 B3-2；`connectToPeer` / `acceptBrowser` 返回的 `pc` 可 `createDataChannel`。
- gateway **不能**静态 import `packages/app`。`loadNative` 必须由 assembler 注入。集成测试用 `require(TMEX_NATIVE_DIR/node_datachannel.node)`，不走 C5-2 的 manifest sha256（那是生产 loader 的事）。
- hello 在 DC 上 40ms 重传，避免对端 `onMessage` 尚未挂上时首包丢失。
- ICE 单测用 FakePC（host 候选语义）；真 STUN 只在 `*.integration.ts`。
- 未碰生产 tmex、默认 tmux session `tmex`、`bun install`。
