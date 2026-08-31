# Settings-tab latency investigation

## Executive finding

The strongest multi-second latency suspect is `remoteAccess`.

`RemoteAccessTab` renders nothing beyond a spinner until `useTunnelStatus` resolves (`apps/fe/src/pages/settings/remote-access/remote-access-tab.tsx:83-91`). Its request handler synchronously awaits external tunnel detection:

- `apps/gateway/src/api/tunnel-routes.ts:162-172`
- `apps/gateway/src/tunnel/manager.ts:578-584`

The detector has a 30-second cache (`apps/gateway/src/tunnel/external-detect.ts:82-83,833-851`), but the first request and every expired-cache request can synchronously perform process inspection, filesystem scans, and several sequential Cloudflare API requests. The Cloudflare client has no application-level timeout (`apps/gateway/src/tunnel/access-client.ts:431-480`).

The `nodes` tab has the second most significant issue: it blocks the entire tab on `/api/auth/mode`, and `/api/local/status` itself performs local-status work and TLS-status work sequentially (`packages/app/src/runtime/local-routes.ts:68-75`).

The other tabs mostly render their shell immediately and show localized loading placeholders. Their backend handlers are primarily small synchronous SQLite queries and do not perform external probes.

---

## Common chunk-level behavior

All tab components are dynamically imported through `lazyChunk`:

`apps/fe/src/pages/settings/SettingsPage.tsx:45-67`

The active tab is rendered inside Suspense:

`apps/fe/src/pages/settings/SettingsPage.tsx:197-222`

Therefore, no tab content can appear until its lazy chunk has loaded. Round 7’s preload/idle behavior reduces this cost, but it does not eliminate it.

`apps/fe/src/pages/settings/chunk-preload.ts:25-28,58-87`

`apps/fe/src/pages/settings/data-prefetch.ts:41-75`

There is no manual Rollup chunk configuration in the current Vite config:

`apps/fe/vite.config.ts:45-76`

No `manualChunks` configuration exists in the repository.

`lazyChunk` does not automatically retry failed imports. It allows two user-triggered retries and then reloads the page:

`apps/fe/src/lazy-chunk.tsx:10-19,54-80`

Preload failures are silently swallowed:

`apps/fe/src/pages/settings/chunk-preload.ts:40-51`

Round 7’s recorded output sizes were approximately:

| Chunk | Recorded size |
|---|---:|
| General | 9.85 kB |
| Terminal | 18.89 kB |
| AI | 20.20 kB |
| Notifications | 32.57 kB |
| Devices | 0.86 kB |
| Nodes | 84.31 kB |
| Remote access | 51.06 kB |

Source: `prompt-archives/2026083100-perf-smell-round7/sub/BO-result.md:68-81`

The terminal chunk statically includes Ghostty:

- `packages/panels/src/settings/terminal-settings-panel.tsx:3,82`
- `packages/terminal-ui/src/components/TerminalPreview.tsx:4`

The notifications chunk statically includes `qrcode.react`, even though QR rendering occurs only when the login modal is opened:

- `packages/panels/src/settings/weixin-account-row.tsx:14`
- `packages/panels/src/settings/weixin-account-login-modal.tsx:10,240-258`

I found no direct Monaco, xterm runtime, Mermaid, or KaTeX import in the settings-node path. The xterm references found in terminal code are type/comments or general terminal implementation references, not a separate settings-tab request.

---

# Per-tab analysis

## 1. General

### Client requests and loading behavior

1. Site settings:

   - Hook: `useSiteSettingsForm`
   - Request: `GET /api/settings/site`
   - References:
     - `apps/fe/src/pages/settings/SettingsPage.tsx:103-107,133-142`
     - `apps/fe/src/pages/settings/use-site-settings-form.ts:61-79`

   This query is enabled when the active tab is `general` or `notifications`. The form uses a draft/default object immediately, so it does not blank the tab while loading.

2. System information:

   - Component: `VersionTab`
   - Request: `GET /api/system/info`
   - References:
     - `packages/panels/src/settings/use-version-tab.ts:32-49`
     - `packages/panels/src/settings/version-tab.tsx:15-51`

   `VersionInfoRows` renders loading placeholders for missing fields:

   `packages/panels/src/settings/version-tab-sections.tsx:36-64`

3. Update check:

   - Request: `GET /api/system/update-check`
   - Only enabled after the user clicks the update-check action.
   - References:
     - `packages/panels/src/settings/use-version-tab.ts:51-60`
     - `apps/gateway/src/api/system.ts:34-36,52-59`

### Waterfalls and rendering gates

- Site settings and system information are independent.
- The site-settings query starts at the page level; system info starts when `VersionTab` mounts.
- The tab does not wait for both requests. It renders the form and system-info placeholders independently.
- The only full blank state is the outer lazy-chunk Suspense fallback.

### Backend cost

`GET /api/settings/site`:

- Handler: `apps/gateway/src/api/settings-routes.ts:20-22`
- Cache: 30-second in-memory cache.
- Cache miss:
  - One SQLite read.
  - Possible row initialization.
  - Possible i18n language update.
- References:
  - `apps/gateway/src/db/site-settings.ts:35-65`

`GET /api/system/info`:

- Handler: `apps/gateway/src/api/system.ts:24-30`
- Reads install metadata from disk only in production:
  - `apps/gateway/src/system/install-info.ts:38-45`
- Development/test return static information:
  - `apps/gateway/src/system/install-info.ts:59-90`
- No child process, network call, or TLS probe.

The update check is not part of initial tab load. When explicitly requested, it makes a GitHub request with a 10-second timeout:

`apps/gateway/src/system/update-check.ts:6-7,24-56`

---

## 2. Terminal

### Client requests and loading behavior

1. Terminal shortcuts:

   - Hook: `useTerminalShortcutsEditor`
   - Request: `GET /api/settings/terminal-shortcuts`
   - References:
     - `packages/panels/src/settings/use-terminal-shortcuts-editor.ts:305-358`
     - `apps/fe/src/pages/settings/data-prefetch.ts:46-48`

   `TerminalShortcutsEditor` displays its loading state until the editor model is ready:

   `packages/panels/src/settings/TerminalShortcutsEditor.tsx:61-89`

2. Terminal preview:

   - No backend request.
   - `TerminalPreview` loads fonts and initializes Ghostty asynchronously.
   - References:
     - `packages/panels/src/settings/terminal-settings-panel.tsx:45-83`
     - `packages/terminal-ui/src/components/TerminalPreview.tsx:51-161`

   The internal client-side sequence is:

   `loadTerminalFonts` → `createTerminalController` → terminal open/fit/render

   `packages/terminal-ui/src/components/TerminalPreview.tsx:79-102,118-144`

   Font loading can call `document.fonts.load`:

   `packages/theme/src/fonts/index.ts:26-65`

### Waterfalls and rendering gates

- The shortcuts query and Ghostty initialization start independently after the component mounts.
- The entire terminal tab is not gated on the shortcuts request.
- The preview container itself renders, but its usable terminal content appears only after font loading and Ghostty startup.
- There is no theme-preset or font-list network request on initial load.

### Backend cost

`GET /api/settings/terminal-shortcuts`:

- Handler: `apps/gateway/src/api/settings-routes.ts:37-39`
- One SQLite read.
- If the row is absent, it inserts defaults and reads again.
- References:
  - `apps/gateway/src/db/terminal-shortcuts.ts:25-46`

No process spawn, filesystem scan, TLS parsing, or outbound request occurs.

### Chunk concern

The most relevant terminal latency is client-side dependency/runtime work, not the endpoint. `TerminalPreview` statically imports `ghostty-terminal`:

`packages/terminal-ui/src/components/TerminalPreview.tsx:4`

---

## 3. Remote access

### Client requests and loading behavior

1. Tunnel status:

   - Hook: `useTunnelStatus`
   - Request: `GET /api/tunnel/status`
   - References:
     - `apps/fe/src/pages/settings/remote-access/use-tunnel-status.ts:1-42`
     - `packages/api-client/src/local/tunnel-api.ts:40-46`

2. Shared authentication mode:

   - Hook: `useSharedAuthMode`
   - Request: `GET /api/auth/mode`
   - It is called in the same render as tunnel status.
   - References:
     - `apps/fe/src/pages/settings/remote-access/remote-access-tab.tsx:52-66`
     - `apps/fe/src/node/mesh-nodes.ts:249-261`

`RemoteAccessTab` waits only for tunnel status:

`apps/fe/src/pages/settings/remote-access/remote-access-tab.tsx:83-91`

Authentication mode is not a full-tab gate. A remote-node view can instead show a static notice:

`apps/fe/src/pages/settings/remote-access/remote-access-tab.tsx:30-34`

The tunnel polling interval is:

- 2 seconds while a tunnel job/process is starting.
- 10 seconds otherwise.

`apps/fe/src/pages/settings/remote-access/tunnel-model.ts:375-383`

### Backend cost: primary suspect

The route explicitly awaits external refresh before returning:

`apps/gateway/src/api/tunnel-routes.ts:162-172`

The manager status calculation itself performs several per-request local operations:

`apps/gateway/src/tunnel/manager.ts:286-349`

- Managed binary existence check and `Bun.which`.
- Persisted tunnel-config DB read.
- Origin certificate existence check.
- Access status DB read/decryption state.
- State derivation.

These are generally cheap, but they are recomputed on every status request.

The external detector has a 30-second cache:

`apps/gateway/src/tunnel/external-detect.ts:82-83,833-851`

However, on the first request or after expiry, `detectUncached` can perform:

1. Synchronous `ps` process listing:

   `apps/gateway/src/tunnel/external-detect.ts:85-93`

2. Launchd and systemd directory scans and file reads:

   `apps/gateway/src/tunnel/external-detect.ts:657-695`

3. Cloudflared configuration and token-file reads:

   `apps/gateway/src/tunnel/external-detect.ts:251-327,454-475`

4. Cloudflare tunnel-name lookup:

   `apps/gateway/src/tunnel/external-detect.ts:281-288,636-655`

5. Cloudflare ingress lookup if local config does not provide hostnames:

   `apps/gateway/src/tunnel/external-detect.ts:590-634`

6. Cloudflare Access probing:

   `apps/gateway/src/tunnel/external-detect.ts:190-220`

   This can call:

   - `listApps`
   - `getOrganization`

   `apps/gateway/src/tunnel/access-client.ts:69-95,157-186`

`listApps` can make up to 50 sequential pagination requests:

`apps/gateway/src/tunnel/access-client.ts:157-186`

The Cloudflare request wrapper does not provide an `AbortSignal` or explicit timeout:

`apps/gateway/src/tunnel/access-client.ts:431-480`

Therefore:

- The route calls refresh synchronously on every status request.
- The expensive uncached detection runs only on the first/expired detector cache.
- The Cloudflare Access probe runs only when detection has suitable credentials and hostnames.
- There is no stale-while-revalidate behavior.
- There is no in-flight deduplication for simultaneous expired-cache requests.
- There is no application-level timeout for these Cloudflare calls.

`cloudflared --version` is not run on every status request. It is used during manager startup/version probing:

- `apps/gateway/src/tunnel/manager.ts:255-277`
- `apps/gateway/src/tunnel/provider.ts:103-117`

Likewise, the settings paths do not invoke `tmux -V`, `launchctl`, or `systemctl`. Launchd/systemd are inspected by reading directories/files, not by spawning those commands.

---

## 4. Devices and files

### Client requests and loading behavior

1. File roots:

   - Hook: `useFileRootsQuery`
   - Request: `GET /api/files/roots`
   - References:
     - `packages/panels/src/settings/files-tab.tsx:78-105`
     - `packages/panels/src/settings/file-root-query.ts:102-115`

   The roots list shows a localized loading state:

   `packages/panels/src/settings/files-tab.tsx:117-175`

2. Devices:

   - Request: `GET /api/devices`
   - References:
     - `packages/panels/src/settings/files-tab.tsx:78-97`
     - `apps/fe/src/components/global-device-provider.tsx:297-327`

The two queries are created in the same render and are not dependent. The devices query is mainly used for add/edit modal options and does not gate the root list.

The device entry card itself is static:

`packages/panels/src/settings/device-entry-card.tsx:8-27`

If the files feature is disabled, the files panel returns early:

`packages/panels/src/settings/files-tab.tsx:47-51`

### Backend cost

`GET /api/devices`:

- Handler: `apps/gateway/src/api/device-routes.ts:38-60`
- One SQLite query with a runtime-status join.
- References:
  - `apps/gateway/src/db/devices.ts:177-191`

No tmux probe, child process, network request, or filesystem scan occurs.

`GET /api/files/roots`:

- Handler: `apps/gateway/src/api/file-root-routes.ts:23-38,109-110`
- Reads file roots from SQLite.
- Performs a device lookup for each root.
- References:
  - `apps/gateway/src/db/file-roots.ts:15-18`

This is an N+1-style query pattern for many roots, but it should not create multi-second latency under normal small datasets. There is no filesystem scan or remote-device access.

---

## 5. Nodes

### Client requests and loading behavior

1. Shared auth mode:

   - Request: `GET /api/auth/mode`
   - Hook/store: `useSharedAuthMode`
   - References:
     - `apps/fe/src/pages/settings/nodes/nodes-tab.tsx:17-43`
     - `apps/fe/src/node/mesh-nodes.ts:249-261`

2. Local status:

   - Hook: `useLocalStatus`
   - Request: `GET /api/local/status`
   - References:
     - `apps/fe/src/pages/settings/nodes/use-local-status.ts:25-32`
     - `packages/api-client/src/local/local-api.ts:47-55`

3. TLS status:

   - Hook: `useTlsStatus`
   - Request: `GET /api/tls`
   - References:
     - `apps/fe/src/pages/settings/nodes/https/use-tls-status.ts:29-40`
     - `apps/fe/src/pages/settings/nodes/https/https-section.tsx:58-80`

4. Mesh node list:

   - Request: `GET /api/mesh/nodes`
   - Hook: `useMeshNodes`
   - References:
     - `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:36-49`
     - `apps/fe/src/node/mesh-nodes.ts:292-308,351-378`

5. Hub node list:

   - Request: `GET /n/<hub>/api/hub/nodes`
   - Hook: `useHubNode`
   - References:
     - `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:36-49`
     - `apps/fe/src/node/mesh-nodes.ts:435-484`
     - `apps/fe/src/node/hub-api.ts:63-78`

`NodesTab` blocks the entire tab until auth mode is loaded:

`apps/fe/src/pages/settings/nodes/nodes-tab.tsx:37-43`

`useSharedAuthMode` and `useLocalStatus` are invoked in the same render, so they can start concurrently. However:

- TLS UI is not mounted until the mode/local-status conditions are satisfied.
- In the mesh path, `/api/local/status` must resolve before the TLS section is shown.
- Node management is mounted after the mode gate.
- Hub-node loading may follow hub-ID resolution, creating a smaller client-side dependency chain.

`HttpsSection` has its own TLS loading state:

`apps/fe/src/pages/settings/nodes/https/https-section.tsx:82-108`

The auth-mode and mesh-node state are resident at app level, so these requests may already be warm when navigating to Settings:

- `apps/fe/src/node/mesh-nodes-resident.tsx:9-12`
- `apps/fe/src/main.tsx:129-148`

### Backend cost

`GET /api/auth/mode`:

- Handler: `apps/gateway/src/mesh/auth-routes.ts:157-203`
- Awaits TLS information.
- Reads local-auth user data.
- May find a primary user by scanning certificates/nodes and performing additional DB lookups.
- References:
  - `apps/gateway/src/mesh/auth-routes.ts:184-203,800-814`
  - `apps/gateway/src/db/local-auth-http.ts:33-64`

No child process or outbound network request occurs, but TLS/certificate work and multiple SQLite reads are on the request path. There is no server-side mode cache.

`GET /api/local/status`:

- Handler: `packages/app/src/runtime/local-routes.ts:53-86`
- Sequentially awaits:
  1. `getLocalStatus`
  2. `tlsStatus`

  `packages/app/src/runtime/local-routes.ts:68-75`

`getLocalStatus` performs manifest and environment-file reads:

- `packages/app/src/runtime/setup-service.ts:462-479`
- `packages/app/src/runtime/setup-service.ts:342-345`
- `packages/app/src/lib/native-datachannel.ts:85-107`
- `packages/app/src/runtime/setup-service.ts:420-429`
- `packages/app/src/lib/env-file.ts:30-33`

TLS status performs DB reads and certificate parsing:

- `packages/app/src/tls/tls-service.ts:197-237`
- `apps/gateway/src/tls/tls-config-store.ts:94-126`
- `packages/app/src/tls/cert-authority.ts:107-124`

`GET /api/tls` uses the same TLS service:

`packages/app/src/runtime/tls-routes.ts:34-56`

There is no process spawn or network probe on these status endpoints, but the local-status route has an avoidable additive waterfall.

`GET /api/mesh/nodes`:

- Handler: `apps/gateway/src/mesh/mesh-routes.ts:91-95,157-230`
- Reads certificates, peers, nodes, and runtime status from SQLite/in-memory stores.
- Decodes certificates and parses inventory per node.
- No child process, network probe, or explicit timeout.

`GET /api/hub/nodes`:

- Handler: `apps/gateway/src/hub/hub-runtime.ts:190-205,235-270`
- Reads node rows.
- Performs per-node certificate and enrollment-token lookups.
- Parses certificate/token data.
- No network probe or process spawn, but it is another O(N) database pattern.

---

## 6. Notifications

### Client requests and loading behavior

The three notification panels mount as siblings:

`apps/fe/src/pages/settings/notification-settings-tab.tsx:15-18,21-151`

1. Telegram:

   - `GET /api/settings/telegram/bots`
   - `packages/panels/src/settings/telegram-bots-tab.tsx:15-31,56-58`

2. Weixin:

   - `GET /api/settings/weixin/accounts`
   - `packages/panels/src/settings/weixin-accounts-tab.tsx:15-33,65-67`

3. Webhooks:

   - `GET /api/webhooks`
   - `packages/panels/src/settings/webhooks-tab.tsx:37-57,196-203`

The requests are independent and start concurrently. Each panel displays its own loading state. The whole tab does not wait for all three.

The site-settings query also starts independently at the page level.

### Backend cost

Telegram:

- Handler: `apps/gateway/src/api/telegram-routes.ts:78-81`
- Two SQLite queries: bots and chat rows.
- JavaScript aggregation.
- `apps/gateway/src/db/telegram.ts:48-84`

Weixin:

- Handler: `apps/gateway/src/api/weixin-routes.ts:69-72`
- Two SQLite queries: accounts and users.
- JavaScript aggregation.
- `apps/gateway/src/db/weixin.ts:52-100`

Webhooks:

- Handler: `apps/gateway/src/api/webhook-routes.ts:50-53`
- One SQLite query/map.
- `apps/gateway/src/db/webhooks.ts:23-31`

No initial-list request performs outbound messaging, TLS work, filesystem scanning, or child-process spawning. Telegram/Weixin network calls are action paths only, such as test/login actions.

---

## 7. AI

### Client requests and loading behavior

1. Provider and model list:

   - Hook/query: `llmProvidersQueryKey`
   - Request: `GET /api/llm/providers`
   - References:
     - `packages/panels/src/settings/llm-providers-tab.tsx:18-28,53-55`
     - `apps/fe/src/pages/settings/data-prefetch.ts:41-45`

   Provider models are included in this response. There is no separate initial model-list request.

2. LLM settings:

   - Request: `GET /api/llm/settings`
   - Used by defaults and search settings.
   - References:
     - `packages/panels/src/settings/llm-providers-tab.tsx:75-109`
     - `packages/panels/src/settings/search-tab.tsx:25-50`

Both components use the same `['llm-settings']` query key, so React Query should deduplicate the request.

The provider card shows a local loading state, but the entire AI tab is not gated. Defaults and search forms render with fallback values while settings are pending.

Provider model refresh is an explicit user action, not part of the initial GET:

`apps/gateway/src/api/llm.ts:86-107`

### Backend cost

`GET /api/llm/providers`:

- Handler: `apps/gateway/src/api/llm.ts:110-113`
- Reads all providers from SQLite.
- Computes/merges/sorts configured, manually added, fetched, and disabled models.
- References:
  - `apps/gateway/src/api/llm.ts:48-62`
  - `apps/gateway/src/db/llm.ts:62-65,124-147`

No provider API call occurs during this GET.

`GET /api/llm/settings`:

- Handler: `apps/gateway/src/api/llm.ts:265-271`
- One SQLite settings read, with default-row insertion if necessary.
- `apps/gateway/src/db/agent.ts:47-60`

No explicit server cache exists, but these handlers are local and normally inexpensive.

---

# React Query and revisit behavior

Each node runtime receives a separate QueryClient:

`apps/fe/src/node/node-runtime-boundary.tsx:41-58`

The defaults are:

- `staleTime: 5000`
- `retry: 1`

`apps/fe/src/node/node-runtimes.ts:260-268`

There is no project override for `refetchOnMount` or `refetchOnWindowFocus`, so the normal TanStack defaults apply.

Consequences:

- After five seconds, settings queries are stale.
- Revisiting a tab can trigger a refetch on mount.
- Window focus can also refetch most queries.
- Existing cached data generally remains visible during background refetch.
- The protected status hook specifically uses `isPending`, not `isFetching`, for its loading projection:

  `apps/fe/src/pages/settings/use-protected-status-query.ts:46-61,82-103`

Therefore, revisiting a tab should not show a full spinner when cached status data exists. A spinner reappears when there is no cached data, the node QueryClient was recreated, a prior request failed, or data was explicitly invalidated.

The site settings query disables focus refetch but has no explicit longer stale time:

`apps/fe/src/pages/settings/use-site-settings-form.ts:61-68`

The site loader deduplicates in-flight requests but is not itself a persistent client cache:

`packages/stores/src/site-settings-loader.ts:35-43,61-110`

The backend site-settings cache is 30 seconds:

`apps/gateway/src/db/site-settings.ts:35-65`

---

# Prioritized fix list

## Backend engineer

### P0 — Make tunnel detection stale-while-revalidate

Files:

- `apps/gateway/src/api/tunnel-routes.ts:162-172`
- `apps/gateway/src/tunnel/manager.ts:578-584`
- `apps/gateway/src/tunnel/external-detect.ts:833-851`

Change:

- Return the last external-detection result immediately.
- When the 30-second TTL expires, start one background refresh instead of awaiting it.
- Add an in-flight promise to prevent duplicate scans during concurrent cache misses.
- Optionally return `probing: true` or an equivalent freshness field.
- Start the first detection during manager startup/background initialization.

Expected effect:

- Remote access content appears as soon as local tunnel state is available.
- Process/filesystem/Cloudflare latency no longer blocks the tab’s first response.
- Concurrent status polls stop duplicating expensive detection.

### P0 — Add explicit Cloudflare probe timeouts

File:

- `apps/gateway/src/tunnel/access-client.ts:431-480`

Change:

- Pass `AbortSignal.timeout(...)` to Cloudflare requests.
- Use a short budget, for example 2–3 seconds per request.
- Bound or time-budget `listApps` pagination rather than allowing up to 50 sequential calls without a total deadline.

Expected effect:

- A broken DNS route, Cloudflare API, or network connection cannot hold `/api/tunnel/status` indefinitely.
- External detection degrades to stale/unknown data instead of blocking the UI.

### P1 — Remove the local-status backend waterfall

File:

- `packages/app/src/runtime/local-routes.ts:68-75`

Change:

- Run `getLocalStatus(deps)` and `deps.tlsStatus()` with `Promise.all`, since neither result depends on the other.
- Consider a short-lived cached TLS status/certificate projection in `packages/app/src/tls/tls-service.ts:197-237`, invalidated after certificate/config mutations.

Expected effect:

- Nodes tab loses the additive latency of manifest/env inspection followed by TLS parsing.
- Repeated certificate parsing is reduced.

### P1 — Cache or snapshot auth mode

Files:

- `apps/gateway/src/mesh/auth-routes.ts:184-203,800-814`
- TLS provider wiring around `packages/app/src/runtime/assemble.ts:475-480`

Change:

- Cache the derived auth mode and TLS projection briefly.
- Invalidate on auth-user, node-membership, or TLS configuration changes.
- Avoid scanning certificates/nodes on every `/api/auth/mode` request.

Expected effect:

- The nodes tab’s full-page auth-mode gate resolves faster.
- Repeated navigation does not redo the same DB/TLS work.

### P2 — Batch node/file-root lookups

Files:

- `apps/gateway/src/hub/hub-runtime.ts:244-270`
- `apps/gateway/src/api/file-root-routes.ts:23-38`

Change:

- Replace per-node certificate/token and per-root device queries with joined/batched reads.
- Add a small cache only if node/root counts justify it.

Expected effect:

- Better scaling for large meshes and many file roots; unlikely to be the primary cause for small installations.

## Frontend engineer

### P1 — Defer Ghostty preview initialization

Files:

- `packages/panels/src/settings/terminal-settings-panel.tsx:45-83`
- `packages/terminal-ui/src/components/TerminalPreview.tsx:4,51-161`

Change:

- Lazy-load `TerminalPreview` inside the terminal settings panel.
- Alternatively, render the preview only after the user expands it.
- Keep terminal controls and shortcuts independent of Ghostty initialization.

Expected effect:

- Terminal settings becomes interactive before font loading/WASM/controller initialization.
- The terminal lazy chunk and initial render become smaller/faster.

### P1 — Give read-mostly settings queries a longer stale window

Files:

- `apps/fe/src/pages/settings/use-site-settings-form.ts:61-68`
- `packages/panels/src/settings/use-terminal-shortcuts-editor.ts:312-315`
- Notification, AI, files, and node list query hooks.
- Shared defaults originate at `apps/fe/src/node/node-runtimes.ts:260-268`.

Change:

- Use a settings-specific `staleTime`, such as 30 seconds, for site, AI, notification, device, file-root, and shortcut data.
- Keep live status queries separately configured with their existing polling intervals.
- Avoid using `isFetching` as a full-tab loading gate; the protected status hook already uses the correct `isPending` behavior.

Expected effect:

- Revisiting tabs causes fewer redundant requests.
- Cached settings remain immediately usable instead of refetching after only five seconds.

### P1 — Prefetch the actual slow status query

File:

- `apps/fe/src/pages/settings/data-prefetch.ts:41-75`

Change:

- Add remote-access tunnel-status prefetch using the shared API-client fetcher, without importing the lazy tab component.
- Consider the same for local/TLS status if nodes navigation is frequent.

Expected effect:

- Hover/idle time can warm the status cache before the tab is clicked.
- This is complementary to the backend fix; it should not be relied on to mask an unbounded Cloudflare request.

### P2 — Replace the nodes full blank gate with a shell

File:

- `apps/fe/src/pages/settings/nodes/nodes-tab.tsx:37-43`

Change:

- Render a lightweight nodes-page skeleton/static header while `/api/auth/mode` is pending.
- Keep mode-specific sections hidden until the mode is known.

Expected effect:

- Improves perceived latency even when auth mode is slow.
- Does not reduce backend time, so it should follow the auth-mode/local-status fixes.

### P2 — Split QR-code login UI from the notifications chunk

Files:

- `packages/panels/src/settings/weixin-account-row.tsx:14`
- `packages/panels/src/settings/weixin-account-login-modal.tsx:10`

Change:

- Lazy-load the login modal and `qrcode.react` only when the user starts Weixin login.

Expected effect:

- Reduces notification chunk download/parse cost.
- This is unlikely to explain several-second delays by itself, but is a clean chunk-level optimization.

