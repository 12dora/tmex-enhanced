# RTC 跨 NAT 直连路径排查报告

## 结论

当前最可能的首要问题不是 STUN 配置，而是 RTC offerer 的启动机制：

- `PeerManager.getLink()` 只会在业务请求所在节点触发。
- `RtcPeerManager.connectToPeer()` 又要求较小 node ID 的一方作为 offerer。
- 如果场景 D 中 `node-a > hubNodeId`，则只有 `node-a` 调用了 `getLink()`，但它被选为 answerer，只会等待 DataChannel，不会发送第一条 SDP。
- hub 节点不会因为 `direct_capable=true` 或收到 `node.list` 就主动创建 offer。
- 因此两端可能没有任何 `rtc.signal`，15 秒后 `dial()` 静默回退到 WS 或 hub relay。

此外，当前代码几乎没有 RTC/ICE 日志，因此“没有诊断日志”本身是代码现状，不能证明 RTC 没有被尝试。

---

## 1. 预期生命周期

### 1.1 启动时加载 native module

`assembleTmex()` 只在包含 `node` role 时创建 mesh，并根据 `TMEX_NATIVE_DIR` 创建 native loader：

- [`packages/app/src/runtime/assemble.ts:109`](file:///Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/runtime/assemble.ts:109)，119–146 行

```ts
const nativeDir = opts.nativeDir ?? process.env.TMEX_NATIVE_DIR ?? '';
const loadNative =
  opts.loadNative ??
  (async () => {
    if (!nativeDir) return null;
    return loadNodeDatachannel({ nativeDir });
  });
```

`RtcPeerManager` 构造时只执行一次加载：

- [`apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:182`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:182)，205–218 行

```ts
this.loadPromise = this.loadNative().then((mod) => {
  this.native = mod;
  return mod;
});
```

`available` 只是 `native !== null`：

```ts
get available(): boolean {
  return this.native !== null;
}
```

所以 `direct enable` 只写入：

```text
<installDir>/native/node_datachannel.node
<installDir>/native/manifest.json
```

见 [`packages/app/src/commands/direct.ts:55`](file:///Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/direct.ts:55)，95–107 行。运行中的进程不会重新扫描目录，必须重启。

场景 D 已经显式重启 node-a 和 hub：

- [`scripts/hub-e2e/split/run.sh:800`](file:///Users/konata/code/tmex-enhanced-wt-merge/scripts/hub-e2e/split/run.sh:800)

因此如果重启后的 `direct_capable=true`，native module 加载本身不是当前 D 的首要嫌疑。

### 1.2 direct_capable 的传播和 gating

本地状态通过 `statusProvider()` 广播：

- [`apps/gateway/src/mesh/mesh-runtime.ts:743`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-runtime.ts:743)，749 行

```ts
direct_capable: rtc.available
```

hub 构造 `node.list` 时把在线节点的 `direct_capable` 放进去：

- [`apps/gateway/src/hub/uplink-server.ts:1092`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-server.ts:1092)，1102–1110 行

远端收到后持久化到 peer store，并由 `shouldTryDc()` 使用：

- [`apps/gateway/src/mesh/peer-manager.ts:646`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:646)

```ts
private shouldTryDc(nodeId: string): boolean {
  if (!this.rtc?.available) return false;
  const peer = this.userStore.listPeers().find((row) => row.nodeId === nodeId);
  if (peer && peer.directCapable === false) return false;
  return true;
}
```

因此 `direct_capable=true` 的含义是“允许尝试 DC”，不是“已经建立 DC”。

### 1.3 谁触发拨号

业务请求触发 `PeerManager.getLink()`：

- HTTP：[`apps/gateway/src/mesh/forwarder.ts:162`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/forwarder.ts:162)，168–184 行
- WebSocket：[`apps/gateway/src/mesh/forwarder.ts:206`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/forwarder.ts:206)，221–230 行

```ts
link = await this.deps.peers.getLink(nodeId);
```

没有现有连接时，`getLink()` 创建 `dial()`：

- [`apps/gateway/src/mesh/peer-manager.ts:411`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:411)，414–422 行

```ts
const existing = this.live.get(nodeId);
if (existing) {
  this.maybeUpgrade(nodeId, { cooldown: true, userPath: true });
  return existing.session;
}

const attempt = this.dial(nodeId);
```

`dial()` 的顺序实际是：

1. DataChannel；
2. peer-port WebSocket secure；
3. hub relay。

- [`apps/gateway/src/mesh/peer-manager.ts:748`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:748)，762–807 行

```ts
if (PEER_TRANSPORT_RANK.dc > floor && this.shouldTryDc(nodeId)) {
  try {
    const dc = await this.dialDc(nodeId, gen, signal);
    if (dc) return dc;
  } catch (err) {
    throwIfStopped(err);
  }
}

if (PEER_TRANSPORT_RANK['ws-secure'] > floor) {
  const ws = await this.dialWsSecure(nodeId, gen, signal);
  if (ws) return ws;
}

// 最后才是 relay
const stream = await this.uplink.openRelay(nodeId);
```

所以“upgrade 只尝试 LAN WS、不尝试 RTC”与当前代码不符。升级路径是：

```text
maybeUpgrade()
  → queueUpgrade()
  → runUpgradeDial()
  → dial()
  → dialDc()
```

见 [`peer-manager.ts:588`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:588)，612–638 行。

已有 relay link 也会尝试 RTC：

```ts
const floor = existingLive ? PEER_TRANSPORT_RANK[existingLive.transport] : 0;
```

relay 的 rank 是 1，DC 的 rank 是 3，因此 relay → DC 是合法升级。

但已有连接时，`getLink()` 不等待升级完成，而是立即返回旧 link。这会导致新 stream 仍然使用 relay：

```ts
if (existing) {
  this.maybeUpgrade(...);
  return existing.session;
}
```

场景 D 如果复用了已有 relay，必须等待 `transport === 'dc'` 后再创建需要验证路径的 stream。

### 1.4 RTC offerer / answerer

RTC 角色由 node ID 的字典序决定：

- [`apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:253`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:253)，256–268 行

```ts
const self = this.identity.nodeId.toLowerCase();
const peer = peerNodeId.toLowerCase();
const offerer = self < peer;
```

offerer 创建 DataChannel：

```ts
const channelP = offerer
  ? Promise.resolve(pc.createDataChannel(PEER_CHANNEL_LABEL))
  : waitDataChannel(pc, this.handshakeTimeoutMs);
```

answerer 不创建 offer，也不主动发送第一条信令，只等待远端 DataChannel。

这就形成了确定性的单向触发问题：

```text
node-a 业务请求
  → node-a.getLink(hub)
  → node-a.connectToPeer(hub)
```

如果：

```text
node-a ID > hub ID
```

那么 node-a 是 answerer。它等待 hub 的 offer，但 hub 没有业务请求，也没有其他机制主动执行 `hub.getLink(node-a)`。

这就是最符合“没有 rtc.signal、没有 RTC 日志、最后走 relay”的代码级原因。

in-process 测试没有覆盖该单向场景：

- [`apps/gateway/src/mesh/integration/direct-path.integration.test.ts:886`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/integration/direct-path.integration.test.ts:886)

```ts
const [linkA, linkB] = await Promise.all([
  meshA.peers.getLink(meshB.nodeId),
  meshB.peers.getLink(meshA.nodeId),
]);
```

测试两端同时调用 `getLink()`，因此无论哪边是 offerer 都能启动。

---

## 2. 信令路径和 hub 自身路由

### 2.1 节点 RTC 信令

本地 PeerConnection 生成 SDP 或 candidate 后，`bindSignaling()` 发送：

- [`apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:506`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:506)，512–538 行

```ts
signaling.send({
  rtcSession,
  from: 'node',
  to,
  sdp: encodeSdpSignal({ type, sdp }),
});
```

`PeerManager.sendRtcSignal()` 包装成 `rtc.signal`：

- [`apps/gateway/src/mesh/peer-manager.ts:676`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:676)，676–695 行

如果已有 relay 或 WS secure link，信令走该 link 的 control channel；否则走 node 到 hub 的 uplink：

```ts
if (live && live.transport !== 'dc') {
  this.sendPeerCtl(live, payload);
  return;
}

this.uplink.sendCtl(payload);
```

### 2.2 hub 转发

对于 node↔node 信令，hub 根据：

```text
dc:<较小 node ID>:<较大 node ID>
```

识别目标：

- [`apps/gateway/src/hub/uplink-server.ts:917`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-server.ts:917)，922–930 行

```ts
const other = live.nodeId === dc.a ? dc.b : dc.a;
if (msg.to !== other) return;

const target = this.registry.get(msg.to);
if (!target?.authenticated || target.userId !== live.userId) return;

this.send(target.link, msg);
```

对于 node↔hub-node，hub 自身作为 node 的 uplink 是通过内存 link 注册到嵌入式 `HubRuntime`：

- [`apps/gateway/src/mesh/mesh-runtime.ts:1211`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-runtime.ts:1211)，1226–1233 行
- [`apps/gateway/src/hub/hub-runtime.ts:144`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/hub-runtime.ts:144)

```ts
target.attachLocalNode(hubLink);
```

因此正常启动时 hub 自己应当存在于 hub 的 registry 中。当前没有发现 node↔hub-node 信令被“目标是 hub 自身”错误短路的问题。

需要区分浏览器信令的 self-routing：

- `MeshRtcSignalRouter` 的本机短路逻辑只服务 browser→node；
- node↔node 的信令使用 `PeerManager.sendRtcSignal()` 和 `UplinkServer.forwardDcSignal()`。

如果 sender 端已经出现 `rtc.signal`，但 hub 端完全没有收到，则应检查 `registry.get(msg.to)`。当前该分支没有日志，目标不存在时直接 return：

```ts
if (!target?.authenticated || target.userId !== live.userId) return;
```

---

## 3. STUN / TURN 配置链路

### 3.1 STUN

环境变量解析：

- [`apps/gateway/src/config.ts:105`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/config.ts:105)，179–187 行

```ts
stunServers: parseStunServers(process.env.TMEX_STUN_SERVERS),
```

split harness 的 `TMEX_E2E_STUN_SERVERS` 被 entrypoint 写入 `TMEX_STUN_SERVERS`：

- [`scripts/hub-e2e/entrypoint.sh:48`](file:///Users/konata/code/tmex-enhanced-wt-merge/scripts/hub-e2e/entrypoint.sh:48)，61 行

```sh
TMEX_STUN_SERVERS=${TMEX_E2E_STUN_SERVERS:-stun:stun.l.google.com:19302}
```

mesh runtime 将其放入 RTC 配置：

- [`apps/gateway/src/mesh/mesh-runtime.ts:665`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-runtime.ts:665)，665–668 行

```ts
iceConfigProvider: () => lastRtc ?? {
  stun: config.stunServers,
  turn: turnConfig(config),
},
```

最终 `RtcPeerManager` 调用：

- [`apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:239`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:239)，239–242 行

```ts
new native.PeerConnection(
  `${this.identity.nodeId}:${role}`,
  buildRtcIceConfig(this.iceConfigProvider())
);
```

`buildRtcIceConfig()` 将 STUN 和 TURN 转换为 `iceServers`：

- [`apps/gateway/src/mesh/rtc/ice.ts:129`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/ice.ts:129)，129–138 行

因此 STUN 到 PeerConnection 的代码链路是完整的。

注意：entrypoint 只在 `app.env` 不存在时创建文件。如果容器 volume 已经存在，之后修改 `TMEX_E2E_STUN_SERVERS` 不会覆盖旧值。应以容器内实际的 `app.env` 或收到的 `node.list.rtc.stun` 为准。

### 3.2 TURN

TURN 环境变量：

```text
TMEX_TURN_URL
TMEX_TURN_USERNAME
TMEX_TURN_CREDENTIAL
```

只有三个值都存在时才生成 TURN 配置：

- [`apps/gateway/src/mesh/mesh-runtime.ts:443`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-runtime.ts:443)，443–451 行

```ts
if (config.turnUrl && config.turnUsername && config.turnCredential) {
  return {
    url: config.turnUrl,
    username: config.turnUsername,
    credential: config.turnCredential,
  };
}
return null;
```

hub 也把 TURN 配置放进 `node.list`：

- [`apps/gateway/src/hub/uplink-server.ts:1122`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-server.ts:1122)，1126–1129 行

当前 TURN 不是 `PeerManager` 的独立第三条 fallback。它是 RTC ICE server 的候选来源：

```text
node_datachannel PeerConnection
  → STUN / TURN ICE candidate
  → ICE 失败或超时
  → PeerManager.dial() 回退到 hub relay
```

如果没有 `TMEX_TURN_*`，则跨对称 NAT、UDP 受限或防火墙场景可能无法建立 DataChannel，最终只能使用 hub relay。

---

## 4. 当前已有和缺失的日志

### 已有日志

1. `direct enable` 命令日志：

```text
[tmex] direct enabled ...
[tmex] direct enable failed: ...
```

见 [`packages/app/src/commands/direct.ts:177`](file:///Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/direct.ts:177)。

2. native addon 加载失败日志：

```text
[tmex][native-datachannel] native addon not found: ...
[tmex][native-datachannel] failed to require native addon: ...
```

见 [`packages/app/src/lib/native-datachannel.ts:81`](file:///Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/lib/native-datachannel.ts:81)，111–157 行。

3. uplink control decode/handler 异常：

```text
[uplink] ctl handler error ...
[uplink] ctl decode error ...
```

见 [`apps/gateway/src/mesh/uplink-client.ts:1128`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:1128)。

4. RTC 失败会产生异常字符串，但通常被吞掉或继续 fallback：

```text
datachannel missing
datachannel open timeout
incomplete dc handshake
peer transcript signature failed
peer hello missing dtls_fingerprint
dtls fingerprint mismatch
```

例如：

- [`apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:545`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:545)
- [`apps/gateway/src/mesh/rtc/dc-handshake.ts:252`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/dc-handshake.ts:252)

### 当前缺失的诊断

以下事件目前均没有正常日志：

- `dialDc()` 开始、目标 node ID、offerer/answerer、`rtcSession`；
- `rtc.signal` 发送、接收、丢弃原因；
- SDP offer/answer 发送与接收；
- ICE candidate 数量和 candidate type；
- host / srflx / relay candidate；
- ICE gathering state；
- ICE connection state；
- PeerConnection state；
- selected candidate pair；
- DTLS 建立完成；
- DataChannel 创建、收到、open、error、close；
- fingerprint mismatch 的双方 fingerprint；
- DC 超时的最后状态；
- DC 失败后选择 WS secure 或 relay 的原因。

虽然 vendored `node-datachannel` 类型提供这些 API：

- [`packages/app/src/vendor/node-datachannel/index.ts:142`](file:///Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/vendor/node-datachannel/index.ts:142)，153–171 行

```ts
state(): RTCPeerConnectionState;
iceState(): RTCIceConnectionState;
gatheringState(): RTCIceGatheringState;
onStateChange(...);
onIceStateChange(...);
onGatheringStateChange(...);
getSelectedCandidatePair(): ...;
```

但 gateway 自己的 `PeerConnectionLike` 只声明了 SDP、candidate 和 DataChannel 基础 API：

- [`apps/gateway/src/mesh/rtc/native.ts:55`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/native.ts:55)，55–67 行

此外，native module 暴露了 `initLogger()`，但 runtime 没有调用：

- [`apps/gateway/src/mesh/rtc/native.ts:69`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/native.ts:69)，73–74 行

---

## 5. 根因排序

### P0：offerer 没有被可靠唤起

置信度：高，但需要确认 node ID 顺序。

证据：

- RTC offerer 是较小 node ID；
- 场景业务请求只发生在 node-a；
- answerer 只等待 DataChannel；
- 没有 `node.list` → 主动 offer 的逻辑；
- in-process 测试显式让两端同时调用 `getLink()`。

确认方法：

```text
比较 mesh-nodes-direct.json 中 node-a.id 和 hub.id：

如果 node-a.id.toLowerCase() > hub.id.toLowerCase()
→ node-a 是 answerer
→ node-a 单方面 getLink() 时不会发送首个 rtc.signal
```

### P1：已有 relay 时，业务 stream 不等待升级

置信度：高，适用于复用已有 relay 的场景。

证据：

```ts
getLink(existing) {
  this.maybeUpgrade(...);
  return existing.session;
}
```

升级是后台异步执行，业务层随后立即用旧 link 打开 stream。因此即使 DC 稍后建立，已经打开的 stream 仍可能是 relay。

### P1：只有 STUN，没有 TURN

置信度：中高，取决于 NAT 类型和网络策略。

代码只在完整配置 `TMEX_TURN_URL/USERNAME/CREDENTIAL` 时加入 TURN。STUN 可达并不保证跨 NAT 成功，尤其是对称 NAT 或 UDP 受限环境。

### P2：persisted `app.env` 造成实际 STUN 配置过期

置信度：中低。

entrypoint 只在首次创建 volume 时写入 `TMEX_STUN_SERVERS`。如果测试复用了旧 volume，compose 中的新 `TMEX_E2E_STUN_SERVERS` 不一定生效。

### P3：hub 自身 registry 转发缺失

置信度：低。

代码明确为 `hub,node` 创建本地 hub，并通过 in-memory uplink 注册本机节点。因此没有发现必然的 self-routing bug。只有在 hub 自身 uplink 尚未注册或已断开时，`forwardDcSignal()` 才会在 `registry.get(msg.to)` 处静默丢弃。

---

## 6. 最小代码修改建议

### 6.1 让 RTC offer 真正启动

建议修改：

1. `apps/gateway/src/mesh/peer-manager.ts`
   - `getLink()`
   - `maybeUpgrade()`
   - 增加一个“preferred offerer wake-up”机制。

最小方案：

- 当本端不是 offerer 时，首次 `getLink()` 不要仅创建 answerer 并等待；
- 通过 hub control 发送一个明确的 `rtc.wake` / `rtc.request`；
- hub 收到后让较小 node ID 的一方调用 `getLink(peerNodeId)`；
- 或者两端都调用 `getLink()`，由 `RtcPeerManager` 的 node ID 规则决定谁真正发 offer。

更直接的实现方式是让 `connectToPeer()` 支持“当前调用方先建立 PC”，但只有较小 ID 方执行 `createDataChannel()`；answerer 仍需被主动唤起。

同时增加单元测试：

```text
只调用较大 ID 节点的 getLink()
预期仍能建立 dc
```

### 6.2 让升级结果对业务可等待

建议修改：

- `apps/gateway/src/mesh/peer-manager.ts:getLink()`
- `apps/gateway/src/mesh/forwarder.ts:handleRemoteHttp()`
- `apps/gateway/src/mesh/forwarder.ts:handleRemoteWs()`

至少增加：

```ts
getLink(nodeId, { waitForPreferredTransport: true })
```

或提供：

```ts
await peers.waitForTransport(nodeId, 'dc', timeoutMs)
```

这样场景 D 可以在打开验证 stream 前等待 DC，而不是立即使用旧 relay。

### 6.3 增加 RTC 诊断

建议修改：

- `apps/gateway/src/mesh/rtc/native.ts`
- `apps/gateway/src/mesh/rtc/rtc-peer-manager.ts`
- `apps/gateway/src/mesh/peer-manager.ts`

在 `PeerConnectionLike` 中补充：

```ts
state?(): string;
iceState?(): string;
gatheringState?(): string;
onStateChange?(cb: (state: string) => void): void;
onIceStateChange?(cb: (state: string) => void): void;
onGatheringStateChange?(cb: (state: string) => void): void;
getSelectedCandidatePair?(): unknown;
```

在 `connectToPeer()` 创建 PeerConnection 后立即记录：

```text
rtc dial start
peer=<id>
session=<dc:...>
role=<offerer|answerer>
stun_count=<n>
turn_enabled=<bool>
```

在 `bindSignaling()` 记录：

```text
rtc signal send/recv
kind=sdp|candidate
sdp_type=offer|answer
candidate_type=host|srflx|relay
```

在 PeerConnection 回调中记录：

```text
rtc gathering state
rtc ice state
rtc peer state
rtc selected candidate pair
```

在 DataChannel 生命周期中记录：

```text
datachannel created
datachannel received
datachannel open
datachannel error
datachannel closed
```

在 `dial()` fallback 时记录：

```text
dc failed reason=<...>
fallback=ws-secure|relay
```

不要默认输出完整 SDP、credential 或完整 candidate 地址；可输出 candidate type、协议、端口和脱敏地址。

---

## 7. 场景 D 应如何断言真正的 DC

当前 `/api/mesh/nodes` 只有：

```ts
reach: 'lan' | 'relay' | null
```

- [`apps/gateway/src/mesh/mesh-routes.ts:35`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-routes.ts:35)，35–46 行

而 `listReach()` 将所有非 relay 传输都映射为 `lan`：

- [`apps/gateway/src/mesh/peer-manager.ts:460`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:460)，466–472 行

因此 `reach=lan` 不能区分 `ws-secure` 和 `dc`。场景脚本也已经明确写出这一点：

- [`scripts/hub-e2e/split/run.sh:838`](file:///Users/konata/code/tmex-enhanced-wt-merge/scripts/hub-e2e/split/run.sh:838)

当前唯一能准确查询实际连接类型的 API 是进程内：

```ts
mesh.peers.transportOf(nodeId)
```

- [`apps/gateway/src/mesh/peer-manager.ts:361`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:361)

HTTP API 和已打开的 stream 对象目前都没有 transport 字段。`OpenedWsStream` 也只有 send、message、close：

- [`apps/gateway/src/mesh/mesh-deps.ts:80`](file:///Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-deps.ts:80)

建议最小扩展：

```ts
type MeshNodeDto = {
  // ...
  reach: 'lan' | 'relay' | null;
  transport: 'ws-secure' | 'relay' | 'dc' | null;
};
```

在 `collectNodes()` 中使用：

```ts
transport: this.deps.peers.transportOf(id),
```

然后场景 D 改为：

```ts
const n = (j.nodes ?? []).find(
  (x) => x.isHub === true || x.id === process.env.HUB
);

if (n?.transport !== 'dc') {
  fail(`expected dc, got ${n?.transport ?? 'null'}`);
}
```

如果只做内部集成测试，则直接断言：

```ts
expect(meshA.peers.transportOf(meshB.nodeId)).toBe('dc');
expect(meshB.peers.transportOf(meshA.nodeId)).toBe('dc');
```

这正是现有 direct-path 集成测试已经使用的字段。