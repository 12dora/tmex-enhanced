# Task F7 — Login flow: correct error, no internal copy, no passkey registration on login, navigate immediately, lazy per-node login

Read: prompt-archives/2026082900-hub-ui-tls/sub/explore-login-devices.md (sections 1, 2, 4 — file:line references), sub/f6-result.md (glossary; keep the tone), plan-prompt.md (第三轮需求 1/2/3/5 + 补充反馈).

User feedback (verbatim intent):
1. Wrong password currently shows "all nodes failed to sign in" — must show the real cause ("Wrong password", "Verification code required/invalid", network error…).
2. The passkey **registration** link on the login page must go; registration lives only in Account Security. The passkey **sign-in** button stays.
3. Remove internal-state explanations from the login page (e.g. "enter password once or passkey once…", fan-out progress list). The login page shows: brand, username, password, verification code (only when `totpEnabled`), Sign in, Sign in with passkey — nothing else except an error line.
4. On success, enter the local tmex **immediately** (navigate to `next` as soon as `self` login succeeds).
5. Do NOT log into every node up front. Log into a node only when the user needs it: keep the in-memory session key; a node gets logged in lazily when (a) the user navigates to `/n/:id/*`, or (b) the user expands / clicks that node in the sidebar, or (c) presses the existing "Sign in to this node" button. Silent login (no prompt) while the in-memory key is alive; otherwise the button/redirect as today. Keep the explicit `?node=` login-page flow (it targets one node and may block on it).

Implementation notes:
- `apps/fe/src/auth/session-key-store.ts`: replace `loginToAllReachable()` with `loginSelf()` (returns `{ ok, code? }`) and `ensureNodeLogin(nodeId)` (idempotent, single-flight per node, uses the in-memory key, updates the mesh store's `loggedIn` for that node on success; throws/returns code on failure). Remove the fan-out; keep TOTP handling (`clearTotpCode` after self login — decide whether the code is still needed for lazy logins: if nodes require TOTP per login, keep the derived material needed instead of the raw code; read the code to decide and document).
- Error mapping in `LoginPage.tsx`: `DELEGATION_BAD_SIGNATURE` / `BAD_SIGNATURE` / `ROOT_KEY_MISMATCH` → `auth.errors.wrongPassword`; `TOTP_REQUIRED` / `TOTP_INVALID` → their keys; `NETWORK_ERROR` → its key; unknown → generic. Never show raw codes/messages.
- Lazy login hooks: `apps/fe/src/node/node-runtime-boundary.tsx` (route `/n/:id`) and `apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx` (on expand/click) call `ensureNodeLogin` when the node is online and not logged in; while pending show a small spinner instead of the tree; on failure fall back to the existing login button (which, if the key is gone, goes to `/login?node=`).
- Sidebar: for online-but-not-signed-in nodes do NOT auto-login on mount; keep collapsed with a "Sign in" affordance; expanding triggers the silent login.
- Login page brand header: render `<Brand />` from `@/components/brand` at the top of the login card (task F8 creates that component in parallel; if it does not exist when you type-check, create a placeholder `apps/fe/src/components/brand.tsx` exporting `Brand(): JSX.Element` that renders the `/logo.png` image + site name from `useSiteStore` — F8 will overwrite it).
- i18n: update `auth.login.*` / `auth.errors.*` keys in the three locale JSONs (remove keys that are no longer used, add `auth.errors.wrongPassword`, `auth.login.signInToNode`/pending text if needed). Then `bun run build:i18n`. No other agent edits the `auth.*` namespace now; task F9 writes its keys to a fragment file, not the JSON.
- Tests: LoginPage.test.tsx (remove the registration-link expectation; add wrong-password mapping, immediate navigation), session-key-store tests (loginSelf, ensureNodeLogin single-flight + mesh store update), sidebar-node-section test (no auto login; expand triggers), node-runtime-boundary test.

Scope: apps/fe/src/pages/LoginPage.tsx (+test), apps/fe/src/auth/** , apps/fe/src/node/node-runtime-boundary.tsx (+test), apps/fe/src/node/mesh-nodes.ts (only a `markLoggedIn(nodeId)` helper), apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx (+test), locale JSON `auth.*` only, generated i18n. Do not touch sidebar-title.tsx, main.tsx, DevicesPage, brand.tsx beyond the placeholder rule.
Baseline: apps/fe `bun test src/` 470/0, tsc 0.
Result: prompt-archives/2026082900-hub-ui-tls/sub/f7-result.md
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
