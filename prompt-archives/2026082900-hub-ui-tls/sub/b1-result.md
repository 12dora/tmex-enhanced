# B1 result — setup wizard API, local status/direct, healthz startedAt, self-exit

## What changed

New runtime routes live in `packages/app` and are mounted in `assembleTmex()` **before** hub/mesh/gateway dispatch.

### New files
- `packages/app/src/runtime/setup-service.ts` — become-hub / join / precheck / local status / direct, injectable deps
- `packages/app/src/runtime/setup-service.test.ts`
- `packages/app/src/runtime/setup-routes.ts` — `POST /api/setup/{precheck,hub,join}`
- `packages/app/src/runtime/setup-routes.test.ts`
- `packages/app/src/runtime/local-routes.ts` — `GET /api/local/status`, `POST /api/local/direct`
- `packages/app/src/runtime/local-routes.test.ts`
- `packages/app/src/runtime/http.ts` — `{error:{code,message}}` JSON helpers

### Modified
- `packages/app/src/runtime/assemble.ts` — mount local/setup routes; inject `startedAt` on mesh-stripped `/healthz`; `setProcessShutdown` + 300ms self-exit
- `packages/app/src/runtime/assemble.test.ts` — standalone status, mesh 404 setup, mesh healthz `startedAt`
- `packages/app/src/runtime/server.ts` — wire `assembled.setProcessShutdown(runShutdown)` (reuses `createProcessShutdown` / `installShutdownHandlers`)
- `packages/app/src/lib/local-auth.ts` — `createAuthContextFromDb(db)` (dynamic imports so CLI still loads `app.env` before gateway `config`)
- `packages/app/src/commands/hub.ts` — exported `JoinError` + `performHubJoin()` (no env/restart); `runHubJoin` still writes env and restarts
- `packages/app/src/commands/join.test.ts` — CLI join still writes `TMEX_ROLES`/`TMEX_HUB_URL` and calls restart (preserves other keys)
- `apps/gateway/src/api/system-routes.ts` — `PROCESS_STARTED_AT` + `/healthz.startedAt`
- `apps/gateway/src/db/managed-migrations.ts` — register `0020_node_identity_user.sql`

`hub.test.ts` was not edited; existing user-command tests still pass. The new “CLI writes env + restart” case lives next to the other join/restart tests in `join.test.ts`.

## Contract behaviour

| Route | Standalone | Mesh |
|---|---|---|
| `GET /api/local/status` | open | requires valid `self` session; `401 {error:{code:'UNAUTHORIZED',message}}` |
| `POST /api/local/direct` | open | same 401 |
| `POST /api/setup/*` | open | `404 {error:{code:'not_standalone',message}}` |

- Become-hub: bootstrap user + optional direct (60s, non-fatal) + write `TMEX_ROLES=hub,node` and `TMEX_HUB_PUBLIC_URL` + respond `{ok,fingerprint,direct,directError,restarting:true}` + `setTimeout(shutdown, 300)`.
- Join: `performHubJoin` then write `TMEX_ROLES=node` + `TMEX_HUB_URL` + same restart shape.
- Env path: production `join(resolveInstallDir(), 'app.env')`; non-production `<repoRoot>/<NODE_ENV>.env.local`. Only owned keys are replaced.
- Direct POST success always includes `restartRequired: true` (`capable` is the current runtime value; standalone has no mesh → `capable=false`).
- `/healthz.startedAt` is `Date.now()` captured at `system-routes` module load. Assembled mesh public `{status:'ok'}` also gets `startedAt` (mesh-http itself is unchanged; see open issues).

## Verification

| Package | Tests | tsc `--noEmit` |
|---|---|---|
| `packages/app` before | 254 pass / 0 fail | 1 error (pre-existing) |
| `packages/app` after | **304 pass / 0 fail** | **1 error** (`Cannot find type definition file for 'node'` — unchanged) |
| `apps/gateway` before | 2441 pass / 0 fail | 21 errors (pre-existing) |
| `apps/gateway` after | **2445 pass / 0 fail** | **21 errors** (unchanged; extras are pre-existing ssh/tmux/ws tests) |

Gateway count rose by 4 without new gateway test files in this task (likely parallel work on the same worktree, or suite drift vs the given baseline). Zero failures.

Biome: `bunx biome check` on all touched files — clean.

Targeted suites: `setup-service` / `local-routes` / `setup-routes` / `assemble` / `hub` / `join` / `schema.migration` / `system-routes.healthz` all green.

## Manual smoke (scratch instance only)

Do **not** use production (port 9883, `~/Library/Application Support/tmex/`, tmux session `tmex`). Use a worktree copy of the empty/dev DB, ports in 20000–29999.

From the repo root (worktree):

```bash
# scratch dir + db (WAL trio if copying the worktree dev db — never the production db)
SCRATCH=/tmp/tmex-b1-smoke
mkdir -p "$SCRATCH"
cp tmex.db{,-shm,-wal} "$SCRATCH/" 2>/dev/null || true

export NODE_ENV=development
export GATEWAY_PORT=21111
export FE_PORT=21112
export TMEX_BIND_HOST=127.0.0.1
export TMEX_BASE_URL=http://127.0.0.1:21112
export TMEX_GATEWAY_URL=http://127.0.0.1:21111
export DATABASE_URL="$SCRATCH/tmex.db"
export TMEX_ROLES=standalone
export TMEX_FE_DIST_DIR="$(pwd)/packages/app/resources/fe-dist"
export TMEX_MIGRATIONS_DIR="$(pwd)/apps/gateway/drizzle"

# run the assembled runtime, not the production launchd service
bun packages/app/src/runtime/server.ts
```

In another shell:

```bash
curl -sS http://127.0.0.1:21111/healthz
# expect status=ok and numeric startedAt

curl -sS http://127.0.0.1:21111/api/local/status
# expect role=standalone, tls.mode=none, direct.capable=false

curl -sS -X POST http://127.0.0.1:21111/api/setup/precheck \
  -H 'content-type: application/json' \
  -d '{"url":"http://127.0.0.1:21111"}'
# expect reachable=true, isSelf=true

# become hub (will write development.env.local and exit 0 after 300ms)
curl -sS -X POST http://127.0.0.1:21111/api/setup/hub \
  -H 'content-type: application/json' \
  -d '{"hubPublicUrl":"http://127.0.0.1:21111","username":"alice","password":"tmex-test-pass","directEnable":false}'
# expect ok=true, fingerprint (64 hex), direct=skipped, restarting=true
# process exits; supervisor/manual restart required. Poll /healthz until startedAt changes.

# mesh 404
# (after restart as hub,node)
curl -sS -o /tmp/setup.out -w '%{http_code}\n' -X POST http://127.0.0.1:21111/api/setup/hub \
  -H 'content-type: application/json' -d '{}'
# expect 404 not_standalone
```

Kill the scratch process when done. Revert any `development.env.local` keys this wrote (`TMEX_ROLES`, `TMEX_HUB_PUBLIC_URL`) — that file is gitignored.

## Open issues / follow-ups (out of scope)

1. **`apps/gateway/src/mesh/mesh-http.ts`** still returns exact `{status:'ok'}` for unauthenticated mesh `/healthz` when called via `MeshRuntime.handleRequest` (existing unit test). The assembled production listener adds `startedAt` in `assemble.ts`. If batch 2 wants the field on the mesh handler itself, that file is out of this task’s scope.
2. **`hub.test.ts`** was not given a new case; the CLI env+restart assertion is in `join.test.ts` (the existing join/restart home).
3. No TLS fields beyond `{mode:'none'}` (batch 2).
4. Did not touch `apps/fe`, `packages/api-client`, `packages/shared`, locale files.

## Notes vs exploration report

- `createAuthContextFromDb` is **async** (dynamic imports) so `cli-auth-entry` can still `loadInstallEnv` before gateway `config` captures `TMEX_MASTER_KEY`. A sync static import failed `index.test.ts` (“loads install env before gateway config”).
- Join URL rules for the setup API (https, or http localhost when not production) are slightly looser than CLI `assertHubJoinUrl` (which also needs `--insecure-local`). Join still goes through `performHubJoin` → `assertHubJoinUrl` and honours `insecureLocal` only when `nodeEnv !== 'production'`.
