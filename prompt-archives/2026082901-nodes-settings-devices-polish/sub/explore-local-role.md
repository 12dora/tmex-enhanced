I could not write an output file: no destination path was supplied, and the workspace is read-only. The complete report is below.

# Local Node Card, Role Model, and Hub Address Model

## 1. Role and hub-address model

### Role values

The repository supports exactly three persisted role strings:

- `standalone`
- `node`
- `hub,node`

Evidence:

- `packages/app/src/lib/roles.ts:1-30`
- `apps/gateway/src/config.ts:74-90`

`hub,node` is the only hub-capable role. There is no `hub`-only value.

The parsed flags are:

```ts
standalone -> { hub: false, node: false }
node       -> { hub: false, node: true }
hub,node   -> { hub: true,  node: true }
```

### Environment variables

Installed production configuration is stored in:

```text
<installDir>/app.env
```

Evidence:

- `packages/app/src/lib/install-layout.ts:29-42`
- `packages/app/src/runtime/setup-service.ts:402-407`

Production loads only environment variables injected from `app.env`; it does not read repository env files:

- `packages/shared/src/env/load-env.ts:1-8`
- `packages/shared/src/env/load-env.ts:116-159`

Role/address variables:

| Variable | Meaning |
|---|---|
| `TMEX_ROLES` | Persisted role string. |
| `TMEX_HUB_URL` | Hub endpoint dialed by a node. |
| `TMEX_HUB_PUBLIC_URL` | Public address advertised by a hub. |
| `TMEX_NODE_ID` | Does not exist. Node ID is stored in `node_identity`. |
| `TMEX_MASTER_KEY` | Installation-wide encryption key; not hub-specific. |
| `TMEX_PEER_PORT` | Direct peer listener port. |
| `TMEX_STUN_SERVERS`, `TMEX_TURN_URL`, `TMEX_TURN_USERNAME`, `TMEX_TURN_CREDENTIAL` | Peer networking configuration. |
| `TMEX_DIRECT_ENABLED` | Installation-wide native direct-plugin flag. |

Environment defaults are defined by `packages/app/src/lib/install.ts:28-55`. Runtime reads the values in `apps/gateway/src/config.ts:133-187`.

Address selection:

- A normal node dials `TMEX_HUB_URL`.
- A hub-capable runtime uses `TMEX_HUB_PUBLIC_URL` first, then `TMEX_HUB_URL`.
- Evidence: `apps/gateway/src/mesh/mesh-runtime.ts:554-559`.

`becomeHub()` writes:

```text
TMEX_ROLES=hub,node
TMEX_HUB_PUBLIC_URL=<public URL>
```

It does not write `TMEX_HUB_URL`:

- `packages/app/src/runtime/setup-service.ts:603-645`

`joinHub()` writes:

```text
TMEX_ROLES=node
TMEX_HUB_URL=<joined hub URL>
```

It stages the env file, performs the join, then atomically promotes the staged file:

- `packages/app/src/runtime/setup-service.ts:648-718`

Because it merges the existing env, `TMEX_HUB_PUBLIC_URL` is not automatically cleared during a node join.

### `GET /api/local/status`

The route is implemented in:

- `packages/app/src/runtime/local-routes.ts:32-64`

Mesh roles require authentication; standalone does not:

- `packages/app/src/runtime/local-routes.ts:39-44`

Actual response shape:

```json
{
  "role": "standalone | node | hub,node",
  "nodeEnv": "development | test | production",
  "hubUrl": "string | null",
  "hubPublicUrl": "string | null",
  "direct": {
    "supported": true,
    "installed": true,
    "enabled": true,
    "capable": true,
    "version": "string | null",
    "platform": "string"
  },
  "tls": {
    "mode": "none | external | selfsigned | acme",
    "listenerRunning": true,
    "tlsPort": 9443
  }
}
```

`getLocalStatus()` constructs the role, addresses, direct-plugin state, and default TLS state:

- `packages/app/src/runtime/setup-service.ts:458-475`

The route replaces the TLS portion with the live TLS listener state:

- `packages/app/src/runtime/local-routes.ts:46-60`

The API client type is incomplete: `LocalTlsStatus` declares only `mode`, although the backend returns `listenerRunning` and `tlsPort`:

- `packages/api-client/src/local/types.ts:14-25`

### Setup endpoints

Routes:

- `POST /api/setup/precheck`
- `POST /api/setup/hub`
- `POST /api/setup/join`

Evidence:

- `packages/app/src/runtime/setup-routes.ts:24-73`

All three endpoints reject mesh roles with `404 not_standalone`:

- `packages/app/src/runtime/setup-routes.ts:29-34`
- `packages/app/src/runtime/setup-service.ts:204-208`

#### `POST /api/setup/hub`

Request:

```json
{
  "hubPublicUrl": "https://hub.example.com",
  "username": "admin",
  "password": "password",
  "directEnable": true
}
```

Response:

```json
{
  "ok": true,
  "fingerprint": "string",
  "direct": "enabled | failed | skipped",
  "directError": "string | null",
  "restarting": true
}
```

Types:

- `packages/app/src/runtime/setup-service.ts:88-101`
- `packages/api-client/src/local/types.ts:46-59`

It:

1. Creates the first local user.
2. Self-admits the local node.
3. Writes `TMEX_ROLES=hub,node`.
4. Writes `TMEX_HUB_PUBLIC_URL`.
5. Optionally installs/enables the native direct plugin.
6. Schedules restart.

Implementation:

- `packages/app/src/runtime/setup-service.ts:603-645`
- `apps/gateway/src/auth/user-key-service.ts:661-837`

#### `POST /api/setup/join`

Request:

```json
{
  "hubUrl": "https://hub.example.com",
  "token": "join-token",
  "name": "node-name",
  "directEnable": true,
  "insecureLocal": false
}
```

Response:

```json
{
  "ok": true,
  "hubUrl": "https://hub.example.com",
  "username": "alice",
  "direct": "enabled | failed | skipped",
  "directError": "string | null",
  "restarting": true
}
```

Types:

- `packages/app/src/runtime/setup-service.ts:103-118`
- `packages/api-client/src/local/types.ts:61-76`

The join implementation calls the shared `performHubJoin()` flow:

- `packages/app/src/runtime/setup-service.ts:688-703`
- `packages/app/src/commands/hub.ts:461-580`

### Restart mechanics

Setup transitions use `withSetupTransition()`:

- `packages/app/src/runtime/setup-service.ts:320-335`

After the operation succeeds, the assembled runtime schedules a restart after 300 ms. It calls the runtime shutdown handler or falls back to `process.exit(0)`:

- `packages/app/src/runtime/assemble.ts:215-225`

The generic restart endpoint is separate:

```text
POST /api/settings/restart
```

It schedules `runtimeController.requestRestart()` after 50 ms and returns:

```json
{
  "success": true,
  "message": "..."
}
```

Evidence:

- `apps/gateway/src/api/settings-routes.ts:54-63`
- `apps/gateway/src/api/settings-routes.ts:91-95`

`/healthz` exposes the process generation timestamp:

```json
{
  "status": "ok",
  "startedAt": 1234567890,
  "restarting": false,
  "env": "production",
  "tmux": {},
  "owner": {}
}
```

Evidence:

- `apps/gateway/src/api/system-routes.ts:68-97`

The frontend records `startedAt` before submitting setup, then waits for a changed value:

- `apps/fe/src/pages/settings/nodes/setup/submit.ts:1-50`
- `apps/fe/src/pages/settings/nodes/restart/wait-for-restart.ts:87-123`

`waitForRestart()` polls `/healthz` every second for up to 60 seconds. A changed `startedAt` is the success condition. If no previous timestamp was available, it requires one failed health probe followed by a healthy probe.

The normal restart button uses:

- `apps/fe/src/pages/settings/nodes/restart/use-restart-now.ts:85-114`

### Current transition matrix

#### Settings UI and setup API

| Transition | Current status |
|---|---|
| `standalone -> hub,node` | Supported by `/api/setup/hub`. |
| `standalone -> node` | Supported by `/api/setup/join`. |
| `hub,node -> standalone` | Not exposed. |
| `node -> standalone` | Not exposed. |
| `node -> hub,node` | Not supported; `becomeHub()` rejects non-standalone. |
| `hub,node -> hub,node` | No distinct role transition; `hub,node` is already hub-capable. |
| Change `TMEX_HUB_URL` while remaining `node` | Not exposed. |

#### CLI caveat

The CLI has lower-level paths not exposed by the Settings UI:

- `hub leave` writes `TMEX_ROLES=standalone`, clears `TMEX_HUB_URL`, and sets `node_identity.hubUrl` to `null`:
  - `packages/app/src/commands/hub.ts:794-807`
- `hub join` does not require standalone mode. It computes:
  - current hub role -> `hub,node`
  - otherwise -> `node`
  - `packages/app/src/commands/hub.ts:620-626`
- Tests explicitly cover joining a rebuilt hub from `TMEX_ROLES=node` without first running `hub leave`:
  - `packages/app/src/commands/join.test.ts:724-742`

Therefore, the reverse transitions do technically exist through CLI code, but they are not UI/API transitions and do not perform complete hub-membership cleanup.

`hub leave` also leaves `TMEX_HUB_PUBLIC_URL` untouched.

## 2. Local state tied to hub A

Migration and schema foundations:

- `apps/gateway/drizzle/0019_hub_auth.sql:1-130`
- `apps/gateway/drizzle/0020_node_identity_user.sql:1`
- `apps/gateway/drizzle/0022_hub_trust.sql:1-6`
- `apps/gateway/src/db/schema.ts:454-680`

### Persistent state inventory

| State | Hub-A relationship | Write path |
|---|---|---|
| `TMEX_ROLES` | Selects node/hub runtime behavior. | `setup-service.ts:633-636`, `setup-service.ts:671-681`, `hub.ts:268-275`. |
| `TMEX_HUB_URL` | Node’s outbound hub address. | `setup-service.ts:671-681`, `hub.ts:268-275`. |
| `TMEX_HUB_PUBLIC_URL` | Hub’s advertised public address; may become stale on a node because join/leave do not clear it. | `setup-service.ts:633-636`; no corresponding clear in `joinHub()` or `runHubLeave()`. |
| `node_identity` row | Persistent node ID, encrypted Ed25519/X25519 private keys, certificate JSON/signature, current hub URL, current user ID. | Schema `apps/gateway/src/db/schema.ts:601-614`; store `apps/gateway/src/auth/node-identity-store.ts:29-91`; creation `apps/gateway/src/auth/node-identity-service.ts:26-56`; join update `packages/app/src/commands/hub.ts:693-725`. |
| `hub_trust` row | CA pin for A, only when the join token contains a CA fingerprint. | Schema `apps/gateway/src/db/schema.ts:675-680`; write `packages/app/src/commands/hub.ts:565-571`. |
| Local `users` row | Yes. A normal join creates or replaces the local mirror of the hub user. | `apps/gateway/src/auth/user-key-service.ts:926-1016`. |
| `user_key_log` | Full replicated key-log history for A’s user. | `UserKeyService.commitJoin()` at `apps/gateway/src/auth/user-key-service.ts:637-658`; replay persistence at `:989-1005`. |
| `user_keys` | Replicated passkeys for the joined user. | `persistApplied()` at `apps/gateway/src/auth/user-key-service.ts:1175-1196`. |
| `node_sessions` | Local browser/device sessions for the mirrored A user. | Schema `apps/gateway/src/db/schema.ts:517-542`; cleanup helper `apps/gateway/src/auth/node-session-store.ts:141-143`. |
| `node_certs` | Certificates for all nodes in A’s user account, including the local node and peer nodes. | Schema `apps/gateway/src/db/schema.ts:544-559`; `admit-node` replay at `apps/gateway/src/auth/user-key-service.ts:1198-1210`. |
| `peer_cache` | A’s hub metadata and peer list. It has no hub URL column, so it is not scoped to A. | `apps/gateway/src/mesh/uplink-client.ts:650-723`; storage `apps/gateway/src/auth/user-store.ts:313-385,388-421`. |
| In-memory uplink state | Current `UplinkClient` points at A, holds connection/list/catch-up state, and is recreated after restart. | `apps/gateway/src/mesh/uplink-client.ts:159-235`; construction `apps/gateway/src/mesh/mesh-runtime.ts:763-785`. |
| `enrollment_tokens` | Normally stored on hub A, not locally, when a node creates an enrollment for another machine. | Non-hub path calls A’s API from `packages/app/src/commands/enroll.ts:340-381`. |
| Native direct plugin | Not hub-specific. It is installed under `<installDir>/native`. | `packages/app/src/lib/install-layout.ts:29-42`; install/remove `packages/app/src/commands/direct.ts:175-270`. |
| `tls_config` | Local HTTPS listener configuration, not A-specific. | Schema `apps/gateway/src/db/schema.ts:630-673`; TLS service `packages/app/src/runtime/assemble.ts:443-460`. |
| `TMEX_MASTER_KEY` | Installation encryption secret, not A-specific. It encrypts local private keys and credentials. | `apps/gateway/src/config.ts:133-145`; `apps/gateway/src/auth/node-identity-store.ts:56-86`. |

### Does `hub join` create local users?

Yes.

`performHubJoin()` receives the remote user, full key log, and node certificates:

- `packages/app/src/lib/hub-client.ts:36-55`
- `packages/app/src/commands/hub.ts:525-580`

`commitJoin()` replays and persists them:

- `apps/gateway/src/auth/user-key-service.ts:637-658`

`persistJoinReplay()` behavior:

1. If the remote user ID does not exist, it inserts a local `users` row.
2. If the user ID exists, it wipes local derived state and rebuilds it.
3. If the username belongs to another user ID, it wipes and deletes that stale username account.
4. It then replays all records and persists the node identity.

Evidence:

- `apps/gateway/src/auth/user-key-service.ts:952-1016`
- `apps/gateway/src/auth/user-key-service.ts:1107-1119`

The join test confirms that a rebuilt hub with the same username replaces the old local account:

- `packages/app/src/commands/join.test.ts:686-722`

### Node ID and certificates

There is no `TMEX_NODE_ID` environment variable.

`ensureNodeIdentity()` creates a random 16-byte node ID once and persists it in the singleton `node_identity` row:

- `apps/gateway/src/auth/node-identity-service.ts:26-56`

The private Ed25519 and X25519 keys are encrypted before storage:

- `apps/gateway/src/auth/node-identity-store.ts:56-86`

A normal join reuses the existing node identity and updates:

```text
node_identity.hubUrl = hub A
node_identity.userId = remote user ID
node_identity.certificateJson = admitted certificate
node_identity.certSig = admitted certificate signature
```

Evidence:

- `packages/app/src/commands/hub.ts:693-725`
- `apps/gateway/src/db/schema.ts:601-614`

### `hub_trust`

`hub_trust` is keyed by canonical hub URL:

```text
hub_url
ca_pem
fingerprint
created_at
```

Evidence:

- `apps/gateway/src/db/schema.ts:675-680`
- `apps/gateway/src/auth/hub-trust-store.ts:46-101`

It is written only when the join token includes a CA fingerprint:

- `packages/app/src/commands/hub.ts:489-491`
- `packages/app/src/commands/hub.ts:565-571`

At runtime, the trust row is used for the uplink TLS CA:

- `apps/gateway/src/mesh/mesh-runtime.ts:766-785`

`HubTrustStore.delete(hubUrl)` exists, but `hub leave` does not call it:

- `apps/gateway/src/auth/hub-trust-store.ts:92-101`
- `packages/app/src/commands/hub.ts:794-807`

### Peer cache and uplink state

The hub sends `node.list`. The node persists:

- hub metadata under the special `peer_cache.node_id = 'hub'`
- admitted peer nodes under their node IDs

Evidence:

- `apps/gateway/src/auth/user-store.ts:149-150,388-421`
- `apps/gateway/src/mesh/uplink-client.ts:650-723`

`peer_cache` is not scoped by hub URL. A hub switch must therefore clear the whole table, not only rows matching A.

The in-memory `UplinkClient` holds A’s URL and connection state:

- `apps/gateway/src/mesh/uplink-client.ts:159-235`

Disconnect only clears in-memory state; it does not delete persistent peer cache:

- `apps/gateway/src/mesh/uplink-client.ts:1185-1227`

### Enrollment state

A node running `hub join` does not create a local `enrollment_tokens` row.

When a non-hub node runs `enroll`, it:

1. Reads `TMEX_HUB_URL`.
2. Logs into A.
3. Calls A’s `POST /api/hub/enrollments`.
4. Receives a join token for another machine.

Evidence:

- `packages/app/src/commands/enroll.ts:318-381`

The `enrollment_tokens` row is therefore on A. A local node may still contain stale tokens from a previous hub role or account replacement.

### Existing cleanup/revoke paths

#### `hub leave`

Current behavior:

```text
node_identity.hubUrl <- null
TMEX_ROLES <- standalone
TMEX_HUB_URL <- ''
restart
```

Evidence:

- `packages/app/src/commands/hub.ts:262-275`
- `packages/app/src/commands/hub.ts:794-807`

It does not remove:

- `hub_trust`
- `users`
- `user_key_log`
- `user_keys`
- `node_sessions`
- `node_certs`
- `peer_cache`
- `nodes`
- `enrollment_tokens`
- node identity keys or node ID
- `TMEX_HUB_PUBLIC_URL`
- native direct plugin
- TLS configuration

The test explicitly confirms that the local user remains after `hub leave`:

- `packages/app/src/commands/join.test.ts:698-704`

#### `mesh reset-root`

`mesh reset-root` rebuilds the local root account and self-admits the local node:

- `packages/app/src/commands/mesh.ts:29-66`

It is destructive to local authentication state and does not represent a hub leave operation.

#### `hub user reset`

This is hub-wide registry cleanup:

```text
DELETE FROM nodes
DELETE FROM enrollment_tokens
```

It intentionally keeps `node_certs`:

- `packages/app/src/commands/hub.ts:445-458`

It is not suitable as a node-side leave operation.

#### Node revocation

The existing hub revocation path is:

```text
POST /api/hub/nodes/:id/revoke
```

It requires a signed `revoke-node` key-log record:

- `apps/gateway/src/hub/hub-runtime.ts:333-371`

Applying the record:

- marks `node_certs.revoked_log_seq`
- deletes that peer from `peer_cache`
- causes the hub to evict the live uplink
- marks the node row `status='revoked'`

Evidence:

- `apps/gateway/src/auth/user-key-service.ts:1211-1227`
- `apps/gateway/src/hub/uplink-server.ts:1186-1213`

`HubTrustStore.delete()`, `UserStore.deleteAllPeers()`, `NodeIdentityStore.clear()`, and the user-derived-state deletion helpers are reusable building blocks, but no existing command combines them into a complete membership reset.

## 3. Hub-side node lifecycle

### Existing hub APIs

The hub exposes:

```text
GET  /api/hub/nodes
POST /api/hub/nodes/:id/rename
POST /api/hub/nodes/:id/revoke
```

It also exposes enrollment endpoints and the uplink WebSocket:

- `apps/gateway/src/hub/hub-runtime.ts:167-216`

There is no:

```text
DELETE /api/hub/nodes/:id
POST /api/hub/nodes/:id/leave
POST /api/hub/nodes/self/leave
```

The browser client only implements list, rename, and enrollment operations:

- `apps/fe/src/node/hub-api.ts:63-112`

### Node stops connecting

When an uplink closes, the hub:

1. Removes the live registry entry.
2. Updates `nodes.last_seen_at`.
3. Broadcasts a node list.

It does not change `nodes.status` and does not delete the row:

- `apps/gateway/src/hub/uplink-server.ts:1171-1184`

The node list includes only rows whose status is `enrolled`, but computes `online` from the in-memory registry:

- `apps/gateway/src/hub/uplink-server.ts:1240-1309`

Therefore a stopped node remains enrolled but appears offline.

### Re-enrollment on another hub

Hub B has an independent database. It does not notify hub A.

On B:

- no existing node ID -> `nodes` row is created;
- same node ID, same user, matching keys -> existing row is patched/re-enrolled;
- different user or mismatched keys -> `node_exists`;
- revoked certificate or revoked node row -> `node_revoked`.

Evidence:

- `apps/gateway/src/hub/hub-runtime.ts:477-620`
- `apps/gateway/src/hub/hub-runtime.ts:643-687`

Hub A retains:

- its `nodes` row;
- its `node_certs` row;
- the user key log;
- any cached peer information.

There is no cross-hub cleanup protocol.

### Can a node ask hub A to delete itself?

Not through an existing self-leave API.

The current management API uses an authenticated user session and the revocation endpoint requires a root/passkey-signed `revoke-node` record:

- `apps/gateway/src/hub/hub-runtime.ts:244-250,333-371`

The UI deliberately disables revoking the current node:

- `apps/fe/src/pages/nodes/nodes-table.tsx:270-280`

A node can use the existing synchronized key-log path:

```text
POST /api/auth/keylog?hub=sync
```

with a signed record:

- `apps/gateway/src/mesh/auth-routes.ts:506-585`

However, that is cryptographic revocation, not physical deletion, and self-revocation is not currently exposed in the UI.

A plain remote delete would also be insufficient: if the certificate remains valid, `handleNodeStatus()` can recreate a missing `nodes` row when the node reconnects:

- `apps/gateway/src/hub/uplink-server.ts:774-825`

## 4. Frontend implementation

### Settings tab composition

`NodesTab`:

- reads shared auth mode with `useSharedAuthMode()`;
- reads local status with `useLocalStatus()`;
- treats `mode?.mode !== 'mesh'` as standalone;
- always renders `LocalMachineCard`.

Evidence:

- `apps/fe/src/pages/settings/nodes/nodes-tab.tsx:14-36`

Standalone renders:

```text
LocalMachineCard
HttpsSection(showHubUrlHint)
HubSetupWizard
```

Mesh renders:

```text
LocalMachineCard
HttpsSection
NodesManagement
```

Evidence:

- `apps/fe/src/pages/settings/nodes/nodes-tab.tsx:38-50`

### `LocalMachineCard`

File:

```text
apps/fe/src/pages/settings/nodes/local-machine-card.tsx
```

Props:

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

Evidence:

- `apps/fe/src/pages/settings/nodes/local-machine-card.tsx:39-53`

Role-to-i18n mapping:

```ts
standalone -> nodes.machine.roleStandalone
node       -> nodes.machine.roleNode
hub,node   -> nodes.machine.roleHub
```

Evidence:

- `apps/fe/src/pages/settings/nodes/local-machine-card.tsx:55-59`

Current state includes:

- `restartRequired`
- `directError`
- fetched direct status
- temporary optimistic direct-status override
- `DirectMutationController`
- `useRestartGateway()`

Evidence:

- `apps/fe/src/pages/settings/nodes/local-machine-card.tsx:194-240`

The role is read-only:

```tsx
<Badge>
  {t(ROLE_LABEL_KEY[status.role])}
</Badge>
```

The hub addresses are also read-only. They are rendered as `CopyableValue` components; the only action is copying:

- `apps/fe/src/pages/settings/nodes/local-machine-card.tsx:242-271`
- `apps/fe/src/pages/settings/nodes/local-machine-card.tsx:495-525`

Relevant i18n keys include:

```text
nodes.machine.title
nodes.machine.role
nodes.machine.roleStandalone
nodes.machine.roleNode
nodes.machine.roleHub
nodes.machine.hubUrl
nodes.machine.hubPublicUrl
nodes.machine.direct
nodes.machine.openNodesPage
nodes.machine.accountSecurity
nodes.machine.restartNow
nodes.machine.restarting
nodes.machine.restartTimeout
nodes.machine.directRestartRequired
nodes.actions.copy
nodes.actions.copied
```

There is no role selector, leave button, hub URL editor, join-code editor, or hub-switch action in the card.

### Local status query

`useLocalStatus()` uses React Query key:

```text
['local-status']
```

It treats mesh `401` as `loginRequired` rather than as a load error:

- `apps/fe/src/pages/settings/nodes/use-local-status.ts:11-51`

### `HubSetupWizard`

The wizard is explicitly standalone-only:

- `apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.tsx:38-48`

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

Evidence:

- `apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.tsx:15-25`

It offers two paths:

- `nodes.setup.path.becomeHub.*`
- `nodes.setup.path.joinHub.*`

It wires:

- `BecomeHubForm`
- `JoinHubForm`

Evidence:

- `apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.tsx:49-99`

Both forms:

1. Capture the old `/healthz.startedAt`.
2. Call the setup API.
3. Wait for restart.
4. Default to navigating to `/login`.

Become-hub form:

- `apps/fe/src/pages/settings/nodes/setup/become-hub-form.tsx:54-120`

Join form:

- `apps/fe/src/pages/settings/nodes/setup/join-hub-form.tsx:37-90`

Join fields:

```text
nodes.setup.fields.hubUrl
nodes.setup.fields.token
nodes.setup.fields.name
nodes.setup.fields.directEnable
nodes.setup.fields.insecureLocal
```

Evidence:

- `apps/fe/src/pages/settings/nodes/setup/join-hub-form.tsx:113-203`

### HTTPS section

`HttpsSection` is not role-aware. It has no role prop or role guard:

- `apps/fe/src/pages/settings/nodes/https/https-section.tsx:41-77`

`NodesTab` renders it for both standalone and mesh roles:

- `apps/fe/src/pages/settings/nodes/nodes-tab.tsx:38-48`

`showHubUrlHint` is only enabled in standalone mode:

```tsx
<HttpsSection showHubUrlHint />
```

The hint key is:

```text
nodes.https.hubUrlHint
```

Evidence:

- `apps/fe/src/pages/settings/nodes/nodes-tab.tsx:40-43`
- `apps/fe/src/pages/settings/nodes/https/https-section.tsx:121-141`

The section manages local TLS modes:

```text
none
external
selfsigned
acme
```

It displays:

- current mode;
- listener state;
- certificate subject/SAN/issuer/expiry;
- restart-required state.

Evidence:

- `apps/fe/src/pages/settings/nodes/https/https-section.tsx:199-240,315-372`

Backend TLS authorization allows unauthenticated standalone access and requires authentication for mesh roles:

- `packages/app/src/runtime/assemble.ts:443-460`

HTTPS is therefore a local service/listener concern for all roles. It is not the source of a node’s hub-A CA pin.

For a node, hub-A trust is stored in `hub_trust` and consumed by the uplink/hub fetcher:

- `apps/gateway/src/mesh/mesh-runtime.ts:766-785`
- `packages/app/src/lib/hub-client.ts:63-77`

## 5. Proposed design

### A. Add an explicit local leave/cleanup API

Add:

```text
POST /api/local/membership/leave
```

Authentication:

- standalone: idempotent no-op or local cleanup;
- mesh: require the existing local authentication/session mechanism;
- destructive cleanup: require an explicit reauthentication or signed confirmation.

Request:

```json
{
  "expectedHubUrl": "https://hub-a.example.com",
  "cleanup": "detach | forget",
  "remotePolicy": "best-effort | required"
}
```

Recommended response:

```json
{
  "ok": true,
  "fromRole": "node",
  "role": "standalone",
  "oldHubUrl": "https://hub-a.example.com",
  "remote": {
    "attempted": true,
    "outcome": "revoked | unreachable | not_needed | not_confirmed"
  },
  "cleanup": {
    "hubTrust": "removed",
    "peerCache": "cleared",
    "identity": "detached",
    "localAccount": "preserved | deleted"
  },
  "restarting": true
}
```

The endpoint should:

1. Verify `expectedHubUrl` matches the current local membership.
2. Stop or quiesce the uplink.
3. Perform best-effort remote self-revocation.
4. Clear hub-specific local state in one DB transaction.
5. Write:
   ```text
   TMEX_ROLES=standalone
   TMEX_HUB_URL=''
   TMEX_HUB_PUBLIC_URL=''
   ```
6. Schedule the normal restart.

### Remote leave semantics

Do not implement remote cleanup as a plain row delete.

Preferred approach: reuse the existing signed key-log revocation path:

```text
POST /api/auth/keylog?hub=sync
```

with a `revoke-node` record targeting the local node. The current frontend self-revoke prohibition should be bypassed only for an explicit “Leave hub” flow.

The hub then:

- marks `node_certs.revoked_log_seq`;
- removes the peer cache entry;
- evicts the live connection;
- marks `nodes.status='revoked'`.

If a true self-service endpoint is required, add a challenge/proof-based endpoint such as:

```text
POST /api/hub/nodes/self/leave
```

It must create a durable revocation/tombstone. A physical delete without revocation allows `handleNodeStatus()` to recreate the row.

### Local cleanup policy

`cleanup: "detach"`:

- clear `hub_trust` for A;
- clear all `peer_cache`;
- detach `node_identity.hubUrl`;
- clear `node_identity.userId` only if the local account is no longer active;
- preserve local users/passkeys for a role-only switch;
- retain native direct-plugin files and TLS configuration.

`cleanup: "forget"` for A-to-B membership switching:

- delete A’s `user_key_log`;
- delete A’s `user_keys`;
- delete A’s `node_sessions`;
- delete A’s `node_certs`;
- delete A’s `nodes`;
- delete A’s `enrollment_tokens`;
- delete the A `users` row;
- clear all `peer_cache`;
- delete A’s `hub_trust` row;
- preserve the node ID and private keys unless a fresh identity is explicitly requested;
- reset `node_identity` certificate/user fields while retaining the key pair.

The existing helper is a useful starting point:

```text
apps/gateway/src/auth/user-key-service.ts:1107-1119
```

The cleanup must additionally delete the user row, clear trust, clear peer cache, and reset the node identity fields.

### B. Frontend role-switch flow

Add actions to `LocalMachineCard`:

```text
Switch to standalone
Change hub
Become hub
Join another hub
```

Keep the role badge and current hub address read-only. Actions should open explicit destructive confirmation dialogs.

Flow for `standalone -> hub,node`:

1. Open existing `BecomeHubForm`.
2. Call existing `POST /api/setup/hub`.
3. Wait for `/healthz.startedAt` to change.
4. Reload/login.

Flow for `standalone -> node`:

1. Open existing `JoinHubForm`.
2. Call existing `POST /api/setup/join`.
3. Wait for restart.
4. Reload/login.

Flow for `node -> standalone`:

1. Require reauthentication.
2. Attempt signed self-revocation against A.
3. Call `POST /api/local/membership/leave`.
4. Wait for restart.
5. Reload to standalone mode.

Flow for `node A -> node B`:

1. Require explicit confirmation that the A account and local mirrored credentials will be removed.
2. Best-effort revoke the local node on A.
3. Call `POST /api/local/membership/leave` with `cleanup:"forget"`.
4. Wait for restart into standalone.
5. Show the existing `JoinHubForm`.
6. Join B using the existing join code.
7. Wait for the second restart.
8. Reload/login.

Do not store the join token or password in persistent browser storage. A temporary `sessionStorage` marker may remember the intended post-restart screen, but the credentials should be re-entered.

### Risks

- Remote A may be unreachable, leaving a ghost enrolled/revocable node record.
- Deleting the local A user removes passkeys, TOTP state, sessions, key-log history, and mirrored node certificates.
- Reusing the same node ID after A revoked it is safe for B but will continue to fail against A with `node_revoked`.
- A failed join after local cleanup can leave the machine standalone and require a new login/setup.
- Existing `TMEX_HUB_PUBLIC_URL` can remain stale unless explicitly cleared.
- `peer_cache` is global rather than hub-scoped; partial cleanup can expose stale peers.
- `hub,node` is a combined role. Switching it to `node` may disable the local hub while the machine is also its own hub-side node.
- The current browser session may become invalid as soon as `node_sessions` or the mirrored user is removed.
- Concurrent role changes must use the existing setup transition lock; otherwise two env/database transitions can interleave.
- A plain remote node-row delete is unsafe because a still-valid certificate can cause the hub to recreate the node row on reconnect.
