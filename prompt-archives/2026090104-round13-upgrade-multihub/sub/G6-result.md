# G6 result — in-process multi-hub failover / replication integration tests

## What landed

New in-process suite (plain `bun test`, **not** live `*.integration.ts`):

- `apps/gateway/src/mesh/integration/multi-hub-harness.ts`
- `apps/gateway/src/mesh/integration/multi-hub.integration.test.ts`

Harness spins up hub **A** (`hub,node`, active, epoch 1) + standby **B** (`hub,node`, priority 200, joined to A) + plain nodes **C** / **D**. B mirrors G5 `assemble.ts`: `mesh.onNodeList → hub.applyReplicatedNodeList`. C learns `[A,B]` from `node.list.hubs[]`; D also has `hubUrls: [HUB_B_URL]` seeds. C/D use `uplinkHub: null` + in-process `wsFactory` (`FakeServerSocket` + `WebSocketLink` → `HubRuntime.attachLocalNode`). `FastScheduler.sleep` is instant so failover stays inside the pool’s 3-fail budget without a real 20 s wait; `interval` still uses real `setInterval` so hub pings get pongs.

Did **not** modify production code.

## Scenario → pass/skip

| # | Scenario | Result | Notes |
|---|---|---|---|
| 1 | Hub set propagation | **pass** | C/D `MeshHubStore` list A (active, epoch 1, online) and B (standby). `GET /api/mesh/hubs` on C: `writerHubId === A`, `attached.publicUrl === A`. `/api/mesh/nodes` marks A/B `isHub` with `hubMode`. |
| 1b | `attached.hubNodeId === A` on first seed attach | **skip** | G2 gap, see Bugs. |
| 2 | Replication on standby | **pass** | B `nodes` has A, C (`name: node-c`), D (`name: node-d`) with non-empty `version`. Crafted `node.list` ghost id (no cert) is not created. Live `version` is `node.status` (`1.1.10_dev`), not redeem `'ver-c'` — expected. |
| 3 | Standby write fencing | **pass** | From C, `POST /n/<B>/api/hub/enrollments\|rename\|revoke` → `409 { code:'HUB_NOT_WRITER', writerHubId:A, writerPublicUrl:http://hub-a.test, writerEpoch:1 }`. `GET /n/<B>/api/hub/nodes` → 200. |
| 4 | Failover | **pass** | `HubRouter.takeDown(A)` closes live links and refuses new ones. C/D re-attach to B (`attached.hubNodeId === B`). C→D `/n/<D>/api/system/info` via B relay 200. B’s `node.list` shows C and D online. |
| 5 | Fail-back | **pass** (closest variant) | Bring A back + `uplink.switchTo(A)` (make-before-break). C/D `attached` A again; B stays standby; `node.status` count `< 16`. **Could not** tick the 60 s probe: `MeshRuntime` does not forward `probeHealthz` / `probeIntervalMs` into `UplinkPool`. |
| 6a | Epoch fencing (E epoch 2) | **pass** | Dual-role E (`active`, epoch 2) attached to A → `console.error('[hub] fenced:…writerEpoch=2')`, `A.mode()==='standby'`. A writes → `HUB_NOT_WRITER` with writer E / `http://hub-e.test` / epoch 2. |
| 6b | Equal-epoch active | **pass** | Twin active epoch 1 → `console.warn('[hub] split-brain:…writerEpoch=1')`; A stays active. |
| 7 | Stale frames ignored | **pass** (closest variant) | After failover to B, send a regressive `node.list` (only A) on captured A sockets. C’s `MeshHubStore` / `lastNodeList.hubs` do not drop B. Real `UplinkClient.stop()` unbinds the old link, so this asserts non-regression more than a live generation-guard hit (unit coverage is `uplink-pool.test.ts`). |
| 8 | Legacy `node.list` without `hubs[]` | **pass** | Live A link delivers a crafted list with only `hub`. C `MeshHubStore` becomes a single active A row (`writerEpoch` 1). |
| — | smoke: bootHubA | **pass** | A online, mode active, epoch 1. |

## Bugs found

### G2: first seed attach leaves `attached.hubNodeId` null

**Skip test:** `G2: first seed attach leaves attached.hubNodeId null even after node.list names the hub`

**Failing assertion (when unskipped):**

```ts
expect(hubs.attached?.hubNodeId).toBe(a.mesh.nodeId);
// Expected: "<A 32-hex>"
// Received: null
```

**Repro:** C starts with only `hubUrl` seed (`hubNodeId: null` in `mergeUplinkCandidates`). `UplinkPool.promote` copies that candidate into `attached` and never refreshes `hubNodeId` from later `node.list.hub` / `hubs[]`. `GET /api/mesh/hubs` therefore returns `attached.publicUrl` correctly but `attached.hubNodeId === null`.

**Not a fail on failover/fail-back:** after C has persisted `mesh_hubs`, `switchTo` / candidate retry uses the stored row, so `attached.hubNodeId === B` (scenario 4) and `=== A` after fail-back (scenario 5) both pass.

Suggested fix (commander / G2): on `dispatchNodeList`, if `list.hub?.nodeId` (or matching `hubs[]` row) is set, write it into `this.attached.hubNodeId`.

## Deterministic variants / API gaps

- **Fail-back probe:** no `CreateMeshRuntimeOptions.probeHealthz` / `probeIntervalMs`. Used public `UplinkPool.switchTo`.
- **Stop A’s uplink server:** `UplinkServer.stop()` is one-shot (`stopped = true`). Tests close tracked wsFactory links + refuse new A URLs, then `bringUp` for fail-back. A’s self in-memory uplink is left up so A can accept again.
- **Dual-role first candidate:** B/E `mesh_hubs` self-row would otherwise be `candidates()[0]`, so `connectOnce` to A would sign `hub-b.test` against A’s host → `bad_sig` storm. Harness pre-seeds A as active in that node’s `meshHubStore` before `createMeshRuntime` (test-only; not a production change).

## Runtime

| Check | Result |
|---|---|
| `bun test src/mesh/integration/multi-hub.integration.test.ts` | **10 pass / 1 skip / 0 fail**, 61 expects, **4.12 s** |
| `apps/gateway && bun test` (full) | **3234 pass / 1 skip / 0 fail**, 316 files, 150.80 s |
| `bunx tsc --noEmit -p .` | **0 errors** |
| `bunx biome check` on the two new files | **clean** (after `--write`) |

## Files touched

- `apps/gateway/src/mesh/integration/multi-hub-harness.ts` (new)
- `apps/gateway/src/mesh/integration/multi-hub.integration.test.ts` (new)
- this result file

No git operations. No production edits.

## Commander

- Keep the skip until G2 fills `attached.hubNodeId` from `node.list`.
- Optional later: plumb `probeHealthz` / `probeIntervalMs` through `MeshRuntime` so fail-back can fire the real probe path without `switchTo`.
