# Exploration Y2 — Gateway Performance Report

Read-only review of the post-Round-1 code. No repository files or git state were modified.

## Findings

### 1. HIGH value — Uploads read the entire request body and synchronously append it

**Files:** [`file-transfer-routes.ts:60`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/api/file-transfer-routes.ts:60), [`transfer-session.ts:120`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/files/transfer-session.ts:120), [`config.ts:172`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/config.ts:172)

**Hot path / cost:** `req.arrayBuffer()` materializes the complete chunk before validation or writing. The advertised 8 MiB chunk size is returned to clients but not enforced. The default declared upload limit is 2 GiB, and `appendFileSync` blocks the Bun event loop for every chunk.

**Evidence:** A client can declare any size up to 2 GiB, send one body, and force an application-level allocation proportional to that body. A normal 8 MiB upload also performs a synchronous filesystem write on the request path.

**Proposed fix:** Enforce `Content-Length` and remaining-size limits before reading, then consume `req.body` incrementally with a hard byte cap. Replace synchronous appends with an asynchronous file handle or stream, advancing `received` only after the write succeeds.

**Expected gain:** Memory usage becomes bounded by the chunk limit instead of request size; concurrent HTTP and WS traffic remains responsive during uploads.

**Risk:** Medium; partial-body and abort handling need careful cleanup.

**Estimated net line-count change:** `+25` to `+45`.

---

### 2. HIGH value — Legacy pane history capture is unbounded and captures both screen modes

**Files:** [`session-commands.ts:340`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/tmux-client/external/session-commands.ts:340), [`session-commands.ts:347`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/tmux-client/external/session-commands.ts:347), [`session-commands.ts:587`](/Users/konata/code/tmex-enhanced-wt-r6/apps/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/tmux-client/external/session-commands.ts:587), [`local-external-connection.ts:563`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/tmux-client/local-external-connection.ts:563)

**Hot path / cost:** `fetchPaneHistory()` runs two `capture-pane -S -` commands—normal and alternate screen—with no history-line or byte bound. It is invoked when selecting a pane and again after local or SSH control-channel restart.

**Evidence:** Local command output is accumulated through `new Response(...).text()` at [`local-external-connection.ts:104`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/tmux-client/local-external-connection.ts:104); SSH command output is accumulated in a string at [`ssh-external-connection.ts:343`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/tmux-client/ssh-external-connection.ts:343). The newer control-barrier capture already bounds history to 4096 lines, but this legacy path bypasses it.

**Proposed fix:** Route legacy selection/history through the bounded control-barrier capture where possible. Otherwise, capture only the relevant screen mode and enforce a byte limit in both local and SSH command runners; coordinate concurrent requests for the same device/pane.

**Expected gain:** Lower pane-switch and reconnect latency, bounded memory, and substantially less local/remote tmux output for large scrollbacks.

**Risk:** Medium; alternate-screen behavior and legacy terminal reconstruction need regression tests.

**Estimated net line-count change:** `−5` to `+20`.

---

### 3. MEDIUM value — Structure changes can trigger three tmux queries every 50 ms

**Files:** [`control-mode-subscription.ts:13`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/tmux-client/control-mode-subscription.ts:13), [`control-mode-subscription.ts:77`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/tmux-client/control-mode-subscription.ts:77), [`snapshot-projector.ts:244`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/tmux-client/external/snapshot-projector.ts:244), [`snapshot-refresh-coordinator.ts:16`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/tmux-client/snapshot-refresh-coordinator.ts:16)

**Hot path / cost:** Structure notifications are debounced for 50 ms, but the refresh coordinator immediately runs a trailing refresh after the previous one completes. Every refresh executes `display-message`, `list-windows`, and `list-panes`.

**Evidence:** Under continuous notifications where a refresh completes in under 50 ms, the code permits 20 refreshes/second, or up to 60 tmux command executions/second per runtime. Local mode performs subprocess-backed commands; SSH mode sends equivalent commands over its command channel. Refreshes are shared per device runtime, not per client.

**Proposed fix:** Add a quiet-period or minimum refresh interval after each refresh, and combine compatible metadata queries into one control-mode transaction where practical. Preserve an explicit immediate-refresh path for user commands that require fresh state.

**Expected gain:** Much lower tmux process/command pressure during window/pane churn and reconnect recovery.

**Risk:** Low to medium; excessively aggressive coalescing could delay tree updates.

**Estimated net line-count change:** `+10` to `+30`.

---

### 4. MEDIUM value — Watch rules reuse the connection but not the pane capture

**Files:** [`service.ts:219`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/watch/service.ts:219), [`scheduler.ts:49`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/watch/scheduler.ts:49), [`runtime-pool.ts:88`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/watch/runtime-pool.ts:88)

**Hot path / cost:** Each rule has its own timer and invokes `capturePaneText()` independently. `WatchRuntimePool` shares the runtime connection, but there is no `(deviceId, paneId)` capture cache or poller.

**Evidence:** Regex rules can run every 5 seconds. One hundred rules targeting the same pane therefore schedule up to 100 captures every 5 seconds—20 `capture-pane` calls per second—although all rules need the same screen text.

**Proposed fix:** Group rules by device and pane, capture each pane once per polling interval, and evaluate all attached rules against that snapshot. Preserve per-rule cooldown and LLM scheduling independently.

**Expected gain:** Near `N`-fold reduction in tmux captures for `N` rules watching the same pane, especially over SSH.

**Risk:** Medium; freshness and differing rule intervals need explicit scheduling semantics.

**Estimated net line-count change:** `+30` to `+60`.

---

### 5. MEDIUM value — Remote directory listing parses the entire directory before applying the 2,000-entry cap

**Files:** [`device-storage.ts:172`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/files/device-storage.ts:172), [`rsync.ts:161`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/files/rsync.ts:161), [`rsync.ts:249`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/files/rsync.ts:249)

**Hot path / cost:** `runRsync()` buffers all stdout, `parseListOnly()` splits and materializes every entry, and only then does `listDirectory()` slice to `MAX_ENTRIES`.

**Evidence:** Bun microbenchmark with 200,000 synthetic rsync entries:

- Input: 8.01 MiB
- Parse time: 74 ms
- RSS increase: 123.7 MiB
- Parsed entries: 200,000
- Returned after cap: 2,000

**Proposed fix:** Add a bounded list-only parser that streams lines and retains only the best `MAX_ENTRIES + 1` entries according to the final sort order. Also enforce a stdout byte limit or terminate the rsync process once the result cannot change.

**Expected gain:** Memory and parsing cost become proportional to the returned page rather than total directory size.

**Risk:** Medium; truncation must preserve the existing directory-first and name-sorting semantics.

**Estimated net line-count change:** `+20` to `+40`.

---

### 6. MEDIUM value — Every watch-state upsert performs an unused SELECT

**Files:** [`service.ts:237`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/watch/service.ts:237), [`service.ts:272`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/watch/service.ts:272), [`db/watch.ts:225`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/db/watch.ts:225)

**Hot path / cost:** A tick first reads state, then writes state, and `upsertWatchRuleState()` immediately reads the row again. `WatchService` ignores the returned row.

**Evidence:** At 100 minimum-interval regex rules, this is approximately 20 writes and 40 SELECTs per second. An in-memory SQLite benchmark over 5,000 operations measured 12.38 ms with the post-write SELECT versus 4.49 ms without it—about 2.75× the operation time.

**Proposed fix:** Add a no-read upsert used by `WatchService`, or make the service dependency return `void` while retaining the existing readback API for callers that need it.

**Expected gain:** Removes one synchronous DB query per successful watch tick and reduces DB contention.

**Risk:** Low; verify all other callers that depend on the returned state.

**Estimated net line-count change:** `−3` to `+10`.

---

### 7. MEDIUM value — Device and tmux-tree REST endpoints contain synchronous N+1 queries

**Files:** [`device-routes.ts:55`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/api/device-routes.ts:55), [`device-routes.ts:44`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/api/device-routes.ts:44), [`tmux-tree.ts:54`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/api/tmux-tree.ts:54), [`devices.ts:178`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/db/devices.ts:178)

**Hot path / cost:** `GET /api/devices` performs one device query plus one runtime-status query per device. `GET /api/tmux/tree` performs one device query plus one tree-order query per device; these are synchronous DB calls.

**Evidence:** 100 devices produce 101 SELECTs for each list endpoint, before JSON serialization. The reorder response repeats the device/status pattern.

**Proposed fix:** Fetch devices with a left join to runtime status and batch tree-order rows by device ID. Map the joined result in one pass while preserving default values for missing status/order rows.

**Expected gain:** O(N) synchronous queries become one or a small constant number of queries, reducing latency and SQLite lock contention.

**Risk:** Low; mainly query mapping and fallback handling.

**Estimated net line-count change:** `−5` to `+20`.

---

### 8. LOW value — Cold tmux panes still copy every output chunk despite having no consumers

**Files:** [`event-bridge.ts:51`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/tmux-client/runtime/event-bridge.ts:51), [`pane-retention.ts:148`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/tmux-client/pane-retention.ts:148), [`replay-store.ts:92`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/tmux-client/retention/replay-store.ts:92)

**Hot path / cost:** Cold retention copies each `%output` payload and creates a segment even though it stores no replay bytes and has no matching consumers.

**Evidence:** Bun benchmark with 5,000 × 1 KiB chunks:

- Cold: 3.97 ms, 0 retained replay bytes
- Active: 5.65 ms, 2 MiB retained replay bytes

The parser and metadata path still have necessary work, but the cold branch performs avoidable allocation and fan-out setup.

**Proposed fix:** In cold mode, advance sequence state without copying payload data and skip fan-out when there are no active/hot consumers. Preserve the full segment behavior for retained panes.

**Expected gain:** Lower allocation and GC pressure for high-output panes nobody is watching.

**Risk:** Low to medium; confirm no caller depends on the returned cold segment.

**Estimated net line-count change:** `−5` to `+10`.

---

### 9. LOW value — Raw remote-file reads buffer and copy up to 50 MiB

**Files:** [`device-storage.ts:242`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/files/device-storage.ts:242), [`device-storage.ts:301`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/files/device-storage.ts:301), [`file-browser-routes.ts:61`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/api/file-browser-routes.ts:61)

**Hot path / cost:** `readRawFile()` reads the remote file into a `Buffer`, then constructs a second `Uint8Array` copy before returning it in a response. The raw-file limit is 50 MiB.

**Evidence:** A maximum-size response can require roughly two 50 MiB application buffers before response handling, excluding runtime overhead. The regular download path already streams a temporary file, so this is an inconsistency in the raw-file path.

**Proposed fix:** Keep the rsync temporary path and return it through the existing temp-file streaming helper, cleaning it up after EOF or cancellation. As a minimal improvement, return the existing buffer without the second copy.

**Expected gain:** Bounded memory for raw-file downloads and lower peak RSS under concurrent requests.

**Risk:** Low to medium; cleanup on disconnect and correct content headers need testing.

**Estimated net line-count change:** `+15` to `+30` for streaming, or `−1` for the minimal no-copy fix.

## Areas checked and already fine

- Agent deltas are not persisted per event: [`run.ts:320`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/agent/run.ts:320) persists new messages at step boundaries only. A 5,000-delta Bun harness produced 79 coalesced broadcasts and one persisted row; naive per-delta insertion produced 5,000 rows.
- Agent WS broadcasts return immediately without subscribers and encode the event payload once before per-client framing: [`ws-hub.ts:118`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/agent/ws-hub.ts:118).
- Stream deltas are coalesced at 40 ms / 2 KiB by [`run-deps.ts:96`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/agent/run-deps.ts:96); no full session snapshot is sent for each delta.
- Pane emulators are acquired for agent resources, not for every pane or every output stream: [`run-resource-scope.ts:65`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/agent/run-resource-scope.ts:65).
- No active snapshot-polling interval exists in the WS layer; `snapshotPollTimer` is only cleared/tested.
- Local directory browsing uses `Dirent`; it does not stat every normal entry serially: [`directory-browse.ts:113`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/files/directory-browse.ts:113).
- Download responses stream temporary files and clean them up after completion: [`file-transfer-routes.ts:144`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/api/file-transfer-routes.ts:144).
- Site settings reads use a 30-second process cache and do not write on reads.
- Local and SSH control connections use one shared runtime per device, bounded control reconnects, and 0.5/1/1.5-second retry delays; there is no client-per-connection reconnect storm.
- Focused Bun tests had 11 passing agent assertions. The WatchService suite had 22 passes and 7 setup failures caused by the environment’s inability to bind temporary port 0 listeners, not assertion failures.