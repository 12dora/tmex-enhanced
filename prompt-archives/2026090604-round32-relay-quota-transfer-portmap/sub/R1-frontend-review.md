1. **P1 — Deleting a mapping can silently retain its remote authorization**  
   `apps/fe/src/pages/devices/portmap/portmap-actions.ts:66–68`

   If deleting A’s listener succeeds but deleting B’s export returns 401 or fails because B is offline, the exception is discarded and deletion appears successful. B’s persisted export remains enabled indefinitely. An authenticated A peer retaining the map ID can still open streams to that service; B does not verify that A’s mapping still exists.

   **Fix:** Retain a pending-cleanup record and report partial deletion until B’s export is removed. Retry cleanup durably, treating A’s `not_found` as an already completed step. Track failed create compensation similarly.

2. **P2 — Ambiguous creation failures revoke authorization for a live mapping**  
   `apps/fe/src/pages/devices/portmap/portmap-actions.ts:50–51`

   A can persist and start its listener before its response is lost or truncated. `createPortMap()` then rejects, and this catch deletes B’s export despite A’s successful creation. The listener continues occupying its port, but forwarding fails; retrying creation encounters the occupied port.

   **Fix:** Distinguish definitive application rejection from ambiguous transport or response-decoding failures. Reconcile A’s mapping using `exported.mapId` before removing B’s export. If compensating, confirm removal of A’s mapping first.

3. **P2 — Missing transfer jobs retry forever**  
   `packages/panels/src/files/transfer-job-stream.ts:52–56`

   When the source restarts during a transfer, its in-memory job registry disappears, but the browser retains a running row. Both endpoints return 404; this catch ignores the status and keeps retrying because the cached row remains nonterminal. Each stale job eventually generates two requests every eight seconds and cannot be removed through “Clear Finished.”

   **Fix:** Handle `ApiError.status === 404` explicitly: remove or settle the row and terminate its subscription. Reserve retries for recoverable failures.

4. **P2 — Pending submission can start a subscription after dialog cleanup**  
   `apps/fe/src/pages/devices/transfer/send-transfer.ts:46–47`

   Close the dialog while its grant or job POST is pending. Unmount cleanup stops existing subscriptions, but the pending operation subsequently resolves and unconditionally starts another stream. No mounted dialog owns that stream’s cleanup.

   **Fix:** Separate job creation from subscription ownership. Check a dialog lifetime signal before subscribing, or let a lifecycle-managed effect subscribe to newly created jobs. Closing the dialog need not cancel the server-side transfer.

5. **P2 — Opposite-direction submissions defeat the busy guard**  
   `apps/fe/src/pages/devices/transfer/use-send.ts:31` and `:50`

   Start a left-side submission, then submit from the right while the first request remains pending. The single `sending` value changes to `'right'`, re-enabling the left button with its original selection still present. Clicking it creates a duplicate submission. Either operation’s unconditional `finally` can also clear the other operation’s busy state.

   **Fix:** Track pending operations independently per side, with request tokens controlling completion updates, or enforce one submission globally and disable both buttons.

6. **P2 — Late creation responses discard newer user input**  
   `apps/fe/src/pages/devices/transfer/use-send.ts:48`  
   `apps/fe/src/pages/devices/portmap/portmap-dialog.tsx:68–69`

   Transfer panes remain editable during submission. Switch the source node/root and select new files before the old request completes: its callback clears the new selection. The port-map form has the same problem: editing nodes or ports during creation is allowed, but the previous request’s success resets the current draft and restores the old listening node.

   **Fix:** Capture a pane/form revision at submission and apply success resets only when that revision still matches. Alternatively, disable the affected controls while submitting.

7. **P2 — Enter opens the highlighted directory instead of the focused row**  
   `apps/fe/src/pages/devices/transfer/use-transfer-pane.ts:98–101`

   Select directory A, then Tab to directory B’s name button and press Enter. Tab navigation does not update `state.highlight`; the handler merely checks that focus is somewhere inside a picker row, then navigates into A and prevents B’s normal activation.

   **Fix:** Resolve the activated entry from the focused row’s `data-picker-index`, or synchronize highlighting on row focus. Restrict directory navigation to the appropriate row control.

8. **P2 — Filtering leaves the range-selection anchor attached to the wrong file**  
   `apps/fe/src/pages/devices/transfer/pane-state.ts:123–125` and `:161–162`

   With hidden files visible, consider `[.a, b, c, d]`. Select `c`, hide hidden files, then Shift-click `b`. The anchor remains index 2, now identifying `d`, so the selection becomes `b, c, d`. This selects an unintended file for transfer. Pruning selection paths does not repair the index-based anchor.

   **Fix:** Store the anchor by entry path and resolve its current index when selecting a range. Clear it when its entry disappears; likewise reconcile highlighting after list changes.

9. **P2 — Completed-item counts include failed files**  
   `packages/panels/src/files/transfer-jobs-store.ts:133`

   `Math.max(itemsDone, event.index + 1)` assumes every preceding item completed successfully or was skipped. The runner continues after individual failures. If file 0 fails and file 1 succeeds while file 2 is transferring, the list reports `2/3` completed, although only one item completed. The final snapshot eventually corrects the count.

   **Fix:** Track item states by index and count `done`/`skipped` transitions idempotently, using the same semantics as snapshot-derived counts.

**Verdict:** Request changes. Remote authorization cleanup, subscription ownership, and asynchronous UI state handling have concrete failure paths. The remaining findings affect transfer selection and progress accuracy.