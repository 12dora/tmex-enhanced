# Task G1 — Remote-node agent sessions (backend)

## Ground rules (read carefully)
- Repo: tmex monorepo, Bun-only runtime (`bun`, `bunx`; never node/npm/npx for running). Worktree root: /Users/konata/code/tmex-enhanced-wt-r5. Work ONLY inside this worktree.
- Several other agents are editing this same worktree in parallel. Touch ONLY the files/directories listed in your scope (plus new files you create inside those directories). Do NOT run `git add/commit/stash/checkout/reset`. Do NOT run formatters over the whole repo; `bunx biome check --write <your files>` only.
- Never edit generated files: `packages/shared/src/i18n/resources.ts`, `packages/shared/src/i18n/types.ts`, anything under `resources/`, `dist/`. For i18n, edit the source locale JSONs `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` (all three, same keys, only inside the sub-object named in your scope) — the commander runs `bun run build:i18n`. If you need the generated types updated to typecheck, you may run `bun run build:i18n` from the repo root yourself (it only regenerates from the JSONs).
- Copy (UI strings) must be concise, professional and plain — the tone of mature large-scale software (think VS Code / GitHub settings). No exclamation marks, no chatty phrasing. zh_CN uses Chinese punctuation.
- Comments in code: only when the logic is genuinely non-obvious; existing comments in this repo are in Simplified Chinese — follow that.
- Do not touch anything about the production tmex install (`~/Library/Application Support/tmex`, port 9883) or any tmux session named `tmex`. Tests must use isolated tmux sockets / test env only.
- Never leave TODOs, stubs, or "simplified versions". Finish the whole scope. If something in the scope is impossible, explain exactly why in your result file.
- Verify before finishing: run the relevant package tests (`cd <pkg> && bun test` — for apps/fe use `bun test src/`), `bunx tsc --noEmit -p .` in each package you touched (error count must not exceed the baseline given below), and `bunx biome check <files you changed>`. Baseline (before this round): apps/gateway 2500 pass / tsc 21 errors (pre-existing); apps/fe 671 / 0; packages/panels 507 / 0; packages/stores 282 / 1; packages/shared 365 / 0; packages/api-client 132 / 5 (pre-existing); packages/ui 47 / 0. Note: the commander already changed shared contracts (agent `nodeId`, MeshNode `reach`/`rttMs`, files browse, tunnel) so some test fixtures now fail tsc until the owning agent updates them — that is expected and yours to fix if in your scope.
- Shared contracts are already written and are FIXED (do not change their shape; you may add doc comments): `packages/shared/src/contracts/agent.ts` (`AgentSessionDto.nodeId`, `CreateAgentSessionRequest.nodeId`), `packages/shared/src/contracts/files.ts` (`BrowseDirectory*`), `packages/shared/src/contracts/tunnel.ts`, `packages/api-client/src/auth/types.ts` (`MeshNode.reach: 'lan'|'wan'|'relay'|null`, `rttMs`), api-client functions `browseDirectory` (file-resources.ts), `fetchAgentSessions(client, {nodeId})` (agent.ts), `fetchTunnelStatus/runTunnelAction` (local/tunnel-api.ts).
- When done, write a concise result report (what changed, file list, test/tsc/biome numbers, anything left or risky) to the absolute path given in your task, then exit.


## Goal
Today an agent session is bound to a pane on the gateway that serves the request; the LLM runs there. In mesh mode we want the browser's entry gateway (self) to own and run ALL agent sessions — including ones bound to a pane on a REMOTE node — using self's LLM providers/settings. Pane reads/writes for remote sessions go over the mesh to the remote node.

Read first: prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/explore-agent-report.md (sections 2–5 map every function involved; line numbers are approximate).

## Scope (files you own)
- apps/gateway/src/db/schema.ts (agentSessions table only), apps/gateway/drizzle/** (new migration; follow the existing drizzle workflow — check package.json scripts / docs for how migrations are generated in this repo, and make sure the generated SQL + meta journal are included), apps/gateway/src/db/agent.ts
- apps/gateway/src/api/agent-session-routes.ts, agent-dtos.ts, agent*.ts, apps/gateway/src/agent/** (supervisor, run, run-deps, run-resource-scope, build-run-request, tools/**)
- apps/gateway/src/mesh/**: only NEW files you create there (e.g. `mesh-internal-tmux-routes.ts`, `peer-request-marker.ts`) plus minimal hook lines in `stream-targets.ts` (mark accepted peer HTTP requests), `mesh-http.ts` (strip/deny the marker on external requests, route `/api/mesh-internal/*`) and `forwarder.ts` if you need a server-side helper to send an internal request to a node. Another agent (G2) edits `peer-manager.ts`, `node-list-projection.ts`, `mesh-routes.ts`, `mesh-deps.ts`, `types.ts` — do NOT touch those.
- apps/gateway/src/ws/agent-kind-handlers.ts if needed.
- Tests next to the files above.

## Requirements
1. DB: `agent_sessions.node_id TEXT NULL` (null = self). Migration + schema + `db/agent.ts` create/list (list optionally filtered by nodeId: 'self' → IS NULL, other → = nodeId) + DTO (`nodeId` is already required on `AgentSessionDto`; fix test fixtures in your scope).
2. API: `POST /api/agent/sessions` accepts `nodeId` (undefined/null/'self' → null). For a remote nodeId: validate the node is a known, trusted, ONLINE mesh peer (use existing mesh runtime/peer-manager read-only APIs via deps); capture origin (pane title/process) through the remote RPC instead of the local registry. `GET /api/agent/sessions?nodeId=` filters as described in `fetchAgentSessions` (packages/api-client/src/agent.ts). `PATCH` must not allow changing the node.
3. Remote pane RPC: add internal HTTP routes on every gateway under `/api/mesh-internal/tmux/`:
   - `POST pane-info` {deviceId, paneId} → what `getPaneInfo` + `findPaneInSnapshot` return
   - `POST capture` {deviceId, paneId, historyLines?} → text
   - `POST send-input` {deviceId, paneId, data} → ok
   Auth model: these routes MUST only be reachable by requests that arrived over an authenticated mesh peer stream. Find where the receiving side of `forwardHttp` (`acceptHttpStream` in stream-targets.ts) builds the Request; attach a marker there (a header like `x-tmex-mesh-peer: <fromNodeId>`) that is also STRIPPED from every externally received request at the HTTP entry (mesh-http.ts) so browsers cannot spoof it — prove it with a test. Routes reject without the marker (403) and do not require a browser session cookie.
   On the self side implement `RemotePaneRuntime` (or similar) satisfying the subset of the runtime interface the agent tools use (`getPaneInfo`, `capturePaneText`, `sendInput`, plus whatever `run-resource-scope` / `build-run-request` / `tools/pane-info.ts` need — narrow those to a small interface instead of the full `DeviceSessionRuntime` where necessary) by sending requests through the existing forwarder / stream opener to the node's `/api/mesh-internal/tmux/...`. Map NODE_UNREACHABLE → a clear tool error / session error.
   Introduce `acquireRuntime(nodeId | null, deviceId)` at the registry/run boundary; the local path stays unchanged.
4. Offline propagation: when a mesh peer goes offline (find the existing peer-offline event; subscribe via deps without editing G2's files if possible — if you must add a one-line hook in mesh-runtime.ts keep it minimal and say so), call `supervisor.stopSessionsForNode(nodeId)` mirroring `stopSessionsForDevice` (stop active runs; running/waiting → error with lastError `NODE_OFFLINE`). Agent WS events already broadcast status changes — ensure this path emits them.
5. Tests: routes (create with nodeId, list filter, marker 403, spoofed marker stripped), RemotePaneRuntime over a fake stream opener, supervisor stopSessionsForNode, migration applies on a fresh db (existing test helpers).

Write your result to: /Users/konata/code/tmex-enhanced-wt-r5/prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/G1-result.md
