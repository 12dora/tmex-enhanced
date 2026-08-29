# Frontend structure report

Output-file note: this session is read-only and no output path was supplied, so no file was written or modified. The report is provided inline.

## 1. Settings → Nodes

### Settings-page registration and layout

`apps/fe/src/pages/SettingsPage.tsx`

- `SettingsTab` includes `'nodes'` at `:38`.
- The Nodes tab item uses `Network`, label `settings.tabGroup.nodes`, and test id `settings-tab-nodes` at `:70-74`.
- The page wrapper is:

  `mx-auto flex w-full max-w-6xl flex-col gap-4 p-3 pb-[calc(2rem+env(safe-area-inset-bottom))] sm:gap-6 sm:p-5`

  at `:89-93`.
- The tab list uses:

  `w-full gap-1 !justify-start overflow-x-auto rounded-xl border border-border/60 p-1.5 ...`

  at `:94-110`.
- `NodesTab` is mounted only when `activeTab === 'nodes'` at `:113-123`.
- `activeTab` is local React state and defaults to `'general'` at `:40-43`; there is currently no query-string handling.

### Component tree

`apps/fe/src/pages/settings/nodes/nodes-tab.tsx:14-53`

`NodesTab` has no props.

Hooks:

- `useSharedAuthMode()` at `:15`
- `useLocalStatus()` at `:16`

Behavior:

- Until auth mode loads, renders a centered spinner at `:18-23`.
- `mode?.mode !== 'mesh'` is treated as standalone at `:26`.
- Outer Nodes-tab container:

  `flex w-full flex-col gap-4`

  at `:28-29`.
- Always renders `LocalMachineCard` at `:30-36`.
- Standalone renders `HttpsSection showHubUrlHint` plus `HubSetupWizard` at `:40-44`.
- Mesh renders `HttpsSection` plus `NodesManagement mode={mode} compact showAccountSecurityLink={false}` at `:45-49`.

### `LocalMachineCard`

`apps/fe/src/pages/settings/nodes/local-machine-card.tsx`

Props: `:44-53`

```ts
interface LocalMachineCardProps {
  mode: AuthModeResponse | null;
  status: LocalStatusResponse | null;
  loading: boolean;
  loginRequired: boolean;
  api?: DirectApi;
  client?: ApiClient;
  onRefresh: () => void;
}
```

`DirectApi` only requires `setDirect(action): Promise<LocalDirectResponse>` at `:39-42`.

Hooks/state:

- `useTranslation()` at `:203`.
- Mesh detection from `mode?.mode === 'mesh'` at `:204`.
- `restartRequired`, `directError` state at `:205-206`.
- Local direct status overlay state (`applied`, `seen`) at `:210-217`.
- `useRestartGateway(client, callback)` at `:220-224`.
- `useDirectMutations(api, callbacks)` at `:226-238`.
- `DirectMutationController` serializes install/remove/enable/disable operations at `:96-157`; React binding uses `useMemo`, `useRef`, and `useSyncExternalStore` at `:167-191`.

Visual structure:

- `<Card>` with `<CardHeader><CardTitle>` at `:242-247`.
- Content class: `flex flex-col gap-3`.
- Rows use `flex flex-wrap items-center gap-2`; labels have `w-32 shrink-0` at `:495-502`.
- Mesh-only links to `/nodes` and `/account/security` at `:317-333`.

Direct i18n keys:

- `nodes.machine.title`
- `nodes.machine.loginRequired`
- `nodes.machine.role`
- `nodes.machine.roleStandalone`
- `nodes.machine.roleNode`
- `nodes.machine.roleHub`
- `nodes.machine.hubUrl`
- `nodes.machine.hubPublicUrl`
- `nodes.machine.direct`
- `nodes.machine.directSupported`
- `nodes.machine.directInstalledVersion`
- `nodes.machine.directInstalled`
- `nodes.machine.directNotInstalled`
- `nodes.machine.directActive`
- `nodes.machine.directDisabled`
- `nodes.machine.directUnsupported`
- `nodes.machine.directInstall`
- `nodes.machine.directRemove`
- `nodes.machine.directSwitch`
- `nodes.machine.directSwitchHint`
- `nodes.machine.directRestartRequired`
- `nodes.machine.restartNow`
- `nodes.machine.restarting`
- `nodes.machine.restartTimeout`
- `nodes.machine.directFailed`
- `nodes.machine.directErrorUnsupported`
- `nodes.machine.directErrorDownloadFailed`
- `nodes.machine.directErrorNotInstalled`
- `nodes.machine.directErrorDetail`
- `nodes.machine.directRemoveConfirm.title`
- `nodes.machine.directRemoveConfirm.description`
- `nodes.machine.directRemoveConfirm.cancel`
- `nodes.machine.directRemoveConfirm.confirm`
- `nodes.machine.openNodesPage`
- `nodes.machine.accountSecurity`
- `nodes.actions.copy`
- `nodes.actions.copied`

### `HttpsSection`

`apps/fe/src/pages/settings/nodes/https/https-section.tsx:41-141`

Props:

```ts
interface HttpsSectionProps {
  api?: TlsApi;
  client?: ApiClient;
  hostname?: string | null;
  showHubUrlHint?: boolean;
}
```

Hooks/state:

- `useTranslation()` at `:62`.
- `useTlsStatus(api)` at `:63`; query state is defined in `use-tls-status.ts:14-64`.
- `draftMode` state at `:64`.
- `useRestartGateway(client, tls.refresh)` at `:65`.
- `useTlsMutations(...)` at `:68-77`; mutation state is `pending`/`confirming`, implemented with `useMemo`, `useRef`, and `useSyncExternalStore` in `tls-mutations.ts:12-166`.

Visual structure:

- Bare `<Card>` at `:121-141`; unlike the standard settings cards, it does not currently specify `border-0 ring-0`.
- Header title/description at `:123-126`.
- Content class: `space-y-3` at `:127`.
- Mode-dependent body is assembled by `HttpsBody` at `:199-313`.
- `StatusHeader` shows listener/certificate state at `:315-372`.
- Saving `none`/`external` while the listener is active opens `StopListenerConfirm` at `:149-197`.

Subcomponents:

- `ModeChooser`, props `selected`, `active`, `disabled`, `onSelect`, at `mode-chooser.tsx:15-27`.
  - Layout: `grid gap-3 sm:grid-cols-2` at `:30-35`.
- `ExternalPanel`, props `status`, `busy`, `savePending`, `onSave(trustProxy)`, at `external-panel.tsx:13-24`.
- `SelfSignedPanel`, props and draft at `selfsigned-panel.tsx:16-48`; local draft state at `:49-55`.
- `AcmePanel`, props and draft at `acme-panel.tsx:27-78`; local draft/errors at `:79-120`.
- `SansEditor`, props `sans`, `disabled`, `error`, `onChange`, at `sans-editor.tsx:11-20`; local input state at `:22-30`.
- Shared `Field`, `InfoRow`, `ListenerFields`, and `CopyableCode` are in `https/parts.tsx:25-172`.

HTTPS i18n keys:

- Core: `nodes.https.title`, `.description`, `.hubUrlHint`, `.currentMode`, `.modeActive`, `.save`, `.saved`, `.renewStarted`, `.loginRequired`, `.loadFailed`, `.restartRequired`, `.restartNow`, `.restarting`, `.restartTimeout`.
- Modes: `nodes.https.mode.none|external|selfsigned|acme.title|description`; `nodes.https.mode.none.detail`.
- Confirmation: `nodes.https.confirmStop.title|description|requirement|confirm|cancel`.
- Listener: `nodes.https.listener.running|stopped|failed`.
- Certificate: `nodes.https.certificate.subject|sans|issuer|validUntil|daysLeft|expired|none`.
- External: `nodes.https.external.intro|trustProxy|trustProxyHint|trustProxyDetail`.
- Private CA: `nodes.https.selfsigned.intro|sans|sansHint|sansPlaceholder|sansAdd|sansRemove|sansEmpty|trustWarning|fingerprint|downloadCa|renew`.
- CA guide: `nodes.https.selfsigned.guide.title|intro|{platform}.title|{platform}.steps`.
- ACME: `nodes.https.acme.intro|domain|domainHint|email|emailHint|challenge|challengeHttp|challengeHttpHint|challengeDns|challengeDnsHint|cloudflareToken|cloudflareTokenHint|cloudflareTokenStored|staging|stagingHint|statusLabel|status.{idle|pending|ok|error}|pendingHint|lastAttempt|nextRenew|renewNow|hints.http01|hints.http01Linux|hints.dns01`.
- Validation: `nodes.https.validation.sansRequired|sansInvalid|sansTooMany|portInvalid|hostRequired|domainInvalid|emailInvalid|tokenRequired`.
- Backend error mapping: `nodes.https.errors.invalid_sans|invalid_domain|invalid_email|cloudflare_token_required|invalid_port|port_in_use|tls_failed|not_applicable|no_ca|unauthorized|unknown`, generated by `tls-errors.ts:5-33`.
- Shared copy buttons: `nodes.actions.copy`, `nodes.actions.copied`.

Source anchors: `packages/shared/src/i18n/locales/en_US.json:1184-1341`.

### `HubSetupWizard`

`apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.tsx:15-100`

Props:

```ts
interface HubSetupWizardProps {
  localStatus: LocalStatusResponse | null;
  client?: ApiClient;
  initialPath?: 'become-hub' | 'join-hub' | null;
  origin?: string | null;
  hostname?: string | null;
  onRestarted?: () => void;
}
```

Hooks/state:

- `useTranslation()` at `:35`.
- `path` state at `:36`.
- Null status renders loading at `:38-43`.
- Non-standalone status returns `null` at `:46-47`.
- Outer class: `space-y-4` at `:49-50`.
- Intro card uses `border-0 ring-0` at `:51-81`.
- Path cards use `ring-1`, selected `bg-primary/5 ring-primary`, otherwise `bg-card ring-foreground/10` at `:118-138`.
- `PathCard` props are `testId`, `icon`, `title`, `description`, `selected`, `onSelect` at `:103-117`.

Child forms:

- `BecomeHubForm`: props at `become-hub-form.tsx:45-52`; state at `:64-76` includes form values, validation visibility, precheck, submitting, error, result; restart waiter via `useRestartWaiter`.
- `JoinHubForm`: props at `join-hub-form.tsx:29-35`; state at `:49-60` includes form values, validation visibility, submitting, error, result, restart waiter.
- Both result and form cards use `border-0 ring-0`; forms use `space-y-6` (`become-hub-form.tsx:123-259`, `join-hub-form.tsx:93-206`).
- Shared form components: `SetupNotice`, `FormField`, `SwitchRow`, `ResultRow`, `RestartPanel` at `setup/form-parts.tsx:25-160`.

Wizard i18n keys:

- `common.loading`.
- `nodes.setup.title`, `.intro`, `.introDetail`.
- `nodes.setup.path.becomeHub.title|description`.
- `nodes.setup.path.joinHub.title|description`.
- Form titles/descriptions: `nodes.setup.becomeHub.*`, `nodes.setup.joinHub.*`.
- Fields: `nodes.setup.fields.hubPublicUrl|hubPublicUrlHint|username|usernameHint|password|passwordHint|confirmPassword|hubUrl|hubUrlHint|token|tokenHint|tokenPlaceholder|name|nameHint|directEnable|directEnableHint|directUnsupportedHint|insecureLocal|insecureLocalHint`.
- Precheck: `nodes.setup.precheck.button|reachableSelf|reachableOther|unreachable|httpsHint`.
- Submit: `nodes.setup.submit.becomeHub|joinHub|pending`.
- Result: `nodes.setup.result.title|becomeHubDescription|joinDescription|fingerprint|hubPublicUrl|hubUrl|username|directLabel|direct.enabled|direct.skipped|direct.failed`.
- Restart: `nodes.setup.restart.waiting|restarted|timeout`.
- Toasts: `nodes.setup.toast.hubCreated|joined`.
- Errors: `nodes.setup.errors.not_standalone|invalid_url|insecure_local_required|invalid_username|weak_password|password_mismatch|invalid_name|user_exists|invalid_token|node_revoked|node_exists|hub_unreachable|join_failed|env_write_failed|direct_unsupported|direct_download_failed|direct_failed|withDetail|unknown`.

Source anchors: `packages/shared/src/i18n/locales/en_US.json:1417-1517`; validation-generated keys are defined in `setup/validation.ts:21-165`.

### `NodesManagement`

`apps/fe/src/pages/nodes/nodes-management.tsx:30-200`

Props at `:30-37`:

```ts
interface NodesManagementProps {
  mode: AuthModeResponse;
  api?: AuthApi;
  showAccountSecurityLink?: boolean; // default true
  compact?: boolean;                 // default false
}
```

Hooks/state:

- `useTranslation()` at `:45`.
- `useMeshNodes()` at `:46`.
- Sets global entry node id via `setEntryNodeId` in an effect at `:49-51`.
- `useHubNode(...)` at `:53`.
- Merges mesh membership and hub heartbeat rows with `mergeNodes` at `:54-57`.
- Pending enrollments use `useSyncExternalStore` at `:59-63`.
- Credential availability/mode resolution at `:65-68`.
- `usePasskeys` and `useCredentialPrompt` at `:71-77`.
- Refresh callback at `:79-82`.
- Expired enrollment ids state at `:84`.
- `useAdmitAction` at `:84-85`.
- `useEnrollmentWatch` at `:87-91`.
- Timed pending-enrollment sweep at `:95-105`.

Layout:

- Missing credentials: compact text or `mx-auto w-full max-w-5xl p-5` at `:107-119`.
- Normal outer layout: `mx-auto flex w-full max-w-5xl flex-col gap-4 p-3 sm:p-5`.
- Compact outer layout: `flex w-full flex-col gap-4` at `:121-127`.
- Noncompact header contains title/subtitle; compact header only keeps right-side actions at `:129-163`.
- Hub-offline notice: rounded destructive notice at `:165-173`.
- Child order: `EnrollmentSection`, `NodesTable`, credential dialog at `:175-198`.

Direct keys: `nodes.title`, `nodes.subtitle`, `nodes.actions.refresh`, `nodes.actions.accountSecurity`, `nodes.hubOffline`, `auth.errors.UNKNOWN_USER`.

### `EnrollmentSection`

`apps/fe/src/pages/nodes/enrollment-section.tsx:26-212`

Props at `:26-48`:

```ts
{
  api: AuthApi;
  mode: ResolvedMode;
  hubApi: HubApi | null;
  hubOnline: boolean;
  prompt: CredentialPromptHandle;
  pendings: PendingEnrollment[];
  onConfirm: (pending: PendingEnrollment) => void;
  busyPendingId: string | null;
  hubUnconfirmedIds: string[];
  clearedIds: string[];
}
```

Hooks/state:

- `useTranslation()` at `:50`.
- `open`, `name`, `busy`, `error`, `created` state at `:51-56`.
- Clears displayed join information when `clearedIds` changes at `:58-60`.
- `submit` callback performs credential prompt, key-log read, enrollment creation, and error handling at `:64-105`.
- Outer section class: `flex flex-col gap-3 rounded-xl border border-border bg-background p-4` at `:107-110`.
- Pending rows use `rounded-lg bg-muted/50 px-2 py-1.5 text-xs` at `:174-208`.

Keys:

- `nodes.hubOffline`
- `nodes.enrollment.title|description|nameLabel|create|joinHint|joinCommand|joinToken|missingHubUrl|hubNotConfirmed|pending|retryHub|confirmPending`
- `nodes.actions.addNode|copy|copied`
- Dynamic `auth.errors.${code}`.

`CopyableCode` is exported at `:227-267`, with local `copied` state and clipboard callback.

### `NodesTable`

`apps/fe/src/pages/nodes/nodes-table.tsx:21-286`

Props at `:21-37`:

```ts
{
  rows: NodeRow[];
  hubApi: HubApi | null;
  hubOnline: boolean;
  mode: ResolvedMode;
  api: AuthApi;
  prompt: CredentialPromptHandle;
  onChanged: () => void;
}
```

Layout:

- Horizontal-scroll wrapper: `overflow-x-auto rounded-xl border border-border bg-background` at `:40`.
- Table class: `w-full min-w-[52rem] text-xs` at `:41`.
- Nine columns: name, status, reach, version, last seen, direct, login, fingerprint, actions at `:44-52`.
- Empty state at `:68-73`.
- `NodeRowView` local state: `renaming`, `nameDraft`, `busy` at `:111-114`.
- Rename callback at `:116-129`.
- Revoke callback, credential signing, hub acknowledgement, and error mapping at `:140-199`.

Keys:

- `nodes.columns.name|status|reach|version|lastSeen|direct|login|fingerprint|actions`
- `nodes.empty`
- `nodes.rename.save|done`
- `nodes.revoke.confirmText|reasonPrompt|done|hubFailed|selfBlocked`
- `nodes.self|hub|status.online|status.offline|reach.lan|reach.relay|loggedIn|hubOffline`
- `common.yes|no`
- Dynamic `auth.errors.${code}`
- `nodes.enrollment.staleRecord`

`NodeLoginButton` used by the login column has props at `apps/fe/src/auth/NodeLoginButton.tsx:11-17` and keys `auth.node.loginToThisNode|loggingIn|retryLogin` at `:57-63`.

### Locale source and build

The browser namespace is a single namespace: `translation`.

Source files:

- `packages/shared/src/i18n/locales/manifest.json:2-25`
- `packages/shared/src/i18n/locales/en_US.json`
- `packages/shared/src/i18n/locales/zh_CN.json`
- `packages/shared/src/i18n/locales/ja_JP.json`

Each locale JSON has the top-level `"translation"` object. Nodes keys are in `en_US.json:1137-1517`, device-page node-status keys at `:1520-1533`, common keys at `:3-40`, settings keys at `:168-215`, sidebar keys at `:673-698`, and auth keys at `:1033-1060`.

`apps/fe/src/i18n/index.ts:10-13` loads these JSON files directly with Vite `import.meta.glob`; it does not load generated `resources.ts`.

Generated files:

- `packages/shared/src/i18n/resources.ts`
- `packages/shared/src/i18n/types.ts`

Build script:

- `packages/shared/scripts/build-i18n.ts:19-20` reads `src/i18n/locales` and writes generated output.
- JSON loading and generation: `:38-69`.
- Root command: `package.json:12`, `bun run build:i18n`.
- Package command: `packages/shared/package.json:17`, `bun scripts/build-i18n.ts`.

## 2. Standalone `/nodes` page

### Registration

`apps/fe/src/main.tsx`

- Lazy module: `nodesModule` at `:189-196`.
- `pageRoutes()` contains `devices`, device detail, `settings`, and `file`, but no child `nodes` route at `:207-234`.
- Top-level route:

  ```tsx
  { path: '/nodes', element: <PageWrapper moduleLoader={nodesModule} withSidebar={false} /> }
  ```

  at `:237-255`, specifically `:244`.
- `withSidebar={false}` means the page is outside `NodeShell`/`SidebarProvider`.

`apps/fe/src/page-wrapper.tsx:1-3` explicitly documents `/nodes` as a no-sidebar page. The top bar renders `Brand` instead of `SidebarTrigger` at `:29-50`.

### Page implementation and tests

`apps/fe/src/pages/NodesPage.tsx`

- `NodesPageProps` at `:14-17`: optional `mode` and `api`.
- Fetches auth mode through `useAuthMode` at `:19-21`.
- Loading spinner at `:23-28`.
- Standalone/`mode === 'none'` returns `null` at `:30-31`.
- Mesh renders `<NodesManagement mode={mode} api={api} />` at `:33`.
- Page title uses `nodes.title` at `:36-39`.
- Exported `nodesRoute` points to `/nodes` at `:42-45`.

`apps/fe/src/pages/NodesPage.test.tsx:62-116` covers:

- Standalone empty render: `:63-65`
- Mesh table/order/login/fingerprint/account-security: `:67-94`
- Hub offline action disabling: `:96-110`
- Missing credentials hiding the table: `:112-115`

### Sidebar link

`apps/fe/src/components/page-layouts/components/sidebar-title.tsx:45-54`

- Mesh-only `NavLink`
- `Network` icon
- `data-testid="sidebar-nodes"`
- Current target: `/nodes`

Tests assert this target at `sidebar-title.test.tsx:60-64`.

The local settings card also links to `/nodes` at `apps/fe/src/pages/settings/nodes/local-machine-card.tsx:317-325`; its test expects the link at `nodes-tab.test.tsx:140-154`.

### Deep links

- `packages/app/src/runtime/assemble.test.ts:361-371` treats `/login`, `/nodes`, and `/n/abcd/devices/1` as SPA deep links.
- `packages/app/src/runtime/serve-frontend.ts:45-81` falls back to `index.html` for extensionless paths.
- Remote device links use `/n/<nodeId>/...`; `nodeAppPath` is implemented in `packages/api-client/src/node-url.ts:165-170`.
- There is no `/n/:nodeId/nodes` frontend child route.

### Removal/redirect worklist

To remove the standalone page while preserving old bookmarks:

1. `apps/fe/src/main.tsx`
   - Remove `nodesModule`.
   - Replace the `/nodes` page route with a compatibility redirect to `/settings?tab=nodes`.
   - Keep the route so `/nodes` deep links do not become router 404s.
   - Use `/n/<nodeId>/settings?tab=nodes` for links created inside a remote `NavLink` context; `NavLink` automatically prefixes absolute paths via `hostAppPath` at `nav-link.tsx:10-25`.

2. `apps/fe/src/pages/SettingsPage.tsx`
   - Parse `tab` from `useSearchParams`.
   - Initialize or synchronize `activeTab` with `tab=nodes`.
   - Current state defaults to `general` at `:40-43`, so a redirect alone will not select Nodes.

3. `apps/fe/src/components/page-layouts/components/sidebar-title.tsx`
   - Change the Network link target from `/nodes` to `/settings?tab=nodes` at `:45-54`.
   - Update `sidebar-title.test.tsx:60-64`.

4. `apps/fe/src/pages/settings/nodes/local-machine-card.tsx`
   - Change or remove the self-link at `:317-325`.
   - Update `nodes-tab.test.tsx:140-154`.
   - If the link is removed, remove `nodes.machine.openNodesPage` from all three locale JSON files and run `bun run build:i18n`.

5. `apps/fe/src/pages/NodesPage.tsx` and `NodesPage.test.tsx`
   - Delete if no direct page compatibility component is retained.
   - Move any still-useful pure behavior coverage to `NodesManagement`/NodesTab tests.

6. `apps/fe/src/page-wrapper.tsx`, `page-wrapper.test.tsx`, and `components/brand.tsx`
   - Update comments that describe `/nodes` as a no-sidebar page.
   - Runtime behavior only changes if the compatibility redirect is implemented as a no-sidebar route.

7. `packages/app/src/runtime/assemble.test.ts`
   - Keep the `/nodes` SPA deep-link test if compatibility redirect remains.
   - No serving-layer change is required.

## 3. Manage devices page

### Page composition

`apps/fe/src/pages/DevicesPage.tsx`

- `DevicesPage` calls `useSharedAuthMode()` at `:32-34`.
- Loading state: `:35-40`.
- Standalone/single-node path renders one `<DeviceManagementPanel />` at `:42-44`.
- Mesh path renders `MeshDevices` at `:45`.
- `MeshDevices` converts mesh nodes with `toNodeDeviceGroups` at `:11-14`.
- If mesh nodes have not loaded, it temporarily renders one self panel at `:15-18`.
- Mesh group wrapper:

  `mx-auto flex w-full max-w-6xl flex-col gap-6 p-3 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-5`

  at `:20-28`.
- Page title is `sidebar.manageDevices` at `:48-52`.
- Global page action is `DeviceManagementActions` at `:54-56`.

There are no device tabs on this page. The structure is node sections containing a device-card grid.

### Node groups

`apps/fe/src/pages/devices/node-device-group.tsx`

`NodeDeviceGroupEntry` at `:24-36`:

```ts
{
  id;
  runtimeNodeId;
  name;
  online;
  loggedIn;
  isSelf;
  isHub;
  version;
  inventory;
}
```

States:

- `offline`
- `signedOut`
- `ready`

State calculation is `nodeDeviceGroupState` at `:38-44`.

`toNodeDeviceGroups` at `:47-70`:

- Maps every `MeshNode`.
- Maps the current entry node to runtime id `self`.
- Forces self to `loggedIn: true`.
- Sorts self first, then names with `localeCompare`.

Group layout:

- Header class: `flex items-center gap-2` at `:96-130`.
- Group section: `flex flex-col gap-2` at `:199-205`.
- Offline inventory card: `rounded-lg border border-border/60 bg-muted/30 p-3` at `:134-164`.
- Signed-out card: `flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-muted/30 p-3` at `:167-178`.
- Ready groups mount `NodeRuntimeScope` and `DeviceManagementPanel` at `:208-217`.
- Ready panel overrides nested panel sizing with:

  `max-w-none p-0 pb-0 sm:p-0`

  at `:211-216`.

### Add-device buttons

There are two distinct add buttons:

1. Global top-right button

   `DeviceManagementActions` at `packages/panels/src/device-management/device-management-actions.tsx:21-37`.

   - `Plus` icon.
   - `variant="ghost"`, `size="icon-sm"`.
   - Test id: `devices-add`.
   - Dispatches `OPEN_ADD_DEVICE_EVENT` at `:13-19` unless an explicit callback is supplied.

2. Per-ready-node button

   `NodeDeviceGroup` creates one at `node-device-group.tsx:185-197`.

   - Only exists for `ready` groups.
   - `variant="ghost"`, `size="icon-sm"`.
   - Test id: `devices-node-add-${runtimeNodeId}`.
   - Calls `panelRef.current?.openAddDevice()` at `:191`.
   - Each panel listens to the global event only when `node.isSelf` at `:211-215`, preventing one global click from opening every remote modal.

### Device management panel and cards

`packages/panels/src/device-management/device-management-panel.tsx`

Props at `:53-60`:

```ts
{
  devicesQueryKey?: readonly unknown[];
  listenOpenAddDeviceEvent?: boolean; // default true
  className?: string;
  ref?: Ref<DeviceManagementPanelHandle>;
}
```

Behavior:

- `openAddDevice()` is exposed through `useImperativeHandle` at `:76`.
- Reads devices through `fetchDevices(runtime.apiClient)` at `:83-87`.
- Hydrates tmux errors through `useTmuxStore` at `:89-100`.
- Deletes with `deleteDeviceApi` and invalidates the query at `:102-111`.
- Sorts by `sortOrder`, then localized name at `:113-121`.
- Outer panel class:

  `mx-auto flex w-full max-w-6xl flex-col gap-3 p-3 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:gap-4 sm:p-5`

  at `:123-130`.
- Empty state uses `py-14` at `:143-162`.
- Nonempty card grid:

  `grid gap-3 lg:grid-cols-2`

  at `:163-174`.
- Create/edit modal mounting: `:176-190`.
- Delete confirmation: `:192-221`.

`packages/panels/src/device-management/device-card.tsx`

- Props: `device`, `onEdit`, `onDelete` at `:25-29`.
- Card class: `overflow-hidden border-border/50` at `:52-58`.
- Header uses `space-y-2 pb-2` at `:59`.
- Icon box: `h-8 w-8`.
- Title: `line-clamp-1 text-sm`.
- Description: `line-clamp-1 text-xs`.
- Badges use `text-[11px] font-normal` at `:117-127`.
- Content starts at `:130`; action row uses `flex items-center justify-end`.

The card’s SSH “Test” menu calls `testDeviceConnection` at `:42-50`.

### Connect behavior

The manage-page “Connect” button is not a click handler. It is a route link:

```tsx
<Link
  to={hostAppPath(runtime.host, `/devices/${device.id}`)}
  ...
>
  {t('device.connect')}
</Link>
```

at `device-card.tsx:130-139`.

For remote groups, `NodeConnectionManager` injects `host.appPath` with `/n/<nodeId>` at `packages/stores/src/node-connection-manager.ts:161-175`; `hostAppPath` itself is at `packages/stores/src/runtime.ts:342-344`.

After navigation:

- `DevicePage` reads route params and renders `DeviceConsole` at `apps/fe/src/pages/DevicePage.tsx:20-30`.
- `GlobalDeviceProvider` detects the current device route at `global-device-provider.tsx:55-61`.
- `useRouteDeviceSubscription` auto-connects the current device at `:140-155`.
- The lower-level tmux store sends `{type:'connect-device', deviceId}` at `packages/stores/src/tmux.ts:154-167`.

The sidebar power button is a separate path:

- `DeviceConnectionControl` invokes `onConnect`/`onDisconnect` at `device-connection-control.tsx:67-82`.
- `DeviceRowHeader` maps connect to `onExpandedChange(deviceId, true)` and disconnect to `connection.disconnect` plus collapse at `device-row-header.tsx:52-60`.
- `SidebarDeviceList` then calls `connection.connect(deviceId)` at `sidebar-device-list.tsx:158-170`.

## 4. Sidebar device list

### Node selection and rendering

`apps/fe/src/components/page-layouts/components/app-sidebar.tsx`

- Sidebar tabs are `panes`, `agent`, and `files` at `:35-66`.
- Device list mounts only for the Panes tab at `:68-79`.
- The main navigation has Manage Devices at `/devices` at `:17-23`.

`apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx`

- Standalone/non-mesh renders one `SideBarDeviceListForRuntime` at `:48-53`.
- Mesh uses `useMeshNodes()` and maps all nodes with `toSidebarEntries` at `:10-28`.
- If mesh data is empty, it temporarily renders the self runtime list at `:34-37`.
- Otherwise it renders every node section at `:39-44`.

`SidebarNodeEntry` is defined at `sidebar-node-section.tsx:21-31`.

Node behavior:

- Offline node: renders last-known inventory only; no runtime or request, at `:122-145`.
- Online but not logged in: renders collapsed sign-in UI at `:148-150`; `useNodeLoginGate` is enabled only after expansion at `:74-77`.
- Online and logged in: mounts `NodeRuntimeScope` and the real device tree at `:152-165`.

Self handling:

- `toSidebarEntries` maps the current entry node to runtime id `self` at `sidebar-device-list.tsx:15-20`.
- Self is forced `loggedIn: true` at `:22-23`.
- Remote runtime expansion keys are `${runtimeNodeId}:${deviceId}` at `sidebar-node-section.tsx:156-162`.

Thus the current default is:

- Self devices: all devices returned by `/api/devices`.
- Online/logged-in remote node devices: all devices returned by that node’s `/n/<nodeId>/api/devices`.
- Offline remote devices: all devices in the node’s last-known `inventory.devices`.
- Online/unlogged remote nodes: no device list until the user expands/signs in.

### Device-tree selection and expansion

`packages/panels/src/device-tree/sidebar-device-list.tsx`

Props at `:32-47`:

```ts
{
  ensureDeviceSubscribed;
  expansionKeyFor?;
  devicesQueryKey?;
  agent?;
  nodeBadge?;
  emptyLabel?;
  connection?;
}
```

Stores/hooks:

- `useRuntime()` at `:59-64`.
- `useUIStore` for `sidebarDeviceExpanded` and its setter at `:66-67`.
- `useDeviceTreeSelection()` at `:69`.
- `useTmuxStore` for window closing at `:71`.
- `useSiteStore` for localized sorting at `:72`.
- Device query uses `fetchDevices(runtime.apiClient)` at `:74-79`.
- Reorder mutation calls `reorderDevices` at `:123-150`.

Default visibility/connection behavior:

- `sidebarDeviceExpanded[key] !== false` means expanded at `:232`.
- All devices whose expansion state is not explicitly false are subscribed at `:192-198`.
- The selected device is auto-expanded/subscribed at `:172-190`.
- The rendered list is every `sortedDevices` entry at `:219-250`.
- Collapse only hides the tree; it does not disconnect. The code explicitly says disconnect requires the Power button at `:158-167`.

### Existing persistence

`packages/stores/src/ui.ts`

`UIState` includes only:

```ts
sidebarCollapsed
sidebarTab
sidebarDeviceExpanded
```

at `:76-107`.

- Store key: `${storagePrefix}tmex-ui` at `:109-110`.
- Default `sidebarDeviceExpanded: {}` at `:115-117`.
- Setter: `setSidebarDeviceExpanded(deviceId, expanded)` at `:131-134`.
- Persisted fields include `sidebarCollapsed` and `sidebarDeviceExpanded` at `:182-198`.
- `sidebarTab` is deliberately not persisted at `:184`.
- Tests verify expansion persistence across store instances at `packages/stores/src/ui.test.ts:77-90`.

There is no existing `showInSidebar`, `visible`, or `inSidebar` field anywhere in the frontend, stores, shared Device contract, database, or API.

### Device contract/API/schema

`packages/shared/src/contracts/devices.ts:6-24`

`Device` contains identity, connection/auth fields, `defaultWorkingDir`, `sortOrder`, timestamps. There is no visibility field.

Create/update requests at `:34-61` also have no visibility field.

`apps/gateway/src/db/schema.ts:97-124`

The `devices` table has no visibility column. `sortOrder` is the only UI-order field at `:112-115`.

`apps/gateway/src/db/devices.ts`

- Create and default ordering: `:50-92`.
- List ordering: `:104-113`.
- Reorder: `:115-123`.
- Update mapping: `:125-166`.

`apps/gateway/src/api/device-routes.ts:167-194`

Available routes are:

- `GET /api/devices`
- `POST /api/devices`
- `PUT /api/devices/order`
- `GET /api/devices/:id`
- `PATCH /api/devices/:id`
- `DELETE /api/devices/:id`
- `POST /api/devices/:id/test-connection`

No sidebar-visibility endpoint exists.

### Minimal proposed model

Recommended: browser-local visibility, not server/user persistence.

Add an explicit UI-store map, for example:

```ts
sidebarDeviceVisibility: Record<string, boolean>
setSidebarDeviceVisibility(key: string, visible: boolean): void
```

Use a composite key:

```ts
`${runtimeNodeId}:${deviceId}`
```

because device ids are only unique within a node and all node runtimes share the UI store.

Default rule:

- Self device with no stored override: visible.
- Remote device with no stored override: hidden.
- Stored `true`: show remote device.
- Stored `false`: hide any device.

Relevant implementation locations:

- `packages/stores/src/ui.ts:76-198` — state, setter, persistence, merge.
- `packages/panels/src/device-tree/sidebar-device-list.tsx:155-250` — filter devices before sorting/subscription/rendering.
- `apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:152-165` — pass node identity/predicate into the runtime list.
- `apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx:12-36` — forward the visibility predicate.
- `packages/panels/src/device-management/device-management-panel.tsx:62-174` and `device-card.tsx:25-143` — render the user-toggleable “show in sidebar” control.
- `apps/fe/src/pages/devices/node-device-group.tsx:208-217` — ensure the remote node identity is available to the management panel.

This matches existing browser-local UI preferences:

- UI preferences use Zustand persistence under `tmex-ui` (`ui.ts:109-198`).
- Device connection intent is also browser-local via localStorage (`device-connection-persistence.ts:12-59`), though it uses per-runtime keys.
- `NodeConnectionManager` intentionally shares one host-level UI store across nodes at `node-connection-manager.ts:128-131`; composite keys are therefore required.

A per-user/server model would require adding a field to the Device contract, SQLite schema, mapper, create/update routes, API client, and likely an ownership model. The current `devices` table has no user foreign key, so it is not a minimal change.

## 5. i18n language switching

### Initialization and active-language selection

`apps/fe/src/i18n/index.ts:1-55`

- Uses the singleton `i18next`.
- Loads locale JSON dynamically through `resourcesToBackend` at `:29-39`.
- `navigator.language` is mapped as follows at `:20-26`:
  - `zh*` → `zh_CN`
  - `ja*` → `ja_JP`
  - everything else → `DEFAULT_LOCALE`
- Initialization uses:

  ```ts
  lng: detectBrowserLocale(),
  fallbackLng: DEFAULT_LOCALE,
  ns: ['translation'],
  defaultNS: 'translation',
  useSuspense: false
  ```

  at `:40-52`.
- `main.tsx` waits for `i18nReady` before first render at `:279-289`.

There is no i18next browser-detector plugin and no language localStorage key in the frontend.

### Site settings language

`packages/shared/src/contracts/site-settings.ts:7-23`

`SiteSettings.language` is a `LocaleCode`.

`apps/gateway/src/db/schema.ts:40-71`

- `site_settings.language` is persisted in the singleton site-settings row.
- Database default: `'en_US'` at `:60`.

`apps/gateway/src/config.ts:177`

- Server initialization default is controlled by `TMEX_DEFAULT_LANGUAGE`, fallback `'en_US'`.

`apps/fe/src/pages/settings/use-site-settings-form.ts`

- Reads `/api/settings/site` at `:35-44`.
- Saves `/api/settings/site` at `:55-68`.
- After save, explicitly calls `i18n.changeLanguage(draft.language)` at `:75-78`.

`packages/stores/src/site.ts`

- `DEFAULT_SETTINGS.language` is `DEFAULT_LOCALE` at `:32-47`.
- `commitSettings` updates the store and globally changes i18next at `:107-112`:

  ```ts
  set({ settings, loading: false });
  void i18next.changeLanguage(settings.language);
  ```
- `fetchSettings` loads `/api/settings/site` through the current runtime API client at `:119-142`.
- `refreshSettings` does the same at `:144-161`.
- A site-settings event also triggers refresh at `:190-198`.

The backend has a separate i18next singleton initialized to English at `apps/gateway/src/i18n/index.ts:1-13`; backend site-settings reads/updates also call `changeLanguage` at `apps/gateway/src/db/site-settings.ts:38-58` and `:68-118`.

### Runtime creation/remount behavior

`packages/stores/src/app-runtime.ts:23-45`

`createAppRuntime` only creates the UI, site, tmux, agent, and file-tree stores. It does not call `i18next.init` or `changeLanguage`.

`packages/stores/src/node-connection-manager.ts`

- Creates a separate runtime/API client per node at `:154-181`.
- Remote API base URLs are `/n/<nodeId>` at `:159-170`.
- All node runtimes share the same browser UI store at `:128-131`.

`packages/stores/src/react.tsx:19-55`

- `RuntimeProvider` uses a runtime-specific fragment key.
- Changing runtime remounts the child subtree.
- It does not initialize or change i18next.

`apps/fe/src/node/node-runtime-boundary.tsx:28-47`

- Creates/gets the current node runtime.
- Calls `useNodeLoginGate`.
- Mounts `RuntimeProvider`, `QueryClientProvider`, and `GlobalDeviceProvider`.
- No i18n operation.

`apps/fe/src/auth/use-node-login.ts:52-113`

- `useNodeLoginGate` only calls `ensureAuthMode`, `refreshMeshNodes`, and `ensureNodeLogin`.
- No `changeLanguage`, `fetchSettings`, or i18n initialization.

`apps/fe/src/node/node-runtime-scope.tsx:18-25`

- Mounts a runtime for an aggregate remote-node section.
- No i18n operation.

The only production frontend `changeLanguage` call sites found are:

- `apps/fe/src/pages/settings/use-site-settings-form.ts:76`
- `packages/stores/src/site.ts:110`

### Likely cause of “Connect flips the UI to English”

Most likely sequence for the manage-page device-card Connect link:

1. A remote device card uses `hostAppPath(runtime.host, '/devices/:id')` at `device-card.tsx:133-139`.
2. For a remote node, navigation becomes `/n/<nodeId>/devices/<deviceId>`.
3. `NodeRuntimeBoundary` switches to that node’s runtime and `RuntimeProvider` remounts the subtree (`react.tsx:20-55`).
4. The remounted sidebar runs `SidebarTitle`’s mount effect at `sidebar-title.tsx:20-25`.
5. `SidebarTitle` calls `useSiteStore(...).fetchSettings()`.
6. The current runtime’s API client fetches that node’s `/api/settings/site`; the remote node commonly still has `language: 'en_US'`.
7. `createSiteStore.commitSettings` mutates the global singleton with `i18next.changeLanguage(settings.language)` at `site.ts:107-112`.
8. Because i18next is global rather than runtime-scoped, the entire UI re-renders in English.

The device-management panel’s `useSiteStore` read at `device-management-panel.tsx:68-75` only uses the language for localized sorting; it does not itself change i18next.

If “connect” means the sidebar Power button rather than the device-card route link, that code path only calls `connection.connect`/`tmux.connectDevice` (`device-connection-control.tsx:75-81`, `global-device-provider.tsx:164-170`, `tmux.ts:154-167`) and contains no language mutation. In that case, investigate an unrelated site-settings refresh, but the direct connect handler is not the cause.

A minimal fix direction is to prevent remote runtime site settings from controlling the global browser language. The host/self runtime or an explicit browser language preference should be the only authority for `i18next.changeLanguage`; remote runtime settings should remain available for that node’s metadata without globally changing the active UI language.