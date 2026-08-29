# Frontend implementation report

Inspected read-only; no files were modified.

## 1. Settings page and site-settings form

`SettingsPage` currently defines five tabs:

```ts
type SettingsTab =
  | 'general'
  | 'devicesAndFiles'
  | 'notifications'
  | 'ai'
  | 'terminal';
```

See [SettingsPage.tsx:29](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/SettingsPage.tsx:29).

The tab order is General, Terminal, Devices & Files, Notifications, and AI. Each tab is represented by `{ value, label, icon, testId }`; labels use `settings.tabGroup.*`. See [SettingsPage.tsx:36](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/SettingsPage.tsx:36).

The tab bar uses `Tabs`, `TabsList`, and `TabsTrigger`. Important styling:

- List: `w-full gap-1 ... overflow-x-auto ... p-1.5`
- Trigger: `pillTabTriggerClassName`, plus `min-w-max gap-2 px-3.5`

See [SettingsPage.tsx:79](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/SettingsPage.tsx:79) and [tabs.tsx:82](/Users/konata/code/tmex-enhanced-wt-merge/packages/ui/src/components/tabs.tsx:82).

There is no HTML `<form>` around the page. `useSiteSettingsForm()` creates a draft model and save mutation:

- `draft` contains only site name/URL, locale, notification settings, and SSH retry settings.
- Initial data comes from `GET /api/settings/site`.
- Save uses `PATCH /api/settings/site` with `buildSiteSettingsPayload(draft)`.
- Success invalidates `site-settings`, refreshes the site store, shows a toast, and handles language refresh messaging.

See [use-site-settings-form.ts:16](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/use-site-settings-form.ts:16), [use-site-settings-form.ts:35](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/use-site-settings-form.ts:35), and [use-site-settings-form.ts:55](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/use-site-settings-form.ts:55).

Current tab form ownership:

- `GeneralSettingsTab` receives `form` and renders `SettingsSaveButton`.
- `NotificationSettingsTab` receives `form` and renders another `SettingsSaveButton`.
- `DevicesAndFilesTab`, `AISettingsTab`, and `TerminalSettingsTab` receive no form.

See [general-settings-tab.tsx:10](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/general-settings-tab.tsx:10), [general-settings-tab.tsx:87](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/general-settings-tab.tsx:87), and [notification-settings-tab.tsx:9](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/notification-settings-tab.tsx:9).

`SettingsSaveButton` is a plain button, not form-submit behavior. See [settings-save-button.tsx:11](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/settings-save-button.tsx:11).

The new Nodes tab should therefore be independent of `SiteSettingsForm`. Do not add hub, role, TLS, direct-link, or mesh fields to `SiteSettingsDraft` or `/api/settings/site`; those are runtime/installation settings with separate lifecycle and likely separate endpoints.

The settings page’s top-right restart action is separate from tab saves. It calls `POST /api/settings/restart` and only shows a success/error toast. See [SettingsPage.tsx:123](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/SettingsPage.tsx:123).

## 2. Sidebar title

`SidebarTitle` renders:

1. Mobile close button, only when `isMobile`.
2. Brand link to `/`.
3. WebSocket latency indicator.
4. Theme menu.
5. Settings link to `/settings`.

See [sidebar-title.tsx:9](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-title.tsx:9).

Current horizontal spacing:

- Root container: `flex items-center gap-2 px-2`
- Mobile close button: `ml-[-8px]`
- Brand link: `flex-1 ... gap-3`
- Settings link: `mr-[-8px]`
- Theme trigger: `h-8 w-8`, with no custom negative margin

See [sidebar-title.tsx:24](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-title.tsx:24), [sidebar-title.tsx:30](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-title.tsx:30), [sidebar-title.tsx:37](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-title.tsx:37), and [sidebar-title.tsx:45](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-title.tsx:45).

The surrounding sidebar header uses vertical `gap-5`; this is the spacing between the title row and the panes/agent/files tabs, not between title-row buttons. See [app-sidebar.tsx:33](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:33).

For the new Nodes shortcut:

- Add another `NavLink`, probably targeting `/nodes`.
- Use `useSharedAuthMode()` and render it only when `meshEnabled` is true.
- `meshEnabled` is false for standalone and before mode loading completes.
- The existing sidebar device list uses exactly this mode guard.

See [sidebar-device-list.tsx:48](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:48) and [mesh-nodes.ts:226](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/mesh-nodes.ts:226).

There is currently no `sidebar-title.test.tsx`. Existing related tests cover the theme trigger and device-list mode behavior, but not the title buttons or settings link. See [theme-menu.test.tsx:35](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/theme-menu.test.tsx:35) and [sidebar-device-list.test.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-device-list.test.tsx).

## 3. NodesPage and extraction boundary

`NodesPage` first loads auth mode unless a `mode` prop is injected:

- Loading renders a spinner.
- `mode === 'none'` renders nothing.
- Mesh mode renders the management view.

See [NodesPage.tsx:80](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/NodesPage.tsx:80) and [NodesPage.tsx:85](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/NodesPage.tsx:85).

The current management view performs the following:

- `useMeshNodes()` loads and polls `/api/mesh/nodes`.
- `setEntryNodeId()` records the current entry node.
- `useHubNode()` locates the hub using `isHub` or `mode.hubNodeId`, then loads `/n/<hub>/api/hub/nodes`.
- `mergeNodes()` combines mesh membership and hub heartbeat/status data.
- `useSyncExternalStore()` tracks pending enrollments.
- `usePasskeys()` loads passkeys for the current origin.
- `useCredentialPrompt()` supplies password/passkey signing.
- `useEnrollmentWatch()` handles redeemed certificates.
- A timer prunes expired pending enrollments.

See [NodesPage.tsx:116](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/NodesPage.tsx:116).

The current page body contains:

- Header with title, subtitle, refresh button, and `/account/security` link.
- Hub-offline warning.
- Enrollment section.
- Nodes table.
- Credential dialog.

See [NodesPage.tsx:187](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/NodesPage.tsx:187).

### Data and event details

`useMeshNodes`:

- Uses the host-level mesh store rather than React Query.
- Fetches `/api/mesh/nodes`.
- Polls every 30 seconds by default.
- Subscribes to the shared `/mesh/ws` event source.

See [mesh-nodes.ts:279](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/mesh-nodes.ts:279) and [mesh-nodes.ts:305](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/mesh-nodes.ts:305).

The event WebSocket is always entry-local at `/mesh/ws`; it carries `NODE_EVENT`, enrollment, and RTC signals. See [mesh-events.ts:160](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/mesh-events.ts:160) and [mesh-events.ts:221](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/mesh-events.ts:221).

`useHubNode` loads `/n/<hub>/api/hub/nodes`, polls every 30 seconds, and considers the hub online only when the latest list succeeded. See [mesh-nodes.ts:343](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/mesh-nodes.ts:343).

Enrollment has two certificate-delivery paths:

- `/mesh/ws` `ENROLL_REDEEMED` push.
- Polling `/n/<hub>/api/hub/enrollments/:id` every 5 seconds.

See [enrollment-watch.ts:1](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/enrollment-watch.ts:1) and [enrollment-watch.ts:131](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/enrollment-watch.ts:131).

Pending enrollment metadata is stored in memory and `sessionStorage`; private `enroll_sk` is not persisted. Unconfirmed signed key-log records are memory-only and are retried byte-for-byte. See [enrollment.ts:62](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/enrollment.ts:62), [enrollment.ts:145](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/enrollment.ts:145), and [enrollment.ts:248](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/enrollment.ts:248).

### Recommended extraction

Create an exported `NodesManagement` component containing the current `NodesView` hook pipeline and reusable body:

```ts
interface NodesManagementProps {
  mode: AuthModeResponse;
  api?: AuthApi;
  // optionally compact/showHeader/onNavigateSecurity
}
```

Move or retain inside it:

- Mesh/hub loading and refresh.
- EnrollmentSection.
- NodesTable.
- Pending and unconfirmed record handling.
- Credential dialog.
- Hub-offline state.

Keep `NodesPage` responsible for:

- Auth-mode loading and standalone hiding.
- Full-page route chrome.
- Page title export.

The current `NodesView` is not exported and combines both chrome and body, so it is the natural refactoring point. The existing `NodesTable` and `EnrollmentSection` already have prop boundaries suitable for reuse.

The route-level page wrapper is separate from the body. `PageWrapper` renders the sticky top bar, `PageTitle`, optional `PageActions`, and content container. With `withSidebar=false`, it omits `SidebarTrigger`. There is no dedicated back button in the current wrapper or NodesPage. See [main.tsx:191](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/main.tsx:191).

`/nodes` is lazy-loaded using `nodesModule` and rendered outside the `NodeShell` sidebar. See [main.tsx:243](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/main.tsx:243) and [main.tsx:291](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/main.tsx:291).

`NodesPage.test.tsx` uses static SSR and verifies:

- Standalone mode renders empty.
- Self is first.
- Fingerprints, reachability, login button, and account-security link appear.
- Hub-offline disables add/rename/revoke.
- Missing `uid`/KDF suppresses management.
- Root signer can auto-admit; passkey cannot.
- Hub URL precedence and no-origin fallback.

See [NodesPage.test.tsx:44](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/NodesPage.test.tsx:44) and [NodesPage.test.tsx:62](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/NodesPage.test.tsx:62).

## 4. Auth mode and node runtime

The client-side mode response is:

```ts
interface AuthModeResponse {
  mode: 'none' | 'mesh';
  nodeId: string;
  uid: string | null;
  username: string | null;
  kdfParams: AuthKdfParamsJson | null;
  passkeysForThisOrigin: boolean;
  passkeyAvailable: boolean;
  totpEnabled?: boolean;
  rootEpoch?: number | null;
  rootPublicKey?: string | null;
  hubNodeId?: string | null;
  hubPublicUrl?: string | null;
}
```

See [types.ts:23](/Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/auth/types.ts:23).

There is no `isHub` field in `AuthModeResponse`. `isHub` exists on each `MeshNode`, and is also derived from `hubNodeId` when merging rows. See [types.ts:137](/Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/auth/types.ts:137) and [mesh-nodes.ts:138](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/mesh-nodes.ts:138).

There is also no explicit `role` field. The UI can infer “this machine is hub” when the current node row is the hub, but cannot distinguish all backend role details from `/api/auth/mode`.

`useAuthMode` fetches `/api/auth/mode` and returns `{ mode, loading, error, reload }`. See [use-session-key.ts:22](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/use-session-key.ts:22).

`useSharedAuthMode` is a host-level external-store hook returning:

```ts
{
  mode,
  loaded,
  meshEnabled,
  entryNodeId
}
```

See [mesh-nodes.ts:226](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/mesh-nodes.ts:226).

Standalone behavior is already implemented by:

- `LoginPage`: returns null for `mode: 'none'`.
- `AccountSecurityPage`: returns null for `mode: 'none'`.
- `NodesPage`: returns null for `mode: 'none'`.
- Sidebar device list: uses the local runtime instead of mesh aggregation.

The new Settings Nodes tab must not reuse this hiding behavior wholesale, because standalone must expose the “enable hub” wizard.

### Self versus `/n/:id`

`resolveNodeUrl()` maps:

- `self`, empty, or undefined → unchanged `/api/...` path.
- Any other validated node ID → `/n/<id>/api/...`.

See [node-url.ts:20](/Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/node-url.ts:20), [node-url.ts:49](/Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/node-url.ts:49), and [node-url.ts:59](/Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/node-url.ts:59).

`createNodeApiClient(nodeId)` creates an `ApiClient` whose base URL is the node prefix. See [node-url.ts:160](/Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/node-url.ts:160).

`useNodeRuntime` obtains a per-node runtime with reference-counted acquire/release semantics. See [node-connection-manager.ts:261](/Users/konata/code/tmex-enhanced-wt-merge/packages/stores/src/node-connection-manager.ts:261).

`NodeRuntimeBoundary` maps a missing route parameter to `self`, then provides the node-specific runtime and React Query client. See [node-runtime-boundary.tsx:14](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/node-runtime-boundary.tsx:14).

Important for the embedded management component: mesh aggregation intentionally uses the entry-level default client, not the current `/n/:id` runtime client. See [mesh-nodes.ts:1](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/mesh-nodes.ts:1) and [hub-api.ts:1](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/hub-api.ts:1).

## 5. API client conventions

`@tmex/api-client` exposes the root client through `src/index.ts`; wildcard package exports permit imports such as `@tmex/api-client/auth/index`. See [package.json:7](/Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/package.json:7).

Endpoints are ordinary typed methods, not a central registry. Add:

1. Request/response types in the relevant `types.ts`.
2. A method on an existing API class or a new client module.
3. An export through the package wildcard or barrel as needed.
4. A transport-injection test.

`ApiClient.fetch()` accepts a relative path and optional `RequestInit`, then returns the raw `Response`. It does not throw for HTTP error statuses. See [client.ts:57](/Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/client.ts:57).

Typical JSON endpoint implementation:

```ts
const res = await client.fetch('/api/example', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(input),
});

if (!res.ok) {
  throw new Error(await parseApiError(res, 'Fallback message'));
}

return (await res.json()) as ExampleResponse;
```

`parseApiError()` supports both `{ error: string }` and `{ error: { message } }`. See [client.ts:83](/Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/client.ts:83).

There is no generic `fetchJson` helper. Existing methods call `res.json()` directly, for example [auth-api.ts:58](/Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/auth/auth-api.ts:58) and [hub-api.ts:69](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/hub-api.ts:69).

For typed error codes, follow `HubApi`’s `readError()` pattern rather than using `parseApiError()`. See [hub-api.ts:46](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/hub-api.ts:46).

### 401 handling

The app installs the session interceptor once from `main.tsx`. See [main.tsx:311](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/main.tsx:311).

Behavior:

- Self 401 → global auth event and navigation to `/login?next=...`.
- `/n/:id` 401 → node-scoped auth event only.
- `NODE_LOGIN_REQUIRED` is handled without redirecting the whole page.
- The interceptor reads a cloned response body, so the caller can still call `res.json()`.

See [session-interceptor.ts:108](/Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/auth/session-interceptor.ts:108) and [session-interceptor.ts:141](/Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/auth/session-interceptor.ts:141).

## 6. Account security and credentials

`AccountSecurityPage` is itself hidden in standalone mode. In mesh mode it:

- Loads `/api/auth/passkeys`.
- Creates a `useCredentialPrompt`.
- Renders password, TOTP, and passkey sections.
- Mounts the credential dialog.

See [AccountSecurityPage.tsx:43](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/AccountSecurityPage.tsx:43) and [AccountSecurityPage.tsx:103](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/AccountSecurityPage.tsx:103).

`useCredentialPrompt` supports:

- `request({ purpose, reuse })`: returns a signer and keeps it in a five-minute memory-only reuse window.
- `withSigner(fn, { purpose })`: obtains a signer and wipes root-key material when the callback completes.
- Password-derived root signing.
- Current-origin passkey signing.

See [credential-prompt.tsx:26](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/credential-prompt.tsx:26) and [credential-prompt.tsx:345](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/credential-prompt.tsx:345).

Account-security actions append signed `user_key_log` records; `sk_sess` cannot sign persistent records. See [account-security-actions.ts:1](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/account-security-actions.ts:1).

The existing Nodes management uses these credentials for enrollment/admit/revoke:

- Enrollment requests a signer and key-log head.
- Admit may reuse a root signer automatically.
- Passkey admit must remain user-initiated.
- Revoke always uses `withSigner`.

See [NodesPage.tsx:323](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/NodesPage.tsx:323) and [NodesPage.tsx:825](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/NodesPage.tsx:825).

The standalone “become hub” wizard should not use this dialog if user creation is server-side. Standalone mode has no `uid`, KDF, or existing root public key. The backend already has a server-side `bootstrapUserWithSelfAdmit()` service that derives the root and creates the initial self-admitted node. See [user-key-service.ts:661](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/auth/user-key-service.ts:661).

However, this service is currently reached by the CLI `hub user add`, not by a browser route. See [hub.ts:168](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/hub.ts:168) and the current auth route list [auth-routes.ts:98](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/auth-routes.ts:98). A new bootstrap/setup endpoint and API-client method are required.

The requested “direct enable/disable” is also not currently a browser API. Existing `direct enable` downloads and writes a native addon; `direct disable` deletes the native directory. See [direct.ts:41](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/direct.ts:41) and [direct.ts:121](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/direct.ts:121). `direct_capable` only indicates capability, not a complete UI-manageable enabled state.

## 7. UI kit and toast

Available primitives are imported by subpath:

- `Button`, with `default`, `outline`, `secondary`, `ghost`, `destructive`, and `link` variants; icon and size variants. See [button.tsx:6](/Users/konata/code/tmex-enhanced-wt-merge/packages/ui/src/components/button.tsx:6).
- `Input`. See [input.tsx:6](/Users/konata/code/tmex-enhanced-wt-merge/packages/ui/src/components/input.tsx:6).
- `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`, and `pillTabTriggerClassName`. See [tabs.tsx:8](/Users/konata/code/tmex-enhanced-wt-merge/packages/ui/src/components/tabs.tsx:8).
- `Dialog` and dialog content/header/footer/title/description. See [dialog.tsx:10](/Users/konata/code/tmex-enhanced-wt-merge/packages/ui/src/components/dialog.tsx:10).
- `Select`, `SelectTrigger`, `SelectContent`, `SelectItem`, and related pieces. See [select.tsx:7](/Users/konata/code/tmex-enhanced-wt-merge/packages/ui/src/components/select.tsx:7).
- `Switch`. See [switch.tsx:5](/Users/konata/code/tmex-enhanced-wt-merge/packages/ui/src/components/switch.tsx:5).
- `AlertDialog`, including destructive confirmation actions. See [alert-dialog.tsx:9](/Users/konata/code/tmex-enhanced-wt-merge/packages/ui/src/components/alert-dialog.tsx:9).
- `Badge`. See [badge.tsx:26](/Users/konata/code/tmex-enhanced-wt-merge/packages/ui/src/components/badge.tsx:26).
- `Card`, `CardHeader`, `CardContent`, `CardFooter`, etc. See [card.tsx:5](/Users/konata/code/tmex-enhanced-wt-merge/packages/ui/src/components/card.tsx:5).

There are no dedicated `Alert`, `Callout`, `Table`, `Code`, or copyable-code primitives in `packages/ui`. Nodes currently uses:

- Native `<table>`. See [NodesPage.tsx:725](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/NodesPage.tsx:725).
- Local `CopyableCode` using `<code>` and clipboard API. See [NodesPage.tsx:660](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/NodesPage.tsx:660).
- Plain styled paragraphs for warnings. See [NodesPage.tsx:215](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/NodesPage.tsx:215).

The app mounts a themed Sonner toaster globally. See [main.tsx:98](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/main.tsx:98). Existing code uses `toast.success`, `toast.error`, and `toast.warning`; for example [SettingsPage.tsx:130](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/SettingsPage.tsx:130).

## 8. i18n

Source locale files:

- [en_US.json](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/i18n/locales/en_US.json)
- [zh_CN.json](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/i18n/locales/zh_CN.json)
- [ja_JP.json](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/i18n/locales/ja_JP.json)

The manifest defines these three locales and `en_US` as default. See [manifest.json:1](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/i18n/locales/manifest.json:1).

Frontend locale JSON is loaded with a Vite glob. See [i18n/index.ts:6](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/i18n/index.ts:6).

Existing settings keys use:

```text
settings.tabGroup.general
settings.tabGroup.devicesAndFiles
settings.tabGroup.notifications
settings.tabGroup.ai
settings.tabGroup.terminal
```

See [en_US.json:193](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/i18n/locales/en_US.json:193).

Existing Nodes keys use namespaces such as:

```text
nodes.columns.*
nodes.status.*
nodes.reach.*
nodes.actions.*
nodes.enrollment.*
nodes.rename.*
nodes.revoke.*
nodes.badge.*
```

See [en_US.json:1136](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/i18n/locales/en_US.json:1136).

Recommended new naming:

```text
settings.tabGroup.nodes

nodes.machine.*
nodes.setup.*
nodes.https.*
nodes.role.*
nodes.direct.*
```

Add source keys to all three locale JSON files, then run:

```bash
bun run build:i18n
```

The command is defined at [package.json:11](/Users/konata/code/tmex-enhanced-wt-merge/package.json:11) and runs [build-i18n.ts:35](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/scripts/build-i18n.ts:35).

Never hand-edit:

- `packages/shared/src/i18n/resources.ts`
- `packages/shared/src/i18n/types.ts`

Both files explicitly identify themselves as generated. See [resources.ts:1](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/i18n/resources.ts:1) and [types.ts:1](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/i18n/types.ts:1).

## 9. Health polling and restart UX

`GET /healthz` returns:

```ts
{
  status: 'ok',
  restarting: boolean,
  env: string,
  tmux: ...,
  owner: ...
}
```

See [system-routes.ts:68](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/api/system-routes.ts:68).

The closest existing restart-aware UX is the Version tab:

- Starts `POST /api/system/upgrade`.
- Polls `GET /api/system/upgrade` every 2 seconds.
- Tracks whether it observed a non-`idle` state.
- Treats a later `idle` state as successful service restart.
- Invalidates system info and shows a success toast.

See [use-version-tab.ts:12](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/settings/use-version-tab.ts:12) and [use-version-tab.ts:62](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/settings/use-version-tab.ts:62).

The current settings restart action does not poll `/healthz`; it posts the restart request and immediately shows `settings.restartScheduled`. See [SettingsPage.tsx:123](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/SettingsPage.tsx:123).

Therefore, hub-role changes, joining/leaving mesh, or TLS changes should either:

- Reuse the upgrade-style “pending → service unavailable/restarting → healthy again” state machine, or
- Add a dedicated health polling hook around `/healthz`.

There is no existing generalized health-wait hook.

## 10. FE test conventions and commands

Unit tests use Bun’s test runner:

```ts
import { describe, expect, test } from 'bun:test';
```

Pages commonly use:

- `react-dom/server`’s `renderToStaticMarkup`.
- `MemoryRouter`.
- Injected state stores.
- Custom `ApiClient` transports.
- `Response`/`Response.json()` mocks.

See [NodesPage.test.tsx:3](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/NodesPage.test.tsx:3), [NodesPage.test.tsx:44](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/NodesPage.test.tsx:44), and [auth-api.test.ts:11](/Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/auth/auth-api.test.ts:11).

No `@testing-library/*` or `msw` usage was found in the FE source or dependencies. Tests rely on static rendering, pure-function tests, in-memory storage, and injected fetch-like transports.

The FE package’s `test` script runs Playwright E2E, not unit tests. See [apps/fe/package.json:5](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/package.json:5).

Useful commands:

```bash
cd apps/fe
bun test src/
bun run test:e2e
bun run build
```

`bun run build` executes `tsc && vite build`. See [apps/fe/package.json:7](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/package.json:7).

From the repository root:

```bash
bun run build:fe
bun run lint
```

These map to the FE build and `biome check .`. See [package.json:13](/Users/konata/code/tmex-enhanced-wt-merge/package.json:13) and [package.json:25](/Users/konata/code/tmex-enhanced-wt-merge/package.json:25).

Biome already ignores generated resources, types, dist, node_modules, and generated runtime assets. See [biome.json:8](/Users/konata/code/tmex-enhanced-wt-merge/biome.json:8).

## Required backend/API additions

The existing frontend and API surface do not currently provide:

1. Browser endpoint to bootstrap a standalone instance into `hub,node`.
2. Browser endpoint to join or leave a hub and persist role/config changes.
3. Browser endpoint for HTTPS mode/configuration.
4. Browser endpoint for direct-link enable/disable.
5. Auth-mode fields for explicit role, direct-link state, or HTTPS configuration.

Existing CLI/runtime evidence:

- Hub roles are persisted through `TMEX_ROLES`, `TMEX_HUB_URL`, and `TMEX_HUB_PUBLIC_URL`; see [config.ts:179](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/config.ts:179).
- `hub user add` creates the initial user and self-admitted node server-side, but is CLI-only today; see [hub.ts:168](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/hub.ts:168).
- `direct enable/disable` currently performs installation-directory file operations; see [direct.ts:55](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/direct.ts:55).
- `TMEX_TRUST_PROXY` is currently a manually configured environment variable, not a site setting; see [config.ts:188](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/config.ts:188).
- External proxy, private CA, and Let’s Encrypt are documented deployment/E2E concepts, not current FE configuration APIs; see [hub-node-operations.md:39](/Users/konata/code/tmex-enhanced-wt-merge/docs/hub/2026082800-hub-node-operations.md:39) and [hub-docker-e2e.md:138](/Users/konata/code/tmex-enhanced-wt-merge/docs/hub/2026082801-hub-docker-e2e.md:138).

The Settings Nodes tab should therefore be structured as a mode-aware orchestration layer:

```text
SettingsPage
└── NodesSettingsTab
    ├── ThisMachineBlock
    ├── StandaloneHubSetup
    │   ├── BecomeHub
    │   └── JoinHub
    ├── HttpsConfiguration
    └── NodesManagement       // mesh mode only
```

`NodesManagement` can reuse the existing mesh management logic, while setup, role, TLS, and direct-link controls require new backend contracts and API-client methods.