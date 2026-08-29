# B2b result — TLS module wired into the production runtime

Integration of B2 (`TlsService` / `createTlsRoutes` / `HttpsListener`) into B1 `assembleTmex()` dispatch and `server.ts` startup/shutdown. TLS routes are mounted **before** local/setup/hub/mesh/gateway/SPA.

Did **not** edit B3 files (`enrollment.ts`, hub-client, hub/enroll commands, uplink/mesh/auth-routes, hub-runtime, schema.ts, `apps/fe/src/node/enrollment.ts`). `managed-migrations.ts` only gained `'0021_tls_config.sql'`.

## What changed

### Gateway
- `apps/gateway/src/db/managed-migrations.ts` — append `'0021_tls_config.sql'` after `'0020_node_identity_user.sql'`.

### App runtime
- `packages/app/src/runtime/assemble.ts`
  - Construct `TlsConfigStore(gateway.db)`, `AcmeHttp01Challenge`, `HttpsListener` (same `fetch` + `websocket` as the later plain listener), `TlsService` (`envPath: resolveSetupEnvPath()`, `trustProxy: gatewayConfig.trustProxy`), `createTlsRoutes`.
  - `tlsHandler` runs at the start of `dispatch`, immediately after `seedLocalContext`.
  - `authorize`: standalone → open (`null`); mesh → `routeDeps.authenticate` (same `nodeSessionStore` B1 uses) → `401 {error:{code:'UNAUTHORIZED',message:'login required'}}`.
  - Expose `assembled.tls` (`TlsService`) and `assembled.httpsListener` (`HttpsListener`) so local-routes and `server.ts` shutdown can reach them.
- `packages/app/src/runtime/server.ts`
  - `await assembled.start()` then `await assembled.tls.startup()`.
  - Shutdown: `tlsService.stop()` → `await httpsListener.stop()` → `await assembled.stop()` → `plainServer.stop(true)` (then existing `exit`).
- `packages/app/src/runtime/local-routes.ts`
  - `GET /api/local/status` overlays `tls` with `{ mode, listenerRunning, tlsPort }` from `tlsService.status()` (`mode` first). Extra fields are additive vs batch 1.
- Tests: `assemble.test.ts`, `local-routes.test.ts`.

### Bundled resources
Ran `bun run --filter tmex-cli bundle:resources` (`packages/app/package.json` → `bash ./scripts/bundle-resources.sh`).

Copied into `packages/app/resources/gateway-drizzle/`:
- `0021_tls_config.sql`
- `meta/_journal.json` last tag `0021_tls_config`

Snapshots (`*_snapshot.json`) are stripped by the bundle script (runtime migrate only needs `_journal.json` + `*.sql`).

**`packages/app/resources/` is gitignored** (root `.gitignore`). The copy is a generated install layout, not a committed artifact.

### Not edited (no B2 bugs found)
- `packages/app/src/tls/**`
- `packages/app/src/runtime/tls-routes.ts`

## Dispatch order (after this task)

1. `seedLocalContext`
2. **`tlsHandler`** — `/.well-known/acme-challenge/*` (public) + `/api/tls*` (authorized)
3. `handleLocalRequest` / `handleSetupRequest`
4. hub / mesh (`localUiGuard` for `/api/` is after TLS so http-01 stays reachable)
5. `gateway.handleRequest` (`/healthz`, core `/api/*`)
6. SPA fallback last

HTTPS listener reuses `assembled.fetch` (already wrapped) and `assembled.websocket`.

## How to verify

```bash
# from repo root
bun test --filter tmex-cli src/runtime/assemble.test.ts src/runtime/local-routes.test.ts
# or:
cd packages/app && bun test
cd packages/app && bunx tsc --noEmit -p .
cd apps/gateway && bun test
cd apps/gateway && bunx tsc --noEmit -p .
bunx biome check \
  apps/gateway/src/db/managed-migrations.ts \
  packages/app/src/runtime/assemble.ts \
  packages/app/src/runtime/assemble.test.ts \
  packages/app/src/runtime/server.ts \
  packages/app/src/runtime/local-routes.ts \
  packages/app/src/runtime/local-routes.test.ts
```

New assemble coverage:
- standalone `GET /api/tls` through `assembled.fetch` → `mode: 'none'`
- mesh `GET /api/tls` without session → `401 UNAUTHORIZED`
- `GET /.well-known/acme-challenge/unknown-token` → `404`, body is not `index.html`
- stored selfsigned config + `tls.startup()` binds an ephemeral port in 20000–29999; `fetch(https, { tls: { ca } })` returns healthz; shutdown stops the listener

Scratch live smoke (do **not** use production 9883 / `~/Library/Application Support/tmex/` / tmux session `tmex`): same recipe as B1, then `PUT /api/tls` selfsigned on a 20000–29999 port and `curl --cacert` `/healthz`. Not run here; unit test covers the listener path.

## Verification numbers

| Check | Baseline | After |
|---|---|---|
| `packages/app` `bun test` | 308 pass / 0 fail | **313 pass / 0 fail** (+4 assemble TLS tests, +1 local-routes overlay test; 2 existing tests updated) |
| `packages/app` `bunx tsc --noEmit -p .` | 1 | **1** (`Cannot find type definition file for 'node'` — pre-existing) |
| `apps/gateway` `bun test` | 2445 pass / 0 fail | **2445 pass / 0 fail** |
| `apps/gateway` `bunx tsc --noEmit -p .` | 21 | **21** (same pre-existing ssh/tmux/ws errors) |
| `bunx biome check` on touched sources | — | clean |

## Open issues / follow-ups

- **`setup-service.ts` `LocalStatus.tls` is still `{ mode: 'none' }`.** Out of scope (B3/other files plus this task's file list). HTTP `GET /api/local/status` overlays the real TLS view in `local-routes.ts`. Direct `getLocalStatus()` callers still see the batch-1 placeholder.
- **B3 `0022_hub_trust.sql`** exists untracked in `apps/gateway/drizzle/` but is **not** in `MIGRATIONS` (as agreed: B3 appends `'0022_hub_trust.sql'` at the end of its task and re-reads the file). This bundle run copied through `0021` only; B3 should re-run `bundle:resources` after appending 0022.
- **`assembled.httpsListener`** is exposed in addition to `assembled.tls` so `server.ts` can `await listener.stop()` after `tlsService.stop()`. `TlsService.stop()` still only stops the renewal scheduler (unchanged).
- Construction uses a `tlsSlot` so `routeDeps.tlsStatus` can close over the service before it is assigned (listener needs `fetch`/`websocket`, which need `dispatch`). The slot is filled before `assembleTmex` returns; requests cannot observe the empty state.
- Linux user-level systemd still cannot bind 80/443; unchanged.
- Live ACME against Let's Encrypt was not run.

## Out-of-scope changes needed from others

None required for this wiring. Optional later: extend `LocalStatus` in `setup-service.ts` so the type matches the additive TLS fields (would also update `setup-service.test.ts`).
