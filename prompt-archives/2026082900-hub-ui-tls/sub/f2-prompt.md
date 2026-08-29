# Task F2 — Standalone "enable hub" wizard (become hub / join hub) + restart waiter + setup API client

Read first:
- prompt-archives/2026082900-hub-ui-tls/sub/explore-frontend.md (frontend exploration report)
- prompt-archives/2026082900-hub-ui-tls/sub/api-contract-batch1.md (API contract — the backend is being implemented in parallel; code strictly against it)
- prompt-archives/2026082900-hub-ui-tls/plan-00.md (overall plan; you implement batch 1 item F2)
- packages/api-client/src/local/types.ts and index.ts exist (commander wrote them). `index.ts` re-exports `./setup-api` — you create that file. `./local-api` belongs to task F1 (do not create/edit).

Task F1 runs in parallel and owns the Settings "Nodes" tab shell (`apps/fe/src/pages/settings/nodes/nodes-tab.tsx`) which renders `<HubSetupWizard localStatus={status} />` from `./setup/hub-setup-wizard` in standalone mode. F1 may have created a placeholder for that file; you overwrite it.

## Deliverables

1. **api-client** `packages/api-client/src/local/setup-api.ts` (+ test): `class SetupApi { constructor(client: ApiClient); precheck(url): Promise<SetupPrecheckResponse>; becomeHub(req: SetupHubRequest): Promise<SetupHubResponse>; joinHub(req: SetupJoinRequest): Promise<SetupJoinResponse> }`, typed errors (code + message) like `HubApi.readError()`. Also `readHealthStartedAt(client): Promise<number | null>` reading `GET /healthz` → `startedAt`.

2. **Restart waiter** `apps/fe/src/pages/settings/nodes/setup/use-restart-waiter.ts`: `useRestartWaiter()` returning `{ state: 'idle'|'waiting'|'restarted'|'timeout', start(previousStartedAt: number | null), elapsedMs }`; polls `/healthz` every 1 s (fetch errors are expected while the process is down), success when `startedAt` differs from `previousStartedAt` (if previous is null, success on first healthy response after at least one failure), timeout 60 s. Unit test with fake timers / injected fetch.

3. **Wizard** `apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.tsx` exporting `HubSetupWizard(props: { localStatus: LocalStatusResponse | null })`:
   - Intro card explaining the two paths. Path selector (two large radio-style cards): "Make this machine the hub" / "Join an existing hub".
   - **Become hub form** (`become-hub-form.tsx`): `hubPublicUrl` prefilled with `window.location.origin` when it is https (else empty; if `localStatus.nodeEnv !== 'production'` also accept http localhost), `username`, `password`, `confirmPassword`, `directEnable` checkbox default on. Inline validation per contract. A "Check reachability" button calling `precheck` showing reachable / isSelf / error with plain-language hints (if not reachable: explain that HTTPS must be provided by a reverse proxy / Cloudflare Tunnel for now — batch 2 adds built-in HTTPS — and link to docs/hub/2026082800-hub-node-operations.md section names). Submitting: record `startedAt`, call `becomeHub`, show result (fingerprint, direct outcome), then `useRestartWaiter.start()`; on `restarted` navigate to `/login`; on `timeout` show the manual-start hint from the contract.
   - **Join hub form** (`join-hub-form.tsx`): `hubUrl`, `token` (textarea, trims whitespace), `name` (default: browser hostname or "node"), `directEnable`, and `insecureLocal` checkbox only when `localStatus.nodeEnv !== 'production'`. Same submit/restart flow; on success show hub url + username; after restart navigate to `/login`.
   - Map backend error codes to i18n messages (`not_standalone`, `invalid_url`, `invalid_username`, `weak_password`, `user_exists`, `invalid_token`, `node_revoked`, `node_exists`, `hub_unreachable`, `join_failed`, `env_write_failed`, `direct_*`); unknown → generic with message.
   - Use `@tmex/ui` primitives (Card, Button, Input, Switch/checkbox, Badge) and sonner toasts; existing Nodes page styling for consistency.
   - Tests: static-render tests for both forms (validation messages, insecureLocal visibility by nodeEnv) and the restart flow via injected transport.

4. **i18n**: all keys under `nodes.setup.*` for the three locales. Because task F1 is editing the same locale JSON files concurrently, DO NOT edit the locale JSON files. Instead write your keys to `prompt-archives/2026082900-hub-ui-tls/sub/f2-i18n-keys.json` as `{ "en_US": { "nodes": { "setup": {...} } }, "zh_CN": {...}, "ja_JP": {...} }`; the commander merges them and rebuilds. For type-checking in the meantime, `t()` calls with unknown keys may fail tsc — if so, isolate them with a tiny local helper `ts(key: string, opts?)` that casts (`t(key as never, opts)`), placed in `setup/i18n.ts`, so tsc stays clean; the commander will convert after merging.

## Scope (files you may touch)
- packages/api-client/src/local/setup-api.ts, setup-api.test.ts
- apps/fe/src/pages/settings/nodes/setup/** (everything under this dir)
- prompt-archives/2026082900-hub-ui-tls/sub/f2-i18n-keys.json
Out of scope: everything else (in particular nodes-tab.tsx, SettingsPage.tsx, locale JSON, gateway).

## Baselines
apps/fe `bun test src/` 333 pass / 0 fail, tsc 0; packages/api-client 96 pass, tsc 5 (pre-existing).

## Result
Write `prompt-archives/2026082900-hub-ui-tls/sub/f2-result.md` when done.
## Ground rules (apply to every task)

- Repo: /Users/konata/code/tmex-enhanced-wt-merge (branch chore/merge-hub-tabs). Bun monorepo (Bun 1.3.14); NOT Node-compatible. If `bun` is not on PATH, `source ~/.zshrc`.
- Other agents are editing this same worktree IN PARALLEL. Touch ONLY the files/directories listed in your scope. If you believe you need to change a file outside your scope, do not edit it — describe the needed change in your result file instead.
- NEVER run any git command that changes state (no add/commit/stash/checkout/reset). Read-only git (status/diff/log) is fine. The commander commits.
- NEVER touch the production tmex service (launchd, port 9883, ~/Library/Application Support/tmex/) nor the tmux session named `tmex`. Do not run e2e (Playwright). Any ad-hoc server you start must use a scratch DB and ports in 20000-29999 and must be killed before you finish.
- Never lint/format generated files: packages/shared/src/i18n/resources.ts, types.ts, resources/fe-dist/*, dist/*. i18n: edit the three locale JSON sources, then run `bun run build:i18n` from the repo root.
- Code comments only where logic is non-obvious. Variable names in standard English. No TODOs, no stubs, no "simplified version" — finish the task fully. Do not restructure unrelated code.
- Verify before finishing: inside each package you touched run `bun test` (apps/fe: `bun test src/`), `bunx tsc --noEmit -p .` (error count must not exceed the baseline given to you), and `bunx biome check <changed files>`. macOS has no `timeout` command. Strip ANSI when parsing test summaries: `sed 's/\x1b\[[0-9;]*m//g'`.
- Follow the exploration report(s) given to you; if the code differs from the report, trust the code and note the discrepancy.
- Write your final report (English, markdown) to the result path given: what you changed (file list), how to verify, test/tsc numbers before/after, open issues, and any out-of-scope changes you need from others. The result file is the completion signal — write it last.
