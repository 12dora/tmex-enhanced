# EX4 — Non-standard ports for relay / hub / direct remote access

Scope: every place tmex assumes, defaults, validates, normalizes, binds or advertises a port,
plus every user-facing input of a relay/hub/remote address, so that (1) hub / relay / direct
HTTPS can run on a high port, (2) setup can suggest a built-in high port, and (3) a typed
address without an explicit port can be auto-probed against a candidate port list.

Repo: `/Users/konata/code/tmex-r32` (branch `feat/round32-relay-quota-transfer-portmap`).
All paths absolute. Read-only survey; no files were modified except this report.

---

## 0. Executive summary (what already works, what is actually missing)

**Good news — the data plane is already port-transparent.** Every URL that travels between
nodes is a full `scheme://host[:port][/path]` string canonicalised by one shared function that
*preserves* non-default ports and only strips the scheme's own default:

- `/Users/konata/code/tmex-r32/packages/shared/src/auth/hub-url.ts:20-26`
  ```ts
  const defaultPort = scheme === 'https' ? '443' : '80';
  const port = url.port && url.port !== defaultPort ? `:${url.port}` : '';
  return `${scheme}://${host}${port}${path}`;
  ```
- `normalizeRelayUrl` wraps it (`packages/shared/src/relay/join-token.ts:54-74`).
- Uplink auth signatures bind `new URL(u).host` — which *includes* a non-default port
  (`/Users/konata/code/tmex-r32/packages/shared/src/auth/uplink-auth.ts:35`), and both sides
  derive it from the same canonical URL, so signing works unchanged on port 18443.
- `r3.` relay join tokens embed the full URL per relay entry (up to 512 bytes each), so ports
  ride along; `packages/shared/src/relay/join-token.test.ts:67-70` already asserts
  `https://relay.example.com:8443/base/` survives.
- Share-origin ranking uses `URL.origin` / `URL.host`
  (`apps/gateway/src/share/share-origins.ts:46-62`), and domain-access normalisation keeps
  non-default ports (`apps/gateway/src/mesh/domain-access-policy.ts:10,28`).
- The built-in HTTPS listener is **already** on a non-standard port by default:
  `DEFAULT_TLS_PORT = 9443` (`/Users/konata/code/tmex-r32/apps/gateway/src/tls/types.ts:10`),
  fully configurable 1..65535 through `PUT /api/tls`.
- ACME **dns-01 already exists** for Cloudflare and DNSPod
  (`packages/app/src/tls/dns-provider.ts`, `cloudflare-dns.ts`, `dnspod-dns.ts`), so a
  certificate can be issued without ever opening port 80.

**What is actually missing** is entirely in the *human* layer:

1. No built-in high-port suggestion anywhere; every setup prompt/field asks the operator to
   type a full URL and offers `https://tmex.example.com` (no port) as the example
   (`nodes.setup.fields.urlPlaceholder`, `EXAMPLE_HUB_URL`).
2. When a user types `relay.example.com` or `https://relay.example.com` with **no** port, the
   client tries exactly 443 and fails with `relay is not healthy` / `hub_unreachable`. There is
   no candidate-port probe anywhere.
3. `docs/deployment` documents only "reverse proxy or Cloudflare Tunnel in front, tmex on
   loopback"; there is no documented "ISP blocks 80/443, run tmex itself on a high port" path
   (the closest is `docs/operations/2026090303-acme-dns-providers.md`, written for the
   "someone else's nginx owns 80/443" case).
4. Two small real bugs found (see §8): `portmap`'s reserved-port set omits the TLS listener
   port, and the LAN access-address candidate always uses the plain-HTTP gateway port.

---

## 1. URL normalisation / validation for relay and hub public URLs

### 1.1 `canonicalHubUrl` — the one canonicaliser

`/Users/konata/code/tmex-r32/packages/shared/src/auth/hub-url.ts:1-27`

- Rejects non-`http(s)`, empty hostname, credentials, query, fragment.
- Lowercases scheme+host, brackets bare IPv6, strips trailing slashes.
- **Strips only the scheme's default port** (`443` for https, `80` for http); any other port is
  kept verbatim. `new URL('https://x:443')` would drop `:443` anyway; this makes it explicit.

Call sites (non-test): `packages/app/src/runtime/setup-service.ts:474`,
`packages/app/src/lib/hub-client.ts:72,113,120`, `packages/app/src/lib/hub-password-join.ts:95`,
`packages/app/src/commands/hub.ts:464,1101`, `packages/shared/src/auth/relay-records.ts:120`,
`packages/shared/src/relay/join-token.ts:63`,
`apps/fe/src/pages/settings/nodes/setup/validation.ts:42`,
`apps/gateway/src/mesh/uplink-pool.ts:184`, `uplink-pool-switch.ts:179`,
`relay-preferred.ts:8`, `mesh-runtime.ts:810`, `apps/gateway/src/auth/hub-trust-store.ts:1`.

### 1.2 `normalizeRelayUrl` — "https, http only for loopback"

`/Users/konata/code/tmex-r32/packages/shared/src/relay/join-token.ts:48-74`

```ts
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}
export function normalizeRelayUrl(raw: string): string {
  ...
  canonical = canonicalHubUrl(raw);            // keeps :8443, drops :443
  const url = new URL(canonical);
  if (url.protocol === 'https:') return canonical;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return canonical;
  throw new RelayJoinTokenError('relay url must be https (http allowed for loopback only)');
}
```
Length cap `RELAY_JOIN_TOKEN_MAX_URL_LEN = 512` (line 10). **A port costs ≤6 bytes — no cap risk.**

Call sites: `packages/app/src/runtime/relay-setup-service.ts:53`,
`packages/app/src/lib/relay-password-join.ts:50`, `packages/app/src/commands/init.ts:257`,
`commands/relay.ts:59`, `commands/relay-join.ts:61`,
`apps/fe/src/pages/settings/nodes/setup/validation.ts:124`,
`apps/gateway/src/mesh/relay-routes-input.ts:62`.

### 1.3 Three near-duplicate "https-or-loopback" validators

| Function | File:line | Extra rule |
|---|---|---|
| `normalizeRelayUrl` | `packages/shared/src/relay/join-token.ts:54` | relay only, loopback http ok |
| `assertHubJoinUrl` | `packages/app/src/lib/hub-client.ts:101-123` | requires explicit `--insecure-local`, forbids it under `NODE_ENV=production` |
| `assertSetupUrl` | `packages/app/src/runtime/setup-shared.ts:142-157` | web setup wizard; loopback http ok when not production |
| `classifyHubUrl` / `classifyRelayUrl` (FE mirror) | `apps/fe/src/pages/settings/nodes/setup/validation.ts:35-50,120-130` | returns `'ok' \| 'invalid' \| 'insecure'` |
| `isTrustedHubUrl` (FE, gate for shell-command interpolation) | `apps/fe/src/node/enrollment.ts:742-755` | rejects credentials |

**None of the five rejects or mangles an explicit port.** All accept `https://host:18443`.

### 1.4 Join tokens

**Relay `r3.` join string** — `/Users/konata/code/tmex-r32/packages/shared/src/relay/join-token.ts:116-162`

```
"r3." + base64url( enroll_sk32 ‖ root_pk32 ‖ head_hash32 ‖ K_log32
                   ‖ n(u8) ‖ [ len(u16 LE) ‖ url utf8 ‖ tenant_id16 ‖ token32 ] × n )
        [ "." <64 lowercase hex CA SPKI fingerprint> ]
```
- Each entry carries the **full canonical URL** (`normalizeEntries` → `normalizeRelayUrl`,
  line 105-109), so a non-standard port is already inside the token.
- Up to 16 relays (`RELAY_JOIN_TOKEN_MAX_URLS`), each url ≤512 bytes.
- CA fingerprint suffix: exactly one `.` segment, 64 lowercase hex
  (`splitCaFingerprint`, line 164-177). A URL containing `:18443` does not interfere — the
  split happens on the *outer* token string, and the base64url body contains no `.`.

**Hub join token** — `/Users/konata/code/tmex-r32/packages/shared/src/auth/enrollment.ts:92-141`

```
base64url( enroll_sk32 ‖ root_pk32 ‖ key_log_head_hash32 )   // 96 bytes → 128 chars
[ "." <64 hex CA SPKI fingerprint> ]
```
- **Carries no URL at all.** The hub address is supplied separately, by hand:
  `tmex hub join <https-url> --token <t>`. FE regex
  `apps/fe/src/pages/settings/nodes/setup/validation.ts:18`:
  `/^[A-Za-z0-9_-]{128}(?:\.[0-9a-f]{64})?$/`.
- The command shown to the user is built from the hub's own `hubPublicUrl`
  (`apps/fe/src/node/enrollment.ts:765-771`, gated by `isTrustedHubUrl`, quoted by
  `shellQuote`) — so if the hub's public URL has a port, the copy-paste command already
  includes it. This is the single most important thing to keep correct.

### 1.5 Env plumbing

| Var | Read at | Default |
|---|---|---|
| `TMEX_RELAY_PUBLIC_URL` | `packages/app/src/runtime/assemble-relay.ts:41-45` (throws if empty when role includes relay); `apps/gateway/src/mesh/relay-dial.ts:40` | — |
| `TMEX_HUB_PUBLIC_URL` | `packages/app/src/runtime/assemble.ts:310`, `setup-service.ts:453`, `install.ts:59,81` | `''` |
| `TMEX_BASE_URL` | `apps/gateway/src/config.ts:300` — `getEnv('TMEX_BASE_URL', 'http://127.0.0.1:8085')` (**stale 8085 fallback**, never hit in practice since `init` always writes it) | written by `install.ts:110` as `formatHttpEndpoint(host, port)` |
| `GATEWAY_PORT` | `apps/gateway/src/config.ts:37` default `'9663'`; `packages/app/src/runtime/server.ts:29` default `'9883'` | two divergent defaults |
| `TMEX_PEER_PORT` | `apps/gateway/src/config.ts:104-113` default `'39001'`; `packages/app/src/lib/roles.ts:14`; `apps/gateway/src/mesh/peer-dc-upgrade.ts:506` fallback | 39001 (already non-standard) |
| `TMEX_BIND_HOST` | `apps/gateway/src/config.ts:298`, `packages/app/src/runtime/server.ts:28` | `0.0.0.0` / `127.0.0.1` |

`formatHttpEndpoint` (`/Users/konata/code/tmex-r32/packages/shared/src/network.ts:15-19`)
brackets IPv6 and always emits an explicit `:port`.

---

## 2. Where the server actually listens for public traffic

### 2.1 Plain HTTP gateway
- `/Users/konata/code/tmex-r32/packages/app/src/runtime/server.ts:28-29,45-50` — the shipped
  product: `Bun.serve({ hostname: TMEX_BIND_HOST || '127.0.0.1', port: GATEWAY_PORT || 9883 })`.
- `/Users/konata/code/tmex-r32/apps/gateway/src/index.ts:16-18,32` — bare gateway dev entry.
- `/Users/konata/code/tmex-r32/apps/gateway/src/config.ts:33-46` — `resolveGatewayPort()`,
  default `'9663'`, validated 1..65535 (0 allowed only in "companion managed" mode,
  `managed-entry.ts:137-163`).
- **Both `/hub/uplink` and `/relay/uplink` WebSockets, `/api/relay/*`, `/healthz`,
  `/.well-known/acme-challenge/*`, the browser UI, share links and `/n/<nodeId>/*` forwarding
  all live on this one listener** (`apps/gateway/src/hub/types.ts:61`,
  `apps/gateway/src/mesh/relay-uplink-http.ts:12`). One public port is enough for everything.

### 2.2 Built-in direct HTTPS listener
- `/Users/konata/code/tmex-r32/packages/app/src/tls/https-listener.ts:41-61`
  ```ts
  this.server = Bun.serve({ hostname: cfg.host, port: cfg.port,
                            tls: { cert: cfg.certPem, key: cfg.keyPem },
                            fetch: this.opts.fetch, websocket: this.opts.websocket });
  ```
  Same `fetch` handler as the plain HTTP listener (`assemble-routes.ts:224-228`), so HTTPS
  serves the identical route surface.
- Port/host come from the DB row: `packages/app/src/tls/tls-service.ts:649-659`
  (`applyListener()` → `listener.apply({ port: tlsPort, host: bindHost, ... })`).
- Defaults: `/Users/konata/code/tmex-r32/apps/gateway/src/tls/types.ts:10-11`
  `DEFAULT_TLS_PORT = 9443`, `DEFAULT_TLS_BIND_HOST = '0.0.0.0'`; schema default
  `apps/gateway/src/db/schema/settings.ts:68` `tls_port … default(9443)`.
- Validation `packages/app/src/tls/tls-service.ts:676-681` — any integer 1..65535.
- **No privileged-port handling** (no setcap / root escalation); a bind failure surfaces as
  `state().error` → `TlsApiError('port_in_use', 409, …)` (`tls-service.ts:662-665`).
  FE hint already says so: `nodes.https.portHint` = "默认 9443。低于 1024 的端口需要 root 权限，
  Linux 用户级服务无法绑定。"
- **How it is advertised:** it is *not*. `packages/app/src/runtime/tls-routes.ts:19-35`
  `resolveEffectiveHttps()` reports `source: 'builtin'` with `publicUrl: null`; only
  `tlsPort`/`bindHost` are exposed via `GET /api/tls`
  (`packages/app/src/tls/tls-service.ts:249-250`) for the settings UI to render
  `nodes.https.status.accessBuiltin` ("HTTPS，由本机内置监听器提供（端口 {{port}}）"). The
  operator must type `https://domain:9443` into the hub/relay public-URL field by hand.

### 2.3 ACME
- http-01: `/Users/konata/code/tmex-r32/packages/app/src/tls/acme-challenge.ts:1,17-49` —
  serves `/.well-known/acme-challenge/<token>` from memory. It **does not bind port 80**; it
  rides the normal gateway `fetch` chain (`packages/app/src/runtime/tls-routes.ts:62`,
  `assemble-routes.ts:340-368`), so port 80 must reach the machine via NAT/router forwarding.
  Explicitly whitelisted pre-auth in `apps/gateway/src/mesh/domain-access-policy.ts:90-96`.
  User copy: `nodes.https.acme.hints.http01` / `http01Linux`.
- **dns-01 exists** — `packages/app/src/tls/dns-provider.ts` (`DnsProviderId =
  'cloudflare' | 'dnspod'`), `cloudflare-dns.ts`, `dnspod-dns.ts`, `acme-dns-patch.ts`,
  wired in `tls-service.ts:667-673`; designed exactly for the "80/443 unavailable" case
  (`docs/operations/2026090303-acme-dns-providers.md:5,76-85`). **Confirmed: no port-80 work
  is needed for certificate issuance.**

### 2.4 Peer port (already non-standard)
- `apps/gateway/src/config.ts:104-113` default `39001`; bind hosts default `['::','0.0.0.0']`
  (`config.ts:126`), i.e. the peer signalling port *is* exposed on all interfaces.
- Advertised as `ws://<host>:<port>/peer` (`apps/gateway/src/mesh/peer-server.ts:126-133`,
  `mesh-runtime.ts:308-325`). Firewall reminder printed at
  `/Users/konata/code/tmex-r32/packages/app/src/commands/hub.ts:665-668`.
- Note `apps/gateway/src/mesh/peer-endpoint-backoff.ts:45` infers `wss:→443 / ws:→80` when a
  peer endpoint URL has no port — backoff bookkeeping only, not dialling.

### 2.5 Cloudflare Tunnel (out of scope, noted)
- Connector→edge is TCP/UDP **7844** (`apps/gateway/src/tunnel/edge-resolver.ts:10`
  `DEFAULT_EDGE_PORT = 7844`); the browser-facing side is Cloudflare's edge on 443 and cannot
  be moved. Local origin target is the gateway's own port
  (`apps/gateway/src/tunnel/manager.ts:213-218`, `named-config.ts:8-25`).
- Public URL is always built as `https://<hostname>` with no port
  (`tunnel/status-view.ts:66`, `tunnel/manager.ts:945`, `share/share-origins.ts:181`,
  `apps/fe/.../access-addresses.ts:37`) — correct for the tunnel case.

---

## 3. Every user-facing input of a relay / hub / remote address

### 3.0 Architectural fact that shapes the whole design

**The browser never makes a cross-origin request to a relay or hub.** Every address form in
`apps/fe` posts to the *local* gateway (`ApiClient` with `baseUrl: ''`), and the Bun process
performs the outbound probe/enroll/join. Verified: no `apps/fe` source file uses
`AbortSignal.timeout`, `RelayEntryProbe` exists only in `apps/gateway/src/share/`, and
`RelayAdminApi.health()` (`packages/api-client/src/relay/admin-api.ts:192-194`) calls
`/api/relay/health` **on the local gateway** (relay-operator console), not on a remote relay.

⇒ A port-probe helper must be callable from **Node/Bun** (gateway + CLI). The web wizard reaches
it through a local API endpoint. **No CORS or mixed-content problem exists, and none should be
introduced by moving probing into the browser.**

### 3.1 Web — setup wizard (`apps/fe/src/pages/settings/nodes/setup/`)

| Form | File:line | Address field | Validation | Probe |
|---|---|---|---|---|
| 把本机设为 Hub | `become-hub-form.tsx:122-151` | `hubPublicUrl` | `validateBecomeHub` → `classifyHubUrl` (`validation.ts:73-94,35-50`) | **"测试地址" button** → `SetupApi.precheck()` (`become-hub-form.tsx:100-110`) |
| 加入已有 Hub | `join-hub-form.tsx:112-172` | `hubUrl` (+ `insecureLocal` switch, dev only) | `validateJoinHub` (`validation.ts:188-209`) | none |
| 本机作为中继 | `become-relay-form.tsx:199-213` | `relayPublicUrl` | `validateBecomeRelay` → `classifyRelayUrl` (`validation.ts:132-162`) | none |
| 加入已有中继 | `join-relay-form.tsx:162-249` | `relayUrl`, `tenantId`, `caFingerprint` | `validateJoinRelay` (`validation.ts:233-255`) | none |

Prefill: `defaultHubPublicUrl` / `defaultRelayPublicUrl`
(`validation.ts:262-271`) prefill from `window.location.origin` **only if that origin itself
validates** — `location.origin` already contains the port, so a user reaching the UI on
`https://box.example.com:18443` gets it prefilled correctly today.

Submit paths → `packages/api-client/src/local/setup-api.ts:78-124` →
`packages/app/src/runtime/setup-routes.ts:8-14`:
`/api/setup/precheck | /hub | /join | /relay | /relay-join` (POST only, standalone only).

**`precheckHubUrl`** — `/Users/konata/code/tmex-r32/packages/app/src/runtime/setup-service.ts:379-419`:
```ts
const parsed = assertSetupUrl(url, deps.nodeEnv);
const response = await fetchImpl(new URL('/healthz', parsed), {
  signal: AbortSignal.timeout(PRECHECK_TIMEOUT_MS),   // 5_000, line 59
  redirect: 'error', ...(caPem ? { tls: { ca: [caPem] } } : {}),
});
// reachable = status 200 && body.status === 'ok';  isSelf = body.startedAt === PROCESS_STARTED_AT
```
**This is the natural home for hub port probing.**

Setup i18n error keys (`nodes.setup.errors.*`): `invalid_url` = "请输入合法的 https:// 地址。",
`insecure_local_required`, `hub_unreachable` = "无法连接到 Hub。请检查地址，并确认 Hub 正在运行。",
`relay_unreachable`, `relay.hub_unreachable`, `invalid_tenant_id`, `invalid_ca_fingerprint`.
Precheck copy: `nodes.setup.precheck.{button,reachableSelf,reachableOther,unreachable,httpsHint}`.
Field hints: `nodes.setup.fields.hubPublicUrlHint` / `relayPublicUrlHint` =
"外部可访问的 https 地址，例如 https://tmex.example.com。所有拟加入的节点均须可正常访问。"
Placeholders: `nodes.setup.fields.urlPlaceholder` = `https://tmex.example.com`,
`relayUrlPlaceholder` = `https://relay.example.com`.

### 3.2 Web — settings → 多节点互联 relay actions
- `apps/fe/src/pages/settings/nodes/relay/use-relay-actions.ts:28` —
  `RelayEnrollIntent = 'enroll' | 'migrate' | 'add' | 'reauth'` (接入中继 / hub→中继迁移 /
  追加中继 / 重新输入接入密码).
- `relay-dialogs.tsx:66-71` — `canSubmitRelayEnroll` gates the submit on
  `isTrustedHubUrl(form.url.trim())`; line 97 locks the URL field for `reauth` only.
- `apps/fe/src/node/relay-enroll.ts:266-275` → `RelayTenantApi.proofMaterial(url)` then
  `.enroll(...)` (`packages/api-client/src/relay/tenant-api.ts`), i.e.
  `POST /api/mesh/relay/enroll/proof-material` + `POST /api/mesh/relay/enroll` on the **local**
  gateway.
- Server side: `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/relay-routes.ts:185-231`.
  `proofMaterial` returns `relayHost: hubHostFromUrl(url)` and the enroll proof is
  **signed over that host string** (`relay-routes.ts:212-215`,
  `packages/shared/src/relay/enroll-proof.ts`).
  ⚠️ **Design constraint: the port must be resolved *before* `proof-material` is called.**
  Probing after signing would invalidate the proof (`RELAY_BAD_PROOF`).
- Outbound call: `relay-routes.ts:233-263` `callRelayEnroll` →
  `fetch(`${resolveRelayDialUrl(url,…)}/api/relay/enroll`)` with
  `RELAY_ENROLL_FETCH_TIMEOUT_MS`.
- i18n: `relay.tenant.errors.INVALID_URL` = "中继地址无效。",
  `relay.tenant.errors.RELAY_UNREACHABLE` = "无法连接该中继，请检查地址。"

### 3.3 Web — site URL (设置 → 通用)
- `apps/fe/src/pages/settings/general-fields.tsx:58-101` `SiteUrlField` — plain `<Input>`,
  **no client-side URL validation at all**; read-only when hub-managed.
- Candidates come from `linkage.siteAccessOrigins`
  (`apps/fe/src/pages/settings/site-url-candidates.tsx`), built server-side by
  `buildShareOriginContext` (§5).

### 3.4 Web — connect-devices wizard (`apps/fe/src/components/side-panels/connect-devices/`)
- **No address is typed here at all.** `computer-guide.tsx` / `connect-path.ts` pick one of
  three paths (relay / hub / ssh); `computer-join-guide.tsx:62-130` *displays* the already-known
  `relayUrl` / `hubUrl` / `tenantId` and renders copy-paste commands via
  `join-command-preview.ts`.
- `join-command-preview.ts:9,12` — `EXAMPLE_HUB_URL = 'https://tmex.example.com'`,
  `EXAMPLE_RELAY_URL = 'https://relay.example.com'` used when the real URL is unknown.
- `mobile-guide.tsx` + `access-addresses.ts:67-89` — candidate list (tunnel / hub / lan /
  current) for the QR code. LAN entries are built as
  `` `http://${ip}:${addresses.port}` `` (`access-addresses.ts:83`) from
  `GET /api/system/addresses` (`apps/gateway/src/system/access-addresses.ts:40-52`,
  `port: config.port` = the **plain-HTTP** gateway port — see §8.2).
- i18n: `connectDevices.computer.join.uplink.{relayUrl,hubUrl,relayMissing,hubMissing}`,
  `connectDevices.computer.host.hub.warning` = "Hub 公开地址设定后不可修改，先确定最终域名。"

### 3.5 CLI

Flag allowlists — `/Users/konata/code/tmex-r32/packages/app/src/lib/args.ts:198-307`
(`assertKnownFlags` at 329-337 rejects anything else):

| Command | URL source | Port-relevant flags |
|---|---|---|
| `tmex init` | `--hub-url`, `--hub-public-url`, `--relay-public-url` | `--host`, `--port`, `--peer-port` (args.ts:204-217) |
| `tmex hub join <url>` | positional `rest[0]` (`cli-auth-entry.ts:19-48`) | `--insecure-local` |
| `tmex hub standby` | `--public-url` (args.ts:248) | — |
| `tmex relay enroll <url>` / `relay reauth <url>` | positional | — |
| `tmex relay join <url> --tenant <id>` | positional (`relay-password-join.ts:27-32`) | `--ca-fingerprint` |

- `init` prompts — `/Users/konata/code/tmex-r32/packages/app/src/commands/init.ts:143`
  (`init.prompt.port`, default `defaultPort()` = 9883 from `packages/app/src/constants.ts:23-25`),
  `:210` (`'Peer port (TMEX_PEER_PORT)'`, default 39001),
  `:239` (`'Relay public URL (TMEX_RELAY_PUBLIC_URL)'`, 3 retries, `normalizeRelayPublicUrl`),
  `:272` (`'Hub public URL (TMEX_HUB_PUBLIC_URL)'`, **no format validation at all**).
  Non-interactive errors: `'init --role relay requires --relay-public-url in non-interactive mode'`
  (`init.ts:229`), `'init --role hub,node requires --hub-public-url in non-interactive mode'`
  (`init.ts:266`).
- `hub join` — `packages/app/src/commands/hub.ts:575-598`: `'hub join requires <https-url>'`,
  `'hub join --token and --password are mutually exclusive'`; URL through
  `assertHubJoinUrl` → `canonicalHubUrl` (`hub.ts:462-472`). If the token starts with `r3.`
  it delegates to `runRelayJoin` (`hub.ts:591-595`).
- `relay enroll` — `packages/app/src/commands/relay.ts:55-60,179-183`:
  ```ts
  const relayUrl = requireRelayUrl(urlRaw, command);         // normalizeRelayUrl
  const health = await fetchRelayHealth(relayUrl, io);       // GET /api/relay/health
  if (!health.ok) throw new Error(`relay is not healthy: ${relayUrl}`);
  ```
  **This is the exact failure a user hits when 443 is blocked** — and the natural CLI hook for
  port probing.
- `relay join --tenant` — `packages/app/src/lib/relay-password-join.ts:48-57`
  (`parseJoinRelayUrl` → `normalizeRelayUrl`, error `RelayPasswordJoinError('invalid_url', …)`).
- `relay-join.ts:54-73` `orderRelayEntries` — a CLI-supplied URL may only *reorder* entries
  already inside the `r3.` token: `'relay url is not listed in the join token: …'`. Port must
  match byte-for-byte after canonicalisation.
- Local admin calls always use loopback: `packages/app/src/commands/relay-shared.ts:83-96`
  (`gatewayBaseUrl` → `http://127.0.0.1:${GATEWAY_PORT}`; throws
  `'GATEWAY_PORT missing from app.env; run tmex init first'`).
- CLI help shapes: `packages/app/src/cli/help.ts:14,25,59,70`.

---

## 4. Existing probing utilities (reusable substrate)

| Utility | File:line | Endpoint | Timeout | Caching |
|---|---|---|---|---|
| `precheckHubUrl` | `packages/app/src/runtime/setup-service.ts:379-419` | `GET <url>/healthz`, expects `{status:'ok'}`; also compares `startedAt` to detect "this is me" | `AbortSignal.timeout(5_000)` (`:59`) | none |
| `probeRelayHealth` | `apps/gateway/src/mesh/relay-uplink-http.ts:29-49` | `GET <dialUrl>/api/relay/health`, `res.ok` | caller-supplied `timeoutMs`, `AbortController` | none; rewrites via `resolveRelayDialUrl` |
| `RelayEntryProbe` | `apps/gateway/src/share/relay-entry-probe.ts:1-105` | `GET <relay>/n/<selfNodeId>/api/auth/mode`, checks `body.nodeId === nodeId` | `RELAY_PROBE_TIMEOUT_MS = 5_000` | ok 10 min / bad 2 min TTL, in-flight dedupe, `invalidate()` |
| `fetchRelayHealth` (CLI) | `packages/app/src/commands/relay.ts:62-69` | `GET <relay>/api/relay/health` via `requestRelayJson` | `RELAY_REQUEST_TIMEOUT_MS = 15_000` (`relay-shared.ts:18`) | none |
| `checkHealth` (doctor) | `packages/app/src/commands/doctor-checks.ts:231-251` | local `/healthz` | `AbortSignal.timeout(3_000)` | none |
| `liveHealthUrl` + poll | `packages/app/src/lib/upgrade-health.ts:103-111,165` | local `/healthz` | `AbortSignal.timeout(4_000)` per attempt | — |
| portmap port probe (round-32, TCP-level) | `apps/gateway/src/portmap/manager.ts:165-180` (`isPortFree`), `apps/fe/src/pages/devices/portmap/use-port-probe.ts` | `GET /api/portmap/probe?host&port`, `/target-probe` | — | debounced in FE |

Anonymity of the probe endpoints is guaranteed:
`apps/gateway/src/mesh/domain-access-policy.ts:72-78`
```ts
const SERVICE_EXACT_PATHS = new Set(['/hub/uplink','/relay/uplink','/healthz','/api/relay/health']);
```
and `/healthz` is not under `/api/`, so `localUiGuard` (`assemble-routes.ts:145-149`) never
touches it. `apps/gateway/src/tunnel/access-paths.ts:12,23` also exempts `/api/relay/health`
from Cloudflare Access.

`resolveRelayDialUrl` (`apps/gateway/src/mesh/relay-dial.ts:65-81`) rewrites the dial target to
`http://127.0.0.1:<GATEWAY_PORT>` when a `relay,node` machine dials **its own** relay host —
any new probe helper must go through it (or accept a pre-resolved dial URL) to avoid hairpin-NAT
timeouts.

---

## 5. Share links / site URL / candidate addresses (round 30) — port correctness

Audited; **no port is dropped anywhere**:

- `apps/gateway/src/share/share-origins.ts:46-53` `labelOf` uses `new URL(url).host` (keeps port);
  `:55-62` `originOf` uses `URL.origin` (keeps non-default port);
  `:249-257` `isIpHost` uses `.hostname` but only for IP-literal classification.
- `collectRaw` (`:288-314`) — kinds `site` / `hub` / `relay` / `tunnel` / `ip`; all pushed as
  full URL strings from `mesh_hubs.publicUrl`, `mesh_relays.url`, `site_settings.site_url`,
  `config.baseUrl`, tunnel hostname.
- `nodeAccessUrl` (`apps/gateway/src/mesh/effective-site-url.ts:63-65`) —
  `` `${hubPublicUrl.replace(/\/+$/,'')}/n/${nodeId}` `` — port preserved.
- `normalizeShareOrigin` (`packages/shared/src/share/origins.ts:119-124`) uses `URL.origin`;
  `origins.test.ts` asserts `https://a.example.com:8443//` → `https://a.example.com:8443`.
- `isPublicShareOrigin` (`origins.ts:88-105`) judges only the hostname, so a public host on a
  high port is accepted.
- Domain-access allowlist (`apps/gateway/src/mesh/domain-access-policy.ts:20-33,63-70,141-150`)
  keeps non-default ports and additionally matches the bare hostname
  (`set.has(hostname)` fallback at `:69`), so an entry stored without a port still allows
  `host:18443`.

The only weak spot is §8.2 below (LAN candidate port).

---

## 6. install.sh / init / firewall reminder texts

- `/Users/konata/code/tmex-r32/install.sh` — **no port logic at all**; installs Bun, downloads
  the `tmex-cli-<version>.tgz` from GitHub Releases, delegates to `tmex init`.
- `/Users/konata/code/tmex-r32/packages/app/src/commands/hub.ts:665-668` — the only firewall
  reminder in shipped code (hardcoded English, not i18n'd):
  `allow inbound TMEX_PEER_PORT (${peerPort}) on the LAN firewall for direct links`
  (asserted by `packages/app/src/commands/join.test.ts:196`).
- `scripts/hub-e2e/split/run.sh:104` — the only bilingual "open TCP `${HUB_PORT}` and 39001 in
  your cloud security group / panel firewall / ufw" reminder; e2e tooling only.
- FE port/firewall copy (zh_CN): `nodes.https.portHint`, `nodes.https.errors.invalid_port`,
  `nodes.https.validation.portInvalid`, `nodes.https.acme.hints.http01` / `http01Linux`,
  `nodes.https.acme.challengeDnsHint` ("无需开放 80 端口，域名的 DNS 必须托管在所选服务商。"),
  `settings.remoteAccess.direct.entryHint` ("…需指向本机的 {{port}} 端口，或指向反向代理。"),
  `settings.remoteAccess.degradedHint` (7844), `connectDevices.computer.path.tip.relay`.
- Docs deployment styles (see §7) currently document only "proxy/tunnel in front, tmex on
  loopback:9883".

---

## 7. Tests and docs to update

### Tests that pin URL/port behaviour
| File | What it asserts |
|---|---|
| `/Users/konata/code/tmex-r32/packages/shared/src/auth/hub-url.test.ts` | `:443`/`:80` stripped, `:8443`/`:9883` kept, IPv6, idempotent |
| `/Users/konata/code/tmex-r32/packages/shared/src/relay/join-token.test.ts:64-82` | `normalizeRelayUrl` port handling; r3 encode/decode with multiple relays on distinct ports |
| `/Users/konata/code/tmex-r32/packages/shared/src/auth/enrollment.test.ts` | hub join token v1/v2 (no URL inside) |
| `/Users/konata/code/tmex-r32/apps/fe/src/pages/settings/nodes/setup/validation.test.ts` | `classifyHubUrl`/`classifyRelayUrl` for `http://127.0.0.1:19883` per `nodeEnv` |
| `/Users/konata/code/tmex-r32/packages/app/src/commands/init.test.ts:5-19` | `normalizeRelayPublicUrl(' https://Relay.Example.com:443/ ')` → `https://relay.example.com` |
| `/Users/konata/code/tmex-r32/packages/shared/src/share/origins.test.ts` | `normalizeShareOrigin` keeps `:8443`; public/private host classification with ports |
| `/Users/konata/code/tmex-r32/apps/gateway/src/share/share-origins.test.ts` | candidate ranking; fixtures on `:9663` |
| `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/effective-site-url.test.ts:176,205` | loopback-with-port stored site URL fallback |
| `/Users/konata/code/tmex-r32/apps/gateway/src/api/domain-access-routes.test.ts` | `listDomainAccessHosts()` default-port stripping |
| `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/relay-wiring.test.ts:132`, `relay-uplink-http.test.ts:34,50` | `probeRelayHealth` URL shape incl. loopback rewrite |
| `/Users/konata/code/tmex-r32/packages/app/src/commands/relay.test.ts:249`, `relay-shared.test.ts:126-175` | `/api/relay/health` path |
| `/Users/konata/code/tmex-r32/packages/app/src/runtime/setup-service.test.ts:233` | `TMEX_HUB_PUBLIC_URL=http://127.0.0.1:9443` round-trip |
| `/Users/konata/code/tmex-r32/apps/gateway/src/portmap/manager.test.ts:44,86-96` | reserved-port refusal |

### Docs
- `/Users/konata/code/tmex-r32/docs/deployment/2026021000-production-install.md:37,70,73-75,152`
  — currently only documents "loopback 9883 + nginx/Caddy/Tunnel in front". **Needs a new
  "运营商封锁 80/443" section.**
- `/Users/konata/code/tmex-r32/docs/relay/2026090304-relay-role.md:132,165-192,526` — r3 format
  and `TMEX_RELAY_PUBLIC_URL`; add "非标端口" note.
- `/Users/konata/code/tmex-r32/docs/hub/2026082800-hub-node-operations.md:28,40,84,154,243-253`
  — hub public URL, firewall reminder, tunnel/reverse-proxy section.
- `/Users/konata/code/tmex-r32/docs/operations/2026090303-acme-dns-providers.md:76-85` — already
  documents the 9443 + dns-01 recipe; generalise it from "别人的 nginx 占着 80/443" to
  "80/443 不可用（被占用或被运营商封锁)".
- `/Users/konata/code/tmex-r32/docs/onboarding/2026083101-connect-devices-panel.md` — wizard copy.
- `/Users/konata/code/tmex-r32/docs/hub/2026090301-site-settings-node-linkage.md`,
  `docs/share/2026090503-terminal-share.md:93` — site URL / share candidates.

---

## 8. Bugs / gaps found along the way

1. **`portmap` reserved ports omit the TLS listener port.**
   `/Users/konata/code/tmex-r32/apps/gateway/src/portmap/manager.ts:49-51`
   ```ts
   function defaultReservedPorts(): number[] { return [config.port, config.peerPort]; }
   ```
   A user can create a port map on 9443 (or whatever `tls_config.tls_port` is) and knock the
   HTTPS listener off the air on next restart. Should include the current `tlsPort`.
2. **LAN access-address candidates always use the plain-HTTP gateway port.**
   `apps/gateway/src/system/access-addresses.ts:44` (`port: config.port`) →
   `apps/fe/.../access-addresses.ts:83` (`http://${ip}:${port}`). If the machine is reachable
   only through the built-in HTTPS listener, the QR code points at a port that may not be
   exposed. Should also surface `tlsPort` when the listener is running.
3. **Divergent `GATEWAY_PORT` defaults** — `9663` (`apps/gateway/src/config.ts:37`) vs `9883`
   (`packages/app/src/runtime/server.ts:29`, `constants.ts:24`, `doctor-checks.ts`,
   `upgrade-health.ts:109`), plus a dead `http://127.0.0.1:8085` fallback for `TMEX_BASE_URL`
   (`apps/gateway/src/config.ts:300`).
4. **`resolveHubPublicUrl` in `tmex init` performs no validation** (`init.ts:263-275`), unlike
   the relay path which retries 3× through `normalizeRelayUrl`.
5. **Hub CA pin fetch has no timeout** — `packages/app/src/commands/hub.ts:227-267`
   (`fetchPinnedHubCa`), whereas the relay equivalent `packages/app/src/lib/relay-ca.ts:32-91`
   uses `RELAY_REQUEST_TIMEOUT_MS`. A blocked port here hangs the CLI instead of failing fast.
6. **`--url` is dead code in `relay join`** — `packages/app/src/commands/relay-password-join.ts:27-32`
   reads `flags.url`, but `relay.join`'s allowlist (`args.ts:298-307`) has no `url`, so
   `--url` is rejected by `assertKnownFlags` before it is ever read.
7. `DEFAULT_PEER_PORT`/`39001` is written literally in three places
   (`apps/gateway/src/config.ts:105`, `packages/app/src/lib/roles.ts:14`,
   `apps/gateway/src/mesh/peer-dc-upgrade.ts:506`).

---

# Recommended design

## (a) Shared module: `packages/shared/src/net/port-candidates.ts`

Exported through the existing browser-safe subpath `@tmex/shared/net`
(`packages/shared/package.json` `"./net": "./src/net/index.ts"`; the module must stay free of
`node:*` imports so the FE bundle is unaffected — it only needs `fetch` and `URL`).

### The built-in list

```ts
/**
 * 建议的高位端口。前五个是 Cloudflare 橙云代理 HTTPS 时放行的端口（套 CDN 时不必改端口即可用），
 * 后三个在 10000–32767 之间：既高于常见扫描面，也低于 Linux 默认临时端口起点 32768，
 * 不会与内核分配的出站端口抢占。低于 1024 的端口需要 root，一律不进候选。
 */
export const SUGGESTED_HIGH_PORTS = [2053, 2083, 2087, 2096, 8443, 13443, 23443, 31443] as const;
```

Justification:

| Port | Why |
|---|---|
| 2053, 2083, 2087, 2096 | The complete set of non-443 HTTPS ports Cloudflare's proxy accepts. If the operator later puts the host behind Cloudflare's orange cloud, the same port keeps working — no second migration. All are outside the top-10 mass-scan set. |
| 8443 | Universally recognised "alt-HTTPS"; also Cloudflare-proxied. Cost: most scanned of the eight, so it is offered but never auto-picked first. |
| 13443, 23443, 31443 | Unassigned by IANA, memorable (`…443` suffix ⇒ "this is the HTTPS one"), and — critically — inside **10000–32767**, i.e. above the well-known/registered congestion and **below `net.ipv4.ip_local_port_range`'s default start of 32768**. |

**Deliberate deviation from the ports named in the task brief.** `41443` and `52443` sit inside
Linux's default ephemeral range (32768–60999) *and* the Windows/macOS range (49152–65535): after
a reboot the kernel can hand one of them to an outbound connection microseconds before tmex
binds, producing an intermittent, unreproducible `EADDRINUSE`. `18443` is bitcoind's regtest RPC
default and collides on developer machines. `13443/23443/31443` avoid both classes of problem.

```ts
export function pickSuggestedPort(rng: () => number = Math.random): number {
  return SUGGESTED_HIGH_PORTS[Math.floor(rng() * SUGGESTED_HIGH_PORTS.length)]!;
}
```
(Injectable `rng` so tests are deterministic; the CLI/gateway may pass a seeded generator.)

### The prober

```ts
export type ProbeKind = 'relay' | 'hub';

export type PortProbeResult = {
  /** 探通的规范化地址，含端口（443 命中时不带端口）。 */
  url: string;
  port: number;
  /** true 表示用户显式写了端口，只做了一次确认，没有遍历候选。 */
  explicit: boolean;
};

export type ProbeAddressPortsOptions = {
  kind: ProbeKind;
  /** 单次请求超时，默认 4000。 */
  timeoutMs?: number;
  /** 候选之间的错开间隔，默认 150ms；443 先单独试 grace 毫秒。 */
  staggerMs?: number;
  graceMs?: number;
  ports?: readonly number[];          // 默认 SUGGESTED_HIGH_PORTS
  fetchImpl?: typeof fetch;           // Node/Bun 侧可注入带 tls.ca 的 fetch
  signal?: AbortSignal;
};

export function candidateUrls(hostOrUrl: string, ports?: readonly number[]): string[];
export async function probeAddressPorts(
  hostOrUrl: string,
  options: ProbeAddressPortsOptions
): Promise<PortProbeResult | null>;
```

Behaviour:

1. **Parse.** Accept `host`, `host:port`, `scheme://host[:port][/path]`. A bare host becomes
   `https://host` (loopback hosts may become `http://` so dev/test keeps working). Everything is
   pushed through `canonicalHubUrl` so the result is byte-identical to what the rest of the
   system stores and signs.
2. **Explicit port ⇒ single check.** Verify once and return `{explicit: true}` (or `null`).
   Never silently move a user off a port they typed.
3. **No port ⇒ 443 first, with a grace window.** Fire 443; if it answers within `graceMs`
   (default 800 ms) return it — the overwhelming majority of deployments. Only if it has not
   answered do the eight candidates start, staggered `staggerMs` apart so a working port on the
   list is found in <2 s while never sending more than a handful of concurrent connections.
   443 keeps racing; if it wins late it still takes precedence.
4. **Role-specific health endpoint.** Both are anonymous and exempt from the domain-access and
   Cloudflare-Access guards (`apps/gateway/src/mesh/domain-access-policy.ts:72-78`,
   `apps/gateway/src/tunnel/access-paths.ts:23`):
   - `relay` → `GET <base>/api/relay/health`, accept `res.ok && body.ok === true`
     (shape from `apps/gateway/src/relay/relay-routes.ts:346`, parsed by
     `packages/app/src/commands/relay.ts:43-53`).
   - `hub` → `GET <base>/healthz`, accept `status === 200 && body.status === 'ok'`
     (same predicate as `precheckHubUrl`, `packages/app/src/runtime/setup-service.ts:403`).
5. `redirect: 'error'`, `AbortSignal.timeout(timeoutMs)`, all failures swallowed into `null` —
   same discipline as `RelayEntryProbe.checkEntry`
   (`apps/gateway/src/share/relay-entry-probe.ts:91-104`).
6. Every loser is aborted as soon as a winner is decided, so a probe costs at most
   `graceMs + 8 × staggerMs + timeoutMs` ≈ 6 s worst case, ~0.9 s in the common case.

**Where it must NOT run:** the browser. Keep the existing invariant that only the local Bun
process makes cross-machine requests (a browser probe would be blocked by CORS on
`/api/relay/health`, and by mixed-content when the UI is served over HTTPS and the candidate is
`http://`). The FE calls a local endpoint instead (below).

Companion helper for setup, in the same module:
```ts
/** 拿一个建议端口，避开本机已占用的端口（gateway / peer / tls）。 */
export function pickSuggestedPortAvoiding(used: readonly number[], rng?): number;
```

## (b) Where web and CLI call it, and the copy

### Web
1. **`POST /api/setup/precheck` gains port probing.**
   `packages/app/src/runtime/setup-service.ts:379-419` — when `assertSetupUrl` yields a URL with
   **no explicit port**, call `probeAddressPorts(url, {kind:'hub'})` instead of the single
   `/healthz` fetch. Extend `PrecheckResult` with `resolvedUrl: string | null` and
   `triedPorts: number[]`. `become-hub-form.tsx` / `join-hub-form.tsx` then show a one-line
   result and offer to write the resolved URL back into the field.
   Copy (zh_CN, following `/Users/konata/code/tmex-r32/../tmex-copy-guidelines.md` — terse, no
   second person):
   - `nodes.setup.precheck.resolvedPort` = `已在 {{port}} 端口探测到 Hub，地址已更新。`
   - `nodes.setup.precheck.probing` = `正在探测常用端口…`
   - `nodes.setup.precheck.unreachableAllPorts` = `443 及内置候选端口均无响应。请确认端口已放行，或直接填写带端口的地址。`
2. **New `POST /api/mesh/relay/resolve`** (authenticated, next to `proof-material` in
   `apps/gateway/src/mesh/relay-routes.ts`) → `{ url }` in, `{ url, port, explicit } | null` out.
   `apps/fe/src/node/relay-enroll.ts:266` calls it **before** `proofMaterial`, because the
   enroll proof is signed over `hubHostFromUrl(url)` (`relay-routes.ts:190,212`). The relay
   dialogs (`relay-dialogs.tsx`) get a "探测" affordance identical to the hub one.
   - `relay.tenant.dialog.probing` = `正在探测中继端口…`
   - `relay.tenant.dialog.resolvedPort` = `中继在 {{port}} 端口。`
3. **`join-relay-form.tsx` / `join-hub-form.tsx`**: run the probe automatically on blur when the
   field has no port, silently; only surface the outcome if it changed the URL or everything
   failed. Never block submit on it.
4. Placeholders/hints stay `https://tmex.example.com` (a port in the placeholder would suggest it
   is required). Add one hint line under the address fields:
   - `nodes.setup.fields.portHint` = `未写端口时按 443 及内置候选端口探测。`

### CLI
- `packages/app/src/commands/relay.ts:179-183` — replace the single `fetchRelayHealth` with
  `probeAddressPorts(relayUrl, {kind:'relay'})` when the URL has no port; on success log
  `relay found on port <p>` and continue with the resolved URL (so the signed proof and the
  stored `mesh_relays.url` both carry the port). On failure keep the existing
  `relay is not healthy: <url>` but append the tried ports.
- `packages/app/src/lib/relay-password-join.ts:48-57` and
  `packages/app/src/commands/relay-password-join.ts` — same treatment for `tmex relay join`.
- `packages/app/src/commands/hub.ts:596` (`runHubJoin`) — probe with `kind:'hub'` before
  `prepareHubJoin`; the resolved URL is what gets canonicalised and written to `TMEX_HUB_URL`.
- `packages/app/src/lib/hub-client.ts:227`-adjacent `fetchPinnedHubCa` — add the missing timeout
  while touching this path (§8.5).
- Skip probing entirely when `--insecure-local` is set or the host is loopback.

## (c) Letting the operator choose a port at setup — and who must listen there

**`tmex init` (interactive)**, `packages/app/src/commands/init.ts:191-275`: after the role
prompt, when the role is `hub,node`, `relay` or `relay,node`, ask a new question *before* the
public-URL prompt:

```
Public HTTPS port [443 / suggested 23443 / custom]:
```
- Default stays `443` (unchanged behaviour for everyone whose ISP is fine).
- Choosing "suggested" calls `pickSuggestedPortAvoiding([gatewayPort, peerPort, tlsPort])`.
- The chosen port is then pre-filled into the public-URL prompt
  (`https://<host>:<port>`) so `normalizeRelayPublicUrl` / the hub prompt receive a complete URL.
- Non-interactive: no new required flag — `--relay-public-url https://h:23443` already works.
  Optionally add `--public-port <n>` as sugar that is only consulted when the public-URL flag has
  no port.

**Web setup** (`become-hub-form.tsx`, `become-relay-form.tsx`): add a small segmented control next
to the address field — `标准 443 / 建议 {{port}} / 自定义` — that only rewrites the port component
of the URL the user is typing. Copy:
- `nodes.setup.fields.publicPort` = `公网端口`
- `nodes.setup.fields.publicPortHint` = `443 被运营商封锁时改用高位端口。同一端口需在下方 HTTPS 设置或反向代理上监听。`
- `nodes.setup.fields.publicPortSuggest` = `随机建议`

**Which component must actually bind that port** — this is the part operators get wrong, so the
UI/doc must state it per deployment style:

| Deployment style (docs) | Who binds the public port | What to change for a high port |
|---|---|---|
| **Reverse proxy in front** (nginx / Caddy / 宝塔) — `docs/deployment/2026021000-production-install.md:73-75`, the default recommendation | the **proxy** | change the proxy's `listen`/site port; tmex stays on loopback `GATEWAY_PORT`; set `TMEX_TRUST_PROXY=true`; put the port into `TMEX_HUB_PUBLIC_URL` / `TMEX_RELAY_PUBLIC_URL` / `site_url` |
| **tmex's own HTTPS listener** — `docs/operations/2026090303-acme-dns-providers.md:76-85` | **tmex** (`HttpsListener`, `packages/app/src/tls/https-listener.ts:41-61`) | set `tlsPort` via 设置 → 节点 → HTTPS (`PUT /api/tls`); default is already 9443; certificate via **ACME dns-01** (http-01 needs port 80 and is unusable here); `TMEX_TRUST_PROXY` must be **off** |
| **Plain HTTP exposed directly** (`TMEX_BIND_HOST=0.0.0.0`) | **tmex gateway** (`server.ts:45-50`) | change `GATEWAY_PORT` in `app.env` (or `tmex init --port`); only acceptable on a LAN or behind a tunnel — no TLS |
| **Cloudflare Tunnel** — `docs/hub/2026082800-hub-node-operations.md:243-253` | **Cloudflare edge (443)**, nothing local | out of scope; the edge port cannot be moved. Connector needs outbound 7844 |
| **Cloudflare orange-cloud DNS in front of your own server** | your proxy or tmex's HTTPS listener | must be one of `2053/2083/2087/2096/8443` — exactly why they are in the suggestion list |
| **Docker node** — `docs/hub/2026090402-docker-node.md` | the **host port mapping** | change `-p <hostPort>:9883`; container internals stay 9883/39001 |

Also: reserve the TLS port in portmap (`apps/gateway/src/portmap/manager.ts:49-51`) so the
port-mapping feature cannot steal it, and surface the HTTPS port in
`GET /api/system/addresses` so the mobile QR candidate is right (§8.1, §8.2).

## (d) How join tokens should carry explicit ports

- **`r3.` relay tokens: no format change.** They already embed each relay's canonical URL,
  ports included (`packages/shared/src/relay/join-token.ts:105-109,149-155`), the 512-byte
  per-URL cap is untouched, and `join-token.test.ts:67` already covers `:8443`. Only add a test
  asserting a candidate from `SUGGESTED_HIGH_PORTS` round-trips.
- **Hub tokens: keep the 96-byte format.** Do **not** invent an `h3.` variant — that would touch
  `encodeJoinToken`/`decodeJoinToken`, the FE regex
  (`apps/fe/src/pages/settings/nodes/setup/validation.ts:18`), the CLI, hub-side redeem and
  every existing token in flight, for no security benefit. The hub URL already travels beside
  the token in the command string that the UI generates
  (`apps/fe/src/node/enrollment.ts:765-771` → `tmex hub join 'https://h:23443' --token …`,
  `shellQuote` handles the colon). What must be guaranteed instead:
  1. `hubPublicUrl` used for `joinCommand()` comes from the hub itself (already true, and the
     comment at `enrollment.ts:757-763` explains why), so the port is whatever the hub advertises;
  2. `isTrustedHubUrl` keeps accepting ports (it does);
  3. when the user pastes a token but types the hub host without a port, the probe from (b)
     fills it in.
- The `.<64hex>` CA-fingerprint suffix is unaffected in both formats: the split is on the outer
  token string, and no URL bytes leak outside base64url.

## (e) Files to change — smallest blast radius

**New**
1. `/Users/konata/code/tmex-r32/packages/shared/src/net/port-candidates.ts` — `SUGGESTED_HIGH_PORTS`,
   `pickSuggestedPort`, `pickSuggestedPortAvoiding`, `candidateUrls`, `probeAddressPorts`.
2. `/Users/konata/code/tmex-r32/packages/shared/src/net/port-candidates.test.ts`.

**Edit (one-line / small)**
3. `/Users/konata/code/tmex-r32/packages/shared/src/net/index.ts` — re-export.
4. `/Users/konata/code/tmex-r32/packages/app/src/runtime/setup-service.ts:379-419` — probe inside
   `precheckHubUrl`; add `resolvedUrl` / `triedPorts` to `PrecheckResult`.
5. `/Users/konata/code/tmex-r32/packages/api-client/src/local/setup-api.ts:78-86` +
   `packages/api-client/src/local/types.ts` — carry the two new fields.
6. `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/relay-routes.ts` — add
   `POST /api/mesh/relay/resolve` (≈20 lines, reuse `normalizeUrlOrNull` +
   `resolveRelayDialUrl`); register in `relay-routes-input.ts` if input parsing is needed.
7. `/Users/konata/code/tmex-r32/packages/api-client/src/relay/tenant-api.ts` — `resolve()` method.
8. `/Users/konata/code/tmex-r32/apps/fe/src/pages/settings/nodes/setup/become-hub-form.tsx` and
   `join-hub-form.tsx`, `become-relay-form.tsx`, `join-relay-form.tsx` — probe on blur + result line.
9. `/Users/konata/code/tmex-r32/apps/fe/src/node/relay-enroll.ts:266` — call `resolve()` before
   `proofMaterial`.
10. `/Users/konata/code/tmex-r32/packages/app/src/commands/relay.ts:179-183` — probe before the
    health gate.
11. `/Users/konata/code/tmex-r32/packages/app/src/commands/hub.ts:596` — probe before
    `prepareHubJoin`; add the missing timeout to `fetchPinnedHubCa` (`hub.ts:227-267`).
12. `/Users/konata/code/tmex-r32/packages/app/src/lib/relay-password-join.ts:48-57` — probe.
13. `/Users/konata/code/tmex-r32/packages/app/src/commands/init.ts:191-275` — public-port question
    + validate `hubPublicUrl` through `assertHubJoinUrl` like the relay path does.
14. `/Users/konata/code/tmex-r32/apps/gateway/src/portmap/manager.ts:49-51` — reserve `tlsPort`.
15. `/Users/konata/code/tmex-r32/apps/gateway/src/system/access-addresses.ts:40-52` +
    `apps/fe/src/components/side-panels/connect-devices/access-addresses.ts:83` — emit/consume the
    HTTPS port when the built-in listener is running.
16. i18n **source** files only —
    `/Users/konata/code/tmex-r32/packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`
    (new keys listed in (b)/(c)), then `bun run build:i18n` from the repo root. Never hand-edit
    `resources.ts` / `types.ts` / `locales/generated/*`.

**Docs**
17. `/Users/konata/code/tmex-r32/docs/deployment/2026021000-production-install.md` — new
    "80/443 被封锁时的高位端口部署" section with the four-style table from (c).
18. `/Users/konata/code/tmex-r32/docs/relay/2026090304-relay-role.md`,
    `/Users/konata/code/tmex-r32/docs/hub/2026082800-hub-node-operations.md`,
    `/Users/konata/code/tmex-r32/docs/operations/2026090303-acme-dns-providers.md` — cross-links
    and the "端口探测" behaviour.

**Explicitly out of scope**
- The `r3.` and hub join-token binary formats (§d).
- `canonicalHubUrl` / `normalizeRelayUrl` semantics — they are already correct.
- Cloudflare Tunnel edge port.
- Any browser-side cross-origin probing.
