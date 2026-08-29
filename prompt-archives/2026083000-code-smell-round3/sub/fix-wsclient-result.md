# Fix ws-client replay-order regression — result

Scope: `packages/ws-client/src/state-machine.ts`, `deferred-select-effects.ts`, `state-machine.test.ts`. No git, no other files.

## Files

- **Changed** `packages/ws-client/src/deferred-select-effects.ts` (195L → 209L)
- **Changed** `packages/ws-client/src/state-machine.ts` (559L, `setCallbacks` only)
- **Changed** `packages/ws-client/src/state-machine.test.ts` (one new regression case)

## What moved / what changed

Root cause: `setCallbacks` replayed `deferred.deviceIds()` (effect-map type/insertion order). History arriving as B then A put B first in the histories map, so callbacks fired `B → A`. Pre-extraction (`4a14ff26`) walked `this.transactions.keys()` first (SELECT_START insertion order), then leftover deferred maps.

Fix: `deviceIds(preferredFirst?)` now emits `preferredFirst` (deduped) then remaining queued ids in the same map-union order as before (`resets` → `histories` → `flushes` → `outputs`). `setCallbacks` passes `this.transactions.keys()`.

Per-device replay inside `DeferredSelectEffects.replay` is unchanged: reset → history reset/apply → stop if replacement still pending → buffered flush → deferred outputs.

## Metrics

CC counted as 1 + `if` / `&&` / `||` / `else if`.

| Symbol | Before (this branch) | After |
|---|---|---|
| `SelectStateMachine.setCallbacks` | CC 1 / 5L | CC 1 / 5L (passes `transactions.keys()`) |
| `DeferredSelectEffects.deviceIds` | CC 1 / 10L | CC 3 / 24L |
| `DeferredSelectEffects.replay` | CC 2 | CC 2 (unchanged) |
| `state-machine.ts` | 559L | 559L |
| `deferred-select-effects.ts` | 195L | 209L |

## Test

New case: `setCallbacks replays devices in SELECT_START order, not deferred-history arrival order`.

Sequence: start A, start B, ACK both, HISTORY for B then A, then `setCallbacks`. Asserts `reset:A, history:A, reset:B, history:B`.

RED (before fix): received `reset:B, history:B, reset:A, history:A` — matches the reviewer’s reproduction. GREEN after the `deviceIds(preferredFirst)` change.

Existing per-device four-queue ordering test is unchanged.

## Verification (`packages/ws-client`)

- `bun test`: **77 pass / 0 fail** (baseline 76; +1 new case). No failures in out-of-scope files.
- `bunx tsc --noEmit -p .`: **0 errors**
- `bunx biome check src/state-machine.ts src/deferred-select-effects.ts src/state-machine.test.ts`: **clean**

## Skipped

- Did not add a standalone unit test of `deviceIds()` leftovers (completed transactions with only flush/output). The machine regression is the reviewer’s exact scenario; leftover union order is the same as the old remaining-map loops.
- Did not change per-device replay or any other package files.

## Bugs found

The replay-order regression itself (this task). No other bugs; no unrelated fixes.
