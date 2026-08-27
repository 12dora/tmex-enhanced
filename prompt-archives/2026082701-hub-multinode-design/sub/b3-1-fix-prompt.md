# Task B3-1-fix — address review of apps/gateway/src/mesh/rtc/ (node side of direct connections)

Context: `sub/b3-1-result.md`, design §3 (载体切换屏障, DataChannel 消息尺寸与背压), §2 链路身份与握手. Review `sub/b3-1-review.md` — the coordinator judged ALL items valid. Concurrent agent B2-4 is wiring `RtcPeerManager` into `mesh-runtime.ts`/`peer-manager.ts`/`ws/index.ts` — keep your public API stable (add, don't rename) and note any signature change loudly in the report. Do not touch `bulk.ts` (B3-2, committed).

Fix each with a regression test (fail before / pass after):

1. Switch order (blocker): send `CARRIER_SWITCH{to:'direct'}` on the old active carrier, then **immediately** `session.switchActiveCarrier(direct)` for outbound; ACK only releases the direct inbound buffer. Test: frames emitted between switch-send and ACK go to direct, in order.
2. `dc-handshake.ts`: pre-auth receive queue capped (4 KiB per message, 8 messages); violation → abort handshake + close PC.
3. `rtc-peer-manager.ts`: `acceptBrowser()` only for sessions created by `authorizeBrowser` (unknown → reject); global registry cap (e.g. 64) and TTL sweep timer; nonce success atomically consumes the record; PC lifecycle tied to the direct carrier (close PC when the carrier closes); used records removed.
4. `fragmenter.ts`: hard max reassembled frame 1 MiB; validate `total <= ceil(1 MiB / payloadMax)`, per-fragment length ≤ payloadMax, cumulative ≤ 1 MiB; violation → error surfaced so the carrier/link closes the channel (not silent drop); timer-based sweep for expired partial frames; `dispose()` clears all pending on channel close.
5. `data-channel-link.ts`: real send queue with resolvers; `send()` Promise resolves only when the whole frame is accepted; on `sendMessageBinary()===false` pause and resume from the failed fragment on `onBufferedAmountLow`; closing rejects queued items.
6. `data-channel-carrier.ts`: check high-water **before** starting a frame; once started, keep remaining fragments internally and finish the frame after buffered-amount-low (so a frame is never truncated); if the channel fails mid-frame, close the direct carrier (gap → primary fallback) instead of returning `backpressure`.
7. Message size: 64 KiB is the total message cap including the 8-byte header (payload 65528); effective payload = `min(65528, channel.maxMessageSize() - 8)`; reject channels that cannot fit the header. Align the constant name used by the browser side (report it — F3-1 must match: `sub/f3-1-result.md` says the browser uses 64 KiB payload; the coordinator will relay the change).
8. `ice.ts`: structured TURN per node-datachannel 0.33.1 `IceServer` (`hostname`, `port`, `username`, `password`, `relayType`); fix the test that locked the wrong behaviour.

File scope: `apps/gateway/src/mesh/rtc/**` except `bulk.ts`/`bulk.test.ts`. Acceptance: `cd apps/gateway && bun test src/mesh/rtc` green; tsc 0 in rtc; biome clean. Result: `prompt-archives/2026082701-hub-multinode-design/sub/b3-1-fix-result.md` (item → change → test; API changes for B2-4/F3-1).
