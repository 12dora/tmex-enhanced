# F7 — fix the 9 R4 findings on the enrollment engine

## Fix-by-fix

### 1. Global key-log write mutex (BLOCKER)

`enrollment-engine.ts` now has **one engine-wide FIFO chain**:

```ts
let keyLogQueue: Promise<unknown> = Promise.resolve();
function withKeyLogLock<T>(run: () => Promise<T>): Promise<T> {
  const result = keyLogQueue.then(run, run); // 前一条 reject 也照样接着跑
  keyLogQueue = result.then(() => undefined, () => undefined);
  return result;
}
```

`runAdmit(id, run)` (the former `withBusy`) acquires the per-id de-dup entry, then runs the
whole `keyLogHead → build/sign → append/disposition` transaction inside `withKeyLogLock`.
`inFlight` survives only as UI de-dup / `busyPendingId` source, as instructed.

Test `全局 key log 写锁 > 两条不同 pending 的 admit 串行…`: `keyLogHead()` awaits a macrotask and
returns `seq = 5 + appended.length`; two pushes for two distinct pendings. Asserts the call order
is `['head','append','head','append']` and that the decoded records carry `seq 6n` then `7n` — i.e.
the second one was built on the head *after* the first append.

### 2. Revalidate before signing (BLOCKER)

- `confirmManually(enrollmentId)` now takes an **ID**; the authoritative pending comes from
  `listPendingEnrollments()` via `livePending(id, enrollPk?)` (matches id **and** `enrollPk`).
- Revalidation points: before the reservation, after the credential prompt, after the hub
  `collectRedeemedCertificates` call, inside the critical section (`admitInLock` / `resendInLock` /
  `confirmInLock`), after `keyLogHead()` and after record construction in `signAdmit`.
- Stale poll outcomes: `tick()` still judges candidates against the fetch-time snapshot (that is
  the only way to know which pending a certificate belongs to), and `handleOutcome` drops it
  silently when the pending is no longer live — **no** "unknown certificate" toast.
- Tests: `推送已 admit 之后，轮询带回的同一张证书被静默丢弃` (poll round-trip delayed past the
  push admit → exactly 1 append) and `自动 admit 之后再点「确认加入」什么都不做，也不要凭据`.

### 3. Ambiguous append keeps the signed bytes (BLOCKER)

`enrollment.ts` `submitAdmitRecord()` stores the record **before** `appendKeyLog`
(`rememberUnconfirmedRecord`, which no-ops when the identical bytes are already stored) and clears
it only on an explicit `admitted` / `stale` / terminal `error` disposition. A thrown request
(connection reset, timeout, malformed response) propagates with the record retained, so
`admitPlan()` returns `resend` and the exact bytes are re-sent.

Tests: `enrollment.test.ts` — rejecting fetch keeps the record + `admitPlan === 'resend'`;
terminal rejection (`BAD_SIGNATURE`) does not keep it. `enrollment-engine.test.ts` —
`请求抛异常（结果未知）` end-to-end: after the throwing append, the next push re-sends byte-identical
content and no second signature is produced.

### 4. Context binding (SHOULD-FIX)

- `useEnrollmentEngine(ctx)` returns `{ confirmManually }` bound to **that slot**;
  `registerAdmitContext(ctx)` returns `{ confirmManually, release }` (the old bare unregister
  function is gone — test call sites updated).
- Slot values are written in a commit-phase effect (`useEffect` with no deps, declared before the
  mount effect so the value is set before `attachSlot`), never during render.
- Background auto-signing uses `signingContext()` = most recent slot with `mode !== null`;
  `activeContext()` is now only used for toast translation, `activeHubApi()` unchanged.
- A detached slot's `confirmManually` is inert (`slots.includes(slot)` guard, re-checked after
  every await).
- `fanOutDone()` calls `onDone` on **every** live slot, each in its own try/catch.
- Both call sites updated: `nodes-management.tsx`
  (`onConfirm={(pending) => void confirmManually(pending.hubEnrollmentId)}`) and `join-token.tsx`
  (exposed on `JoinEnrollment.confirmManually`).
- Tests: fan-out to both consumers; `mode: null` slot does not block a signable one; manual confirm
  uses the initiating slot's prompt (not the last-registered one); released slot's button is inert.

### 5. Remembered-signer ownership + lease (SHOULD-FIX)

`credential-prompt.tsx`, kept minimal:

- `rememberSigner(signer, now, owner?)` records an owner token; `forgetSigner(owner?)` drops only
  when the owner matches (no argument = unconditional, for page-level reset/tests). Each
  `useCredentialPrompt()` instance owns a `Symbol` (`usePromptOwner`), used by its unmount cleanup
  (`usePromptTeardown`) and by `handle.forget`.
- `leaseSigner(signer)` → `release()`: while a lease is held, `dropRemembered()` detaches the entry
  but defers the seed wipe until the lease is released. The engine leases the signer for the whole
  admit (auto path and manual path) so an unmount cannot zero a root key mid-signature.
- Tests in `credential-prompt.test.tsx`: another instance's unmount does not wipe; ownerless forget
  still wipes; lease defers the wipe until release (and double-release is a no-op).

### 6. No wedged lock (SHOULD-FIX)

`runAdmit` puts every statement after `inFlight.add(id)` — including the `commit()` that publishes
`busyPendingId` — inside `try/finally`. `notify()` wraps each listener in try/catch over a copy of
the set. I/O timeouts were explicitly out of scope and were not added.

### 7. Invalid state no longer masks a later valid certificate (SHOULD-FIX)

`markCertificateReady(id)` atomically adds to `certificateReadyIds` and deletes `invalidById[id]`;
`finishPending()` clears both projections on every terminal state.
Test: bad signature → `invalidById` set → valid certificate → `invalidById` cleared and
`certificateReadyIds` populated (passkey user, so it stops exactly at the confirm button).

### 8. Panel session survives refresh (SHOULD-FIX)

`join-token.tsx`: new `JoinSession { id, admitted }` persisted in `sessionStorage` under
`tmex.connectDevices.joinSession` — **id and a boolean only**, never the join token or any key.
`useJoinSession(createdId, engine)` restores it on mount, reconciles against the authoritative
pending store (`useSyncExternalStore(subscribePendingEnrollments, …)`), clears it on
expiry/cancel/orphan, and stamps `admitted: true` so step 6 keeps showing 「已加入」 after a
refresh. `JoinEnrollment.pending` became `JoinEnrollment.session`; `JoinConfirmStatus` renders from
it. All storage access is try/catch'd and degrades to memory-only when `sessionStorage` is absent.
Tests: the 5 state renders now drive `session`, plus a new
`刷新后引擎投影没了，会话里的「已加入」标记仍然显示`.

### 9. Terminal cleanup + composite reset (SHOULD-FIX)

`finishPending(id, 'admitted' | 'expired' | 'cancelled')` is the single terminal path used by
admit, the expiry sweep and `cancelPending()`: it calls `forgetUnconfirmedRecord(id)` (which also
drops the mirrored `hubUnconfirmedIds`), removes the pending when still present, and clears
`certificateReadyIds` / `invalidById` for that id.
`resetEnrollmentEngineForTest()` now also resets `keyLogQueue`, `clearUnconfirmedRecords()`,
`clearPendingEnrollments()` and `forgetSigner()` — no new reset helpers were needed, all three
already existed. Tests assert the cancel/expiry paths drop the retry record and that reset empties
the collaborating stores.

## Files changed

| File | What |
| --- | --- |
| `apps/fe/src/node/enrollment-engine.ts` | mutex, revalidation, slot binding, terminal cleanup, notify isolation, composite reset |
| `apps/fe/src/node/enrollment-engine.test.ts` | 11 → 20 tests (new API + 9 regression tests) |
| `apps/fe/src/node/enrollment.ts` | `submitAdmitRecord` stores before sending; `rememberUnconfirmedRecord` |
| `apps/fe/src/node/enrollment.test.ts` | +2 tests (throwing append keeps bytes; terminal rejection drops them) |
| `apps/fe/src/auth/credential-prompt.tsx` | owner token + lease; `usePromptOwner` / `usePromptTeardown` |
| `apps/fe/src/auth/credential-prompt.test.tsx` | +3 ownership/lease tests |
| `apps/fe/src/components/side-panels/connect-devices/join-token.tsx` | session persistence, `useJoinSession`, bound confirm |
| `apps/fe/src/components/side-panels/connect-devices/connect-devices-panel.test.tsx` | step-6 tests use `session`; +1 refresh test |
| `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx` | bound `confirmManually(id)` |

`enrollment-watch.ts` and `computer-guide.tsx` needed no change (the watch module is pure
判定 helpers; the guide only forwards the `enrollment` object).

## Verification (from the worktree)

| Check | Result |
| --- | --- |
| `apps/fe$ bun test src/` | **1039 pass / 0 fail**, 72 files (baseline 1024/0; +15 tests) |
| `apps/fe$ bunx tsc --noEmit -p .` | **0** `error TS` (baseline 0) |
| `bunx biome check <9 changed files>` | clean (3 files auto-formatted with `--write`) |
| `bun scripts/complexity/gate.ts` | `complexity gate ok (1091 files, 9067 functions)` |

No allowlist entry was added, raised or deleted. Two new violations appeared during the work and
were **refactored away**, not locked: `useCredentialPrompt` (123 lines) → extracted
`usePromptOwner` / `usePromptTeardown`; `useJoinEnrollment` (CC 18) → extracted `useJoinSession` /
`isSessionGone`.

No i18n change was needed (no new user-visible string). No dev instance was started; no
state-changing git command was run.

## Notes / out of scope

- **Behaviour change worth knowing**: because the signed record is now stored *before* the request,
  `hubUnconfirmedIds` contains the id for the duration of the append. The confirm button is
  disabled during that window (`busyPendingId`), but the label reads 「hub 未确认 / 重试」 rather
  than 「等待新节点加入」 while the request is in flight. This is the price of never losing the
  retry bytes; it is also arguably the truthful state.
- Server-side idempotent replay handling (mentioned in R4 #3) is a gateway/hub concern and was not
  touched.
- I/O abort/timeout (R4 #6, explicitly not required) is still absent: a hung `appendKeyLog` holds
  the engine-wide key-log lock indefinitely. If that is wanted, the right place is a bounded
  `withKeyLogLock` wrapper plus an `AbortController` threaded through `AuthApi`.
- A shared key-log write coordinator covering revoke / passkey / TOTP (R4 #1's "ideally") is **not**
  implemented: those flows live outside `node/` (`use-node-row-actions.ts`,
  `account-security-actions.ts`) and were out of scope. The engine's lock only serialises admits;
  an admit concurrent with a revoke can still race on the head. Promoting `withKeyLogLock` into
  `auth/key-log-actions.ts` and routing every `appendKeyLog` through it would close that gap.
