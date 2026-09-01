# G6b — Update the multi-hub integration harness for the authorized-hub allowlist and the per-candidate transport; make the suite green again

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it strictly. Then read `sub/G6-prompt.md`, `sub/G6-result.md`, `sub/G3b-result.md` (section "Commander / harness" has precise instructions: hubs must now be listed in the writer's `hubPeers`/`authorizedHubIds`; the F2 trap for hub E; F4 own-row snapshot), `sub/G2b-result.md` (per-candidate transport: dual-role processes now dial the active hub over WS and only use the in-memory link for self; `attached.hubNodeId` is filled from `node.list`; `onNodeList` meta carries the authenticated attached hub id).

## Task

NOTE: G2b already adapted the harness (dual-role via `wsFactory`, `hubPeers` pre-authorization with `createPendingNode()`, E/twin omit A from their own `hubPeers`, G2 test un-skipped; suite currently 11 pass / 0 skip). Items 1–3 below are therefore DONE — verify quickly and focus on item 4 (new security scenarios) and item 5.

`apps/gateway/src/mesh/integration/multi-hub.integration.test.ts` + `multi-hub-harness.ts` currently fail (0 pass / 10 fail / 1 skip) because:

1. Hub A never authorizes B / E: pass `config.hubPeers: [B.nodeId, E.nodeId]` (the harness must therefore create the identities of B and E **before** constructing A, or reconstruct A — pick the cleanest deterministic approach; `bootAbcdTopology` waits for B's row in A's `mesh_hubs`, which only appears when B is authorized).
2. F2 trap: `enrollAndStart` seeds the parent A into the new hub's store at `writerEpoch: 99`; with allowlists, E (active, epoch 2) that authorizes A would fence *itself* at construction. Seed the parent with its real epoch (1) instead of 99, or omit A from E's `hubPeers` — prefer the real epoch (it is also what production does).
3. Dual-role attach changed (G2b): remove any pre-seeding hacks that were only needed because dual-role always attached to itself; B (standby) must now genuinely dial A over the fake WS factory. Un-skip the G2 `attached.hubNodeId` test if G2b fixed it.
4. Add scenarios for the new security behaviour: (a) an **unauthorized** node sending `node.status.hub {mode:'active', writerEpoch: 999}` does not demote A, does not appear in `/api/mesh/hubs` on C, is not the writer; (b) A restarted after being fenced by E stays standby (construct a new HubRuntime over the same DB / store and assert `mode() === 'standby'` and writes → `HUB_NOT_WRITER`); (c) standby B rejects a chain-extending `key.log.append` from C with `HUB_NOT_WRITER` while an identical replay is acked ok; (d) with C attached to standby B (A down), `POST /api/auth/keylog` on C for a fresh record is refused with `409 HUB_NOT_WRITER` (per G2b F9), and succeeds again after A is back.
5. Keep the whole file deterministic and < 90 s.

## Files you own

- `apps/gateway/src/mesh/integration/multi-hub.integration.test.ts`
- `apps/gateway/src/mesh/integration/multi-hub-harness.ts`

Do NOT modify production code. If a scenario exposes a production bug, mark the test `test.todo`/`test.skip` with the failing assertion in your result.

## Verification

`cd apps/gateway && bun test src/mesh/integration/multi-hub.integration.test.ts` green (or documented skips), then full `bun test` (0 fail) and `bunx tsc --noEmit -p .` 0, biome clean on your files.

## Result file

`/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/G6b-result.md` — scenario table, bugs found, runtime. Write it, then exit.
