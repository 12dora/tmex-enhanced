## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: remote node names degrade to raw node ids in `GET /api/mesh/nodes` on non-hub entries (and briefly on hub entries)

Scope: `apps/gateway/src/mesh/**` EXCEPT `rtc/**` and `peer-manager.ts` (those were just changed by someone else — read-only for you), plus `apps/gateway/src/hub/**` read-only unless a hub-side fix is unavoidable. Do NOT touch `scripts/**`, `apps/fe/**`, `packages/**`.

Observed on a real 4-node mesh today: on a freshly joined node entry (`home`, role `node`, uplink to a public hub), `GET /api/mesh/nodes` returns `name` equal to the node id for the hub row and for another node row (`{"id":"364676b5…","name":"364676b5ee9193fd551a8bfbffbc92e1","isHub":true}`, `{"id":"61154a33…","name":"61154a33ec0e50e995b74fe7bba20780"}`) even though `GET /api/hub/nodes` on the hub knows them as the hub's own name / `node-a`. The sidebar therefore shows raw ids. A previous engineer noted: `mesh-routes.ts` builds the name as `peer?.name ?? (isSelf ? 'self' : id)` and only reads the peers table, which on a hub entry is populated asynchronously and is deleted by `onNodeList` when the cert/uid check does not line up.

Find the real reason names are missing on a node entry: trace `node.list` (hub → node, `uplink-protocol.ts` / `uplink-client.ts` / `mesh-runtime.ts` `onNodeList`) — does the hub include `name` in each entry? does the node persist it into `peer_cache`/peers? is the hub's own row (self on hub) ever named (hub's `nodes` registry has no row for itself? then the hub should advertise its own display name, e.g. from `TMEX_SITE_NAME` or os.hostname(), in the `hub_meta` sentinel)? Also `self` naming: the entry's own row is literally `"self"` — check whether the DTO also carries the node's real registered name so the UI can show `home (self)`; if the hub registry name for self is available locally (`node_identity` after join has the name?), expose it as `name` and keep `isSelf` semantics via `id === mode.nodeId`; verify the frontend does not depend on the literal string `'self'` (grep `apps/fe`, `packages/panels`, `packages/stores` for `=== 'self'` — report, do not edit FE; if FE depends on it, keep `name: 'self'` and add `displayName` instead).

Fix with tests (`mesh-routes.test.ts`, `mesh-runtime.test.ts`, hub tests as needed): names must be present for all online peers on both hub and node entries as soon as `node.list` has been received, survive hub restart via `peer_cache`, and update on rename (`nodes.name` changes → next `node.list`/`NODE_EVENT`).

Verification: `cd apps/gateway && bun test` 0 fail (baseline now 2321 pass), tsc ≤ 21, biome clean.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-node-names-result.md`
