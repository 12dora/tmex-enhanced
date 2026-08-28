## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: split harness — optional netem shaping on the LAN bridge for the L (LAN DC) scenarios

Scope: `scripts/hub-e2e/split/run.sh`, `scripts/hub-e2e/Dockerfile` (add `iproute2` to apt if missing), `docs/hub/2026082801-hub-docker-e2e.md` (分体拓扑). Do NOT run the harness or docker builds.

Add `TMEX_E2E_LAN_NETEM` (e.g. `"delay 80ms rate 16mbit"`): when set, before the LAN direct scenarios apply `tc qdisc add dev <lan iface> root netem $TMEX_E2E_LAN_NETEM` inside node-a AND node-b (the interface attached to the docker `lan` network — find it by matching the container's IP on that network via `ip -4 -o addr`), log it, and remove it (`tc qdisc del`) after the LAN scenarios and on EXIT. The containers already have `cap_add: NET_ADMIN`. Print the effective qdisc (`tc qdisc show dev …`) into the report evidence for L2. Purpose: reproduce WAN-like latency/bandwidth on the LAN DC so the 8 MiB bulk (L7) and interruption (L4/L5) scenarios exercise flow control like the real TURN path.

Verification: `bash -n`; read the Dockerfile apt list; keep `set -u` safety.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-harness-netem-result.md`
