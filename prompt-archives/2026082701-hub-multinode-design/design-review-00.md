Reviewed the full design, prior survey, specified source files, and relevant HTTP/file/runtime call paths. No files were modified.

# 1. Factual errors

- **[blocker] `crypto.sign('ed25519', ...)` is invalid.**  
  **Doc:** §2, “会话令牌”.  
  **Evidence:** Bun’s `node:crypto` compatibility layer throws `ERR_CRYPTO_INVALID_DIGEST` for that call; Ed25519 requires `algorithm = null` or `undefined`, as documented by [Node.js crypto](https://nodejs.org/api/crypto.html#cryptosignalgorithm-data-key-callback).  
  **Suggested change:** Specify `sign(null, payloadBytes, privateKey)` and `verify(null, payloadBytes, publicKey, signature)`, including exact key serialization formats.

- **[blocker] Existing Borsh `seq` cannot provide transport-switch continuity.**  
  **Doc:** §1 “帧序号边界”, §4 “SwitchableTransport”, risk item on Borsh `seq`.  
  **Evidence:** The envelope has a plain `u32 seq` ([schema.ts:8](/Users/konata/code/tmex-enhanced/packages/shared/src/ws-borsh/schema.ts:8)); each browser client instance owns its own counter ([client.ts:94](/Users/konata/code/tmex-enhanced/packages/ws-client/src/client.ts:94), [client.ts:502](/Users/konata/code/tmex-enhanced/packages/ws-client/src/client.ts:502)); each server socket gets a separate generator ([codec-borsh.ts:19](/Users/konata/code/tmex-enhanced/apps/gateway/src/ws/borsh/codec-borsh.ts:19)). Receivers decode and dispatch `seq` but do not validate continuity or deduplicate ([protocol-dispatcher.ts:50](/Users/konata/code/tmex-enhanced/packages/ws-client/src/protocol-dispatcher.ts:50), [index.ts:207](/Users/konata/code/tmex-enhanced/apps/gateway/src/ws/index.ts:207)).  
  **Suggested change:** Remove claims that envelope `seq` supports cutover. Define a logical-session cutover protocol with epochs/acknowledged cursors, or keep relay control active and use canonical pane cursors for direct terminal traffic.

- **[blocker] “Existing file chunk protocol” is not reusable as a DataChannel sink/source.**  
  **Doc:** §4 “文件传输”.  
  **Evidence:** Borsh `CHUNK` fragments one WS message and carries `originalKind/originalSeq` ([schema.ts:275](/Users/konata/code/tmex-enhanced/packages/shared/src/ws-borsh/schema.ts:275)); it is unrelated to files. Upload is `init → sequential HTTP PUT → commit NDJSON` ([files.ts:211](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/files.ts:211), [upload-transfer.ts:26](/Users/konata/code/tmex-enhanced/packages/api-client/src/upload-transfer.ts:26)). Download is `prepare NDJSON → HTTP response stream` ([files.ts:353](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/files.ts:353), [files.ts:419](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/files.ts:419)).  
  **Suggested change:** Define a separate bulk protocol: metadata/init, byte offset, bounded data chunks, completion, cancellation, and fallback behavior.

- **[blocker] The proposed `GatewaySocket` interface is insufficient for current handlers.**  
  **Doc:** §3 “虚拟 socket 适配器”.  
  **Evidence:** Current code also depends on numeric `send()` results, `terminate()`, `getBufferedAmount()`, and external drain callbacks ([websocket-send-guard.ts:91](/Users/konata/code/tmex-enhanced/apps/gateway/src/ws/websocket-send-guard.ts:91), [websocket-send-guard.ts:116](/Users/konata/code/tmex-enhanced/apps/gateway/src/ws/websocket-send-guard.ts:116), [websocket-send-guard.ts:174](/Users/konata/code/tmex-enhanced/apps/gateway/src/ws/websocket-send-guard.ts:174), [websocket-send-guard.ts:201](/Users/konata/code/tmex-enhanced/apps/gateway/src/ws/websocket-send-guard.ts:201)). Socket identity is also used as keys in client, canonical-session, agent, barrier, and registry maps ([index.ts:82](/Users/konata/code/tmex-enhanced/apps/gateway/src/ws/index.ts:82), [types.ts:19](/Users/konata/code/tmex-enhanced/apps/gateway/src/ws/types.ts:19)).  
  **Suggested change:** Separate a logical `GatewaySession` from its carrier. Define carrier operations for send status, queued bytes, drain notification, close, and terminate.

- **[should-fix] Frontend state is not universally keyed by `deviceId`.**  
  **Doc:** “现状代码事实”, §4 “store 复合键…只改键的构造与解析处”.  
  **Evidence:** Only tmux state has device-indexed maps ([tmux-state.ts:24](/Users/konata/code/tmex-enhanced/packages/stores/src/tmux-state.ts:24)). Agent subscriptions are keyed by session ID ([agent.ts:27](/Users/konata/code/tmex-enhanced/packages/stores/src/agent.ts:27)); file expansion is keyed by `rootId + path` ([file-tree.ts:5](/Users/konata/code/tmex-enhanced/packages/stores/src/file-tree.ts:5)). The store layer already supports independently instantiated per-gateway runtimes ([app-runtime.ts:23](/Users/konata/code/tmex-enhanced/packages/stores/src/app-runtime.ts:23)).  
  **Suggested change:** Correct the current-state description and remove the “only key construction” estimate.

- **[should-fix] There is no `runtime.fetch()`.**  
  **Doc:** §1 and §3 HTTP forwarding.  
  **Evidence:** `GatewayRuntime` exposes `handleRequest(req, bunServer)` plus separate WebSocket callbacks ([runtime.ts:35](/Users/konata/code/tmex-enhanced/apps/gateway/src/runtime.ts:35), [runtime.ts:123](/Users/konata/code/tmex-enhanced/apps/gateway/src/runtime.ts:123)).  
  **Suggested change:** Specify a new transport-neutral `dispatchHttp(Request)` API and keep Bun upgrade handling outside it.

- **[should-fix] Native package selection is not just `process.platform/arch`.**  
  **Doc:** §5 `direct enable|disable`.  
  **Evidence:** Current `node-datachannel` packages distinguish architecture and libc, such as `linux-x64-gnu` versus `linux-x64-musl`; see the project’s [official package metadata](https://raw.githubusercontent.com/murat-dogan/node-datachannel/v0.33.1/package.json). The current install layout also has no native directory field ([install-layout.ts:14](/Users/konata/code/tmex-enhanced/packages/app/src/lib/install-layout.ts:14)).  
  **Suggested change:** Add a pinned manifest mapping platform, architecture, libc, package name, addon filename, integrity, and expected N-API version.

# 2. Design gaps that would break implementation

- **[blocker] JavaScript cannot send the HttpOnly session cookie as the DataChannel `{token}` frame.**  
  **Doc:** §2 “WebRTC”.  
  **Evidence:** The only defined browser credential is the HttpOnly `tmex_session` cookie, while the DataChannel requires browser JavaScript to send a token. No readable token-minting endpoint is defined.  
  **Suggested change:** Have the authenticated hub mint a short-lived, hub-signed RTC ticket bound to `uid`, `nodeId`, `sessionId`, and expiry. Send that ticket—not the session cookie—to the node.

- **[blocker] Cookie scope is incomplete and the hub-cookie offline-login step cannot work across origins.**  
  **Doc:** §2 “会话令牌” and “本地可用”.  
  **Evidence:** `Path=/` is not specified, so a cookie set by `/api/hub/auth/login` defaults to a narrower path and will not authenticate `/ws` or `/n/*`. A host-only hub cookie is never sent to a node’s LAN/loopback origin. Node-local self-signed cookie behavior is unspecified.  
  **Suggested change:** Explicitly define hub cookies as `Path=/; HttpOnly; Secure; SameSite=Lax` with no `Domain`. Treat node-local access as a separate login and separate origin-scoped cookie; define its HTTPS/loopback `Secure` behavior.

- **[blocker] A new direct carrier is a new server session, not a transparent continuation.**  
  **Doc:** §4 “SwitchableTransport”.  
  **Evidence:** The server rejects every non-`HELLO` message on a fresh socket ([index.ts:316](/Users/konata/code/tmex-enhanced/apps/gateway/src/ws/index.ts:316)). Device attachment, selected panes, pane subscriptions, canonical sessions, and agent subscriptions are socket-local ([device-connection-registry.ts:192](/Users/konata/code/tmex-enhanced/apps/gateway/src/ws/device-connection-registry.ts:192), [agent.ts:84](/Users/konata/code/tmex-enhanced/packages/stores/src/agent.ts:84)). The client sends `HELLO` only when its socket opens ([client.ts:223](/Users/konata/code/tmex-enhanced/packages/ws-client/src/client.ts:223)).  
  **Suggested change:** Define logical session attachment and cutover acknowledgements, including replay of HELLO/device/pane/agent state, or avoid whole-session switching.

- **[blocker] HTTP relay semantics omit URL rewriting, cancellation, and credential filtering.**  
  **Doc:** §3 `http` streams.  
  **Evidence:** Node routing only recognizes `/api/*` ([runtime.ts:139](/Users/konata/code/tmex-enhanced/apps/gateway/src/runtime.ts:139)), while handlers depend on query strings ([files.ts:165](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/files.ts:165), [agent.ts:131](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/agent.ts:131)). File operations rely on `Request.signal` or response-stream cancellation to stop rsync and remove temporary files ([files.ts:288](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/files.ts:288), [files.ts:346](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/files.ts:346), [files.ts:408](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/files.ts:408)).  
  **Suggested change:** Specify stripping `/n/:nodeId`, preserving encoded path and query, filtering hop-by-hop and browser credentials, mapping stream RST to request abort/response cancellation, and hard per-stream/per-uplink buffer limits.

- **[blocker] Role composition is not specified at the packaged-server boundary.**  
  **Doc:** §1 roles, §5 packaging.  
  **Evidence:** The packaged server unconditionally constructs one gateway and delegates every request to it first ([server.ts:23](/Users/konata/code/tmex-enhanced/packages/app/src/runtime/server.ts:23)). Gateway construction always reads site settings, primes tmux, and starts messaging/push/agent/watch services ([runtime.ts:67](/Users/konata/code/tmex-enhanced/apps/gateway/src/runtime.ts:67), [runtime.ts:74](/Users/konata/code/tmex-enhanced/apps/gateway/src/runtime.ts:74), [runtime.ts:109](/Users/konata/code/tmex-enhanced/apps/gateway/src/runtime.ts:109)). Existing options cannot express hub-only startup.  
  **Suggested change:** Add an explicit startup matrix: hub-only creates `HubRuntime`; node-only creates `GatewayRuntime + UplinkClient`; dual role creates both. Define which runtime owns migrations, frontend serving, shutdown, and restart.

- **[should-fix] `/ws` and `/api/hub/*` routing collides with the existing gateway.**  
  **Doc:** §3 hub-side routing.  
  **Evidence:** `/ws` is currently the gateway protocol endpoint ([runtime.ts:128](/Users/konata/code/tmex-enhanced/apps/gateway/src/runtime.ts:128)); all `/api/*` requests are consumed by gateway dispatch, including unknown paths ([api/index.ts:42](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/index.ts:42)). A hub handler placed after the current gateway never sees `/api/hub/*`.  
  **Suggested change:** Reserve `/hub/ws` for hub control/signaling and dispatch `/api/hub/*` before gateway routes. Retain `/ws` for standalone/node-local gateway access.

- **[should-fix] Node-scoped `ApiClient` does not cover raw asset URLs and existing direct `fetch` calls.**  
  **Doc:** §4 “寻址”.  
  **Evidence:** File media/download helpers construct unscoped `/api/files/*` URLs ([file-urls.ts:3](/Users/konata/code/tmex-enhanced/packages/api-client/src/file-urls.ts:3)); `FilePage` places them directly in `src`/`href` attributes ([FilePage.tsx:98](/Users/konata/code/tmex-enhanced/apps/fe/src/pages/FilePage.tsx:98)). Some FE settings code still calls global `fetch('/api/...')` directly.  
  **Suggested change:** Add a runtime/base-URL resolver for fetches, media sources, iframes, links, and downloads; migrate every direct global fetch.

- **[should-fix] The hub cannot render offline devices after a fresh page load.**  
  **Doc:** §4 “设备灰显”.  
  **Evidence:** The proposed hub schema stores node metadata but no cached device inventory; device records remain only in each node database. Once a node is offline, the hub has no device names or IDs to flatten.  
  **Suggested change:** Cache a minimal last-known inventory per node, preferably one versioned `inventory_json` field for v1, or change the UI requirement to show only an offline node row.

- **[should-fix] DataChannel message sizing and backpressure are underspecified.**  
  **Doc:** §3 WebRTC channels.  
  **Evidence:** Merely setting `bufferedAmountLowThreshold` does not establish a high-water limit or pause writes. Existing Borsh frames can be 1 MiB ([codec.ts:11](/Users/konata/code/tmex-enhanced/packages/shared/src/ws-borsh/codec.ts:11)), and HTTP upload chunks are 8 MiB ([files.ts:40](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/files.ts:40)); neither is guaranteed to fit one negotiated SCTP message.  
  **Suggested change:** Negotiate a conservative message limit, fragment above it, define high/low-water send queues on both browser and node, and close/rebase on dropped fragments. The existing canonical protocol’s 32 KiB limit is a suitable starting point ([canonical-state.ts:10](/Users/konata/code/tmex-enhanced/packages/shared/src/ws-borsh/canonical-state.ts:10)).

# 3. Simplifications

- **[should-fix] Keep relay as the control plane; move only terminal data/input and bulk direct.**  
  **Doc:** §4 whole-WS switching.  
  **Evidence:** The existing canonical protocol already has `paneEpoch`, `seqStart/seqEnd`, terminal cursors, replay gaps, and idempotent `inputId` ([canonical-state.ts:84](/Users/konata/code/tmex-enhanced/packages/shared/src/ws-borsh/canonical-state.ts:84), [canonical-state.ts:106](/Users/konata/code/tmex-enhanced/packages/shared/src/ws-borsh/canonical-state.ts:106), [canonical-state.ts:173](/Users/konata/code/tmex-enhanced/packages/shared/src/ws-borsh/canonical-state.ts:173)).  
  **Suggested change:** Keep metadata, agent, watch, settings, and signaling on relay; select relay/direct only for canonical terminal streams. This removes full WS session migration while preserving WebRTC latency gains.

- **[should-fix] Use one existing `AppRuntime` per node instead of globally rewriting every ID.**  
  **Doc:** §4 compound `nodeId/deviceId` keys.  
  **Evidence:** `createGatewayConnection`, injectable `ApiClient`, `createAppRuntime`, storage prefixes, and `RuntimeProvider` already form a per-gateway isolation boundary ([connection.ts:33](/Users/konata/code/tmex-enhanced/packages/ws-client/src/connection.ts:33), [runtime.ts:122](/Users/konata/code/tmex-enhanced/packages/stores/src/runtime.ts:122), [app-runtime.ts:23](/Users/konata/code/tmex-enhanced/packages/stores/src/app-runtime.ts:23), [react.tsx:17](/Users/konata/code/tmex-enhanced/packages/stores/src/react.tsx:17)).  
  **Suggested change:** Let `NodeConnectionManager` own a per-node connection, API client, and app runtime. Use `nodeId/deviceId` only in routing and the aggregated sidebar projection.

- **[should-fix] Defer UPnP/NAT-PMP SDP injection.**  
  **Doc:** §1 NAT strategy item 4.  
  **Evidence:** The document itself marks candidate injection as unverified and allows it to degrade to logging. Standard ICE host/IPv6/STUN/TURN plus hub fallback already satisfies the confirmed connectivity decision.  
  **Suggested change:** Remove this from v1 implementation scope; retain it as a post-PoC optimization.

- **[nit] Do not implement placeholder multi-user APIs.**  
  **Doc:** §3 `/api/hub/users`, auth bundles with user arrays.  
  **Evidence:** v1 is explicitly single-user, with multi-user only reserved in schema.  
  **Suggested change:** Keep `user_id` columns and identity tables, but omit `/api/hub/users`, user-management UI, and generalized authorization branches until multi-user work begins.

- **[nit] Do not serialize the in-process uplink through MessagePort and the binary mux.**  
  **Doc:** §1 and §3 dual role.  
  **Evidence:** Both roles share a Bun process and require neither isolation nor cross-thread transport.  
  **Suggested change:** Implement an in-memory duplex stream adapter against the same `UplinkSession` interface; test the binary codec separately.

# 4. Security holes (concrete only)

- **[blocker] Forwarding browser headers exposes the hub session to a compromised node.**  
  **Doc:** §3 HTTP OPEN `{method, path, headers}`.  
  **Attack path:**  
  1. The browser sends `Cookie: tmex_session=...` to the hub.  
  2. The hub validates it and forwards all headers to the target node.  
  3. An attacker controlling that node extracts the hub cookie.  
  4. The attacker replays it against the public hub and gains control of every node until expiry/revocation.  
  **Suggested change:** Never forward `Cookie`, `Authorization`, proxy, connection, or forwarding headers. Send only sanitized application headers plus authenticated internal identity metadata. Use node-scoped RTC tickets rather than the hub session token.

- **[should-fix] Automatic OIDC identity binding permits account takeover when the issuer has more than one valid subject.**  
  **Doc:** §2 OIDC flow.  
  **Attack path:**  
  1. The owner configures an OIDC issuer that contains or admits another account.  
  2. Before the owner links an identity, that account logs into tmex.  
  3. Because tmex has one local user and no existing mapping, the attacker’s subject is automatically bound to the owner account.  
  4. The attacker receives a full hub session.  
  **Suggested change:** Require an authenticated local session/password or explicit CLI command to link the first `(issuer, subject)` pair. Do not auto-bind an arbitrary first OIDC login.

- **[should-fix] The token trust matrix is not explicit.**  
  **Doc:** §2 hub- and node-issued tokens.  
  **Attack path:** If hub verification selects a key from `iss`, any enrolled node can mint `{uid: owner, iss: node:<id>}` and authenticate to the public hub.  
  **Suggested change:** State normatively: hub accepts only hub-signed `iss=hub` session cookies; a node accepts hub tokens or tokens signed by that exact node; RTC tickets must be hub-signed and include `aud=node:<id>` and the RTC session ID.

# 5. Open questions for the product owner

1. Must WebRTC replace the entire gateway WS, or may relay remain the control plane while only canonical terminal traffic and bulk use DataChannel?
2. When a node is offline, should the sidebar show its last-known individual devices or only one offline node entry?
3. If DataChannel fails mid-file, should v1 restart the transfer over relay, or must it resume from the acknowledged offset?
4. Which native-direct platforms are release requirements for v1: macOS arm64/x64, Linux glibc arm64/x64, and Linux musl?