# gateway tmux-client: canonical capture, history pagination, subscription admission

Scope: `apps/gateway/src/tmux-client/runtime/canonical-screen-capture.ts`, `pane-history-reader.ts`, `retention/subscription-coordinator.ts`, the three new helpers next to them, and their existing test files. No git. Nothing else in the repo.

## Files

- **Changed** `apps/gateway/src/tmux-client/runtime/canonical-screen-capture.ts` (148L → 74L)
- **Added** `apps/gateway/src/tmux-client/runtime/canonical-screen-checkpoint.ts` (136L)
- **Changed** `apps/gateway/src/tmux-client/runtime/canonical-screen-capture.test.ts` (existing cases kept; +9)
- **Changed** `apps/gateway/src/tmux-client/pane-history-reader.ts` (320L → 318L)
- **Added** `apps/gateway/src/tmux-client/pane-history-pagination.ts` (80L)
- **Changed** `apps/gateway/src/tmux-client/pane-history-reader.test.ts` (existing cases kept; +5)
- **Changed** `apps/gateway/src/tmux-client/retention/subscription-coordinator.ts` (180L → 136L)
- **Added** `apps/gateway/src/tmux-client/retention/subscription-admission.ts` (53L)
- **Changed** `apps/gateway/src/tmux-client/retention/subscription-coordinator.test.ts` (existing cases kept; +5)

## What moved

### 4. Canonical screen capture

`captureFrame(host, paneId, historyLines)` owns barrier vs fallback acquisition (alt-screen fallback still requests `historyLines: 0` and always sets `historyText: null`). Pure `buildCanonicalCheckpoint(input)` owns prefix, cursor sequence, whole-history include-or-drop, UTF-8 tail truncation, mode bits, and history-cursor creation. `estimateHistoryLines` holds the projected-size byte budget.

`CanonicalScreenCapture` still owns in-flight dedup, identity/budget gates, epoch consistency (`identity` / `baseCursor` / `currentIdentity` must match), and `storeScreenCheckpoint`. Alt-screen history is never spliced into the snapshot; history that does not fit the text budget is dropped as a whole.

### 6. History pagination

`computeHistoryCaptureWindow` computes start/end coordinates, anchor inclusion, and capture byte limit. Pure `selectHistoryRows` packs from the newest row, counts the trailing newline, and truncates only when the first (newest) row alone exceeds the budget.

`readPage` still does remote capture, row-count / anchor hashing, cursor/session updates, and the existing `epoch_changed` / `cache_evicted` / `resource_exhausted` mapping. Session bootstrap and page commit stay on the class (`bootstrapHistorySession`, `commitHistoryPage`).

### 7. Subscription admission

`acceptSubscriptionRequests({ mode, requests, occupied, limit, lookupPane, validate })` is called once for `active` and once for `hot`. It clones accepted requests, copies rejection epochs, and treats an already-occupied pane as not consuming an extra quota slot.

`apply` still does closed/disposed checks, generation monotonicity / fingerprint conflict, unique-id + hot-vs-active filtering, active-then-hot ordering, `touchAcceptedPanes`, `refreshModes`, and replay-plan construction.

## Metrics

McCabe = 1 + `if` / `for` / `&&` / `||` / `?:` (same style as the round baseline; lizard is not installed here).

| Symbol | Before | After | Target |
|---|---|---|---|
| `captureInternal` | CC 27 / 100L | CC 8 / 33L | ≤10 |
| `captureFrame` | — | CC 3 / 32L | — |
| `buildCanonicalCheckpoint` | — | CC ~16 / 49L | — |
| `readPage` | CC 19 / 120L | CC 8 / 71L | ≤8 |
| `computeHistoryCaptureWindow` | — | CC 3 / 23L | — |
| `selectHistoryRows` | — | CC 5 / 27L | — |
| `apply` | CC 18 / 112L | CC 7 / 67L | ≤9 |
| `acceptSubscriptionRequests` | — | CC 5 / 28L | — |
| `canonical-screen-capture.ts` | 148L | 74L | ~70L |
| `canonical-screen-checkpoint.ts` | — | 136L | ~80L (also holds `captureFrame` + `estimateHistoryLines`) |
| `pane-history-reader.ts` | 320L | 318L | ~245L (bootstrap/commit stayed in-class) |
| `pane-history-pagination.ts` | — | 80L | ~75L |
| `subscription-coordinator.ts` | 180L | 136L | ~125L |
| `subscription-admission.ts` | — | 53L | ~55L |

All three function CC targets met.

## Verification (`apps/gateway`)

- Scoped: the three existing test files → **31 pass / 0 fail**
- `bun test`: **1559 pass / 0 fail** (baseline 1472; extra passes are this slice’s +19 cases plus other agents in the same worktree)
- `bunx tsc --noEmit -p .`: **27 errors**, matching baseline. None in scoped files (pre-existing ssh/telegram/ws/push/control-mode errors).
- `bunx biome check` on the nine scoped files: **clean**

## Skipped

- Did not run Playwright e2e (`apps/fe/tests`).
- Did not flatten `readPage` further to hit the ~50L sketch; remote capture, anchor hashing, and error mapping stay in the method as specified, so length is 71L with CC 8.
- `acceptSubscriptionRequests` takes `mode` as specified but does not branch on it; quotas stay separate because `apply` calls it twice with different `occupied`/`limit`.

## Bugs found

None. No unrelated fixes.
