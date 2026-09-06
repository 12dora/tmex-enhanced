Found six actionable defects.

1. **P1 — A stalled delivery blocks all subsequent notifications to that sink.**  
   [mesh-forwarder.ts:157](/Users/konata/code/tmex-r31/apps/gateway/src/events/mesh-forwarder.ts:157)

   `deliverOnce()` awaits delivery without a deadline, and the bridge calls `forwardInternalHttp()` without an abort signal. That transport waits indefinitely for response headers. A concrete trigger is a sink webhook that accepts the connection but stalls: the sink awaits `EventNotifier.notify()` before responding, leaving the sender’s lane permanently `draining`. Backoff and queue expiration never run; subsequent notifications eventually overflow the queue.

   **Fix:** Add a bounded delivery deadline, propagate cancellation through the bridge to `forwardInternalHttp()`, and bound sink-side channel execution. Test a delivery that remains unresolved beyond the queue TTL.

2. **P2 — A stale Hub/Relay advertisement overrides a newer direct withdrawal.**  
   [notification-sink-set.ts:59](/Users/konata/code/tmex-r31/apps/gateway/src/mesh/notification-sink-set.ts:59)

   Suppose A advertises `notifySink: true`, then the uplink disconnects while A and B retain their direct connection. Turning A’s switch off updates B’s `peer_cache` through direct status, but B’s `lastNodeList` still contains `true`. OR-ing these sources keeps A in the sink set indefinitely during the outage. Presence decay does not invalidate inventory. B continues posting every event to A and receiving terminal 404 rejections.

   **Fix:** Select the newest authoritative inventory per node instead of OR-ing historical observations. Since uplink lists and direct status both update `peer_cache`, prefer that cache where applicable, with an explicit fallback for other storage sources. Test direct withdrawal after uplink loss.

3. **P2 — Failed-request reinsertion evicts the newest notification.**  
   [mesh-forward-queue.ts:91](/Users/konata/code/tmex-r31/apps/gateway/src/events/mesh-forward-queue.ts:91)

   While an older event is in flight, 20 distinct newer events can fill the pending queue. If delivery fails, `unshift()` reinserts the old event and uses `pop()` to discard the newest event. This reverses the documented “drop oldest” policy precisely during slow or failing delivery.

   **Fix:** Apply the same oldest-event eviction policy when reinserting failed requests; discard the failed entry if it is the oldest overflow candidate. The in-memory reproduction retained `old, new1` and discarded `new2`.

4. **P2 — Stopping a forwarder does not prevent its in-flight request from restarting retries.**  
   [mesh-forwarder.ts:140](/Users/konata/code/tmex-r31/apps/gateway/src/events/mesh-forwarder.ts:140)

   `forget()` removes the lane and cancels its current timer, but an awaiting `drain()` still holds that lane. If delivery subsequently fails, it reinserts the event and schedules another timer without checking whether the lane was disposed. Those retries become invisible to `pending` because the lane is no longer in the map. Separately, mesh shutdown only clears the bridge; it does not stop the channel’s forwarder, so queued retries retain the retired runtime.

   **Fix:** Stop the forwarder when clearing/replacing the bridge, cancel active requests, and check a lane disposal flag or generation after every await. The reproduction produced a new retry timer after `stop()`, while reporting zero pending events.

5. **P2 — Adding the 65th origin resets every origin’s rate limit.**  
   [mesh-internal-notifications-routes.ts:50](/Users/konata/code/tmex-r31/apps/gateway/src/mesh/mesh-internal-notifications-routes.ts:50)

   When the bucket map reaches 64 entries, the next unseen origin calls `buckets.clear()`. In a mesh with at least 65 admitted origins, this restores exhausted origins to a full burst immediately. Repeated traffic across those origins defeats the advertised per-origin limit; marker authentication does not prevent this eviction-based reset.

   **Fix:** Preserve active buckets when capacity is reached. Reclaim only sufficiently idle buckets, or reject new origins/use a bounded overflow limiter. The reproduction changed an exhausted origin’s response from 429 to 200 at the same timestamp after requests from 64 other origins.

6. **P2 — The displayed origin name remains sender-controlled.**  
   [mesh-internal-notifications-routes.ts:137](/Users/konata/code/tmex-r31/apps/gateway/src/mesh/mesh-internal-notifications-routes.ts:137)

   The route validates `origin.nodeId` against the authenticated marker, but accepts arbitrary `origin.nodeName` and stamps it into `payload.nodeName`. An admitted node B can therefore submit its own valid ID with C’s display name, causing sink notifications to identify C as their source. Overwriting a forged name inside `event.payload` does not address this second input path.

   **Fix:** Resolve the display name from the sink’s trusted node metadata using the authenticated marker ID; fall back to that ID. Add a test forging `origin.nodeName`, not just `event.payload.nodeName`.

All **50 targeted Bun tests passed**. Additional in-memory reproductions confirmed the queue eviction, shutdown race, stale advertisement, rate-limit reset, and sender-controlled display name. No repository files were modified.