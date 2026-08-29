# Isolate deferred select effects — result

Scope: `packages/ws-client/src/state-machine.ts` (+ new helper + test). No git, no other package files.

## Files

- **Added** `packages/ws-client/src/deferred-select-effects.ts` (195L)
- **Changed** `packages/ws-client/src/state-machine.ts` (662L → 559L)
- **Changed** `packages/ws-client/src/state-machine.test.ts` (one new case; existing cases kept)

Did not touch `client.ts`, `pane-sink-registry.ts`, `index.ts`, or anything else in the package.

## What moved

Four deferred maps (`resets` / `histories` / `flushes` / `outputs`) now live on `DeferredSelectEffects`.

Required surface: `deferReset` / `deferHistory` / `deferFlush` / `deferOutput`, `hasReplacement`, `deviceIds`, `clear` (one device or all), `replay`.

Also on the helper (needed to hit CC + line targets without leaving dual-path branches in the machine): `resetOrDefer`, `historyOrDefer`, `flushOrDefer`, `outputOrDefer`. These preserve “call now if the callback exists, otherwise enqueue.”

Replay order is unchanged and load-bearing:

1. deferred reset
2. history reset + apply
3. **stop** if a replacement (reset or history) is still pending
4. buffered flush
5. deferred outputs

`SelectStateMachine.setCallbacks` now snapshots `deferred.deviceIds()` (union of the four queues) and replays each id once. It no longer walks `transactions` plus four maps. A device with a live transaction but empty queues was already a no-op replay.

`SelectCallbacks` extends `DeferredSelectCallbacks` (same optional fields; `onSelectFailed` stays on the machine type).

## Metrics

| Symbol | Before | After |
|---|---|---|
| `handleLiveResume` | CC 13 / 50L | CC 8 / 37L (`state-machine.ts:298`) |
| `replayDeferred` | CC 13 / 38L | CC 1 / 3L (`state-machine.ts:453`) |
| `DeferredSelectEffects.replay` | — | CC 2 |
| `state-machine.ts` | 662L | 559L (target ≤ 570) |

CC counted the same way as the round baseline (1 + `if`/`&&`/`||`/`else if`).

## Test

New case: `replays reset, history, flush, and output in that order for one device`. It fills all four queues on one device and asserts:

`reset:%reset` → `reset:%history` → `history:…` → `flush:…` → `output:…`

A single `SelectStateMachine` transaction cannot populate both reset and history (no-history live vs history path), so the ordering test drives `DeferredSelectEffects` directly. Existing machine tests still cover deferred history replay, sibling output, flush pane id, timeouts, and stale timers.

## Verification (`packages/ws-client`)

- `bun test`: **76 pass / 0 fail** (baseline 75 pass; +1 new case). No failures in out-of-scope files.
- `bunx tsc --noEmit -p .`: **0 errors**
- `bunx biome check src/state-machine.ts src/deferred-select-effects.ts src/state-machine.test.ts`: **clean**

## Skipped

- Did not re-export the helper from `index.ts` (out of scope).
- Did not add a second test for the “stop if replacement still pending” branch; existing history-defer + missing-callback paths still cover it, and the request asked for one all-queue ordering test.

## Bugs found

None. No unrelated fixes.
