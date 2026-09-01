# T1 result — per-client viewport claims (backend + protocol)

## Exported names

**Shared (`packages/shared` / `wsBorsh`)**
- `KIND_TERM_VIEWPORT = 0x0308`, `KIND_TERM_VIEWPORT_POLICY = 0x0309`
- `schema.TermViewportSchema` `{ deviceId, paneId, cols: u16, rows: u16, visible: bool }`
- `schema.TermViewportPolicySchema` `{ deviceId, windowId, paneId, owner: bool, cols: u16, rows: u16 }`

**ws-client**
- Command: `{ type: 'terminal-viewport'; deviceId; paneId; cols; rows; visible }` (union uses `type`, matching existing commands; task text said `kind`)
- `buildTermViewportMessage({ deviceId, paneId, cols, rows, visible })`
- `TerminalViewportPolicyEvent = { type: 'terminal-viewport-policy'; kind: 'terminal-viewport-policy'; deviceId; windowId; paneId; owner; cols; rows }`
- Decoder emits that event on `KIND_TERM_VIEWPORT_POLICY` (tmux-event-router can `case 'terminal-viewport-policy'` on `event.type`)

## Files changed

- `packages/shared/src/ws-borsh/{kind,schema,index,index.test}.ts`
- `packages/ws-client/src/{transport-types,transport-command-encoder,message-builder,message-builder.test,transport-message-decoder,transport-message-decoder.test,transport,transport.test,index}.ts`
- `apps/gateway/src/ws/{viewport-policy,viewport-policy.test,viewport-claims.test,gateway-session,types,borsh-dispatcher,borsh-dispatcher.test,tmux-kind-handlers,tmux-command-handlers,index,index.test,device-connection-registry,test-helpers}.ts`
- `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`
- `docs/terminal/2026090101-viewport-policy.md`

## Gateway integration

- Claims on `GatewaySession.viewportClaims` keyed `deviceId/windowId`.
- `handleTermResize(session, …)` / `TERM_SYNC_SIZE` = visible claim; `handleTermViewport` updates visibility/geometry.
- `resolveWinner`: max `cols*rows`, then `cols`, then `rows`, then lowest session id; hidden excluded; none → keep size.
- Apply via existing `resizeWindow`/`resizePane` only when winner geometry ≠ last applied (`DeviceConnectionEntry.lastAppliedViewport`). Snapshot skip is bypassed when last-applied is already set (stale snapshot after a previous winner).
- Policy sent to all claimants on winner/geometry change, and to a session on its first claim.
- Drop + recompute: `closeSession`, device detach; reconnect-failure drops without recompute.
- Unknown pane: ignore claim; resize/sync still `resizePane` (legacy).

## Tests / tsc

| Package | Tests | tsc |
|---|---|---|
| shared | 392 → **398** pass | clean |
| ws-client | 283 → **286** pass | clean |
| gateway | 3080 → **3115** pass / 0 fail | `error TS` count **21** (unchanged) |
| stores | not edited | **fails** `host-services.test.ts:93` (`helpers[0].value`) — unrelated clipboard mock; T2a already added `'terminal-viewport-policy'` so the exhaustive router switch is complete |

Biome clean on all touched TS files.

## Unfinished

Nothing in T1 scope. `packages/stores` tsc failure is concurrent/unrelated; do not treat as a viewport-protocol break.
