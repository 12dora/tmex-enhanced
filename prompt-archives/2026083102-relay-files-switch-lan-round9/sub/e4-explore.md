# Task E4：LAN 直连可行性报告

## 结论

可以直连。当前代码存在三条路径：

| 路径 | 实际承载 | 是否需要 Hub |
|---|---|---|
| 节点↔节点 WebSocket | `ws-secure`，经 `TMEX_PEER_PORT` 直拨 | 首次地址通常来自 Hub；数据不经 Hub |
| 节点↔节点 WebRTC | `dc`，ICE host/STUN/TURN | 信令可经 Hub，媒体数据不经 Hub |
| 浏览器↔远程节点 | 浏览器 WebRTC `direct`，作为远程 Gateway WS 的第二载体 | 浏览器 REST/主 WS 仍连接 entry |

因此，`reach=lan` 不能证明使用了 WebRTC；它可能只是 LAN 上的 `ws-secure`。官方运维文档明确要求看 `transport === "dc"`。[docs/hub/2026082800-hub-node-operations.md:146](/Users/konata/code/tmex-enhanced-wt-r9/docs/hub/2026082800-hub-node-operations.md:146)

对于 `konata-mac`、`jiefa-app`、`jiefa-dns-1`，没有“必须经 Hub relay”的代码限制。实际阻塞点应在：节点是否广播了正确的 `ws://LAN_IP:39001/peer`、TCP 39001 是否可达、native DataChannel 是否启用、UDP 是否被防火墙/TUN/代理阻断，以及 Hub 是否继续转发 RTC 信令。

## 1. 节点↔节点直接连接

### 1.1 LAN WebSocket 直拨

节点自身地址不是通过 `/api/system/addresses` 生成的。

`enumeratePeerEndpoints()` 遍历 `os.networkInterfaces()`，排除 internal、IPv4 loopback、IPv6 link-local/multicast，然后生成：

```ts
const url = `ws://${host}:${port}/peer`;
```

[apps/gateway/src/mesh/mesh-runtime.ts:340](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/mesh-runtime.ts:340)  
[apps/gateway/src/mesh/mesh-runtime.ts:348](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/mesh-runtime.ts:348)

节点状态通过 `statusProvider()` 上报这些地址：

```ts
endpoints: enumeratePeerEndpoints(
  stores.peerHolder.manager?.listenPort ?? stores.config.peerPort,
  stores.interfacesFn()
)
```

[apps/gateway/src/mesh/mesh-runtime.ts:767](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/mesh-runtime.ts:767)

默认端口是 `39001`：

```ts
const value = (raw ?? '39001').trim() || '39001';
```

[apps/gateway/src/config.ts:89](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/config.ts:89)

PeerServer 默认绑定 `::` 与 `0.0.0.0`，监听 `/peer`；非 WebSocket 请求返回 `426 Upgrade Required`。[apps/gateway/src/mesh/peer-server.ts:105](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-server.ts:105)  
[apps/gateway/src/mesh/peer-server.ts:158](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-server.ts:158)

地址来源链路是：

```text
node.status.endpoints
  → Hub node.list / 已认证 peer link
  → userStore.peer.endpointsJson
  → PeerManager.dialWsSecure()
```

[apps/gateway/src/mesh/uplink-client.ts:297](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/uplink-client.ts:297)  
[apps/gateway/src/mesh/uplink-client.ts:571](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/uplink-client.ts:571)  
[apps/gateway/src/mesh/peer-manager.ts:1420](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:1420)

`PeerManager.dialDirect()` 使用缓存 URL 建立 WebSocket，等待时间为 `PEER_CONNECT_TIMEOUT_MS = 3000`，随后执行 `handshakeWsDirect()`。[apps/gateway/src/mesh/peer-manager.ts:58](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:58)  
[apps/gateway/src/mesh/peer-manager.ts:1433](/Users/konata/code/tmex-enhanced-wt-r9/apps/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:1433)

该路径不是裸明文业务流。`handshakeWsDirect()` 返回 `transport: 'ws-secure'`，内部是 `SecureChannelLink` + `LinkMux`。[apps/gateway/src/mesh/peer-protocol.ts:346](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-protocol.ts:346)

节点认证使用：

- `node_certs` 中的 Ed25519 公钥；
- `buildPeerTranscript(path, helloA, helloB)`；
- `signTranscript()` / `verifyTranscript()`；
- X25519 派生 SecureChannel AES-GCM 密钥。

[apps/gateway/src/mesh/peer-protocol.ts:181](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-protocol.ts:181)  
[packages/shared/src/auth/peer-handshake.ts:14](/Users/konata/code/tmex-enhanced-wt-r9/packages/shared/src/auth/peer-handshake.ts:14)  
[packages/shared/src/auth/peer-handshake.ts:60](/Users/konata/code/tmex-enhanced-wt-r9/packages/shared/src/auth/peer-handshake.ts:60)

### 1.2 节点↔节点 WebRTC DataChannel

`RtcPeerManager.connectToPeer()` 使用 native `node-datachannel`：

```ts
const offerer = self < peer;
const role = offerer ? 'offerer' : 'answerer';
```

因此，node ID 字典序较小的一侧产生 offer。[apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:253](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:253)

连接过程：

1. 创建 `PeerConnection`；
2. offerer 创建 `peer` DataChannel；
3. 交换 SDP；
4. 交换 ICE candidates；
5. 等待 DataChannel；
6. 执行 `handshakeDataChannel()`；
7. 校验节点证书签名和 DTLS fingerprint；
8. 创建 `DataChannelLink`，记录 `transport='dc'`。

[apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:268](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:268)  
[apps/gateway/src/mesh/rtc/dc-handshake.ts:256](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/rtc/dc-handshake.ts:256)

RTC session 格式为：

```ts
return `dc:${lo}:${hi}`;
```

[apps/gateway/src/mesh/rtc/ice.ts:188](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/rtc/ice.ts:188)

信令发送逻辑：

```ts
if (live && live.transport !== 'dc') {
  this.sendPeerCtl(live, payload);
  return;
}
this.ensureDcSession?.(peerNodeId, msg.rtcSession);
this.uplink.sendCtl(payload);
```

[apps/gateway/src/mesh/peer-manager.ts:1220](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:1220)

含义：

- 已有 `ws-secure` 或 `relay` peer link：RTC 信令走该 link 的 `ctl`；
- 没有可用 peer link，或当前已是 `dc`：通过 Hub uplink 发送；
- `rtc.signal` 是明确支持的 Hub uplink 类型。

[apps/gateway/src/mesh/uplink-client.ts:513](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/uplink-client.ts:513)

Hub 对节点间 RTC 有专门逻辑，不是“只支持 Hub↔node”：

```ts
const dc = parseDcPeerSession(msg.rtcSession);
if (dc) {
  this.forwardDcSignal(live, msg, dc);
  return;
}
```

[apps/gateway/src/hub/uplink-server.ts:864](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/hub/uplink-server.ts:864)

`forwardDcSignal()` 要求发送方和目标是同一用户的两个已登记节点，然后把信令发给另一侧。[apps/gateway/src/hub/uplink-server.ts:890](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/hub/uplink-server.ts:890)

较大 node ID 一侧负责发送签名 `rtc.wake`，唤醒较小 ID 一侧开始 `getLink()`：

```ts
if (this.identity.nodeId.toLowerCase() < peerNodeId.toLowerCase()) return;
```

[apps/gateway/src/mesh/peer-manager.ts:1091](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:1091)

### 1.3 ICE 配置、STUN、TURN

native ICE 配置最终只包含：

```ts
return { iceServers: collectIceServers(cfg) };
```

[apps/gateway/src/mesh/rtc/ice.ts:136](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/rtc/ice.ts:136)

虽然 `RtcIceConfig` 类型定义了 `enableIceUdpMux`、`bindAddress` 等字段，但当前 `buildRtcIceConfig()` 没有设置它们。[apps/gateway/src/mesh/rtc/native.ts:21](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/rtc/native.ts:21)

运行时配置：

- `TMEX_STUN_SERVERS`：逗号分隔；
- `TMEX_TURN_URL`；
- `TMEX_TURN_USERNAME`；
- `TMEX_TURN_CREDENTIAL`。

[apps/gateway/src/config.ts:199](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/config.ts:199)

TURN 只有三项同时存在才会下发。[apps/gateway/src/mesh/mesh-runtime.ts:392](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/mesh-runtime.ts:392)

安装器写入的 STUN 默认值是 Google：

```ts
export const DEFAULT_STUN_SERVERS = 'stun:stun.l.google.com:19302';
```

[packages/app/src/lib/roles.ts:13](/Users/konata/code/tmex-enhanced-wt-r9/packages/app/src/lib/roles.ts:13)

但 gateway 的 `parseStunServers(undefined)` 返回空数组。[apps/gateway/src/config.ts:101](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/config.ts:101)  
所以实际生产值取决于 `app.env` 是否由安装器写入。

同 LAN 的 host↔host 连接不需要 STUN；浏览器控制器也明确写着：

```ts
// ICE 配置拿不到时仍尝试建连（同内网 host 候选不需要 STUN）
```

[packages/ws-client/src/direct/direct-carrier-controller.ts:526](/Users/konata/code/tmex-enhanced-wt-r9/packages/ws-client/src/direct/direct-carrier-controller.ts:526)

仓库没有显式的 `iceTransportPolicy`、mDNS 开关或 host candidate 禁用逻辑。能确认的是 host candidates 没有被应用层过滤；具体 native/browser 库是否对 host 地址使用 mDNS，由底层实现决定。架构文档中的“无 mDNS”指节点发现，不是明确的 ICE mDNS 配置。[docs/hub/2026082700-hub-node-architecture.md:36](/Users/konata/code/tmex-enhanced-wt-r9/docs/hub/2026082700-hub-node-architecture.md:36)

## 2. 连接选择、降级和 LAN upgrade

传输优先级：

```ts
dc: 3
ws-secure: 2
relay: 1
```

[apps/gateway/src/mesh/peer-manager.ts:86](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:86)

`shouldTryDc()` 的实际条件只有：

```ts
if (!this.rtc?.available) return false;
if (peer && peer.directCapable === false) return false;
return true;
```

[apps/gateway/src/mesh/peer-manager.ts:843](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:843)

没有 node/hub 角色判断。

`dial()` 的顺序是：

1. 尝试 `dc`；
2. 尝试缓存 endpoint 的 `ws-secure`；
3. 复用现有 link；
4. 最后通过 Hub `openRelay()` 建立 `relay`。

[apps/gateway/src/mesh/peer-manager.ts:1303](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:1303)

DC 或 WebSocket 失败不会阻止 relay fallback：

```ts
const stream = await this.uplink.openRelay(nodeId);
```

[apps/gateway/src/mesh/peer-manager.ts:1364](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:1364)

当已有 relay/ws link 时，`maybeUpgrade()` 才会尝试更高优先级链路；它要求链路支持 quiesce，并受 `PEER_UPGRADE_COOLDOWN_MS=10s`、`PEER_UPGRADE_SCAN_MS=15s` 限制。[apps/gateway/src/mesh/peer-manager.ts:781](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:781)

地址变化会触发 upgrade：

```ts
notifyPeerEndpointsChanged(nodeId)
```

[apps/gateway/src/mesh/mesh-runtime.ts:810](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/mesh-runtime.ts:810)

但已有节点↔节点 stream 不会自动迁移到新 DC；文档明确说明只有新 stream 才会走新传输。[docs/hub/2026082800-hub-node-operations.md:148](/Users/konata/code/tmex-enhanced-wt-r9/docs/hub/2026082800-hub-node-operations.md:148)

## 3. `reach`、`transport`、`rttMs`

### 3.1 reach 分类

核心函数：

```ts
if (transport == null) return null;
if (transport === 'relay') return 'relay';
return classifyRemoteAddress(remoteAddress);
```

[apps/gateway/src/mesh/address-class.ts:26](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/address-class.ts:26)

私有地址包括：

- `127.0.0.0/8`；
- `10.0.0.0/8`；
- `192.168.0.0/16`；
- `172.16.0.0/12`；
- `169.254.0.0/16`；
- IPv6 `fe80::/10`、`fc00::/7`。

[apps/gateway/src/mesh/address-class.ts:39](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/address-class.ts:39)  
[apps/gateway/src/mesh/address-class.ts:89](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/address-class.ts:89)

缺少远端地址证据时默认是 `wan`，不是 `lan`。[apps/gateway/src/mesh/address-class.ts:35](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/address-class.ts:35)

远端地址来源：

- `ws-secure`：缓存 URL 的 host，`hostFromWsUrl(url)`；
- `dc`：选中的 ICE pair 的 `remote.address` 或 candidate；
- `relay`：直接强制 `relay`。

[apps/gateway/src/mesh/peer-manager.ts:1275](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:1275)  
[apps/gateway/src/mesh/peer-manager.ts:1462](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:1462)

### 3.2 transport 和 RTT

`emitLinkInfo()` 设置：

```ts
reach: classifyPeerReach(live.transport, live.remoteAddress),
transport: live.transport,
rttMs: live.rttMs,
```

[apps/gateway/src/mesh/peer-manager.ts:1907](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:1907)

节点间 RTT 来自每 15 秒一次的 ping/pong；连续 3 次无 pong 会丢弃 peer。[apps/gateway/src/mesh/peer-manager.ts:1884](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:1884)

浏览器直连 RTT 则来自 `RTCPeerConnection.getStats()` 的选中 candidate pair。[packages/ws-client/src/direct/direct-carrier-controller.ts:949](/Users/konata/code/tmex-enhanced-wt-r9/packages/ws-client/src/direct/direct-carrier-controller.ts:949)

浏览器路径映射：

- `host → host`：`lan` 或 `v6`；
- 任一 `relay`：`turn`；
- `srflx/prflx`：`v4-p2p` 或 `v6`。

[packages/ws-client/src/direct/ice-stats.ts:78](/Users/konata/code/tmex-enhanced-wt-r9/packages/ws-client/src/direct/ice-stats.ts:78)

## 4. 浏览器打开远程终端时的实际路径

浏览器不会使用远程节点的 LAN IP 建立 HTTP 或主 WebSocket。

`nodeWsUrl()` 明确生成：

```ts
self → /ws
remote → /n/<id>/ws
```

并使用当前页面的 host。[packages/api-client/src/node-url.ts:113](/Users/konata/code/tmex-enhanced-wt-r9/packages/api-client/src/node-url.ts:113)

`createNodeConnection()` 对非 `self` 节点创建：

1. 主 Gateway WS：`/n/<nodeId>/ws`；
2. `DirectCarrierController`；
3. `/mesh/ws` 上的 RTC 信令；
4. `connection.directDiagnostics`。

[apps/fe/src/node/node-runtimes.ts:191](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/node-runtimes.ts:191)

entry 收到 `/n/:id/ws` 后：

```ts
const link = await this.deps.peers.getLink(nodeId);
const stream = await this.deps.streams.openWsStream(link, auth, cid);
```

[apps/gateway/src/mesh/forwarder.ts:552](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/forwarder.ts:552)

因此主路径是：

```text
浏览器
  → entry Gateway WS
  → entry PeerManager 到远程 node 的 link
     → dc / ws-secure / relay
  → 远程 node GatewaySession
```

远程 node 侧用 `acceptWsStream()` 将 peer stream 包装为 `LinkStreamCarrier`，挂到新的 `GatewaySession`。[apps/gateway/src/mesh/stream-targets.ts:475](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/stream-targets.ts:475)

浏览器 WebRTC 成功后，DataChannel 只是该 Gateway WS 的第二 carrier。只有 `CARRIER_SWITCH{to:'direct'}` 发送、浏览器 ACK 后才变成 active。[apps/gateway/src/mesh/rtc/carrier-switch.ts:61](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/rtc/carrier-switch.ts:61)  
[packages/ws-client/src/client.ts:497](/Users/konata/code/tmex-enhanced-wt-r9/packages/ws-client/src/client.ts:497)

### `/api/mesh-internal/tmux/*`

这些不是浏览器终端主 WS 路径，而是 server-side 的远程 pane RPC：

- `RemotePaneRuntime.sendInput()` → `/api/mesh-internal/tmux/send-input`；
- `capturePaneText()` → `/api/mesh-internal/tmux/capture`；
- `getPaneInfo()` → `/api/mesh-internal/tmux/pane-info`。

[apps/gateway/src/agent/remote-pane-runtime.ts:27](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/agent/remote-pane-runtime.ts:27)

`forwardInternalHttp()` 通过 `peers.getLink(nodeId)` 和 `openHttpStream()` 转发。[apps/gateway/src/mesh/forwarder.ts:218](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/forwarder.ts:218)

目标侧必须有 mesh peer marker；否则返回 `403`。[apps/gateway/src/mesh/mesh-internal-tmux-routes.ts:40](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/mesh-internal-tmux-routes.ts:40)

公开的 `/n/<id>/api/mesh-internal/*` 会被 entry 明确拒绝：

```ts
if (parsed.rest.startsWith('/api/mesh-internal')) {
  return jsonError('FORBIDDEN', 403);
}
```

[apps/gateway/src/mesh/forwarder.ts:141](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/forwarder.ts:141)

### failover

entry 保持浏览器 WS 不变，重新在当前最优 peer link 上打开 WS stream，重放 HELLO、device、pane subscription，并记录：

```text
[mesh][stream] failover stream=... from=dc to=relay|ws-secure ...
```

[apps/gateway/src/mesh/forwarder.ts:301](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/forwarder.ts:301)  
[apps/gateway/src/mesh/forwarder.ts:373](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/forwarder.ts:373)

## 5. 本拓扑的已验证阻塞条件

1. **TCP 39001 不可达或监听在 loopback**  
   `TMEX_PEER_PORT` 默认 `39001`；`TMEX_PEER_BIND_HOST` 默认 `::,0.0.0.0`。`TMEX_BIND_HOST` 只影响 Gateway HTTP，不控制 peer 口。[apps/gateway/src/mesh/mesh-runtime.ts:383](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/mesh-runtime.ts:383)

2. **节点没有广播正确 LAN endpoint**  
   当前广播值来自 `os.networkInterfaces()`，不是 `/api/system/addresses`。后者只返回 Gateway 的 `config.port`，通常是 `9883`。[apps/gateway/src/system/access-addresses.ts:40](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/system/access-addresses.ts:40)

3. **native DataChannel 未启用**  
   `TMEX_DIRECT_ENABLED=false`、缺少 `TMEX_NATIVE_DIR`、addon/manifest 缺失或校验失败，都会使 `loadNative()` 返回 `null`，从而 `direct_capable=false`。[packages/app/src/runtime/assemble.ts:453](/Users/konata/code/tmex-enhanced-wt-r9/packages/app/src/runtime/assemble.ts:453)  
   [packages/app/src/lib/native-datachannel.ts:111](/Users/konata/code/tmex-enhanced-wt-r9/packages/app/src/lib/native-datachannel.ts:111)

4. **UDP 被防火墙、Surge/TUN 或网络策略阻断**  
   当前 native ICE 没有配置固定 UDP 端口范围；必须由操作系统/网络允许 native ICE 使用的 UDP。文档明确记录 macOS TUN 会吞掉 UDP，且 node-datachannel/libjuice 当前不支持 TURN TCP/TLS relay。[docs/hub/2026082800-hub-node-operations.md:299](/Users/konata/code/tmex-enhanced-wt-r9/docs/hub/2026082800-hub-node-operations.md:299)

5. **STUN 在中国大陆不可达**  
   历史 E2E 已记录 Google STUN 不可达，改用 `stun.miwifi.com`。[prompt-archives/2026082801-hub-docker-e2e-multi-theme/plan-00-result.md:78](/Users/konata/code/tmex-enhanced-wt-r9/prompt-archives/2026082801-hub-docker-e2e-multi-theme/plan-00-result.md:78)  
   但同 LAN host↔host 不应依赖 STUN。

6. **节点未被同一用户的证书链信任**  
   Hub `forwardDcSignal()` 要求两个 node certificate 都属于同一用户且未吊销。[apps/gateway/src/hub/uplink-server.ts:1057](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/hub/uplink-server.ts:1057)

7. **只观察 `reach=lan` 或 `direct_capable=true`**  
   `reach=lan` 可能来自 `ws-secure`；`direct_capable=true` 只代表 native 可尝试，不代表 ICE 成功。[docs/hub/2026082800-hub-node-operations.md:146](/Users/konata/code/tmex-enhanced-wt-r9/docs/hub/2026082800-hub-node-operations.md:146)

当前代码已经修复历史上的“较大 ID 侧不会唤醒 offerer”问题，增加了签名 `rtc.wake`。历史结果确认：有入站 UDP 的机器可建立 `transport=dc`；UDP 被过滤的机器只能 relay。[prompt-archives/2026082802-hub-live-e2e/plan-00-result.md:9](/Users/konata/code/tmex-enhanced-wt-r9/prompt-archives/2026082802-hub-live-e2e/plan-00-result.md:9)  
[prompt-archives/2026082802-hub-live-e2e/plan-00-result.md:38](/Users/konata/code/tmex-enhanced-wt-r9/prompt-archives/2026082802-hub-live-e2e/plan-00-result.md:38)

## 6. 配置和状态字段清单

### 环境变量

- `TMEX_ROLES`：`node` 或 `hub,node`；
- `TMEX_HUB_URL`；
- `TMEX_HUB_PUBLIC_URL`；
- `TMEX_PEER_PORT`，默认 `39001`；
- `TMEX_PEER_BIND_HOST`，默认 `::,0.0.0.0`；
- `TMEX_STUN_SERVERS`；
- `TMEX_TURN_URL`；
- `TMEX_TURN_USERNAME`；
- `TMEX_TURN_CREDENTIAL`；
- `TMEX_NATIVE_DIR`；
- `TMEX_DIRECT_ENABLED`；
- `RTC_LIVENESS_INTERVAL_MS`，默认 `3000`；
- `RTC_LIVENESS_TIMEOUT_MS`，默认 `10000`；
- `UPLINK_CONNECT_TIMEOUT_MS`，默认 `20000`；
- 相关但不控制 RTC：`GATEWAY_PORT`、`TMEX_BIND_HOST`、`TMEX_BASE_URL`、`TMEX_TRUST_PROXY`。

`TMEX_RTC_*` 在运行时代码中不存在；RTC 相关环境变量实际是上面的 `RTC_LIVENESS_*`。E2E 专用的 `TMEX_E2E_STUN_SERVERS` 不是生产运行时配置。[docs/hub/2026082801-hub-docker-e2e.md:153](/Users/konata/code/tmex-enhanced-wt-r9/docs/hub/2026082801-hub-docker-e2e.md:153)

### API/UI 状态

`GET /api/mesh/nodes` 返回：

```ts
id, online, reach, transport, rttMs, direct_capable, isHub
```

[apps/gateway/src/mesh/node-list-projection.ts:13](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/node-list-projection.ts:13)

`GET /api/local/status` 返回：

```ts
direct: {
  supported,
  installed,
  enabled,
  capable,
  version,
  platform
}
```

[packages/api-client/src/local/types.ts:5](/Users/konata/code/tmex-enhanced-wt-r9/packages/api-client/src/local/types.ts:5)

设备页诊断使用的准确 i18n keys：

- `nodes.reach.lan` / `.wan` / `.relay` / `.none`
- `nodes.badge.direct`
- `nodes.badge.transportWs` / `.transportDc` / `.transportRelay`
- `nodes.badge.iceTitle`
- `nodes.badge.reachRow` / `.transportRow`
- `nodes.badge.connectionState` / `.iceState`
- `nodes.badge.localCandidate` / `.remoteCandidate` / `.selectedPair`
- `nodes.badge.icePlaceholder`

[apps/fe/src/node/device-node-badges.tsx:15](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/device-node-badges.tsx:15)  
[apps/fe/src/node/device-node-badges.tsx:147](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/device-node-badges.tsx:147)

注意：前端 `DirectDiagnostics` 暴露 ICE 状态、candidate 类型、选中 pair 和 RTT，但不暴露控制器内部的 `failureReason`。[packages/ws-client/src/direct/types.ts:27](/Users/konata/code/tmex-enhanced-wt-r9/packages/ws-client/src/direct/types.ts:27)

## 7. 只读诊断步骤

以下命令由运维人员在 live 节点执行；本次未连接生产实例、未运行服务/测试，也未执行任何 tmux 命令。

### 7.1 检查运行时和 Mesh 状态

使用现有登录 cookie，不要把 cookie 写入共享日志：

```bash
COOKIE='Cookie: tmex_s_self=<当前入口会话>'
BASE='https://<entry-host>:9883'

curl -fsS -H "$COOKIE" "$BASE/api/local/status" | jq '.direct'
curl -fsS -H "$COOKIE" "$BASE/api/mesh/nodes" |
  jq '.nodes[] | {id,online,reach,transport,rttMs,direct_capable,isHub}'
curl -fsS -H "$COOKIE" "$BASE/api/mesh/rtc-config" | jq .
curl -fsS -H "$COOKIE" "$BASE/api/system/addresses" | jq .
```

重点：

- `direct.capable=true`；
- 目标节点 `direct_capable=true`；
- 目标 `transport` 是否为 `dc`；
- `/api/system/addresses.port` 是 Gateway 端口，不是 peer 端口；
- `/api/mesh/nodes` 和 `/api/hub/nodes` 都不会直接返回 `endpoints`，endpoint 需要从节点状态/日志链路确认。[apps/gateway/src/hub/hub-runtime.ts:244](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/hub/hub-runtime.ts:244)

### 7.2 检查 TCP peer 口

从每台机器分别检查另外两台：

```bash
nc -vz -w 3 10.110.88.3 39001
nc -vz -w 3 10.110.88.5 39001
curl --noproxy '*' -i --max-time 3 http://10.110.88.3:39001/peer
```

若端口监听正常但未发送 WebSocket Upgrade，第二条应返回 `426 Upgrade Required`。[apps/gateway/src/mesh/peer-server.ts:164](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-server.ts:164)

### 7.3 检查日志

在 macOS 使用系统日志，在 Linux 使用实际服务日志单元：

```bash
log show --last 15m --style compact \
  --predicate 'eventMessage CONTAINS "[mesh][rtc]" OR eventMessage CONTAINS "[uplink]"'

journalctl -u <实际-tmex-unit> --since '15 min ago' |
  grep -E '\[mesh\]\[rtc\]|\[mesh\]\[stream\]|\[uplink\]'
```

期望看到：

```text
[mesh][rtc] dial start role=offerer|answerer
[mesh][rtc] signal send/recv kind=sdp
[mesh][rtc] signal ... kind=candidate
[mesh][rtc] ice ...
[mesh][rtc] selected pair ...
[mesh][rtc] datachannel open ...
```

较大 node ID 一侧还应出现 `kind=wake`。失败时重点看：

```text
[mesh][rtc] dial failed ...
[mesh][rtc] ice failed local_types=... remote_types=...
[mesh][rtc] liveness timeout peer=... idle_ms=...
```

文档给出的判断规则是：

- 没有 `dial start`：该次没有真正拨号；
- 只有 answerer、没有 wake/offer：信令唤醒链路异常；
- candidate 只有 `host` 且没有 `srflx`：STUN 没有产生 server-reflexive candidate；
- 两侧有 `srflx` 仍失败：需要检查 NAT/TURN；
- `datachannel open` 才能证明建立了 DC。[docs/hub/2026082800-hub-node-operations.md:272](/Users/konata/code/tmex-enhanced-wt-r9/docs/hub/2026082800-hub-node-operations.md:272)

不要采集或分享完整 SDP、ICE password 或 session cookie。

### 7.4 检查 UDP

只读检查网卡和路由：

```bash
ifconfig
ip -4 -o addr
ip route get 10.110.88.5
```

在有权限的情况下抓取 UDP 包，观察建立 RTC 时是否有流量：

```bash
sudo tcpdump -ni <LAN-interface> udp
```

macOS 侧同时确认 Surge/TUN 是否接管该流量；仓库文档把 macOS TUN 吞 UDP 列为已知直连障碍。[docs/hub/2026082800-hub-node-operations.md:300](/Users/konata/code/tmex-enhanced-wt-r9/docs/hub/2026082800-hub-node-operations.md:300)

## 8. 启用这里的 LAN direct 的变更优先级

1. **先做运维配置，不改代码**  
   确认三台节点的 `TMEX_PEER_PORT=39001`、`TMEX_PEER_BIND_HOST=0.0.0.0`，放行 LAN TCP 39001；确认 native addon 存在且 `direct.capable=true`；允许 LAN UDP。风险最低。

2. **确保生产安装器启用 native addon**  
   使用现有 `direct enable`/设置页，使 `TMEX_DIRECT_ENABLED=true`、`TMEX_NATIVE_DIR` 指向正确安装目录。涉及 `packages/app/src/runtime/assemble.ts`、`packages/app/src/lib/native-datachannel.ts`。风险是平台 addon 版本、N-API 或动态库加载失败。

3. **若状态中 endpoint 缺失，再修 endpoint 可见性**  
   检查 `apps/gateway/src/mesh/mesh-runtime.ts`、`peer-server.ts`、`peer-manager.ts`、`uplink-server.ts` 的 endpoint 生成、上报、缓存和刷新。风险是广播错误地址或泄露不应公开的接口地址。

4. **为 native ICE 增加显式 UDP bind/端口配置**  
   当前 `RtcIceConfig` 虽有 `bindAddress` 等字段，但没有接入环境配置。可修改 `apps/gateway/src/config.ts`、`apps/gateway/src/mesh/rtc/ice.ts`、`rtc/native.ts`。同 LAN 当前不一定需要此改动；风险较高，可能影响 node-datachannel 跨平台行为。

5. **替换或补充大陆可达的 STUN/TURN**  
   设置 `TMEX_STUN_SERVERS`；跨 NAT 时提供 UDP 可达 TURN，并填写三个 `TMEX_TURN_*`。不要依赖当前文档记录中不工作的 TURN TCP/TLS 路径。风险是外部服务可用性和 TURN 流量成本。

6. **补充诊断 API，区分“LAN WS”和“LAN DC”**  
   在 gateway/FE 增加 endpoint 摘要、ICE failure reason、candidate 类型和 selected pair 的只读诊断；涉及 `mesh-routes.ts`、`rtc-peer-manager.ts`、`rtc-log.ts`、`direct-diagnostics.ts`、`device-node-badges.tsx`。风险是地址/ICE 元数据暴露，应继续掩码。

