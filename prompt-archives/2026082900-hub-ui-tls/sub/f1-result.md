# F1 result — Settings "Nodes" tab shell, sidebar nodes icon, NodesManagement extraction, local API client

Status: **done**. All deliverables implemented, tests and type checks at or above baseline.

## Files changed

### api-client
- **new** `packages/api-client/src/local/local-api.ts` — `LocalApi { status(), setDirect(enable) }` on an injected `ApiClient` (defaults to `defaultApiClient`, i.e. the entry machine, no `/n/<id>` prefix). Typed errors follow the `HubApi.readError()` pattern: `LocalApiError { code, message, status }`, parsed from the contract body `{ error: { code, message } }` (also tolerates the legacy `{ error: "code" }` envelope). Exports `defaultLocalApi`.
- **new** `packages/api-client/src/local/local-api.test.ts` — 8 tests with a recorded transport (same shape as `auth/auth-api.test.ts`): URL/method/body assertions, `restartRequired` pass-through, 401 and `409 direct_unsupported` typed errors, unparseable-body fallback.

`src/local/index.ts` and `src/local/types.ts` were left untouched (owned by the commander); `setup-api.ts` is F2's.

### Sidebar
- `apps/fe/src/components/page-layouts/components/sidebar-title.tsx`
  - New `Network` icon `NavLink` to `/nodes`, rendered only when `useSharedAuthMode().meshEnabled` (false while the mode is still loading, so it never flashes). `aria-label` + `title` from `sidebar.nodes`, `data-testid="sidebar-nodes"`.
  - Spacing tightened: the action buttons (latency / theme / nodes / settings) now live in one `flex shrink-0 items-center gap-0.5` cluster; the row gap dropped `gap-2` → `gap-1`; the brand link keeps `flex-1`. The `mr-[-8px]` hack moved from the settings link onto the cluster, so the optical right edge is unchanged while four icons fit without widening the sidebar. The shared button classes were hoisted into `ACTION_BUTTON_CLASS`, and `WsLatency` got `px-0.5` so it does not collide with the tighter gap.
  - The settings link gained `data-testid="sidebar-settings"` (it had none).
- **new** `apps/fe/src/components/page-layouts/components/sidebar-title.test.tsx` — 3 static-render tests (mesh shows `/nodes`, `mode:'none'` does not, unloaded mode does not). Renders inside `MemoryRouter` + `RuntimeProvider` + `SidebarProvider`; installs a `window.matchMedia` stub because `SidebarProvider` reads it during the initial state computation.

### NodesManagement extraction
`apps/fe/src/pages/NodesPage.tsx` shrank from 990 to 45 lines. It now only does mode loading, standalone hiding (`return null`) and mounting the shared body. New files under `apps/fe/src/pages/nodes/`:

- `types.ts` — `ResolvedMode`, `PLACEHOLDER_KDF`.
- `use-admit-action.ts` — `canAutoSignAdmit()`, `useAdmitAction()` (moved verbatim).
- `enrollment-section.tsx` — `EnrollmentSection`, `resolveHubPublicUrl()`, `CopyableCode` (moved verbatim).
- `nodes-table.tsx` — `NodesTable`, `NodeRowView`, `formatLastSeen()`, `Th`/`Td`/`Tag` (moved verbatim).
- `nodes-management.tsx` — exported `NodesManagement({ mode, api?, showAccountSecurityLink?, compact? })` with the full hooks pipeline (mesh nodes, hub node, pendings, passkeys, credential prompt, enrollment watch, expiry sweep), hub-offline notice, `EnrollmentSection`, `NodesTable`, credential dialog.

`NodesPage.test.tsx`: only the two helper imports moved (`canAutoSignAdmit` from `./nodes/use-admit-action`, `resolveHubPublicUrl` from `./nodes/enrollment-section`). All 9 assertions still pass unchanged.

**Deviation from the task text, deliberate:** the header (title / subtitle / refresh / account-security link) stayed *inside* `NodesManagement` rather than moving up into `NodesPage`. The refresh button needs `refreshAll`, which is built from `useMeshNodes()` + `useHubNode()` inside the pipeline; hoisting it into `NodesPage` would have meant either lifting the whole pipeline back out or adding a render-prop/imperative-handle just for one button. Instead `compact` selects the container and header variant:
- `compact={false}` (the `/nodes` page): `mx-auto max-w-5xl p-3 sm:p-5` container, `h1` + subtitle + refresh + account-security link — pixel-identical to the old page.
- `compact={true}` (settings tab): no outer padding/max-width, no page title, right-aligned refresh only.

`showAccountSecurityLink` defaults to `true`; the settings tab passes `false` because `LocalMachineCard` already offers that link.

### Settings "Nodes" tab
- `apps/fe/src/pages/SettingsPage.tsx` — added `'nodes'` to `SettingsTab`, tab item `{ label: settings.tabGroup.nodes, icon: Network, testId: 'settings-tab-nodes' }` placed right after `devicesAndFiles`, and `{activeTab === 'nodes' && <NodesTab />}`. No `form` prop, no `SiteSettingsDraft` changes.
- **new** `apps/fe/src/pages/settings/nodes/use-local-status.ts` — `useLocalStatus(api = defaultLocalApi)` on React Query, key `['local-status']` (`LOCAL_STATUS_QUERY_KEY`). Returns `{ status, loading, loginRequired, error, refresh }`; a 401 `LocalApiError` is surfaced as `loginRequired` (and not retried) instead of an error, `refresh()` invalidates the key.
- **new** `apps/fe/src/pages/settings/nodes/local-machine-card.tsx` — `LocalMachineCard`: role badge (`standalone` / `node` / `hub,node`), copyable `hubUrl` / `hubPublicUrl` rows, direct-link row with supported / installed / capable badges + `Switch` calling `LocalApi.setDirect` (spinner while pending, switch disabled when the platform is unsupported or a restart is in flight), toast on failure, and in mesh mode links to `/nodes` and `/account/security`. Login-required and loading states render in place of the body.
- **new** `apps/fe/src/pages/settings/nodes/nodes-tab.tsx` — `NodesTab()` (no props). `useSharedAuthMode()` for the mode, `useLocalStatus()` for the machine; renders `LocalMachineCard` always, then `<HubSetupWizard localStatus={status} />` when not mesh, or `<NodesManagement mode compact showAccountSecurityLink={false} />` when mesh. No HTTPS slot in batch 1 (nothing to render).
- **new** `apps/fe/src/pages/settings/nodes/nodes-tab.test.tsx` — 4 static-render tests: standalone renders card + wizard and no nodes table; unsupported platform disables the direct switch; mesh renders card + nodes table + both links and no page-level account-security link; `loginRequired` shows the hint instead of crashing. `./use-local-status` is replaced with `mock.module` (a *local* module path, so the mock cannot leak into unrelated files) because `src/pages/FilePage.test.tsx` globally replaces `@tanstack/react-query` for the whole `bun test` process.

`setup/hub-setup-wizard.tsx` already existed by the time I type-checked (F2 wrote it, with a compatible `{ localStatus, client?, initialPath?, origin?, hostname?, onRestarted? }` signature), so **no placeholder was created** and nothing under `setup/**` was touched.

### Restart-after-direct-toggle (coordinator's mid-task contract update)
`POST /api/local/direct` now always returns `restartRequired: true`. `LocalMachineCard` therefore shows a restart panel after any successful toggle: the `directRestartRequired` hint plus a **Restart now** button. The poll is implemented inline in the card (per instruction — `setup/use-restart-waiter.ts` is F2's):
1. read `/healthz.startedAt` before restarting;
2. `POST /api/settings/restart`;
3. poll `GET /healthz` every 1 s for up to 60 s;
4. success when `startedAt` differs from the recorded value → invalidate `['local-status']` via `onRefresh`;
5. if the gateway does not expose `startedAt` (older build), fall back to "saw one unreachable probe, then a healthy one";
6. timeout → `restartTimeout` message ("start it manually, then reload").

The panel text switches between `directRestartRequired` / `restarting` / `restartTimeout` and the switch is disabled while waiting. An unmount guard (`useRef`) stops the loop from touching state after the card goes away.

### i18n
Added to all three locale JSONs, then `bun run build:i18n` from the repo root (which regenerated `packages/shared/src/i18n/resources.ts` and `types.ts` — not hand-edited, not linted):
- `settings.tabGroup.nodes`
- `sidebar.nodes`
- `nodes.machine.{title, role, roleStandalone, roleNode, roleHub, hubUrl, hubPublicUrl, direct, directSupported, directUnsupported, directInstalled, directNotInstalled, directCapable, directEnable, directDisable, directRestartRequired, directFailed, restartNow, restarting, restartTimeout, accountSecurity, openNodesPage, loginRequired}`

`restartNow` / `restarting` / `restartTimeout` are the three keys added for the coordinator's restart flow. No `nodes.setup.*` keys were added (F2 owns those). Insertion was done via a JSON round-trip verified byte-identical on the untouched files, so the diff is +27 lines per locale and nothing else.

## How to verify

```bash
cd apps/fe            && bun test src/ && bunx tsc --noEmit -p .
cd packages/api-client && bun test     && bunx tsc --noEmit -p .
cd packages/shared     && bun test     && bunx tsc --noEmit -p .
cd <repo root>         && bunx biome check apps/fe/src/pages/nodes apps/fe/src/pages/settings/nodes packages/api-client/src/local
```

Manual (needs the B1 endpoints): open `/settings` → **Nodes** tab. Standalone shows the machine card + setup wizard; mesh shows the machine card + the full node management body, and the sidebar grows a network icon next to the gear.

## Numbers (before → after)

| package | tests before | tests after | tsc before | tsc after |
|---|---|---|---|---|
| apps/fe (`bun test src/`) | 333 pass / 0 fail | **385 pass / 0 fail** | 0 errors | **0 errors** |
| packages/api-client | 96 pass | **115 pass / 0 fail** | 5 errors | **5 errors** (same pre-existing ones in `client.test.ts`, `files-download.test.ts`) |
| packages/shared | 335 pass | **335 pass / 0 fail** | 0 errors | **0 errors** |

The apps/fe and api-client deltas include F2's tests, which landed in the same worktree while I was working. My own additions: 3 (sidebar-title) + 4 (nodes-tab) fe tests and 8 api-client tests.

`bunx biome check` is clean on every file I touched. Locale JSONs were checked too (clean); generated i18n outputs were not linted.

## Open issues / notes for others

1. **Duplicate restart-poll logic.** `packages/api-client/src/local/setup-api.ts` (F2) already exports `probeHealth` / `readHealthStartedAt`, and `apps/fe/src/pages/settings/nodes/setup/use-restart-waiter.ts` (F2) is a full restart waiter. I implemented the card's poll inline as instructed, so the same ~30 lines now exist twice. After both tasks land, someone owning both files should collapse the card onto `readHealthStartedAt` (or on `useRestartWaiter` if its API allows a non-navigating completion callback). I did not touch F2's files.
2. **`LocalDirectResponse.restartRequired` is still optional** in `packages/api-client/src/local/types.ts` (commander-owned, out of my scope). Given the contract update it is now always present; consider making it required. The card handles both shapes.
3. **`GET /healthz` must actually expose `startedAt`** (contract §healthz). Until the backend ships it, the card falls back to "unreachable then healthy", which is correct but slower to conclude.
4. **`/api/settings/restart` semantics.** The card reuses the existing endpoint and only treats a non-2xx as failure; it does not read `{ success, message }`. If the backend ever returns 200 with `success: false`, that check needs tightening.
5. **`NodesPage` chrome deviation** — see the extraction section above; flagging it explicitly in case the reviewer expects the header in `NodesPage.tsx`.
6. **Global `@tanstack/react-query` mock leak.** `src/pages/FilePage.test.tsx` replaces the module for the whole test process. Any future test that wants to render a real `useQuery` component must either mock the local hook (what `nodes-tab.test.tsx` does) or run in an isolated file set. Worth a shared note; I did not change `FilePage.test.tsx`.
