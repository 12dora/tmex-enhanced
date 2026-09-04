# T5 — relay performance metrics API (`GET /api/relay/metrics`) + missing counters

Result file: /Users/konata/code/tmex-r26/prompt-archives/2026090403-round26-pwa-login-localtab/sub/T5-result.md

## Scope (files you may edit)
- apps/gateway/src/relay/** (new `relay-metrics.ts` + test; `relay-runtime.ts`, `relay-admin-routes.ts`, `relay-registry.ts`, `relay-uplink-server.ts`, `relay-stream-router.ts`, `relay-metering.ts`, `relay-tenant-store.ts`, `types.ts`, tests). Do NOT edit `relay-hardening.test.ts` beyond what compiles.
- packages/shared/src/link/mux.ts (+ test) — only to add a read-only `stats()` counter API.
- apps/gateway/src/db/schema/relay.ts + a new migration `apps/gateway/src/db/migrations/0046_relay_pack_updated_at.sql` (look at 0045 and `managed-migrations.ts` / drizzle meta for how migrations are registered — follow the exact same procedure, including the drizzle journal if used).
- packages/api-client/src/relay/admin-api.ts (+ test): add `metrics()` returning `RelayMetricsResponse` imported from the ALREADY EXISTING `packages/api-client/src/relay/metrics-types.ts` (do not change that file's shape without a very good reason — the frontend agent is building against it; if you must add a field make it optional).
- Do NOT touch apps/gateway/src/mesh/** (another agent), apps/fe/**, packages/ui/**.

## Context
Read the inventory in /private/tmp/claude-501/-Users-konata-code-tmex-enhanced/f162c75c-ae5d-41f6-8245-2e3de8d399e8/scratchpad/sub/EX3-report.md sections 10–13 first (what exists: RelayRegistry.onlineCount/listTenant/streamCount, RelayMetering, RelayTenantStore.countActiveNodes, `/api/relay/status` admin payload in relay-admin-routes.ts, admin auth via `adminAuth.authorize()` which accepts the local logged-in user, event-loop lag sampler `apps/gateway/src/ws/event-loop-lag.ts` `gatewayEventLoopLag().snapshot()`).

## Tasks
1. Counters that don't exist yet:
   - Per-member RTT on the relay server: record `pingAt` when the heartbeat ping is sent in `relay-uplink-server.ts` (~:434) and compute `rttMs` on pong; store on `RelayLiveNode` together with `connectedAt` and a `reconnects` counter (increment when an authenticated link for the same tenant+node replaces/re-accepts).
   - Per-member active streams and live byte rates: in `relay-stream-router.ts` associate each stream with source/target members, increment/decrement on open/close, and feed a live per-member + per-tenant byte counter (in-memory, in addition to the existing `RelayMetering` DB accounting; keep the existing in/out double-count semantics for the DB path and document the semantics in the response — `bytesIn` = bytes received from members, `bytesOut` = bytes sent to members).
   - frames/s: add a read-only `stats()` to `LinkMux` in packages/shared (`framesIn/framesOut/bytesIn/bytesOut/openStreams/unacked`) incremented in `sendFrame`/`handleFrame`; aggregate over authenticated links on the relay.
   - Sealed pack `updatedAt`: add `sealed_pack_updated_at` (integer, nullable) to `relay_tenants` via migration 0046, set it in `putPack()`, expose size + updatedAt.
   - Process: `process.memoryUsage()`, CPU utilization from consecutive `process.cpuUsage()` deltas over the sample interval, `os.loadavg()` (null on platforms where it is all zeros/unsupported), event-loop lag from the existing sampler, `openSockets` = accepted WebSocket count on the uplink server, `authenticatedLinks` = registry online count.
2. `apps/gateway/src/relay/relay-metrics.ts`: a `RelayMetricsCollector` started by `RelayRuntime` (sample every 5000 ms, ring buffer of 60 samples, rates = delta of cumulative counters / elapsed), with `snapshot(): RelayMetricsResponse` matching `metrics-types.ts` exactly (members array includes `name` if the relay knows a member name — check `relayNodes` table / node list for a name field, else null). Stop the timer on runtime shutdown; make the timer `unref()`'d so tests/CLI exit.
3. Route: `GET /api/relay/metrics` in `matchAdminRoute` + `routeAdmin` (relay-runtime.ts ~:213), admin-authorized like `/api/relay/status`. Optional query `?members=0` omits the members array. Never include token hashes, keys, sealed pack bytes or key-log content.
4. api-client: `RelayAdminApi.metrics()` + test.
5. Tests: collector unit test with fake clock (rates, ring buffer cap, cpu pct), route test (401 without auth, 200 shape with local user auth), registry RTT/reconnect test, mux stats test, migration test following the existing `*.migration.test.ts` pattern.

Verify: `cd apps/gateway && bun test src/relay src/db` → 0 fail / 0 errors; `cd packages/shared && bun test src/link`; `cd packages/api-client && bun test`; `bunx tsc --noEmit -p .` in apps/gateway, packages/shared, packages/api-client → 0 errors; biome clean; root `bun run lint` must not add complexity-gate violations (if a function exceeds the gate, split it — do not edit the allowlist).
Baselines: gateway `bun test` 4319/0 (src/relay 126/0/0 errors after T1), shared 689/0, api-client 218/0, all tsc 0.
