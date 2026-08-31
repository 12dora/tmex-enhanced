# F9 — close the remaining R5 findings on the enrollment engine

## 1. BLOCKER — cancellation vs unresolved append

`inFlight: Set<string>` became `transactions: Map<string, AdmitTransaction>` where
`AdmitTransaction = { cancelRequested: boolean }`.

- **State**: `EnrollmentEngineState` gains `busyIds: string[]` (every id in a transaction);
  `busyPendingId` stays as `busyIds.at(-1) ?? null`. Both are written by one `commitBusy()` that
  reads the map, so they can never drift apart.
- **`cancelPending(id)`** while a transaction is open only sets `cancelRequested` and returns —
  it no longer touches the pending or the stored record.
- **`runAdmit()`'s `finally`** deletes its own entry (`transactions.get(id) === txn`), re-commits
  busy, and then calls `applyDeferredCancel(id)`:
  - `state.admittedIds.includes(id)` → no-op (accepted → treat as admitted);
  - `unconfirmedRecord(id)` still present (thrown fetch / `unconfirmed` disposition) → no-op:
    pending **and** the exact signed bytes are kept, and `hubUnconfirmedIds` (mirrored from the
    record store) surfaces the state so the resend path can reconcile;
  - otherwise (terminal rejection — `submitAdmitRecord` already dropped the record — or nothing
    was ever submitted) → `finishPending(id, 'cancelled')`.
- **UI**: `EnrollmentSection` now takes `busyIds: string[]` instead of `busyPendingId` and disables
  **both** the confirm and the cancel button on `busyIds.includes(id)`; `nodes-management.tsx`
  passes `engine.busyIds`. The panel's `JoinConfirmStatus` uses `engine.busyIds.includes(id)` for
  its confirm button — **the panel has no cancel button** (never had one), so there was nothing to
  disable there.
- Tests (`enrollment-engine.test.ts`, new `describe('事务期间取消')`): cancel during an in-flight
  append that (a) succeeds → `admittedIds: ['e-cancel-ok']`, `cancelledIds: []`, record dropped;
  (b) throws → record retained byte-identical, pending kept, `hubUnconfirmedIds` set,
  `cancelledIds` empty, and a following manual confirm resends the same bytes; (c) a transaction
  that submits nothing (blocked on the hub lookup) → the cancel is honoured on completion.

## 2. Immutable operation context (R5 #4 + splice)

`OperationContext { api, hubApi, mode, prompt, t, signer, slot, slotGeneration, engineGeneration }`
is built by `openOperation(slot, signerAccessor)` at the moment a manual confirm / auto-admit
starts, and is the **only** thing the rest of the operation reads.

- `hubApi` resolves the "slot has no hub yet" fallback (`value.hubApi ?? activeHubApi()`) **once**,
  at snapshot time; `confirmInLock()` polls through `op.hubApi`, never `activeHubApi()`.
- `ContextSlot` gained a `generation` counter; `writeSlot()` bumps it when the identity-bearing
  fields change (`api`, `hubApi`, `mode.uid`, `mode.rootEpoch` — `prompt`/`t` are new objects every
  render and deliberately do not count). `useEnrollmentEngine`'s commit-phase effect and the new
  `registerAdmitContext().update()` both go through `writeSlot`.
- `opAlive(op)` (engine generation + slot generation + slot still attached) replaces the old
  `slots.includes(slot)` checks and is re-evaluated after every await; a stale operation is a
  silent no-op and never commits state, toasts, or holds a lease.
- Tests: manual confirm queries **only** the initiating slot's hub channel even though a later-
  registered panel has another one; a slot re-registered with a different hub during the credential
  prompt aborts the confirm entirely (no append, pending untouched).

## 3. Signer lease scope

The lease moved out of `handleOutcome` / `confirmFromSlot` and into the new `buildRecord()`, which
runs inside the critical section after `keyLogHead()`: `op.signer()` → `leaseSigner` → build →
`release()` in `finally`. Nothing is leased across the FIFO wait or across `appendKeyLog`.

`op.signer` is an accessor, not a value: the auto path passes `() => takeRememberedSigner(nowMs())`
so the reuse window is read at the instant of signing (if another prompt instance dropped it while
we queued, we simply don't sign instead of signing with a zeroed seed); the manual path returns the
signer captured from `prompt.request()`. Resend paths (`resendInLock`, and the stored-record branch
of `admitInLock`) never reach `buildRecord` and therefore never lease.

## 4. Notify isolation in `enrollment.ts`

Both `notify()` (pending store) and `notifyUnconfirmed()` iterate a copy with a per-listener
try/catch, same as the engine. Tests: a throwing subscriber neither blocks the next subscriber nor
propagates to `addPendingEnrollment` / `submitAdmitRecord`.

## 5. Revoke through the same key-log mutex (R5 #1)

`withKeyLogLock` is now exported from `enrollment-engine.ts`. In `use-node-row-actions.ts` the
`keyLogHead → buildRevokeNodeRecord → appendKeyLog` sequence is wrapped in it. The only structural
change is that the head fetch moved from *before* `prompt.withSigner(...)` to *inside* it — that is
required for correctness (the head must be read inside the same critical section as the append) and
it deliberately keeps the credential dialog **outside** the lock, so a user staring at the password
box cannot wedge every admit. Nothing else in the hook changed.

Test: `describe('与吊销共用一条写锁')` starts a revoke-shaped closure (structurally identical to the
hook's locked body) through `withKeyLogLock` and pushes a certificate at the same time; the call
order is `['head','append','head','append']` and the two records carry `seq 6n` then `7n`.
The hook itself is not exercised directly — `apps/fe` has no DOM/hook test harness (all component
tests are `renderToStaticMarkup`), so the assertion is on the locked sequence, not on React.

## 6. Panel session binding

`JoinSession` is now `{ id, enrollPk, createdAt, exp, uid, hubNodeId, admitted, admittedAt, nodeId }`
— all public data, still no join token or key. `readJoinSession()` validates every field.

- Restore requires `uid`/`hubNodeId` to match the current auth mode; a non-admitted session must
  additionally match a live pending on `id` **and** `enrollPk` **and** `createdAt`.
- The `admitted` marker expires `ADMITTED_SESSION_TTL_MS` (24 h) after `admittedAt`.
- **Membership reconciliation is implemented**: `finishPending(id, 'admitted', nodeIdHex)` records
  the certificate's node id in an engine-level map exposed as `admittedNodeIdFor(id)`; the panel
  stamps it into the session at admit time, and `isAdmittedMarkerFresh()` drops the marker when the
  shared mesh-node store (`getMeshNodesState()`, read via `useSyncExternalStore` — a snapshot read,
  no extra fetch) is loaded and no longer contains that node. Two cases fall back to the pure time
  expiry and are documented in code: the mesh list not loaded yet (`nodeIds === null`), and a
  session admitted through the **resend** path, which has bytes but no certificate and therefore no
  node id.
- Validation is gated on `identity.ready` (`/api/auth/mode` loaded and non-null) so the refresh
  window — where `uid` is still `null` — cannot wipe a stored session; a `startedRef` guard keeps an
  identity refresh (e.g. a mesh-node event) from resurrecting a session that was just cleared.
- Tests: new `describe('isSessionValid')` covers pending mismatch on each of the three fields,
  uid/hub mismatch, the 24 h expiry, the membership check in all three states (present / absent /
  list unknown), and the "engine just admitted, pending already gone" transition.

## 7. Reset quiescence

`resetEnrollmentEngineForTest()` bumps a module-level `engineGeneration` **first**. Every operation
carries the generation it started under, and `opAlive()` / the `runAdmit` finally check it before
committing anything, so an operation that returns after a reset is a complete no-op (test:
an append still in flight is resolved after the reset and leaves `admittedIds` / `busyIds` empty).
The reset also clears `transactions`, `admittedNodeIds`, and calls the new
`resetSignerLeasesForTest()` in `credential-prompt.tsx`, which drops the lease table **and performs
any deferred wipe it still owes** (otherwise a root seed would be forgotten un-zeroed).
Documented in the function's doc comment: the reset does **not** await or abort in-flight I/O —
`AuthApi` has no abort channel, so hard-waiting would just hang tests; generation guards are the
mechanism instead.

## Files changed

| File | What |
| --- | --- |
| `apps/fe/src/node/enrollment-engine.ts` | transactions/`busyIds`/deferred cancel, `OperationContext` + slot generation, lease scope, `withKeyLogLock` export, `admittedNodeIdFor`, engine generation + reset |
| `apps/fe/src/node/enrollment-engine.test.ts` | 20 → 27 tests (cancel×3, snapshot×3, revoke race) |
| `apps/fe/src/node/enrollment.ts` | per-listener try/catch in both stores |
| `apps/fe/src/node/enrollment.test.ts` | +2 subscriber-isolation tests |
| `apps/fe/src/auth/credential-prompt.tsx` | `resetSignerLeasesForTest()` |
| `apps/fe/src/auth/credential-prompt.test.tsx` | +1 lease-reset test |
| `apps/fe/src/components/side-panels/connect-devices/join-token.tsx` | bound `JoinSession`, `isSessionValid`, readiness gate, `busyIds` |
| `.../connect-devices/connect-devices-panel.test.tsx` | session fixtures + `describe('isSessionValid')` (+5 tests) |
| `apps/fe/src/pages/settings/nodes/management/use-node-row-actions.ts` | revoke inside `withKeyLogLock` |
| `apps/fe/src/pages/settings/nodes/management/enrollment-section.tsx` | `busyIds` prop; cancel disabled while busy |
| `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx` | passes `engine.busyIds` |

## Verification (worktree, `apps/fe`)

| Check | Result |
| --- | --- |
| `bun test src/` | **1070 pass / 0 fail**, 73 files (baseline 1055/0; +15 tests) |
| `bunx tsc --noEmit -p .` | **0** `error TS` (baseline 0) |
| `bunx biome check <11 changed files>` | clean (3 files auto-formatted with `--write`) |
| `bun scripts/complexity/gate.ts` | `complexity gate ok (1092 files, 9089 functions)` |

No allowlist entry was added, raised, or deleted. No i18n change was needed (no new user-visible
string). No dev instance was started; no state-changing git command was run.

## Notes / out of scope

- **`enrollment-engine.ts` is now 880 lines against the gate's 900-line file limit.** I trimmed
  comment bulk to get there and it passes, but the next feature-sized change to this file will trip
  the gate. The natural split is the state projection block (`commit`/`clearProjections`/
  `terminalIds`/`finishPending`/`markCertificateReady`/`markInvalid`) into an
  `enrollment-engine-state.ts`; I did not do it because creating a new module was outside the file
  scope I was given.
- `registerAdmitContext()` now also returns `update(next)`. It is the non-React equivalent of the
  commit-phase effect (and the only way to exercise slot-generation aborts without a DOM harness).
- I/O abort/timeout is still absent: a hung `appendKeyLog` holds the engine-wide key-log lock (and
  now the revoke path too) indefinitely. Closing that needs an `AbortController` threaded through
  `AuthApi` plus a bounded `withKeyLogLock`, which is an api-client change.
- Other key-log writers outside `node/` and the nodes page — `account-security-actions.ts`
  (passkey / TOTP records) — still append outside the lock. Routing them through the same
  `withKeyLogLock` is a one-line change per call site but those files were out of scope.
- Behaviour note carried over from F7 and unchanged: because the signed record is stored before the
  request, the pending reads 「hub 未确认 / 重试」 while an append is in flight (the buttons are
  disabled during that window).
