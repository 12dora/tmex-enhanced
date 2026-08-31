I completed the read-only investigation, but the requested file could not be written: the sandbox rejected `apply_patch` with `writing is blocked by read-only sandbox`. No repository files were modified. The target file does not exist.

The report content is below for copying to:

`/Users/konata/code/tmex-enhanced-wt-r8/prompt-archives/2026083101-onboarding-remote-access-round8/sub/E4-result.md`

# E4 — tmex onboarding and remote-access findings

## Executive corrections

- The current CLI command is `tmex-cli init`, not `tmex-cli install`.
- There is no `service` command, bare `tmex hub` command, or `tmex node enroll` command.
- Real mesh commands are `tmex hub user add`, `tmex hub join`, `tmex hub leave`, `tmex enroll`, and `tmex direct enable|disable` (`packages/app/src/lib/args.ts:3-18,82-144`).
- `tmex direct enable|disable` controls the mesh peer direct-link plugin; it is not the public “Direct connection” remote-access mode (`apps/fe/src/pages/settings/remote-access/tunnel-model.ts:104-108,120-140`).

## Installation

### Prerequisites and defaults

- `npx` is the supported entry point. `tmex-cli` is Node.js-compatible and its launcher uses `#!/usr/bin/env node` (`packages/app/README.md:1-17`; `packages/app/bin/tmex.js:1-7`). No minimum Node.js version is declared.
- The installed runtime requires Bun `>=1.3.0` (`packages/app/src/constants.ts:4`) and tmux `>=3.0` (`packages/app/src/lib/tmux.ts:20-48`).
- Bun installer command: `curl -fsSL https://bun.sh/install | bash`.
- Default install directory:
  - macOS: `~/Library/Application Support/tmex`
  - Linux: `~/.local/share/tmex`
- Default database: `<install-dir>/data/tmex.db`
- Default port: `9883`
- Default CLI host: `127.0.0.1` (`packages/app/src/constants.ts:7-24`).
- macOS uses launchd; Linux uses per-user systemd. Generated service paths are `~/Library/LaunchAgents/com.tmex.tmex.plist` and `~/.config/systemd/user/tmex.service` (`packages/app/src/lib/service.ts:29-43`).

### Real commands

```bash
# Interactive install
npx tmex-cli init

# Exact README non-interactive example
npx tmex-cli init --no-interactive \
  --install-dir ~/.local/share/tmex \
  --host 127.0.0.1 \
  --port 9883 \
  --db-path ~/.local/share/tmex/data/tmex.db \
  --autostart true

# Diagnose
npx tmex-cli doctor

# Upgrade
npx tmex-cli upgrade

# Uninstall
npx tmex-cli uninstall
```

Evidence: `README.md:52-76`.

`init` also accepts:

```text
--role standalone|node|hub,node
--hub-url <url>
--hub-public-url <url>
--peer-port <port>
--bun-path <path>
--install-deps
--skip-dep-check
--service-name
--force
```

Evidence: `packages/app/src/cli/help.ts:3-18`; `packages/app/src/commands/init.ts:105-185`.

`--skip-dep-check` does not skip Bun validation (`packages/app/src/commands/init.ts:222-246`).

`upgrade` accepts `--version`, `--install-dir`, and `--bun-path`. `uninstall` accepts `--install-dir`, `--yes`, and destructive `--purge` (`packages/app/src/cli/help.ts:8-9`; `packages/app/src/commands/uninstall.ts:19-25`). `--lang <en|zh-CN>` is global (`packages/app/src/cli/help.ts:20-25`).

There is no user-facing `tmex service` command. The README’s statement that tmex has no built-in authentication (`README.md:78-82`) is stale relative to the current mesh/auth implementation.

## Hub and mesh

### Roles and setup UI

The only role strings are `standalone`, `node`, and `hub,node` (`packages/app/src/lib/roles.ts:1-19`).

Settings deep links:

```text
/settings?tab=nodes
/settings?tab=remoteAccess
```

Evidence: `apps/fe/src/pages/SettingsPage.tsx:69-86,128-140,160-220`.

Exact tab keys:

| i18n key | English | Chinese |
|---|---|---|
| `settings.tabGroup.nodes` | `Multi-node Mesh` | `多节点互联` |
| `settings.tabGroup.remoteAccess` | `Remote access` | `远程访问` |

Evidence: `packages/shared/src/i18n/locales/en_US.json:228-235`; `zh_CN.json:228-235`.

For a fresh standalone instance, `/settings?tab=nodes` shows two paths:

- `nodes.setup.path.becomeHub.title`: `把本机设为 Hub`
- `nodes.setup.path.joinHub.title`: `加入已有 Hub`

Evidence: `apps/fe/src/pages/settings/nodes/nodes-tab.tsx:1-4,61-74`; `apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.tsx:47-101`.

The Become Hub form contains:

- `nodes.setup.fields.hubPublicUrl`: `Hub 公开地址`
- `nodes.setup.precheck.button`: `测试地址`
- `nodes.setup.submit.becomeHub`: `创建账号并重启`

The Join Hub form contains:

- `nodes.setup.fields.hubUrl`: `Hub 地址`
- `nodes.setup.fields.token`: `加入码`
- `nodes.setup.fields.name`: `节点名称`
- `nodes.setup.submit.joinHub`: `加入并重启`

Evidence: `packages/shared/src/i18n/locales/zh_CN.json:1891-1946`; `apps/fe/src/pages/settings/nodes/setup/become-hub-form.tsx:147-256`; `join-hub-form.tsx:113-203`.

The Become Hub flow creates the first user, self-admits the local node, writes:

```text
TMEX_ROLES=hub,node
TMEX_HUB_PUBLIC_URL=<hub-public-url>
```

and restarts (`packages/app/src/runtime/setup-service.ts:610-651`).

CLI equivalent:

```bash
npx tmex-cli@latest init --role hub,node --no-interactive \
  --install-dir "$HOME/Library/Application Support/tmex" \
  --host 127.0.0.1 --port 9883 \
  --db-path "$HOME/Library/Application Support/tmex/data/tmex.db" \
  --autostart true \
  --hub-public-url https://tmex.example.com

npx tmex-cli hub user add <username>
```

Evidence: `docs/hub/2026082800-hub-node-operations.md:58-74`; `packages/app/src/commands/hub.ts:331-360`.

### Public Hub address

`TMEX_HUB_PUBLIC_URL` is used for `/api/auth/mode.hubPublicUrl` and join-command generation (`docs/hub/2026082800-hub-node-operations.md:31-37`; `apps/gateway/src/config.ts:199-203`).

Hub enrollment returns `public_url: this.config.publicUrl` (`apps/gateway/src/hub/hub-runtime.ts:346-407`). The frontend refuses to generate a join command unless this is a trusted HTTPS URL (`apps/fe/src/pages/settings/nodes/management/enrollment-section.tsx:215-225`).

Important UI limitation: once the machine is already `hub,node`, `nodes.machine.hubPublicUrl` is displayed read-only; there is no edit control (`apps/fe/src/pages/settings/nodes/local-machine-card.tsx:201-204`; confirmed by `local-machine-card.test.tsx:383-389`).

The guide should set the final public hostname before or during Become Hub setup.

### Enrollment, join, and approval

On an authenticated mesh entry:

1. Open `/settings?tab=nodes`.
2. Open `节点管理`.
3. Click `添加`.
4. Click `生成加入码`.

Exact keys:

```text
nodes.management.title              = 节点管理
nodes.actions.add                   = 添加
nodes.enrollment.create              = 生成加入码
nodes.enrollment.joinCommand        = 加入命令
nodes.enrollment.joinToken           = 加入码
nodes.enrollment.joinHint            = 请在 10 分钟内在新机器上运行下面的命令。
nodes.enrollment.pending             = 等待新节点加入
nodes.enrollment.confirmPending      = 确认加入
nodes.enrollment.cancelPending       = 取消
nodes.enrollment.retryHub            = 重试
```

Evidence: `packages/shared/src/i18n/locales/zh_CN.json:1837-1861`; `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:119-177`; `enrollment-section.tsx:108-160`.

The generated node command is:

```bash
npx tmex-cli hub join <hub-public-https-url> \
  --token <join-token> \
  --name <node-name>
```

The frontend constructs it in `apps/fe/src/node/enrollment.ts:694-705`.

The CLI requires the HTTPS URL and `--token`, defaults `--name` to `node`, and supports `--insecure-local` and `--no-restart` (`packages/app/src/commands/hub.ts:589-645`; `packages/app/src/cli/help.ts:14`).

`--insecure-local` is only for non-production local HTTP testing. Production requires HTTPS (`docs/hub/2026082800-hub-node-operations.md:121-136`; `packages/shared/src/i18n/locales/zh_CN.json:1932-1933,1972-1975`).

Enrollment API sequence:

- Authenticated `POST /api/hub/enrollments`
- Authenticated `GET /api/hub/enrollments/:id`
- Node-side `POST /api/hub/enrollments/redeem`

Evidence: `apps/gateway/src/hub/hub-runtime.ts:168-205,272-295,346-407,447-534`.

Redeem creates or updates a node with status `enrolled`, but the Hub uplink rejects nodes without an admitted certificate as `cert_not_admitted` (`hub-runtime.ts:612-695`; `uplink-server.ts:539-598`).

The Hub-side “allowlist” is the signed key-log admission state:

- The UI pending state is `等待新节点加入`.
- The approval button is `确认加入`.
- Confirmation applies a signed `admit-node` record.
- Root-key signers can be auto-admitted.
- Passkey flows require the user to click `确认加入`.

Evidence: `packages/app/src/commands/enroll.ts:386-435`; `docs/hub/2026082800-hub-node-operations.md:150-154`.

The Hub-side CLI alternative is:

```bash
npx tmex-cli enroll --ttl 10m
```

It requires a local user, prints the join token and exact join command, and can poll for admission (`packages/app/src/commands/enroll.ts:102-106,438-501`).

## PWA and mobile behavior

- Manifest endpoint: `GET /api/manifest.webmanifest`
- Manifest `display`: `standalone`
- Manifest `start_url`: `/`
- Manifest `scope`: `/`
- Icons: `/tmex.png`, `/tmex-maskable.png`

Evidence: `apps/gateway/src/api/system-routes.ts:13-42,71-76`.

The manifest name is dynamic:

```text
name       = getSiteSettings().siteName
short_name = getSiteSettings().siteName
```

The default site name is `tmex` (`apps/gateway/src/api/system-routes.ts:13-20`; `apps/gateway/src/config.ts:155-164`). HTML title is `tmex` (`apps/fe/index.html:18-21`).

There is no `vite-plugin-pwa`, service-worker registration, or service worker in `apps/fe`. The app provides a manifest and mobile metadata only (`apps/fe/index.html:12-20`).

Existing iOS copy:

```text
common.pwaInstallHintIOSSafari
iOS Safari does not show an automatic install prompt.
Tap Share, then "Add to Home Screen".
```

Evidence: `packages/shared/src/i18n/locales/en_US.json:35-40`.

iOS standalone/status-bar handling exists in `apps/fe/src/main.tsx:76-98`.

Android-specific install copy was not found. The onboarding can instruct Android Chrome: browser menu → `Install app` or `Add to Home screen`.

Mobile is a browser client. It controls tmux running on a server/node; it does not provide a local tmux runtime.

## Remote access

Open `/settings?tab=remoteAccess` on the machine directly connected to the browser. Remote-node views show a notice because `/api/tunnel/*` only operates on the directly connected machine (`apps/fe/src/pages/settings/remote-access/remote-access-tab.tsx:1-43`; `apps/gateway/src/api/tunnel-routes.ts:15-26,162-198`).

The UI has three modes:

### Quick tunnel

- `settings.remoteAccess.mode.quick.title`: `Quick tunnel` / `临时隧道`
- Click `Install cloudflared`.
- Select Quick tunnel.
- Click `Start`.
- Cloudflare returns a temporary `trycloudflare.com` URL.
- The URL stops working when the tunnel stops.

Evidence: `apps/fe/src/pages/settings/remote-access/wizard.tsx:1-4,317-360,404-449`; `packages/shared/src/i18n/locales/en_US.json:298-305,391-415`.

### Named tunnel

- `settings.remoteAccess.mode.named.title`: `Named tunnel` / `命名隧道`
- Install cloudflared.
- Click `Sign in to Cloudflare`.
- Click `Open authorization page`.
- Authorize a Cloudflare-hosted domain.
- Enter a lowercase hostname such as `tmex.example.com`.
- Optionally enter a tunnel name.
- Optionally configure Cloudflare Access rules.
- Click `Create and start`.
- Configure reverse-proxy trust and auto-start.

Evidence: `apps/fe/src/pages/settings/remote-access/named-step.tsx:32-119,121-255,259-345`; `packages/shared/src/i18n/locales/en_US.json:417-451`.

When the machine is a Hub, the UI displays:

```text
This machine is a Hub: set the Hub's public URL to this hostname so other nodes can connect through the tunnel.
```

Key: `settings.remoteAccess.steps.named.hubHint`.

Evidence: `apps/fe/src/pages/settings/remote-access/named-step.tsx:348-358`; `packages/shared/src/i18n/locales/en_US.json:425-437`.

### Direct connection

- `settings.remoteAccess.mode.direct.title`: `Direct connection` / `直接连接`
- tmex does not create a tunnel or port mapping.
- The operator exposes a fixed IP, forwarded port, or reverse proxy.
- Point the public entry to the local origin port, normally `9883`.
- Use HTTPS.
- The UI only reports/enables the local protection gate.

Evidence: `apps/fe/src/pages/settings/remote-access/direct-step.tsx:1-4,32-90`; `packages/shared/src/i18n/locales/en_US.json:331-352`.

The frontend calls:

```text
GET  /api/tunnel/status
POST /api/tunnel/actions
```

Evidence: `packages/api-client/src/local/tunnel-api.ts:40-58`.

Backend action names include:

```text
install
login
cancel_login
quick_start
create
start
stop
remove
check
set_auto_start
set_trust_proxy
configure_access
set_access_enforce
adopt_external
```

Evidence: `apps/gateway/src/api/tunnel-routes.ts:48-160`.

There is no public-facing CLI command for the remote-access wizard.

Cloudflare actions require sign-in protection or Cloudflare Access. Otherwise the backend requires explicit exposure acknowledgement (`apps/gateway/src/tunnel/manager.ts:352-433,491-505`; `packages/shared/src/contracts/tunnel.ts:20-39,157-177`).

## Authentication and first-user bootstrap

- If `TMEX_ROLES` contains `hub` or `node`, login is enforced (`apps/gateway/src/db/local-auth-settings.ts:149-164`).
- Protected requests without a valid node session return HTTP 401 (`apps/gateway/src/mesh/session-middleware.ts:49-95,195-206`).
- `/api/auth/mode` is public and reports mesh mode, user, node, Hub, and public Hub information (`apps/gateway/src/mesh/auth-routes.ts:184-203`).
- The Login page renders for mesh mode (`apps/fe/src/pages/LoginPage.tsx:42-60`).
- Remote nodes may require lazy per-node login. UI label: `auth.node.loginToThisNode` / `Login this node` (`apps/fe/src/auth/use-node-login.ts:76-106`; `NodeLoginButton.tsx:33-77`).

First Hub user:

```bash
npx tmex-cli hub user add <username>
```

This prompts for a hidden password and self-admits the Hub node (`packages/app/src/commands/hub.ts:331-360`).

The UI Become Hub flow performs the same bootstrap before writing `TMEX_ROLES=hub,node` (`packages/app/src/runtime/setup-service.ts:610-651`).

For standalone direct exposure, the Direct connection screen can bootstrap a first local user only from the local machine, then enable local sign-in. Username length is 1–64 characters; password requires at least 8 characters (`apps/fe/src/pages/settings/remote-access/direct-step.tsx:94-131`; `apps/gateway/src/db/local-auth-settings.ts:103-147`).

## Proposed “Connect more devices” outline

### Tab 1 — Mobile device (control only)

1. Open tmex in iOS Safari.
2. Tap **Share** → **Add to Home Screen**.
3. On Android Chrome, open the browser menu → **Install app**.
4. Explain that the installed app is a standalone web client. It controls tmux on the selected server/node; it does not run local tmux on the phone.

### Tab 2 — Server or computer

1. Install tmex:

   ```bash
   npx tmex-cli init
   ```

   Automation:

   ```bash
   npx tmex-cli init --no-interactive \
     --install-dir ~/.local/share/tmex \
     --host 127.0.0.1 \
     --port 9883 \
     --db-path ~/.local/share/tmex/data/tmex.db \
     --autostart true
   ```

2. Mode 1 — join an existing Hub:
   - On the Hub:

     ```bash
     npx tmex-cli@latest init --role hub,node --no-interactive \
       --install-dir "$HOME/Library/Application Support/tmex" \
       --host 127.0.0.1 --port 9883 \
       --db-path "$HOME/Library/Application Support/tmex/data/tmex.db" \
       --autostart true \
       --hub-public-url https://tmex.example.com

     npx tmex-cli hub user add <username>
     ```

   - In `/settings?tab=nodes`, open `节点管理` → `添加` → `生成加入码`.
   - On this machine:

     ```bash
     npx tmex-cli hub join https://tmex.example.com \
       --token <join-token> \
       --name <node-name>
     ```

   - Return to the Hub Nodes page and click `确认加入` if pending.
   - Sign in.

3. Mode 2 — make this machine the Hub:
   - First establish the final public entry:
     - `/settings?tab=remoteAccess` → `命名隧道`, or
     - `/settings?tab=remoteAccess` → `直接连接`.
   - For Cloudflare named tunnel: `安装 cloudflared` → `登录 Cloudflare` → `打开授权页面` → `主机名` → `创建并启动` → `反向代理信任`.
   - For direct exposure: point the public entry at port `9883` and use HTTPS.
   - Before or during Hub setup, open `/settings?tab=nodes` → `把本机设为 Hub`, enter the final hostname in `Hub 公开地址`, create the first account, then click `创建账号并重启`.
   - Add other machines through `节点管理` → `添加` → `生成加入码`.
   - On each other machine run:

     ```bash
     npx tmex-cli hub join https://tmex.example.com \
       --token <join-token> \
       --name <node-name>
     ```

   - Click `确认加入` and sign in.

### Commands not to document

```text
tmex install
tmex service
tmex node enroll
```

These are not current commands. Use `tmex-cli init`, `tmex hub join`, and Hub-side `tmex enroll --ttl 10m` or the Nodes-page `生成加入码` flow instead.