# G3b — Hub side fixes from review RV3: authorized hub allowlist, persisted fencing + writer gate, standby key-log fencing

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it strictly. Then read `sub/G3-prompt.md`, `sub/G3-result.md`, `sub/G1-result.md` and the review `sub/RV3-result.md` (blockers 1, 3, 5 and should-fix 2 are yours). Threat model: `docs/hub/2026082700-hub-node-architecture.md` §2 and §5 安全边界 — a compromised ordinary node must only affect itself.

## Fixes (TDD: flip/extend the existing tests that currently assert the insecure behaviour — `uplink-server.test.ts` ~2078 and ~2177)

### F1 (RV3 blocker 1) — Only **authorized** hubs may advertise / be listed / fence

- New config `TMEX_HUB_PEERS` in `apps/gateway/src/config.ts` (you own it now): comma-separated 32-hex node ids of the *other* hubs this hub authorizes (`config.hubPeers: string[]`, validated hex, de-duplicated; empty by default). Document it in the env table of `docs/hub/2026082800-hub-node-operations.md` (one line).
- `HubRuntimeConfig.authorizedHubIds?: string[]` (wired from `config.hubPeers` by the runtime — you may edit the `HubRuntime` construction block in `apps/gateway/src/mesh/mesh-runtime.ts` **only** to pass `authorizedHubIds: config.hubPeers ?? gatewayConfig.hubPeers` and nothing else; another agent edits the rest of that file concurrently, so make a single minimal edit there).
- In `uplink-server.ts`: a `node.status.hub` advertisement is accepted **only if** the sender node id is in `authorizedHubIds` (or is self). Unauthorized advertisements are dropped and logged at most once per node per 10 min (`[hub] ignored hub advertisement from unauthorized node=…`). Unauthorized nodes never enter `mesh_hubs`, never participate in `pickWriterHub`, never trigger fencing, and their `caFingerprint` is never broadcast.
- Additionally, `hubs[]` entries received by the **hub's own node side** (replication path `applyReplicatedNodeList` → `MeshHubStore.replaceAll`) must be filtered to `authorizedHubIds ∪ {self} ∪ {the source hub itself}`; the source hub is trusted for the list because the node authenticated it as its attached hub.
- Tests: unauthorized high-epoch active advertisement does not demote, does not appear in `node.list.hubs`, does not become writer; authorized one still works exactly as before.

### F2 (RV3 blocker 3) — Fencing must survive restarts and writes must check "am I the writer"

- On `UplinkServer` construction: compute the effective mode = config mode, **except** if `MeshHubStore.list()` already contains an *authorized* active hub with a `writerEpoch` strictly greater than own → start as `standby` (log `[hub] starting fenced: …`). Persist runtime demotion by upserting the own row with `mode:'standby'` (already) **and** remembering the fenced epoch so a restart with the same env epoch stays fenced (the own row in `mesh_hubs` is the persistence; make sure construction reads it before upserting self).
- Every fenced write path (`enrollments`, `redeem`, `rename`, `revoke`) requires `mode() === 'active' && pickWriterHub(authorized rows) === self`; otherwise `409 HUB_NOT_WRITER`.
- Tests: restart after demotion stays standby; active-but-not-writer (another authorized active with higher epoch known in store) rejects writes.

### F3 (RV3 blocker 5) — Standby must not extend the key log

- In standby mode, `key.log.append` (uplink ctl) accepts only records that are **identical replays** of records already present (same seq + same hash) and rejects any chain-extending record with an error the node can recognise (`{ t:'key.log.append.ack', ok:false, error:'HUB_NOT_WRITER', writerHubId, writerPublicUrl, writerEpoch }` — inspect the existing ack shape and keep it compatible). Serving `key.log.req` stays allowed.
- Investigate where fresh records originate (browser-signed `admit-node`/`revoke-node`/passkey/TOTP records go through `apps/gateway/src/mesh/auth-routes.ts` or `hub-runtime.ts`?). Report precisely in the result: for each write surface, whether it appends locally first and then pushes to the hub. If any path appends **locally first** on an entry node, describe the exact function so the node-side agent can gate it on "attached hub is writer" (do not edit `src/mesh/**` yourself beyond the single line allowed above).
- Tests: standby rejects extending append with the writer info; identical replay is acked ok; active behaviour unchanged.

### F4 (RV3 should-fix 2) — Own row from config snapshot

- `applyReplicatedNodeList` / `replaceAll` must re-insert the own hub row from the runtime's config snapshot (mode/priority/epoch/publicUrl/caFingerprint), never depending on the row still existing in the store; and it must ignore lists whose *actual* source (meta.hubNodeId — the node side will now pass the authenticated attached hub id, not `list.hub.nodeId`) equals self.

## Files you own

- `apps/gateway/src/hub/**`
- `apps/gateway/src/config.ts` (+ `config.test.ts`) — additive `hubPeers` only
- `docs/hub/2026082800-hub-node-operations.md` (one env line)
- `apps/gateway/src/mesh/mesh-runtime.ts` — ONLY the single `authorizedHubIds:` line inside the `new HubRuntime({ config: {...} })` block

Do NOT touch any other file under `apps/gateway/src/mesh/**` (G2b is editing them), `src/system/**`, `packages/**`, `apps/fe/**`.

## Verification

`cd apps/gateway && bun test src/hub src/config.test.ts && bunx tsc --noEmit -p .` (tsc 0 in your files; report any errors elsewhere), biome on changed files. Also run `bun test src/mesh/integration/multi-hub.integration.test.ts` — it exercises fencing with an authorized E hub; if it now fails because the harness doesn't set `authorizedHubIds`, tell the commander exactly which harness option must be set (do not edit the harness).

## Result file

`/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/G3b-result.md` — fix mapping, the key-log origin investigation (F3), new config/API, test counts. Write it, then exit.
