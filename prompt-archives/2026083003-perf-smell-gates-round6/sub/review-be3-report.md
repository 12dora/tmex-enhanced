# Review findings

- **Blocker — `apps/gateway/src/mesh/rtc/bulk.ts:175`**  
  Every received upload frame is copied into an unbounded promise chain. A permitted multi-GB upload arriving faster than filesystem writes can retain most of the upload in memory and OOM the gateway because DataChannel transport backpressure does not reflect disk persistence. Add application-level credits/backpressure or enforce a bounded queued-byte limit.

- **Should-fix — `apps/gateway/src/mesh/rtc/bulk.ts:159`**  
  The idle timer is refreshed on frame arrival but not when queued writes complete. If `done` arrives behind a backlog taking over 30 seconds, an upload making continuous disk progress is aborted and deleted. Refresh the watchdog after successful appends and add a low-timeout, multi-write regression test.

- **Should-fix — `apps/gateway/src/watch/scheduler.ts:51`**  
  Production `WatchService` injects wall time, and the adapter only accumulates deltas between observations. If the clock rolls back between `add()` and the first timer callback, the callback records no elapsed time and re-arms a full interval; clock restoration can conversely create a large forward leap. Use a separately injectable monotonic scheduler clock, defaulting to `performance.now()`, while retaining wall time for event timestamps.

- **Should-fix — `apps/gateway/src/watch/scheduler.test.ts:356`**  
  The rollback test samples at four seconds immediately before rolling the clock back, preserving almost the whole interval and masking the normal add-to-first-callback failure above. Remove that intermediate sample, exercise the scheduled callback after rollback, and also test wall-clock restoration.

- **Should-fix — `apps/gateway/src/tmux-client/snapshot-refresh-coordinator.ts:39`**  
  Requests arriving during the pre-refresh quiet wait are marked as trailing even though the pending refresh already covers them. A finite notification burst therefore performs the initial refresh, the coalesced quiet-period refresh, and an unnecessary third refresh. Track the coordinator phase and only create trailing work for requests arriving during or after `refresh()`.

- **Should-fix — `apps/gateway/src/tmux-client/snapshot-refresh-coordinator.ts:30`**  
  A same-tick `request(); requestImmediate()` occurs before `cancelQuiet` is installed, so the user-triggered refresh still waits 150 ms and then causes two refreshes. Let `requestImmediate()` upgrade a leading request before its quiet wait begins and add a same-tick test.

- **Should-fix — `apps/gateway/src/files/rsync.test.ts:217`**  
  The new compatibility test uses full-sort-then-slice, but the previous production path sliced the first `MAX_ENTRIES` rsync entries and then sorted that page. For `c.txt, a.txt, b.txt, zdir` with cap 3, old behavior returns `a,b,c`; the collector returns `zdir,a,b`. Preserve first-page membership with a bounded first-N collector, or explicitly document this as an API change and correct the test premise.

- **Should-fix — `apps/gateway/src/files/rsync.ts:273`**  
  Heap maintenance loses input order when the collator treats names as equal, such as `file1`, `file01`, `File1`, and `FILE1`. At a truncation boundary, this can reorder entries and retain the wrong equivalent item. Record an input sequence and use it as the final comparator tie-breaker.

- **Should-fix — `apps/gateway/src/tmux-client/local-external-connection.ts:137`**  
  UTF-8 alignment removes leading continuation bytes but retains an incomplete trailing sequence. If overflow occurs after a leading byte but before its continuation bytes, valid output such as `bcd E2` decodes as `bcd�`; SSH shares this decoder. Trim incomplete trailing code points or use streaming decoder semantics, and extend the test beyond head cuts.

- **Should-fix — `apps/gateway/src/mesh/uplink-key-log-sync.test.ts:122`**  
  The stale-generation test blocks in the initial `head()`, so reset aborts the flow before `applyMany()` can return its fork result. It would pass even if the post-`applyMany()` generation guard were removed. Block inside `applyMany()`, reset and advance generation, then resolve with a fork result and assert no callback or teardown.

- **Should-fix — `apps/gateway/src/mesh/forwarder.test.ts:397`**  
  The injected TTL is 40 ms, but the test waits only 15 ms. It passes if the setter is ignored, if the old 15-second constant remains, or if the production default regresses. Assert survival across the old boundary and expiry after the configured TTL, preferably with fake timers.

- **Nit — `apps/gateway/src/mesh/stream-replay-state.test.ts:29`**  
  Checking that `noteDeviceConnected` no longer exists does not prove `DEVICE_CONNECTED` is decoded once; an inline second decode would pass. Count decoder invocations through a test seam or leave the performance claim to a benchmark.

- **Nit — `apps/gateway/src/mesh/peer-handshake-timeout.test.ts:6`**  
  Sleeping after promise settlement does not verify that the timeout was cleared, because a later rejection of an already-settled promise is invisible. Spy on or inject `clearTimeout` and assert cleanup directly for resolve and reject paths.

# Verified OK

- Stream replay extraction preserves malformed-frame forwarding, connected-device deduplication, resume readiness, and canonical cursor behavior.
- User-key persistence preserves transaction boundaries, transactional store construction, operation ordering, identity binding, and wipe ordering.
- Rate-limit mutable state remains per `UplinkServer` instance and public re-exports remain compatible.
- Uplink key-log runtime reset, abort, snapshot-before-reset, generation, user-ID, and fork-teardown behavior matches the prior implementation.
- Local and SSH reconnect ordering is preserved, including restart-count write-back and EAGAIN re-entry after `4 ×` delay.
- Upload offset validation occurs inside the shared per-session queue; successful persistence precedes `received` advancement, and `done` remains ordered after pending RTC writes.
- Mesh initialization and holder population order are preserved; node-list pruning and synthetic hub-loss offline events remain equivalent.
- Consolidated IPv6 parsing preserves zone-ID handling, dotted-quad rejection, compression quirks, and both former call paths.
- Device/runtime and tmux-tree batching preserve ordering, missing-row defaults, and single-device behavior.
- Raw-file streaming avoids whole-file buffering and retains EOF/cancellation cleanup paths.

Verification: **230 focused tests passed, 0 failed**. Suites requiring temporary-directory writes or local listener binding could not execute in the read-only sandbox.