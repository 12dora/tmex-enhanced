# G3 — Hub side: active/standby mode, hub-set broadcast, standby replication, write fencing

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it strictly. Then read `prompt-archives/2026090104-round13-upgrade-multihub/plan-00.md` (§目标 3) and `sub/G1-result.md` (foundation: `HubEndpointInfo`/`HubAdvertisement`/`node.list.hubs`/`writerHubId`/`writerEpoch`, `HUB_NOT_WRITER` error shape, config `hubMode/hubPriority/hubWriterEpoch`, `MeshHubStore` + `pickWriterHub`). Background: `docs/hub/2026082700-hub-node-architecture.md` §2–§3, `sub/EX3-result.md` §1, §2.3–2.5, §5.1, §7.

## Goal

`HubRuntime` (`apps/gateway/src/hub/hub-runtime.ts`) + `UplinkServer` (`uplink-server.ts`) currently assume they are the only hub. Add **phase-1 multi-hub**: a hub runs in `active` (writer) or `standby` mode; hubs learn about each other via node advertisements; the writer broadcasts the hub set; a standby replicates the registry and refuses writes; an active hub that sees a higher-epoch active demotes itself (fencing).

## Requirements

1. **Config plumbing**: `HubRuntimeConfig` gains `mode: HubMode`, `priority: number`, `writerEpoch: number`, `hubNodeId: string` (own node id — check what the runtime already knows; `types.ts`). `HubRuntime.mode()` getter and `setMode(mode)` (runtime demotion), `writerEpoch()`.
2. **Collect hub advertisements** (`uplink-server.ts` `node.status` handler ~617): when a `node.status` carries `hub: HubAdvertisement`, upsert `MeshHubStore` (`hubNodeId` = the sending node id, `online` = true, `lastSeenAt` = now); on that node's disconnect mark `online=false`. The hub also upserts **itself** at start (`mode/priority/writerEpoch` from config, `publicUrl` = `config.publicUrl`, `online=true`).
3. **Broadcast hub set**: `node.list` (built ~1065–1130) includes `hubs: HubEndpointInfo[]` from `MeshHubStore.list()` (online flags from the registry), `writerHubId = pickWriterHub(...)`, `writerEpoch` of that writer, and the legacy singular `hub` field must now describe the **writer** hub (not necessarily self — on a standby, `hub` points at the active writer if known, else self). If G1's compat finding says old decoders reject unknown keys, use G1's legacy encoder for nodes whose reported version is older than the version that ships this change (compare with `compareSemver` from `@tmex/shared`; the registry knows each node's `version`); otherwise ignore this sentence. Re-broadcast when the hub set changes (an advertisement arrives/changes, a hub goes offline/online, own mode changes) — reuse the existing debounced broadcast path.
4. **Fencing**: on receiving an advertisement with `mode:'active'` and `writerEpoch` **greater** than own while own mode is `active` → log loudly (`[hub] fenced: higher writerEpoch=… from hub=…`), `setMode('standby')`, upsert self, re-broadcast. Equal epoch from another active → log a `split-brain` warning every 60 s (rate-limited) and keep serving; never auto-promote.
5. **Standby write fencing**: in standby mode the following return `409` with the `HubNotWriterError` body (writer fields from `pickWriterHub` over `MeshHubStore`; null when unknown): `POST /api/hub/enrollments`, `POST /api/hub/enrollments/redeem`, `POST /api/hub/nodes/:id/rename`, `POST /api/hub/nodes/:id/revoke`, and any ctl message that appends to the key log **originating from a node that is not merely catching the hub up** — inspect `uplink-server`'s `key.log`/append handling: applying records that extend the chain from a node that is ahead is *allowed* (they were already accepted by the writer and are signature-verified), but a fresh append request API (if one exists over ctl) must be rejected in standby. Reads (`GET /api/hub/nodes`, `GET /api/hub/enrollments/:id`, uplink auth, `node.list`, relay, rtc signalling, key-log serving) keep working on standby.
6. **Standby registry replication**: `HubRuntime.applyReplicatedNodeList(list: UplinkNodeList, meta: { hubNodeId: string | null })` — called by the process wiring (another agent) with every `node.list` the local node side receives from the hub it is attached to. Ignore lists whose source is self. For each listed node: upsert `nodes` (id, name, version, direct_capable, inventory/endpoints if present, `status='enrolled'`, `last_seen_at`) via `node-persistence.ts` — but **only** for nodes that have a non-revoked cert in `node_certs` (membership stays anchored to the user-signed chain; never create rows for unknown ids). Mark nodes absent from the list but present locally as not-online (do not delete). Also `MeshHubStore.replaceAll` from `list.hubs` (keeping own row). Enrollment tokens are **not** replicated in phase 1 (standby cannot redeem anyway). Document this limitation in the result.
7. **Registry semantics on standby**: uplinks from nodes are accepted normally (they authenticate against `node_certs`, which every node already has), so relay among nodes attached to this standby works. Nothing else changes.
8. **Enrollment redeem while active but another active exists with a higher epoch**: impossible after fencing (we demote first); no extra handling.

## Tests (TDD)

Extend `hub-runtime.test.ts`, `uplink-server.test.ts`, `node-registry.test.ts` as needed (+ new `hub-replication.test.ts` if you split the replication into `hub-replication.ts` — recommended). Cover: advertisement upsert/offline, node.list carries hubs/writerHubId/legacy `hub`=writer, fencing demotion + rate-limited split-brain warning, all four write routes 409 on standby with the exact body, reads still OK on standby, replication upserts only cert-backed nodes and marks absent ones offline, own row preserved, source=self ignored. Existing hub tests must stay green (baseline: gateway 3134 pass total before this round).

## Files you own

- everything under `apps/gateway/src/hub/**`
- `apps/gateway/src/auth/user-store.ts` ONLY if a strictly additive query is unavoidable (say so in the result); prefer `node-persistence.ts` (yours).

Do NOT touch `apps/gateway/src/mesh/**` (G2 owns `mesh-runtime.ts`/`uplink-client.ts`/`mesh-routes.ts`; G4 owns `forwarder.ts`), `apps/gateway/src/system/**`, `apps/gateway/src/config.ts`, `db/**`, `auth/mesh-hub-store.ts`, `packages/**`, `apps/fe/**`. If `HubRuntimeOptions` needs a `MeshHubStore` instance, accept it in the options (the wiring agent will pass it) and default to constructing one from `opts.db` when absent.

## Verification

`cd apps/gateway && bun test && bunx tsc --noEmit -p .` → 0 fail / 0 tsc errors (other agents add tests concurrently; report but don't chase failures clearly inside `src/mesh/**` or `src/system/**` mid-edit), biome on changed files.

## Result file

`/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/G3-result.md` — include the new `HubRuntimeConfig`/`HubRuntimeOptions` fields, the `applyReplicatedNodeList` signature, the exact 409 body, replication limitations, test counts. Write it, then exit.
