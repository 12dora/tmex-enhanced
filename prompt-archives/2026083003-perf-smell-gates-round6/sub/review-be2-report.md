# Review report

Request changes: two blockers and eight additional issues found.

## Findings

1. **blocker** — [apps/gateway/src/files/transfer-session.ts:147](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/files/transfer-session.ts:147)  
   Concurrent chunks can both validate against the same `received` value before either async write advances it. Two simultaneous `offset=0` requests can both append and return 200, corrupting the committed file.  
   **Fix:** Serialize validation, writing, and `received` advancement per upload session.

2. **blocker** — [apps/gateway/src/watch/scheduler.ts:205](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/watch/scheduler.ts:205)  
   If the last rule is detached while its pane tick is in flight, the empty group remains with no timer. A concurrent same-pane rule with an equal or longer interval reuses that group without re-arming, leaving the new rule permanently unscheduled.  
   **Fix:** Unconditionally reset and arm empty/timerless groups when attaching, or delete empty groups immediately and track in-flight work separately.

3. **should-fix** — [apps/gateway/src/files/transfer-session.ts:151](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/files/transfer-session.ts:151)  
   `fh.write(bytes)` ignores `bytesWritten`, and an error after a partial append leaves bytes on disk while `received` remains unchanged. Retrying the offset then duplicates the partial data.  
   **Fix:** Write until the complete buffer is persisted and truncate back to the validated offset on any write/close failure.

4. **should-fix** — [apps/gateway/src/files/transfer-session.ts:155](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/files/transfer-session.ts:155)  
   Cancel can delete a session while an append still holds an open descriptor. The append may subsequently advance the detached session and return success after cancellation.  
   **Fix:** Coordinate cancellation through the per-session append queue and verify the session is still current before advancing or returning success.

5. **should-fix** — [apps/gateway/src/watch/scheduler.ts:87](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/watch/scheduler.ts:87)  
   Accruing only `group.minIntervalMs` and resetting to zero changes arbitrary interval semantics: grouped 5s and 7s rules run the 7s rule at 10s, 20s, etc. Re-arming also discards elapsed time; removing a 5s rule after a 30s rule accrued 25s postpones the latter until 55s.  
   **Fix:** Track absolute per-rule deadlines with a monotonic clock and schedule the group for the nearest deadline.

6. **should-fix** — [apps/gateway/src/watch/scheduler.ts:151](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/watch/scheduler.ts:151)  
   Timer events are discarded while any pane tick is active. A slow 30s LLM evaluation can therefore suppress multiple 5s regex ticks on the same pane; unlike the previous scheduler, unrelated rules lose their polling opportunities.  
   **Fix:** Record a pending pane tick and rerun after completion, or release pane exclusivity after the shared capture and evaluate rules independently.

7. **should-fix** — [apps/gateway/src/files/rsync.ts:313](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/files/rsync.ts:313)  
   Truncated-directory semantics changed from “take the first `MAX_ENTRIES` rsync entries, then sort that slice” to “globally select the smallest sorted `MAX_ENTRIES`.” Late directories can now displace entries previously returned. The tests explicitly bless the changed behavior at [rsync.test.ts:163](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/files/rsync.test.ts:163) and [rsync.test.ts:186](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/files/rsync.test.ts:186), so they assert the wrong compatibility baseline.  
   **Fix:** Retain only the first `MAX_ENTRIES + 1` valid entries and sort the returned slice, unless the API contract is intentionally changed.

8. **should-fix** — [apps/gateway/src/tmux-client/external/session-commands.ts:385](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/tmux-client/external/session-commands.ts:385)  
   A successful but empty capture is conflated with target-missing and returns `null`. Legacy pane switching then emits no `TERM_HISTORY`, leaving the switch barrier buffered until its history timeout.  
   **Fix:** Preserve whether capture succeeded; emit an empty history/reset payload with cursor and mode metadata, returning `null` only for an actually missing target.

9. **should-fix** — [apps/gateway/src/tmux-client/external/session-commands.ts:340](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/tmux-client/external/session-commands.ts:340)  
   In-flight history coalescing is keyed only by pane ID, while `SessionCommands` survives control-channel reconnects. The reconnect path can reuse a pre-reconnect capture for the active pane, restoring stale contents or waiting behind a hung old capture.  
   **Fix:** Include the connection/control generation in the key or clear pending captures when the transport generation changes.

10. **should-fix** — [apps/gateway/src/tmux-client/snapshot-refresh-coordinator.ts:30](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/tmux-client/snapshot-refresh-coordinator.ts:30)  
    `requestImmediate()` during an active quiet wait both cancels the wait and records a trailing immediate request. A structure refresh followed by a user command therefore produces two back-to-back refreshes, defeating the churn reduction.  
    **Fix:** Represent “waiting for quiet” separately and upgrade that pending refresh to immediate without scheduling another trailing run.

11. **nit** — [apps/gateway/src/api/device-routes.ts:55](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/api/device-routes.ts:55)  
    The endpoint reads and maps the entire device table through `getAllDevices()` before issuing the new joined query, so devices are decoded twice. The `≤ 3` assertion at [device-routes.test.ts:60](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/api/device-routes.test.ts:60) is too permissive to enforce the intended single batched read.  
    **Fix:** Return `listDevicesWithRuntimeStatus()` directly and assert one list query.

## Verified OK

- Chunked upload bodies without `Content-Length` remain incrementally capped; oversized declared lengths return 413 before body consumption.
- Raw-file `Content-Length` comes from the copied temp file’s actual stat size.
- Temp-file streams invoke cleanup on EOF, cancellation, and read errors.
- Rsync ordering matches the old comparator when the result count is at most `MAX_ENTRIES`.
- Line-streamed rsync still drains stderr and awaits process exit before classifying failures.
- Skipping `-a` after a non-empty current-screen capture is sound; `-a` explicitly selects the alternate screen in the [tmux manual](https://man.openbsd.org/tmux).
- History stdout is bounded incrementally and the local subprocess/SSH channel is terminated on overflow.
- User-command create/kill/split/select paths use `requestImmediate()`, so they do not intentionally wait 150 ms.
- Cold-pane ingest advances sequence state without copying; an older client cursor still produces a rebase, while the first retained hot segment starts at the advanced sequence.
- `writeWatchRuleState()` removes unnecessary readback while `upsertWatchRuleState()` retains its return-value contract.
- Device/runtime defaults, tree response shape, overlay ordering, and empty-tree defaults remain equivalent.
- Bun SQLite reports `MAX_VARIABLE_NUMBER=500000`, so realistic device counts do not hit the common 999-variable limit.

## Verification

- `72 pass, 0 fail`: scheduler, rsync, pane retention, snapshot coordinator, and session commands.
- `14 pass, 0 fail`: device batching, tree batching, and watch-state upsert tests.
- Upload/raw tests could not execute: all nine stopped at setup because the read-only sandbox rejects `mkdtemp` with `EPERM`; these were environmental failures, not assertion results.