# Common rules for every coding agent on this worktree

- Worktree: `/Users/konata/code/tmex-enhanced-wt-r14` (branch `feat/round14-multihub-phase2-nodes-mgmt`). Runtime is **Bun** (`bun`, `bunx`); Node only for `packages/app` CLI. If `bun` is missing from PATH, source `~/.zshrc` PATH.
- **Other agents are editing this same worktree in parallel. Touch ONLY the files listed in your scope. Never run `git add/commit/stash/checkout/reset`.** The commander commits.
- Read `AGENTS.md` at the repo root first and follow it (Chinese comments only where logic is non-obvious; no unnecessary comments; no TODOs, no stubs, no "simple version first").
- **Never touch the production tmex**: do not read/write `~/Library/Application Support/tmex/`, do not curl port 9883, do not kill/restart launchd services, do not touch the tmux session named `tmex` or the default tmux socket. Tests must use temp dirs and free ports.
- Never lint/format generated files (`packages/shared/src/i18n/resources.ts`, `types.ts`, `resources/fe-dist/*`, `dist/*`).
- Look up library APIs in `node_modules` source before using them; do not guess.
- TDD: write/extend tests alongside the implementation. Before finishing run, in the package you changed: `bun test <dir>` (in `apps/fe` use `bun test src/...`, never bare `bun test`), `bunx tsc --noEmit -p .` (error count must not exceed the baseline given in your task), `bunx biome check <changed files>` (fix with `--write`). macOS has no `timeout` command; strip ANSI from bun test output with `sed 's/\x1b\[[0-9;]*m//g'`.
- When done, write a concise result report (what changed, file list, test/tsc numbers, anything left) to the absolute result path given in your task, **then exit**. Write the file only when finished.

# G7 — Final backend hardening from review round 3 (all accepted findings)

Result file: `/Users/konata/code/tmex-enhanced-wt-r14/prompt-archives/2026090200-round14-multihub-phase2-nodes-mgmt/sub/G7-result.md`

Read `prompt-archives/2026090200-round14-multihub-phase2-nodes-mgmt/sub/RV3-result.md` fully — the commander accepted ALL backend findings. Verify each referenced line against current code, then fix:

1. `hub.write-forward` frame gains `writerHubId`/`writerEpoch` (appended optional fields, legacy-stripped); the executing hub verifies `isWriter()`, own id and current epoch before executing; mismatch → `HUB_NOT_WRITER` ack. (uplink-server.ts ~595, codec)
2. A process with the hub role must NEVER RTT-switch its uplink away from the current writer: in `uplink-pool.ts` disable prefer-nearest when local roles include `hub` (writer uplink is the control plane); nodes-only feature. Document in the doc's RTT section.
3. Uniform live/generation gating: `hub.tokens` / `hub.attachments` / `hub.forward` / write-forward ACKs / relay callbacks are dropped when arriving on a superseded uplink; handlers receive the actual source `{hubNodeId, generation}` from the pool/client instead of re-deriving "current writer"; writer-only frames then check source === pickWriterHub() and epoch. (mesh-runtime.ts ~1102/1169, hub-runtime.ts ~385/450, uplink-pool.ts ~1219)
4. Attachment keepalive: re-send the full local attachment set every 2 min (< 5 min TTL) and/or refresh all routes of a hub on its uplink heartbeat; a quiet-but-alive remote node must not expire. (attachment-router.ts ~169, uplink-server.ts ~710)
5. Paginate `hub.attachments` snapshots/unions like `hub.tokens`: ≤48 KiB per frame with `{snapshotId, page, final}`, receiver applies atomically on final; assert encoded size before send; tighten the per-frame entry cap. (codec ~33/369)
6. Cross-hub nodes count as online: `node.list` `online` = local registry OR live attachment route (flips off when the route expires/revokes); `/api/mesh/nodes` and hub-side online gates use it so relay targets are usable from the UI. (uplink-server.ts ~1853, mesh-runtime.ts ~1411)
7. Forwarded-write ACKs can exceed the 64 KiB control frame (redeem returns full key log + certs): pre-encode size check plus chunked ACK (`{id, part, final, bytes}` reassembled by the standby) so a successful side-effect never loses its response; request bodies size-checked before send with a clean oversized error. (hub-runtime.ts ~522, writer-forward.ts ~63)
8. Writer-side idempotency cache for forwarded writes: bounded in-memory LRU keyed `(fromHubId, id)` storing request digest + full ACK; same id+digest → replay stored ACK; same id different digest → reject. (uplink-server.ts ~595, writer-forward.ts ~91)
9. Auto-promote: track writer unreachability and quorum votes per `(writerHubId, writerEpoch)` (reset on epoch change); accept only votes whose epoch matches; judge freshness by local receive time, not the peer clock's `observedAt`. (hub-peer-poller.ts ~109/370)
10. Startup ordering: do not advertise a CA fingerprint (node.status / mesh_hubs self row / /api/hub/status) before the HTTPS listener has successfully applied; gate the initial advertise on listener state; if the listener ultimately fails, refrain/withdraw. (packages/app/src/runtime/assemble.ts ~749, server.ts ~49 — coordinate with the tls-service callback)
11. Relay resource bounds: remove `crossHubStreams` entries on normal close (`stream.closed`), delete empty sets; LRU/size-cap `RtcHubRouteTable`; cap `hub-relay` OPEN payload bytes BEFORE JSON parse (8 KiB) and `visitedHubIds.length` ≤ hop limit before any map insertion. (uplink-server.ts ~914, rtc/signaling.ts, hub-relay.ts ~48)

Tests for every item (unit + extend `multi-hub.integration.test.ts` where the harness reaches: stale-generation frame dropped, forwarded write on fenced ex-writer rejected, attachment keepalive keeps route past TTL, paginated snapshot, cross-hub online projection, chunked oversized ACK, idempotent replay). Baselines: `apps/gateway` full `bun test` green (≈3493 + yours), tsc 0; `packages/shared` green, tsc 0; `packages/app` tsc 1 pre-existing.

Scope: `apps/gateway/src/hub/**`, `apps/gateway/src/mesh/**` (surgical in `mesh-routes.ts`, only the online projection if needed), `packages/shared/src/uplink/codec.ts` (+test), `packages/app/src/runtime/{assemble.ts,server.ts}`, `packages/app/src/tls/tls-service.ts` if needed, `docs/hub/2026090104-multi-hub-standby.md`. Do NOT touch `apps/gateway/src/api/**`, `system/**`, `tunnel/**`, `apps/fe/**`.
