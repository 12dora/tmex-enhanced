# Split `apps/gateway/src/ws/index.ts`

Scope: `apps/gateway/src/ws/index.ts` plus new sibling modules and tests. No git. Did not touch `canonical-feed-session.ts`, `tmux-command-handlers.ts`, `legacy-feed-broadcaster.ts`, `inbound-frame-decoder.ts`, `error-classify.ts`, or `borsh/*`.

## Files

- **Added** `apps/gateway/src/ws/client-send.ts` (44L)
- **Added** `apps/gateway/src/ws/client-send.test.ts` (4 cases)
- **Added** `apps/gateway/src/ws/hello-negotiation.ts` (83L)
- **Added** `apps/gateway/src/ws/hello-negotiation.test.ts` (4 cases)
- **Added** `apps/gateway/src/ws/client-lifecycle.ts` (90L)
- **Added** `apps/gateway/src/ws/client-lifecycle.test.ts` (7 cases)
- **Added** `apps/gateway/src/ws/canonical-client.ts` (87L)
- **Added** `apps/gateway/src/ws/runtime-attachment.ts` (71L)
- **Added** `apps/gateway/src/ws/command-facade.ts` (303L)
- **Changed** `apps/gateway/src/ws/index.ts` (685L → 224L)
- **Changed** `apps/gateway/src/ws/index.test.ts` (existing cases kept; +HELLO-required, +PING after HELLO, +canonical session reuse)

`WebSocketServer`, `RUNTIME_IDLE_GRACE_MS`, `parseWindowLayoutSize`, and `payloadNeedsChunking` remain importable from `./index`.

## What moved

### Send helpers (`client-send.ts`)

`sendClientEnvelope` / `sendClientChunked` / `sendClientError` own backpressure gating, frame encoding, and ERROR envelopes. Class methods are one-line wrappers so host interfaces and `this.sendEnvelope` overrides still go through the instance.

### HELLO / PING (`hello-negotiation.ts`)

`handleHello` and `handlePing` take a `HelloNegotiationHost` (`sendEnvelope` / `sendError`). Decode failure metadata, `clientImpl` truncation, `agentWsHub.registerClient`, and HELLO_S2C fields are unchanged. `handleBorshMessage` still branches HELLO → PING → `dispatchBorshKind` in the same order.

### Upgrade / client lifecycle (`client-lifecycle.ts`)

`handleUpgrade` (pathname `/ws` + `createBorshClientState`), `openClient`, `handleClientDrain`, `closeClient`, `closeAllClients`. Close still unregisters canonical session, send-guard, switch barrier, session store, agent hub, then walks device entries.

`WebSocketServer.handleUpgrade` now types the server as `WebSocketUpgradeServer` (`upgrade` only). `runtime.ts` still passes the Bun `Server`; that is a compatible widening.

### Canonical subscription bookkeeping (`canonical-client.ts`)

`getOrCreateCanonicalSession` and `sendCanonicalEvent` moved as-is, including the existing `frame as unknown as BufferSource` send-guard call. Attach/detach still updates `canonicalClients` and idle-release timers.

### Runtime attach / release (`runtime-attachment.ts`)

`attachRuntimeListener` is the `DeviceSessionRuntimeListener` that forwards into `LegacyFeedBroadcaster` / `DeviceConnectionRegistry.handleConnectionClose`. `releaseDeviceConnection` still discards batcher state, clears registry timers, detaches runtime, and releases via `deps`.

### Host-interface forwards (`command-facade.ts`)

Abstract `WebSocketCommandFacade` holds getters plus tmux / theme / overlay / feed one-liners. Those methods *are* the `TmuxCommandHost` / `BorshDispatchHost` surface; extracting them as free functions would still leave the same wrappers on the class. Inheritance avoids that extra hop without call-site churn. Collaborators (`registry`, `theme`, `overlays`, `feed`) stay `protected`.

## Metrics

CC = 1 + `if` / `&&` / `||` / `?:` / `for` / `catch`. Length is function span.

| Symbol | Before | After |
|---|---|---|
| `index.ts` | 685L | 224L |
| `handleHello` | CC 3 / 36L | CC 3 / 41L in `hello-negotiation.ts`; class wrapper 3L |
| `handlePing` | CC 3 / 18L | CC 3 / 24L in `hello-negotiation.ts`; class wrapper 3L |
| `sendChunked` | CC 2 / 10L | `sendClientChunked` CC 2 / 14L; class wrapper 3L |
| `sendCanonicalEvent` | CC 6 / 27L | CC 6 / 28L |
| `getOrCreateCanonicalSession` | CC 8 / 35L | CC 8 / 39L; class wrapper 3L |
| `handleClose` / `closeClient` | CC 3 / 21L | CC 3 / 25L; class wrapper 3L |
| `handleUpgrade` | CC 3 / 14L | CC 3 / 17L; class wrapper 3L |
| `attachRuntime` | CC 2 / 34L | CC 2 / 39L; class wrapper 3L |
| `handleBorshMessage` | CC 7 / 41L | unchanged (not restructured) |
| `handleMessage` | CC 4 / 18L | unchanged |

Entry module target (<400L) met.

## Verification (`apps/gateway`)

- Scoped (new ws modules + `index.test.ts` + host/theme/settings/event/registry tests): **104 pass / 0 fail**
- `bun test`: **1735 pass / 0 fail** (baseline 1669; extra passes are new tests here plus other agents)
- `bunx tsc --noEmit -p .`: **20 errors**, same as baseline. **None** in scoped files. Remaining errors are other agents / pre-existing (`push/*`, `tmux-client/*`, `telegram/service.ts`, `issue45-*.test.ts`, etc.)
- `bunx biome check` on the 11 scoped files: **clean**

## Skipped

- Did not restructure Borsh kind dispatch (`handleBorshMessage` still HELLO-guard → HELLO → PING → `dispatchBorshKind`).
- Did not touch inbound frame decoding (already extracted).
- Did not split `handleBorshMessage` further: it is one protocol state machine, not a second seam.

## Bugs found (not fixed)

1. **HELLO S2C `maxFrameBytes` vs session limit.** After HELLO, `borshState.maxFrameBytes` is `min(client, DEFAULT_MAX_FRAME_BYTES)` but the HELLO_S2C payload always sends `DEFAULT_MAX_FRAME_BYTES` (1MiB). A client that advertised a smaller cap is told the server maximum, not the effective send limit.
2. **HELLO is not one-shot.** A second HELLO_C2S after `negotiated === true` is accepted: it re-truncates `clientImpl`, overwrites `maxFrameBytes`, and calls `agentWsHub.registerClient` again. No “already negotiated” error.
3. **`sendCanonicalEvent` still uses `frame as unknown as BufferSource`.** Pre-existing; moved unchanged.
