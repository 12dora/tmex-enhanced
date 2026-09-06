# F2 result — frontend review fixes (R1-frontend-review.md, 9 findings)

Worktree `/Users/konata/code/tmex-r32`. No git operations. All 9 findings fixed, each with unit tests.

## 1. Fixes

### (1) P1 — deleting a mapping could silently retain B's authorization

- `packages/api-client/src/portmap.ts`: `deletePortMap()` now returns `DeletePortMapResult { exportRemoved: boolean }`
  — it reads A's response body (`{ ok: true, exportRemoved }` from P2's backend change) and treats a missing
  field / empty 204 body as `false`. This is the only api-client signature change; the only caller is
  `portmap-actions.ts`.
- `apps/fe/src/pages/devices/portmap/portmap-actions.ts` (rewritten `deletePortMapping`):
  - A's `DELETE` returning `not_found` / 404 counts as done and the flow continues to B (previously it threw).
  - `exportRemoved === true` → stop, and drop any pending record for that mapId.
  - otherwise the UI still tries B's `DELETE /api/portmap/exports/:mapId`; success or B's `not_found` = done.
  - any other outcome (B unreachable/unauthorized, or B's runtime id unresolvable) → a durable pending-cleanup
    record instead of a swallowed exception.
- New `apps/fe/src/pages/devices/portmap/pending-cleanup.ts`: module store (`useSyncExternalStore`) persisted in
  `localStorage` under `tmex:portmap-pending-cleanup`, capped at 20 entries, defensive parsing, storage
  injectable for tests (`setPendingCleanupStorageForTest`). Records carry `{mapId, listenMeshId, targetMeshId,
  label, confirmed, createdAt}` — mesh ids, not runtime ids, so they survive a reload and are re-resolved
  against the current node list.
- New `apps/fe/src/pages/devices/portmap/pending-cleanup-list.tsx`: rows rendered in the port-map dialog under
  「待清理放行」 with a 清理 action (disabled + reason tooltip when the target node is not usable).
- `retryExportCleanup()` in `portmap-actions.ts` drives the retry: for an unconfirmed record it first re-checks
  A's list (`live` → the mapping is alive, drop the record without touching B), then deletes B's export.
  Outcomes: `removed` / `live` (record dropped) vs `pending` (kept, error copy shown).

### (2) P2 — ambiguous creation failures no longer revoke a live mapping

`createPortMapping()` now classifies the failure before compensating:

- definitive 4xx from A → A did not persist → delete B's export (failure → pending record, `confirmed: true`);
- anything else (5xx, network, decode) → re-fetch A's list and look for `exported.mapId`:
  - found → **the map is live**: return it as a success, never delete the export;
  - not found → delete B's export as above;
  - list fetch also failed → do **not** touch the export, record an unconfirmed pending cleanup and rethrow.

### (3) P2 — missing transfer jobs no longer retry forever

- `packages/panels/src/files/transfer-job-stream.ts`: `isJobGone()` (`ApiError.status === 404`) is checked on
  both the events stream and the snapshot fetch; either one settles the row and ends the subscription
  (no reconnect, no further polling). Other failures keep the existing retry/backoff.
- `packages/panels/src/files/transfer-jobs-store.ts`: new `settleMissingTransferJob(nodeId, jobId)` +
  `TRANSFER_JOB_GONE = 'job_gone'` — the row goes to `failed` with error `job_gone` (copy 「任务已不存在」),
  becomes non-cancellable and is removable via “清除已结束”. Exported from `@tmex/panels/files/transfers`.

### (4) P2 — subscription ownership tied to the dialog lifetime

`sendTransfer()` takes an optional `signal` that is **not** passed to the grant/job requests (closing the dialog
must not cancel the server-side job); it only gates `subscribeTransferJob()`. `use-send.ts` owns an
`AbortController` created in a mount effect and aborted on unmount, so a POST that resolves after the dialog is
gone only upserts the row — `useTransferJobsSync` re-subscribes on the next open.

### (5) P2 — busy guard

New `apps/fe/src/pages/devices/transfer/send-runner.ts` (`createSendRunner`, framework-free so it is unit
testable): single-flight (a second submission from either side is rejected outright) plus a request token, so
only the current attempt may write `sending` / `errorKey` / call `onSent`. `discard()` (unmount) invalidates the
in-flight callbacks. `SendController` now exposes `busy`; `TransferPane` gained a `busy` prop and disables
**both** send buttons while any submission is pending (`sending` still drives the button label).

### (6) P2 — late responses no longer discard newer input

- Transfer: `TransferPaneState` gained a monotonic `revision`, bumped by node/root/path/selection-changing
  actions (draft/highlight/move do not bump). `clearSelection` accepts an optional `revision` and is a no-op when
  it no longer matches; the dialog captures the pane's revision at submit time.
- Port map: `resetFormIfUnchanged(submitted, listenNodeId)` in `portmap-form-state.ts`; the dialog captures the
  form object at submit and only resets when the current state is still that same reference.

### (7) P2 — Enter acts on the focused row

`use-transfer-pane.ts` resolves the entry from the focused row's `data-picker-index` (via the new pure
`pickerIndex()` helper) and only when the focus is inside the row's name button (`data-picker-name`), so Enter on
the checkbox is left alone and Enter on a file falls through to normal activation. Row focus also syncs the
highlight (`entry-list.tsx` `onFocusRow` → `{type:'highlight', index, paths}`), so Tab and arrow navigation share
one state.

### (8) P2 — range anchor stored by path

`anchor: number` → `anchorPath: string | null`, plus `highlightPath`. `range` resolves the anchor's current index
from `action.paths` (falling back to a single-row selection when the anchor entry is gone). `prune` now
reconciles everything after a list change: selection pruning, anchor cleared when its entry disappears, highlight
re-resolved by path (or cleared). `move` / `highlight` carry `paths` so the path is always recorded.
Unchanged input still returns the same state reference (no render loops).

### (9) P2 — itemsDone counts only done/skipped

`TransferJobView` gained `itemStates: readonly (TransferItemState|undefined)[]`. Snapshots seed it from
`job.items`; `item` events write the state at their index (`withItemState`) and recompute
`itemsDone = countFinishedItems(...)` — idempotent for repeated events, identical semantics to the
snapshot-derived count, and a failed file 0 no longer inflates the counter.

### Extra (coordinator request)

- Lint: `send-runner.ts` (noAssignInExpressions, import order), `send-runner.test.ts` (noConfusingVoidType),
  `pane-state.ts` + `transfer-job-stream.test.ts` formatting — all fixed without any `biome-ignore`.
- `packages/panels/src/files/use-directory-upload.ts` now passes
  `streams: pickUploadStreams(runtime.nodeId !== SELF_NODE_ID)` into `uploadFileWithTransport`: the REST fallback
  leg for a remote node goes through the hub/relay (2 streams), while a `self` upload stays same-machine
  (4 streams). The bulk/direct path ignores `streams`, so this only affects the fallback.

## 2. i18n

zh_CN authored first, en_US / ja_JP synced, key sets identical (verified), `bun run build:i18n` run from the
repo root. New keys: `devices.transfer.errors.job_gone`, `devices.portmap.cleanup.{title,description,retry,
retrying,unavailable,failed}`. Both live under `devices.*` (rest bundle, not first screen).

## 3. Files touched

New: `apps/fe/src/pages/devices/portmap/pending-cleanup.ts`, `pending-cleanup.test.ts`,
`pending-cleanup-list.tsx`, `pending-cleanup-list.test.ts`;
`apps/fe/src/pages/devices/transfer/send-runner.ts`, `send-runner.test.ts`, `send-side.ts`.

Modified: `packages/api-client/src/portmap.ts` + `portmap.test.ts`;
`packages/panels/src/files/{transfer-jobs-store.ts,transfer-job-stream.ts,transfers.ts,use-directory-upload.ts}`
+ their tests; `apps/fe/src/pages/devices/portmap/{portmap-actions.ts,portmap-form-state.ts,
use-portmap-mutations.ts,portmap-dialog.tsx}` + tests;
`apps/fe/src/pages/devices/transfer/{pane-state.ts,use-transfer-pane.ts,entry-list.tsx,transfer-pane.tsx,
transfer-dialog.tsx,use-send.ts,send-transfer.ts}` + tests;
`packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` (+ generated i18n output).

`transfer-toast.tsx` needed no change (it only drives `startLocalTransfer`, which now seeds `itemStates: []`).

## 4. Gates

| gate | result |
|---|---|
| `bunx tsc --noEmit -p apps/fe` | 0 errors |
| `bunx tsc --noEmit -p packages/panels` | 0 errors |
| `bunx tsc --noEmit -p packages/api-client` | 0 errors |
| `apps/fe` `bun test src/` | **2801 pass / 0 fail** (F1 baseline 2758) |
| `packages/panels` `bun test` | **1070 pass / 0 fail** (was 1063) |
| `packages/api-client` `bun test` | **278 pass / 0 fail** (was 276) |
| `packages/shared` `bun test` | 799 pass / 0 fail (locale consistency green) |
| `bun scripts/complexity/gate.ts` | ok, no violations, no allowlist entries added |
| `bunx biome check` on every touched file | clean |
| root `bun run lint` | only `apps/gateway/dbg1[0-4]-tmp.ts` remain (another agent's temp debug files, not mine) |

## 5. For the commander

1. **Backend contract**: A's `DELETE /api/portmap/:id` should return `{ ok: true, exportRemoved: boolean }`
   (P2). A missing field is treated as `false`, i.e. the UI still cleans B itself — safe either way.
   `deletePortMap()` now resolves to an object; anyone else adding a caller must handle that.
2. `TransferJobView` gained a required `itemStates` field — any other constructor of that type must set it.
3. `devices.portmap.cleanup.*` and `devices.transfer.errors.job_gone` are new keys; re-run `bun run build:i18n`
   once at the end (three agents touched the locale JSONs).
4. Pending-cleanup records live in `localStorage` (`tmex:portmap-pending-cleanup`, ≤20 entries, per browser).
   They are only visible/retryable while the port-mapping dialog is open — that is where the section renders.
5. Not run: e2e (backends not ready) and any live instance.
