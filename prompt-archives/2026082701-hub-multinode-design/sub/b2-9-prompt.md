# Task B2-9 — node-side leftovers: rtcSession in CARRIER_SWITCH, node.list trust filter before caching, peer bind host config, sid required in authorize

Context: `sub/f3-3-result.md` §1 (browser now expects `rtcSession: string` in `CARRIER_SWITCH` / `CARRIER_SWITCH_ACK`; empty string is treated as legacy and only accepted when exactly one pending attempt exists), `sub/b2-7-result.md` "未能做" items 1–3, and `sub/b3-1-fix-result.md`. Schemas already changed in `packages/shared/src/ws-borsh/schema.ts`; the node currently sends `rtcSession: ''` (`apps/gateway/src/mesh/rtc/carrier-switch.ts`).

1. `CarrierSwitchController`: `attachDirect(session, carrier, {rtcSession})` stores it; `beginSwitch`/`sendSwitch` fill the real value for both `to:'direct'` and `to:'primary'`; `handleAck(session, epoch, rtcSession)` accepts only when both match (stale/other-attempt ACK ignored); `ws/index.ts` ACK hook passes the decoded `rtcSession`; `RtcPeerManager.attachDirect` passes the accepted browser record's `rtcSession`. Fix the two biome `noConfusingVoidType` nits in `carrier-switch.ts`. Tests.
2. `uplink-client.ts`: filter `node.list` entries against `node_certs` (present, same user, non-revoked) **before** `upsertPeer`; unknown nodes never touch `peer_cache`; test.
3. `config.ts`: register `TMEX_PEER_BIND_HOST` (comma-separated hosts; default dual-stack `::` + `0.0.0.0`) and thread it to `PeerServer` via `MeshRuntimeConfig`; test.
4. `RtcPeerManager.authorizeBrowser`: `sid` required (no default `''`); update `rtc-loopback.integration.ts` accordingly.
5. Run `cd apps/gateway && bun test` fully and `bunx tsc --noEmit -p .` — report exact numbers.

File scope: `apps/gateway/src/mesh/rtc/{carrier-switch,rtc-peer-manager,rtc-loopback.integration}.ts` (+tests), `apps/gateway/src/ws/index.ts` (ACK hook lines), `apps/gateway/src/mesh/{uplink-client,mesh-runtime,peer-server,types}.ts` (+tests), `apps/gateway/src/config.ts` (+test). Acceptance: gateway green (baseline 1791), tsc ≤ 23, biome clean. Result: `prompt-archives/2026082701-hub-multinode-design/sub/b2-9-result.md`.
