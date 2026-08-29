# Backend implementation report: hub/node management and built-in TLS

Read-only exploration completed. No repository files were modified.

## 1. Process and runtime assembly

### Production entrypoint

The installed production process is not `apps/gateway/src/index.ts`.

`packages/app/package.json:19` defines `build:runtime` through `scripts/build-runtime.ts`. The build script invokes Bun with `packages/app/src/runtime/server.ts` as the runtime entry and writes:

```text
dist/runtime/server.js
```

See [`packages/app/scripts/build-runtime.ts:198`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/scripts/build-runtime.ts:198).

The generated `run.sh` executes that file:

```text
exec <bunPath> <installLayout.runtimeServerPath>
```

See [`packages/app/src/lib/install.ts:129`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/lib/install.ts:129).

Therefore production uses:

```text
packages/app/src/runtime/server.ts
  -> dist/runtime/server.js
```

`apps/gateway/src/index.ts` is a gateway-only development/test-style entrypoint.

### Environment loading

Both entrypoints import their bootstrap loader before importing configuration:

- [`packages/app/src/runtime/bootstrap-env.ts:1`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/runtime/bootstrap-env.ts:1)
- [`apps/gateway/src/bootstrap-env.ts:1`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/bootstrap-env.ts:1)

They load `packages/shared/src/env/load-env.ts`.

In production, `loadEnv()` does not read a repository `.env` file. It validates the already-injected process environment and requires:

```text
TMEX_MASTER_KEY
GATEWAY_PORT
TMEX_BIND_HOST
DATABASE_URL
TMEX_FE_DIST_DIR
TMEX_MIGRATIONS_DIR
```

See [`packages/shared/src/env/load-env.ts:20`](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/env/load-env.ts:20) and [`packages/shared/src/env/load-env.ts:129`](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/env/load-env.ts:129).

Development/test mode reads repository `development.env` / `test.env`, with optional `.local` overrides. See [`packages/shared/src/env/load-env.ts:161`](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/env/load-env.ts:161).

### `packages/app` production assembly

`packages/app/src/runtime/server.ts` performs:

```ts
const host = process.env.TMEX_BIND_HOST || '127.0.0.1';
const port = Number(process.env.GATEWAY_PORT || '9883');
const staticRoot = resolveStaticRoot();
const assembled = await assembleTmex({ staticRoot });
```

See [`packages/app/src/runtime/server.ts:21`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/runtime/server.ts:21).

It then creates the current single listener:

```ts
const server = Bun.serve({
  hostname: host,
  port,
  fetch: assembled.fetch,
  websocket: assembled.websocket,
});
```

See [`packages/app/src/runtime/server.ts:29`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/runtime/server.ts:29).

`assembleTmex()` creates the gateway first. If `roles.node` is true, it creates `MeshRuntime` using the gateway database and loads the native RTC module from `TMEX_NATIVE_DIR`. See [`packages/app/src/runtime/assemble.ts:109`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/runtime/assemble.ts:109).

Role interpretation is defined in [`apps/gateway/src/config.ts:74`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/config.ts:74):

```ts
standalone -> { hub: false, node: false }
node       -> { hub: false, node: true }
hub,node   -> { hub: true, node: true }
```

A hub runtime is created inside `MeshRuntime` when `roles.hub` is true. See [`packages/app/src/runtime/assemble.ts:151`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/runtime/assemble.ts:151) and [`apps/gateway/src/mesh/mesh-runtime.ts:607`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-runtime.ts:607).

### Gateway-only entrypoint

`apps/gateway/src/index.ts` independently creates a `GatewayRuntime` and one `Bun.serve` listener:

```ts
const gateway = await createGatewayRuntime({
  systemApiHandler: handleSystemApiRequest,
});

const server = Bun.serve({
  hostname: config.bindHost,
  port: config.port,
  idleTimeout: 255,
  fetch: (request, bunServer) => gateway.handleRequest(request, bunServer),
  websocket: gateway.websocket,
});
```

See [`apps/gateway/src/index.ts:14`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/index.ts:14) and [`apps/gateway/src/index.ts:15`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/index.ts:15).

It restarts in-process:

```ts
gateway.onRestartRequested(async () => {
  await gateway.stop();
  server.stop(true);
  resolve();
});

while (true) {
  await run();
}
```

See [`apps/gateway/src/index.ts:33`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/index.ts:33).

This path does not create `MeshRuntime` or `HubRuntime`.

### Restart behavior

`GatewayRuntime.onRestartRequested()` delegates to the process-wide `runtimeController`:

```ts
onRestartRequested(listener: () => Promise<void> | void): void;
```

See [`apps/gateway/src/runtime.ts:34`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/runtime.ts:34) and [`apps/gateway/src/runtime.ts:189`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/runtime.ts:189).

The controller prevents duplicate requests:

```ts
async requestRestart(): Promise<void> {
  if (this.restarting) return;
  this.restarting = true;
  await this.listener?.();
}
```

See [`apps/gateway/src/control/runtime.ts:13`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/control/runtime.ts:13).

The existing restart API schedules restart after returning the HTTP response:

```ts
setTimeout(() => {
  void runtimeController.requestRestart();
}, 50);

return json({ success: true, message: t('settings.restartScheduled') });
```

See [`apps/gateway/src/api/settings-routes.ts:54`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/api/settings-routes.ts:54).

The setup API should use the same delayed pattern after rewriting `app.env`.

For the production app runtime, `createProcessShutdown()` calls `assembled.stop()`, then exits with code `0` on success. See [`packages/app/src/runtime/assemble.ts:349`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/runtime/assemble.ts:349).

Shutdown order:

1. `MeshRuntime.stop()`
2. `HubRuntime.stop()`
3. `GatewayRuntime.stop()`
4. HTTP server stop

See [`packages/app/src/runtime/assemble.ts:303`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/runtime/assemble.ts:303).

Inside `MeshRuntime`, the order is peer manager, uplink, HTTP runtime, RTC, then bulk transport. See [`apps/gateway/src/mesh/mesh-runtime.ts:1287`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-runtime.ts:1287).

### Second HTTPS listener

The natural insertion point is immediately beside the existing `Bun.serve()` in `packages/app/src/runtime/server.ts`, after `assembleTmex()` and before `assembled.start()`:

- primary listener: [`packages/app/src/runtime/server.ts:29`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/runtime/server.ts:29)
- runtime startup: [`packages/app/src/runtime/server.ts:36`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/runtime/server.ts:36)

The second listener should use the decrypted TLS material and a separate port. If it must serve `/mesh/ws` or WSS uplinks, it also needs `assembled.websocket`; otherwise only the HTTP fetch handler is required.

The shutdown callback must stop both listeners after `assembled.stop()`:

```text
await assembled.stop()
plainServer.stop(true)
httpsServer.stop(true)
process.exit(0)
```

No TLS listener currently exists in the repository.

## 2. Locating `app.env` and `installDir`

### Install layout

`createInstallLayout(installDir)` defines:

```text
<installDir>/runtime/server.js
<installDir>/resources/fe-dist
<installDir>/resources/gateway-drizzle
<installDir>/native
<installDir>/app.env
<installDir>/run.sh
<installDir>/install-meta.json
```

See [`packages/app/src/lib/install-layout.ts:29`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/lib/install-layout.ts:29).

The generated service sets its working directory to `installDir`, both for systemd and launchd. See [`packages/app/src/lib/service.ts:45`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/lib/service.ts:45).

### Environment variables

`buildAppEnvValues()` writes the core app environment:

```text
NODE_ENV
TMEX_BIND_HOST
GATEWAY_PORT
DATABASE_URL
TMEX_MASTER_KEY
TMEX_BASE_URL
TMEX_SITE_NAME
TMEX_ROLES
TMEX_HUB_URL
TMEX_PEER_PORT
TMEX_HUB_PUBLIC_URL
TMEX_STUN_SERVERS
```

See [`packages/app/src/lib/install.ts:45`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/lib/install.ts:45).

The generated `run.sh` additionally exports:

```text
TMEX_FE_DIST_DIR
TMEX_MIGRATIONS_DIR
TMEX_NATIVE_DIR
```

See [`packages/app/src/lib/install.ts:117`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/lib/install.ts:117).

There is no existing `TMEX_INSTALL_DIR` variable in the application source. `TMEX_NATIVE_DIR` is injected by `run.sh`; `loadNodeDatachannel()` also sets it after successfully loading the native module. See [`packages/app/src/lib/native-datachannel.ts:135`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/lib/native-datachannel.ts:135).

### Existing gateway helper

The gateway already has:

```ts
export function resolveInstallDir(): string {
  const feDist = process.env.TMEX_FE_DIST_DIR;
  if (feDist) return resolve(feDist, '..', '..');
  return process.cwd();
}
```

See [`apps/gateway/src/system/install-info.ts:26`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/system/install-info.ts:26).

This is the correct existing helper for locating the production install directory:

```text
TMEX_FE_DIST_DIR=<installDir>/resources/fe-dist
                         -> <installDir>
```

Otherwise the service working directory is used.

The setup API can therefore locate:

```text
join(resolveInstallDir(), 'app.env')
```

or construct the same layout through `createInstallLayout()` if the install package is made reusable.

### Existing app.env read/modify/write helpers

The generic helpers are in [`packages/app/src/lib/env-file.ts:4`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/lib/env-file.ts:4):

```ts
parseEnvContent(content: string): Record<string, string>;
stringifyEnv(values: Record<string, string>): string;
readEnvFile(filePath: string): Promise<Record<string, string>>;
writeEnvFile(filePath: string, values: Record<string, string>): Promise<void>;
```

`writeEnvFile()` uses a temporary file and atomic rename, with mode `0600`. See [`packages/app/src/lib/env-file.ts:86`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/lib/env-file.ts:86).

The existing hub-specific wrapper is:

```ts
async function writeRolesAndHubUrl(
  envPath: string,
  roles: string,
  hubUrl: string,
): Promise<void>
```

See [`packages/app/src/commands/hub.ts:109`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/hub.ts:109).

It reads all existing values, changes only `TMEX_ROLES` and `TMEX_HUB_URL`, then writes the complete map. This preserves other key/value pairs, but `stringifyEnv()` sorts keys and does not preserve comments or blank lines.

For the setup API, reuse the same read/modify/write pattern and add:

```text
TMEX_ROLES
TMEX_HUB_PUBLIC_URL
TMEX_HUB_URL
<new TLS keys>
```

Because `packages/app` is currently the owner of this helper and `apps/gateway` does not depend on it, either extract it into a new Node-only install/runtime package or implement an equivalent gateway-side adapter. Do not put filesystem-specific code into the browser-safe shared entrypoint.

## 3. `withAuth`, stores, and in-process reuse

### CLI auth context

`HubIo` is defined in [`packages/app/src/commands/hub.ts:48`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/hub.ts:48):

```ts
export type HubIo = {
  log?: (message: string) => void;
  password?: string;
  oldPassword?: string;
  newPassword?: string;
  restart?: (serviceName: string, installDir: string) => Promise<void>;
  auth?: LocalAuthContext;
  now?: () => number;
  fetcher?: typeof fetch;
  insecureLocal?: boolean;
  skipRestart?: boolean;
  stop?: (serviceName: string, installDir: string) => Promise<void>;
  nodeEnv?: string;
  totpCode?: string;
  serviceManager?: ServiceManagerKind;
};
```

`withAuth()` is:

```ts
async function withAuth<T>(
  parsed: ParsedArgs,
  io: HubIo | undefined,
  fn: (ctx: LocalAuthContext) => Promise<T>,
): Promise<T>
```

See [`packages/app/src/commands/hub.ts:93`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/hub.ts:93).

Its behavior:

- If `io.auth` is supplied, it directly invokes the callback.
- Otherwise it calls `openInstallAuth(parsed)`.
- It closes the CLI-owned context in `finally`.

It does not independently construct the master key. The gateway crypto layer lazily derives the key from `config.masterKey`. See [`apps/gateway/src/crypto/index.ts:9`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/crypto/index.ts:9).

`LocalAuthContext` includes:

```ts
{
  env,
  installDir,
  envPath,
  databaseUrl,
  migrationsFolder,
  db,
  sqlite,
  close,
  userStore,
  keyLogStore,
  nodeSessionStore,
  identityStore,
  userKeys,
}
```

See [`packages/app/src/lib/local-auth.ts:12`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/lib/local-auth.ts:12).

### First-user/self-admit flow

The CLI entrypoint is:

```ts
export async function runHubUserAdd(
  parsed: ParsedArgs,
  username: string,
  io: HubIo = {},
): Promise<{ userId: string; fingerprint: string; rootEpoch: number }>
```

See [`packages/app/src/commands/hub.ts:168`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/hub.ts:168).

It:

1. Opens or receives auth context.
2. Rejects an existing username.
3. Calls `ensureNodeIdentity(ctx.identityStore)`.
4. Calls:

```ts
ctx.userKeys.bootstrapUserWithSelfAdmit({
  username,
  password,
  identity,
  now,
})
```

The core method is already in the gateway:

```ts
bootstrapUserWithSelfAdmit(input: BootstrapSelfAdmitInput)
```

See [`apps/gateway/src/auth/user-key-service.ts:661`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/auth/user-key-service.ts:661).

Its transaction creates/resets the user, writes the genesis/reset-root and self-admit-node key-log records, creates the node certificate, and sets `node_identity.user_id`.

### Join flow

The CLI entrypoint is:

```ts
export async function runHubJoin(
  parsed: ParsedArgs,
  urlRaw: string,
  io: HubIo = {},
): Promise<{ userId: string; hubUrl: string }>
```

See [`packages/app/src/commands/hub.ts:306`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/hub.ts:306).

It performs:

1. Decode join token.
2. Validate hub URL.
3. Ensure local node identity.
4. Fetch hub auth mode.
5. Create local certificate and proof-of-possession.
6. Redeem enrollment.
7. Verify the returned key-log chain and certificates.
8. Commit the join.
9. Rewrite hub-related environment values.
10. Request service restart unless `skipRestart` is set.

The app-local validation adapter is `commitVerifiedJoin()` in [`packages/app/src/commands/hub.ts:435`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/hub.ts:435). It is private to `packages/app`.

The actual atomic persistence operation is already gateway-owned:

```ts
export type CommitJoinInput = {
  records: ApplyKeyLogInput[];
  expectedRootPublicKey: Uint8Array;
  anchorHash: Uint8Array;
  username: string;
  expectedUserId: string;
  identity?: SaveNodeIdentityInput;
  now?: number;
};
```

See [`apps/gateway/src/auth/user-key-service.ts:84`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/auth/user-key-service.ts:84).

`UserKeyService.commitJoin(input)` verifies/replays the chain and persists users, key-log records, certificates, and node identity transactionally. See [`apps/gateway/src/auth/user-key-service.ts:637`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/auth/user-key-service.ts:637).

### Gateway-side stores

`MeshRuntime` currently creates:

```ts
const userStore = new UserStore(db);
const keyLogStore = new KeyLogStore(db);
const nodeSessionStore = new NodeSessionStore(db);
const challengeStore = new ChallengeStore();
const identityStore = new NodeIdentityStore(db);
const keyLogService = new UserKeyService({
  db,
  userStore,
  keyLogStore,
  nodeSessionStore,
});
```

See [`apps/gateway/src/mesh/mesh-runtime.ts:558`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-runtime.ts:558).

`MeshRuntime` exposes `userStore` and `userKeyService`, but not all stores. See [`apps/gateway/src/mesh/mesh-runtime.ts:286`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-runtime.ts:286).

Standalone mode has no `MeshRuntime`, so the setup API needs a gateway-owned seam that creates the auth services against the already-open `GatewayRuntime.db`.

Recommended minimal seam:

```ts
type GatewayAuthContext = {
  userStore: UserStore;
  keyLogStore: KeyLogStore;
  nodeSessionStore: NodeSessionStore;
  identityStore: NodeIdentityStore;
  userKeys: UserKeyService;
};
```

Add a gateway-owned factory or setup service using the existing `AuthDb`. Do not open a second SQLite connection and do not close the shared gateway database from the request handler.

The app-local `commitVerifiedJoin()` validation logic should be moved into a gateway-owned join/setup service, or into a neutral backend package. The persistence call should remain `UserKeyService.commitJoin()`.

### Dependency direction

`apps/gateway/package.json:25` depends on `@tmex/shared`, but not on `tmex-cli` or `packages/app`.

`apps/gateway/tsconfig.json:14` only defines the `@tmex/shared` path alias.

Conversely, `packages/app` already imports gateway source directly, including from:

- [`packages/app/src/commands/hub.ts:1`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/hub.ts:1)
- [`packages/app/src/lib/local-auth.ts:75`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/lib/local-auth.ts:75)

Therefore the current direction is effectively:

```text
packages/app -> apps/gateway
apps/gateway -X-> packages/app
```

`apps/gateway` should not import `packages/app`; that would reverse the dependency and create a build/package cycle.

Recommended placement:

- Auth, join verification, user bootstrap, and transactional persistence: `apps/gateway/src/auth` or `apps/gateway/src/setup`.
- Pure token types/encoding: `packages/shared`.
- `app.env`, install layout, native download, service restart adapters: a new Node-only package shared by `packages/app` and `apps/gateway`.

## 4. Direct enable/disable and native loading

The exact enable signature is:

```ts
export interface EnableDirectOptions {
  installDir: string;
  pin?: NativePin | null;
  platform?: NodeJS.Platform | string;
  arch?: string;
  libc?: 'gnu' | 'glibc' | 'musl' | null | 'detect';
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}
```

See [`packages/app/src/commands/direct.ts:23`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/direct.ts:23).

The disable signature is:

```ts
export interface DisableDirectOptions {
  installDir: string;
}
```

See [`packages/app/src/commands/direct.ts:33`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/direct.ts:33).

`enableDirect()`:

1. Creates the install layout from `installDir`.
2. Determines the native pin.
3. Fetches the platform tarball using `fetchImpl ?? fetch`.
4. Verifies NPM integrity.
5. Extracts the addon.
6. Writes `node_datachannel.node` and `manifest.json` under `<installDir>/native`.

See [`packages/app/src/commands/direct.ts:55`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/direct.ts:55).

`disableDirect()` removes the native directory recursively. See [`packages/app/src/commands/direct.ts:121`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/direct.ts:121).

Whether direct should be enabled is currently:

```ts
return list.includes('node');
```

See [`packages/app/src/commands/direct.ts:41`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/direct.ts:41).

The native module is loaded by `loadNodeDatachannel({ nativeDir })`, which validates the manifest and SHA-256, calls `requireNative(addon)`, and imports the vendored JavaScript wrapper. See [`packages/app/src/lib/native-datachannel.ts:111`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/lib/native-datachannel.ts:111).

`RtcPeerManager` loads it once in its constructor:

```ts
this.loadPromise = this.loadNative().then((mod) => {
  this.native = mod;
  return mod;
});
```

See [`apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:177`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:177).

`direct_capable` is computed from:

```ts
direct_capable: rtc.available
```

See [`apps/gateway/src/mesh/mesh-runtime.ts:744`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-runtime.ts:744).

There is no reload method on `RtcPeerManager`. Downloading the native module while the process is running will not update the existing `rtc.available` value or replace the loaded module. With the current architecture, `direct enable|disable` must schedule a process restart.

## 5. HTTP route registration and authentication

### Core `/api` routes

Core routes are registered in a static array:

```ts
const apiRoutes: ApiRoute[] = [
  ...capabilitiesRoutes,
  ...deviceRoutes,
  ...treeRoutes,
  ...settingsRoutes,
  ...
];
```

See [`apps/gateway/src/api/index.ts:26`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/api/index.ts:26).

Dispatch is:

```ts
export function handleApiRequest(
  req: Request,
  _server?: Server<unknown>,
  systemApiHandler?: SystemApiHandler,
): Response | Promise<Response>
```

See [`apps/gateway/src/api/index.ts:42`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/api/index.ts:42).

Route signatures are:

```ts
type ApiRouteHandler<P extends string = string> = (
  req: Request,
  params: PathParams<P>,
  ctx: ApiRouteContext,
) => Response | Promise<Response> | undefined | null;

interface ApiRoute<P extends string = string> {
  method: string;
  path: P;
  handler: ApiRouteHandler<P>;
}
```

See [`apps/gateway/src/api/route.ts:31`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/api/route.ts:31).

A setup API intended to work in standalone mode should be a core API route or a route layer inserted before core dispatch. Mesh routes alone are insufficient because standalone mode has no `MeshRuntime`.

The current `ApiRouteContext` does not contain the database or auth stores. See [`apps/gateway/src/api/route.ts:4`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/api/route.ts:4). The cleanest options are:

1. Extend runtime/API construction with a setup service dependency.
2. Convert the static route list into a route factory receiving gateway dependencies.
3. Add a gateway-owned setup handler before `handleApiRequest()`.

### Mesh route registration

`MeshRoutes` receives its dependencies through `MeshRoutesDeps` and registers explicit routes such as:

```text
GET  /api/mesh/nodes
GET  /api/mesh/rtc-config
GET  /api/mesh/connection
POST /api/rtc/authorize
GET  /mesh/ws
```

See [`apps/gateway/src/mesh/mesh-routes.ts:49`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-routes.ts:49).

### Session middleware

`authenticateRequest()` treats standalone mode specially:

```ts
if (isStandaloneRoles(deps.roles)) {
  return {
    ok: true,
    userId: null,
    session: null,
    sid: null,
  };
}
```

See [`apps/gateway/src/mesh/session-middleware.ts:36`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/session-middleware.ts:36).

`isStandaloneRoles()` is:

```ts
return !roles.hub && !roles.node;
```

See [`apps/gateway/src/mesh/mesh-deps.ts:238`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-deps.ts:238).

Consequently, `requireSession()` is not a first-run setup authorization mechanism in standalone mode. It authenticates the request as anonymous-success. Setup endpoints need a separate bootstrap policy, such as a first-user-only guard combined with local-origin/loopback restrictions or another explicit one-time authorization mechanism.

`jsonError()` returns:

```json
{
  "code": "UNAUTHORIZED"
}
```

See [`apps/gateway/src/mesh/session-middleware.ts:197`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/session-middleware.ts:197).

Core API failures generally use:

```json
{
  "error": "..."
}
```

See [`apps/gateway/src/api/index.ts:52`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/api/index.ts:52).

The frontend hub client accepts either shape. See [`apps/fe/src/node/hub-api.ts:46`](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/hub-api.ts:46).

### `/api/auth/mode`

Mesh mode uses `AuthRoutes.handleMode()`.

Standalone mode returns:

```json
{
  "mode": "none",
  "nodeId": null,
  "uid": null,
  "username": null,
  "hubUrl": null,
  "hubPublicUrl": null
}
```

See [`apps/gateway/src/mesh/auth-routes.ts:149`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/auth-routes.ts:149).

In production assembled mode, when no `MeshRuntime` exists, `packages/app/src/runtime/assemble.ts` supplies the standalone response before gateway dispatch. See [`packages/app/src/runtime/assemble.ts:181`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/runtime/assemble.ts:181).

## 6. Database migrations and TLS encryption

### Existing schema and migrations

The schema is in [`apps/gateway/src/db/schema.ts:454`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/db/schema.ts:454).

Relevant existing tables include:

```text
users
user_keys
user_key_log
node_sessions
node_certs
nodes
enrollment_tokens
node_identity
peer_cache
```

`node_identity` is a singleton keyed by `id = 1`. See [`apps/gateway/src/db/schema.ts:601`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/db/schema.ts:601).

Migration generation uses:

```text
bun run --filter @tmex/gateway db:generate
```

The configuration points Drizzle at `src/db/schema.ts` and outputs to `apps/gateway/drizzle`. See [`apps/gateway/drizzle.config.ts:1`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/drizzle.config.ts:1).

Runtime migration loading uses `TMEX_MIGRATIONS_DIR`, then the repository `drizzle` directory as fallback. See [`apps/gateway/src/db/migrate.ts:6`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/db/migrate.ts:6).

Important checkout inconsistency:

- The prompt identifies `0019` as latest.
- The checked-out `apps/gateway/drizzle/meta/_journal.json` contains `0020_node_identity_user`.
- `apps/gateway/drizzle/0020_node_identity_user.sql` exists.
- [`apps/gateway/src/auth/schema.migration.test.ts:84`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/auth/schema.migration.test.ts:84) tests the `0020` migration.
- However, [`apps/gateway/src/db/managed-migrations.ts:7`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/db/managed-migrations.ts:7) only registers managed migrations through `0019_hub_auth.sql`.

Before adding TLS, reconcile `0020` in `managed-migrations.ts`. Otherwise a production embedded migration bundle can disagree with the checked-in migration journal/schema.

A new `tls_config` table requires:

1. Add `tlsConfig = sqliteTable(...)` to `schema.ts`.
2. Generate a new migration.
3. Add the SQL file and journal entry.
4. Register the migration in `managed-migrations.ts`.
5. Ensure the resource bundling copies it into `packages/app/resources/gateway-drizzle`.

Resource bundling is performed by [`packages/app/scripts/bundle-resources.sh:5`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/scripts/bundle-resources.sh:5).

For a single active HTTPS certificate, a singleton row is appropriate. If certificates will support multiple domains, ACME accounts, or staged rotations, use a stable certificate/profile identifier and an active marker instead.

### Encryption helper

The gateway crypto API is:

```ts
export async function encrypt(plaintext: string): Promise<string>;
export async function decrypt(ciphertext: string): Promise<string>;
export async function decryptWithContext(
  ciphertext: string,
  context: CryptoDecryptContext,
): Promise<string>;
```

See [`apps/gateway/src/crypto/index.ts:31`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/crypto/index.ts:31) and [`apps/gateway/src/crypto/index.ts:75`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/crypto/index.ts:75).

The helper uses AES-GCM with a 12-byte IV and stores base64-encoded IV+ciphertext.

Existing encrypted identity storage uses contextual fields such as:

```ts
{
  scope: 'node_identity',
  entityId: nodeId,
  field: 'private_key',
}
```

See [`apps/gateway/src/auth/node-identity-store.ts:94`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/auth/node-identity-store.ts:94).

TLS material should follow the same pattern:

```text
scope: tls_config
entityId: <config id>
field: certificate
field: private_key
field: ca
```

Store encrypted PEM strings or one encrypted JSON document. Never expose the decrypted private key through an API response.

There is currently no `acme-client`, Cloudflare DNS provider, TLS configuration table, or HTTPS `Bun.serve` listener in the repository.

## 7. Join-token format and CA fingerprint extension

### Current format

The shared implementation is in [`packages/shared/src/auth/enrollment.ts:80`](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/auth/enrollment.ts:80):

```ts
export function encodeJoinToken(
  enrollSk: Uint8Array,
  rootPublicKey: Uint8Array,
  keyLogHeadHash: Uint8Array,
): string
```

The token is exactly 96 bytes:

```text
bytes 0..31   enroll_sk
bytes 32..63  root public key
bytes 64..95  key-log head hash
```

It is base64url encoded to exactly 128 characters. See [`packages/shared/src/auth/enrollment.ts:14`](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/auth/enrollment.ts:14).

The decoder is:

```ts
export function decodeJoinToken(token: string): JoinToken
```

See [`packages/shared/src/auth/enrollment.ts:100`](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/auth/enrollment.ts:100).

It currently rejects any payload other than exactly 96 decoded bytes.

### CLI producer and consumer

CLI enrollment produces the token in [`packages/app/src/commands/enroll.ts:275`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/enroll.ts:275):

```ts
encodeJoinToken(
  enrollment.enrollSk,
  user.rootPublicKey,
  user.keyLogHeadHash,
)
```

CLI join consumes it in [`packages/app/src/commands/hub.ts:325`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/hub.ts:325).

### Browser producer

The browser UI path is:

```text
apps/fe/src/pages/NodesPage.tsx
  -> api.keyLogHead()
  -> createEnrollmentOnHub()
  -> encodeJoinTokenZeroing()
  -> display join command/token
```

The enrollment helper is [`apps/fe/src/node/enrollment.ts:576`](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/enrollment.ts:576).

The browser-specific encoder duplicates the 96-byte layout and zeroes the enrollment secret afterward. See [`apps/fe/src/node/enrollment.ts:625`](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/enrollment.ts:625).

The hub API only creates the enrollment record. It does not currently create the final join token. See [`apps/fe/src/node/hub-api.ts:95`](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/hub-api.ts:95).

The response can currently include `public_url`, but no CA fingerprint. See [`apps/gateway/src/hub/hub-runtime.ts:453`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/hub-runtime.ts:453).

### Backward-compatible CA segment

Recommended format:

```text
<existing-128-character-base64url-token>.<ca-fingerprint>
```

Use `.` as the delimiter because it is outside the base64url alphabet.

Compatibility behavior:

- No CA fingerprint: emit the existing 128-character token unchanged.
- CA fingerprint present: append one canonical fingerprint segment.
- Decoder splits into one or two segments.
- The first segment must still decode to exactly 96 bytes.
- The optional second segment must be validated as a canonical fingerprint, preferably a lowercase SHA-256 hex digest.
- Existing old tokens remain valid.

The shared type can become:

```ts
type JoinToken = {
  enrollSk: Uint8Array;
  rootPublicKey: Uint8Array;
  keyLogHeadHash: Uint8Array;
  caFingerprint?: string;
};
```

All three implementations must change together:

1. Shared `encodeJoinToken()` / `decodeJoinToken()`.
2. Browser `encodeJoinTokenZeroing()`.
3. CLI enrollment and CLI join.

The browser needs the fingerprint supplied through the enrollment response or auth-mode response. Extend `HubEnrollmentCreated` or the equivalent hub metadata response. The join consumer should pass the decoded fingerprint into the TLS trust configuration rather than treating it as an informational string.

### Trust propagation seams

The current uplink WebSocket factory is:

```ts
export type UplinkWsFactory = (
  url: string,
) => WebSocketTransportInput | Promise<WebSocketTransportInput>;
```

See [`apps/gateway/src/mesh/uplink-client.ts:60`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:60).

The current default is simply:

```ts
new WebSocket(url)
```

See [`apps/gateway/src/mesh/uplink-client.ts:91`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:91).

This is the correct seam for injecting CA-aware WebSocket creation.

The HTTP hub client already accepts an injectable fetcher:

```ts
type HubFetch = typeof fetch;
```

See [`packages/app/src/lib/hub-client.ts:55`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/lib/hub-client.ts:55).

`fetchAuthMode`, enrollment posting, and redemption all accept a fetcher. See [`packages/app/src/lib/hub-client.ts:120`](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/lib/hub-client.ts:120).

A Bun-specific fetcher configured with `tls.ca` should be supplied through this seam.

## 8. Tests and tooling

### Gateway test result

The requested command was run from `apps/gateway`:

```text
bun test src/ 2>&1 | tail -3
```

The exact output was:

```text
 1 error
 10590 expect() calls
Ran 2398 tests across 246 files. [124.47s]
```

The command reports one test error. Because the command is piped through `tail`, the shell pipeline status reflects `tail`, not necessarily the test runner.

`packages/app` tests were not run, as requested.

### Test locations and helpers

Gateway tests are colocated under `apps/gateway/src` and generally use `*.test.ts`.

Live endpoint tests use `*.integration.ts` and are excluded from the default test command. The scripts are defined in [`apps/gateway/package.json:5`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/package.json:5).

In-memory migrated auth database helper:

```ts
export function createMigratedAuthDb(): {
  sqlite: Database;
  db: AuthDb;
  close: () => void;
}
```

See [`apps/gateway/src/auth/test-db.ts:10`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/auth/test-db.ts:10).

Mesh test support includes:

```ts
fakeSocketPair()
ImmediateScheduler
seedUser()
seedNodeIdentity()
waitUntil()
```

See [`apps/gateway/src/mesh/test-support.ts:12`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/test-support.ts:12).

The most complete in-process mesh HTTP harness is in [`apps/gateway/src/mesh/auth-routes.test.ts:183`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/auth-routes.test.ts:183):

```ts
async function bootMesh(...)
```

It creates an in-memory migrated database, auth stores, `UserKeyService`, mesh dependencies, and `MeshHttpRuntime`.

For core API route tests, `handleApiRequest()` is called directly. See [`apps/gateway/src/api/index.routing.test.ts:20`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/api/index.routing.test.ts:20).

For a full gateway runtime, use:

```ts
const runtime = await createGatewayRuntime({
  runMigrationsOnStart: true,
});
```

See [`apps/gateway/src/mesh/stream-targets.test.ts:31`](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/stream-targets.test.ts:31).

Always call `runtime.stop()` and close any isolated database.

### TypeScript commands

There are no dedicated backend `typecheck` scripts. Use:

```text
bunx tsc --noEmit -p apps/gateway/tsconfig.json
bunx tsc --noEmit -p packages/app/tsconfig.json
bunx tsc --noEmit -p packages/shared/tsconfig.json
```

The frontend build already runs TypeScript:

```text
bun run --filter @tmex/fe build
```

See [`apps/fe/package.json:5`](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/package.json:5).

### Biome

Root configuration is [`biome.json:1`](/Users/konata/code/tmex-enhanced-wt-merge/biome.json:1):

```text
indent: spaces
indent width: 2
line width: 100
recommended linter rules
noExplicitAny disabled
single quotes
trailing commas: ES5
```

Root commands are defined in [`package.json:8`](/Users/konata/code/tmex-enhanced-wt-merge/package.json:8):

```text
bun run lint
bun run lint:fix
bun run format
```

Do not lint or format generated migrations, bundled resources, `dist`, or generated i18n files.

## Recommended implementation boundary

```text
Setup HTTP API
  -> gateway-owned setup service
      -> existing UserKeyService.bootstrapUserWithSelfAdmit()
      -> extracted join verification adapter
      -> existing UserKeyService.commitJoin()
      -> gateway auth stores on existing GatewayRuntime.db
      -> NodeIdentityStore
      -> Node-only install/env/direct adapter
      -> delayed restart request

TLS listener
  -> decrypt tls_config from DB
  -> Bun.serve({ tls, fetch, websocket })
  -> stop alongside primary listener
```

The key structural points are:

1. Keep auth and transactional persistence in `apps/gateway`.
2. Do not make `apps/gateway` import `packages/app`.
3. Reuse the gateway’s existing database and auth services in-process.
4. Extract app.env/install/direct operations into a Node-only neutral package.
5. Treat standalone session authentication as insufficient for bootstrap authorization.
6. Reconcile managed migration `0020` before adding the TLS migration.
7. Restart after direct module changes because RTC loading is constructor-time only.