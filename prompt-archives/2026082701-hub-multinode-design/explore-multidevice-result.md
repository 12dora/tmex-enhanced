# tmex architecture report

Scope: current source under `apps/`, `packages/`, `scripts/`, plus `docs/` and `prompt-archives/`. No files were modified.

## 1. Existing multi-device implementation

### What “multi-device” means today

The feature is Gateway-managed local/SSH targets, not remote tmex agents.

- Shared contract: `DeviceType` is only `local | ssh`; SSH authentication is password, key, agent, config reference, or auto. There are no pairing or agent-connection fields. [devices.ts:3](/Users/konata/code/tmex-enhanced/packages/shared/src/contracts/devices.ts:3)
- Main backend modules are [`device-routes.ts`](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/device-routes.ts:176), [`devices.ts`](/Users/konata/code/tmex-enhanced/apps/gateway/src/db/devices.ts:50), [`device-session-runtime.ts`](/Users/konata/code/tmex-enhanced/apps/gateway/src/tmux-client/device-session-runtime.ts:111), and [`device-connection-registry.ts`](/Users/konata/code/tmex-enhanced/apps/gateway/src/ws/device-connection-registry.ts:34).
- The frontend device tree is implemented in [`sidebar-device-list.tsx`](/Users/konata/code/tmex-enhanced/packages/panels/src/device-tree/sidebar-device-list.tsx:187).

### Registration, pairing, and connection direction

Registration is an administrative REST operation:

1. `POST /api/devices` validates the device and generates a UUID with `uuidv4()`.
2. SSH credentials are encrypted before insertion.
3. The device is persisted and immediately passed to `pushSupervisor.upsert()`. [device-routes.ts:67](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/device-routes.ts:67)

There is no pairing flow, registration token, device invite, or remote-agent handshake. The route table contains only CRUD and test-connection endpoints. [device-routes.ts:176](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/device-routes.ts:176)

Connection direction is:

```text
Browser ──HTTP / one WebSocket──> Gateway ──SSH/TCP, exec, rsync──> target device
```

The browser sends `DEVICE_CONNECT(deviceId)` over the Gateway WebSocket. The Gateway creates or reuses a runtime and calls `runtime.connect()`. [device-connection-registry.ts:192](/Users/konata/code/tmex-enhanced/apps/gateway/src/ws/device-connection-registry.ts:192)

At startup, the push supervisor also enumerates every persisted device and attempts to connect to each one. [supervisor.ts:136](/Users/konata/code/tmex-enhanced/apps/gateway/src/push/supervisor.ts:136)

For SSH devices, the exact outward dial is:

```ts
client.connect(authConfig);
```

in [`ssh-external-connection.ts:330`](/Users/konata/code/tmex-enhanced/apps/gateway/src/tmux-client/ssh-external-connection.ts:330). The same SSH client then opens remote shell and tmux control channels. [ssh-external-connection.ts:337](/Users/konata/code/tmex-enhanced/apps/gateway/src/tmux-client/ssh-external-connection.ts:337)

Therefore, the target need not literally have a public address if it is reachable through a LAN, VPN, ProxyJump, or port-forward. However, the current architecture requires the Gateway to initiate a connection to the target; it has no reverse outbound spoke connection or NAT traversal mechanism.

### Transport and protocol

HTTP is served through a small internal route dispatcher, not Express/Hono/etc. [api/index.ts:26](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/index.ts:26)

The browser control channel is a custom binary WebSocket protocol:

- Borsh schema: magic bytes, version, kind, flags, sequence number, and payload. [schema.ts:8](/Users/konata/code/tmex-enhanced/packages/shared/src/ws-borsh/schema.ts:8)
- Codec constants use magic `TX`, protocol version `1`, and a default 1 MiB frame limit. [codec.ts:9](/Users/konata/code/tmex-enhanced/packages/shared/src/ws-borsh/codec.ts:9)
- Message kinds are shared in [`kind.ts`](/Users/konata/code/tmex-enhanced/packages/shared/src/ws-borsh/kind.ts:5).

Important kind groups include:

- Session: `HELLO`, `PING`, `PONG`, `ERROR`.
- Device lifecycle: `DEVICE_CONNECT`, `DEVICE_CONNECTED`, `DEVICE_DISCONNECT`, `DEVICE_EVENT`. [kind.ts:11](/Users/konata/code/tmex-enhanced/packages/shared/src/ws-borsh/kind.ts:11)
- tmux state/control: snapshots, events, select, create/close/rename/reorder, pane operations.
- Terminal: input, paste, resize, output, history, clipboard.
- Agent, watch, site settings, canonical feed, and chunking. [kind.ts:108](/Users/konata/code/tmex-enhanced/packages/shared/src/ws-borsh/kind.ts:108)

Large payloads are split into `CHUNK` frames. [codec.ts:109](/Users/konata/code/tmex-enhanced/packages/shared/src/ws-borsh/codec.ts:109)

The older text `WsMessage` contract still exists, but the current server ignores string WebSocket frames. [ws/index.ts:156](/Users/konata/code/tmex-enhanced/apps/gateway/src/ws/index.ts:156)

### Device capabilities

A runtime exposes:

- tmux snapshots and events;
- terminal output/history;
- input, paste, resize, pane/window selection;
- window and pane creation, closing, splitting, focusing, moving, breaking, renaming, and reordering;
- pane metadata and clipboard events;
- screen capture and pane information. [device-session-runtime.ts:36](/Users/konata/code/tmex-enhanced/apps/gateway/src/tmux-client/device-session-runtime.ts:36)

The runtime is selected by device type: local devices use `LocalExternalTmuxConnection`; all other devices use `SshExternalTmuxConnection`. [device-session-runtime.ts:111](/Users/konata/code/tmex-enhanced/apps/gateway/src/tmux-client/device-session-runtime.ts:111)

Additional device-bound features are Gateway-side:

- Agent sessions are persisted with `deviceId` and `paneId`; creation acquires the Gateway’s tmux runtime. [schema.ts:192](/Users/konata/code/tmex-enhanced/apps/gateway/src/db/schema.ts:192) [agent.ts:147](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/agent.ts:147)
- Watch rules capture device/pane screens through the same runtime.
- File roots are bound to a device. [files.ts:93](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/files.ts:93)
- File transfers use Gateway-side local paths or SSH/rsync. [device-storage.ts:141](/Users/konata/code/tmex-enhanced/apps/gateway/src/files/device-storage.ts:141) [ssh-command.ts:73](/Users/konata/code/tmex-enhanced/apps/gateway/src/files/ssh-command.ts:73)

### Forwarding/proxying across devices

There is no tmex-to-tmex forwarding layer.

The Gateway API and WebSocket handlers resolve `deviceId` locally and invoke the selected runtime. The tmux tree endpoint reads the Gateway’s cached snapshot and overlays. [tmux-tree.ts:16](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/tmux-tree.ts:16)

File operations similarly resolve `rootId -> deviceId` and run local filesystem or rsync operations from the Gateway. [device-storage.ts:101](/Users/konata/code/tmex-enhanced/apps/gateway/src/files/device-storage.ts:101)

### Database and secrets

The `devices` table stores:

- identity and display fields;
- `local`/`ssh` type;
- SSH host, port, username, config reference, and tmux session;
- encrypted password, private key, and private-key passphrase;
- working directory, ordering, and timestamps. [schema.ts:87](/Users/konata/code/tmex-enhanced/apps/gateway/src/db/schema.ts:87)

Runtime status is stored separately: last-seen time, tmux availability, and last error. [schema.ts:116](/Users/konata/code/tmex-enhanced/apps/gateway/src/db/schema.ts:116)

Relevant migrations include:

- initial device schema and type/auth checks: [`0000_busy_starjammers.sql:9`](/Users/konata/code/tmex-enhanced/apps/gateway/drizzle/0000_busy_starjammers.sql:9);
- device tree ordering: [`0006_bitter_bushwacker.sql:1`](/Users/konata/code/tmex-enhanced/apps/gateway/drizzle/0006_bitter_bushwacker.sql:1);
- file roots gaining `device_id`: [`0008_perfect_ozymandias.sql:5`](/Users/konata/code/tmex-enhanced/apps/gateway/drizzle/0008_perfect_ozymandias.sql:5);
- default working directory: [`0011_stormy_sauron.sql:1`](/Users/konata/code/tmex-enhanced/apps/gateway/drizzle/0011_stormy_sauron.sql:1).

There are no device token, pairing-secret, public-key, or spoke-registration columns in the current schema or shared contract.

SSH credentials use AES-GCM encryption with `TMEX_MASTER_KEY`; production requires that key. [crypto/index.ts:11](/Users/konata/code/tmex-enhanced/apps/gateway/src/crypto/index.ts:11) [config.ts:126](/Users/konata/code/tmex-enhanced/apps/gateway/src/config.ts:126)

## 2. Auth and session model

### Browser authentication

The current application has no browser login/session authentication:

- API requests are dispatched directly without auth middleware. [api/index.ts:42](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/index.ts:42)
- WebSocket upgrade checks only the `/ws` path. [ws/index.ts:135](/Users/konata/code/tmex-enhanced/apps/gateway/src/ws/index.ts:135)
- WebSocket `HELLO` negotiates client/version/frame capabilities; it contains no credential or token. [schema.ts:23](/Users/konata/code/tmex-enhanced/packages/shared/src/ws-borsh/schema.ts:23)
- The server requires `HELLO` before other messages, but this is protocol sequencing, not authentication. [ws/index.ts:326](/Users/konata/code/tmex-enhanced/apps/gateway/src/ws/index.ts:326)

The repository’s own architecture document describes the intended deployment posture as “no application auth” with protection delegated to a reverse proxy or network ACL. [architecture.md:149](/Users/konata/code/tmex-enhanced/docs/2026021000-tmex-bootstrap/architecture.md:149)

The current model is therefore effectively single-user/perimeter-trust. There are no browser user, role, permission, or account tables in the current schema; `agentMessages.role` is an LLM message role, not an application role.

### Other tokens

`TMEX_GATEWAY_OWNER_TOKEN` is an internal HMAC key used to produce an ownership proof in health responses when given a challenge. It is not browser authentication or a device token. [gateway-ownership.ts:11](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/gateway-ownership.ts:11) [system-routes.ts:74](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/system-routes.ts:74)

Historical material is inconsistent:

- The original bootstrap plan mentions JWT and HTTP-only cookies. [plan-00-result.md:20](/Users/konata/code/tmex-enhanced/prompt-archives/2026021000-tmex-bootstrap/plan-00-result.md:20)
- A later plan explicitly records removal of login, password auth, JWT, and auth pages. [plan-00-result.md:7](/Users/konata/code/tmex-enhanced/prompt-archives/2026021108-settings-telegram-bell/plan-00-result.md:7)
- The older deployment document still references `TMEX_ADMIN_PASSWORD`, `JWT_SECRET`, login, and JWT expiry. [deployment.md:36](/Users/konata/code/tmex-enhanced/docs/2026021000-tmex-bootstrap/deployment.md:36) [deployment.md:492](/Users/konata/code/tmex-enhanced/docs/2026021000-tmex-bootstrap/deployment.md:492)

The current source and removal record should be treated as authoritative.

### EasyFrame / EasyUI

A whole-repository case-insensitive search, including `docs/` and `prompt-archives/`, found no occurrence of `EasyFrame` or `EasyUI`.

Consequently, there are no such routes, layout wrappers, auth shells, or tmex integration points to describe.

## 3. Gateway server structure

### Entry points and serving

The standalone Gateway entry point is [`apps/gateway/src/index.ts`](/Users/konata/code/tmex-enhanced/apps/gateway/src/index.ts:11):

- loads environment variables;
- creates the Gateway runtime;
- starts `Bun.serve`;
- delegates HTTP fetches and WebSocket callbacks to the runtime. [index.ts:14](/Users/konata/code/tmex-enhanced/apps/gateway/src/index.ts:14)

The packaged application entry point is [`packages/app/src/runtime/server.ts`](/Users/konata/code/tmex-enhanced/packages/app/src/runtime/server.ts:17). It serves:

1. Gateway API and WebSocket;
2. frontend static assets;
3. SPA fallback routing. [server.ts:25](/Users/konata/code/tmex-enhanced/packages/app/src/runtime/server.ts:25)

The backend route registry is assembled in [`apps/gateway/src/api/index.ts:26`](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/index.ts:26). Routing is implemented by the project’s own `ApiRoute` matcher/dispatcher.

### Environment variables

| Variable | Meaning and read location |
|---|---|
| `GATEWAY_PORT` | Gateway listen port; default 9663 in Gateway config, 9883 in packaged server. [config.ts:28](/Users/konata/code/tmex-enhanced/apps/gateway/src/config.ts:28) [server.ts:19](/Users/konata/code/tmex-enhanced/packages/app/src/runtime/server.ts:19) |
| `TMEX_BIND_HOST` | Bind address. [config.ts:80](/Users/konata/code/tmex-enhanced/apps/gateway/src/config.ts:80) |
| `TMEX_GATEWAY_URL` | Vite development backend URL and proxy target; frontend-only wiring value. [vite.config.ts:23](/Users/konata/code/tmex-enhanced/apps/fe/vite.config.ts:23) |
| `FE_PORT` | Vite dev/preview port. [vite.config.ts:24](/Users/konata/code/tmex-enhanced/apps/fe/vite.config.ts:24) |
| `TMEX_BASE_URL` | Default site URL persisted into `site_settings`; it is not the browser WebSocket discovery mechanism. [config.ts:81](/Users/konata/code/tmex-enhanced/apps/gateway/src/config.ts:81) [site-settings.ts:17](/Users/konata/code/tmex-enhanced/apps/gateway/src/db/site-settings.ts:17) |
| `DATABASE_URL` | SQLite/database location. [config.ts:84](/Users/konata/code/tmex-enhanced/apps/gateway/src/config.ts:84) |
| `TMEX_MASTER_KEY` | Production encryption key for SSH and other secrets. [config.ts:76](/Users/konata/code/tmex-enhanced/apps/gateway/src/config.ts:76) |
| `TMEX_FE_DIST_DIR` | Packaged frontend static directory. [server.ts:9](/Users/konata/code/tmex-enhanced/packages/app/src/runtime/server.ts:9) |
| `TMEX_MIGRATIONS_DIR` | Packaged Drizzle migration directory. [migrate.ts:6](/Users/konata/code/tmex-enhanced/apps/gateway/src/db/migrate.ts:6) |
| `TMEX_TMUX_BIN` / `TMEX_TMUX_SOCKET` | tmux executable and optional socket selection. [config.ts:44](/Users/konata/code/tmex-enhanced/apps/gateway/src/config.ts:44) [config.ts:108](/Users/konata/code/tmex-enhanced/apps/gateway/src/config.ts:108) |
| `TMEX_GATEWAY_OWNER_TOKEN` | Internal health ownership proof key, not user auth. [config.ts:63](/Users/konata/code/tmex-enhanced/apps/gateway/src/config.ts:63) |

The shared environment loader distinguishes development, test, and production. Production receives variables from installed `app.env`/`run.sh`; it does not load repository env files. [load-env.ts:1](/Users/konata/code/tmex-enhanced/packages/shared/src/env/load-env.ts:1) [load-env.ts:116](/Users/konata/code/tmex-enhanced/packages/shared/src/env/load-env.ts:116)

### Frontend WebSocket discovery

In production, the browser defaults to same-origin `/ws`, using `ws://` or `wss://` based on the page protocol. [client.ts:11](/Users/konata/code/tmex-enhanced/packages/ws-client/src/client.ts:11)

In development, Vite proxies:

- `/api` to `TMEX_GATEWAY_URL`;
- `/ws` to the corresponding `ws://`/`wss://` URL. [vite.config.ts:56](/Users/konata/code/tmex-enhanced/apps/fe/vite.config.ts:56)

A standard `GatewayConnection` creates one Borsh WebSocket client and one WebSocket transport. [connection.ts:33](/Users/konata/code/tmex-enhanced/packages/ws-client/src/connection.ts:33) Multiple devices are multiplexed over that channel using `deviceId` in payloads; there is not one browser WebSocket per device.

### Existing proxy/relay/tunnel code

There are only edge/frontend proxies:

- Vite development proxy. [vite.config.ts:56](/Users/konata/code/tmex-enhanced/apps/fe/vite.config.ts:56)
- Nginx proxy for `/api` and `/ws` to the Gateway. [nginx.conf:13](/Users/konata/code/tmex-enhanced/apps/fe/nginx.conf:13)

`GatewayTransportSourceRoute` includes a literal `'relay'` value, but this is only a transport type. [transport-types.ts:201](/Users/konata/code/tmex-enhanced/packages/ws-client/src/transport-types.ts:201)

`SharedGatewayTransport` allows a host application to own a data channel and publish events, but it does not implement a network relay or remote-device protocol. [shared-transport.ts:1](/Users/konata/code/tmex-enhanced/packages/ws-client/src/shared-transport.ts:1)

## 4. Frontend device switching

The main pieces are:

- `GlobalDeviceProvider`, which loads devices and ensures the route device is subscribed. [global-device-provider.tsx:34](/Users/konata/code/tmex-enhanced/apps/fe/src/components/global-device-provider.tsx:34)
- Sidebar device tree and nested windows/panes. [sidebar-device-list.tsx:187](/Users/konata/code/tmex-enhanced/packages/panels/src/device-tree/sidebar-device-list.tsx:187)
- `DeviceRow`, which displays local/SSH icons, online status, windows, panes, and device actions. [device-row.tsx:32](/Users/konata/code/tmex-enhanced/packages/panels/src/device-tree/device-row.tsx:32)
- Routes `/devices/:deviceId` and `/devices/:deviceId/windows/:windowId/panes/:paneId`. [main.tsx:245](/Users/konata/code/tmex-enhanced/apps/fe/src/main.tsx:245)
- Per-device Zustand state for snapshots, connection status, errors, selected panes, and tmux actions. [tmux-state.ts:24](/Users/konata/code/tmex-enhanced/packages/stores/src/tmux-state.ts:24)

The device concept is substantial, not merely a navigation label:

- tmux store actions consistently accept `deviceId`;
- snapshots and connection state are keyed by device;
- the Gateway runtime registry maintains one shared runtime per device and can fan it out to multiple browser clients. [runtime-registry.ts:9](/Users/konata/code/tmex-enhanced/apps/gateway/src/tmux-client/runtime-registry.ts:9)

It is not universal on every REST request:

- agent session creation carries `deviceId`; later session operations use session ID, whose DB record is device-bound;
- file operations generally use `rootId`, whose root record carries `deviceId`;
- all calls still terminate at the same Gateway rather than at separate device services.

The device tree design explicitly states that devices are DB entities while windows and panes come from live tmux snapshots. [2026061400-reorder.md:10](/Users/konata/code/tmex-enhanced/docs/device-tree/2026061400-reorder.md:10)

## 5. Packaging and deployment

### Installation and service execution

The package is `tmex-cli`, with `tmex`/`tmex-cli` binaries defined in [`packages/app/package.json:1`](/Users/konata/code/tmex-enhanced/packages/app/package.json:1).

Installation:

1. Copies runtime JavaScript, frontend dist, and Drizzle migrations into the install layout. [install.ts:48](/Users/konata/code/tmex-enhanced/packages/app/src/lib/install.ts:48)
2. Writes `app.env`.
3. Writes `run.sh`, which loads `app.env`, exports `TMEX_FE_DIST_DIR` and `TMEX_MIGRATIONS_DIR`, then executes the Bun runtime server. [install.ts:84](/Users/konata/code/tmex-enhanced/packages/app/src/lib/install.ts:84)
4. Installs launchd on macOS or systemd user service on Linux. [service.ts:83](/Users/konata/code/tmex-enhanced/packages/app/src/lib/service.ts:83)

The runtime server serves both Gateway and frontend from one Bun process. [server.ts:23](/Users/konata/code/tmex-enhanced/packages/app/src/runtime/server.ts:23)

### Hub-only feasibility

There is no first-class hub-only mode.

Couplings that make it non-trivial:

- `tmex-cli init` checks for a usable tmux installation unless dependency checks are skipped. [init.ts:190](/Users/konata/code/tmex-enhanced/packages/app/src/commands/init.ts:190)
- Gateway startup runs migrations, initializes settings, and on a fresh database creates a local device automatically. [runtime.ts:63](/Users/konata/code/tmex-enhanced/apps/gateway/src/runtime.ts:63)
- Startup also starts push, agent, and watch supervisors. [runtime.ts:109](/Users/konata/code/tmex-enhanced/apps/gateway/src/runtime.ts:109)
- The default push supervisor attempts to connect to all persisted devices. [supervisor.ts:141](/Users/konata/code/tmex-enhanced/apps/gateway/src/push/supervisor.ts:141)

A custom deployment with an existing database containing only SSH devices might function logically as a “hub,” but the stock package does not provide a dedicated mode that removes local tmux assumptions or separates hub services from device services.

### Device-only/agent-only feasibility

There is no standalone remote spoke/agent executable and no code for a device to establish an outbound connection to a hub.

`managed-entry.ts` is API-only and omits the frontend, but it still creates the normal Gateway runtime, migrations, SQLite-backed services, and tmux integration. [managed-entry.ts:1](/Users/konata/code/tmex-enhanced/apps/gateway/src/managed-entry.ts:1) [managed-entry.ts:132](/Users/konata/code/tmex-enhanced/apps/gateway/src/managed-entry.ts:132)

Thus, the existing package cannot directly run as a device-only agent without a new entry point, protocol, authentication model, and runtime split.

## 6. Relevant documentation

| Document | Summary |
|---|---|
| [`docs/2026021000-tmex-bootstrap/architecture.md:5`](/Users/konata/code/tmex-enhanced/docs/2026021000-tmex-bootstrap/architecture.md:5) | Foundational architecture; describes local/SSH devices, Gateway, SQLite, and tmux integration. |
| [`docs/2026021000-tmex-bootstrap/deployment.md:196`](/Users/konata/code/tmex-enhanced/docs/2026021000-tmex-bootstrap/deployment.md:196) | Older deployment guide covering Docker, nginx, Cloudflare Tunnel, and SSH. Its JWT/login sections are stale. |
| [`docs/env/2026061301-three-tier-env.md:9`](/Users/konata/code/tmex-enhanced/docs/env/2026061301-three-tier-env.md:9) | Development/test/production environment loading and precedence. |
| [`docs/env/2026061301-three-tier-env.md:63`](/Users/konata/code/tmex-enhanced/docs/env/2026061301-three-tier-env.md:63) | Explains why frontend Vite does not load backend secrets. |
| [`docs/ws-protocol/2026021402-ws-borsh-v1-spec.md:90`](/Users/konata/code/tmex-enhanced/docs/ws-protocol/2026021402-ws-borsh-v1-spec.md:90) | Borsh WebSocket kinds, directions, framing, HELLO, device lifecycle, tmux, terminal, agent, and chunk messages. |
| [`docs/ws-protocol/2026021403-ws-state-machines.md:65`](/Users/konata/code/tmex-enhanced/docs/ws-protocol/2026021403-ws-state-machines.md:65) | Frontend per-device connection state machine. |
| [`docs/ws-protocol/2026021403-ws-state-machines.md:197`](/Users/konata/code/tmex-enhanced/docs/ws-protocol/2026021403-ws-state-machines.md:197) | Gateway device connection-entry model and shared runtime behavior. |
| [`docs/terminal/2026041400-tmux-external-cli-architecture.md:18`](/Users/konata/code/tmex-enhanced/docs/terminal/2026041400-tmux-external-cli-architecture.md:18) | Local/SSH external tmux runtime architecture and event flow. |
| [`docs/terminal/2026021404-terminal-switch-barrier-design.md:22`](/Users/konata/code/tmex-enhanced/docs/terminal/2026021404-terminal-switch-barrier-design.md:22) | `selectToken`, history, live-output barriers, and terminal switching semantics. |
| [`docs/device-tree/2026061400-reorder.md:10`](/Users/konata/code/tmex-enhanced/docs/device-tree/2026061400-reorder.md:10) | Device tree persistence and distinction between DB devices and live tmux windows/panes. |
| [`docs/agent/2026061300-terminal-agent-overview.md:32`](/Users/konata/code/tmex-enhanced/docs/agent/2026061300-terminal-agent-overview.md:32) | Agent session DB/API and terminal integration. |
| [`docs/agent/2026061302-system-prompt-and-credential-handling.md:18`](/Users/konata/code/tmex-enhanced/docs/agent/2026061302-system-prompt-and-credential-handling.md:18) | Agent device context, credentials, and redaction considerations. |
| [`docs/files/2026061500-transfer-progress-chunked.md:9`](/Users/konata/code/tmex-enhanced/docs/files/2026061500-transfer-progress-chunked.md:9) | Chunked upload/download flow and rsync stages. |
| [`docs/release/2026041300-cli-release-process.md:5`](/Users/konata/code/tmex-enhanced/docs/release/2026041300-cli-release-process.md:5) | CLI package artifacts and release process. |
| [`docs/service/2026061400-process-survival.md:16`](/Users/konata/code/tmex-enhanced/docs/service/2026061400-process-survival.md:16) | launchd/systemd process survival and service behavior. |
| [`docs/update/2026061406-self-update.md:23`](/Users/konata/code/tmex-enhanced/docs/update/2026061406-self-update.md:23) | Installed package detection and self-update workflow. |

## Key constraints & opportunities for a hub-and-spoke design

- Current devices are only `local` or `ssh`; there is no spoke/agent identity model.
- The Gateway initiates SSH and rsync connections, so NAT devices require Gateway reachability through public networking, VPN, ProxyJump, or port forwarding.
- There is no device pairing secret, registration token, or device-side credential validation.
- The existing Borsh envelope, chunking, sequence numbers, and device lifecycle kinds provide a reusable wire foundation.
- The current protocol is browser↔Gateway; it has no device↔Gateway peer role or authentication handshake.
- The runtime registry already provides one shared runtime per `deviceId` with multiple browser consumers.
- `pushSupervisor` eagerly connects to all persisted devices; a spoke architecture would need explicit online/offline and reconnect semantics.
- REST, Agent, watch, tmux, and file operations are Gateway-owned rather than generic proxied requests.
- File transfer currently assumes Gateway-side filesystem access and SSH/rsync; NAT spokes would need a replacement transport.
- Agent sessions are already associated with `deviceId` and `paneId`, providing a persistence boundary for routing.
- Browser authentication, users, roles, and authorization are currently absent and would be required for a public multi-tenant hub.
- Device SSH secrets are encrypted under one Gateway `TMEX_MASTER_KEY`; spoke credentials would need independent rotation and revocation.
- There is no supported hub-only or device-only package mode.
- `SharedGatewayTransport` is an integration seam for host-owned channels, but it is not an implemented relay.
- Existing packaging separates runtime, frontend assets, migrations, and service startup, which could support new hub/spoke entry points after the runtime dependencies are split.