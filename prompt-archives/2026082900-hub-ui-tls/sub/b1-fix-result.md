# B1-fix result — setup API review fixes

## What changed

### `packages/app/src/commands/direct.ts`
- `EnableDirectOptions.signal?: AbortSignal` is passed to `fetch` and used to cancel body reading (`ReadableStream` cancel + abort race).
- Install writes `<installDir>/native.tmp-<pid>-<rand>/`, then removes any existing `native/` and `rename`s the staging dir into place. Any failure `rm -rf`s the staging dir.
- Failures are typed: `{ ok: false, kind: 'unsupported' | 'download' | 'integrity' | 'install', reason }`. `unsupported` still sets `unsupported: true` so CLI skip/exit behaviour is unchanged.
- `kind` remains optional on the type so out-of-scope callers (`init.test.ts`) still typecheck; `enableDirect` always sets it. Missing `kind` maps as `download`.

### `packages/app/src/runtime/setup-service.ts`
- `runEnableDirect` passes `AbortSignal.timeout(directTimeoutMs ?? 60_000)` and **awaits** `enableDirect` (no orphaned `withTimeout` promise).
- Shared mapping (`mapDirectEnableFailure`) used by `setLocalDirect` (throws) and setup `direct:'failed'` (non-fatal, `directError` from the mapped message):
  - `unsupported` → 409 `direct_unsupported`
  - `download` (HTTP / network / timeout / abort) → 502 `direct_download_failed`
  - `integrity` / `install` → 500 `direct_failed`
- Process-wide setup latch (`processSetupLock`) shared by `becomeHub` and `joinHub`. Tests inject `createSetupTransitionLock()` so files do not share committed state. Production `assemble.ts` does not pass `setupLock` and therefore uses the module-level latch.
  - Second in-flight request → `409 setup_in_progress`
  - After `scheduleRestart` → `409 setup_committed`
  - `getByUsername` rechecked inside the lock
  - UNIQUE-constraint from bootstrap → `409 user_exists`
- Join env: fully computed replacement is written to a sibling temp file (mode `0600`) **before** `performHubJoin`; after local join, atomic `rename` onto the env path; staged file removed on any failure. Rename failure after join → `500 env_write_failed` with recovery text (`node has joined locally; only the env keys TMEX_ROLES=node, TMEX_HUB_URL=<url> need to be written manually`) and **no** restart.

### Tests
- `direct.test.ts` — kind classification, abort (fetch sees `signal.aborted`), missing addon → `install`, atomic replace, no leftover `native.tmp-*`.
- `setup-service.test.ts` — concurrent becomeHub (200 + 409), post-commit 409, UNIQUE → `user_exists`, join rename failure recovery / no restart, direct timeout abort + no `native/`, kind mapping.
- `setup-routes.test.ts` — HTTP concurrent becomeHub, post-commit 409, join rename 500 + no restart.
- `local-routes.test.ts` — integrity → 500 `direct_failed`; mesh 401/200 via a real `NodeSessionStore` + `authenticateRequest` (self cookie `tmex_s_self`).

### Contract
- Appended `409 setup_in_progress` and `409 setup_committed` under both `POST /api/setup/hub` and `POST /api/setup/join` Errors.

### Unchanged in scope
- `setup-routes.ts` / `http.ts` — no code change needed (`SetupError` already maps `code`/`httpStatus`).

## How to verify

```bash
cd packages/app
bun test src/commands/direct.test.ts src/runtime/setup-service.test.ts src/runtime/setup-routes.test.ts src/runtime/local-routes.test.ts
bun test src
bunx tsc --noEmit -p .
bunx biome check src/commands/direct.ts src/commands/direct.test.ts src/runtime/setup-service.ts src/runtime/setup-service.test.ts src/runtime/setup-routes.ts src/runtime/setup-routes.test.ts src/runtime/local-routes.test.ts src/runtime/http.ts
```

## Test / tsc numbers

| | Tests | tsc `--noEmit` |
|---|---|---|
| Baseline (given) | 308 pass / 0 fail | 1 (`Cannot find type definition file for 'node'`) |
| After | **330 pass / 0 fail** (40 files) | **1** (same pre-existing error) |

Targeted files: **63 pass / 0 fail**. The jump from 308 → 330 includes this task’s new cases plus parallel worktree test additions (B2b/B3). Zero failures.

Biome: clean on all scoped files after `--write`.

## Open issues

1. **Exit code 0 on setup restart** (`assemble.ts:451`) — deferred to commander; not touched (B2b owns that file).
2. **`DirectEnableResult.kind` is optional** so out-of-scope `init.test.ts` (`{ ok: false, reason }`) still typechecks. Production `enableDirect` always sets `kind`.
3. Join URL is now asserted with `assertSetupUrl` before staging (https, or http localhost when not production), matching the contract’s `400 invalid_url`. CLI `assertHubJoinUrl` (in `hub.ts`, owned by B3) still runs inside `performHubJoin`.

## Out-of-scope changes needed from others

None required for this fix. Production lock is the module default; `assemble.ts` does not need to pass `setupLock`.

Do **not** wire a second lock in assemble/server/local-routes.
