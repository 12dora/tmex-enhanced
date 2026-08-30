# Exploration S1 report

Read-only audit completed. No source files or Git state were modified.

The complexity gate currently reports 132 violations. Relevant baseline sizes include:

- `mesh/uplink-client.ts`: 1,372 lines
- `mesh/mesh-runtime.ts`: 1,300 lines
- `mesh/peer-manager.ts`: 2,294 lines
- `mesh/forwarder.ts`: 1,090 lines
- `hub/uplink-server.ts`: 1,447 lines
- `auth/user-key-service.ts`: 1,013 lines
- `tunnel/manager.ts`: 1,215 lines

## 1. HIGH — Forwarder double-decodes `DEVICE_CONNECTED` frames

Location: `apps/gateway/src/mesh/forwarder.ts:155-165`, `:271-293`, `:563-873`

Current structure:

- File: 1,090 lines.
- `StreamReplayState`: 311 lines.
- `handleRemoteBytes()` calls `noteInbound()`, which decodes the envelope.
- For `DEVICE_CONNECTED`, it then calls `noteDeviceConnected()`, decoding the same envelope and payload again.

This occurs on the forwarded WebSocket receive path. A Bun microbenchmark using a 25-byte `DEVICE_CONNECTED` frame and 500,000 iterations measured:

| Operation | Time | Per frame |
|---|---:|---:|
| Decode envelope and payload once | 341 ms | 0.683 µs |
| Decode both twice | 706 ms | 1.411 µs |

The redundant decode costs approximately 0.729 µs per affected frame, or about 52% of the total parsing time in this case.

Proposed split:

- Move `StreamReplayState` into `mesh/stream-replay-state.ts`.
- Change `noteInbound()` to return `{ kind, deviceId? }`.
- Remove `noteDeviceConnected()` and use the already-decoded device ID in `handleRemoteBytes()`.
- Keep HTTP routing, failover, queueing, and socket lifecycle in `Forwarder`.

Expected result:

- `forwarder.ts`: approximately 770–790 lines.
- New replay module: approximately 300–315 lines.
- Expected net change: approximately `-15 to +5` lines.
- `handleRemoteBytes()` remains below CC 15; replay decoding stays encapsulated.

Expected gain: one fewer envelope and payload decode for every `DEVICE_CONNECTED` frame, plus a separately testable replay state machine.

Risk: Medium. The return shape of `noteInbound()` changes, and malformed-frame behavior must remain identical.

Coverage: `forwarder.test.ts:465-879` covers failover, canonical replay, legacy replay, cursor patching, queued frames, and generation races.

## 2. MEDIUM — `UplinkClient` contains an independent key-log synchronization subsystem

Location: `apps/gateway/src/mesh/uplink-client.ts:189-206`, `:555-1129`, `:1156-1192`

Current structure:

- File: 1,372 lines.
- Connection/auth/heartbeat state is mixed with key-log catch-up state.
- Key-log state includes catch-up chains, abort controllers, task tracking, pending requests, acknowledgements, list epochs, list watermarks, fork state, and retry logic.
- The synchronization path begins after `node.list` and controls when the node-list callback is finally emitted.

The current implementation is behaviorally important: reconnect tests cover local-behind, local-ahead, partial apply, retry, fork, stale generations, aborts, and delayed node-list completion. `uplink-client.test.ts` contains more than 20 tests covering this subsystem, including `:1025`, `:1257`, `:1346`, `:1645`, `:1810`, and `:1972`.

Proposed split:

- Extract `UplinkKeyLogSync` into `mesh/uplink-key-log-sync.ts`.
- Move `handleKeyLogRes`, node-list catch-up, `queryKeyLogAt`, `appendAndAck`, request tracking, fork handling, and catch-up cancellation there.
- Keep socket creation, authentication, heartbeat, control dispatch, and state transitions in `UplinkClient`.
- Pass generation/state/link operations through a small explicit context rather than exposing the whole client.

Expected result:

- `UplinkClient`: approximately 790–820 lines.
- `UplinkKeyLogSync`: approximately 560–590 lines.
- Current individual catch-up functions are already below the CC limit; the split primarily reduces class responsibility.
- Expected net change: approximately `-5 to +15` lines, so this should be kept neutral by avoiding wrapper duplication.

Expected gain: clearer ownership of the reconnect consistency protocol and smaller mutation surface around generation/abort handling. No guaranteed runtime speedup.

Risk: High. Reset ordering, stale generations, pending acknowledgements, and fork teardown are tightly coupled.

Coverage: `uplink-client.test.ts` key-log tests listed above; `mesh-runtime.test.ts:587-906`; hub integration tests.

## 3. MEDIUM — `UserKeyService` mixes cryptographic replay with database mutation

Location: `apps/gateway/src/auth/user-key-service.ts:650-657`, `:659-804`, `:858-876`, `:909-1012`

Current structure:

- File: 1,013 lines.
- Replay/verification logic is in the same module as transactional persistence.
- `persistApplied()` is 90 lines and performs key-log append, root/head updates, passkey/TOTP changes, certificate changes, peer deletion, and session revocation.
- `persistJoinReplay()` and `bootstrapUserWithSelfAdmit()` also contain transaction setup and reset logic.

Proposed split:

Create `auth/user-key-persistence.ts` containing:

- `AuthStores`
- Transactional store construction
- `persistApplied`
- `wipeUserDerivedState`
- `persistEncryptedIdentity`
- `bindIdentityUser`

Keep record decoding, signature verification, replay state transitions, and join-chain validation in `UserKeyService`.

Expected result:

- `user-key-service.ts`: approximately 865–890 lines.
- New persistence module: approximately 135–150 lines.
- Expected net change: approximately `-5 to +5` lines.
- `replayStep()` and `replayJoinChain()` remain unchanged and retain their current complexity.

Expected gain: cryptographic/replay code becomes independent from most database mutation code. This reduces the chance of changing replay semantics while modifying persistence behavior.

Risk: Medium. Transaction boundaries must remain exactly unchanged.

Coverage: `user-key-service.test.ts:35-887`, especially fork, reset, join, identity, and atomic `applyMany` tests.

## 4. MEDIUM — `mesh-runtime` wiring performs several unrelated assembly jobs

Location: `apps/gateway/src/mesh/mesh-runtime.ts:560-760`, `:762-1077`, `:810-866`

Current structure:

- File: 1,300 lines.
- `constructMeshDeps()`: 201 lines.
- `wireMeshEventsAndSessions()`: 317 lines.
- Inline `onNodeList`: CC 30.
- The wiring function creates the uplink, peer manager, HTTP dispatch bridge, RTC signal router, browser RTC accept path, session callbacks, and state transitions.

The dependencies are genuinely cyclic:

- Uplink node-list events inspect `PeerManager`.
- `PeerManager` forwards browser signals to the RTC router.
- RTC router sends through either `PeerManager` or `UplinkClient`.
- Browser accept callbacks depend on the session registry and RTC state.
- Initialization currently relies on mutable holders to break these cycles.

Proposed split, initially within the same file to preserve line neutrality:

- `createMeshStoresAndServices()`
- `createSessionBindings()`
- `createUplinkWiring()`
- `handleUplinkNodeList()`
- `pruneStaleListedPeers()`
- `createPeerWiring()`
- `createRtcBrowserWiring()`

Expected result:

- `constructMeshDeps()`: approximately 30–45 lines.
- `wireMeshEventsAndSessions()`: approximately 30–50 lines.
- `onNodeList`: split into three functions, each approximately CC 4–8.
- All new functions should remain under 120 lines and CC 15.
- Expected net change: approximately `-5 to +10` lines.

Expected gain: initialization order and callback ownership become visible, making RTC/uplink/session changes safer to review. This does not by itself remove the file-size violation.

Risk: High. The current holders are intentional cycle-breaking state; moving code across modules prematurely could create circular imports or initialization races.

Coverage: `mesh-runtime.test.ts:184-1009`, `mesh-runtime-node-presence.test.ts`, `integration/wiring.test.ts`.

## 5. LOW — Hub uplink rate limiting is an independent subsystem embedded in `UplinkServer`

Location: `apps/gateway/src/hub/uplink-server.ts:119-408`

Current structure:

- File: 1,447 lines.
- `TokenBucket`, `IdleLruMap`, `WindowedLogBudget`, and `KeyLogReqLimiter` occupy approximately 290 lines.
- The limiter is unrelated to authentication, RTC routing, node projection, heartbeat, or relay handling.

The hot path is `onCtl()` → `handleKeyLogReq()` → `KeyLogReqLimiter.take()` at `:711-759`, `:893-941`, and `:329-351`. Overflow cleanup is bounded but scans the overflow user/node maps on requests.

Proposed split:

- Move the four limiter classes and their private helpers to `hub/uplink-rate-limit.ts`.
- Keep the public `KeyLogReqLimiter` API unchanged.
- Do not change the algorithm or convert it into a table-driven implementation.

Expected result:

- `uplink-server.ts`: approximately 1,150–1,170 lines.
- New rate-limit module: approximately 290–305 lines.
- Expected net change: approximately `0 to +15` lines.
- The hub file-size gate would still require an allowlist unless more unrelated code is moved.

Expected gain: clear separation of abuse-control state from uplink protocol state. No material runtime gain expected.

Risk: Low to Medium. Main risk is import/test API churn.

Coverage: `uplink-server.test.ts:1358-1564`, including limiter bounds, TTL, overflow, and request behavior.

## 6. LOW — IPv6 parsing is duplicated across address policy modules

Locations:

- `apps/gateway/src/mesh/mesh-runtime.ts:319-344`
- `apps/gateway/src/mesh/address-class.ts:126-150`
- Caller: `mesh-runtime.ts:346-372`, currently CC 20

The two parsers implement the same compressed IPv6 group expansion algorithm. The surrounding address policies differ, so the complete predicates should not be merged.

Proposed split:

- Export a shared pure `parseIpv6Words()` helper from `address-class.ts`, or place it in a small `mesh/ip-parser.ts`.
- Normalize zone IDs inside the shared helper so both callers preserve current behavior.
- Split `isAdvertisablePeerAddress()` into `isAdvertisableIpv4()` and `isAdvertisableIpv6()`.

Expected result:

- `isAdvertisablePeerAddress()`: approximately 15–18 lines, CC approximately 4–6.
- Shared parser replaces the 26-line local copy.
- Expected net change: approximately `-20 to -30` lines.

Risk: Medium. Existing malformed-address semantics must remain unchanged.

Coverage: `mesh-runtime.test.ts:1133-1189`, `integration/wiring.test.ts:13-130`, `address-class.test.ts:21-63`.

## Exact duplicated blocks

The following are concrete cross-file duplicates found with `rg`:

| Duplicate | Locations | Recommendation |
|---|---|---|
| Handshake timeout Promise, including timer cleanup and `PeerHandshakeError` | `rtc/rtc-peer-manager.ts:136-149`, `rtc/dc-handshake.ts:255-268`, `peer-protocol.ts:162-175` | Extract `withPeerHandshakeTimeout()` into a small shared module. Expected net `-20 to -25` lines. |
| JSON-preserving string helper | `uplink-client.ts:1361-1371`, `peer-manager.ts:2236-2246` | Extract exact `jsonText()` helper. Expected net `-8 to -12` lines. Keep hub’s `stringifyJson()` separate because it intentionally catches cyclic values. |
| IPv6 compressed-group parser | `mesh-runtime.ts:319-344`, `address-class.ts:126-150` | Share only the parser, not the address policy. Expected net `-20 to -30` lines after predicate splitting. |

The timeout helper is covered indirectly by `peer-protocol.test.ts`, `rtc/dc-handshake.test.ts`, and `rtc/rtc-peer-manager.test.ts`. The JSON helper is covered through peer-status and node-list persistence tests.

## PeerManager assessment

`apps/gateway/src/mesh/peer-manager.ts` is 2,294 lines and contains these real responsibilities:

- Dialing and transport fallback: `:1233-1511`
- Link installation and inbound stream binding: approximately `:1513-1680`
- RTC wake, signaling, and waiters: approximately `:836-1231`
- Upgrade scheduling and backoff: `:684-834`
- Control protocol handling: `:1711-1754`
- Peer status projection and key-log exchange: `:1756-1946`
- Parking, retirement, promotion, and timers: `:1948-2233`

A 3–4 module split is not currently a clean seam. The state maps at `:300-344` are shared across all responsibilities:

`dial()` calls `track()`, `track()` can park or retire links, close callbacks call `dropPeer()`, `dropPeer()` promotes parked/retiring links, upgrade scheduling calls `dial()`, and RTC wake/signaling can re-enter `getLink()` and dialing.

Recommendation: allowlist the file and the existing `dial`, `handlePeerCtl`, and `applyPeerStatus` violations. If a future split is needed, the only credible first seam is a transport adapter containing `dialDc`, `dialWsSecure`, `dialDirect`, and relay dialing, with explicit callbacks for `track`, stale-generation checks, key retention, signaling, and RTC wake dispatch. That extraction would likely be neutral to +20 lines and carries more regression risk than current value justifies.

## Violations recommended for allowlisting

| Violation | Reason |
|---|---|
| `mesh/peer-manager.ts` file, `dial` CC22, `handlePeerCtl` CC23, `applyPeerStatus` CC19 | Shared link lifecycle state machine; previous flat-dispatch extraction was intentionally retained. |
| `mesh/stream-pump.ts:5 pumpToLink` CC17 and `mesh/link-stream-carrier.ts:90 pump` CC16 | Queue/backpressure loops; the cross-module extraction was already tried and reverted with an 80-line increase. |
| `mesh/stream-targets.ts:171 acceptHttpStream` CC18 and `:296 openHttpStream` 137 lines | Each function is one authenticated bidirectional protocol transaction. |
| `mesh/rtc/channel-fanout.ts:30 fanoutDataChannel` 135 lines | Event ordering and cleanup are one cohesive channel handoff. |
| `mesh/rtc/bulk.ts:283 pumpDownload` CC17 | Streaming/error cleanup loop; splitting would obscure cancellation semantics. |
| `mesh/rtc/dc-handshake.ts:271 handshakeDataChannel` 128 lines | Handshake state sequence and protocol validation are intentionally sequential. |
| `mesh/session-middleware.ts:36 authenticateRequest` CC17 | Authentication precedence across local, forwarded, and standalone requests. |
| `mesh/auth-routes.ts:301 handlePasskeyRegisterVerify` CC16 | Security validation sequence should remain explicit. |
| `agent/tools/read-screen.ts:27 execute` CC17 | Emulator/capture fallback behavior is one tool operation. |
| `agent/tools/send-input.ts:31 createSendInputTool` 130 lines and `:76 execute` CC26 | Mode-specific terminal input semantics; helper extraction would add wrappers without reducing behavior. |
| `tunnel/external-detect.ts:213 enrichCandidate` CC25 | Candidate enrichment and scoring are one bounded detection pass. |
| `tunnel/external-detect.ts:349 parseCloudflaredYml` CC22 | Grammar-style parser branches should remain visible. |
| `tunnel/manager.ts` file, `status` CC18, `handleAction` CC23 | Stable response contract and action-specific guards; table-driven dispatch would hide semantics. |
| `tunnel/access-jwt.ts:87 verifyAccessJwt` CC19 | Security gate with ordered parsing, signature, and claim checks. |
| `tls/tls-config-store.ts:97 get` CC16 | Per-field fallback/default chain. |
| `api/tunnel-routes.ts:48 parseAction` CC40 | Exhaustive action-specific request validation; a table rewrite would obscure required fields. |
| `ws/index.ts:216 handleMessage` CC16 | Protocol envelope/chunk dispatch is intentionally flat. |
| `mesh/node-list-projection.ts:86 projectMeshListNode` CC20 | Previously retained pure projection logic. |
| Residual file violations in `mesh-runtime.ts` and `hub/uplink-server.ts` | The neutral splits above improve seams but do not fully reduce those files below 900 lines. |

## Dead-export candidates

`rg` found no importer outside the defining module for these definite internal-only exports:

- `tunnel/manager.ts:129 writeNamedConfigYml`
- `tunnel/manager.ts:148 isAccessProtectedHealthResponse`
- `tunnel/manager.ts:56 PatchHostEnv`
- `tunnel/manager.ts:57 ReadHostEnv`

They are used internally but are not imported elsewhere or re-exported through a barrel. Removing only `export` is a zero-line behavioral cleanup.

Barrel-only candidates also have no repository importer beyond their defining file and barrel:

- `UplinkClientOptions`
- `NetworkInterfacesFn`
- `UplinkServerOptions`
- `RtcSessionRegistration`
- `RegisterGatewaySessionInput`
- `RegisterGatewaySessionResult`
- `CONNECTION_ID_BYTES`
- `generateConnectionId`
- `resolveUserId`
- Several `UserKeyService` result/input types

These may be intentional public API. They should be removed from barrels only after checking published consumers.

## Already fine

- Hub node-list broadcasting already encodes once, reuses bytes across links, skips unchanged projections, and drops cache without rebuilding; covered by `uplink-server.test.ts:1675-1783`.
- Uplink generation/abort/fork handling has extensive direct coverage and passed 98/98 relevant tests.
- PeerManager upgrade, parking, retirement, quiesce, and RTC wake behavior are heavily tested; the complexity is not accidental duplication.
- Forwarder failover preserves queued frames, generation fences, canonical cursors, and legacy replay ordering.
- `mesh/ctl.ts` already centralizes JSON byte encoding/decoding; the duplicate `jsonText()` helper is a different semantic operation.
- Security paths for passkeys, JWTs, tunnel actions, and TLS defaults should remain explicit rather than being flattened into generic tables.

## Verification

Passed:

- `peer-protocol`, `dc-handshake`, and `address-class`: 30 passed, 0 failed.
- `user-key-service`, `uplink-client`, and `uplink-server`: 98 passed, 0 failed.

The broader combined run produced 237 passes and 48 failures, but the failures were environmental:

- Bun could not bind the test suite’s ephemeral sockets: `EADDRINUSE`, “port 0 in use”.
- Existing tunnel tests could not create temporary directories: `EPERM` from `mkdtemp`.

These failures were not treated as product regressions.