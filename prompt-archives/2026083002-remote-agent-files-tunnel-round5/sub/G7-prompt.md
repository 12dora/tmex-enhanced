# Task G7 — Fix review finding: link failover emits a transient offline (backend, small)

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


Context: `review-be-2-report.md` item 3 in this directory. In `apps/gateway/src/mesh/peer-manager.ts` `dropPeer()` removes the live link and immediately calls `onLinkInfo` (reach = null → mesh-runtime emits an `offline` node event → `notifyNodeOffline` kills running remote agent sessions and the UI flickers), and only afterwards promotes the retiring/parked fallback link (WebRTC → WebSocket/relay downgrade is a normal event).

## Scope (files you own)
apps/gateway/src/mesh/peer-manager.ts (+ its tests), apps/gateway/src/mesh/node-event-dedupe.ts if needed. Do NOT edit mesh-runtime.ts (another agent owns it right now).

## Fix
Promote the retiring/parked link first, then emit a single link-info notification reflecting the final live state; only emit a null reach when no fallback exists. Make sure `rttOf` resets appropriately on the promoted link. Add tests: (a) dc link dropped with a parked ws-secure link → observers see exactly one link info with reach lan/wan (never null in between); (b) last link dropped → null. Run the whole `src/mesh` test folder, tsc, biome.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r5/prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/G7-result.md
