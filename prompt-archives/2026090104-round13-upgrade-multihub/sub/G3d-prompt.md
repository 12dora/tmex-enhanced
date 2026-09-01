# G3d — Hub-side + link fixes from review RV4 (legacy node.list keeps own hub row; link frame pacing; poll regression test)

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it strictly. Then read `sub/RV4-result.md` (items 1, 4, 10 are yours), `sub/G3b-result.md`, `sub/G3c-result.md`, `sub/G4c-result.md` and the follow-up commit `1437377b` (server-side proactive pause + `getBufferedAmount` poll in `packages/shared/src/link/websocket-link.ts`).

## Fixes (TDD)

- **RV4-1 (blocker, mixed-version)** — A 1.1.11 standby attached to a **1.1.10 active hub** receives a legacy `node.list` without `hubs[]`. The node side synthesizes a single active record and `replaceAll`s the store (deleting the standby's own row); then `HubRuntime.applyReplicatedNodeList()` returns early because `!list.hubs` and never re-inserts the own snapshot → the standby loses its own candidate (no self fallback). Fix in `apps/gateway/src/hub/hub-replication.ts` / `hub-runtime.ts`: **always** re-insert the own hub snapshot (from `UplinkServer.ownHubSnapshot()`) when the process runs the hub role, on both the `hubs[]` path and the legacy path (and still ignore self-sourced lists). Also make sure the legacy-synthesised active row for the 1.1.10 hub is kept **only if** that hub id is authorized or is the source hub (it is the source → keep). Tests: legacy list → store has {source hub (active), self (standby)}; `hubs[]` list → unchanged behaviour; self-sourced → ignored.
- **RV4-4 (should-fix) single-frame > 1 MiB** — the encoded frame is payload + 10-byte header; a max `MAX_FRAME_PAYLOAD` (1 MiB) DATA frame on an empty-but-slow socket still exceeds the gateway's 1 MiB `backpressureLimit`. Fix on the **sender** side in the link mux (`packages/shared/src/link/**`): split outgoing DATA into frames of at most 256 KiB payload (wire-compatible: receivers accept any size ≤ 1 MiB; window accounting unchanged). Do not change `MAX_FRAME_PAYLOAD` (receive-side validation) or the window constants. Tests: a 1 MiB write produces ≥ 4 frames; round-trip integrity; flow control still honoured.
- **RV4-10 (nit)** — add a regression test in `websocket-link.test.ts` for the exact failure class fixed by `1437377b`: a fake server adapter that exposes `bufferedAmount()` and **never** emits `drain` (because `send` never returned -1); after the proactive pause the queue must resume via the poll once `bufferedAmount()` drops.

## Files you own

- `apps/gateway/src/hub/hub-replication.ts` (+test), `apps/gateway/src/hub/hub-runtime.ts` (only the `applyReplicatedNodeList` method and tests)
- `packages/shared/src/link/**` (+tests)

Do NOT touch `apps/gateway/src/mesh/**` (another agent is editing it), `src/system/**`, `packages/app/**`, `apps/fe/**`.

## Verification

`cd packages/shared && bun test && bunx tsc --noEmit -p .` (0/0), `cd apps/gateway && bun test src/hub src/mesh/integration/large-push.integration.test.ts src/mesh/integration/multi-hub.integration.test.ts && bunx tsc --noEmit -p .` (0 fail; report any failures in `src/mesh/**` that belong to the other agent), biome on changed files.

## Result file

`/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/G3d-result.md`. Write it, then exit.
