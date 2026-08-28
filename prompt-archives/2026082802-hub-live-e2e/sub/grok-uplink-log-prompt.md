## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: uplink connect failures are silent — add diagnostics and a connect timeout

Scope: `apps/gateway/src/mesh/uplink-client.ts` (+ `uplink-client.test.ts`), `docs/hub/2026082800-hub-node-operations.md` (常见排障 table). Nothing else (other agents are editing peer-manager/rtc/forwarder concurrently).

Observed today: a freshly joined production node (`TMEX_ROLES=node`, valid `TMEX_HUB_URL`) showed zero `[uplink]` log lines for 10+ minutes and never opened a socket to the hub; `runLoop()` in `uplink-client.ts` swallows every `connectOnce` error (`catch {}`) and backs off (`backoffDelayMs`), so operators cannot tell TLS errors, 4401 rejections, DNS failures, or a hung handshake apart. Required:
1. Log every connect failure once per attempt, rate-limited to at most one line per 30 s per reason: `[uplink] connect failed hub=<host:port> attempt=<n> reason=<code/message class> next_retry_ms=<delay>` (never log credentials or full URLs with tokens). Map common causes to stable reason codes: tls (certificate/handshake), dns, refused, timeout, http_<status> (e.g. 4401/403 upgrade rejection), auth_rejected (post-handshake auth failure), protocol.
2. Log state transitions `[uplink] online hub=… after_ms=…` and `[uplink] offline reason=…` (rate-limited).
3. Add a connect timeout (`UPLINK_CONNECT_TIMEOUT_MS`, default 20000) around the WS open + auth handshake in `connectOnce` so a hung TLS/handshake counts as a failure and retries.
4. Expose the last failure reason/time on the client (e.g. `lastConnectError`) and surface it in `GET /api/mesh/nodes`' self row or `/api/auth/mode` only if a field already exists for uplink state (grep `uplinkState`/`hubOnline`); otherwise leave HTTP alone and just log.
Tests with the fake scheduler/transport: failure → log line with reason + retry; timeout → failure; online/offline lines.

Verification: `cd apps/gateway && bun test src/mesh/uplink-client.test.ts` and `bun test src/mesh` 0 fail; tsc ≤ 21; biome clean.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-uplink-log-result.md`
