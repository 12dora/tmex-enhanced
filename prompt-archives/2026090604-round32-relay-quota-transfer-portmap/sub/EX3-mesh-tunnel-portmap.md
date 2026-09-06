# EX3 — Mesh transport / tunnel / port-mapping feasibility survey

Scope: everything a "map B:12345 → A:5678" feature needs to reuse. All paths absolute.
Repo: `/Users/konata/code/tmex-r32` (branch `main`, `542b576f`).

**Headline finding:** the repo already contains a complete, production-hardened stream
multiplexer with credit-based flow control (`packages/shared/src/link/`). Every mesh
transport (direct LAN WS, WebRTC DataChannel, hub relay, public relay) terminates in the
*same* `LinkMux` object exposed as `LinkSession`. Opening a generic bidirectional byte
stream to another node is a one-liner (`link.openStream(payload)`); adding a new stream
*type* is a two-line change in one classifier function. There is **no** raw TCP
listener/dialer anywhere in the product code — that is the only genuinely new piece.

---

## 1. Mesh transport inventory

### 1.1 The common denominator: `LinkSession` / `LinkMux`

Everything below produces a `LinkSession`. Interface at
`/Users/konata/code/tmex-r32/packages/shared/src/link/types.ts:25-32`:

```ts
export interface LinkSession {
  openStream(openPayload: Uint8Array): Promise<LinkStream>;
  onStream(cb: (stream: LinkStream) => void): void;
  readonly ctl: LinkCtl;
  readonly lastFrameAt?: number;
  close(reason?: string): void;
  readonly closed: Promise<LinkCloseInfo>;
}
```

`LinkStream` (`types.ts:50-68`) is a full-duplex byte stream: pull-based
`readable: ReadableStream<StreamChunk>`, `write(bytes, {head?})`, half-close `end()`,
`reset(reason)`, `closed`, `onAbort(cb)`.

**Framing** — `/Users/konata/code/tmex-r32/packages/shared/src/link/codec.ts:35-71`.
Fixed 10-byte header, little-endian:

| offset | size | field |
|---|---|---|
| 0 | 4 | `streamId` (u32 LE) |
| 4 | 1 | `op` |
| 5 | 1 | `flags` |
| 6 | 4 | `payloadLength` (u32 LE) |

Ops (`types.ts:18-24`): `OPEN=1, DATA=2, END=3, RST=4, WINDOW=5`. Flags: `FLAG_HEAD = 1`
(`types.ts:9`) marks a "header" chunk — used by the HTTP stream type to carry the response
head out-of-band from the body. `CTL_STREAM_ID = 0` is a reserved always-open control
stream that cannot `END`/`RST` (`mux.ts:670-673`, `152`, `166`).

Incremental decoder `FrameDecoder` (`codec.ts:122-221`) keeps a chunk list + read cursor,
concatenating only when a full frame is available — transports may split/coalesce freely.

**Flow control** — per-stream credit windows, `mux.ts`:
- `INITIAL_STREAM_WINDOW = 1 MiB` (`types.ts:5`), `MAX_DATA_SEND_PAYLOAD = 256 KiB`
  sender cap (`types.ts:4`), `MAX_FRAME_PAYLOAD = 1 MiB` receiver cap (`types.ts:2`).
- Writes block on credit: `MuxStream.writeInternal` (`mux.ts:257-299`) slices to
  `min(remaining, sendWindow, maxFramePayload, MAX_DATA_SEND_PAYLOAD)` and awaits
  `waitForSendCredit()`.
- **Credit is only returned when the application reads.** The readable is constructed with
  `highWaterMark: 0` (`mux.ts:110-136`); `flushReadable()` calls
  `consumeFromReadable(byteLength)` → `mux.sendWindowCredit()` → a `WINDOW` frame
  (`mux.ts:320-345`, `253-255`, `527-535`). This is exactly the back-pressure semantics a
  TCP tunnel needs — a slow local TCP peer naturally stalls the remote sender.
- Over-window sends are fatal to the stream: `onIncomingData` RSTs on
  `bytes.byteLength > recvAdvertised` (`mux.ts:198-201`).
- **Link-level cap: `MAX_LINK_UNACKED = 65 * 1 MiB = 65 MiB`** (`types.ts:7`).
  `addUnacked()` (`mux.ts:520-525`) calls `protocolError()` — **which closes the whole
  link** — if total unacked outbound exceeds it. ⚠️ See §9 hazards.

**Limits** (`mux.ts:23-25`): `MAX_MUX_STREAMS = 256`, `MAX_PENDING_INCOMING = 64`,
`MAX_CTL_INBOX = 64`.

**Stream id allocation** (`mux.ts:415`, `618-629`): initiator uses odd ids from 1,
acceptor even from 2, strictly increasing; wrong parity or non-increasing OPEN is a
protocol error (`mux.ts:699-728`).

**Binary efficiency:** fully binary, zero base64. One `Uint8Array` copy on
`transport.send` (`websocket-link.ts:228 bytes.slice()`) and one on ingest
(`mux.ts:46-48 copyBytes`), plus `payload: raw.slice(...)` in the decoder
(`codec.ts:154`). Acceptable, not zero-copy.

**Registering a new stream type.** Incoming streams are dispatched purely by the JSON
`openPayload`:

- `classifyOpenPayload(bytes): 'http' | 'ws' | 'relay' | 'unknown'` —
  `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/stream-targets.ts:583-597`.
- Called twice in `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/peer-live-registry.ts:257`
  (reject `unknown`/`relay` with `stream.reset('unknown-stream-type')`) and `:312`
  (`handleInboundStream` → `acceptHttpStream` / `acceptWsStream`).
- Open payload shapes: `HttpStreamOpenPayload` / `WsStreamOpenPayload` at
  `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/types.ts:95-112`.

So a new `{"type":"tcp", ...}` type needs: one branch in `classifyOpenPayload`, one branch
in `handleInboundStream`, and an `acceptTcpStream()` next to `acceptHttpStream`.

### 1.2 Node ↔ node, direct LAN/WAN WebSocket (`ws-secure`)

- Listener: `PeerServer` — `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/peer-server.ts:59-111`.
  `Bun.serve` per bind host, default dual-stack `['::','0.0.0.0']`
  (`types.ts:8 DEFAULT_PEER_BIND_HOSTS`), port from `TMEX_PEER_PORT` (default 39001).
  Handshake rate limit 10/min/IP (`peer-server.ts:7-8`).
- Handshake: `handshakeWsDirect()` —
  `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/peer-protocol.ts:345-396`.
  hello/sig exchange (Ed25519 over a transcript, X25519 ephemeral) →
  `SecureChannelLink` (AES-GCM, `packages/shared/src/link/secure-channel-link.ts`) →
  `new LinkMux(secure, { role, logContext: { transport: 'ws-secure' } })`.
- Transport adapter with back-pressure:
  `/Users/konata/code/tmex-r32/packages/shared/src/link/websocket-link.ts:64-242`.
  Server side honours `SERVER_WS_BACKPRESSURE_LIMIT = 1 MiB` (`:28`, matches
  `Bun.serve websocket.backpressureLimit` set at `apps/gateway/src/runtime.ts:266`,
  `closeOnBackpressureLimit: true`); pauses on `send() === -1`, resumes on `drain`, plus a
  16 ms poll fallback (`:126-146`). Client side: high water 4 MiB / low water 1 MiB,
  16 ms poll (`:24-26`).

### 1.3 Node ↔ node, WebRTC DataChannel (`dc`)

- `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/rtc/` (native binding `native.ts`,
  `rtc-peer-manager.ts`, `signaling.ts`, `ice.ts`).
- `DataChannelLink implements ByteTransport` —
  `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/rtc/data-channel-link.ts:62-…`.
  Notable perf work:
  - **Two priority queues**: `controlQueue` vs `dataQueue` (`:70-71`), classified by
    `isUrgentMuxFrame()` (`:48-54`) — CTL stream, `WINDOW`, `RST`, `END` jump the
    bulk queue. This is what keeps window credits flowing under a saturated bulk stream.
  - Fragmentation to fit `maxMessageSize`:
    `/Users/konata/code/tmex-r32/packages/shared/src/link/fragment-core.ts` —
    8-byte header `{frameId u32, idx u16, total u16}` (`:1`, `:66-71`),
    `DC_MAX_MESSAGE_BYTES = 64 KiB`, preferred send size `16 KiB`
    (`FRAGMENT_SEND_MESSAGE_BYTES`), `RECEIVER_MAX_FRAGMENTS = 17`, adaptive
    `pickFragmentPayloadSize()` (`:12-21`).
  - Buffered-amount watermarks `DC_HIGH_WATER_BYTES` / `DC_LOW_WATER_BYTES`
    (`rtc/data-channel-carrier.ts`), `onBufferedAmountLow` + `DC_FLUSH_RETRY_MS = 8`
    retry (`data-channel-link.ts:22`, `:106-109`).
  - Liveness ping/pong inside the channel (`rtc/liveness.ts`).
- Dial breaker (round-17 work):
  `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/rtc/rtc-dial-breaker.ts` on top of
  `/Users/konata/code/tmex-r32/packages/shared/src/net/dial-breaker.ts:1-4`
  (3 fails → 30 s base, ×2 to 30 min cap, 60 s healthy reset;
  `RTC_DIAL_DISABLE_AFTER_DEFAULT = 10`, forced re-probe every 10 min).
- Dial race (round-29 "拨号竞速"):
  `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/peer-dial-race.ts:18-19` —
  `FOREGROUND_DC_BUDGET_MS = 2500`, `FOREGROUND_DIRECT_DEADLINE_MS = 4000`; DC gets a
  short head start, then ws-secure runs in parallel, then the whole direct attempt yields
  to relay. Losing leg's late session is `discard`ed.
- Concurrent LAN dialing (round-9 "直连并发"):
  `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/peer-ws-race.ts`
  (`raceWsSecureEndpoints`, `DirectDialLimiter`), stagger
  `PEER_WS_DIAL_STAGGER_MS = 250` (`peer-manager-state.ts:20`).

### 1.4 Node ↔ hub / node ↔ relay uplink

- Hub uplink client: `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/uplink-client.ts`
  (`UPLINK_PING_INTERVAL_MS = 15_000` at `:53`). Server side
  `/Users/konata/code/tmex-r32/apps/gateway/src/hub/uplink-server.ts`,
  `hub/uplink-auth-session.ts:141` binds `link.onStream`.
- Relay uplink client:
  `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/relay-uplink-client.ts`
  (heartbeat `RELAY_HEARTBEAT_INTERVAL_MS = 15_000`, miss limit 3 —
  `apps/gateway/src/relay/types.ts:6-7`). Server:
  `apps/gateway/src/relay/relay-uplink-server.ts:158`.
- Pool / failover across multiple hubs+relays:
  `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/uplink-pool.ts` (`openRelay` at `:646`).

### 1.5 Node ↔ node via relay/hub (`relay` transport) — **nested mux**

This is the important structural fact:

1. A opens **one** relay stream on its uplink:
   `uplink.openRelay(nodeId)` → `link.openStream(JSON {to})`
   (`uplink-client.ts:337-344`, `relay-uplink-client.ts:339-351`, `uplink-pool.ts:646`).
2. Relay/hub validates and splices it to B with `{to, from}`:
   - public relay: `acceptRelayStream()` +`pumpRelayPair()` —
     `/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-stream-router.ts:26-117`.
   - hub: `HubRelayStreams.routeNodeStream()` / `pumpToLocalNode()` —
     `/Users/konata/code/tmex-r32/apps/gateway/src/hub/hub-relay-streams.ts:192-240`,
     `:129-144`; cross-hub multi-hop at `:110-127`, `:146-169`.
3. Both nodes run `handshakeRelay()` **inside** that single stream —
   `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/peer-protocol.ts:398-468`:
   `byteTransportFromStream(stream)` (`secure-channel-link.ts:123`) → `SecureChannelLink`
   → `new LinkMux(...)`. Called from `peer-dialer.ts:330-331` and `:514`.

⇒ **The relay/hub sees exactly one opaque byte stream per peer pair.** Any number of inner
mux streams (HTTP, WS, and a future TCP tunnel) ride inside it and are automatically
metered / rate-limited / quota-counted as one relay stream. No relay-side change is needed
to make a tunnel work in relay mode.

### 1.6 Forwarder (`/n/<id>` HTTP + WS proxy)

- `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/forwarder.ts:137-…`;
  path parse `parseNodePrefix()` at
  `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/forwarder-path.ts:1-5`
  (`^/n/([^/]+)(/.*)?$`).
- `Forwarder.handle()` (`forwarder.ts:155-172`): `/n/<id>/ws` → `handleRemoteWs`,
  `/n/<id>/api/**` → `handleRemoteHttp`, `/api/mesh-internal*` explicitly 403 from the
  browser edge (`:166-168`).
- Client side of the stream types:
  `openHttpStream()` (`stream-targets.ts:270-406`) and `openWsStream()` (`:549-581`);
  server side `acceptHttpStream()` (`:148-249`) and `acceptWsStream()` (`:449-482`).
- Stream failover (round-9/28 hardening):
  `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/forwarder-failover.ts` +
  `mesh-deps.ts:24-31`: `STREAM_FAILOVER_BACKOFF_MS = [0,50,100,…,6400]`,
  `HTTP_FAILOVER_MAX_ATTEMPTS = 4`, `STREAM_QUEUE_MAX_FRAMES = 256`,
  `STREAM_QUEUE_MAX_BYTES = 4 MiB`, overflow ⇒ close browser socket, never silent drop.
  Replay bookkeeping in `mesh/stream-replay-state.ts`.
- WS bridging carrier: `LinkStreamCarrier` —
  `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/link-stream-carrier.ts:7-…`,
  `LINK_STREAM_BACKPRESSURE_BYTES = 1 MiB` (`:5`).
- Generic pump helpers: `pumpToLink` / `pumpLink` —
  `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/stream-pump.ts:5-45`.

### 1.7 Link lifecycle constants that matter for a long-lived tunnel

`/Users/konata/code/tmex-r32/apps/gateway/src/mesh/peer-manager-state.ts:17-28`:

```
PEER_IDLE_MS = 5 * 60_000        // link torn down after 5 min with zero streams
PEER_CONNECT_TIMEOUT_MS = 3_000
PEER_LAN_DIAL_TIMEOUT_MS = 4_000
PEER_PING_INTERVAL_MS = 5_000    // + PEER_MISSED_PONG_LIMIT = 3
PEER_MAX_CONCURRENT_STREAMS = 256
PEER_RETIRE_MIN_MS = 5_000 / QUIET 2_000 / MAX 30_000
PEER_TRANSPORT_RANK = { dc: 3, 'ws-secure': 2, relay: 1 }
```

Stream accounting per peer: `PeerLiveRegistry.bindSession` wraps `openStream`
(`peer-live-registry.ts:239-268`) and counts live streams in `onLocalStream`
(`:286-309`); a link with `streams > 0` is never idled out (`:417-423`).

Retire/quiesce on transport upgrade:
`/Users/konata/code/tmex-r32/apps/gateway/src/mesh/peer-link-drain.ts:135-235`. An
upgraded-away link is *retired*, not killed: `maybeFinishRetire()` returns early while
`live.streams > 0` (`:191`) — **except** when the retire reason is a drain reason
(`'missed-pong' | 'idle'`, `peer-reconnect-wake.ts:40`), where it hard-closes after
`PEER_RETIRE_MAX_MS = 30 s` (`peer-link-drain.ts:187-190`).

---

## 2. How a node opens an arbitrary bidirectional byte stream to another node today

**It already can, and this is the primitive to build on.**

```ts
const link = await peerManager.getLink(nodeId);   // peer-manager.ts:427-456
const stream = await link.openStream(encodeJsonBytes({ type: 'tcp', ... }));
// stream.write(bytes) / stream.readable / stream.end() / stream.reset()
```

`PeerManager.getLink()` — `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/peer-manager.ts:427-456`
— is the single entry point. It reuses a live link, joins an in-flight dial, or starts one
(`dialer.dial(nodeId, { foreground: true })`), and opportunistically triggers DC upgrade.
It throws `NodeUnreachableError` (`mesh/types.ts:74-83`) when unreachable. The returned
`LinkSession` hides *which* transport won.

**The multiplexer lives in `packages/shared/src/link/mux.ts` (`LinkMux`)**; it is
instantiated in exactly four places:
- `apps/gateway/src/mesh/peer-protocol.ts:381` (ws-secure) and `:444` (relay)
- `apps/gateway/src/mesh/peer-dialer.ts:235` (DataChannel)
- `packages/shared/src/link/websocket-link.ts:308` (`WebSocketLink` wrapper, uplink)

Existing consumers of the primitive, i.e. the precedents to copy:

| Use | Open payload | Client | Server |
|---|---|---|---|
| HTTP proxy | `{type:'http',method,path,query,headers,origin,auth}` | `openHttpStream` `stream-targets.ts:270` | `acceptHttpStream` `stream-targets.ts:148` |
| tmux/gateway WS proxy | `{type:'ws',auth,cid?,share?}` | `openWsStream` `stream-targets.ts:549` | `acceptWsStream` `stream-targets.ts:449` |
| Node→node RPC (remote agent, notifications) | reuses `http` | `Forwarder.forwardInternalHttp` `forwarder.ts:236-…`, bridge `mesh/mesh-agent-bridge.ts:6-16`, wired at `mesh-runtime.ts:1315-1325` | `/api/mesh-internal/*`, `mesh-internal-tmux-routes.ts:186-201` |
| Hub/relay splice | `{to}` / `{to,from}` / `{kind:'hub-relay',…}` | `uplink-client.ts:337` | `relay-stream-router.ts:26`, `hub-relay-streams.ts:192` |

Remote-agent RPC example (a clean model for a node-local capability invoked from another
node): `/Users/konata/code/tmex-r32/apps/gateway/src/agent/remote-pane-runtime.ts:82-102`.

There is **no** existing raw-TCP splice anywhere (confirmed: no `Bun.connect`, no
`net.createConnection` for data, `apps/gateway/src/tunnel/` only spawns `cloudflared`).

---

## 3. Auth / authorization for node-to-node actions

### 3.1 Peer identity (transport layer)

Mutual Ed25519 over an X25519-ECDH transcript, both on the direct path and inside the
relay stream: `exchangeHelloAndSig()` —
`/Users/konata/code/tmex-r32/apps/gateway/src/mesh/peer-protocol.ts:180-267`;
peer public key looked up from the local cert store `lookupPeerEdPk()` (`:142-155`),
rejecting unknown or `revokedLogSeq != null` certs. Session keys via
`derivePeerSessionKeys()`, channel encryption `SecureChannelLink`.
⇒ **A `LinkSession` is already an authenticated, encrypted channel to a specific
`peerNodeId` of the same user.** Anything sent over it inherits that.

`PeerManager.getLink` calls `this.requireTrusted(nodeId)` (`peer-manager.ts:429`) —
untrusted/revoked peers never get a link. `onRevoked()` (`:458-473`) tears everything down.

### 3.2 Peer marker (application layer)

`/Users/konata/code/tmex-r32/apps/gateway/src/mesh/peer-request-marker.ts`:

```ts
export const X_TMEX_MESH_PEER = 'x-tmex-mesh-peer';           // :3
export function attachMeshPeerMarker(headers, fromNodeId)      // :10-15
export function readMeshPeerMarker(req): string | null          // :5-8
export function stripMeshPeerMarkerFromRequest(req)             // :21-38
```

`acceptHttpStream` stamps it after stripping client-supplied copies
(`stream-targets.ts:25-33 BLOCKED_REQUEST_HEADERS` includes `X_TMEX_MESH_PEER`,
`cookie`, `authorization`, `host`, `x-tmex-via`, `proxy-*`, `x-forwarded-*`; applied at
`:157-160`). The browser edge is fenced off separately: `Forwarder.handle` 403s
`/n/<id>/api/mesh-internal*` (`forwarder.ts:166-168`).

Gate: `requirePeerMarker()` —
`/Users/konata/code/tmex-r32/apps/gateway/src/mesh/mesh-internal-tmux-routes.ts:41-46`,
applied once at the `/api/mesh-internal` entry (`:186-201`). `isMeshInternalPath()` at
`:203-205`. Related: `isPeerInboundRequest()` (`peer-request-marker.ts:17-19`, checks
`clientIp` starting with `peer:`).

⇒ **Pattern for a node-to-node control call: put it under `/api/mesh-internal/...` and it
is automatically peer-only.** Note `isAuthSkippedPath()`
(`/Users/konata/code/tmex-r32/apps/gateway/src/mesh/stream-auth.ts:44-47`) treats
`/api/mesh-internal/` as session-auth-exempt — the peer marker *is* the auth there.

### 3.3 Browser-initiated action targeting node B

The browser only ever talks to the entry node. Per-node session cookies do the rest:

- FE path builder: `/Users/konata/code/tmex-r32/packages/api-client/src/node-url.ts:37-42`
  (`assertNodeId` — strict `^[0-9a-f]{32}$` or `self`, explicitly defends against
  `/n/../api/x` traversal).
- Cookie name `tmex_ns_<nodeId>` via `nodeSessionCookieName()` (`apps/gateway/src/auth/cookies.ts`);
  the Forwarder reads it and passes it as the stream's `auth` field:
  `forwardedAuthFor()` — `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/forwarder.ts:102-109`.
- Node B verifies it locally: `verifyStreamAuth()` / `authorizeHttpStream()` —
  `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/stream-auth.ts:63-113`, against its
  own `NodeSessionStore`, yielding `uid`. Per-frame re-verification for WS:
  `createStreamRecheck()` (`:119-141`).
- Entry-node-orchestrated variant (when the entry node must record state too):
  `handleMeshNodeUninstall()` —
  `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/node-operations.ts:157-222`. It
  checks `readNodeSession(req, nodeId)` (`:149-151`) → 401 `NODE_LOGIN_REQUIRED`,
  writes progress to `gateway_kv`, then `forwardAuthorizedHttp(req, {nodeId, method, path, body})`
  (wired `mesh-routes.ts:375-383` → `mesh-http.ts:183` → `Forwarder.forwardAuthorizedHttp`).

⇒ **A port-map UI needs no new authorization mechanism**: `POST /n/<A>/api/portmap` and
`GET /n/<B>/api/portmap/ports` are already authenticated as "this user, on that node".

### 3.4 Key-log signed records

`/Users/konata/code/tmex-r32/packages/shared/src/auth/key-log.ts` (+ `key-log-hub.ts`,
`relay-records.ts`, `readmit-node-record.ts`, `rename-node-record.ts`); node side
`apps/gateway/src/auth/key-log-store.ts`, `user-key-service.ts`; sync
`mesh/uplink-key-log-sync.ts`, `mesh/relay-key-log-sync.ts`. This log is for **identity**
events (admit/revoke/rename/rotate) only. Port maps are node-local config, **not** a
key-log concern — do not add records there.

### 3.5 Tenant / user boundaries

- Public relay: `acceptRelayStream()` resolves the target strictly within the caller's
  tenant — `ctx.tenants.getNode(live.tenantId, to)`, requiring `status === 'admitted'`
  (`relay-stream-router.ts:42-51`). A `tenantId` is bound at uplink auth time
  (`relay/relay-uplink-auth.ts`); cross-tenant addressing is structurally impossible.
- Hub: `routeNodeStream()` rejects with `'cross-user'` when
  `targetCert.userId !== live.userId` (`hub-relay-streams.ts:203-211`); cross-hub hops
  additionally require `sameUser` on all three certs (`:71-108`).
- ⇒ Because a port-map stream is nested *inside* the peer link (§1.5), it inherits these
  checks unchanged. There is no way to address a node outside your tenant/user.

---

## 4. Bun TCP APIs and port-in-use detection

### 4.1 What exists

- **`Bun.listen` — test-only.** `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/peer-manager.test.ts:3338`
  and `:3508` ("hang server" fixtures). No product code uses it.
- **`Bun.connect` — zero uses in the repo.**
- **`Bun.serve`** (HTTP/WS only): `packages/app/src/runtime/server.ts:44` (production
  entry), `packages/app/src/tls/https-listener.ts:47`, `apps/gateway/src/index.ts:16`
  (dev entry), `apps/gateway/src/managed-entry.ts:161`,
  `apps/gateway/src/mesh/peer-server.ts:135`.
- **`node:net`**: only `isIP` (`mesh/rtc/ice.ts:1`, `packages/app/src/tls/*.ts`) plus two
  ephemeral-port allocators (below). `packages/stores/src/node-connection-manager.ts` and
  `apps/gateway/src/tmux-client/device-session-runtime.ts` export functions *named*
  `createConnection` but they are app-level factories, not sockets.
- **No unix-socket paths anywhere.**

### 4.2 Free-port / occupied-port logic

Canonical pattern — `/Users/konata/code/tmex-r32/apps/gateway/src/tunnel/spawn.ts:25-44`:

```ts
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    ...
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
```

Duplicate at `/Users/konata/code/tmex-r32/packages/app/src/lib/upgrade-txn.ts:108-121`
(`allocateEphemeralPort()`), used by upgrade preflight for `GATEWAY_PORT` (`:314`) and
`TMEX_PEER_PORT` (`:335`).

Test-only helpers with an actual **occupancy probe**:
`/Users/konata/code/tmex-r32/apps/fe/tests/helpers/mesh-boot.ts:46-73` —
`canBind()` (bind then close) + `isListening()` (`net.connect`) + `findFreePort(start)`
linear scan. `apps/fe/playwright.config.ts:60-71` refuses to run if a configured e2e port
is occupied by an unknown process (explicitly to avoid hitting production's 9663/9883).

**There is no production `isPortFree` / `EADDRINUSE` handling.** The closest bind-failure
handling:
- `HttpsListener.apply()` — `packages/app/src/tls/https-listener.ts:39-…`: always
  `await this.stop()` first, then try/catch around `Bun.serve`, storing `lastError`
  instead of throwing (tests at `https-listener.test.ts:24-72`).
- `PeerServer.start()` — `apps/gateway/src/mesh/peer-server.ts:83-111`: collects per-host
  bind errors; throws `failed to bind peer server: ...` only if **all** hosts fail (so a
  missing IPv6 stack is tolerated).

⇒ A port-map feature must write its own `isPortFree(host, port)` (bind + immediate close,
per-address-family) — this is genuinely new code, though `pickFreePort` is the exact
shape to copy.

### 4.3 `TMEX_PEER_PORT`

- Parsed `apps/gateway/src/config.ts:104-112` (default `'39001'`, must be integer 1..65535),
  exported `config.peerPort` at `:355`; `TMEX_PEER_BIND_HOST` at `:357`,
  `DEFAULT_PEER_BIND_HOSTS = ['::','0.0.0.0']` at `:126`.
- Consumed `apps/gateway/src/mesh/mesh-runtime.ts:959` → `PeerManager` →
  `new PeerServer({ port: opts.peerPort, ... })` (`peer-manager.ts:253-260`).
- **No conflict detection** beyond §4.2. Writers: `packages/app/src/lib/install.ts:80`,
  `packages/app/src/commands/init.ts:210`, firewall reminder
  `packages/app/src/commands/hub.ts:667-668`.

### 4.4 Listener creation / shutdown

- Dev entry `apps/gateway/src/index.ts:16-40`: `Bun.serve` in a `while(true)` restart loop,
  `idleTimeout: 255` (deliberately maxed for large transfers, `:19-21`); no signal handlers.
- Production entry `packages/app/src/runtime/server.ts:51-57`: `stopAll` =
  `tls.stop()` → `httpsListener.stop()` → `assembled.stop()` → `server.stop(true)`.
  Signal handling: `installShutdownHandlers()` /
  `createProcessShutdown()` — `packages/app/src/runtime/assemble.ts:517-561`,
  idempotent, races against `SHUTDOWN_TIMEOUT_MS = 20_000` (`assemble.ts:58`), then
  `process.exit`. Only installed when `meshShutdownNeeded(roles)` (`assemble.ts:62-64`).
- Gateway-level teardown registry: `GatewayRuntime.stop()` —
  `/Users/konata/code/tmex-r32/apps/gateway/src/runtime.ts:297-315` (wsServer, share,
  tunnel, watch, agent, push, tmux, telegram, weixin).
- Mesh-level teardown registry: `stopQuietly([...])` —
  `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/mesh-runtime.ts:521-529`, applied at
  `:1449-1471` over `[peer, uplink, hub, mesh http, rtc, bulk]`, logging rather than
  throwing per part. **This is the list a port-map listener registry should join.**

---

## 5. Persistence

### 5.1 Stack

`bun:sqlite` + `drizzle-orm/bun-sqlite`.
`/Users/konata/code/tmex-r32/apps/gateway/src/db/client.ts` — singleton `Database`,
pragmas `foreign_keys=ON`, `journal_mode=WAL`, `busy_timeout=5000`,
`synchronous=NORMAL` (`:9-14`); `getDb()` returns `drizzle(sqlite, { schema })`.

Tables are declared with `sqliteTable` in `/Users/konata/code/tmex-r32/apps/gateway/src/db/schema/*.ts`
(one file per domain: `agent.ts`, `devices.ts`, `mesh.ts`, `mesh-relay.ts`,
`messaging.ts`, `relay.ts`, `settings.ts`, `share.ts`, `users-auth.ts`), barrel-exported by
`/Users/konata/code/tmex-r32/apps/gateway/src/db/schema.ts` (9 lines of `export *`).

Conventions: camelCase TS key → explicit `snake_case` SQL column; booleans as
`integer('x', { mode: 'boolean' }).notNull().default(false)`; epoch-ms `integer` timestamps
for newer feature tables (share/relay), ISO `text` for older settings tables; enum-ish text
columns get a `check(...)` constraint plus `$type<...>()`; singleton config rows pinned by
a `check(id = 'default'/1)`; composite PKs via `primaryKey({ columns: [...] })`.

### 5.2 Migrations

- Folder `/Users/konata/code/tmex-r32/apps/gateway/drizzle/`, 49 files
  `0000_busy_starjammers.sql` … `0048_share_password_enc.sql` + `meta/_journal.json`.
  Recent entries use hand-picked slugs (`0047_share.sql`, `0044_messaging_commands.sql`).
- Config `/Users/konata/code/tmex-r32/apps/gateway/drizzle.config.ts`
  (`dialect: 'sqlite'`, `schema: './src/db/schema.ts'`, `out: './drizzle'`).
- Applied at boot: `runMigrations()` —
  `/Users/konata/code/tmex-r32/apps/gateway/src/db/migrate.ts` (resolves
  `TMEX_MIGRATIONS_DIR` → `cwd/drizzle` → `../../drizzle`), invoked
  `/Users/konata/code/tmex-r32/apps/gateway/src/runtime.ts:185-190` as the very first step.
- Scripts (in `apps/gateway/package.json:18-19`):
  `db:generate` = `drizzle-kit generate --config drizzle.config.ts`,
  `db:migrate` = `bun src/db/migrate.ts`.
- ⚠️ **Two gotchas:**
  1. `apps/gateway/drizzle/meta/` only has snapshots `0000`–`0032`; `0033`–`0048` were
     never committed. `drizzle-kit generate` may therefore produce a bogus full-table diff —
     inspect (or hand-write) the generated SQL.
  2. The packaged build embeds migrations from a hard-coded list:
     `/Users/konata/code/tmex-r32/apps/gateway/src/db/managed-migrations.ts:9-58`
     (`MIGRATIONS` const, materialized at `apps/gateway/src/managed-entry.ts:146-151`).
     **A new `.sql` must be appended there or the shipped binary won't apply it.**

### 5.3 Store + boot-resume patterns to copy

Best structural analog for "persisted rows that spawn a background runtime object at boot":

- **Watch rules** (enable flag filtered at start):
  schema `apps/gateway/src/db/schema/agent.ts:183`
  (`enabled: integer('enabled',{mode:'boolean'}).notNull().default(true)`);
  query `getEnabledWatchRules()` — `apps/gateway/src/db/watch.ts:113-121`;
  resume `WatchService.start()` — `apps/gateway/src/watch/service.ts:129-137`
  (`for (const rule of this.deps.listEnabledRules()) this.addRule(rule)`).
- **Share sessions** (re-arm timers + recorders):
  `ShareService.startSweeper()` — `apps/gateway/src/share/share-service.ts:346-364`
  (`for (const row of this.store.listActive()) { expireIfDue / scheduleExpiry / startRecorder }`),
  called from `apps/gateway/src/runtime.ts:230`.
- **Tunnel auto-start** (persisted boolean gating a spawned process):
  `TunnelManager.start()` — `apps/gateway/src/tunnel/manager.ts:329-350`
  (`if (persisted.autoStart && persisted.mode !== 'off' …) await this.startProcess(...)`),
  called from `startLiveGatewayServices()` at `apps/gateway/src/runtime.ts:129`.
  Its store is the cleanest CRUD template: `TunnelConfigStore` +
  `MemoryTunnelConfigStore` behind a `TunnelConfigStoreLike` interface —
  `/Users/konata/code/tmex-r32/apps/gateway/src/tunnel/config-store.ts` (141 lines).
- **Richer store with lifecycle + logs**: `ShareStore` —
  `/Users/konata/code/tmex-r32/apps/gateway/src/share/share-store.ts` (371 lines);
  row→domain mapper co-located in the store file (`toRow` at `:68`) rather than in the
  shared `apps/gateway/src/db/mappers.ts` (which is reserved for legacy core tables).
- **Small encrypted-column store**: `MeshRelayStore` —
  `/Users/konata/code/tmex-r32/apps/gateway/src/auth/mesh-relay-store.ts` (220 lines).

Boot order (`createGatewayRuntime`, `apps/gateway/src/runtime.ts:174-231`):
migrations → seed local device → site settings → agent settings → controller reset →
shell PATH → orphan temp sweep → `await sweepReleaseCacheOnStartup()` →
wsServer/db wiring → `getShareService().startSweeper()` → `await liveStart()`
(`:116-133`: event-loop lag, messaging, push, agent supervisor, watch, **tunnel**, online push).

### 5.4 KV escape hatch

`/Users/konata/code/tmex-r32/apps/gateway/src/db/kv.ts` — `getGatewayKv(key)` /
`setGatewayKv(key, value)` over `gateway_kv(key PK, value, updated_at)`
(`apps/gateway/src/db/schema/settings.ts:41-45`). Used by `node-operations.ts` for
transient per-node operation state (`NODE_OPERATION_KEY_PREFIX = 'mesh.node-op.'`,
TTL 30 min — `node-operations.ts:11-12`, `59-104`). Good for ephemeral status, **not** for
port-map rows.

---

## 6. WS event bus to browsers

Binary Borsh envelopes. Kinds:
`/Users/konata/code/tmex-r32/packages/shared/src/ws-borsh/kind.ts` — relevant ranges:

```
0x0801 KIND_SITE_THEME_UPDATE   0x0802 KIND_SETTINGS_UPDATE   0x0803 KIND_NOTIFY_EVENT
0x0a01 KIND_NODE_EVENT          0x0a02 KIND_RTC_SIGNAL        0x0a03 KIND_CARRIER_SWITCH
0x0a04 KIND_CARRIER_SWITCH_ACK  0x0a05 KIND_ENROLL_REDEEMED
```

Note `packages/shared/src/ws-borsh/kind-doc-drift.test.ts` enforces docs/kind parity — a
new kind must be documented.

Two channels:

1. **Gateway WS (`/ws` and `/n/<id>/ws`)** — `WebSocketServer`,
   `/Users/konata/code/tmex-r32/apps/gateway/src/ws/index.ts`. Broadcast helpers at
   `:794-842` (`broadcastSettingsUpdate`, `broadcastEventNotify`, `broadcastThemeChange`,
   `broadcastTmuxEvent`, `broadcastDeviceEvent`…). Decoupling registries (runtime
   registers on start, nulls on stop):
   - `/Users/konata/code/tmex-r32/apps/gateway/src/settings/broadcaster.ts:4-28` —
     `SettingsNamespace` union (`'site' | 'terminal-shortcuts' | … | 'notifications-mesh'`)
     + `registerSettingsBroadcaster` / `broadcastSettingsUpdate`. **Adding
     `'port-maps'` to this union is the cheapest way to push "the list changed".**
   - `/Users/konata/code/tmex-r32/apps/gateway/src/events/broadcaster.ts:1-16` — event
     notify bridge, same shape.
2. **Mesh WS (`/mesh/ws`)** — `MeshRoutes`,
   `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/mesh-routes.ts`. Upgrade at `:172-174`,
   socket set `meshSockets` (`:118`), `broadcastNodeEvent()` at `:529-…` (encodes
   `KIND_NODE_EVENT` from the `PeerLinkProvider.onNodeEvent` subscription registered at
   `:130-132`), `broadcastRtcSignal` at `:134-136`, targeted push
   `forwardEnrollRedeemed()` at `:385-413`. This is the right bus for
   **live traffic counters / tunnel up-down**, since it is already node-scoped and
   subscribed by the settings UI.

`mesh-internal` routes (node→node, peer-marker gated) live at
`/Users/konata/code/tmex-r32/apps/gateway/src/mesh/mesh-internal-tmux-routes.ts` and
`mesh-internal-notifications-routes.ts`; entry `handleMeshInternalTmuxRequest()` (`:186-201`).

REST route registration for browser-facing APIs:
`/Users/konata/code/tmex-r32/apps/gateway/src/api/index.ts:26-43` (`apiRoutes` array),
`route()` helper + typed path params at
`/Users/konata/code/tmex-r32/apps/gateway/src/api/route.ts:43-71`.

---

## 7. Relay quota / metering touchpoints

Everything happens in the relay's stream router, once per relayed stream:

- **Concurrent-stream quota**: `ctx.registry.reserveStream(tenantId, quota.maxStreams)`
  before the (async) `openStream` to prevent concurrent OPENs slipping through —
  `/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-stream-router.ts:52-66`
  (comment at `:53` explains the ordering). Released in `release()` (`:61-66`) /
  `pumpRelayPair` finish/abort (`:107-116`). Registry at
  `apps/gateway/src/relay/relay-registry.ts:146-174`
  (`reserveStream`, `releaseStream`, `reserveMemberPair`, `memberKey`).
- **Bandwidth token bucket (per tenant)**: `RelayTokenBucket` —
  `/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-quota.ts:99-295`.
  Capacity = 1 s of rate; per-logical-stream round-robin (`createStream()` at `:135-141`);
  a priority bypass lane for frames ≤ `RELAY_TOKEN_BUCKET_BYPASS_BYTES = 4 KiB` (`:69`,
  `:150`, `:159-172`) so control/window frames aren't head-of-line blocked by bulk.
  **Delays, never drops.** Applied in `pumpMetered` at `relay-stream-router.ts:153`.
- **Metering**: `RelayMetering` —
  `/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-metering.ts:23-141`.
  `record(tenantId, {bytesIn,bytesOut})` (tenant, both directions counted per forwarded
  byte), `recordMember(tenantId, nodeId, …)` (directional), `recordAdmitted()` (post-token
  bucket). Flushed to `RelayTenantStore.addUsage` every
  `RELAY_METER_FLUSH_MS = 30_000` (`relay/types.ts:12`) and on stop. Call sites
  `relay-stream-router.ts:146-154`.
- **Quota parsing/limits**: `/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-quota.ts:8-65`
  (`RELAY_QUOTA_MAX_NODES_LIMIT = RELAY_CTL_MAX_NODES = 256`,
  `RELAY_QUOTA_MAX_STREAMS_LIMIT = 65_536`,
  `RELAY_QUOTA_MAX_BANDWIDTH = 10 GiB/s`); defaults
  `RELAY_DEFAULT_QUOTA = { maxNodes: 16, maxStreams: 64, bandwidthBytesPerSec: null }`
  (`relay/types.ts:35-39`).
- **Metrics surface**: `/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-metrics.ts`
  (`RelayMetricsTotals`/`RelayMetricsTenant` with `activeStreams`, `bytes*PerSec`,
  `quota`/`usage` blocks; `RELAY_METRICS_INTERVAL_MS = 5_000`,
  `RELAY_METRICS_HISTORY_LIMIT = 60`). Consumed by the FE via
  `packages/api-client/src/relay/{admin-api,tenant-api,metrics-types}.ts`.

⚠️ **Key consequence for port mapping:** because a peer link over relay is *one* relay
stream carrying a nested mux (§1.5), a tunnel through relay is metered and rate-limited
automatically as part of that single stream. It costs **1** against `maxStreams`, not one
per TCP connection. That is good for fair-share accounting but means the relay cannot
distinguish tunnel bytes from terminal bytes — if round-32 wants per-feature quota, the
distinction must be made **on the node** (see Recommended design).

---

## 8. Tests and e2e harness

### 8.1 In-process integration suites (plain `bun test`)

- `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/integration/mesh.integration.test.ts`
  (1529 lines) — two in-process `MeshRuntime`s over an in-memory link: login fan-out via
  `/n/<id>`, re-enroll idempotency, revoked rejection, WS forwarding, relay SecureChannel
  (no plaintext leak), upload abort, SSO, forgery attempts, share 4410/4401.
- Also in that folder: `direct-path.integration.test.ts`, `dc-http-bulk.integration.test.ts`,
  `hub-contract.integration.test.ts`, `hub-peer-poll.integration.test.ts`,
  `large-push.integration.test.ts` (+ `large-push-harness.ts`),
  `multi-hub.integration.test.ts` (+ `multi-hub-harness.ts`),
  `rtc-wake.integration.test.ts`, **`stream-failover.integration.test.ts`**,
  `wiring.test.ts`.
- `/Users/konata/code/tmex-r32/apps/gateway/src/relay/integration/` —
  `relay.integration.test.ts`, `relay-membership.integration.test.ts` (quotas!),
  `relay-password-join.integration.test.ts`, harnesses `relay-mesh-harness.ts`,
  `relay-tenant-ops.ts`, `relay-test-tenant.ts`.
- Loopback RTC: `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/rtc/rtc-loopback.integration.ts`
  — `node↔node DataChannelLink + LinkMux round-trip` at `:133-146`. **Exactly the harness
  to extend for a tunnel stream over DC.**
- Mux unit tests: `/Users/konata/code/tmex-r32/packages/shared/src/link/mux.test.ts`
  (721 lines) — the reference for window/RST/END semantics.

### 8.2 Playwright mesh e2e (real 2-process hub+node)

- Run: `cd apps/fe && bun run scripts/run-e2e.ts --project mesh`.
  `applyMeshFlags()` at `/Users/konata/code/tmex-r32/apps/fe/scripts/run-e2e.ts:76-89`
  sets `TMEX_E2E_MESH=1`, `TMEX_E2E_MESH_ONLY=1`.
  Projects registered in `/Users/konata/code/tmex-r32/apps/fe/playwright.config.ts:33-48`.
- Supervisor: `/Users/konata/code/tmex-r32/apps/fe/tests/helpers/mesh-boot.ts`
  - **Dedicated tmux sockets** `tmex-mesh-e2e-hub` / `tmex-mesh-e2e-node` (`:32-34`).
  - Port allocation `findFreePort()` (`:46-73`), used at `:354-357` for
    hub/node gateway ports from 19771 and peer ports from 39771.
  - `renderAppEnv()` (`:95-118`) writes per-instance `GATEWAY_PORT`, `DATABASE_URL`,
    `TMEX_PEER_PORT`, `TMEX_PEER_BIND_HOST=127.0.0.1`, `TMEX_TMUX_SOCKET`, `TMEX_ROLES`.
  - `startInstance()` (`:153-171`) `Bun.spawn` on `packages/app/src/runtime/server.ts`.
  - `cleanup()` (`:313-328`) SIGTERMs children then `tmux -L <socket> kill-server`.
- Specs: `apps/fe/tests/mesh-login.spec.ts`, `mesh-notify.spec.ts`, `mesh-passkey.spec.ts`,
  `mesh-share.spec.ts`; helpers `apps/fe/tests/helpers/mesh.ts`
  (`bootMesh` `:66-106`, `stopMesh` `:108-133`, `meshTmux` `:140-146`).

### 8.3 Docker harness (hub + 2 nodes + caddy)

`/Users/konata/code/tmex-r32/scripts/hub-e2e/` — `Dockerfile`, `docker-compose.yml`
(services `caddy`/`hub`/`node-a`/`node-b`/`driver`; node-b deliberately off the hub network
so its reach starts as `relay`), `run.sh` (9 scenarios), driver TS under `driver/`.
Run: `TMEX_TARBALL=/path/tmex-cli-x.y.z.tgz scripts/hub-e2e/run.sh`; teardown
`scripts/hub-e2e/run.sh down`. Split (real remote hub) variant under
`scripts/hub-e2e/split/`. Doc: `/Users/konata/code/tmex-r32/docs/hub/2026082801-hub-docker-e2e.md`.

### 8.4 Scripts

Root `package.json`: `test` = `bun run --filter '*' test`, `test:unit` =
`bun scripts/ci/unit-tests.ts`. `apps/gateway/package.json`: `test` = `bun test`, plus
`test:live:*` for `*.integration.ts` (not auto-discovered). `apps/fe/package.json`:
`test:e2e` = `bun run scripts/run-e2e.ts`. **There is no `test:mesh` script.**

### 8.5 Recorded hazards (AGENTS.md + code)

- `AGENTS.md:8` — never touch the machine's production tmex (launchd, port 9883,
  `~/Library/Application Support/tmex/`). Always start temp instances in-repo with explicit
  `GATEWAY_PORT` / `TMEX_BIND_HOST` / `TMEX_FE_DIST_DIR` overrides.
- `AGENTS.md:9` — **never** touch the tmux session literally named `tmex`. Always use a
  dedicated socket (`tmux -L tmex-e2e`); `kill-server` nukes an entire socket.
- `AGENTS.md:10` — three-tier env; tests always `NODE_ENV=test` (`test.env`).
- `apps/fe/playwright.config.ts:60-71` throws if an e2e port is occupied by an unknown
  process (guards against hitting production 9663/9883);
  `apps/fe/tests/global-setup.ts` asserts the connected gateway really is `NODE_ENV=test`.
- ⚠️ For port mapping specifically: e2e tests must bind **ephemeral** listen ports on
  `127.0.0.1` only, never a fixed port, and must assert cleanup — a leaked `Bun.listen`
  survives the test process only if not `unref`'d, but a leaked *port reservation* will
  break reruns.

---

## 9. Hazards to design around (derived from the above)

1. **`MAX_LINK_UNACKED = 65 MiB` closes the whole link.** `mux.ts:520-525` calls
   `protocolError()` → `close()`. With `INITIAL_STREAM_WINDOW = 1 MiB` per stream, ~66
   simultaneously saturated streams on one peer link is fatal — and `streamWindow` is a
   *mux-wide* constructor option (`mux.ts:411`), not settable per stream. A port map with
   many concurrent TCP connections must cap its own concurrency (suggest ≤ 32 tunnel
   streams per peer) or the tunnel will kill the terminal session's link.
2. **`MAX_MUX_STREAMS = 256` / `PEER_MAX_CONCURRENT_STREAMS = 256`** (`mux.ts:25`,
   `peer-manager-state.ts:23`) is the hard ceiling on concurrent connections per peer;
   exceeding it RSTs (`peer-live-registry.ts:244`, `:262`) or protocol-errors
   (`mux.ts:718-721`).
3. **Transport upgrade pins the old carrier.** A long-lived tunnel stream keeps a retiring
   `relay` link alive indefinitely (`peer-link-drain.ts:191`), so a DC upgrade won't
   actually move existing tunnel traffic onto the fast path. Conversely a `missed-pong`
   /`idle` retire hard-closes after 30 s (`:187-190`).
4. **Streams do not survive link loss.** `finishClose()` aborts every stream
   (`mux.ts:791-804`). The existing answer is application-level failover
   (`forwarder-failover.ts`, `STREAM_FAILOVER_BACKOFF_MS`) — a TCP tunnel cannot replay
   bytes, so the correct behaviour is to close the local TCP socket (RST) and let the
   client reconnect.
5. **Relay sees one stream per peer pair**, so relay-side quota cannot isolate tunnel
   traffic (§7).
6. **`managed-migrations.ts` must be updated by hand** for any new migration (§5.2).
7. **Drizzle snapshots 0033–0048 are missing** — verify generated SQL (§5.2).

---

# Recommended design

## Shape

`A:5678 → B:12345`. A owns the listener; B owns the dialer. Nothing else changes.

```
TCP client ──connect──> [node A: Bun.listen 127.0.0.1:5678]
                              │  one LinkStream per accepted socket
                              │  openPayload {"type":"tcp","port":12345,"host":"127.0.0.1","mapId":…}
                              ▼
                    PeerManager.getLink(B)  ── LinkMux ──┐
                              │                          │
        ┌─────────────────────┼──────────────────────────┴─ transport chosen by peer-dialer:
        │  dc (WebRTC)  │  ws-secure (LAN/WAN)  │  relay (hub or public relay)
        └─────────────────────┼──────────────────────────┐
                              ▼
                    [node B: acceptTcpStream] ──Bun.connect──> 127.0.0.1:12345
```

## 1. Transport primitive — reuse `LinkSession`, add one stream type

Do **not** build a new transport. Add `type: 'tcp'` to the existing open-payload
classifier:

- `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/types.ts` — add
  `TcpStreamOpenPayload = { type: 'tcp'; mapId: string; host: string; port: number }`.
- `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/stream-targets.ts:583-597` —
  `classifyOpenPayload` returns `'tcp'` when `open.type === 'tcp'`.
- `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/peer-live-registry.ts:257` and `:312` —
  allow `'tcp'` and dispatch to `acceptTcpStream(stream, { peerNodeId, … })`.

This automatically gives you: authenticated + encrypted peer identity (§3.1), credit-based
flow control (§1.1), transport selection with DC/ws-secure/relay failover and dial racing
(§1.3), relay tenant isolation and metering (§1.5, §7), and idle-link keepalive while a
tunnel stream is open (§1.7). Zero relay-side or hub-side changes.

**Authorization inside `acceptTcpStream`:** the peer link only proves *which node* is
calling, not *which user action*. Add an explicit allow-list check on B: the requested
`{host, port}` must match an **enabled, non-paused** row in B's own `port_map_exports`
table (or an "allow any port from my own mesh peers" node setting, default off). Do not
let an arbitrary peer dial arbitrary ports — that would turn every node into an open SOCKS
proxy for the mesh.

## 2. TCP listener on node A

New module, modelled on `apps/gateway/src/tunnel/spawn.ts` + `peer-server.ts`:

```
apps/gateway/src/portmap/
  types.ts             // PortMapRow, PortMapStatus, error codes  (+ shared contract, §5)
  port-probe.ts        // isPortFree(host, port) — bind+close, per family (copy pickFreePort shape)
  listener.ts          // class PortMapListener: Bun.listen + per-socket LinkStream pump
  pump.ts              // socket <-> LinkStream bidirectional pump w/ backpressure
  accept-tcp-stream.ts // node B side: openPayload -> allow-list check -> Bun.connect -> pump
  manager.ts           // PortMapManager: CRUD, boot resume, pause/resume, counters, stop()
  store.ts             // drizzle CRUD + MemoryPortMapStore (mirror tunnel/config-store.ts)
  routes.ts            // /api/portmap/* (browser) — registered in api/index.ts:26-43
  internal-routes.ts   // /api/mesh-internal/portmap/* (peer) — port probe on B, guarded by requirePeerMarker
```

- **Listener**: `Bun.listen({ hostname, port, socket: { open, data, drain, close, error } })`.
  Default `hostname: '127.0.0.1'`; binding `0.0.0.0` must be an explicit opt-in flag on the
  row (it exposes B's service to A's LAN).
- **Occupied-port detection**: before persisting a row, run `isPortFree(host, port)`
  (bind + immediate close, one attempt per address family, mirroring
  `PeerServer.start()`'s per-host error aggregation at `peer-server.ts:83-111`). Reject with
  `PORT_IN_USE` 409. Re-check at boot resume: if the port is taken at startup, keep the row
  but mark it `error` and surface it in the list dialog rather than crashing the runtime
  (same philosophy as `HttpsListener.apply()` storing `lastError`).
- **Cleanup**: register `manager.stop()` in the mesh `stopQuietly` list at
  `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/mesh-runtime.ts:1449-1471` **and** in
  `GatewayRuntime.stop()` at `apps/gateway/src/runtime.ts:297-315`. `stop()` must
  `server.stop(true)` every listener and `reset()` every open stream.

## 3. Dialer on node B

`acceptTcpStream(stream, ctx)`:
1. `parseOpenPayload(stream.openPayload)` (`peer-protocol.ts:520-529`).
2. Allow-list check (§1 above) → `stream.reset('portmap-forbidden')` on failure.
3. `Bun.connect({ hostname, port, socket: {...} })` with a connect timeout (~5 s) →
   on failure `stream.reset('portmap-connect-failed')`.
4. Bidirectional pump (below).

## 4. Flow control / pump

The mux already does the hard part; the pump must simply not defeat it.

- **Remote → local TCP**: read from `stream.readable` with a reader loop (the
  `pumpMetered` shape in `relay-stream-router.ts:119-184` is the reference). Only pull the
  next chunk after `socket.write()` reports it was accepted; when Bun's socket signals
  back-pressure (`write()` returns a short count), wait for `drain` before the next
  `reader.read()`. Because the mux only issues `WINDOW` credit on read
  (`mux.ts:320-345`), *not reading* is precisely how you push back-pressure across the
  mesh. Never buffer unboundedly.
- **Local TCP → remote**: in the socket `data` handler, `await stream.write(bytes)`. That
  promise resolves only when the bytes fit in the send window
  (`mux.ts:257-299`), so pause the socket while it is pending and resume after. Chunks
  larger than 256 KiB are split automatically.
- **Half-close**: TCP FIN from the local side → `stream.end()`; peer `END` (reader `done`)
  → `socket.end()`. Abort/RST both ways → `stream.reset()` / `socket.terminate()`, wired
  through `stream.onAbort(...)` (`types.ts:66`).
- **Sizing**: no extra buffering layer. 1 MiB window × 256 KiB frames is already tuned for
  the DC fragmenter (16 KiB fragments, `fragment-core.ts:4`) and the WS back-pressure
  limits (1 MiB server / 4 MiB client, `websocket-link.ts:24-28`).
- **Concurrency cap** (hazard §9.1/§9.2): enforce a per-peer live-tunnel-stream cap in the
  manager, default **32**, hard max 64. Beyond it, refuse the TCP accept (close the socket
  immediately) rather than opening a stream that could trip `MAX_LINK_UNACKED` and kill the
  peer link that also carries the user's terminal.

## 5. Routing and failover

- Routing is delegated entirely to `PeerManager.getLink(B)`
  (`peer-manager.ts:427-456`): DC preferred (rank 3), then ws-secure (2), then relay (1)
  (`peer-manager-state.ts:30-34`), with the round-29 dial race
  (`peer-dial-race.ts:18-19`) and round-17 breaker (`rtc/rtc-dial-breaker.ts`).
- **Per-connection, dial lazily.** Call `getLink()` at TCP-accept time, not at
  listener-start time; an idle port map should hold no link (avoids pinning a link for 5 min
  past its `PEER_IDLE_MS`).
- **On link loss, do not replay.** `stream.onAbort` → close the local TCP socket. Byte
  streams have no resumption point; replaying would corrupt the protocol. Surface the drop
  as a counter and a `NODE_UNREACHABLE`-style status in the list dialog. This is the one
  place where the port map deliberately *does not* imitate `forwarder-failover.ts`.
- **Transport upgrade (hazard §9.3):** long-lived tunnel streams pin the old carrier. Two
  acceptable answers: (a) accept it — new connections use the upgraded link, existing ones
  finish on the old one; or (b) on `peers.transportOf(nodeId)` improving, mark existing
  streams "stale" and let the manager RST them only if the user has enabled a
  "reconnect on faster path" toggle. **Recommend (a)** for round 32; it needs no code and
  matches TCP semantics.

## 6. Relay mode / quota

No relay-side change. A tunnel rides inside the existing single relay stream per peer pair
(§1.5) and is therefore already counted once against `maxStreams` and rate-limited by the
tenant `RelayTokenBucket` (`relay-quota.ts:99-295`), with bytes flowing into
`RelayMetering` (`relay-metering.ts:23-141`) and out to `relay-metrics.ts`.

If round 32 wants **per-feature fair share**, do it on the node, not the relay: give the
port-map manager its own local token bucket (reuse `RelayTokenBucket` verbatim — it is
transport-agnostic) applied only when `peers.transportOf(nodeId) === 'relay'`, with a
conservative default (e.g. 2 MiB/s per node, configurable). That keeps a bulk `rsync`
through a port map from starving the terminal session sharing the same relay stream, and
it is enforceable without trusting the relay operator's quota configuration.

## 7. Persistence

New schema file `/Users/konata/code/tmex-r32/apps/gateway/src/db/schema/portmap.ts`,
`export *`'d from `apps/gateway/src/db/schema.ts`. Following the `watchRules` /
`tunnelConfig` conventions (§5.1, §5.3):

```ts
export const portMaps = sqliteTable('port_maps', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // A side (this node = listener)
  listenHost: text('listen_host').notNull().default('127.0.0.1'),
  listenPort: integer('listen_port').notNull(),
  // B side
  targetNodeId: text('target_node_id').notNull(),
  targetHost: text('target_host').notNull().default('127.0.0.1'),
  targetPort: integer('target_port').notNull(),
  paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [ index('port_maps_listen_idx').on(t.listenHost, t.listenPort) ]);

// what THIS node allows inbound peers to dial (node B's allow-list)
export const portMapExports = sqliteTable('port_map_exports', { /* host, port, enabled, note */ });
```

- Migration `apps/gateway/drizzle/0049_port_maps.sql` **plus** appending both filenames to
  `MIGRATIONS` in `/Users/konata/code/tmex-r32/apps/gateway/src/db/managed-migrations.ts:9-58`
  (hazard §9.6). Inspect the generated SQL (hazard §9.7).
- Store: `PortMapStore` + `MemoryPortMapStore` behind `PortMapStoreLike`, copying
  `/Users/konata/code/tmex-r32/apps/gateway/src/tunnel/config-store.ts`.
- **Boot resume**: `PortMapManager.start()` reads
  `store.list().filter(r => !r.paused)` and starts a listener per row —
  the `WatchService.start()` shape (`apps/gateway/src/watch/service.ts:129-137`).
  Call it from `startLiveGatewayServices()` next to `tunnelManager.start()`
  (`apps/gateway/src/runtime.ts:129`). Rows whose port is occupied at boot stay persisted
  with status `port_in_use`.
- **Pause** = stop the listener + RST live streams, keep the row (`paused = true`).
  **Delete** = pause + delete the row.

## 8. API + UI surface

- Browser REST on node A (`apps/gateway/src/api/portmap/routes.ts`, registered in
  `apps/gateway/src/api/index.ts:26-43`):
  `GET /api/portmap` (list + live counters), `POST /api/portmap` (create; 409
  `PORT_IN_USE`), `PATCH /api/portmap/:id` (pause/resume/rename),
  `DELETE /api/portmap/:id`, `GET /api/portmap/probe?port=` (local free-port check).
- Peer RPC on node B (`/api/mesh-internal/portmap/probe`, guarded by the existing
  `requirePeerMarker` entry at `mesh-internal-tmux-routes.ts:186-201`) so the create dialog
  can tell the user "B is not listening on 12345" before saving. Called via
  `Forwarder.forwardInternalHttp` / `MeshAgentBridge` (`mesh-agent-bridge.ts:6-16`).
- The UI itself just calls `/n/<A>/api/portmap` — per-node session cookie handles auth
  (§3.3), no new authorization code.
- Shared contract `packages/shared/src/contracts/portmap.ts` (mirror
  `contracts/tunnel.ts`); FE client `packages/api-client/src/portmap.ts` (mirror
  `share.ts`); UI under `apps/fe/src/pages/settings/nodes/` (next to
  `network-section.tsx` / `direct-section.tsx`) or a new `port-maps/` folder.
- **Push**: add `'port-maps'` to `SettingsNamespace`
  (`/Users/konata/code/tmex-r32/apps/gateway/src/settings/broadcaster.ts:4-16`) for
  list-changed notifications; for live byte counters / per-map up-down, emit a throttled
  frame on the mesh WS (`MeshRoutes`, `mesh-routes.ts`) with a new
  `KIND_PORTMAP_EVENT = 0x0a06` — remember `ws-borsh/kind-doc-drift.test.ts` requires the
  kind be documented.
- i18n keys go in `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json`, then
  `bun run build:i18n`. **Never lint/format `resources.ts` / `types.ts`** (AGENTS.md).

## 9. Tests

- Unit: `port-probe.test.ts` (bind/collision on an ephemeral port), `pump.test.ts`
  (half-close, RST, back-pressure) using `createInMemoryLinkPair()`
  (`packages/shared/src/link/in-memory-link.ts`).
- Integration: extend
  `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/integration/` with
  `portmap.integration.test.ts` — two in-process `MeshRuntime`s, a throwaway
  `Bun.listen` echo server as B's target, assert a byte round-trip through the relay path
  and (via `rtc-loopback.integration.ts:133-146`'s harness) the DC path.
- Relay path: add a case to
  `apps/gateway/src/relay/integration/relay-membership.integration.test.ts` asserting the
  tunnel is metered and does **not** consume an extra `maxStreams` slot.
- e2e: optional; if added, bind only ephemeral `127.0.0.1` ports and reuse
  `apps/fe/tests/helpers/mesh-boot.ts`'s `findFreePort` — and obey AGENTS.md's tmux-socket
  and production-instance prohibitions.
