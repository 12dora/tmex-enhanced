# G2d — Mesh-side fixes from review RV4 (candidate ordering, dual-role standby local-write gate, live-mode advertisement, CA keyUsage, log hygiene, mesh WS backpressure)

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it strictly. Then read `sub/RV4-result.md` (items 2, 3, 5, 6, 7, 8, 9 are yours), `sub/G2b-result.md`, `sub/G2c-result.md`, `sub/G3b-result.md`.

## Fixes (TDD)

- **RV4-2 (blocker) candidate ordering** — `mergeUplinkCandidates()` in `apps/gateway/src/mesh/uplink-pool.ts` must produce ONE globally sorted list regardless of source: active candidates first (writerEpoch desc, priority asc), then standby (priority asc), then unknown-mode seeds; seeds keep `writerEpoch 0`/`priority 1000+i` but a seed **active** still ranks above the own **standby** row. Property: a fresh standby with only its own row + `TMEX_HUB_URL` seed must dial the seed first, and attach to itself only as fallback. Also: if the pool is attached to self (standby) while a higher-ranked candidate exists, the preferred-hub probe must run (verify `syncProbe` treats "self at index > 0" like any other case). Tests for both.
- **RV4-3 (blocker) dual-role standby local key-log write** — `apps/gateway/src/mesh/auth-routes.ts` `refuseIfAttachedNotWriter()` (or equivalent): when this process runs the hub role, decide from the **live hub mode** (`HubRuntime.mode()`; pass a `hubMode: () => HubMode | null` provider from `mesh-runtime.ts` into AuthRoutes deps) — a dual-role process whose hub mode is `standby` refuses fresh local appends with `409 HUB_NOT_WRITER` **even when `attachedHub()` is null**; a dual-role `active` writer applies locally (it is the writer); plain nodes keep the current rule (unknown attach → today's behaviour); standalone unchanged. Tests for all four combinations.
- **RV4-6 (should-fix) advertisement reflects live mode** — `hubRoleAdvertisement()` in `mesh-runtime.ts` must read `hub.mode()`/`hub.writerEpoch()` (live) rather than static config so a fenced hub advertises `standby`; re-send `node.status` when the hub's mode changes (subscribe to whatever change hook `UplinkServer`/`HubRuntime` exposes — G3c added `onModeChange` to `UplinkServerOptions`; if it is not reachable from mesh-runtime, poll `hub.mode()` in the existing `sendStatusIfChanged()` computation so the next status tick carries it, and trigger a status send from the fencing path via a small callback you add to `HubRuntimeOptions` ONLY if `apps/gateway/src/hub/hub-runtime.ts` already exposes a generic hook — otherwise leave a note; do not edit `src/hub/**`).
- **RV4-7 (should-fix)** CA bootstrap: require `X509Certificate.keyUsage` to include `keyCertSign` (when `keyUsage` is present) in addition to `ca === true`. Test with a CA:true cert lacking keyCertSign → rejected.
- **RV4-8 (should-fix)** log hygiene: every log line that prints a hub URL must print `origin` only (scheme://host[:port]) — strip userinfo/query/fragment via one `redactUrl()` helper. Test.
- **RV4-9 (should-fix)** log volume: rate-limit `try`/`failover`/`switch-back` lines per URL to once per 60 s unless the candidate state (index/error/transport) changed; log state transitions, not every attempt. Test: 10 consecutive identical failures → ≤ 2 lines.
- **RV4-5 (should-fix, minimal)** mesh server-socket writes without backpressure handling: `apps/gateway/src/mesh/forwarder.ts` MESH_FORWARD_WS remote→browser pump (~line 373) and `/mesh/ws` broadcast in `mesh-routes.ts` (~301, ~458): check `ws.send()` results — on `-1` pause the pump until `drain` (the gateway `websocket.drain` handler for mesh sockets exists — see `assemble.ts` `mesh.websocket.drain`), on `0` close that socket with a clear reason; for the broadcast path skip the client when `getBufferedAmount()` already exceeds 1 MiB (log once). Keep it minimal and covered by unit tests with a fake socket.

## Files you own

`apps/gateway/src/mesh/uplink-pool.ts` (+test), `apps/gateway/src/mesh/mesh-runtime.ts` (advertisement + AuthRoutes dep wiring only; another agent may still touch the `new HubRuntime({...})` block — do not reformat the file), `apps/gateway/src/mesh/auth-routes.ts` (+test), `apps/gateway/src/mesh/mesh-http.ts` (dep plumbing), `apps/gateway/src/mesh/forwarder.ts` (+test), `apps/gateway/src/mesh/mesh-routes.ts` (+test), `apps/gateway/src/mesh/mesh-deps.ts` if a type needs extending.

Do NOT touch `src/hub/**`, `packages/shared/**`, `src/system/**`, `src/mesh/integration/**`, `packages/app/**`, `apps/fe/**`.

## Verification

`cd apps/gateway && bun test src/mesh && bunx tsc --noEmit -p .` → 0 fail / 0 tsc (report failures in `src/hub/**` if another agent is mid-edit), biome on changed files.

## Result file

`/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/G2d-result.md`. Write it, then exit.
