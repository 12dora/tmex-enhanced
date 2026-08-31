# B4 result — local-status waterfall + TLS / auth-mode caches

## What changed

1. **`GET /api/local/status` no longer waterfalls.** `getLocalStatus(deps)` and `deps.tlsStatus()` run with `Promise.all`. Either rejection still goes through `mapError(..., 'direct_failed')`.

2. **TLS status projection cache (per `TlsService` instance, TTL 10s).** `status()` serves a cached projection; `invalidateStatusCache()` runs on every mutation (all `store.upsert` via a private wrapper, `applyListener`, `load()` when `trustProxy` changes, `stop()`). In-flight computes are not stored if a mutation happened during the read (`statusGeneration`). Injectable `now` (already on `TlsServiceOptions`) drives TTL in tests. No module-global cache.

3. **`GET /api/auth/mode` caches request-independent derivation (TTL 5s).** Cached: TLS info, local-auth payload, primary user, hub meta, closed flag. **Not** cached: `passkeyAvailable` and `passkeysForThisOrigin` (recomputed per `Origin`). Module-level `invalidateAuthModeCache()` plus per-instance `AuthModeCache`. Invalidation on:
   - successful `POST /api/auth/local` and `POST /api/auth/local/bootstrap`
   - successful key-log apply (`keyLogSuccess`)
   - `setTlsInfo` / `setLocalAuthStore`

`findPrimaryUser` and `isPasskeyAvailable` moved to `auth-mode-cache.ts` and re-exported from `auth-routes.ts` so the file stays under its 924-line lock (now 917). `tls-config-store.ts` was not modified; TLS writes in this service go through `TlsService.upsert()`.

## Files

- `packages/app/src/runtime/local-routes.ts` (+ test)
- `packages/app/src/tls/tls-service.ts` (+ test)
- `apps/gateway/src/mesh/auth-mode-cache.ts` (new)
- `apps/gateway/src/mesh/auth-routes.ts` (+ test)

## Verification

| Check | Result |
|---|---|
| `cd packages/app && bun test src/runtime src/tls` | **158 pass, 0 fail** (14 files) |
| `cd apps/gateway && bun test src/mesh/auth-routes.test.ts src/tls` | **37 pass, 0 fail** (2 files) |
| `bunx tsc --noEmit -p .` in `packages/app` | **1** `error TS` (baseline 1, unchanged: `Cannot find type definition file for 'node'`) |
| `bunx tsc --noEmit -p .` in `apps/gateway` | **38** `error TS` (baseline 21). **None** in scoped files (`auth-routes`, `auth-mode-cache`). All 38 are in `src/tunnel/**`, `src/push/**`, `src/tmux*`, `src/telegram/**`, `src/ws/**`, `src/api/tunnel-routes.test.ts` — other agents’ files. |
| `bunx biome check` on the 7 changed files | clean (1 import-order fix applied, then re-check clean) |
| `bun scripts/complexity/gate.ts` | **ok** (1085 files, 8977 functions). Did not raise allowlist locks. `auth-routes.ts` 917 lines (lock 924). |

## Out of scope (noticed, not changed)

- Mesh admit/revoke, hub enrollment, and other `UserStore` writers outside `auth-routes.ts` do not call `invalidateAuthModeCache()`. The 5s TTL is the safety net; neighbors can import `invalidateAuthModeCache` from `auth-routes.ts` / `auth-mode-cache.ts` when those paths are in scope.
- Nodes tab still blanks on `/api/auth/mode` (frontend P2 in E5). This task only speeds the backend derivation.
- `/api/tls` shares `TlsService.status()` and therefore the new 10s cache; `tls-routes.ts` was not edited.
- Did not touch `apps/gateway/src/tunnel/**`, `apps/gateway/src/api/tunnel-routes.ts`, or `packages/app/src/commands/**`.
