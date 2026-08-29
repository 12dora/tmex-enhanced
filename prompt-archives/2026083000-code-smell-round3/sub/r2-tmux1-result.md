# r2-tmux1 — gateway pane emulator create + retention readHistory / enforceBounds

Scope: `PaneEmulator.create`, `PaneReplayStore.readHistory`, `RetentionPolicyScheduler.enforceBounds`. No git. Helpers stayed in the same three files (no new modules). Existing test cases kept; table-driven boundary cases added.

## Files

- **Changed** `apps/gateway/src/tmux-client/pane-emulator.ts` (339L → 359L)
- **Changed** `apps/gateway/src/tmux-client/pane-emulator.test.ts` (existing 8 cases kept; +create fallback/cleanup tables)
- **Changed** `apps/gateway/src/tmux-client/retention/replay-store.ts` (336L → 342L)
- **Changed** `apps/gateway/src/tmux-client/retention/replay-store.test.ts` (existing `buildReplayPlan` case kept; +readHistory cursor/byte tables)
- **Changed** `apps/gateway/src/tmux-client/retention/policy-scheduler.ts` (224L → 266L)
- **Changed** `apps/gateway/src/tmux-client/retention/policy-scheduler.test.ts` (existing dispose case kept; +hot-cap / `<=` vs `>` / eviction-order tables)

## What moved

### `create`

`create` is now a dispatch: size fallback via `positiveSize`, then `isRetentionSource` (all four optional APIs present — same AND as before) → `attachRetentionStream` or `attachLegacyStream`. Shared `failCreate` closes a lease if one exists, nulls it, and `terminal.free()`s — used at the same four failure points as the old inlined cleanup (missing identity, capture throw, null checkpoint, null/gapped replay). Capture/subscribe throws *after* those points still skip cleanup, matching the original.

### `readHistory`

Pure `classifyReplayCursor` is the epoch / `seq > latestSeq` (`pane_gap`) / `seq < oldestSeq` (`cache_evicted`) decision; equality on either bound stays a hit. `collectHistoryBefore` owns reverse walk, `chunk.seqStart >= beforeSeq` skip, `seqEnd > beforeSeq` clip, and byte-limit take. Gap pages go through `emptyHistoryPage` (still `seqStart = seqEnd = latestSeq`, empty data, `nextCursor: null`, no `lastTouchedAt` bump). Success still sets `lastTouchedAt` and emits `nextCursor` only when `seqStart > oldestSeq`.

`buildReplayPlan` in the same file now uses `classifyReplayCursor` so the two cursor classifiers cannot drift.

### `enforceBounds`

Phased in place: `capImplicitHotPanes` (keep `max(0, maxHotPanes - explicitHotCount)` most-recent implicit hot; rest `makeCold(..., 'hot_limit')`), early return when `retainedBytes <= maxRetentionBytes`, then `evictImplicitHotForRetention` → `evictCheckpointsForRetention` → `evictOldestReplayChunks` (still re-sorts by first-chunk `receivedAt` each iteration). Rank is `retentionEvictionRank`: active=2, `explicitHot`=1, else=0.

## Metrics

McCabe = 1 + `if` / `for` / `while` / `&&` / `||` / `?:` / `??` / `catch` (same style as the round baseline). Length is function span. lizard is not installed here.

| Symbol | Before | After |
|---|---|---|
| `create` | CC 17 / 79L | CC 3 / 19L |
| `positiveSize` | — | CC 3 / 3L |
| `isRetentionSource` | — | CC 4 / 8L |
| `failCreate` | — | CC 1 / 6L |
| `attachRetentionStream` | — | CC 8 / 38L |
| `attachLegacyStream` | — | CC 5 / 14L |
| `readHistory` | CC 17 / 74L | CC 4 / 31L |
| `classifyReplayCursor` | — | CC 4 / 13L |
| `collectHistoryBefore` | — | CC 7 / 23L |
| `concatBytes` | — | CC 2 / 10L |
| `emptyHistoryPage` | — | CC 1 / 10L |
| `buildReplayPlan` | CC 12 / 55L | CC 8 / 40L (shared classifier; not a listed target) |
| `enforceBounds` | CC 15 / 54L | CC 2 / 9L |
| `capImplicitHotPanes` | — | CC 5 / 17L |
| `evictImplicitHotForRetention` | — | CC 5 / 15L |
| `evictCheckpointsForRetention` | — | CC 4 / 16L |
| `evictOldestReplayChunks` | — | CC 5 / 22L |
| `retentionEvictionRank` | — | CC 3 / 5L |

## Verification

Characterization tables were green against the pre-refactor bodies, then stayed green after the split.

- Scoped: `pane-emulator.test.ts` + `replay-store.test.ts` + `policy-scheduler.test.ts` + `pane-retention.test.ts` → **53 pass / 0 fail**
- `bun test` (`apps/gateway`): **1669 pass / 0 fail** (baseline 1559; extras are this slice’s new cases plus other agents in the same worktree)
- `bunx tsc --noEmit -p .`: **25 errors** (baseline 27). **None** in scoped files. Remaining errors are pre-existing / other-agent (`ssh-*`, `ws/issue45*`, …)
- `bunx biome check` on the six scoped files: **clean**

Did not run Playwright e2e (`apps/fe/tests`).

## Skipped

None of the three listed functions. They were not flat dispatch: `create` duplicated lease/terminal teardown, `readHistory` duplicated cursor classification with `buildReplayPlan`, `enforceBounds` hid three eviction phases behind one rank ternary.

Did not add a file-per-function. Did not broaden `failCreate` to `write` / `readPaneReplay` / `subscribe` throws (those were never cleaned up). Did not change `>` vs `>=` / `<=` on seq, byte caps, or hot slots.

## Bugs found

None. No unrelated fixes.
