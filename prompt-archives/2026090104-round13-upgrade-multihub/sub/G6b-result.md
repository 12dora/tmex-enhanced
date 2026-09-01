# G6b result — multi-hub harness allowlist + per-candidate transport + security scenarios

## What landed

Items 1–3 were already in the G2b harness (`createPendingNode` → A's `hubPeers`, E/twin omit A, dual-role `wsFactory`, G2 un-skipped). This agent verified them, then:

- Seeded the parent hub row at **real `writerEpoch: 1`** (was 99). Production-like; B is standby so authorizing A still does not self-fence.
- After `waitOnline`, dual-role enrollments with `hubUrl` + `wsFactory` **`switchTo` the parent** if they first attached to self. Needed because an active E (epoch 2) now ranks itself above A (epoch 1) and would otherwise never advertise to A.
- Added four security scenarios (item 4). No production edits.

## Scenario → pass/skip

| # | Scenario | Result | Notes |
|---|---|---|---|
| 1 | Hub set propagation | **pass** | C/D see A active epoch 1 and B standby; `writerHubId === A`; `/api/mesh/nodes` marks A/B `isHub`. |
| G2 | first seed attach fills `attached.hubNodeId` | **pass** | Un-skipped by G2b; still green. |
| 2 | Replication on standby | **pass** | B has A/C/D; ghost id without cert is not created. |
| 3 | Standby write fencing | **pass** | enroll/rename/revoke via B → `409 HUB_NOT_WRITER`; GET nodes 200. |
| 4 | Failover | **pass** | C/D re-attach to B; C→D relay 200. |
| 5 | Fail-back | **pass** | `switchTo(A)`; no `node.status` storm (`< 16`). |
| 6a | Epoch fencing (E epoch 2) | **pass** | E `switchTo(A)` then A `mode()==='standby'`; writes → writer E / epoch 2. |
| 6b | Equal-epoch active | **pass** | split-brain warn; A stays active. |
| 7 | Stale frames ignored | **pass** | MeshHubStore does not drop B. |
| 8 | Legacy `node.list` without `hubs[]` | **pass** | C synthesizes single active A. |
| 4a | Unauthorized high-epoch ad | **pass** | C sends `node.status.hub {active, writerEpoch:999}`; A stays active; C not in A's `mesh_hubs` or C's `/api/mesh/hubs`; writer remains A; warn once. |
| 4b | A restarted after E fences | **pass** | Stop A's hub, `new HubRuntime` over same DB/store with `mode:'active'` epoch 1 + `authorizedHubIds:[E]`; `mode()==='standby'`, `[hub] starting fenced:…writerEpoch=2`; redeem → `409 HUB_NOT_WRITER` writer E. |
| 4c | Standby `key.log.append` | **pass** | C attached to B (A down): chain-extending append `ok:false error=HUB_NOT_WRITER`; identical replay of B's head record `ok:true`; B head seq unchanged. |
| 4d | `POST /api/auth/keylog` on non-writer attach | **pass** | C on B → `409 HUB_NOT_WRITER` (writer A, no local apply); after A back + `switchTo(A)` same record → 200. |
| — | smoke: bootHubA | **pass** | A online, active, epoch 1. |

## Items 1–3 (verify)

| Item | Status |
|---|---|
| 1 A authorizes B/E via `hubPeers` + pending identity first | Already in G2b `bootAbcdTopology` / fencing tests. B's row appears in A's `mesh_hubs`. |
| 2 F2 trap | Seed epoch **1** (not 99). E/twin still omit A from their own `hubPeers`. Active dual-role `switchTo(parent)` so E still fences A. |
| 3 Dual-role dials A over fake WS; G2 un-skipped | B uses `wsFactory`; G2 test asserts `attached.hubNodeId === A`. |

## Bugs found

None in production. No `test.skip` / `test.todo`.

Harness note (not a product bug): with parent seed epoch 1, an **active** dual-role whose own epoch is higher than the parent will prefer self as writer and attach in-memory. The harness now `switchTo`s the parent after boot so epoch-fencing ads still reach A. Standby B is unaffected (A still ranks first).

## Runtime

| Check | Result |
|---|---|
| `cd apps/gateway && bun test src/mesh/integration/multi-hub.integration.test.ts` | **15 pass / 0 fail / 0 skip**, 89 expects, **5.39 s** (was G2b 11 pass; +4 security tests) |
| `cd apps/gateway && bun test` (full) | **3262 pass / 0 fail**, 317 files, **154.02 s** |
| `bunx tsc --noEmit -p .` (apps/gateway) | **owned files: 0 errors**. Unrelated untracked `src/mesh/integration/large-push-harness.ts:77` (other agent): `PeerLinkProvider` missing `listReach` / `onNodeEvent`. Did not touch it. |
| `bunx biome check` on the two owned files | **clean** (after `--write` import wrap) |

## Files touched

- `apps/gateway/src/mesh/integration/multi-hub-harness.ts` — seed epoch 1; parent `switchTo`; `reconstructHubRuntime`; `keyLogList`
- `apps/gateway/src/mesh/integration/multi-hub.integration.test.ts` — 4a–4d
- this result file

No git operations. No production edits.

## Commander

- Full gateway `bun test` is green (0 fail). `tsc` is red only on another agent's untracked `large-push-harness.ts`; that agent needs to add `listReach` + `onNodeEvent` to its `PeerLinkProvider` stub.
- Optional later: plumb `probeHealthz` / `probeIntervalMs` through `MeshRuntime` so fail-back can fire the real probe path without `switchTo` (unchanged from G6).
