# F2 — "Connect more devices" side panel + sidebar entry

## What changed

### New — `apps/fe/src/components/side-panels/connect-devices/`

| File | Purpose |
|---|---|
| `connect-devices-panel.tsx` | Replaced the placeholder. Default export; two top-level pill tabs (`connect-tab-mobile` / `connect-tab-computer`), mobile default. Pages are rendered conditionally (not via `TabsContent`) so static SSR tests can assert the active page and the hidden branch costs nothing. |
| `guide-step.tsx` | Local `GuideStep` (numbered marker + title + description + children, same visual language as `remote-access/step-shell.tsx` `WizardStepCard` but with no todo/done state) and `GuideLink` (inline `NavLink` to a settings deep link). Nothing imported from the remote-access folder. |
| `guide-tabs.tsx` | `GuideTabs` — thin wrapper over `@tmex/ui/tabs` `Tabs/TabsList/TabsTrigger` with `pillTabTriggerClassName`; `fullWidth` for the top-level tabs, fit-width for the secondary ones. |
| `command-block.tsx` | `CommandBlock` — monospace block (`bg-muted/50 rounded-lg p-2 text-[11px] break-all font-mono` + `overflow-x-auto`) with an outline copy button. Reuses `useCopyToClipboard` / `CopyLabel` from `apps/fe/src/pages/settings/nodes/copy-feedback.tsx` (2s "copied" state + sr-only live region, labels `nodes.actions.copy` / `nodes.actions.copied`). |
| `mobile-guide.tsx` | `MobileGuide` + exported `MobilePlatformSteps` (for direct rendering in tests). Intro, iOS/Android secondary tabs, 3 steps each; step 1 renders `window.location.origin` in a `CommandBlock` labelled `mobile.addressLabel`; footer = `remoteHint` + `GuideLink` to `/settings?tab=remoteAccess`. |
| `computer-guide.tsx` | `ComputerGuide` + exported `JoinSteps` / `HostSteps`. Step 1 install (`INSTALL_COMMAND` from `@tmex/shared` + `pathHint` + `export PATH="$HOME/.local/bin:$PATH"`), step 2 mode sub-tabs, then the branch steps continuing the numbering from 3. Join: hub / token (link `/settings?tab=nodes`) / run (`join.run.example` in a copyable block) / confirm. Host: entry (link `/settings?tab=remoteAccess`) / hub (amber note `bg-amber-500/10 text-amber-600 dark:text-amber-400`, same as the other warnings in the repo, + link `/settings?tab=nodes`) / invite. |
| `connect-devices-panel.test.tsx` | 5 tests, `react-dom/server` static render. |

### Modified

- `apps/fe/src/components/page-layouts/components/app-sidebar.tsx` — footer now passes two items to `NavMain`: `nav.connectDevices` (icon `CirclePlus`, `url = hrefFor('connect')`, `linkState = SIDE_PANEL_LINK_STATE`, `data-testid="sidebar-connect-devices"`) followed by the existing manage-devices item.
- `apps/fe/src/components/page-layouts/components/nav-main.tsx` — exported `NavMainItem` interface with optional `testId` / `linkState`; `SidebarMenu` becomes `flex-row gap-1 group-data-[collapsible=icon]:flex-col` with `min-w-0 flex-1` items so both buttons render side by side (and stack again if the sidebar is ever made `collapsible="icon"` — it is `offcanvas` today); active highlighting now guarded by `item.url.startsWith('/')` so the relative `?panel=connect` target never lights up as "current page"; `aria-label` added to `SidebarMenuButton` (tooltip was already there). Both entries are the same `SidebarMenuButton`, identical size/style.
- `packages/shared/src/i18n/locales/ja_JP.json` — added the full `connectDevices` block (48 keys, identical key set to zh_CN/en_US). Quoted UI labels use the strings that actually exist in ja_JP (`このマシンをハブにする`, `ハブの公開アドレス`, `参加コードを作成`, `承認`, `マルチノード連携`, `リモートアクセス`); relay is rendered `中継（Hub）`, join token `参加コード`. Regenerated `resources.ts` / `types.ts` via `bun run --filter @tmex/shared build:i18n`.
- `packages/shared/src/i18n/locales/{zh_CN,en_US}.json` — untouched; no missing keys were found in `connectDevices`.

### Out of the literal file scope (flagged)

- Created `apps/fe/src/components/page-layouts/components/app-sidebar-footer.test.tsx` (new). The task asked for a sidebar-footer test but `nav-main.test.ts` is a pure-function `.ts` file with no JSX, so a new `.tsx` test file next to it was the only way to render the footer. It renders `AppSidebar` inside `MemoryRouter → RuntimeProvider → QueryClientProvider → GlobalDeviceProvider → SidebarProvider` and asserts `sidebar-connect-devices`, `href="/?panel=connect"`, `aria-label`, `href="/devices"`, and exactly two `sidebar-menu-button` slots.
- `nav-main.test.ts` was left unchanged (its assertions still hold).

## Testids

`connect-devices-panel`, `connect-tab-mobile`, `connect-tab-computer`, `connect-platform-ios`, `connect-platform-android`, `connect-mode-join`, `connect-mode-host`, `connect-step-ios-{open,add,launch}`, `connect-step-android-{open,add,launch}`, `connect-step-install`, `connect-step-mode`, `connect-step-join-{hub,token,run,confirm}`, `connect-step-host-{entry,hub,invite}`, `command-block-{origin,install,path,join}` (+ `-copy`), `connect-mobile-remote-link`, `connect-join-token-link`, `connect-host-entry-link`, `connect-host-hub-link`, `connect-host-hub-warning`, `sidebar-connect-devices`.

## Verification

- `cd apps/fe && bun test src/components` → **238 pass, 0 fail** (16 files), includes the 5 connect-devices tests and the 2 sidebar-footer tests.
- `cd apps/fe && bun test src/` → **948 pass, 35 fail** (983 tests / 70 files). All 35 failures are in `src/pages/settings/remote-access/remote-access-tab.test.tsx` and `src/pages/settings/remote-access/tunnel-model.test.ts` — another agent's in-flight remote-access refactor, untouched by me. Zero failures in my files.
- `cd apps/fe && bunx tsc --noEmit -p .` → 34 `error TS` lines, **all** under `src/pages/settings/remote-access/` (same in-flight refactor). Filtering that folder out leaves **0 errors**, i.e. nothing from this task.
- `bunx biome check <changed files>` → clean (one formatting fix applied with `--write` during development).
- `bun run --filter @tmex/shared build:i18n` → 3 locales regenerated, exit 0. `connectDevices` key parity verified programmatically: zh_CN 48 / en_US 48 / ja_JP 48, empty diff.
- `bun scripts/complexity/gate.ts` → **2 violations, neither in my files**: `apps/fe/src/pages/settings/remote-access/tunnel-model.ts:187 wizardStepState CC 31 > 27` and `packages/app/src/commands/init.ts:215 runInit CC 19 > 18`. No `scripts/complexity` files were edited.

## Notes

- `window.location.origin` is read through a small guard (`typeof window === 'undefined' ? ''`) so static rendering never throws; under `installWindowStorage()` it resolves to `http://localhost:9663`, which the test asserts.
- The remote-access / nodes links are plain `NavLink`s to `/settings?tab=…` with no `panel` param, so navigating away drops `?panel=connect` and the sheet closes on its own — asserted in the test (`expect(html).not.toContain('panel=connect')` for the panel body).
- `side-panel-host.tsx`, `side-panel-url.ts`, `use-side-panel.ts`, remote-access and devices pages were not touched.

## Follow-up — tab a11y fix (review finding)

**Finding**: `guide-tabs.tsx` closed the Base UI `Tabs` root right after the tab list, so the conditionally rendered content sat outside the root — no `aria-controls` on the tabs, no `tabpanel` / `aria-labelledby` on the content.

**Fix — option (a)**, the smaller of the two: content now lives in `TabsContent` panels inside the same `Tabs` root.

- `guide-tabs.tsx` — `GuideTabs` (which owned the root) replaced by `GuideTabList`, which renders only the `TabsList` + triggers. The root and the panels are now owned by the caller. Net −8 lines.
- `connect-devices-panel.tsx` — the outer `div` is now the `Tabs` root (keeps `data-testid="connect-devices-panel"`), with `TabsContent value="mobile" | "computer"`.
- `mobile-guide.tsx` — `Tabs` root around the platform list + one `TabsContent` per platform.
- `computer-guide.tsx` — the `Tabs` root wraps **both** the step-2 card (which contains the `GuideTabList`) and the branch panels that follow it, so the button row stays inside the numbered card while the branch steps stay outside it as siblings; the relationship is carried by React context, not DOM adjacency. `JoinSteps` / `HostSteps` moved into `TabsContent value="join" | "host"`.

Conditional mounting is preserved: Base UI `Tabs.Panel` defaults to `keepMounted: false`, verified in `@base-ui/react@1.2.0` `tabs/panel/TabsPanel.d.ts` — only the active panel is in the DOM. `aria-controls` / `aria-labelledby` are wired by Base UI from the tab/panel registry (`tabs/tab/TabsTab.js:163`, `tabs/panel/TabsPanel.js:78`), i.e. after mount; the static-render pass therefore shows `role="tablist"` / `role="tab"` + `aria-selected` / `role="tabpanel"` but not yet the id cross-references. That is noted in a comment at the top of the test file.

**New test coverage** (1 new test + assertions on an existing one):
- `一级 / 二级都是真的 tab 组件…` — exactly 2 `tablist`, 4 `tab`, 2 `tabpanel` roles in the default panel render, `aria-selected="true"` present, and the unselected branches (`connect-step-install`, `connect-step-android-add`) absent from the DOM.
- `ComputerGuide` test now also asserts 1 `tablist` + 1 `tabpanel` and that `connect-step-host-entry` is not mounted while the join branch is active.

**Verification after the fix**
- `cd apps/fe && bun test src/components/side-panels` → **22 pass, 0 fail** (3 files).
- `cd apps/fe && bun test src/components` → **239 pass, 0 fail** (16 files).
- `cd apps/fe && bun test src/` → **995 pass, 0 fail** (70 files). The remote-access failures reported in the section above are gone — that agent finished its refactor in the meantime.
- `cd apps/fe && bunx tsc --noEmit -p .` → **0 errors**.
- `bunx biome check apps/fe/src/components/side-panels/connect-devices` → clean (2 formatting fixes applied with `--write`, tests re-run green afterwards).
- `bun scripts/complexity/gate.ts` → 4 violations, **none in my files** (`remote-access-tab.tsx:SelfRemoteAccess`, `packages/panels/src/settings/{webhooks-tab,llm-providers-tab,search-tab}.tsx`) — other agents' in-flight work.

Scope stayed inside `apps/fe/src/components/side-panels/connect-devices/**`; no git operations were run.
