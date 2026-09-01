# G6 — In-process integration tests for multi-hub (active/standby) failover and replication

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it strictly. Then read `prompt-archives/2026090104-round13-upgrade-multihub/plan-00.md` (§目标 3) and `sub/G1-result.md`, `sub/G2-result.md`, `sub/G3-result.md`, `sub/G5-result.md` (what was actually built: `UplinkPool`, `MeshRuntime.onNodeList`, `HubRuntime.applyReplicatedNodeList`, standby write fencing, epoch fencing, `MeshHubStore`).

## Goal

Add an integration test file `apps/gateway/src/mesh/integration/multi-hub.integration.test.ts` (plain `bun test` — NOT a `*.integration.ts` live test; follow the naming of the existing files in that directory, e.g. `mesh.integration.test.ts`, which run under the default `bun test`) using the existing in-process harness (look at `apps/gateway/src/mesh/integration/*` helpers and `apps/gateway/src/hub/hub-test-helpers.ts`: they spin up `HubRuntime` + several `GatewayRuntime`/`MeshRuntime` with `InMemoryLink`/in-process WebSocket links, create a user, enroll/admit nodes, and exercise `/n/:id` forwarding and relay).

## Scenarios (each a separate `test`, shared setup in `beforeAll`/helper)

Topology: hub **A** (`hub,node`, mode active, writerEpoch 1) ; node **B** (`hub,node`, mode standby, priority 200, joined to A as a node — its own hub runtime is wired to replicate from its node side via `onNodeList → applyReplicatedNodeList` exactly as `packages/app/src/runtime/assemble.ts` does — mirror that wiring in the test) ; node **C** (plain node) ; node **D** (plain node). All nodes have hub candidates `[A, B]` (via config seeds or via the `hubs[]` learned from A's `node.list` — cover **both** ways: C learns from `node.list`, D is configured with `TMEX_HUB_URLS`-equivalent seeds).

1. **Hub set propagation**: after everyone attaches to A, `MeshHubStore` on C and D lists A (active, epoch 1, online) and B (standby); `GET /api/mesh/hubs` on C returns `attached.hubNodeId === A`, `writerHubId === A`; `/api/mesh/nodes` marks both A and B `isHub` with correct `hubMode`.
2. **Replication on standby**: B's `nodes` table contains A, C, D (cert-backed) with names/versions; a fake node id injected into a crafted `node.list` (no cert) is NOT created.
3. **Standby write fencing**: `POST /n/<B>/api/hub/enrollments`, rename, revoke via B → `409 { code: 'HUB_NOT_WRITER', writerHubId: A, writerPublicUrl: <A url>, writerEpoch: 1 }`; `GET /n/<B>/api/hub/nodes` → 200.
4. **Failover**: stop A's uplink server (or close all its links + refuse new ones). Within the pool's failure budget (use the injectable timings/fakes exposed by `UplinkPool` — do not sleep 20 s real time), C and D re-attach to B; `attached.hubNodeId === B` on both; C can still reach D through relay via B (`/n/<D>/api/system/info` from C succeeds) ; `node.list` from B lists C and D online.
5. **Fail-back (make-before-break)**: bring A back; after the probe interval (fake timer/injected trigger) C and D are attached to A again; B remains standby; no duplicate `node.status` storms (assert bounded count).
6. **Epoch fencing**: start a second active hub **E** with writerEpoch 2 attached as a node to A (or advertise via a crafted `node.status` with `hub:{mode:'active',writerEpoch:2}`) → A logs fenced and `A.mode() === 'standby'`; A's subsequent writes return `HUB_NOT_WRITER` with writer E. Equal-epoch active → warning only, A stays active (spy on `console.warn`/logger).
7. **Stale frames ignored**: during failover, deliver a late `node.list` from the old A link after C attached to B — C's `MeshHubStore`/peer_cache must not regress (generation guard).
8. **Legacy compatibility**: a `node.list` **without** `hubs[]` (old hub) makes C synthesize a single active record from the legacy `hub` field.

Prefer deterministic control (injected clocks/timers, explicit `switchTo` where the pool exposes it) over real waiting; the whole file should run in < 60 s. If a scenario is impossible with the shipped APIs, implement the closest deterministic variant and state precisely what you could not assert.

## Files you own

- new `apps/gateway/src/mesh/integration/multi-hub.integration.test.ts`
- additive helpers ONLY in a new file `apps/gateway/src/mesh/integration/multi-hub-harness.ts` (do not modify existing helper files; if an existing helper needs a tiny extension, copy the needed piece into your harness instead)

Do NOT modify production code. If a scenario reveals a **bug** in G2/G3 code, do not fix it — write a failing test marked with `test.todo`/`test.skip` + a clear description in your result file (with the exact failing assertion), so the commander can route the fix.

## Verification

`cd apps/gateway && bun test src/mesh/integration/multi-hub.integration.test.ts` green (or with documented skips), full `bun test` still 0 fail, `bunx tsc --noEmit -p .` 0, biome clean on your files.

## Result file

`/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/G6-result.md` — scenario → pass/skip table, bugs found (with reproduction), runtime of the file. Write it, then exit.
