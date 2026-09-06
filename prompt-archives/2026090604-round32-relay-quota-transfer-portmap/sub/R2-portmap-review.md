1. **P1 — RST detection can permanently retain connections and peer-budget slots**  
   **Location:** [apps/gateway/src/portmap/socket-handlers.ts:44](/Users/konata/code/tmex-r32/apps/gateway/src/portmap/socket-handlers.ts:44)

   Native-handle loss is checked only inside the readable `end` event. Two concrete paths bypass that check:
   - A saturated connection is paused with unread data buffered when its peer sends RST. Bun’s native close handler pushes EOF, but readable `end` waits for that buffer to drain. If the mux consumer remains stalled, disposal never runs.
   - A peer sends FIN, then later resets the remaining connection. Readable `end` already fired for FIN; native close does not generate another one.

   In both cases, the dead socket remains registered, its budget slot stays occupied, and the mesh stream remains open. Repeating this exhausts the default 48-slot peer budget and blocks further mappings to that peer.

   **Evidence:** Exercising the installed Bun 1.3.14 socket handlers with synthetic native-handle loss and the real pump/mux reproduced both paths: `closed=false`, one retained slot, and an unsettled remote stream.

   **Fix:** Detect native-handle loss independently of readable EOF—for example, through an adapter-owned liveness monitor covering paused and half-closed sockets, removed on disposal. Route confirmed loss through `pump.destroy()` and socket destruction. Merely invoking `onClose()` is insufficient because its `localFin`/`streamEnded` guards can suppress reset.

2. **P2 — The new integrity tests cannot detect block substitution or cross-connection mixing**  
   **Locations:** [apps/gateway/src/mesh/integration/portmap.integration.test.ts:446](/Users/konata/code/tmex-r32/apps/gateway/src/mesh/integration/portmap.integration.test.ts:446), [line 498](/Users/konata/code/tmex-r32/apps/gateway/src/mesh/integration/portmap.integration.test.ts:498)

   The payload repeats every 256 bytes, and all eight concurrent connections send identical payloads. Replacing one aligned 256 KiB mux block with another leaves the bytes—and therefore FNV hash—unchanged. Exchanging equal-length responses between connections also passes every hash and aggregate counter assertion.

   **Fix:** Generate deterministic pseudorandom payloads with distinct seeds per connection and verify each connection against its own expected hash. Include differing connection lengths to expose stream-boundary mistakes.

**Verdict:** Request changes for the RST cleanup defect. The integrity tests also need stronger payloads. Live TCP verification was blocked by the sandbox’s `EPERM` on loopback binding; the lifecycle reproduction used Bun’s embedded handlers without network access.