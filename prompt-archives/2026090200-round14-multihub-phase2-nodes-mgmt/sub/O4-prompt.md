# Common rules for every coding agent on this worktree

- Worktree: `/Users/konata/code/tmex-enhanced-wt-r14` (branch `feat/round14-multihub-phase2-nodes-mgmt`). Runtime is **Bun** (`bun`, `bunx`); Node only for `packages/app` CLI. If `bun` is missing from PATH, source `~/.zshrc` PATH.
- **Other agents are editing this same worktree in parallel. Touch ONLY the files listed in your scope. Never run `git add/commit/stash/checkout/reset`.** The commander commits.
- Read `AGENTS.md` at the repo root first and follow it (Chinese comments only where logic is non-obvious; no unnecessary comments; no TODOs, no stubs, no "simple version first").
- **Never touch the production tmex**: do not read/write `~/Library/Application Support/tmex/`, do not curl port 9883, do not kill/restart launchd services, do not touch the tmux session named `tmex` or the default tmux socket. Tests must use temp dirs and free ports.
- Never lint/format generated files (`packages/shared/src/i18n/resources.ts`, `types.ts`, `resources/fe-dist/*`, `dist/*`).
- Look up library APIs in `node_modules` source before using them; do not guess.
- TDD: write/extend tests alongside the implementation. Before finishing run, in the package you changed: `bun test <dir>` (in `apps/fe` use `bun test src/...`, never bare `bun test`), `bunx tsc --noEmit -p .` (error count must not exceed the baseline given in your task), `bunx biome check <changed files>` (fix with `--write`). macOS has no `timeout` command; strip ANSI from bun test output with `sed 's/\x1b\[[0-9;]*m//g'`.
- When done, write a concise result report (what changed, file list, test/tsc numbers, anything left) to the absolute result path given in your task, **then exit**. Write the file only when finished.

# O4 — Write the round-14 live test driver `live-r14.ts` (write the script + a dry self-check; the commander runs the real thing)

Result file: `/Users/konata/code/tmex-enhanced-wt-r14/prompt-archives/2026090200-round14-multihub-phase2-nodes-mgmt/sub/O4-result.md`
Deliverable: `/Users/konata/code/tmex-enhanced-wt-r14/prompt-archives/2026090200-round14-multihub-phase2-nodes-mgmt/sub/live-r14.ts`

Base it on last round's proven driver `prompt-archives/2026090104-round13-upgrade-multihub/sub/live-r13.ts` (read it fully; reuse its instance bootstrap: production-mode temp instances from repo source via `packages/app/src/runtime/server.ts`, isolated install dirs under `LIVE_ROOT`, free ports, per-instance tmux socket names like `tmex-live-r14-*`, self-signed TLS, enrollment/join via CLI `packages/app/src/cli-auth-entry.ts`, playwright only if the r13 script used it — prefer pure HTTP where possible). Update `REPO` to `/Users/konata/code/tmex-enhanced-wt-r14` and `ROOT` default under `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/c87e7d41-4167-4f04-b03f-99760894dfcc/scratchpad/live/`. NEVER touch production tmex (port 9883, `~/Library/Application Support/tmex`) or the tmux session `tmex`; set `TMEX_UPLINK_PREFER_NEAREST=0` on all instances for determinism.

Topology: A (hub,node active) + B (node → standby hub via `tmex hub standby`) + C (node seeded to A) + D (node seeded to B's URL). Read `docs/hub/2026090104-multi-hub-standby.md` (current version in this worktree) for the exact CLI/API semantics, and the result reports `sub/G2-result.md`…`sub/G5-result.md`.

Parts (each a function, runnable individually via argv, default `all`):
- **Part ADMIT**: after join, admit B via the signed key-log path: build `admit-hub` with the shared helpers (see how the FE does it — `apps/fe/src/node/enrollment.ts` admit/revoke builders; in the script you can sign with the root key directly using `packages/shared/src/auth` functions since the script knows the password/root seed from enrollment) and POST `/api/auth/keylog?hub=sync` on A; assert `GET /api/mesh/hubs` on C shows B with `authorization: 'signed'` (no TMEX_HUB_PEERS env needed on A). Also assert the compat gate: temporarily fake one node's version < 1.1.13 is NOT practical live — skip gate testing here (unit-covered).
- **Part ROLE**: `POST /n/<B>/api/hub/role` … actually call B's URL directly (`https://B/api/hub/role`, session from B? simpler: through A's entry `/n/<Bid>/api/hub/role` with C's… the script logs into A as the entry) — demote A via role API, promote B (omit writerEpoch → server allocates), assert transitions reach `complete` across B's self-restart, C fails over to B (attached hub id), A returns as standby and is fenced (higher epoch), writer switches back after promoting A again.
- **Part RELAY**: with C attached to A and D attached to B (verify via `/api/mesh/hubs` attached + `/api/mesh/nodes` `attachedHubId`), assert C can reach D: from C's gateway `GET /n/<D>/api/system/info` succeeds (cross-hub relay), and reverse.
- **Part TOKENS**: create an enrollment on A (writer), assert the reply's `replicatedTo` contains B (or poll B's db `enrollment_tokens` row); kill A, promote B, redeem the token against B with a fresh instance E (or via CLI join) → E joins.
- **Part UNINSTALL**: spawn one more disposable node F joined to the writer with a fake service-manager-free install? — `POST /api/system/uninstall` requires launchd/systemd; live instances have none (`deployment: none`) so expect 409 `UNINSTALL_NOT_ALLOWED` and assert exactly that (the full uninstall path is unit-tested; live we prove the guard). Also assert entry relay `POST /api/mesh/nodes/<F>/uninstall` surfaces the 409 and records NO lingering operation.
- **Part FORWARD**: while A is writer, create an enrollment THROUGH B (`POST https://B/api/hub/enrollments` with proper auth) and assert 200/201 + `X-Tmex-Forwarded-By` header + token exists on A.

Each part prints `PASS <part>` / `FAIL <part>: reason` and the script exits non-zero on any FAIL; cleanup kills all children and removes LIVE_ROOT unless `KEEP=1`. Timeouts generous (failover ≤ 30 s, failback ≤ 90 s, restart ≤ 90 s).

Validation you must do yourself (allowed): run `bun run live-r14.ts ADMIT` (or the cheapest part) once end-to-end from a COPY of the script placed in the scratchpad `live/` dir (r13 note: run it from a copied location so playwright/module resolution works — check the r13 header comment; if it must run from `apps/fe`, replicate that). Fix until that part passes. Report which parts you executed and their output tail. Do not run the full suite if time is tight — the commander will.

Scope: only `prompt-archives/2026090200-round14-multihub-phase2-nodes-mgmt/sub/live-r14.ts` (+ scratchpad copies), result file. Do not modify any source file. No git.
