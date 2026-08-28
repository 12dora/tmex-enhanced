## High — overflow recovery can be overwritten by the stale selection transaction

**File:** `packages/ws-client/src/state-machine.ts:558`

`outputGapped` is set but never read. Recovery is requested immediately, while the transaction remains active; if the replacement screen snapshot arrives before `HISTORY`/`LIVE_RESUME`, the later unconditional reset/history commit overwrites the recovered snapshot.

Before:

```ts
if (gate.buffer.length >= 1000) {
  gate.buffer.shift();
}
gate.buffer.push(new Uint8Array(data));
```

After:

```ts
if (transaction) transaction.outputGapped = true;
this.callbacks.onRebaseRequired?.(deviceId, paneId, 'resource_exhausted');
```

Yet `handleHistory()` still unconditionally calls `onResetTerminal` and `onApplyHistory`, and `handleLiveResume()` completes the transaction and flushes the now-empty buffer. The new test only asserts that the flag and rebase callback occur; it does not verify that stale history cannot subsequently overwrite recovery.

**Fix:** once `outputGapped` is true, skip that transaction’s reset/history/flush commit. Complete or cancel it first, then issue or reissue the rebase request. Add a test with the order `overflow → replacement snapshot → HISTORY → LIVE_RESUME` and assert that history callbacks are not invoked.

## Medium — overflow recovery is permanently lost when callbacks are registered late

**File:** `packages/ws-client/src/state-machine.ts:562`

The state machine explicitly supports construction without callbacks and later replay through `setCallbacks()`, but overflow recovery is sent only through an optional callback and is not deferred. Meanwhile, the buffered data is permanently discarded.

After:

```ts
gate.buffer = [];
gate.overflowed = true;
this.callbacks.onRebaseRequired?.(deviceId, paneId, 'resource_exhausted');
```

`SelectCallbacks` still declares:

```ts
onRebaseRequired?: (...) => void;
```

Thus an overflow before callback registration—or for a valid caller omitting this optional callback—drops all buffered and subsequent gated output, later commits an empty buffer, and never requests recovery. Before the change, overflow retained a bounded tail rather than clearing everything.

**Fix:** store pending rebases and replay them from `setCallbacks()`/`replayDeferred()` when `onRebaseRequired` becomes available. Add coverage for overflow before late callback registration.

**Overall verdict: Request changes—the new overflow path can leave terminal state permanently stale or corrupted.**