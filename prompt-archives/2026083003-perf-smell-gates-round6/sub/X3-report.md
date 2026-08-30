# Gateway performance audit — Exploration X3

Measurements below are inline Bun microbenchmarks on Bun 1.3.14 / macOS arm64. No repository files were modified.

## 1. HIGH — Pending forwarded streams can leak indefinitely

Files: [forwarder.ts:532](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/mesh/forwarder.ts:532), [forwarder.ts:168](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/mesh/forwarder.ts:168), [mesh-http.ts:290](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/mesh/mesh-http.ts:290)

Hot path / cost: `handleRemoteWs()` stores every opened remote stream in the module-level `pendingStreams` map before WebSocket `open`. If the browser socket closes before `open`, `handleForwardSocketClose()` finds no pump and returns, leaving the token and remote stream retained. Only `takePendingForwardStream()` removes entries, and there is no TTL or size bound.

Evidence: each aborted pre-open upgrade can retain one `OpenedWsStream`, its link references, and callbacks permanently. This is an unbounded resource-retention path rather than merely a theoretical map-growth concern.

Proposed fix: make the close handler discard `ws.data.token` when no pump exists, deleting the map entry and closing the associated stream. Add an identity-checked short expiry as a second safety net for connections that never deliver either `open` or `close`.

Expected gain: prevents cumulative memory, socket, and mesh-stream exhaustion under repeated aborted upgrades.

Risk: Low; the token is removed on normal `open`, so cleanup must only close the still-pending entry.

Estimated net line-count change: `+8–15`.

## 2. HIGH — Every agent turn loads and re-serializes the complete transcript

Files: [run.ts:288](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/agent/run.ts:288), [build-run-request.ts:27](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/agent/build-run-request.ts:27), [db/agent.ts:243](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/agent/db/agent.ts:243), [run.ts:410](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/agent/run.ts:410)

Hot path / cost: `assembleRunRequest()` synchronously selects every message and maps every JSON content value. `applyMessageWindow()` then calls `JSON.stringify()` for every message, even though it may discard most of the old prefix; title generation performs another full-history query.

Evidence from `applyMessageWindow()` alone:

- 1,000 messages / ~2.0 MiB: `0.567 ms`
- 10,000 messages / ~19.8 MiB: `4.018 ms`
- 50,000 messages / ~99.1 MiB: `18.831 ms`

These numbers exclude SQLite row materialization and Drizzle JSON parsing, so the real pre-request cost is higher.

Proposed fix: add a windowed history query that first finds the earliest required sequence using stored content lengths or a lightweight metadata query, then loads only the suffix required by the 200,000-character budget. Reuse that bounded history for title generation and preserve the existing user-message boundary rules.

Expected gain: turn assembly, allocations, and DB reads become proportional to the retained context instead of total session history; long-running sessions avoid repeated multi-megabyte or multi-gigabyte scans.

Risk: Medium; incorrect boundary calculation could alter tool-call/user-message pairing, so existing window tests must remain authoritative.

Estimated net line-count change: `+15–25`.

## 3. HIGH — Forwarder fully decodes bulk canonical pane data before forwarding it unchanged

Files: [forwarder.ts:269](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/mesh/forwarder.ts:269), [forwarder.ts:648](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/mesh/forwarder.ts:648), [forwarder.ts:666](/Users/konata/code/tmex-enhanced-wt-r6/apps/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/mesh/forwarder.ts:666)

Hot path / cost: `handleRemoteBytes()` must inspect the envelope, but `StreamReplayState.noteInbound()` additionally fully decodes every canonical event. For `PaneData`, this allocates and decodes the large `data` field only to retain pane cursor metadata, after which the original raw bytes are sent to the browser.

Evidence from a 10 MiB synthetic canonical stream:

- 10,240 × 1 KiB frames: full decode `79.5 ms`; envelope-only `36.5 ms`
- 349 × 30 KiB frames: full decode `63.1 ms`; envelope-only `30.8 ms`

The replay inspection portion is therefore roughly twice as expensive with full payload decoding, before WebSocket transmission.

Proposed fix: add a bounded canonical reader that validates the event header and extracts device, pane, epoch, and sequence fields while skipping the length-prefixed pane data without allocating it. Keep full decoding for non-`PaneData` events and resume-sensitive payloads.

Expected gain: approximately 50% lower replay-inspection CPU for bulk pane traffic and elimination of discarded pane-data allocations.

Risk: Medium-high; the reader must remain aligned with the Borsh schema and preserve malformed-frame rejection behavior.

Estimated net line-count change: `+10–20`.

## 4. MEDIUM — Hub re-encodes the same `node.list` once per recipient

Files: [uplink-server.ts:552](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/hub/uplink-server.ts:552), [uplink-server.ts:558](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/hub/uplink-server.ts:558), [uplink-server.ts:646](/Users/konata/code/tmex-enhanced-wt-r6/apps/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/hub/uplink-server.ts:646), [codec.ts:841](/Users/konata/code/tmex-enhanced-wt-r6/packages/shared/src/uplink/codec.ts:841), [uplink-server.ts:861](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/hub/uplink-server.ts:861)

Hot path / cost: `broadcastNodeList()` builds one message object but `send()` calls `encodeUplinkCtl()` separately for every authenticated link. `handleNodeStatus()` broadcasts after every accepted status update. `UplinkClient.sendStatusIfChanged()` does suppress unchanged heartbeats, so this is not an unconditional per-heartbeat broadcast.

Evidence using a 100-node list with eight devices per node, encoded size ~43.6 KiB:

- 100 recipients: `6.773 ms`, ~4.16 MiB of temporary encoded output
- 500 recipients: `33.853 ms`, ~20.8 MiB of temporary encoded output

Proposed fix: encode the immutable node-list bytes once and add a byte-oriented send helper that preserves the existing per-link error handling. Separately coalesce or suppress broadcasts when the projected node-list state has not changed.

Expected gain: removes N−1 JSON serialization and UTF-8 encoding passes per broadcast; at 500 recipients this saves roughly 34 ms of local CPU in the benchmark.

Risk: Low for pre-encoding; Medium if list-version or broadcast-coalescing semantics are changed.

Estimated net line-count change: `+4–10`.

## 5. MEDIUM — Peer status handling materializes the entire peer table for one node

Files: [peer-manager.ts:1714](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/mesh/peer-manager.ts:1714), [peer-manager.ts:1757](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/mesh/peer-manager.ts:1757), [user-store.ts:354](/Users/konata/code/tmex-enhanced-wt-r6/apps/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/auth/user-store.ts:354), [schema.ts:655](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/db/schema.ts:655)

Hot path / cost: every trusted `node.status` message calls `listPeers()`, which selects and converts every peer row, then performs `.find()` for one `nodeId`. The table has `node_id` as its primary key, but no direct `getPeer(nodeId)` method is used. The handler then unconditionally writes the full peer projection and runs endpoint-upgrade notification.

Evidence: the operation is O(P) in peer count for each status event and performs a synchronous SQLite read plus write. Status messages are event-driven because unchanged status is filtered upstream, but topology/status changes still pay the full-table cost.

Proposed fix: add `getPeer(nodeId)` using the existing primary key and compare normalized endpoint, inventory, and capability fields before writing. Keep `lastSeenAt` updates separate so unchanged metadata does not trigger a full upsert or upgrade check.

Expected gain: O(P) table materialization becomes O(1) lookup, with fewer SQLite writes and fewer unnecessary upgrade evaluations as peer count grows.

Risk: Medium; preserve current `lastSeenAt` and stale-metadata semantics.

Estimated net line-count change: `+5–12`.

## 6. MEDIUM — Peer lifecycle cleanup uses short polling intervals

Files: [peer-manager.ts:1913](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/mesh/peer-manager.ts:1913), [peer-manager.ts:1924](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/mesh/peer-manager.ts:1924), [peer-manager.ts:2033](/Users/konata/code/tmex-enhanced-wt-r6/apps/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/mesh/peer-manager.ts:2033), [peer-manager.ts:2114](/Users/konata/code/tmex-enhanced-wt-r6/apps/konata/code/tmex-enhanced-wt-r6/apps/mesh/peer-manager.ts:2114)

Hot path / cost: idle peers poll once per second for up to five minutes; parked and retiring peers poll every 250 ms for up to 30 seconds. The callbacks mostly perform map lookups and clock checks. Timers are cleared correctly, so this is callback/CPU overhead rather than a leak.

Evidence:

- One idle peer: up to 300 callbacks before expiry.
- 100 idle peers: up to 30,000 callbacks over five minutes, approximately 100 callbacks/second.
- One parked or retiring peer: up to 120 callbacks per 30-second lifecycle.

Proposed fix: replace idle polling with a one-shot deadline timer and re-arm only when stream activity changes. Replace parked/retiring polling with deadline timers plus the existing event-driven checks on stream close and quiesce acknowledgements.

Expected gain: reduces idle cleanup from 300 callbacks to approximately one, and bounded transition cleanup from up to 120 callbacks to one or a small number of event-driven re-arms.

Risk: Medium; timer race behavior must preserve the 2-second quiet, 5-second minimum, and 30-second maximum retirement rules.

Estimated net line-count change: `-5 to +10`.

## 7. LOW — Canonical frame-size cache retains one key per device/pane identity

Files: [frame-sizer.ts:10](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/ws/canonical/frame-sizer.ts:10), [frame-sizer.ts:22](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/ws/canonical/frame-sizer.ts:22), [canonical-feed-session.ts:213](/Users/konata/code/tmex-enhanced-wt-r6/apps/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/ws/canonical-feed-session.ts:213)

Hot path / cost: `maxDataByKey` caches `PaneData` sizing by the literal device ID and pane ID, even though the result depends on encoded byte lengths, not identity. The map has no eviction and device detachment does not remove its keys.

Evidence: a long-lived canonical session that cycles through unique panes/devices grows the map monotonically. The growth is per session, not process-global, and the cached values are small, so this is lower value than the confirmed forwarder leak.

Proposed fix: key the cache by the relevant UTF-8 byte lengths, or expose a device-removal method that deletes all `PaneData` keys on detach. Add a small regression test that exercises repeated attach/detach with unique IDs.

Expected gain: bounded cache cardinality and fewer retained strings; negligible CPU change.

Risk: Low, provided byte lengths—not JavaScript character counts—are used.

Estimated net line-count change: `-2 to +8`.

## Checked and already fine

- [control-mode/framing.ts:30](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/tmux-client/control-mode/framing.ts:30) and [pane-stream-parser.ts:102](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/tmux-client/pane-stream-parser.ts:102): normal pane/control output uses bulk byte runs and only merges cross-chunk fragments; no per-byte string concatenation remains on the main path.
- [terminal-output-batcher.ts:1](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/ws/terminal-output-batcher.ts:1): 16 ms deadline, 64 KiB per-pane cap, 8 MiB global cap, and timer cancellation are explicit.
- [legacy-feed-broadcaster.ts:111](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/ws/legacy-feed-broadcaster.ts:111): event/snapshot payloads are encoded once and reused across recipients; pane observer counts avoid scanning all clients for every output frame.
- [websocket-send-guard.ts:54](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/ws/websocket-send-guard.ts:54): WeakMaps/WeakSets and backpressure timer cleanup prevent per-socket state retention.
- [db/client.ts:9](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/db/client.ts:9): SQLite already uses WAL, `synchronous = NORMAL`, foreign keys, and a 5-second busy timeout.
- [fragment-core.ts:5](/Users/konata/code/tmex-enhanced-wt-r6/packages/shared/src/link/fragment-core.ts:5) and [pane-history-session.ts:3](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/tmux-client/pane-history-session.ts:3): in-flight fragments and history sessions have explicit bounds/TTL cleanup.
- [agent/ws-hub.ts:112](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/agent/ws-hub.ts:112): agent event payloads are encoded once per broadcast and disconnected subscriptions are removed.

## Verification

`bun test apps/gateway/src/agent/build-run-request.test.ts` passed: 8/8 tests.

The combined agent/forwarder/peer-manager/hub run completed 130 passing tests and 6 failures. All six failures were `EADDRINUSE` server-bind failures in `peer-manager.test.ts`; forwarder and hub tests passed.