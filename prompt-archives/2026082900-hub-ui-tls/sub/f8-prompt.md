# Task F8 — Single source of truth for brand (logo + product name) and top-bar branding on sidebar-less pages

Read: prompt-archives/2026082900-hub-ui-tls/sub/explore-login-devices.md section 3 (branding inventory, file:line).

User feedback: "这些页面左上角 top bar 都应该展示 tmex 的 logo 和名称。所有对 logo 和名称的引用归为一处，避免后续散弹修改。"

Implement:
1. `apps/fe/src/components/brand.tsx`: `Brand({ size?: 'sm'|'md', linkTo?: string, showName?: boolean })` — renders the logo (`/logo.png`, from one exported constant `BRAND_LOGO_SRC`) and the site name (`useSiteStore().settings?.siteName` with the store's fallback; export `useBrandName()`); optional NavLink wrapper. Export `PRODUCT_NAME = 'tmex'` for the non-site-name fallback and use it in the store fallback modules too if they hardcode `'tmex'` (`packages/stores/src/site.ts`, `site-fallback.ts`) — if importing from apps/fe into packages/stores is impossible (dependency direction), put the constant in `@tmex/shared` (browser-safe) and import it from both places.
2. `sidebar-title.tsx`: replace the inline logo/name block with `<Brand linkTo="/" />` — keep layout, testids and the mesh-only nodes icon exactly as they are.
3. `apps/fe/src/main.tsx` `PageWrapper`: when `withSidebar={false}` (login, account security, nodes page) render `<Brand size="sm" linkTo="/" />` at the left of the top bar before the page title. Task F7 is concurrently editing `LoginPage.tsx` and will place `<Brand />` inside the login card itself; if it created a placeholder `brand.tsx`, overwrite it with yours (same export name `Brand`).
4. Grep for every remaining hardcoded `'tmex'` product-name string and `/logo.png` in `apps/fe/src`, `packages/panels/src`, `packages/stores/src`, `packages/ui/src` (excluding tests, `index.html`, PWA manifest, CLI/backend) and route them through the constants.
5. Tests: `brand.test.tsx` (name fallback, custom siteName, link), update `sidebar-title.test.tsx`, and a PageWrapper static-render check that the brand appears when `withSidebar=false`.

Scope: apps/fe/src/components/brand.tsx (+test), apps/fe/src/components/page-layouts/components/sidebar-title.tsx (+test), apps/fe/src/main.tsx, packages/stores/src/{site.ts,site-fallback.ts}, packages/shared/src/<new brand constants file> (browser-safe, exported from the main barrel), packages/panels/src/device-console/page-title.tsx & use-device-console-effects.ts only if they hardcode the name. Do not touch LoginPage.tsx, DevicesPage, locale JSON.
Baseline: apps/fe 470/0 tsc 0; packages/stores 257/0 tsc 1; packages/shared 344/0; packages/panels 368/0.
Result: prompt-archives/2026082900-hub-ui-tls/sub/f8-result.md
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
