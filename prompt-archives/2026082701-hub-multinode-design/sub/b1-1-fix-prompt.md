# Task B1-1-fix — session/carrier close semantics (apps/gateway/src/ws, managed-entry.ts)

Context: the GatewaySession/Carrier split is committed (`sub/b1-1-result.md`; design §3 "载体抽象" / "载体切换屏障"). A reviewer found lifecycle bugs: `sub/b1-1-review.md`. The coordinator judged ALL five items valid. Since then `ws/index.ts` gained `attachStreamSession(carrier)` (B2-2a, `sub/b2-2a-result.md`) — keep it working and make it use the same close path.

Fix each with a regression test that fails before / passes after:

1. `WebSocketServer.closeSession(session, code, reason)`: single explicit termination entry — marks `session.closed`, closes AND detaches both `primary` and `direct` (guard `forget` on each), removes the session from `connectedClients` / `canonicalSessions` / `sessionStateStore` / switch-barrier / `agentWsHub` / device registries. `managed-entry.ts` restart path calls this instead of casting a session to a `ServerWebSocket`; add `handleCarrierClose` wiring so the Bun close callback of an already-closed session is a no-op.
2. `handleClose(session, carrier)` (rename to `handleCarrierClose`): the caller always passes the carrier that actually closed (Bun adapter in `runtime.ts`, `attachStreamSession().onClose`, future DataChannel). Primary closed → `closeSession`; non-active direct closed → detach only; active direct closed → detach, switch active back to primary (leave the CARRIER_SWITCH notification to Phase 3 — just switch state) and continue.
3. Every inbound entry (`handleMessage`, `attachStreamSession().onMessage`, drain) ignores a session with `closed === true`; closing the primary while direct is active closes the direct carrier too.
4. `GatewaySession.attachCarrier(c, 'direct')` when a direct already exists: atomic replacement — if the old direct is active, switch active to primary first; `forget` old in the guard via a `onCarrierDetached` hook the server registers; close old; install new. Attaching the same carrier twice throws.
5. `gateway-metrics-log.ts`: snapshot over all attached carriers of every session (`session.carriers()` helper), field names say carriers.

Tests to add (in `ws/index.test.ts` / `gateway-session.test.ts` / `managed-entry` tests): restart while direct is active cleans everything and closes both carriers; non-active direct closes → session survives; primary closes → direct closed and a later inbound message on the direct carrier is dropped; direct replacement; metrics over two carriers.

File scope: `apps/gateway/src/ws/**`, `apps/gateway/src/managed-entry.ts` (+tests), `apps/gateway/src/runtime.ts` only the Bun close/drain callback lines, `apps/gateway/src/mesh/stream-targets.ts` only if the `attachStreamSession` return shape must change (say so in the report). Nothing else. Acceptance: `cd apps/gateway && bun test` green (baseline now 1573), tsc ≤ 23, biome clean. Result: `prompt-archives/2026082701-hub-multinode-design/sub/b1-1-fix-result.md`.
