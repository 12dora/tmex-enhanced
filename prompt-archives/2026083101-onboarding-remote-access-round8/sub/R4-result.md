# Review findings

## BLOCKER

1. **The lock is per enrollment, but the key-log head is global.**

   [`enrollment-engine.ts:321`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:321) tracks `inFlight` by `hubEnrollmentId`. Two different certificates can therefore enter [`signAdmit()`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:366) concurrently, both read the same head at line 375, and both produce a record for the same next sequence. This can happen with two push events, push plus manual confirmation, or a second poll starting while another outcome is being submitted. `busyPendingId` also proves the engine permits multiple operations while exposing only one of them.

   **Fix:** serialize the entire `keyLogHead → build/sign → append/disposition` transaction with one engine-wide FIFO mutex, not a set keyed by enrollment. Ideally this should be a shared key-log write coordinator covering revoke/passkey/TOTP operations too. Add a test with two distinct pending IDs whose `keyLogHead()` promises overlap.

2. **A stale poll or delayed manual confirmation can sign an enrollment after it has already been admitted or cancelled.**

   [`tick()`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:296) captures `pendings` before awaiting the hub. If a push admits and removes one while that request is pending, the poll later constructs an `admit` outcome from the stale array. [`handleOutcome()`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:402) checks only `inFlight`; after the push releases the lock, it signs the same certificate again.

   The manual path has the same problem: [`confirmManually()`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:444) accepts an arbitrary `PendingEnrollment`, waits outside the lock for credentials, and never verifies that the pending still exists. Auto-admit or cancellation during the prompt therefore leaves it signing a removed pending.

   **Fix:** make manual confirmation accept an ID and resolve the authoritative pending from `listPendingEnrollments()`. Revalidate ID and `enrollPk` immediately before acquiring the signing reservation, after every user/network await, and inside the global key-log critical section. Stale poll outcomes for already-cleared IDs should be ignored without producing an “unknown certificate” alert.

3. **An ambiguous append failure loses the only safe retry bytes and permits re-signing.**

   [`submitAdmitRecord()`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment.ts:362) stores the signed record only after `appendKeyLog()` returns an explicitly classified `unconfirmed` response. A rejected fetch, connection loss after the server commits, malformed response, or indefinitely stalled request bypasses that storage. [`withBusy()`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:324) then releases the lock, and the next push/poll signs again because `admitPlan()` sees no stored record.

   This violates the rule that an uncertain submission must only retry the exact bytes already signed.

   **Fix:** transition the signed record to an “awaiting confirmation” store before sending it. Clear it only after an explicit accepted, stale, or terminal-rejection response. Network exceptions/timeouts must retain the exact record; recovery should resend/reconcile that record, never obtain a new head and sign another one. Server-side idempotent replay handling may also be needed when the original response was lost.

## SHOULD-FIX

4. **Manual actions are not bound to the UI context that initiated them.**

   [`activeContext()`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:156) chooses the last registered slot. Both the management page at [`nodes-management.tsx:146`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:146) and the panel at [`join-token.tsx:243`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/components/side-panels/connect-devices/join-token.tsx:243) call a context-free `confirmManually()`.

   Consequently, a management-page click can invoke the panel’s prompt/API/translation callbacks. A last-registered panel whose mode is still `null` also suppresses a valid management context. The selected context is captured across all subsequent awaits, so its component can unmount before its stale `onDone` or API closure is called. Successful admission invokes only that one context’s `onDone`; when the panel wins, the management page’s `hub.refresh()` parity is lost.

   **Fix:** have `useEnrollmentEngine()` return a confirmation function bound to that slot/token. Select a compatible, credential-ready context separately for background auto-signing, update slot values only in a commit-phase effect, and fan successful completion out to every live consumer’s refresh callback.

5. **Multiple prompt instances have unsafe ownership of the single remembered signer.**

   The new design mounts multiple `useCredentialPrompt()` instances, but every instance’s cleanup calls global `forgetSigner()` at [`credential-prompt.tsx:466`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/auth/credential-prompt.tsx:466). Unmounting either UI can therefore erase a root signer authenticated through the other UI. It can also zero the same root-key object returned by `takeRememberedSigner()` while [`signAdmit()`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:366) is awaiting the head.

   This causes lost auto-admit capability and can invalidate an in-progress signature.

   **Fix:** give remembered signers explicit ownership or leases. A prompt should clear only the signer it created, and the engine should retain a non-wipeable lease until record construction completes. A single host-level credential prompt is another viable design.

6. **The lock can remain wedged indefinitely.**

   [`withBusy()`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:324) adds the ID before entering `try`. If `commit()` or an external-store listener throws, the `finally` is never installed and the ID remains locked. Once inside, `keyLogHead()`, hub polling, and `appendKeyLog()` have neither cancellation nor timeout; unmounting all consumers does not release or abort such work.

   **Fix:** put every statement after lock acquisition inside the `try/finally`, isolate subscriber exceptions in `notify()`, and add bounded I/O with abort/timeout handling. A timeout after submission must transition to the ambiguous/unconfirmed state described above—not merely release the lock and allow re-signing.

7. **A bad certificate permanently masks a later valid certificate in the panel.**

   Invalid results are stored at [`enrollment-engine.ts:409`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:409), but a subsequent valid outcome never removes `invalidById[id]`. The panel checks that error before its confirmation state at [`join-token.tsx:219`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/components/side-panels/connect-devices/join-token.tsx:219). For a passkey user, one bad candidate therefore permanently hides the manual-confirm button even after a valid certificate arrives.

   **Fix:** atomically clear the ID’s invalid state when a valid certificate is accepted, and remove invalid/ready state when the pending reaches any terminal state. Add a `bad signature → valid certificate → confirm button` test.

8. **The panel cannot recover its session-specific pending after refresh or remount.**

   [`join-token.tsx:102`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/components/side-panels/connect-devices/join-token.tsx:102) initializes the tracked pending to `null` and populates it only from the current hook instance’s in-memory `create.created`. Pending enrollments themselves survive in `sessionStorage`, but closing/reopening the panel or refreshing the page loses the association, leaving step 6 blank. A full refresh also loses the engine’s admitted terminal state.

   **Fix:** persist a non-secret panel-session enrollment ID, restore it by matching the authoritative pending store, and clear it on cancellation/expiry. Preserve or reconcile an admitted terminal marker if “admitted” must remain visible after refresh. Do not persist the join token or enrollment private key.

9. **Expiry/cancellation and the test reset leave related singleton state behind.**

   [`scheduleSweep()`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:231) and [`cancelPending()`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:481) remove pending rows but do not call `forgetUnconfirmedRecord()`. Signed retry records and `hubUnconfirmedIds` can therefore survive after their enrollment has expired or been cancelled. `certificateReadyIds` and `invalidById` also accumulate terminal IDs.

   [`resetEnrollmentEngineForTest()`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:536) resets only the engine projection; it does not clear pending storage, unconfirmed records, or the remembered signer, so tests must know and reset several hidden singleton stores separately.

   **Fix:** centralize terminal cleanup so admit, expiry, and cancellation clear retry records and per-ID projections consistently. Provide a composite test reset—or explicitly invoke all collaborating-store reset functions from this helper—to prevent cross-test state leakage.