## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: split harness — run the DataChannel scenarios (D/H/I) against node-b over the LAN bridge, in addition to the hub

Scope (only): `scripts/hub-e2e/split/run.sh`, `docs/hub/2026082801-hub-docker-e2e.md` (分体拓扑 section only). Do NOT touch drivers, compose, entrypoint, app code. Do NOT run the harness or docker builds (the commander runs it).

Context from today's live runs (read `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-harness-direct-result.md` and the D/H/I code in `run.sh`): node-a↔hub DC never establishes in this environment (hub's VPS filters inbound UDP upstream; node-a is behind a symmetric NAT; TURN over TCP is unsupported by libjuice). So D2/D3 fail and H/I are skipped, which leaves the DataChannel interruption + bulk logic unverified. node-a and node-b share the `lan` docker network from scenario C onward, so host ICE candidates connect directly — a DC between node-a (entry) and node-b over LAN is achievable.

Change `run.sh`:
1. Refactor D/H/I into functions parameterized by target: `run_direct_scenarios <label> <target-node-id> <target-container-exec-fn> <device-id> <pane-id>` (or equivalent) so the same assertions run for target=hub (existing, via `rssh docker exec tmex-split-hub …`) and target=node-b (local `docker exec tmex-split-node-b …`). Reuse existing helpers (`driver nodes.ts wait-transport`, `terminal.ts --capture-seq`, `files.ts sha256`, `drop_direct_udp`/`undrop_direct_udp`). Report row labels: keep `D1/D2/D3/H1/H2/H3/I1/I2` for the hub target and add `L1..L8` (or `D1-lan`… — pick one scheme and document it) for node-b.
2. `direct enable` must also run on node-b (restart node-b, wait healthy, recreate its tmux session like the existing hub/node-a code does; the device on node-b from scenario A/C: `DEVICE_B_ID`/`PANE_B` already exist — check they survive the restart, recreate as the existing code does after D/E).
3. For the LAN target the UDP drop on node-a must cut the DC (host candidates are UDP) while the uplink (TCP/WSS) survives — the existing iptables rule `OUTPUT -p udp DROP` covers it. After undrop the transport must return to `dc` (the existing H3 logic).
4. Ordering: run the LAN variant right after E (lan is connected from C onward and stays), then the hub variant as today. The LAN variant rows are REQUIRED (count toward FAILS); the hub variant stays as-is (FAIL with evidence when the environment blocks UDP). Keep the report/evidence behavior.
5. Update the 分体拓扑 scenario table in the doc accordingly and note why the LAN variant exists.

Verification: `bash -n`, `shellcheck` if available (`brew list shellcheck` — if not installed skip), read through once for unbound variables under `set -u`.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-harness-lan-dc-result.md`
