# T2 — Port mapping backend (round 32)

Node A listens on a local TCP port, every accepted socket becomes one `tcp` mux stream to node B,
B validates an export row and dials the real service. No new transport, no relay-side change.

## What was built

### Mesh plumbing (minimal edits to shared files)

- `apps/gateway/src/mesh/types.ts` — `TcpStreamOpenPayload = { type:'tcp'; mapId; host; port }`.
- `apps/gateway/src/mesh/stream-targets.ts` — `classifyOpenPayload` now returns `'tcp'`
  (return type widened to `'http' | 'ws' | 'tcp' | 'relay' | 'unknown'`).
- `apps/gateway/src/mesh/peer-live-registry.ts` — `handleInboundStream` dispatches `tcp` to
  `dispatchTcpStream(stream, { peerNodeId, selfNodeId: this.state.identity.nodeId })`.
  The existing deny-list guard (`unknown`/`relay` → reset) already lets `tcp` through.
- **Deviation:** `dispatchTcpStream` lives in the new `apps/gateway/src/portmap/dispatch.ts`, not in
  `stream-targets.ts`. That file is already over the 600-line gate with an allowlist pin of 609 and
  the helper pushed it to 616; moving it out keeps the gate clean (stream-targets is now 601).
- `apps/gateway/src/mesh/mesh-runtime.ts` — one helper `bindPortMaps(d, peerManager)` registers
  `{ peers: PeerManager, exports: PortMapExportStore(d.db) }` under this node's id, plus one
  `['portmap', () => unbindPortMap()]` entry in `stopQuietly`. Keyed by nodeId so the two in-process
  MeshRuntimes in the integration test do not clobber each other. The mesh entry unbinds rather than
  stopping listeners on purpose: a mesh restart re-binds and the maps keep working, whereas stopping
  the listeners there would leave them down (nothing restarts them); while unbound, new connections
  are simply closed. Listener teardown belongs to `GatewayRuntime.stop()`.
- `apps/gateway/src/runtime.ts` — `startPortMaps()` in `startLiveGatewayServices` (skipped on
  relay-only roles) and `stopPortMaps()` in `GatewayRuntime.stop()`.
- `apps/gateway/src/api/index.ts` — one import + `...portMapRoutes` in `apiRoutes`.

### New module `apps/gateway/src/portmap/`

| file | role |
| --- | --- |
| `types.ts` | row types, `PortMapError`, http status mapping, validators, limits |
| `store.ts` | `PortMapStore` / `PortMapExportStore` (drizzle) + Memory twins behind interfaces (mirrors `tunnel/config-store.ts`) |
| `binding.ts` | nodeId → `{ peers, exports }` registry; `solePortMapPeers()` for the gateway singleton |
| `port-probe.ts` | `isPortFree(host, port)` (bind + immediate release), `isPortListening(host, port, timeout)` |
| `pump.ts` | socket ⇄ `LinkStream` bidirectional pump + Bun socket-callback adapter |
| `listener.ts` | `Bun.listen` per map, lazy `getLink` per connection, 64-connection cap, `setNoDelay` |
| `accept-tcp-stream.ts` | B side: payload parse → export check → `Bun.connect` (5 s) → pump |
| `manager.ts` | CRUD, boot resume, pause/resume, counters, probe, `stop()`, gateway singleton |
| `routes.ts` | the browser REST surface |
| `dispatch.ts` | the mesh-side entry point |
| `test-echo-server.ts` | echo / FIN test servers (used by unit + integration tests) |

### Schema / migration

- `apps/gateway/src/db/schema/portmap.ts` — `port_maps` (+ `port_maps_listen_idx` on
  `listen_host, listen_port`) and `port_map_exports` (pk `map_id`), exactly as specified.
- `apps/gateway/drizzle/0050_port_maps.sql` + journal entry `idx 50` in `drizzle/meta/_journal.json`
  (the drizzle migrator is journal-driven, so the entry is required — `createMigratedAuthDb` uses it).
- `apps/gateway/src/db/managed-migrations.ts` — appended `'0050_port_maps.sql'` after `0048`.
  **R1 has not yet appended `0049_relay_limits.sql`** (the .sql and the journal entry exist, the
  MIGRATIONS array does not). They must insert it *before* my line; commander please re-check that
  the array stays numerically ordered at merge time.

## Behaviour notes / deviations worth knowing

1. **Bun's `socket.end()` closes both halves.** Measured on Bun 1.3.14: after `end()` the local
   socket is closed immediately (readyState -1) and can no longer read; the peer does get the FIN.
   `socket.shutdown(true)` is worse — it fires our own `end` callback and never sends a FIN.
   So: local FIN → `stream.end()` works as a true half-close (we keep pumping remote→local), while
   remote `END` → `socket.end()` closes the local connection. A socket close after the remote END is
   treated as a clean finish (no RST back). Documented in the doc file.
2. **No `socket.pause()` during dialing.** A paused Bun socket also defers its `close` event, so a
   client that disconnects mid-dial would leak the connection slot. Early data is buffered instead,
   capped at 1 MiB (`MAX_EARLY_BYTES`), then the socket is dropped. After the pump is attached,
   pause/resume is used normally as the local→remote backpressure.
3. **Backpressure**: remote→local pulls the next chunk only after `socket.write` fully accepted the
   previous one (waiting for `drain` on partial writes), so mux WINDOW credit is the cross-mesh
   backpressure; local→remote awaits `stream.write` with the socket paused. Hard bound 8 MiB.
4. **Per-map cap 64** connections (`PORT_MAP_MAX_CONNECTIONS`), refused at accept; max 64 map rows.
5. Boot resume keeps rows whose port is taken and reports `state:'error', error:'port_in_use'`.
   `PortMapManager.start()` tolerates a missing table (logs, continues) so a relay-only/preflight
   gateway cannot crash on it.
6. `PATCH {paused:false}` on an already-listening map is a no-op (it used to re-probe its own port
   and 409 itself).

## API summary F1 must follow (contract file unchanged)

`packages/shared/src/contracts/portmap.ts` was **not modified** — no changes for F1 to absorb.
`packages/api-client/src/portmap.ts` as F1 wrote it matches these routes exactly.

Node A (node-session auth, same as every other `/api` route):

| method | path | request | 2xx body |
| --- | --- | --- | --- |
| GET | `/api/portmap` | – | `{ maps: PortMapDto[] }` |
| POST | `/api/portmap` | `CreatePortMapRequest` | 201 `{ map: PortMapDto }` |
| PATCH | `/api/portmap/:id` | `{ name?, paused? }` | `{ map: PortMapDto }` |
| DELETE | `/api/portmap/:id` | – | `{ ok: true }` |
| GET | `/api/portmap/probe?host=&port=` | – | `PortProbeResponse` (unwrapped) |

Node B:

| method | path | request | 2xx body |
| --- | --- | --- | --- |
| GET | `/api/portmap/exports` | – | `{ exports: PortMapExportDto[] }` |
| POST | `/api/portmap/exports` | `CreatePortMapExportRequest` | 201 `{ export: PortMapExportDto }` |
| DELETE | `/api/portmap/exports/:mapId` | – | `{ ok: true }` (idempotent) |
| GET | `/api/portmap/target-probe?host=&port=` | – | `TargetPortProbeResponse` (unwrapped) |

**Error body** (all failures):

```json
{ "error": { "code": "port_in_use", "message": "…" }, "code": "port_in_use", "message": "…" }
```

The top-level `code` is duplicated on purpose: `api-client`'s `toApiError` only reads a top-level
`code`, so `ApiError.code` is one of `PortMapErrorCode` and `isApiErrorCode(err, 'port_in_use')`
works. Status mapping: `invalid_request` 400 · `not_found` 404 · `port_in_use` / `port_reserved` /
`limit_reached` 409 · everything else 500.

**Validation F1 should respect** (all violations are 400 `invalid_request`):

- `mapId`: `^[A-Za-z0-9_-]{8,64}$`. `POST /api/portmap/exports` without one returns a 32-char hex id;
  pass that same id to `POST /api/portmap` so A's row and B's export row match.
- `targetNodeId` / `fromNodeId`: 32 lowercase hex chars.
- ports: integers 1–65535. `host` fields: `^[A-Za-z0-9._:-]{1,255}$`, default `127.0.0.1`.
- `name`: trimmed, ≤ 64 chars, optional (defaults to `''`).
- Reserved ports (gateway port, `TMEX_PEER_PORT`) → 409 `port_reserved`; a port already bound or
  already mapped → 409 `port_in_use` (`probe` reports the same via `reserved` / `usedByMapId` / `free`).
- Creation order stays as planned: B `POST /exports` → A `POST /api/portmap` (rollback the export on
  failure); deletion reversed — A's `DELETE` does nothing on B.

## Tests

New (all green):

- `src/portmap/port-probe.test.ts` (3), `pump.test.ts` (6, incl. >1 MiB flow control, half-close both
  directions, RST both directions), `accept-tcp-stream.test.ts` (6, authorization matrix + connect
  failure), `manager.test.ts` (10, CRUD/probe/boot-resume/cap/counters), `routes.test.ts` (5),
  `store.test.ts` (2), `src/db/port-maps.migration.test.ts` (1, pre-0050 db upgrades cleanly).
- `src/mesh/integration/portmap.integration.test.ts` (6): two in-process `MeshRuntime`s (hub A +
  enrolled node B, in-memory peer links), echo server on B, ephemeral 127.0.0.1 listen port on A —
  byte round-trip + counters, >1 MiB payload, half-close, paused map refuses connections and resumes,
  missing export ⇒ connection closed with the target never dialled, delete stops the listener and
  frees the port. Every fixture is torn down in `afterEach`.

Totals: `bun test src/portmap src/db/port-maps.migration.test.ts src/mesh/integration/portmap.integration.test.ts src/runtime.test.ts`
→ **45 pass / 0 fail**.

Full `apps/gateway` suite (final run, after all my edits): **4970 pass / 10 fail / 4980 across 452
files**. All 10 failures are the known-baseline `mesh phase-2 integration` set (baseline: 4913 pass /
10 fail) — no portmap test appears. Two earlier runs showed extra failures that were artifacts of
editing files while the suite was running (`bun test` reads sources at execution time) plus one real
issue of mine that is fixed: `startLiveGatewayServices skips … on relay-only` — port maps are now
gated on non-relay-only roles and the store read is defensive; `src/runtime.test.ts` is 6/6 green.

Gates:

- `bunx tsc --noEmit -p apps/gateway` → 0 errors from my files; the only errors present are T1's
  in-flight `apps/gateway/src/transfer/*` (channel/receiver result types).
- `bunx tsc --noEmit -p packages/shared` → 0.
- `bun scripts/complexity/gate.ts` → 0 violations from my files (`stream-targets.ts` back to 601
  under its 609 pin, `assembleMeshRuntime` back under 120). Remaining violations belong to F1
  (`apps/fe/.../portmap/*.tsx`, transfer dialogs) and T1 (`push-driver.ts`, and `wireMeshHttp` in
  `mesh-runtime.ts` which T1 grew with `setTransferMeshBridge`).
- `bunx biome check` on every file I touched → clean (import order in the three shared files was
  fixed by moving my import lines only, no reformatting).

## Docs

`docs/mesh/2026090604-port-mapping.md` (Chinese): 背景 / 设计（流类型与授权、表、生命周期、背压、
半关闭）/ 接口 / 限制 — including the relay note (the tunnel rides inside the single existing relay
stream per peer pair, so it is metered and rate-limited by the tenant quota and costs no extra
`maxStreams` slot) and the 64-connection rationale against `MAX_LINK_UNACKED = 65 MiB`.

## For the commander

1. `managed-migrations.ts` ordering vs R1's `0049_relay_limits.sql` (see above).
2. Nothing else to wire: routes, boot start/stop and the mesh binding are all registered.
3. There is no WS push for port-map changes; the FE polls while its dialog is open, as planned.
