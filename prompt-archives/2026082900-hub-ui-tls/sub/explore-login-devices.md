# Read-only implementation report

No files were modified.

## 1. Login flow and error aggregation

### Current flow

- `next` and optional target node are read from the URL at [`LoginPage.tsx:60`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:60) and [`LoginPage.tsx:61`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:61).
- Password login derives a session key/delegation, clears the entered credentials, then awaits fan-out at [`LoginPage.tsx:160`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:160), [`LoginPage.tsx:169`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:169), and [`LoginPage.tsx:173`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:173).
- Passkey login follows the same fan-out path at [`LoginPage.tsx:198`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:198) and [`LoginPage.tsx:203`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:203).
- `loginToAllReachable()` logs into `self` first, because `/api/mesh/nodes` requires a session, at [`session-key-store.ts:535`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/session-key-store.ts:535), [`session-key-store.ts:549`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/session-key-store.ts:549), and [`session-key-store.ts:550`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/session-key-store.ts:550).
- It then fetches `/api/mesh/nodes` at [`session-key-store.ts:560`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/session-key-store.ts:560), filters online nodes, and logs into the remaining nodes in parallel at [`session-key-store.ts:581`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/session-key-store.ts:581) and [`session-key-store.ts:593`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/session-key-store.ts:593).
- `AuthApi.listNodes()` is the protected `GET /api/mesh/nodes` wrapper at [`auth-api.ts:67`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/auth/auth-api.ts:67). Node-specific auth paths become `/n/<id>/api/auth/...`; `self` remains unprefixed at [`auth-api.ts:34`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/auth/auth-api.ts:34).

### Why wrong password becomes “all nodes failed”

1. Password derivation itself does not verify the password. It only creates the root delegation at [`session-key-store.ts:218`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/session-key-store.ts:218).
2. The self login failure is stored correctly in the progress row at [`session-key-store.ts:551`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/session-key-store.ts:551) and [`session-key-store.ts:553`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/session-key-store.ts:553).
3. However, self failure returns `{ anyOk: false }` at [`session-key-store.ts:555`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/session-key-store.ts:555).
4. `LoginPage` then discards the specific code and displays `auth.login.allNodesFailed` at [`LoginPage.tsx:121`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:121) and [`LoginPage.tsx:125`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:125).
5. The detailed row still renders `auth.errors.<row.code>` at [`LoginPage.tsx:334`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:334) and [`LoginPage.tsx:343`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:343), but the primary error is misleading.

For a non-self node, its failure remains attached to that node’s progress row and does not make the whole login fail if self succeeded.

### Local versus remote errors

- Wrong password: the backend verifies the root delegation signature against the stored root public key at [`auth-routes.ts:740`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/auth-routes.ts:740). A wrong derived key becomes `DELEGATION_BAD_SIGNATURE` through [`auth-routes.ts:745`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/auth-routes.ts:745) and [`auth-routes.ts:970`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/auth-routes.ts:970).
- There is no backend `BAD_PASSWORD` code. The existing `ROOT_KEY_MISMATCH` / “Wrong password” key is used by the account-security credential prompt, not by the login page, at [`credential-prompt.tsx:90`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/credential-prompt.tsx:90) and [`credential-prompt.tsx:491`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/credential-prompt.tsx:491).
- Missing TOTP is checked client-side at [`LoginPage.tsx:147`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:147), and again while building a node login at [`session-key-store.ts:460`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/session-key-store.ts:460).
- Backend TOTP results are explicit: `TOTP_REQUIRED` at [`auth-routes.ts:799`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/auth-routes.ts:799) and `TOTP_INVALID` at [`auth-routes.ts:803`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/auth-routes.ts:803).
- If a target node is absent from the protected mesh list, the frontend returns `UNKNOWN_NODE` at [`session-key-store.ts:450`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/session-key-store.ts:450).
- A stale or invalid target can receive `TARGET_MISMATCH` from the backend at [`auth-routes.ts:284`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/auth-routes.ts:284).
- There is no `NODE_NOT_ADMITTED` response in `auth-routes.ts`. The mesh list is built from active certificates, so non-admitted/revoked nodes are excluded at [`mesh-routes.ts:215`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-routes.ts:215) and [`mesh-routes.ts:231`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-routes.ts:231).

### Login-page text and i18n keys

Static login keys used by [`LoginPage.tsx:221`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:221) through [`LoginPage.tsx:310`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:310):

- `auth.login.title`
- `auth.login.subtitle`
- `auth.login.username`
- `auth.login.password`
- `auth.login.totp`
- `auth.login.submit`
- `auth.login.deriving`
- `auth.login.signingIn`
- `auth.login.usePasskey`
- `auth.login.registerPasskeyHere`
- `auth.login.credentialsRequired`
- `auth.login.totpRequired`
- `auth.login.allNodesFailed`
- `auth.login.nodeListFailed`
- `auth.login.willSignIn`

Their English definitions are at [`en_US.json:1035`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/i18n/locales/en_US.json:1035) and [`en_US.json:1049`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/i18n/locales/en_US.json:1049).

Additional rendered text:

- `nodes.status.online` / `nodes.status.offline` for the pre-login public node list at [`LoginPage.tsx:319`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:319) and [`LoginPage.tsx:323`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:323).
- Dynamic `auth.errors.<code>` for per-node failures at [`LoginPage.tsx:342`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:342).
- The complete current error-key inventory is at [`en_US.json:1056`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/i18n/locales/en_US.json:1056) through [`en_US.json:1090`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/i18n/locales/en_US.json:1090), including `TOTP_REQUIRED`, `TOTP_INVALID`, `NETWORK_ERROR`, `BAD_SIGNATURE`, `DELEGATION_BAD_SIGNATURE`, `DELEGATION_EXPIRED`, `UNKNOWN_USER`, `TARGET_MISMATCH`, `ROOT_KEY_MISMATCH`, `PASSKEY_ABORTED`, and `NO_PASSKEY_FOR_ORIGIN`.
- Non-i18n text includes the TOTP placeholder `000000` at [`LoginPage.tsx:266`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:266), raw node names/IDs at [`LoginPage.tsx:322`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:322), and raw error messages/codes in the catch paths at [`LoginPage.tsx:175`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:175).

There is currently no login-page text for delegation lifetime or cookie behavior. The delegation is technically 18 hours at [`delegation.ts:6`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/auth/delegation.ts:6), but that is not rendered. `auth.security.sessionKeyNote` is only rendered on Account Security at [`AccountSecurityPage.tsx:165`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/AccountSecurityPage.tsx:165), and the cookie/proxy explanation is a settings key, not a login-page key.

## 2. Passkey registration versus passkey login

The login-page registration link is rendered at [`LoginPage.tsx:305`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:305) through [`LoginPage.tsx:310`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:310).

It should be removed. The existing test explicitly expects it at [`LoginPage.test.tsx:50`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.test.tsx:50).

Registration belongs in `PasskeySection` on Account Security:

- Section composition: [`AccountSecurityPage.tsx:153`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/AccountSecurityPage.tsx:153).
- Registration action: [`AccountSecurityPage.tsx:509`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/AccountSecurityPage.tsx:509) through [`AccountSecurityPage.tsx:515`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/AccountSecurityPage.tsx:515).
- Registration button: [`AccountSecurityPage.tsx:627`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/AccountSecurityPage.tsx:627) through [`AccountSecurityPage.tsx:635`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/AccountSecurityPage.tsx:635).
- The page immediately calls `GET /api/auth/passkeys` at [`AccountSecurityPage.tsx:108`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/AccountSecurityPage.tsx:108), which requires a session through [`auth-routes.ts:141`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/auth-routes.ts:141).
- Both registration endpoints require a session at [`auth-routes.ts:123`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/auth-routes.ts:123) and [`auth-routes.ts:128`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/auth-routes.ts:128).
- Registration also requires a credential signer supplied by `useCredentialPrompt`, not merely an anonymous page visit.

The separate passkey login button must remain:

- Gate: `mode.passkeyAvailable && mode.passkeysForThisOrigin` at [`LoginPage.tsx:70`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:70).
- Rendered at [`LoginPage.tsx:292`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:292) through [`LoginPage.tsx:302`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:302).

## 3. Branding inventory

### Actual logo assets

- The only React-rendered brand logo is `/logo.png` in [`sidebar-title.tsx:43`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-title.tsx:43) through [`sidebar-title.tsx:47`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-title.tsx:47).
- `/tmex.png` is used as the static Apple touch icon in [`apps/fe/index.html:19`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/index.html:19).
- The gateway-generated PWA manifest uses `/tmex.png` and `/tmex-maskable.png` at [`system-routes.ts:25`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/api/system-routes.ts:25) through [`system-routes.ts:37`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/api/system-routes.ts:37).
- No `/tmex.svg` usage was found.
- The `<img>` in `FilePage` is a user file preview, not branding, at [`FilePage.tsx:121`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/FilePage.tsx:121).

### Current site-name behavior

| Surface | Current behavior |
|---|---|
| Sidebar | Uses `useSiteStore().settings?.siteName`, fetches settings, then falls back to hardcoded `tmex` at [`sidebar-title.tsx:17`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-title.tsx:17), [`sidebar-title.tsx:21`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-title.tsx:21), and [`sidebar-title.tsx:27`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-title.tsx:27). |
| PageWrapper/top bar | Renders only the page title and actions; it has no logo or site name at [`main.tsx:210`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/main.tsx:210) and [`main.tsx:224`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/main.tsx:224). |
| Login page | No logo or site name; only a `ShieldCheck` icon and `auth.login.title` at [`LoginPage.tsx:222`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:222). |
| Account Security | No logo/site name. Its PageWrapper title is `auth.security.title` at [`AccountSecurityPage.tsx:642`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/AccountSecurityPage.tsx:642). |
| Nodes page | No logo/site name. PageWrapper uses `nodes.title` at [`NodesPage.tsx:36`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/NodesPage.tsx:36); the internal header also only uses `nodes.title`/`nodes.subtitle` at [`nodes-management.tsx:129`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/nodes/nodes-management.tsx:129). |
| Settings page | No logo/site name in its header. PageWrapper uses `sidebar.settings` at [`SettingsPage.tsx:128`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/SettingsPage.tsx:128). The general settings form edits `siteName`; it is not a brand header at [`general-settings-tab.tsx:26`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/general-settings-tab.tsx:26). |
| Devices page | No logo/site name; PageWrapper uses `sidebar.manageDevices` at [`DevicesPage.tsx:8`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/DevicesPage.tsx:8). |
| File/device console | File page shows its filename at [`FilePage.tsx:305`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/FilePage.tsx:305). Device-console titles use `useSiteStore().settings.siteName` for browser/terminal title construction at [`page-title.tsx:22`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-console/page-title.tsx:22) and [`use-device-console-effects.ts:73`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-console/use-device-console-effects.ts:73). |
| Static document metadata | `index.html` hardcodes description and `<title>tmex` at [`index.html:20`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/index.html:20) and [`index.html:21`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/index.html:21). |
| Store fallback | Default site name is hardcoded as `tmex` at [`site.ts:32`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/stores/src/site.ts:32) and [`site-fallback.ts:23`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/stores/src/site-fallback.ts:23). |

### Recommended shared component

Use `apps/fe/src/components/brand.tsx`, not `packages/ui`, because the component needs application-level `useSiteStore` and settings loading.

Replace/augment these call sites:

1. Replace the site-name/image block in `SidebarTitle` at [`sidebar-title.tsx:17`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-title.tsx:17) and [`sidebar-title.tsx:43`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-title.tsx:43).
2. Add a compact `Brand` to the no-sidebar `PageWrapper` top bar near [`main.tsx:214`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/main.tsx:214). This automatically covers Login, Account Security, and Nodes, whose routes use `withSidebar={false}` at [`main.tsx:293`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/main.tsx:293).
3. If the login card itself should show branding, add it near [`LoginPage.tsx:221`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:221).
4. Keep page-specific `PageTitle` components unchanged; they represent the current page, not the product brand.
5. Keep `/tmex.png` and `/tmex-maskable.png` handling separate because static HTML and the PWA manifest cannot be replaced by a React component.

## 4. Login success and background fan-out

### Current behavior

Navigation waits for all fan-out work:

- `onSubmit` awaits `runFanOut()` at [`LoginPage.tsx:173`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:173).
- `runFanOut()` awaits `loginToAllReachable()` at [`LoginPage.tsx:121`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:121).
- `loginToAllReachable()` awaits every remote login through `Promise.all` at [`session-key-store.ts:593`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/session-key-store.ts:593).
- Only then does it set `phase='done'`, which triggers navigation at [`LoginPage.tsx:101`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:101).

The explicit `?node=` flow intentionally waits for that target node before navigating at [`LoginPage.tsx:109`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:109) and [`LoginPage.tsx:118`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.tsx:118).

### Session and cookie storage

- `sk_sess`, delegation, delegation signature, and TOTP material live in module-level memory at [`session-key-store.ts:50`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/session-key-store.ts:50) and [`session-key-store.ts:84`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/session-key-store.ts:84).
- Password login stores them after derivation at [`session-key-store.ts:181`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/session-key-store.ts:181) through [`session-key-store.ts:208`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/session-key-store.ts:208).
- They are not cookies/localStorage and survive React route changes until explicitly cleared or expired.
- The local login response becomes `tmex_s_self` through [`session-middleware.ts:148`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/session-middleware.ts:148).
- A remote login response becomes `tmex_s_<nodeId>` through the forwarder at [`forwarder.ts:583`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/forwarder.ts:583).

### Recommended change

Split the operation into:

1. Login `self`.
2. Once self succeeds and its cookie is established, navigate to `next` immediately.
3. Continue `/api/mesh/nodes` loading and remote logins in a detached background task.

A practical implementation is an `onSelfLoggedIn` callback or a separate `loginSelfThenFanOut()` API invoked immediately after the self result at [`session-key-store.ts:549`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/session-key-store.ts:549). Keep `?node=` target login blocking because that flow specifically requests one node.

Important safeguards:

- Do not let the background task call React state setters after LoginPage unmounts.
- Keep `clearTotpCode()` until all background node attempts finish; it currently occurs at [`session-key-store.ts:600`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/session-key-store.ts:600).
- Add a task generation/cancellation guard. The current `current` session object is global and can be replaced by another login while an old background task is still running.
- Refresh or patch the mesh-node store after successful remote logins. `MeshNode.loggedIn` is derived from cookies when `/api/mesh/nodes` is fetched at [`mesh-routes.ts:244`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-routes.ts:244), but `loginToAllReachable()` does not currently update the frontend mesh store.
- After route change, `NodeRuntimeBoundary` creates the active node runtime at [`node-runtime-boundary.tsx:20`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/node-runtime-boundary.tsx:20). The session cookies are already available to that runtime.
- `NodeLoginButton` can use the still-live in-memory session key to silently log into a node at [`NodeLoginButton.tsx:38`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/NodeLoginButton.tsx:38) and [`NodeLoginButton.tsx:44`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/NodeLoginButton.tsx:44).

## 5. Devices management

### Current data source

`DevicesPage` is only a wrapper around one `DeviceManagementPanel` at [`DevicesPage.tsx:1`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/DevicesPage.tsx:1) and [`DevicesPage.tsx:5`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/DevicesPage.tsx:5).

The panel:

- Uses the current runtime at [`device-management-panel.tsx:56`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-management/device-management-panel.tsx:56).
- Fetches only that runtime’s `/api/devices` at [`device-management-panel.tsx:72`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-management/device-management-panel.tsx:72) and [`device-management-panel.tsx:74`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-management/device-management-panel.tsx:74).
- The API wrapper is `GET /api/devices` at [`devices.ts:26`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/devices.ts:26).
- Create, update, delete, reorder, and connection-test functions all accept an injected `ApiClient` at [`devices.ts:34`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/devices.ts:34), [`devices.ts:51`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/devices.ts:51), and [`devices.ts:98`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/devices.ts:98).

### Existing mesh aggregation pattern

`useMeshNodes()` owns the protected `/api/mesh/nodes` list at [`mesh-nodes.ts:254`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/mesh-nodes.ts:254) and refreshes it on mount/poll at [`mesh-nodes.ts:294`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/mesh-nodes.ts:294).

The sidebar already implements the required three-way state split:

| Node state | Existing behavior |
|---|---|
| Offline | Show last-known `inventory.devices`, do not create a runtime or request devices at [`sidebar-node-section.tsx:68`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:68). |
| Online, not logged in | Show only `NodeLoginButton` at [`sidebar-node-section.tsx:94`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:94). |
| Online, logged in | Mount `NodeRuntimeScope` and render the node’s real device tree at [`sidebar-node-section.tsx:105`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:105) and [`sidebar-node-section.tsx:108`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:108). |

`NodeRuntimeScope` provides a per-node runtime, query client, and device provider at [`node-runtime-scope.tsx:18`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/node-runtime-scope.tsx:18). Runtime acquisition/release is handled by `useNodeRuntime()` at [`node-connection-manager.ts:261`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/stores/src/node-connection-manager.ts:261); unused runtimes are released after a 30-second grace period at [`node-connection-manager.ts:211`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/stores/src/node-connection-manager.ts:211).

For a non-self node, the injected runtime client automatically prefixes REST calls with `/n/<id>` at [`node-url.ts:49`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/node-url.ts:49) and [`node-connection-manager.ts:159`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/stores/src/node-connection-manager.ts:159). Therefore `fetchDevices(runtime.apiClient)` becomes `/n/<id>/api/devices`.

### Recommended grouped DevicesPage design

Create a node-group child component and render one group per `useMeshNodes().nodes` entry:

- Use `useSharedAuthMode()` and `useMeshNodes()` in the page parent.
- For offline nodes, show node status and `inventoryDevices(node.inventory)` without a protected request.
- For online but unauthenticated nodes, show node status plus `NodeLoginButton`.
- For online and authenticated nodes, wrap the group in `NodeRuntimeScope`, then render `DeviceManagementPanel` inside it.
- Add the node name/status header using the existing `NodeBadge` pattern.
- Keep each group’s query key isolated by its node-specific `QueryClient`; the existing key `['devices']` is safe inside each node runtime.

Add/edit/delete/test actions are already runtime-aware:

- Dialog mutations use `runtime.apiClient` at [`use-device-dialog-submit.ts:79`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-management/use-device-dialog-submit.ts:79) and [`use-device-dialog-submit.ts:90`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-management/use-device-dialog-submit.ts:90).
- Connection testing uses the current runtime client at [`device-card.tsx:42`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-management/device-card.tsx:42).
- Connect links already preserve the current node through `hostAppPath()` at [`device-card.tsx:133`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-management/device-card.tsx:133).

One issue must be addressed for grouped panels: `DeviceManagementActions` defaults to a global browser event at [`device-management-actions.tsx:12`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-management/device-management-actions.tsx:12) and [`device-management-actions.tsx:20`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-management/device-management-actions.tsx:20). Multiple mounted panels would all open their add dialogs. For the grouped page, disable `listenOpenAddDeviceEvent` and use explicit per-node panel refs/callbacks; the panel already exposes `openAddDevice()` at [`device-management-panel.tsx:36`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-management/device-management-panel.tsx:36) and [`device-management-panel.tsx:63`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-management/device-management-panel.tsx:63).

## 6. Backend touchpoints

- `/api/auth/login` accepts signed login/delegation data, not a password, at [`auth-routes.ts:254`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/auth-routes.ts:254) and [`types.ts:89`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/auth/types.ts:89).
- Non-2xx login responses are returned as `{ ok: false, status, code }` by the API client at [`auth-api.ts:136`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/auth/auth-api.ts:136).
- Backend login validation covers challenge consumption, entry, target, UID, delegation, login signature, TOTP, and session issuance at [`auth-routes.ts:273`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/auth-routes.ts:273), [`auth-routes.ts:299`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/auth-routes.ts:299), [`auth-routes.ts:305`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/auth-routes.ts:305), and [`auth-routes.ts:317`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/auth-routes.ts:317).
- Successful self login becomes a browser cookie; remote login is converted by the forwarder into a node-specific cookie.
- `NODE_LOGIN_REQUIRED` is a protected-API/remote-session signal, not an `/api/auth/login` error. It is handled without redirecting the whole app at [`session-interceptor.ts:116`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/auth/session-interceptor.ts:116) and [`session-interceptor.ts:121`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/auth/session-interceptor.ts:121).

## 7. Tests to update or extend

Current direct tests:

- Login page: [`apps/fe/src/pages/LoginPage.test.tsx:25`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.test.tsx:25). The registration-link assertion is at [`LoginPage.test.tsx:50`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/LoginPage.test.tsx:50) and should be removed/replaced.
- Sidebar title: [`apps/fe/src/components/page-layouts/components/sidebar-title.test.tsx:50`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-title.test.tsx:50). Add site-name/logo assertions here if `Brand` replaces the current implementation.
- No `apps/fe/src/pages/DevicesPage.test.tsx` currently exists.

Closest tests for the requested changes:

- Login/session fan-out: [`apps/fe/src/auth/session-key-store.test.ts:246`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/session-key-store.test.ts:246).
- Sidebar mesh device states: [`apps/fe/src/components/page-layouts/components/sidebar-device-list.test.tsx:91`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-device-list.test.tsx:91).
- Device API paths and mutations: [`packages/api-client/src/devices.test.ts:37`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/devices.test.ts:37).
- Device form payloads: [`packages/panels/src/device-management/use-device-dialog-submit.test.ts:24`]( /Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-management/use-device-dialog-submit.test.ts:24).
- Node runtime/query isolation: [`apps/fe/src/node/node-runtime-boundary.test.tsx:1`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/node-runtime-boundary.test.tsx:1) and [`apps/fe/src/node/node-runtimes.test.ts:1`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/node-runtimes.test.ts:1).
- Backend auth codes, cookies, TOTP, and passkey registration requirements: [`apps/gateway/src/mesh/auth-routes.test.ts:851`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/auth-routes.test.ts:851), [`auth-routes.test.ts:923`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/auth-routes.test.ts:923), and [`auth-routes.test.ts:985`]( /Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/auth-routes.test.ts:985).