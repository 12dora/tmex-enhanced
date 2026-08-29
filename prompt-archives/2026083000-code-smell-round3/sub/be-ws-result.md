# gateway watch evaluator + legacy WS feed + inbound frame decode

Scope: `apps/gateway/src/watch/evaluator.ts`, `apps/gateway/src/ws/legacy-feed-broadcaster.ts`, `apps/gateway/src/ws/index.ts` (`handleMessage` only), plus new helpers and tests. No git. Nothing else in the repo.

## Files

- **Added** `apps/gateway/src/watch/evaluator-triggers.ts` (118L)
- **Added** `apps/gateway/src/watch/evaluator-triggers.test.ts`
- **Added** `apps/gateway/src/ws/throttled-event-broadcast.ts` (17L)
- **Added** `apps/gateway/src/ws/throttled-event-broadcast.test.ts`
- **Added** `apps/gateway/src/ws/inbound-frame-decoder.ts` (65L)
- **Added** `apps/gateway/src/ws/inbound-frame-decoder.test.ts`
- **Changed** `apps/gateway/src/watch/evaluator.ts` (157L → 93L)
- **Changed** `apps/gateway/src/ws/legacy-feed-broadcaster.ts` (358L → 367L; helpers stayed in-file)
- **Changed** `apps/gateway/src/ws/index.ts` (719L → 684L; `handleMessage` only + import)
- **Changed** `apps/gateway/src/ws/index.test.ts` (existing cases kept; 5 wire-level `handleMessage` cases added)

## What moved

### 2. Watch trigger state machines (`evaluator-triggers.ts`)

`evaluateMatchTrigger` / `evaluateUnchangedTrigger` own the two trigger state machines. Unchanged no-match `reset`/`ignore` lives in `resetUnchangedStateIfNeeded`; value-change restart in `shouldRestartUnchangedTimer`; once/repeat cooldown in `passesTriggerGate`; stuck-time + gate in `unchangedHoldResult`.

`evaluateWatchRule` still compiles the pattern (`tryCompilePattern`) and selects the last match (`findLastMatch`), then dispatches. Missing-group, reset/ignore, once, repeat, and cooldown semantics are unchanged.

### 8. Throttled legacy event delivery (`throttled-event-broadcast.ts`)

`broadcastThrottledEvent(clients, payload, shouldDeliver, send, record)` iterates clients, applies the predicate, sends, and records delivery attempts.

`broadcastTmuxEvent` still extracts pane/source and builds throttle predicates (bell vs notification). Empty notifications still drop before encode. Unthrottled event types still send to every client and record `entry.clients.size`.

### 9. Inbound frame decoding (`inbound-frame-decoder.ts`)

`decodeInboundFrame` returns `{ status: 'ignore' } | { status: 'error', code, message, retryable } | { status: 'ok', kind, seq, payload }`. It owns magic checks, envelope decode, chunk reassembly, and error metadata (`WsBorshError` fields, else `ERROR_INVALID_FRAME` + `Invalid envelope` / `Invalid chunk`).

`handleMessage` ignores string frames, sends protocol errors, or calls `handleBorshMessage`. HELLO handling and handler dispatch were not touched.

## Metrics

CC from lizard (same 1 + `if`/`&&`/`||`/`?:`/`for`/`catch` style as the round baseline). Length is lizard `length` (function span).

| Symbol | Before | After |
|---|---|---|
| `evaluateWatchRule` | CC 24 / 85L | CC 5 / 26L |
| `evaluateMatchTrigger` | — | CC 2 / 17L |
| `evaluateUnchangedTrigger` | — | CC 6 / 28L |
| `broadcastTmuxEvent` | CC 24 / 70L | CC 7 / 62L |
| `broadcastThrottledEvent` | — | CC ~3 / 17L (lizard did not name the generic) |
| `handleMessage` | CC 15 / 53L | CC 4 / 18L |
| `decodeInboundFrame` | — | CC 6 / 45L |
| `evaluator.ts` | 157L | 93L |
| `legacy-feed-broadcaster.ts` | 358L | 367L |
| `index.ts` | 719L | 684L |

Targets met: `evaluateWatchRule` ≤ 6, `broadcastTmuxEvent` ≤ 10, `handleMessage` ≤ 5.

## Verification (`apps/gateway`)

- Scoped: evaluator + triggers + throttled broadcast + inbound decoder + `ws/index.test.ts` → **109 pass / 0 fail**
- `bun test`: **1559 pass / 0 fail** (baseline 1472 pass / 0 fail; extra passes include this scope and other agents)
- `bunx tsc --noEmit -p .`: **27 errors**, same as baseline; **none in scoped files**
- `bunx biome check` on the 10 scoped files: **clean**

## Skipped

- Did not change HELLO / `handleBorshMessage` / kind dispatch (`index.ts` beyond `handleMessage`).
- Did not extract `extendTmuxEvent` (still CC 15; not in this task).
- Did not shrink `legacy-feed-broadcaster.ts` overall: pane/source extraction and throttle predicates stayed in the class as specified, so the file gained small string helpers.

## Bugs found

None. No unrelated fixes.
