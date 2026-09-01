# G2b — Node side fixes from review RV3 + G6: per-candidate transport (dual-role standby must uplink to the active hub), probe resync, single-flight, CA download hardening, attached meta

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it strictly. Then read `sub/G2-prompt.md`, `sub/G2-result.md`, `sub/G6-result.md` (integration harness + one bug) and the review `sub/RV3-result.md` (blocker 2, blocker 4, should-fix 1/3/4/5, nit are yours; blocker 5 has a node-side part described below).

## Fixes (TDD; extend `uplink-pool.test.ts`, `mesh-runtime*.test.ts`; keep `src/mesh/integration/multi-hub.integration.test.ts` green — un-skip its G2 test once fixed)

### F1 (RV3 blocker 2) — Transport per candidate; dual-role standby must connect to the remote active hub

Today `createMeshRuntime` for a `hub,node` process defaults `uplinkHub` to the local `HubRuntime` and always attaches via `InMemoryLink`, so a **standby** never uplinks to the active hub (and its advertisement/replication never happen); the pool's custom-connect branch also never iterates other candidates. Fix in `UplinkPool`/`mesh-runtime.ts`:
- Candidate iteration must always go through the ordered candidate list. For each candidate choose the transport: **InMemoryLink to the local HubRuntime iff the candidate is self** (candidate `hubNodeId === own node id`, or its normalized URL equals own `hubPublicUrl`/`hubEndpointUrl(config)`); otherwise the normal WebSocket transport with that URL's CA pin. Remove the `start(connectOnce)` lock-in for dual-role.
- Ordering already ranks the active writer above a standby's own row, so: an **active** hub attaches to itself (in-memory); a **standby** attaches to the active via WS and only falls back to itself when all higher-ranked candidates fail; when the active returns, the normal probe/switch-back applies (self is just another candidate).
- Make sure the uplink auth transcript is signed against the host of the URL actually being dialled (it already is per URL; just don't mix).
- Tests: dual-role standby with candidates `[A(active), self(standby)]` dials A over the fake WS factory first; A down → falls back to in-memory self; A back → probe switches back.

### F2 (RV3 blocker 4) — Re-sync after every live `node.list`

After persisting a live `node.list` (`hubs[]` or legacy synthesis) into `MeshHubStore`, recompute candidates, refresh `attached.{hubNodeId,mode,writerEpoch}` from the row matching the attached URL (this also fixes the G6 bug: `attached.hubNodeId` was `null` after a seed-only first attach), and call the probe scheduler (`syncProbe()`) so that if the attached hub is no longer index 0 (e.g. B was promoted with a higher epoch, A demoted) the 60 s probe starts and switches. Test: attached to healthy A; list reorders B first → probe fires → `switchTo(B)`.

### F3 (RV3 should-fix 1) — Single-flight

`switchTo`, the connect loop and the probe must share a switch token/mutex: a completed *older* connect attempt must never `promote` over a newer live link; probes are in-flight-guarded and the 60 s period gets ±20 % jitter; sequential probes of up to 16 candidates must not overlap the next tick. Tests for concurrent `switchTo` and overlapping probe ticks.

### F4 (RV3 should-fix 3) — CA bootstrap hardening

`fetch <publicUrl>/api/tls/ca.crt` with `rejectUnauthorized:false`: enforce 5 s timeout, 64 KiB max body, exactly one PEM certificate, it must be a CA (basic constraints CA:TRUE / keyCertSign — use `node:crypto` `X509Certificate`: check `.ca === true`), fingerprint must be 64 hex before any network call, single-flight per URL. Tests: oversized body, two PEMs, non-CA cert, hanging response (fake fetch) → all rejected, nothing pinned.

### F5 (RV3 should-fix 4) — Generation guard on relay/fork callbacks

Install the inbound relay handler only on the promoted (live) client; wrap `onKeyLogFork` and any other externally visible callback with the client-identity/generation check so a pending (not yet promoted) or superseded client cannot inject events. Test: pending client emits relay/fork → ignored.

### F6 (RV3 should-fix 5) — CA fingerprint refresh

`refreshTls()` runs once at start; make TLS status changes (whatever event/callback the TLS service exposes — look at how `HubRuntime.tlsInfo` gets it) refresh `state.caFingerprint` and call `sendStatusIfChanged()`. If the TLS service has no change notification, poll it every 10 min and note that in the result.

### F7 (RV3 nit) — No duplicate `node.status` right after authentication (client already sends one; the pool's post-promote send should only happen if `sendStatusIfChanged()` detects a change).

### F8 (RV3 should-fix 2, node part) — Replication source id

`onNodeList` meta `hubNodeId` must be the **authenticated attached hub's node id** (from the candidate row / `attached.hubNodeId`), not `list.hub.nodeId` (which is the writer, not necessarily the sender).

### F9 (RV3 blocker 5, node part) — Fresh key-log writes need the writer

The hub-side agent (G3b) is making a standby reject chain-extending `key.log.append` with `{ ok:false, error:'HUB_NOT_WRITER', writerHubId, writerPublicUrl, writerEpoch }`. On the node side: (a) `uplink-key-log-sync.ts` must treat that ack as non-fatal (log once, keep the local records, retry after the next attach/hub change — do not tear down the link, do not loop hot); (b) find every place where the **entry node appends a freshly user-signed record locally first** (`auth-routes.ts` / `user-key-service` call sites for add-passkey/remove-passkey/set-totp/clear-totp/admit-node/revoke-node) and, when `attachedHub()` is known and is **not** the writer (`pickWriterHub` over `MeshHubStore`), refuse with `409 HUB_NOT_WRITER` (same body) **before** writing locally. If the attached hub is unknown/offline keep today's behaviour (offline-capable local ops must not regress) — document the exact rule you implemented. G3b's result file (`sub/G3b-result.md`, may appear while you work) contains the precise origin analysis; consult it if present.

## Files you own

Everything under `apps/gateway/src/mesh/**` **except** `forwarder.ts`, `stream-targets.ts`, the remote-upgrade cases in `mesh-routes.test.ts`, and the single `authorizedHubIds:` line another agent adds inside the `new HubRuntime({...})` block of `mesh-runtime.ts` (if you see it appear, keep it). You may edit `apps/gateway/src/mesh/integration/multi-hub.integration.test.ts` only to un-skip the G2 test and adapt harness options if F1 changes how dual-role nodes attach (`multi-hub-harness.ts` may be adapted accordingly).

Do NOT touch `apps/gateway/src/hub/**`, `config.ts`, `src/system/**`, `packages/**`, `apps/fe/**`.

## Verification

`cd apps/gateway && bun test src/mesh && bunx tsc --noEmit -p .` (0 fail in `src/mesh`, tsc 0 in your files), biome on changed files.

## Result file

`/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/G2b-result.md` — fix mapping, the F9 rule, test counts. Write it, then exit.
