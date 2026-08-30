# Review report

## Findings

- **should-fix** — [apps/gateway/src/hub/uplink-server.ts:828](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/hub/uplink-server.ts:828)  
  `broadcastNodeList()` returns `false` both when the projection is unchanged and when building it fails. Authentication consequently sends the cached list after a `keyLogSource.head()`/DB failure. A reconnecting node can accept an outdated `key_log_head`, finish synchronization against it, and remain behind after the transient failure recovers because unchanged status heartbeats do not necessarily trigger another broadcast. Return a tri-state result and use cached bytes only for a successfully verified “unchanged” result; retry or fail authentication on build errors.

- **should-fix** — [apps/gateway/src/hub/uplink-server.ts:428](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/hub/uplink-server.ts:428)  
  Both full encoded lists are retained per user until server shutdown. In particular, the last-link close path at [uplink-server.ts:1243](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/hub/uplink-server.ts:1243) builds and caches an offline list even though there are no recipients, so a multi-user hub accumulates two potentially large buffers for every user that has ever connected, including deleted/inactive users. Evict both entries when a user has no authenticated links, or use a bounded cache and a compact fingerprint.

- **should-fix** — [apps/gateway/src/mesh/peer-manager.test.ts:2728](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/mesh/peer-manager.test.ts:2728)  
  The new deadline tests do not simulate timer deadlines: `ImmediateScheduler.tickIntervals()` at [test-support.ts:101](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/mesh/test-support.ts:101) invokes every interval regardless of its delay. The tests therefore call a 5-second interval at `t=4999` and again at `t=5000`, something a real interval cannot do, so missing re-arming or an incorrect next deadline can still pass; iterating the live array can also execute newly appended timers recursively. Use a due-time-aware fake scheduler that advances time and executes only scheduled callbacks, preferably from a snapshot/priority queue.

- **nit** — [apps/gateway/src/hub/uplink-server.ts:559](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/hub/uplink-server.ts:559)  
  A changed list is encoded twice: once for its version-neutral fingerprint and again at line 564 for delivery. Thus the optimisation is N encodes → 2, not N → 1, and the “encodes once” test at [uplink-server.test.ts:1636](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/hub/uplink-server.test.ts:1636) only proves that recipients share the final buffer. Compare a stable structural fingerprint before encoding, or explicitly test and document the intended two-encode behavior.

## Verified OK

- Pending forward streams are identity-checked, cleared on take/pre-open close/expiry, and do not double-close through the reviewed races.
- `PaneData` peeking preserves canonical-encoding and sequence-range validation; malformed frames do not update replay cursors.
- Frame-sizer results depend on UTF-8 byte lengths, so equal-length identities correctly share cached sizes.
- Windowed history paging has no page-boundary skip; its stop condition preserves `applyMessageWindow` results, including over-budget newest-user and no-user sessions.
- SQLite `length(JSON)` undercounts only astral Unicode relative to JavaScript UTF-16 length, causing conservative extra loading rather than missed history.
- First-user-only title loading matches `maybeGenerateSessionTitle()`’s established first-user semantics.
- Peer status comparison preserves normalized metadata and `lastSeenAt`; retirement re-arming and disposal paths are present in production code.
- Successful unchanged node-list builds still deliver cached bytes to a newly authenticated link.

Focused verification passed: agent window 5/5, frame sizing 6/6, canonical state 8/8, forwarder regressions 3/3, peer-manager additions 5/5, and hub additions 3/3. The combined network-heavy run was blocked by sandbox `EADDRINUSE` failures when binding port `0`.