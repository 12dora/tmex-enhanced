# G3c — Hub-to-hub status polling so a promoted standby fences the old writer (and vice versa)

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it strictly. Then read `sub/G3-result.md`, `sub/G3b-result.md` (authorized hubs, fencing, `UplinkServer.isWriter()`, `ownHubSnapshot()`), `sub/G2b-result.md`/`sub/G2c-result.md` (UplinkPool: an **active** dual-role hub attaches to itself in-memory; per-URL CA pins via `HubTrustStore`; `uplink-pool.ts` exports the CA/pin helpers), `sub/G6b-result.md`.

## Field evidence (live three-instance test today)

A active(epoch 1), B standby, C node. `tmex hub promote` on B (epoch 2) + restart: B now ranks itself first and attaches to **itself**, so it never sends a `node.status.hub` advertisement to A. A therefore never sees epoch 2, stays active, and C (attached to A) never learns that B is the writer: `waitFor('A fenced to standby')` timed out after 120 s. The same gap exists in the intended operational flow: A dies → B promoted → A comes back up → A starts active(epoch 1) and nobody tells it that it was superseded → permanent split-brain.

## Fix: authenticated hub status polling

1. **Public endpoint** on every hub: `GET /api/hub/status` (no session; same class as `/healthz`) → `{ hubNodeId, publicUrl, mode, priority, writerEpoch, name?, caFingerprint?: string|null, now }` from `ownHubSnapshot()`. Metadata only (all of it is already broadcast in `node.list.hubs[]`). Add it to `HubRuntime.handleRequest`.
2. **Poller** (new `apps/gateway/src/hub/hub-peer-poller.ts`, owned by `HubRuntime`): at start (after 2 s) and every 60 s (±20 % jitter), for each **authorized** hub known in `MeshHubStore` (rows whose id ∈ `authorizedHubIds`, excluding self) fetch `<publicUrl>/api/hub/status` with a 5 s timeout using the per-URL TLS pin from `HubTrustStore` exactly like the uplink does (reuse the helper exported by `uplink-pool.ts` / `mesh-runtime.ts` — do not duplicate the pin logic; if no pin exists and the URL is https, use system trust; on TLS failure log once per 10 min). Validate the body (32-hex `hubNodeId` must equal the row's id — otherwise ignore and warn), then feed it through **the same path as an authenticated advertisement** (the function `UplinkServer` uses for `node.status.hub` from authorized nodes): upsert `mesh_hubs` (`online: true`, `lastSeenAt`), run fencing (higher-epoch active → demote self, log `[hub] fenced by peer status …`), split-brain warning for equal epochs, and rebroadcast `node.list` when anything changed. Unreachable peers → `online: false` after 3 consecutive failures (do not remove rows).
3. Also poll **immediately** when `setMode()` changes (promotion/demotion at runtime) and when a new authorized hub row appears.
4. Security note in code comment + docs: peer status is trusted only because the URL is TLS-authenticated (pin or system CA) **and** the hub id is on the local allowlist; an unauthorized URL/id can never fence us.
5. `docs/hub/2026090104-multi-hub-standby.md`: add a short section「hub 间状态探测」 (why it is needed: promoted standby / returning old writer; 60 s cadence; what is exposed by `/api/hub/status`).

## Tests (TDD)

`hub-peer-poller.test.ts` with an injected fetch: authorized higher-epoch active → self demoted + broadcast; unauthorized id in body → ignored; equal epoch → warn only; failures → offline after 3; timeout respected; jitter bounds. `hub-runtime.test.ts`: `/api/hub/status` shape, no auth needed. Integration: extend nothing in `multi-hub.integration.test.ts` (other agent's file) — instead add a focused in-process test in your own new file `apps/gateway/src/mesh/integration/hub-peer-poll.integration.test.ts` reusing `multi-hub-harness.ts` **read-only**: promote B (construct B active epoch 2 attached to itself), trigger the poller once on A (expose `pollPeersNow()` for tests) → A becomes standby and its `node.list` names B as writer.

## Files you own

- `apps/gateway/src/hub/**` (new poller, `hub-runtime.ts`, `uplink-server.ts`, `types.ts`, tests)
- new `apps/gateway/src/mesh/integration/hub-peer-poll.integration.test.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts` ONLY to pass what the poller needs into `HubRuntimeOptions` (e.g. `hubTrust: HubTrustStore`, a `fetchWithPin` helper) inside the existing `new HubRuntime({...})` block — a single minimal edit
- `docs/hub/2026090104-multi-hub-standby.md`

Do NOT touch `uplink-pool.ts`, `uplink-client.ts`, `forwarder.ts`, `src/system/**`, `packages/**`, `apps/fe/**`, `multi-hub-harness.ts`, `multi-hub.integration.test.ts`.

## Verification

`cd apps/gateway && bun test src/hub src/mesh/integration && bunx tsc --noEmit -p .` (0 fail / 0 tsc), biome on changed files.

## Result file

`/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/G3c-result.md`. Write it, then exit.
