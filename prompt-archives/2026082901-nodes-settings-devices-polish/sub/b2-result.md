# B2 result: leaveMesh ordering, hub drain, CLI stop/start

## Files changed

### App
- `packages/app/src/runtime/membership-reset.ts` — stage standalone env first, then quiesce + `clearAll()`, then atomic promote
- `packages/app/src/runtime/membership-reset.test.ts` — staging failure keeps membership; DB failure leaves env untouched
- `packages/app/src/runtime/setup-service.ts` — export `newStagedEnvPath` / `writeStagedEnv` / `promoteStagedEnv` / `removeStagedEnv` / `readExistingEnv` / `wrapJoinEnvWriteError`
- `packages/app/src/runtime/assemble.ts` — `quiesceMesh` and process `stop()` await async `hub.stop()`
- `packages/app/src/runtime/local-routes.test.ts` — leave happy path uses staged-env stubs
- `packages/app/src/commands/hub.ts` — CLI `hub leave` stops a managed service before opening/resetting, starts after
- `packages/app/src/commands/join.test.ts` — stop/start vs `--no-restart` vs no manager
- `packages/app/src/lib/service.ts` — `startService()` (systemd `start`, launchd `bootstrap`)

### Gateway
- `apps/gateway/src/hub/uplink-server.ts` — async `stop()`, reject new ctl/accept after stop, drain in-flight ctl with 5 s cap
- `apps/gateway/src/hub/uplink-server.test.ts` — in-flight `key.log.append` completes before `stop()` resolves
- `apps/gateway/src/hub/hub-runtime.ts` — `stop()` awaits `uplink.stop()`

## Finding 1 (blocker): env/DB ordering

`leaveMesh()` now follows the `joinHub()` staged-env pattern:

1. Resolve `envPath` (`resolveEnvWriteTarget`) and write standalone keys to a sibling `.tmp` file (`newStagedEnvPath` + `writeStagedEnv`). Staging failure → `env_write_failed`, no quiesce, no `clearAll()`, live `app.env` unchanged.
2. `quiesceMesh` then `MeshMembershipStore.clearAll()`. If this throws, delete the staged file and leave `app.env` untouched.
3. Atomic `rename` of the staged file onto the env target.

No-envPath (in-memory) still mutates `process.env` only after a successful `clearAll()`.

Tests: `env_write_failed` asserts alice/users still present and `TMEX_ROLES=node`; new test spies `clearAll()` to throw and asserts env + no leftover `.tmp`.

## Finding 2 (major): quiesce must drain

`UplinkServer.stop()` is async. After `stopped = true` it refuses `accept()` and `enqueueCtl()`, then awaits tracked ctl promises (`Set<Promise<void>>`) with `HUB_STOP_DRAIN_TIMEOUT_MS = 5000`. Timeout logs `[hub] uplink stop drain timed out; continuing` and resolves (does not throw). `HubRuntime.stop()` awaits that drain. Assemble `quiesceMesh` / process stop await `hub.stop()`.

Unit test: gated `keyLogSource.append` — `stop()` stays pending until the gate is released, then append has finished.

## Finding 3 (major): CLI `hub leave` vs a running service

Detection matches `maybeRestart` (`io.serviceManager ?? detectServiceManager()`).

- Manager present (`launchd` / `systemd-user`) and an install dir: **stop** (via `io.stop` or `stopService`) **before** `withAuth` / `leaveMesh`, then **start** afterwards (`io.start` or `startService`). `--no-restart` leaves the service stopped and prints `HUB_MANUAL_RESTART_HINT`. If `leaveMesh` throws after stop, start is still attempted so a failed leave does not leave a managed install down.
- Manager `none`: no stop/start; print the existing manual-restart hint (unless `skipRestart`).
- Injected `io.auth` without `io.stop`/`io.start` never calls real launchd/systemd (tests).

## Test / tsc numbers

| Package | bun test | tsc `--noEmit` |
|---|---|---|
| `packages/app` | **408 pass / 0 fail** (baseline 406; +2) | **1 error** (unchanged; `Cannot find type definition file for 'node'`) |
| `apps/gateway` | **2455 pass / 0 fail** (baseline 2454; +1) | **21 errors** (unchanged, pre-existing) |

`bunx biome check` on every file listed above: clean (3 import/format fixes applied with `--write`).

No TODOs.
