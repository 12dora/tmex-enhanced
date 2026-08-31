## Re-review of the 9 findings

1. **PARTIALLY FIXED** — Admissions now use one FIFO critical section ([enrollment-engine.ts:429](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:429)), but revoke and other key-log writers still read and append outside it ([use-node-row-actions.ts:54](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/pages/settings/nodes/management/use-node-row-actions.ts:54)).

2. **FIXED** — Poll outcomes and manual actions re-resolve the authoritative pending by ID and `enrollPk` after asynchronous boundaries and inside the lock ([enrollment-engine.ts:543](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:543), [enrollment-engine.ts:611](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:611), [enrollment-engine.ts:640](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:640)).

3. **FIXED** — Signed bytes are stored before `appendKeyLog()` and retained when the request throws or remains unconfirmed ([enrollment.ts:385](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment.ts:385)).

4. **PARTIALLY FIXED** — Confirmation is slot-bound, but it still polls through the globally selected `activeHubApi()` and re-reads a mutable slot context after prompting ([enrollment-engine.ts:591](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:591), [enrollment-engine.ts:636](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:636)).

5. **FIXED** — Remembered signers have owner tokens, and both automatic and manual admission hold leases with `finally`-based release ([credential-prompt.tsx:114](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/auth/credential-prompt.tsx:114), [enrollment-engine.ts:558](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:558)).

6. **PARTIALLY FIXED** — Synchronous exceptions no longer wedge `inFlight` or the FIFO chain, but key-log/hub I/O remains unbounded and collaborating-store notification still invokes listeners without isolation ([enrollment-engine.ts:431](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:431), [enrollment.ts:89](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment.ts:89)).

7. **FIXED** — A valid certificate clears the previous invalid projection, while every terminal path clears both certificate projections ([enrollment-engine.ts:515](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:515), [enrollment-engine.ts:380](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:380)).

8. **FIXED** — The panel persists and restores its enrollment ID and admitted marker, reconciling non-admitted sessions against the pending store ([join-token.tsx:117](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/components/side-panels/connect-devices/join-token.tsx:117)).

9. **PARTIALLY FIXED** — Terminal cleanup is centralized and normal stores are reset, but reset neither drains existing operations nor clears the newly introduced lease/deferred-wipe state ([enrollment-engine.ts:380](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:380), [enrollment-engine.ts:715](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:715), [credential-prompt.tsx:40](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/auth/credential-prompt.tsx:40)).

## New defects

### BLOCKER

- **Cancellation can destroy the only safe retry bytes while an append is unresolved.** Multiple admissions may be in `inFlight`, but `busyPendingId` exposes only the latest one ([enrollment-engine.ts:445](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:445)). An earlier enrollment can therefore be cancelled while its stored record is awaiting `appendKeyLog()`; `finishPending()` deletes that record ([enrollment-engine.ts:380](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:380), [enrollment.ts:385](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment.ts:385)). A subsequent network exception loses the exact bytes; success produces contradictory cancelled/admitted terminal state. **Fix:** expose all busy IDs and make cancellation participate in the per-ID transaction state; never discard a submitted record until its disposition is known or reconciled.

### SHOULD-FIX

- **Manual confirmation can splice two contexts.** The signer comes from the context captured before the prompt, while `confirmInLock()` later uses the current `slot.value` and a globally selected hub ([enrollment-engine.ts:592](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:592), [enrollment-engine.ts:634](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:634)). **Fix:** capture an immutable operation context plus principal/generation token, use its `hubApi`, and abort if that generation is no longer current.

- **Signer leases can retain root-key material indefinitely.** Leases are acquired before waiting in the FIFO and released only after network submission finishes ([enrollment-engine.ts:558](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:558), [enrollment-engine.ts:612](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:612)); a hung predecessor or append prevents release, and resend paths lease a signer they never use. **Fix:** do not lease for resend, release immediately after record construction, and bound/cancel queue and network waits.

- **Restored panel sessions lack a strong enrollment or account binding.** Storage contains only `{id, admitted}` ([join-token.tsx:47](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/components/side-panels/connect-devices/join-token.tsx:47)); `admitted: true` bypasses disappearance checks indefinitely, while a non-admitted session matches any pending with that ID ([join-token.tsx:109](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/components/side-panels/connect-devices/join-token.tsx:109)). **Fix:** persist and verify public enrollment identity (`enrollPk`/`createdAt`) plus user/hub identity, expire the marker, and reconcile admission against authoritative membership.

- **The test reset can detach an active FIFO instead of quiescing it.** Replacing `keyLogQueue` and clearing `inFlight` allows an older operation to complete later and mutate the freshly reset state or interfere with a new operation ([enrollment-engine.ts:721](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/node/enrollment-engine.ts:721)). **Fix:** add a generation guard or await/abort all active work before resetting, and reset lease bookkeeping safely.