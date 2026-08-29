# B1 result: leave-hub local membership reset API + CLI reuse

## Files changed

### Gateway
- `apps/gateway/src/auth/mesh-membership-store.ts` — `MeshMembershipStore.clearAll()` in one sqlite transaction
- `apps/gateway/src/auth/mesh-membership-store.test.ts`
- `apps/gateway/src/auth/index.ts` — re-export

### App
- `packages/app/src/runtime/membership-reset.ts` — `leaveMesh({ expectedRole })`
- `packages/app/src/runtime/membership-reset.test.ts`
- `packages/app/src/runtime/setup-service.ts` — export `withSetupTransition` / `patchOwnedEnvKeys`; `joinHub()` writes `TMEX_HUB_PUBLIC_URL=` when role is `node`; optional `quiesceMesh` on deps
- `packages/app/src/runtime/setup-service.test.ts` — join clears a stale public URL
- `packages/app/src/runtime/local-routes.ts` — `POST /api/local/leave`
- `packages/app/src/runtime/local-routes.test.ts`
- `packages/app/src/runtime/assemble.ts` — wire `quiesceMesh` (mesh.stop + hub.stop, best-effort)
- `packages/app/src/commands/hub.ts` — `hub leave` calls `leaveMesh`; CLI join clears `TMEX_HUB_PUBLIC_URL` when the resulting role is `node`
- `packages/app/src/commands/join.test.ts` — leave is a full membership reset

### api-client
- `packages/api-client/src/local/types.ts` — `LocalLeaveRequest` / `LocalLeaveResponse`; `LocalTlsStatus.listenerRunning` + `tlsPort`
- `packages/api-client/src/local/local-api.ts` — `leave(body)`
- `packages/api-client/src/local/local-api.test.ts`

Local types were already re-exported from `packages/api-client/src/local/index.ts` (`export * from './types'`). The package root index does not export local types (unchanged).

## API behaviour

`POST /api/local/leave` next to `/api/local/direct`.

Auth:
- `standalone` → **400** `{ error: { code: "not_member", message } }` (no session required)
- mesh (`node` / `hub,node`) → same self-session `authenticate()` as `/api/local/direct`; failure is **401** `{ error: { code: "unauthorized", message: "login required" } }`

Body: `{ "expectedRole": "node" | "hub,node" }`. Missing/invalid value → **409** `role_mismatch`. Must equal current role or `leaveMesh` throws **409** `role_mismatch`.

Inside `withSetupTransition`:
1. Best-effort `quiesceMesh` (assemble: `mesh.stop()` then `hub.stop()`; errors swallowed).
2. One sqlite transaction via `MeshMembershipStore.clearAll()`: `user_key_log`, `user_keys`, `node_sessions`, `node_certs`, `nodes`, `enrollment_tokens`, `peer_cache`, `hub_trust`, `node_identity`, `users` (children first, `users` last; FKs are ON).
3. Env merge via the same `patchOwnedEnvKeys` writer as join/becomeHub:
   ```
   TMEX_ROLES=standalone
   TMEX_HUB_URL=
   TMEX_HUB_PUBLIC_URL=
   ```
   Empty values are written as `KEY=` (`stringifyEnv`); they overwrite stale values instead of omitting the keys.
4. `scheduleRestart()` — same 300 ms path as setup endpoints (`SETUP_RESTART_DELAY_MS`).

**200:** `{ "ok": true, "fromRole": "node" | "hub,node", "restarting": true }`

Other errors (existing `SetupError` mapping):
- **409** `setup_in_progress` / `setup_committed`
- **500** `env_write_failed`

CLI `hub leave` calls the same `leaveMesh` (dynamic import to avoid a `hub.ts` ↔ `setup-service.ts` cycle). UX/messages (`left hub; role set to standalone`, `--no-restart` / no service manager hint) are unchanged. Restart remains CLI `maybeRestart`, not process.exit.

`joinHub()` always writes `TMEX_HUB_PUBLIC_URL=` because the setup path always yields role `node`. CLI `hub join` clears it only when `nextRole === 'node'` (a hub-capable node joining keeps `hub,node` and its public URL).

## Deviations from the contract (and why)

1. **Error envelope** is `{ error: { code, message } }`, same as every other local/setup route and `ApiErrorBody`. The contract listed codes as `"error": "not_member" | …`; implementing a bare string would break the existing client error parser.
2. Leave **401** uses lowercase `unauthorized` (contract). `/api/local/direct` is unchanged (`UNAUTHORIZED`). Same session guard, different code as specified for leave.
3. CLI does **not** use the process-wide setup lock (that lock stays committed after a successful API setup until restart). Each CLI leave gets a fresh `createSetupTransitionLock()` so one-shot CLI / tests are not stuck on `setup_committed`. The HTTP path still uses the process lock.
4. CLI restart policy is unchanged (`maybeRestart` / `--no-restart`). The 300 ms restart is the HTTP/setup path via `assemble.scheduleRestart`.
5. Empty env is `KEY=`, not deleted keys — required so merge cannot leave a stale `TMEX_HUB_PUBLIC_URL`.

No TODOs or partial paths.

## Test / tsc numbers

| Package | bun test | tsc `--noEmit` |
|---|---|---|
| `packages/app` | **406 pass / 0 fail** (baseline 396; +10) | **1 error** (unchanged; `Cannot find type definition file for 'node'`) |
| `apps/gateway` | **2454 pass / 0 fail** (baseline 2453; +1) | **21 errors** (unchanged, pre-existing) |
| `packages/api-client` | **130 pass / 0 fail** (baseline 128; +2) | **5 errors** (unchanged, pre-existing) |

`bunx biome check` on every file listed above: clean after `--write`.
