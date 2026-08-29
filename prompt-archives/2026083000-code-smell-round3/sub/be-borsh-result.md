# Table-drive snapshot fields + extract legacy editor — result

Scope: `packages/shared/src/ws-borsh/state-snapshot-diff.ts` (+ two new modules + extended test). No git, no other package files.

## Files

- **Added** `packages/shared/src/ws-borsh/state-snapshot-field-appliers.ts` (144L)
- **Added** `packages/shared/src/ws-borsh/legacy-snapshot-editor.ts` (91L)
- **Changed** `packages/shared/src/ws-borsh/state-snapshot-diff.ts` (266L → 134L)
- **Changed** `packages/shared/src/ws-borsh/state-snapshot-diff.test.ts` (existing two cases kept; field matrix + editor order/replacement added)

Did not touch `schema.ts`, `convert.ts`, `index.ts`, or anything else in the package.

## What moved

### Field application (`state-snapshot-field-appliers.ts`)

`applyPaneFields` / `applyWindowFields` (and `applySessionFields`) are one-line wrappers over shared `applyTypedFields`. Per-entity tables are keyed by source field id; each descriptor has a runtime guard (`isString` / `isNumber` / `isBoolean` / `*OrNull`) and an assignment. Nullable fields still go through `assignOptional` (`null` deletes the key).

Wire rules preserved: iterate fields in source order, last valid value wins, unknown field ids skipped, invalid types skipped, `null` only deletes when the descriptor allows it.

### Tree editor (`legacy-snapshot-editor.ts`)

`LegacySnapshotEditor` owns clone + `removeEntity` / `upsertSession` / `upsertWindow` / `upsertPane`. `applyLegacyStateSnapshotDiff` is orchestration only: clone → removals → ordered upserts by entity kind.

Pane relocation is still the original loop: find by native id, splice only when the owning window is not the destination, append if absent, then apply fields on that same object.

## Metrics

| Symbol | Before | After |
|---|---|---|
| `applyPaneFields` | CC 28 / 30L | CC 1 / 3L (`state-snapshot-field-appliers.ts`) |
| `applyWindowFields` | CC 14 / 15L | CC 1 / 5L (`state-snapshot-field-appliers.ts`) |
| `applyLegacyStateSnapshotDiff` | CC 24 / 75L | CC 6 / 19L (`state-snapshot-diff.ts`) |
| `applyTypedFields` | — | CC ~4 / 7L (generic; lizard did not name it) |
| `state-snapshot-diff.ts` | 266L | 134L |

CC from lizard (same 1 + `if`/`&&`/`||`/`else if` style as the round baseline). Targets met: pane/window ≤ 4, apply-diff ≤ 8.

## Test

Field matrix: every pane field (index, active, width, height, left, top, title, currentPath, currentCommand, customName) and every window field (name, index, active, layout, customName) with valid value, wrong type, and `null`. Plus last-valid-wins + unknown id.

Editor cases: input not mutated; same-window upsert keeps sibling order; move appends to destination and keeps remaining fields; new panes append in upsert order; session id replacement drops windows; window create then field replace; removals-before-upserts recreates a pane; window/pane upserts without session or destination are skipped.

## Verification (`packages/shared`)

- `bun test`: **165 pass / 0 fail** (baseline 141 pass; +24 new cases in this file). No failures in out-of-scope files.
- `bunx tsc --noEmit -p .`: **0 errors**
- `bunx biome check` on the four files above: **clean**

## Skipped

- Did not re-export the new modules from `index.ts` (out of scope).
- Did not extract `decodeLegacyStateSnapshotDiff` (explicitly listed as not worth doing).
- Did not add a session-field matrix (session only has `name`; not requested).

## Bugs found

None. No unrelated fixes.
