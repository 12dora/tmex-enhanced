# gateway tmux-client: table-driven snapshot split + metadata reconcile plan

Scope: `apps/gateway/src/tmux-client/snapshot-format.ts`, `apps/gateway/src/tmux-client/metadata-projection.ts`, new `apps/gateway/src/tmux-client/metadata/reconcile-plan.ts`, plus their tests. No git. Nothing else in the repo.

## Files

- **Changed** `apps/gateway/src/tmux-client/snapshot-format.ts` (197L → 186L)
- **Changed** `apps/gateway/src/tmux-client/snapshot-format.test.ts` (existing cases kept; layouts 2/8, early/unsupported return, `splitFlexibleSnapshotFields` added)
- **Changed** `apps/gateway/src/tmux-client/metadata-projection.ts` (326L → 308L)
- **Added** `apps/gateway/src/tmux-client/metadata/reconcile-plan.ts` (110L)
- **Added** `apps/gateway/src/tmux-client/metadata/reconcile-plan.test.ts` (5 cases)

## What moved

### Snapshot field splitting

`SNAPSHOT_FIELD_LAYOUTS` maps field counts 2 / 4 / 8 / 9 to `{ prefixCount, suffixCount }`. `splitFlexibleSnapshotFields(parts, layout)` takes one flexible middle span (joined with `|`) and right-anchors the suffix. `splitSnapshotFields` keeps the early return when `parts.length <= fieldCount` and still returns the raw split when the count has no layout.

Delimiter-in-title/name behaviour is unchanged: extra `|` tokens stay in the flexible field; suffix fields stay byte-identical via `parts.at(-n) ?? ''`. `suffixCount === 0` (count 2) uses `slice(prefix)` rather than `slice(prefix, -0)`.

### Metadata reconcile planning

`buildMetadataReconcilePlan(records, removedAt, desired, baseRevision, nextRevision)` is a pure comparison. It returns named `creates` / `updates` / `removals` plus an `actions` list in the original order (desired-map creates/updates interleaved, then records-map removals). Update/remove actions capture the live `ProjectedRecord` so recursive subtree removal still double-`markRemoval`s as before.

`MetadataProjection.reconcile` still owns first-establish, `patchBuffer.beginDirtyRevision` / revision bump / `finishMutation`. `applyReconcileAction` performs the queued mutations: create → `createRecord` + `markFullUpsert`; update → parent clone/`markUpsert` then `setRecordField`; remove → `removeRecord`.

Rules preserved: tombstone skip when `removedAt > baseRevision`; stale field skip when `previous.revision > baseRevision`; custom-name skip when desired lacks the field; parent move only when `parentRevision <= baseRevision`; removals skip entities newer than base.

## Metrics

| Symbol | Before | After |
|---|---|---|
| `splitSnapshotFields` | CC 25 / 48L | CC 3 / 11L |
| `splitFlexibleSnapshotFields` | — | CC 2 / 15L |
| `reconcile` | CC 25 / 74L | CC 7 / 29L |
| `applyReconcileAction` | — | CC 6 / 23L |
| `buildMetadataReconcilePlan` | — | CC 12 / 46L |
| `collectFieldChanges` | — | CC 9 / 19L |
| `snapshot-format.ts` | 197L | 186L |
| `metadata-projection.ts` | 326L | 308L |
| `reconcile-plan.ts` | — | 110L |

CC from lizard where it names the function (`splitSnapshotFields` 3, `splitFlexibleSnapshotFields` 2, planner helpers above). Lizard’s TS parser still does not name class methods; `reconcile` / `applyReconcileAction` are McCabe 1 + `if` / `||` / `for` / `?:` (same style as the round baseline). Targets met: `splitSnapshotFields` ≤ 6, `reconcile` ≤ 8.

## Verification (`apps/gateway`)

- Scoped: `snapshot-format.test.ts` + `metadata-projection.test.ts` + `reconcile-plan.test.ts` → **38 pass / 0 fail**
- `bun test`: **1524 pass / 3 fail / 3 errors**. All three are other agents’ in-flight missing modules, not this scope:
  - `./pane-history-pagination` (`pane-history-reader.test.ts`)
  - `./subscription-admission` (`subscription-coordinator.test.ts`)
  - `./canonical-screen-checkpoint` (`canonical-screen-capture.test.ts`)
- `bunx tsc --noEmit -p .`: **46 errors**, none in scoped files. Extra vs baseline 27 are the same other-agent files (missing modules, incomplete tests, plus pre-existing ssh/telegram/ws errors).
- `bunx biome check` on the five scoped files: **clean**

## Skipped

- `parsePaneSnapshotRow` (still CC ~20) — not in this task.
- Did not touch `external/snapshot-projector.ts` (caller of `splitSnapshotFields`).
- Did not flatten `creates`/`updates` execution into separate loops; `actions` keeps the original interleaved order.

## Bugs found

None. No unrelated fixes.
