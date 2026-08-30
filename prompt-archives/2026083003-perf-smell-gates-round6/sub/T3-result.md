# T3 result — user-key persistence + hub rate-limit split

## What changed

S1 findings 3 and 5: pull DB mutation out of `UserKeyService` and limiter state out of `UplinkServer`. Behaviour unchanged; `replayStep` / `replayJoinChain` not edited.

1. **`auth/user-key-persistence.ts`**
   - Moved `AuthStores`, `createTxStores` (was `txStores`), `persistApplied`, `wipeUserDerivedState`, `persistEncryptedIdentity`, `bindIdentityUser`, plus `EncryptedIdentity` and `kdfParamsToJson` (needed by persist, re-exported from the service).
   - `createTxStores(tx, userStore, keyLogStore, nodeSessionStore)` — same constructor-on-tx construction; extra args because `UserKeyService` fields are private (`this` is not an `AuthStores`).
   - Transaction callbacks still: create stores from `tx` → mutate → (optional) throw. Fork/CAS/join/bootstrap order unchanged.

2. **`hub/uplink-rate-limit.ts`**
   - Moved `TokenBucket`, `IdleLruMap`, `WindowedLogBudget`, `KeyLogReqLimiter` and overflow helpers, plus limiter default constants.
   - `UplinkServer` re-exports `KeyLogReqLimiter` and the `HUB_KEY_LOG_REQ_*` constants. `sanitizeLogField` stays in the server (logging, not limiter).

## Files

| File | Action |
|---|---|
| `apps/gateway/src/auth/user-key-persistence.ts` | new |
| `apps/gateway/src/auth/user-key-persistence.test.ts` | new (persistApplied / wipe / identity / tx rollback) |
| `apps/gateway/src/auth/user-key-service.ts` | import persistence; drop moved fns |
| `apps/gateway/src/hub/uplink-rate-limit.ts` | new |
| `apps/gateway/src/hub/uplink-rate-limit.test.ts` | moved limiter unit tests + TokenBucket / IdleLruMap / WindowedLogBudget |
| `apps/gateway/src/hub/uplink-server.ts` | import + re-export |
| `apps/gateway/src/hub/uplink-server.test.ts` | dropped the three limiter-only tests |

## Complexity (before → after)

| Symbol | Before | After |
|---|---|---|
| `user-key-service.ts` | 1012 lines | **849** (< 900) |
| `persistApplied` | CC 9 / 90L @923 | CC 9 / 90L @98 (`user-key-persistence.ts`) |
| `wipeUserDerivedState` | CC 1 / 13L | CC 1 / 13L |
| `persistEncryptedIdentity` | CC 1 / 15L | CC 1 / 15L |
| `bindIdentityUser` | CC 1 / 3L | CC 1 / 3L |
| `txStores` / `createTxStores` | CC 1 / 8L | CC 1 / 12L (explicit store args) |
| `replayStep` | CC 8 / 36L @659 | CC 8 / 36L @631 |
| `replayJoinChain` | CC 13 / 44L @696 | CC 13 / 44L @668 |
| `uplink-server.ts` | 1446 lines | 1185 |
| `uplink-rate-limit.ts` | — | 279 |
| `KeyLogReqLimiter.take` | CC 6 / 23L | CC 6 / 23L |
| `takeOverflow` | CC 6 / 29L | CC 6 / 29L |
| `sweepOverflow` | CC 5 / 11L | CC 5 / 11L |

**Net production lines:** 1012+1446=2458 → 849+192+1185+279=**2505 (+47)**. Over the ≤+10 target. Overhead is ESM import/re-export wrappers, `AppliedKeyLogStep`, and `createTxStores` extra parameters — not duplicated logic. Hitting +10 would mean deleting those wrappers or collapsing sequential persist/limiter code.

## Measurements

`KeyLogReqLimiter.take` (post-extract, algorithm identical): 200_000 iterations, **17.22 ms**, **0.086 µs/take** (`scratchpad/t3-limiter-take.bench.ts`). No runtime win expected (S1). Complexity gate is the before/after that the task asked for.

## Tests / tsc / biome

- `cd apps/gateway && bun test src/auth src/hub`: **130 pass, 0 fail**
- `bunx tsc --noEmit -p .`: T3 files **0 errors**. Package total 24 vs baseline 21; the extra 3 are pre-existing/parallel `mesh-runtime.ts` (not T3).
- `bunx biome check` on the 7 files: **clean**

## Left / risky

- Nothing unfinished.
- `createTxStores` takes four store instances instead of `this`; constructors and tx object are the same.
- Limiter constants are defined in `uplink-rate-limit.ts` and re-exported from `uplink-server.ts`.
- `uplink-server.ts` is still > 900 lines (S1 expected that).
