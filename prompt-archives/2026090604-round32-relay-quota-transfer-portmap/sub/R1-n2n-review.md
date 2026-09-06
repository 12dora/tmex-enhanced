1. **P1 — Symlinks bypass the grant’s destination boundary.**  
   Locations: [dest.ts:70](/Users/konata/code/tmex-r32/apps/gateway/src/transfer/dest.ts:70), [receiver.ts:279](/Users/konata/code/tmex-r32/apps/gateway/src/transfer/receiver.ts:279).  
   For a grant restricted to `/root/inbox`, an existing `inbox/link -> /root/private` allows `relPath=link/file` to overwrite `/root/private/file`: local validation checks containment in the **root**, not the granted directory. A symlink outside the root also lets recursive `mkdir` create outside directories before validation rejects the request. SSH destinations receive only lexical validation, so an existing symlink can redirect the actual upload outside the root altogether.  
   **Fix:** Resolve and enforce the granted directory boundary before any mutation, including on SSH destinations. Use symlink-safe component traversal and retain that protection through staging and commit.

2. **P1 — `onConflict=skip` can overwrite another writer’s file.**  
   Location: [receiver.ts:180](/Users/konata/code/tmex-r32/apps/gateway/src/transfer/receiver.ts:180).  
   Conflict detection happens only when preparing the file. Two sessions can both observe an absent destination and upload independently; the second commit then deletes/replaces the first session’s completed file. The same happens if a local process creates the destination during the upload. `ResumableSink.commit()` unconditionally removes the destination, and SSH upload likewise lacks no-clobber semantics.  
   **Fix:** Enforce `skip` atomically at final placement. Add a no-clobber sink operation and corresponding remote behavior; an additional existence check alone still races.

3. **P1 — Large directories are silently transferred incompletely.**  
   Location: [expand.ts:87](/Users/konata/code/tmex-r32/apps/gateway/src/transfer/expand.ts:87).  
   `listDirectory()` caps results at 2,000 entries and returns `truncated=true`. Expansion ignores that flag. A directory containing 2,001 files therefore transfers only 2,000 and finishes as `done`; the 5,000-file expansion limit never detects the omission.  
   **Fix:** Reject truncated listings explicitly, or provide a complete bounded enumeration API for transfers instead of using the browser listing API.

4. **P1 — Different source files with the same relative path are falsely reported as transferred.**  
   Locations: [receiver.ts:171](/Users/konata/code/tmex-r32/apps/gateway/src/transfer/receiver.ts:171), [receiver.ts:216](/Users/konata/code/tmex-r32/apps/gateway/src/transfer/receiver.ts:216).  
   Select `/one/report.txt` and `/two/report.txt`, with different contents but equal sizes. Both expand to `report.txt`. After the first commits, the second receives a complete status from the first file’s cached record, sends no bytes, and commits successfully. Both items show `done`, including under `overwrite`, although the second contents never arrive.  
   **Fix:** Detect destination-path collisions during expansion and apply an explicit conflict policy. Canonicalize receiver map keys and distinguish file identity from destination path; reject size changes instead of reusing an incompatible record.

5. **P1 — Transfer resource allocation has no aggregate bounds.**  
   Locations: [routes.ts:119](/Users/konata/code/tmex-r32/apps/gateway/src/transfer/routes.ts:119), [receiver.ts:205](/Users/konata/code/tmex-r32/apps/gateway/src/transfer/receiver.ts:205).  
   An authenticated source user can enqueue unlimited jobs, even with invalid grants, because directory expansion precedes grant redemption. The rsync concurrency limit bounds execution but not queued jobs or retained snapshots. On B, one granted peer can register unlimited file records and upload unlimited aggregate bytes while refreshing its session. The sender’s 5,000-file limit provides no receiver-side protection. Fileless directory trees also evade that expansion counter.  
   **Fix:** Enforce per-user/global job admission limits and receiver-side session, file-count, aggregate-byte, and active-write budgets. Bound all visited expansion entries, including directories.

6. **P2 — Cancellation does not stop local transfers or destination SSH uploads.**  
   Locations: [channel.ts:86](/Users/konata/code/tmex-r32/apps/gateway/src/transfer/channel.ts:86), [job-runner.ts:176](/Users/konata/code/tmex-r32/apps/gateway/src/transfer/job-runner.ts:176), [receiver.ts:282](/Users/konata/code/tmex-r32/apps/gateway/src/transfer/receiver.ts:282).  
   The local channel ignores the abort signal, and the shared driver does not independently stop successful workers after abort. Cancelling a single-file local job during transfer can therefore copy all remaining chunks, commit the file, and report `done`. Destination SSH uploads also receive no cancellation signal and can continue writing after the source cancels. A read-only Bun check confirmed the driver continues all three ranges after abort when the transport returns `landed`.  
   **Fix:** Propagate cancellation into sink readers and remote rsync, check it before scheduling ranges and committing, and make cancellation win when setting the terminal job state.

7. **P2 — Closing a session races with active writes and commits.**  
   Location: [receiver.ts:138](/Users/konata/code/tmex-r32/apps/gateway/src/transfer/receiver.ts:138).  
   `closeSession()` removes the session and launches cleanup without cancelling or awaiting operations already holding its object. A pending preparation can register/create a partial file after cleanup has run. An active ranged write can recreate its `.rx` sidecar after discard, and an already-started commit can continue after DELETE succeeds. Those operations are no longer reachable by session GC.  
   **Fix:** Add a closing state and session-owned cancellation, reject new operations, await active operations, and only then discard files and remove the session.

8. **P2 — Session GC deletes actively progressing transfers.**  
   Locations: [receiver.ts:78](/Users/konata/code/tmex-r32/apps/gateway/src/transfer/receiver.ts:78), [receiver.ts:250](/Users/konata/code/tmex-r32/apps/gateway/src/transfer/receiver.ts:250).  
   Activity is refreshed at request entry and after an entire PUT, not while bytes arrive. An 8 MiB chunk taking over ten minutes is collected mid-upload despite continuous progress. Similarly, A opens B’s session before staging the source file; a long SSH pull can expire the destination session before the first PUT.  
   **Fix:** Track active operations and byte activity, and keep sessions alive during source staging. Check expiry before refreshing it in `getSession()` so late requests cannot revive expired sessions between GC ticks.

9. **P2 — SSH files are marked committed before they reach the destination.**  
   Location: [receiver.ts:270](/Users/konata/code/tmex-r32/apps/gateway/src/transfer/receiver.ts:270).  
   The committed flag is set after local staging rename, before remote directory creation or rsync succeeds. If SSH placement fails, a repeated commit returns success immediately and status advertises the file as complete, although the destination file is absent or unchanged.  
   **Fix:** Track local staging completion separately from destination commitment. Set `committed` only after successful remote placement, and allow retries to resume that placement step.

10. **P2 — Unexpected exceptions leave jobs permanently running.**  
    Location: [routes.ts:136](/Users/konata/code/tmex-r32/apps/gateway/src/transfer/routes.ts:136).  
    The detached runner’s rejection is discarded. For example, `mkdtempSync()` during source staging can throw when temporary storage is exhausted. The job remains `running` with no `finishedAt`; subscribers never receive `end`, and finished-job GC never removes it.  
    **Fix:** Put terminal error handling around the complete runner, map aborts to `cancelled` and other exceptions to `failed`, and perform cleanup before resolving the runner.

11. **P2 — Failed peer acquisition abandons opened source streams.**  
    Location: [forwarder.ts:260](/Users/konata/code/tmex-r32/apps/gateway/src/mesh/forwarder.ts:260).  
    Each PUT opens a file stream before forwarding. `countStreamBytes()` starts a pipe, but if `getLink()` rejects, forwarding returns a 503 without cancelling that pipe. No HTTP stream ever takes ownership of it. Repeated retries against an unavailable peer can leave source readers and file handles open; unlinking the staging file does not close those handles.  
    **Fix:** Cancel the wrapped body whenever forwarding fails before transport ownership is established, including failed stream opens and pre-aborted calls.

12. **P2 — Progress subscriptions buffer without backpressure.**  
    Location: [routes.ts:159](/Users/konata/code/tmex-r32/apps/gateway/src/transfer/routes.ts:159).  
    Every listener immediately emits into `ndjsonResponse()`, whose helper unconditionally enqueues regardless of consumer demand. A connected client that stops reading accumulates events for the job’s remaining lifetime. Byte-progress updates also emit unthrottled `item` events, so throttling aggregate `progress` does not bound this queue. Multiple slow subscribers multiply memory use.  
    **Fix:** Use a bounded subscription buffer, coalesce replaceable progress/item updates, and disconnect consumers that exceed the budget while preserving terminal events.

13. **P2 — Restarted receivers leave unrecoverable partial files behind.**  
    Location: [receiver.ts:198](/Users/konata/code/tmex-r32/apps/gateway/src/transfer/receiver.ts:198).  
    Partial-file identity includes a random session ID, while sessions exist only in memory. After B crashes, a new grant creates a different session and different partial filename. The old files cannot be resumed, and the session timer cannot discover them because its map is empty. This transfer module never invokes a disk sweep, so orphaned local partials and SSH staging directories remain.  
    **Fix:** Persist recoverable transfer metadata with a stable, authorization-bound identity, or implement bounded startup/periodic orphan cleanup. The current restart-resume claim in `job-registry.ts` must also be corrected.

14. **P2 — Finished-job retention does not actually expire while idle.**  
    Location: [job-registry.ts:31](/Users/konata/code/tmex-r32/apps/gateway/src/transfer/job-registry.ts:31).  
    Sweeping happens only during job creation, lookup, or listing. After a batch finishes and the browser disconnects, every snapshot—including potentially thousands of items per job—remains in the process indefinitely despite the stated 30-minute retention.  
    **Fix:** Schedule periodic eviction independently of API traffic and cap retained history by count or memory budget.

15. **P2 — Empty directories disappear from successful transfers.**  
    Location: [expand.ts:93](/Users/konata/code/tmex-r32/apps/gateway/src/transfer/expand.ts:93).  
    Expansion records only files, and destination directories are created only as file parents. Transferring an empty directory, or a tree containing empty subdirectories, reports success without creating those directories.  
    **Fix:** Include explicit directory entries in the transfer manifest and create them through the same authorized destination resolver.

16. **P2 — Forwarder errors escape the shared transfer contract.**  
    Location: [mesh-channel.ts:27](/Users/konata/code/tmex-r32/apps/gateway/src/transfer/mesh-channel.ts:27).  
    `nodeUnreachableResponse()` returns `{code: "NODE_UNREACHABLE"}`. `errorCodeOf()` blindly casts that string, overriding the intended lowercase fallback. An unreachable destination therefore produces a job error outside `TransferErrorCode`; PUT exhaustion subsequently reduces it to `unknown` because the runner’s separate allowlist rejects it.  
    **Fix:** Introduce one validated error normalizer shared by channel and runner. Explicitly map forwarder errors to transfer codes, preserve valid `FileErrorCode` values, and handle cancellation separately.

17. **P2 — Quality issue: the integration test does not exercise its claimed concurrency or reset behavior.**  
    Locations: [transfer.integration.test.ts:244](/Users/konata/code/tmex-r32/apps/gateway/src/mesh/integration/transfer.integration.test.ts:244), [transfer.integration.test.ts:92](/Users/konata/code/tmex-r32/apps/gateway/src/mesh/integration/transfer.integration.test.ts:92).  
    The “four parallel streams” fixture is 6 MiB with an 8 MiB chunk size, so it sends exactly one PUT. Session-open, status, PUT, commit, and close already satisfy `opened > 4`. The reset test cleanly truncates one request body while retaining the link; it never resets a stream, reconnects peers, or traverses an actual relay. The cancellation test aborts before work starts. These tests miss the lifecycle failures above.  
    **Fix:** Use at least four chunks and assert simultaneously active PUTs. Reset a live stream/link after recorded bytes, verify resumed ranges after reconnection, and cancel after writing begins. Exercise relay routing separately from the in-memory mux fixture.

**Verdict:** Request changes. The diff contains authorization-boundary failures, silent transfer omissions, overwrite races, and substantial lifecycle/resource defects. Review included all gateway transfer modules and read-only Bun probes; filesystem integration tests were not run because they create and delete files.