# Task F1 — Settings "Nodes" tab shell, sidebar nodes icon, NodesManagement extraction, local status/direct API client

Read first (do not re-explore what they already answer):
- prompt-archives/2026082900-hub-ui-tls/sub/explore-frontend.md (frontend exploration report, file:line references)
- prompt-archives/2026082900-hub-ui-tls/sub/api-contract-batch1.md (API contract; backend is implementing it in parallel — code against it, do not wait for it)
- prompt-archives/2026082900-hub-ui-tls/plan-00.md (overall plan; you implement batch 1 items F1)
- packages/api-client/src/local/types.ts and index.ts already exist (commander wrote them) — use these types; index.ts re-exports `./local-api` (yours) and `./setup-api` (task F2's, do not create).

## Deliverables

1. **api-client** `packages/api-client/src/local/local-api.ts` (+ `local-api.test.ts`): `class LocalApi { constructor(client: ApiClient) ; status(): Promise<LocalStatusResponse>; setDirect(enable: boolean): Promise<LocalDirectResponse> }` following the `HubApi.readError()` typed-error pattern (throw an error carrying `code` and `message` from the contract error body). Tests with injected transport like `auth-api.test.ts`.

2. **Sidebar** `apps/fe/src/components/page-layouts/components/sidebar-title.tsx`: add a "Nodes" icon `NavLink` to `/nodes` (lucide icon e.g. `Network`), rendered only when `useSharedAuthMode().meshEnabled`. Tighten horizontal spacing of the top-row buttons (latency indicator / theme / nodes / settings): reduce the gap (e.g. `gap-2` → `gap-0.5` or `gap-1` for the action cluster, keep brand link `flex-1`), remove/adjust the `mr-[-8px]` hack coherently so four icons fit without widening the sidebar. Aria-label + tooltip text via i18n. Add `sidebar-title.test.tsx` (static render: icon hidden when mode none, shown when mesh).

3. **NodesManagement extraction**: in `apps/fe/src/pages/NodesPage.tsx`, extract the mesh management body (hooks pipeline + hub-offline notice + EnrollmentSection + NodesTable + credential dialog) into an exported `NodesManagement` component (`apps/fe/src/pages/nodes/nodes-management.tsx`, move helpers into `apps/fe/src/pages/nodes/` as needed) with props `{ mode: AuthModeResponse; api?: AuthApi; showAccountSecurityLink?: boolean; compact?: boolean }`. `NodesPage` keeps mode loading, standalone hiding, page chrome (title/subtitle/refresh) and uses `NodesManagement`. `NodesPage.test.tsx` must keep passing (adjust imports only if a helper moved).

4. **Settings tab**: `apps/fe/src/pages/SettingsPage.tsx` add tab `nodes` (label `settings.tabGroup.nodes`, icon `Network`, testId `settings-tab-nodes`), placed after `devicesAndFiles`. Content: `apps/fe/src/pages/settings/nodes/nodes-tab.tsx` exporting `NodesTab` — no `form` prop. Structure:
   - `useSharedAuthMode()` for mode; `useLocalStatus()` hook (`apps/fe/src/pages/settings/nodes/use-local-status.ts`, React Query, key `['local-status']`, `LocalApi.status()`, handles 401 in mesh by showing a "login required" hint instead of crashing).
   - `LocalMachineCard` (`local-machine-card.tsx`): role badge, hub url / hub public url (copyable), direct link row: status (supported / installed / capable) + Switch to enable/disable calling `LocalApi.setDirect`; while pending show spinner; show `restartRequired` hint; toast on error. In mesh mode a button/link to `/account/security`; in mesh mode also a link to `/nodes`.
   - standalone (`mode.mode === 'none'`): render `<HubSetupWizard localStatus={status} />` imported from `./setup/hub-setup-wizard` — task F2 owns that file. If it does not exist when you type-check, create a minimal placeholder `apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.tsx` exporting `HubSetupWizard(props: { localStatus: LocalStatusResponse | null }): null` — F2 will overwrite it. Do NOT edit it further.
   - mesh: `<NodesManagement mode={mode} compact />` below the card.
   - An `HttpsSection` slot is NOT needed in batch 1; leave a clearly named placeholder position comment-free (just structure) — nothing to render.
   - Tests: `nodes-tab.test.tsx` static render for standalone (card + wizard placeholder) and mesh (card + management) with injected transports/stores as in NodesPage.test.tsx.

5. **i18n**: add keys to all three locale JSONs (`packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json`): `settings.tabGroup.nodes`, `sidebar.nodes` (tooltip/aria), `nodes.machine.*` (title, role, roleStandalone, roleNode, roleHub, hubUrl, hubPublicUrl, direct, directSupported, directUnsupported, directInstalled, directNotInstalled, directCapable, directEnable, directDisable, directRestartRequired, directFailed, accountSecurity, openNodesPage, loginRequired). Keep to those namespaces; task F2 will add `nodes.setup.*` separately (do not add any `nodes.setup.*` keys). Then run `bun run build:i18n` from the repo root.

## Scope (files you may touch)
- packages/api-client/src/local/local-api.ts, local-api.test.ts
- apps/fe/src/components/page-layouts/components/sidebar-title.tsx (+ new sidebar-title.test.tsx)
- apps/fe/src/pages/NodesPage.tsx, NodesPage.test.tsx, new apps/fe/src/pages/nodes/**
- apps/fe/src/pages/SettingsPage.tsx, new apps/fe/src/pages/settings/nodes/** EXCEPT `setup/**` (only the placeholder described above)
- the three locale JSON files (only the namespaces listed) + the generated i18n outputs via the build script
Out of scope: anything under apps/gateway, packages/app, packages/shared/src (except locales), other fe pages.

## Baselines
apps/fe `bun test src/` 333 pass / 0 fail, tsc 0 errors; packages/api-client 96 pass, tsc 5 errors (pre-existing); packages/shared 335 pass, tsc 0.

## Result
Write `prompt-archives/2026082900-hub-ui-tls/sub/f1-result.md` when done.
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
