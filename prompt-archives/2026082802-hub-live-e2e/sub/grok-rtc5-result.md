# RTC round 5 — handshake → Link handoff

## What changed

Handshake and Link no longer share a single undifferentiated binary byte stream during the handoff window.

- Handshake frames are JSON **text** (`sendMessage`) with `t` in `{hello, sig, done}`. Binary LinkMux fragments stay binary.
- `DataChannelLink` ignores handshake-plane messages (any text frame, or binary JSON `hello`/`sig`/`done`) instead of feeding them to the reassembler.
- After local verify, each side sends `{t:"done"}` and **does not return** (so `connectToPeer` cannot install a Link and send LinkMux) until the peer’s `done` arrives.
- Hello retransmission (40 ms) stops on the first inbound `sig`.
- Handshake 4 KiB / 8-count limits apply only to handshake-plane frames. Non-handshake frames are buffered with the fanout byte cap (`MAX_LINK_UNACKED`) and reinjected in order; they never abort with `dc handshake message too large` or queue overflow.

`rtc-peer-manager.ts` is unchanged: `connectToPeer` still builds the Link only after `handshakeDataChannel` returns, which is now after both `done` acks.

## Tests

Reviewer reproductions kept as `{linkClosedReason, channelOpen}` / `{bHandshake, channelOpen}`:

- (a) late `hello` after Link is up, and live hello retransmit while one side already has a Link → `linkClosedReason: undefined`, `channelOpen: true` (was `fragment-protocol` / closed).
- (b) A finishes, sends LinkMux DATA > 4 KiB plus a >8 frame burst while B is still waiting for `done` → `bHandshake: {ok: true}`, `channelOpen: true`.
- Delayed sig then immediate OPEN still reaches the later-attached Link (OPEN is injected while B is held on `sig`).
- Hello retransmit stops after the first inbound `sig`.

Nit: `rtc-wake.integration.test.ts` now enrolls a third node, waits until its uplink is online, revokes the cert **without** closing that uplink, then sends a signed wake at it. The hub drops the signal because the cert is revoked, not because the target was never in the registry.

## Verification

- `cd apps/gateway && bun test src/mesh/rtc src/mesh/integration/rtc-wake.integration.test.ts` — 127 pass, 0 fail
- `cd apps/gateway && bun test src/mesh` — 380 pass, 0 fail
- `bunx tsc --noEmit -p .` — 21 errors (baseline; 0 in touched RTC files after the HubBoot typing fix)
- `bunx biome check <changed files>` — clean

## Open issues

None in this handshake/Link handoff. In-flight `hello`/`sig`/`done` after both sides return are ignored by the Link for the life of the channel.
