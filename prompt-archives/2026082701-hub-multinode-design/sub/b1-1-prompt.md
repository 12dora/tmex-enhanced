# Task B1-1 — GatewaySession / Carrier split (apps/gateway/src/ws/**)

## Context

tmex is adding a hub/node mesh (design: `docs/hub/2026082700-hub-node-architecture.md`, §3 "载体抽象"). Today the gateway WebSocket layer uses Bun's `ServerWebSocket` object as (1) transport, (2) protocol-negotiation state holder (`ws.data.borshState`), and (3) the identity key for every per-client Map/Set. Later phases must attach a second transport (a link stream or a WebRTC DataChannel) to the SAME logical session. Your job is the refactor that makes this possible, **without introducing any new protocol or behavior change**: all existing tests must stay green and standalone behavior must be byte-identical.

Read first, in this order:
1. `prompt-archives/2026082701-hub-multinode-design/phase0-result.md` — section "E0-1 载体拆分" (summary + risks).
2. `prompt-archives/2026082701-hub-multinode-design/sub/e0-1-result.md` — the complete reference list (§1), state ownership (§2), send path semantics (§3), attach requirements (§4), the nine-step refactor plan (§5), affected tests (§6), risks (§7). Follow §5 as your implementation plan.
3. `docs/hub/2026082700-hub-node-architecture.md` §3 "载体抽象" and "载体切换屏障" (only to understand the target shape; do NOT implement CARRIER_SWITCH).

## Deliverables

- New `apps/gateway/src/ws/carrier.ts`: `Carrier` interface (`send(bytes): 'sent'|'backpressure'|'closed'`, `bufferedAmount()`, `onDrain(cb)`, `close(code, reason)`, `terminate()`) and `BunSocketCarrier` (mapping: `ws.send()>0 → 'sent'`, `-1 → 'backpressure'`, `0` or throw → `'closed'`). Bun types appear only here and at the ingress boundary (`ws/index.ts` upgrade/open handlers, `runtime.ts`, `managed-entry.ts`).
- New `apps/gateway/src/ws/gateway-session.ts`: `GatewaySession` (`id`, `borshState`, `state`, `primary`, `direct`, `activeCarrier`, `closed`, `attachCarrier`, `detachCarrier`, `switchActiveCarrier`, `isActiveCarrier`, `handleCarrierDrain`). A drain from a carrier that is not `activeCarrier` must NOT advance canonical/session state.
- `BorshClientState` → `BorshSessionState`; Bun socket `data` becomes `{ session, carrier }`. Two independent seq counters exist (`borshState.seqGen` and `session-state.ts` `wsConnection.seq`) — keep both, do not merge, never reset either on attach.
- `websocket-send-guard.ts` and `codec-borsh.ts` `sendToClient` operate on `Carrier`; backpressure state keyed by carrier (`WeakMap<Carrier,…>`); `maxFrameBytes` passed explicitly from the session (no reflection through `ws.data`). Keep guard's public tri-state (`sent/backpressured/dropped`) and all termination reasons (`oversized_frame`, `dropped_frame`, `backpressure_timeout`, `backpressure_gap`).
- `ws/index.ts`, `switch-barrier.ts`, `session-state.ts`, `device-connection-registry.ts`, `legacy-feed-broadcaster.ts`, `theme-settings-broadcaster.ts`, `gateway-metrics-log.ts`, `borsh-dispatcher.ts`, `tmux-command-handlers.ts`, `types.ts`: all signatures and all Maps/Sets keyed by session; closures in timers capture the session (never the raw socket) and read `session.activeCarrier` at send time. Delete `SwitchBarrierSocket` / `asSwitchBarrierSocket`.
- `agent/ws-hub.ts`: `Set<GatewaySession>`, `Map<string, Set<GatewaySession>>`.
- `runtime.ts` and `managed-entry.ts`: stay as the Bun adapter boundary; `socketOwners` becomes `Map<GatewaySession, …>` (or equivalent keyed by session) — adjust callback types minimally.
- Test fixtures (`ws/test-helpers.ts`, `host-interfaces.test.ts`, and the ~25 affected test files listed in e0-1 §6): introduce `createGatewaySession()` + `createFakeCarrier()` helpers and migrate tests. Add new tests: (a) `BunSocketCarrier` result mapping; (b) `GatewaySession` attach/detach/switch; (c) "drain from a stale (non-active) carrier does not advance canonical state"; (d) send-guard keyed per carrier (two carriers on one session have independent backpressure).

## Your file scope

`apps/gateway/src/ws/**`, `apps/gateway/src/agent/ws-hub.ts`, `apps/gateway/src/agent/ws-hub.test.ts`, `apps/gateway/src/runtime.ts`, `apps/gateway/src/managed-entry.ts` (+ their tests). Nothing else. Do NOT touch `apps/gateway/src/db/**`, `apps/gateway/src/auth/**`, `apps/gateway/src/api/**`, or `packages/**`.

## Acceptance

- `cd apps/gateway && bun test` → all pass (≥ 1472 + your new tests).
- `bunx tsc --noEmit -p apps/gateway` error count ≤ 27 (baseline; list the remaining ones in the report so the coordinator can confirm they are pre-existing).
- `bunx biome check` clean on every file you touched.
- No new protocol kinds, no behavior change visible to clients.

## Result file

`prompt-archives/2026082701-hub-multinode-design/sub/b1-1-result.md`
