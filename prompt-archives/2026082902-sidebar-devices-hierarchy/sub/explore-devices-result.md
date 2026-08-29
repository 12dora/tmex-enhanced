# tmex Devices management code map

Line references use the current working tree.

## 1. Global “+” flow and likely failure points

- `apps/fe/src/page-wrapper.tsx:36-56` renders the sticky page header and top-right `PageActions`.
- `apps/fe/src/pages/DevicesPage.tsx:36-68`:
  - `useAddDeviceTargets()` reads ready node targets.
  - More than one target renders `AddDeviceMenu`.
  - One target passes its `open` callback to `DeviceManagementActions`.
  - Zero targets uses the legacy global-event path.
- `apps/fe/src/pages/devices/add-device-targets.ts:27-65` is a module-level registry used because header and page content are separate React subtrees.
- `apps/fe/src/pages/devices/add-device-menu.tsx:15-50` opens a node-selection menu; selecting an item directly calls `target.open`.
- `packages/panels/src/device-management/events.ts:2` defines `OPEN_ADD_DEVICE_EVENT = 'tmex:open-add-device'`.
- `packages/panels/src/device-management/device-management-actions.tsx:12-37`:
  - Calls `onAddDevice?.()` when supplied.
  - Otherwise dispatches `new CustomEvent(OPEN_ADD_DEVICE_EVENT)`.
- `apps/fe/src/pages/devices/node-device-group.tsx:183-217`:
  - Ready node groups register `panelRef.current?.openAddDevice`.
  - Only the self panel has `listenOpenAddDeviceEvent={true}`; remote panels disable the global listener.
- `packages/panels/src/device-management/device-management-panel.tsx:48-85` subscribes to the event and exposes `openAddDevice()` through a ref.
- `packages/panels/src/device-management/device-management-panel.tsx:194-200` renders `DeviceDialog mode="create"` after `showAddModal` becomes true.
- `packages/panels/src/device-management/device-dialog.tsx:28-80` creates form state and renders the dialog. `packages/panels/src/device-management/use-device-dialog-submit.ts:66-120` performs the mutation.

Failure analysis:

- Normal application routes provide the required contexts:
  - `apps/fe/src/main.tsx:198-257` wraps routes in `NodeRuntimeBoundary`.
  - `apps/fe/src/main.tsx:269-279` provides the self runtime and React Query client.
  - `apps/fe/src/node/node-runtime-scope.tsx:18-26` provides per-node runtime/query contexts for mesh panels.
- A missing provider is the clearest actual crash source in isolated tests/embeddings:
  - `packages/stores/src/react.tsx:57-62` throws if `<RuntimeProvider>` is absent.
  - `DeviceManagementPanel` calls `useRuntime()` and `useQueryClient()` at `device-management-panel.tsx:72-78`.
  - Dialog submission calls both at `use-device-dialog-submit.ts:36-38,72-75`.
- A click during initial page loading can silently do nothing, not crash: `PageWrapper` renders the header before `DevicesPage` mounts its panel; `DevicesPage.tsx:39-45` returns only a spinner while the auth mode is loading.
- `panelRef.current?.openAddDevice()` at `node-device-group.tsx:186` is null-safe, so a missing ref is a no-op.
- No hook-order issue is apparent: conditional SSH rendering is JSX only; hooks are not conditionally called.
- Required keys exist in locale files and generated types; missing i18n keys are unlikely to cause a crash. See section 7.

## 2. Duplicate “Local Device” label

Both sites are in `packages/panels/src/device-management/device-card.tsx`:

- Header subtitle: `device-card.tsx:49-52`, rendered at `device-card.tsx:81-83`.
- Type pill: `device-card.tsx:135-138`.

The header title itself is the device name; the first label is the second line beneath it.

## 3. Device type versus remote mesh node

Shared type definition:

- `packages/shared/src/contracts/devices.ts:1-24`
  - `DeviceType = 'local' | 'ssh'`.
  - No `remote-node` type.
  - No node ownership field.
  - Includes `sortOrder`, but no group/folder/tag field.

Database schema:

- `apps/gateway/src/db/schema.ts:97-124`
  - `id`, `name`, `type`, `host`, `port`, `username`, `sshConfigRef`, `session`, `authMode`.
  - Encrypted password/key/passphrase columns.
  - `defaultWorkingDir`, `sortOrder`, timestamps.
  - DB checks restrict `type` to `local`/`ssh` and `authMode` to `password`/`key`/`agent`/`configRef`/`auto`.
- `apps/gateway/src/db/schema.ts:126-134` stores runtime status separately in `device_runtime_status`.

Persistence and API:

- `apps/gateway/src/db/devices.ts:50-92` inserts the supplied `device.type`; new devices are ordered by `sortOrder`.
- `apps/gateway/src/db/devices.ts:95-112` returns devices ordered by `sortOrder`.
- `apps/gateway/src/db/mappers.ts:37-55` copies `row.type` directly into the API `Device`.
- `apps/gateway/src/api/device-routes.ts:67-105` accepts `body.type` directly and creates the DB record.
- `apps/gateway/src/api/device-routes.ts:54-65` returns `{ devices }` with runtime status fields added.
- `packages/api-client/src/devices.ts:13-31` defines `DeviceWithRuntime` and fetches `/api/devices`.

Connection implementation confirms the meaning:

- `apps/gateway/src/tmux-client/device-session-runtime.ts:111-117` selects local tmux versus SSH based only on `device.type`.
- `apps/gateway/src/tmux-client/local-external-connection.ts:186-200` requires `type === 'local'`.
- `apps/gateway/src/tmux-client/ssh-external-connection.ts:75-90` requires `type === 'ssh'`.

Mesh nodes are a separate model:

- `packages/api-client/src/auth/types.ts:139-160` defines `MeshNode`, including `id`, `online`, `inventory`, `loggedIn`, and `isHub`.
- `apps/gateway/src/mesh/mesh-routes.ts:35-47,211-290` constructs node metadata.
- `apps/fe/src/pages/devices/node-device-group.tsx:25-70` maps mesh nodes to runtime groups.
- `apps/fe/src/node/node-runtimes.ts:191-258` creates one runtime per node.
- `packages/api-client/src/node-url.ts:49-53,160-163` scopes remote requests under `/n/<nodeId>`.
- `apps/gateway/src/mesh/forwarder.ts:100-113,142-153,432-490` forwards `/n/<nodeId>/api/...` to the remote node.

Therefore:

- An SSH device is a remote host configured in the current node’s device DB.
- A device belonging to a remote mesh node is still `type: 'local'` if it is local to that remote node.
- Remote mesh ownership is represented by the runtime/node URL, not by `Device.type`.
- There is no `nodeId` in the device DB row or API response.
- The card correctly displays `device.type`; it has no information from which to derive “remote mesh node”.

## 4. Connect/disconnect behavior

Management-card connect button:

- `packages/panels/src/device-management/device-card.tsx:85-91` is only a React Router `<Link>` to `/devices/:deviceId`.
- It does not call a connection API directly.

Connection abstraction:

- `packages/panels/src/device-connection.ts:1-14` defines status and the `connect`/`disconnect` adapter methods.
- `apps/fe/src/components/global-device-provider.tsx:186-217,243-282` builds the adapter.
- `apps/fe/src/components/global-device-provider.tsx:164-180`:
  - `connect()` marks connect intent, clears errors, then calls the tmux store.
  - `disconnect()` marks disconnect intent, then calls the tmux store.
- `packages/stores/src/tmux.ts:154-188`:
  - `connectDevice()` sends the WebSocket command `{ type: 'connect-device' }`.
  - `disconnectDevice()` sends `{ type: 'disconnect-device' }` and clears local subscriptions/state.
- There is no REST connect/disconnect endpoint.
- `POST /api/devices/:id/test-connection` is only a connection test: `apps/gateway/src/api/device-routes.ts:190-193`; client wrapper `packages/api-client/src/devices.ts:96-109`.

Sidebar behavior:

- `packages/panels/src/device-tree/device-connection-control.tsx:25-45` is only a colored status dot; despite its name, it has no click handler and no disconnect button.
- `packages/panels/src/device-tree/device-row-header.tsx:47-48` renders that dot.
- `packages/panels/src/device-tree/sidebar-device-list.tsx:170-180` calls `connection.connect(deviceId)` when a device is expanded.
- `sidebar-device-list.tsx:184-210` also auto-subscribes visible/selected devices.
- `apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx:34-45` passes the provider’s adapter into the sidebar.
- The adapter exposes `disconnect()`, but there is no current end-user sidebar call site for it; the current UI primarily connects on expansion and disconnect is available programmatically.

## 5. Edit dialog fields and device types

Always shown:

- `packages/panels/src/device-management/device-basic-fields.tsx:56-110`
  - Name.
  - Type (`local` or `ssh`).
  - Tmux session.
  - Default working directory.
- Type selection is disabled in edit mode: `device-basic-fields.tsx:33-40`.

SSH-only:

- `packages/panels/src/device-management/device-dialog.tsx:54-62` conditionally renders SSH sections.
- `packages/panels/src/device-management/device-ssh-connection-fields.tsx:36-74`
  - Host.
  - Port.
  - Username.
- `packages/panels/src/device-management/device-auth-fields.tsx:132-144`
  - Authentication mode.
  - Password, private key/passphrase, or SSH config reference depending on mode.

Auth options:

- `device-auth-fields.tsx:15-46` exposes `password`, `key`, `agent`, and `configRef`.
- Shared `AuthMode` also includes `auto`: `packages/shared/src/contracts/devices.ts:3-4`.
- `auto` is used for local devices and as the initial form default (`device-form.ts:25-58`), but is not an explicit SSH select option. Existing SSH records with `authMode: 'auto'` can therefore render without a matching label.

Payload behavior:

- `packages/panels/src/device-management/device-form.ts:61-99`:
  - Local create sends only local/session/working-directory fields and `authMode: 'auto'`.
  - SSH create sends host, port, username, auth mode, and relevant secret/config fields.
- `device-form.ts:101-133` builds edit payloads.
- `device-form.ts:144-160` validates SSH host, port, username, and config reference.

## 6. Grouping, hierarchy, schema, migrations, and CRUD pattern

No persisted device groups/folders/tags/categories were found.

Existing ordering only:

- `packages/shared/src/contracts/devices.ts:20-21` has `sortOrder`.
- `apps/gateway/src/db/schema.ts:113` stores `devices.sort_order`.
- `packages/panels/src/device-tree/sidebar-device-list.tsx:212-243` sorts and submits the complete device order.
- `packages/api-client/src/devices.ts:81-94` wraps `PUT /api/devices/order`.
- `apps/gateway/src/db/schema.ts:360-369` defines `device_tree_order`, but it stores window/pane display order, not device groups.
- `apps/fe/src/pages/devices/node-device-group.tsx:1-8,25-70` provides runtime mesh-node sections; these are not DB-backed device groups.

Migration mechanism:

- Migrations live in `apps/gateway/drizzle/`, currently `0000_...sql` through `0023_...sql`, plus `meta/_journal.json`.
- `apps/gateway/drizzle.config.ts:3-9` configures Drizzle SQLite schema generation.
- `apps/gateway/package.json:22-23`:
  - `bun run db:generate`
  - `bun run db:migrate`
- `apps/gateway/src/db/migrate.ts:6-23` resolves the migration directory using `TMEX_MIGRATIONS_DIR`, current-working-directory `drizzle`, or the repository fallback.
- `apps/gateway/src/runtime.ts:63-80` runs migrations at gateway startup.
- `apps/gateway/src/db/managed-migrations.ts:7-32,62-75` has an explicit managed-runtime migration list; a new migration must be added there.
- `apps/gateway/scripts/build-managed.ts:56-61` embeds all SQL migrations.
- `packages/app/scripts/bundle-resources.sh:8-28` copies gateway migrations into the CLI package’s `resources/gateway-drizzle`.
- `packages/app/src/lib/local-auth.ts:42-50,131-150` resolves and applies installed migrations.
- `packages/app/src/lib/install-layout.ts:89-109` defines the installed migration resource path.

For a new `device_groups` feature, the closest existing pattern is:

1. Add Drizzle schema in `apps/gateway/src/db/schema.ts`.
2. Generate the next numbered migration with `bun run db:generate`; do not hand-edit generated snapshots.
3. Add the migration to `apps/gateway/src/db/managed-migrations.ts`.
4. Add DB helpers and re-exports in `apps/gateway/src/db/<feature>.ts` and `apps/gateway/src/db/index.ts:8-23`.
5. Add a route module modeled on `apps/gateway/src/api/device-routes.ts`.
6. Register it in `apps/gateway/src/api/index.ts:26-51`.
7. Add a client wrapper modeled on `packages/api-client/src/devices.ts`.

API/validation pattern:

- `apps/gateway/src/api/route.ts:37-45,78-93` defines the lightweight typed route table and dispatcher.
- `apps/gateway/src/api/device-routes.ts:167-195` declares device routes.
- Device POST uses manual checks: `device-routes.ts:67-76`.
- PATCH uses `readJsonObjectBody()` plus internal field parsers, not an external validation library:
  - `apps/gateway/src/api/http.ts:21-31`
  - `apps/gateway/src/api/device-patch.ts:62-80`
  - `apps/gateway/src/api/config-field.ts`
- `packages/api-client/src/devices.ts:26-109` wraps relative `/api/...` calls using the injected `ApiClient`; remote-node clients automatically prepend `/n/<nodeId>`.

## 7. i18n

Locale sources:

- `packages/shared/src/i18n/locales/en_US.json`
- `packages/shared/src/i18n/locales/zh_CN.json`
- `packages/shared/src/i18n/locales/ja_JP.json`
- Manifest: `packages/shared/src/i18n/locales/manifest.json`

Namespaces:

- `translation.device.*`: `en_US.json:54-125`
  - Includes `typeLocal`, `typeSSH`, dialog fields, auth labels, connect labels, sidebar labels, and add-to-node labels.
- `translation.sidebar.*`: `en_US.json:681-696`
  - Includes `sidebar.manageDevices` and `sidebar.addDevice`.
- `translation.devices.nodes.*`: `en_US.json:1564-1577`
  - Includes mesh-node status, inventory, and `devices.nodes.addDevice`.
- Generated key list:
  - `packages/shared/src/i18n/types.ts:67-135`
  - `types.ts:680` includes `sidebar.addDevice`.
  - `types.ts:1459` includes `devices.nodes.addDevice`.
- Generated resources: `packages/shared/src/i18n/resources.ts:1-5`; do not edit directly.

Build command:

- Root: `package.json:11-13` — `bun run build:i18n`.
- Implementation: `packages/shared/scripts/build-i18n.ts:5-20,103-142`.
- Package script: `packages/shared/package.json:16-18`.

## 8. Test and tsc baseline

Sequential runs of the requested commands:

| Package | `bun test src/` | `bunx tsc --noEmit -p .` |
|---|---:|---|
| `packages/panels` | 389 pass, 0 fail, 29 files | No diagnostics; exit 0 |
| `packages/stores` | 275 pass, 0 fail, 27 files | 1 error: `src/host-services.test.ts:93:23`, mocked object lacks property `value` |
| `apps/fe` | 578 pass, 0 fail, 45 files | No diagnostics; exit 0 |

The requested `| tail -N` pipelines report shell exit code 0 because `tail` is the final process; the raw sequential tsc run confirms the stores error.