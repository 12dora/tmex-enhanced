Locations below use the supplied diff’s new-file line numbers.

1. **P1 — Managed gateway cannot start because migration 0049 is omitted.**  
   **Location:** `apps/gateway/src/db/managed-migrations.ts:57`

   The diff adds `0049_relay_limits` to the migration journal but adds only `0050_port_maps.sql` to `MIGRATIONS`. Managed startup materializes SQL files from this list, then Drizzle reads every journal entry. It therefore fails with a missing `0049_relay_limits.sql` before starting the gateway, including for existing databases.

   **Fix:** Include `0049_relay_limits.sql` before `0050_port_maps.sql` and verify the materialized migration directory against the journal. The current working tree already contains this correction; the supplied diff does not.

2. **P1 — Receiving FIN destroys the opposite direction, losing responses.**  
   **Location:** `apps/gateway/src/portmap/pump.ts:203`

   A client sends a request and half-closes its write side while waiting for a response. A forwards END to B, whose pump calls `socket.end()`. As the implementation’s own comments and tests acknowledge, this closes the target socket’s read side too. A target that generates its response after receiving EOF cannot deliver that response. Thus even the documented “client FIN first” case is broken across the complete tunnel.

   **Fix:** Implement actual write-half shutdown and continue pumping target responses until their independent EOF. If the current native socket API cannot provide that behavior, replace the socket adapter with one that can. Test a target that produces its entire response only after receiving FIN.

3. **P1 — Per-map limits allow ordinary traffic to disconnect the entire peer link.**  
   **Location:** `apps/gateway/src/portmap/listener.ts:102`

   The 64-connection limit belongs to each listener, whereas LinkMux’s 65 MiB outstanding-byte limit belongs to the shared link. Two mappings to the same node can admit 66 connections. When their destinations stop reading and the streams fill their windows, `addUnacked()` closes the link, disconnecting terminal sessions and other mappings as well. More mappings can also exceed the receiver’s mux stream-count limit.

   **Fix:** Enforce a shared admission/buffering budget across mappings using the same peer link, including inbound TCP streams, with capacity reserved for other traffic. Reject excess TCP connections before opening streams. An in-memory reproduction confirmed that the 66th full-window stream closes the link.

4. **P1 — Normal uploads are reset while a cold peer connection is being established.**  
   **Location:** `apps/gateway/src/portmap/pump.ts:50`

   Before `getLink()` and `openStream()` finish, the listener continues reading into `early`. A local client sending more than 1 MiB during a real DC negotiation or relay connection setup exceeds the cap and is terminated. This is ordinary TCP traffic encountering connection latency, not an abusive sender. The synchronous in-memory integration transport largely eliminates this window.

   **Fix:** Apply socket read backpressure during dialing and resume after attaching the pump. Bound the dialing lifetime with a deadline and explicit stop cleanup so deferred socket-close notifications cannot retain connections indefinitely.

5. **P1 — Timed-out and aborted dials retain underlying connection attempts without an admission bound.**  
   **Location:** `apps/gateway/src/portmap/accept-tcp-stream.ts:82` and `:117`; `apps/gateway/src/portmap/port-probe.ts:44`

   `Promise.race()` times out the caller but does not cancel `Bun.connect()`. Cleanup waits for eventual connection success. Additionally, stream-abort handling is registered only after connecting. A peer with one valid export to an address that silently drops SYNs can repeatedly OPEN/RST streams: mux slots are released immediately while underlying connection attempts accumulate until the OS timeout, exhausting descriptors. Repeated target probes have the same timeout problem.

   **Fix:** Use a cancellable dial primitive, register stream cancellation before dialing, and cancel on timeout and shutdown. Bound pending plus active connections independently of mux stream lifetime, releasing capacity only when the underlying attempt/socket is disposed. Share this dial implementation with target probing.

6. **P2 — Failed resume changes persistent state and prevents subsequent resume attempts.**  
   **Location:** `apps/gateway/src/portmap/manager.ts:125` and `:137`

   Resuming while another process occupies the port persists `paused: false` before `checkPortAvailable()` throws. After the port becomes free, retrying `{paused:false}` skips startup because `wasPaused` is already false. The same condition prevents directly retrying a map whose boot-time bind failed.

   **Fix:** Validate and bind before committing the resumed state, preserving the paused state on failure. Retry startup whenever the requested state is unpaused and no listener exists. A mocked-bind reproduction confirmed the failed resume persists `false`, followed by a retry that makes zero bind attempts.

7. **P2 — Quality: the integration test substitutes away the transport behavior it appears to exercise.**  
   **Location:** `apps/gateway/src/mesh/integration/portmap.integration.test.ts:67` and `:434`

   `peerLinkFactory()` directly adopts an in-memory pair labeled `ws-secure`; it performs no secure transport handshake, network backpressure, or relay traversal. The half-close test receives all echoed bytes before calling `end()` and merely waits for closure. Consequently, the cold-dial failure and response-after-FIN loss above both escape this suite.

   **Fix:** Keep these as component tests, but exercise at least one actual secure peer transport with delayed establishment and a slow reader. Replace the half-close assertion with a client that preserves its read half and receives a response generated after FIN.

**Verdict:** Request changes. The diff has startup, data-loss, and shared-link/resource-exhaustion defects. In-memory checks confirmed the aggregate-window failure and early-buffer rejection; mocked binding confirmed the resume failure. Live TCP reproduction was blocked by the sandbox’s `EPERM` restriction.