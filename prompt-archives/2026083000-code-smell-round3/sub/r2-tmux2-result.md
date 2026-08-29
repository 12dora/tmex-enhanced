# r2-tmux2 — gateway metadata hierarchy, pane snapshot parse, local reconnect

Scope: `buildDesired`, `dispatchPaneStreamByte`, `parsePaneSnapshotRow`, `reconnectControlClient`. No git. No files outside this list (plus their existing tests). Did not merge SSH/local reconnect paths.

## Files

- **Changed** `apps/gateway/src/tmux-client/metadata/hierarchy-builder.ts` (124L → 136L)
- **Changed** `apps/gateway/src/tmux-client/metadata/hierarchy-builder.test.ts` (existing cases kept; +4)
- **Changed** `apps/gateway/src/tmux-client/snapshot-format.ts` (187L → 193L)
- **Changed** `apps/gateway/src/tmux-client/snapshot-format.test.ts` (existing cases kept; +3, layout-12 assertion added)
- **Changed** `apps/gateway/src/tmux-client/local-external-connection.ts` (613L → 636L)
- **Changed** `apps/gateway/src/tmux-client/local-external-connection.test.ts` (existing cases kept; +4)
- **Unchanged** `apps/gateway/src/tmux-client/pane-stream-parser.ts` (skipped `dispatchPaneStreamByte`)

## What moved

### `buildDesired`

Optional field writes are two same-file helpers, same idea as `config-field.ts` specs: `applyDefinedFields` (`!== undefined`) and `applyNonEmptyStringFields` (truthy strings). Window layout / pane geometry / title-path-command / unknown-pane hints go through those tables; required fields and the pane-epoch throw stay explicit. Host-empty custom name still wins over snapshot `customName` via `??` then the truthy check (empty host string does not fall through).

### `parsePaneSnapshotRow`

Reuses the phase-1 `SNAPSHOT_FIELD_LAYOUTS` map: count 12 is `{ prefixCount: 9, suffixCount: 2 }` so title is the flexible middle span and command/path stay right-anchored. `parsePaneSnapshotRow` calls `splitSnapshotFields(line, 12)` instead of hand-slicing `parts.slice(9)`. Flag parse and optional free-text (title keeps surrounding whitespace; command/path trim) live in `parseSnapshotFlag` / `optionalSnapshotText`. The remaining `if` is the required id/int/flag check with TypeScript narrowing.

### `reconnectControlClient`

Pure `classifyControlSessionProbe` decides `spawn-unavailable` (sentinel `-2` first) vs `session-gone` (stderr, then stdout, then default) vs `alive`. `isControlLifecycleActive` replaces the duplicated `connected && !manualDisconnect` tests. Give-up, session-gone status/notify/shutdown, spawn-pressure decrement + delayed retry, and start/snapshot/history stay in this function. SSH reconnect was not touched.

## Metrics

McCabe = 1 + `if` / `for` / `&&` / `||` / `?:` / `??` / `catch` (same style as the round baseline). Length is function span.

| Symbol | Before | After |
|---|---|---|
| `buildDesired` | CC 18 / 76L | CC 7 / 67L |
| `applyDefinedFields` | — | CC 3 / 9L |
| `applyNonEmptyStringFields` | — | CC 3 / 9L |
| `parsePaneSnapshotRow` | CC 16 / 44L | CC 11 / 38L |
| `parseSnapshotFlag` | — | CC 2 / 4L |
| `optionalSnapshotText` | — | CC 4 / 6L |
| `reconnectControlClient` | CC 16 / 64L | CC 11 / 65L |
| `classifyControlSessionProbe` | — | CC 5 / 12L |
| `isControlLifecycleActive` | — | CC 2 / 3L |
| `dispatchPaneStreamByte` | CC 18 / 35L | skipped (unchanged) |

## Verification

Characterization tests were green against the pre-refactor bodies. New `classifyControlSessionProbe` / layout-12 tests failed until the exports and `SNAPSHOT_FIELD_LAYOUTS[12]` existed, then passed.

- Scoped: `hierarchy-builder.test.ts` + `snapshot-format.test.ts` + `local-external-connection.test.ts` → **70 pass / 0 fail**
- `bun test` (full package): **1669 pass / 0 fail** (baseline 1559; extras are this slice’s +11 cases plus other agents in the same worktree)
- `bunx tsc --noEmit -p .`: **32 errors** (baseline 27). **None** in scoped production files. Extra vs baseline are other agents (`push/*`, `ws/issue45*`, `telegram/service.ts`, `system/managed-endpoint.test.ts`, `ssh-*`, …). One pre-existing error in an untouched test at the bottom of `local-external-connection.test.ts` (see below). Two errors in `local-external-connection.eagain.test.ts` which this slice did not edit.
- `bunx biome check` on the six scoped files: **clean**

## Skipped

**`dispatchPaneStreamByte` (CC 18 / 35L).** Already a flat phase `switch` that groups OSC / screen-title / DCS-tmux fall-throughs into existing handlers. A `Record<ParserPhase, handler>` would lose exhaustiveness grouping, add a hash lookup on the byte hot path, and would not be easier to read than the switch. Per the task note, table form is not clearly simpler and was not attempted.

Did not flatten `parsePaneSnapshotRow`’s remaining required-field `if` into `.some(v => v === null)`: that would drop TS narrowing of `index` / flags. Did not extract give-up / session-gone / resume into extra private methods (would force jumping for a still-linear lifecycle). Did not run Playwright e2e (`apps/fe/tests`).

## Bugs found

Pre-existing, not fixed: `local-external-connection.test.ts` concurrent-snapshot test assigns `releaseStale = resolve` inside a `Promise` executor, then calls `releaseStale?.()`. `tsc` reports TS2349 (`Type 'never' has no call signatures`) — classic control-flow narrowing of `(() => void) | null`. Out of scope of this refactor.

No unrelated fixes.
