# EX1 — Architecture report for the terminal-share feature (Opus explore, 2026-09-05)

Repo: `/Users/konata/code/tmex-r29`. Design docs of record: `docs/hub/2026082700-hub-node-architecture.md`, `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`.

## 1. Authentication model

### 1.1 Browser credential: per-node opaque session cookie
- Cookie `tmex_s_<nodeId>` — `apps/gateway/src/auth/cookies.ts:27` (`nodeSessionCookieName`), `buildSetCookie` `:31` (`Path=/; HttpOnly; SameSite=Lax`, `Secure` on https). nodeId must be canonical 32-hex (`:23 isCanonicalNodeId`).
- `MESH_VIA_SELF = 'self'` at `apps/gateway/src/mesh/mesh-deps.ts:8` → local cookie is `tmex_s_self`.
- Session records in SQLite `node_sessions`: `apps/gateway/src/auth/node-session-store.ts` — `NodeSessionRecord` `:12` `{ sid, userId, viaNodeId, sessPublicKey, delegationMethod:'root'|'passkey', credentialId, issuedAt, expiresAt, hardExpiresAt, renewedAt, revokedAt }`; `issue()` `:46` (random 32-byte sid, 18h sliding, 7d hard cap); `verify(sid,{viaNodeId,now})` `:79`; `revoke` `:124`, `revokeAllForUser` `:136`, `revokeByCredential` `:148`, `revokeVia` `:158`, `sweepExpired` `:166`. A `share_sessions` store should mirror this shape.

### 1.2 HTTP auth middleware
`apps/gateway/src/mesh/session-middleware.ts`: `authenticateRequest(req, deps, viaOverride?)` `:49` — (1) `standaloneOpenBypass` `:38` when standalone + login protection off; (2) mesh-peer requests take uid from `requestDispatchContext` `:60-72`; (3) otherwise `readSelfCookie` `:253` + `nodeSessionStore.verify`. Result `AuthenticateOk` `:15` `{ ok, userId, session, sid, renewedExpiresAt? }` — the only principal object; no roles/scopes. `attachAuthToRequest` `:98` stores `{via,sid,uid}` in per-Request WeakMap (`getMeshRequestContext`/`setMeshRequestContext` in `mesh-deps.ts`). `requireSession(deps, handler)` `:195`. `applySessionHeaders` `:109` / `consumeSetSessionForBrowser` `:160` translate `x-tmex-set-session` into `Set-Cookie` only when via===self.

Route gating: `MeshHttpRuntime.localUiGuard(req)` `apps/gateway/src/mesh/mesh-http.ts:391` — 401 for `/api/*` unless `isAuthPublicPath`. Public paths `apps/gateway/src/mesh/auth-public-paths.ts:2` (`/api/auth/mode`, `/api/auth/nodes`, `/api/auth/challenge`, `/api/auth/login`, `/api/auth/passkey/login/options`); `isAuthPublicPath` `apps/gateway/src/mesh/auth-routes.ts:151`. Route composition: `packages/app/src/runtime/assemble-routes.ts:482-497` — `tls → local → setup → relay → hub → meshHttp → gateway → static`. `meshHttp()` `:168` runs `localUiGuard` then `guardGatewayWebSocket` for `/ws`.

### 1.3 WebSocket auth
`WebSocketServer.handleUpgrade` (`apps/gateway/src/ws/index.ts:154`) does NO auth. Auth is in `MeshHttpRuntime.guardGatewayWebSocket` (`mesh-http.ts:223`): matches `/ws`, `/n/self/ws`, `/n/<ownNodeId>/ws`; unauthenticated → upgrade with `data.kind = MESH_REJECT_4401_KIND` and close 4401 `NODE_LOGIN_REQUIRED` (`WS_CLOSE_LOGIN_REQUIRED`, `mesh-deps.ts:35`); authenticated → `data = { kind: MESH_GATEWAY_WS_KIND, sid, uid, via:'self', cid? }`.
`routeWebsocket` (`assemble-routes.ts:228`): `open()` `:238-269` → `gw.open(ws)` + `mesh.registerGatewaySession({sid,uid,via,session,cid})`; `message()` `:270` → `mesh.touchSocket(ws)` re-verifies every `WS_SESSION_VERIFY_MS = 5min` (`mesh-http.ts:293`).
Live revocation: `closeSocketsForUser` `:260` / `closeSocketsForSid` `:268` / `applyKeyLogEffects` `:276` / `sweepInvalidSockets` `:328`; `MeshRuntime.closeSocketsForUser/closeSocketsForSid` `apps/gateway/src/mesh/mesh-runtime.ts:1370-1377`.
`GatewaySession` (`apps/gateway/src/ws/gateway-session.ts:11`) has NO identity: fields `id, borshState, state, primary, direct, activeCarrier, closed, viewportClaims, paneSizeEpochs`. sid/uid live in `SessionRegistry` (`apps/gateway/src/mesh/mesh-session-registry.ts:44`, `RegisteredGatewaySession` `:11` `{connectionId,cid,sid,uid,via,session,lastVerifyAt,pc}`, WeakMap `:46`). → Put a share scope directly on `GatewaySession`.

### 1.4 Forwarded WS (browser → hub → node)
`Forwarder.handleRemoteWs` `apps/gateway/src/mesh/forwarder.ts:639`: hub reads cookie `tmex_s_<targetNodeId>` without verifying; missing → 4401; opens `openWsStream(link, auth, cid)`. Node: `acceptWsStream` `apps/gateway/src/mesh/stream-targets.ts:477` → `verifyAuth(auth,'/ws',opts)` `:152` (`sessionStore.verify(auth,{viaNodeId: peerNodeId})`) → `wsServer.attachStreamSession(carrier)` (`ws/index.ts:201`) + `onGatewaySession({sid,uid,via,cid})`. HTTP: `acceptHttpStream` `:172` → `GatewayRuntime.dispatchHttp(request,{uid,viaNodeId,renewedExpiresAt})` (`apps/gateway/src/runtime.ts:232`). Auth is at the destination node; hub is a cookie carrier. `AUTH_SKIP` honored by forwarder (`forwarder.ts:559`, `forwarder-auth-policy.ts:16`); `applyAuthPolicy` `:30` maps node's `x-tmex-set-session` to per-node `Set-Cookie` at hub. Cookie extraction points to teach about a share cookie: `forwarder.ts:561`, `:645`.

### 1.5 Vocabulary
- `authSurfaceOnly`: MeshHttpRuntime with only auth plane (`mesh-http.ts:73,128,209,438`; `packages/app/src/runtime/assemble.ts:119`).
- local-peer waiver: `apps/gateway/src/mesh/client-source.ts:23 isTrustedLocalClient`, `:45 waivesPasskeySecondFactor`; `address-class.ts:427`, `domain-access-policy.ts:14`.
- passkey second factor: `apps/gateway/src/auth/passkey.ts`; `auth-routes.ts` `verifySecondFactors`.
- root session: `delegationMethod==='root'`.
- via: entry node binding; `via_mismatch`.

### 1.6 Existing scoped tokens (none per-terminal)
Enrollment token (`packages/shared/src/auth/enrollment.ts`, `apps/gateway/src/hub/hub-tokens.ts`); relay tenant/admin tokens (`apps/gateway/src/db/schema/relay.ts:4-84`, `relay/relay-admin-auth.ts`); node cert; RTC authorize nonce (`POST /n/:T/api/rtc/authorize`).

### 1.7 shared auth types
`packages/shared/src/auth/index.ts` → `encoding.ts`, `delegation.ts`, `login.ts`, `key-log.ts`, `peer-handshake.ts`, `uplink-auth.ts`, `relay-records.ts`. Domain constants `DOMAIN_*`. FE session key: `apps/fe/src/auth/session-key-store.ts` (IndexedDB `tmex-auth`).

## 2. Terminal data path

### 2.1 Wire protocol kinds (`packages/shared/src/ws-borsh/kind.ts`)
Session: HELLO_C2S 0x0001, HELLO_S2C 0x0002, PING 0x0003, PONG 0x0004, ERROR 0x0005. Device: DEVICE_CONNECT 0x0101, DEVICE_CONNECTED 0x0102, DEVICE_DISCONNECT 0x0103, DEVICE_DISCONNECTED 0x0104, DEVICE_EVENT 0x0105. tmux: TMUX_SELECT 0x0201, SELECT_WINDOW 0x0202, CREATE_WINDOW 0x0203, CLOSE_WINDOW 0x0204, CLOSE_PANE 0x0205, RENAME_WINDOW 0x0206, TMUX_EVENT 0x0207, SET_WINDOW_STYLE 0x020a, REORDER_WINDOWS 0x020b, REORDER_PANES 0x020c, RESIZE_PANE 0x020f, APPLY_STACKED_LAYOUT 0x0210, SPLIT_PANE 0x0211, FOCUS_PANE 0x0212, RENAME_PANE 0x0213, MOVE_PANE 0x0214, BREAK_PANE 0x0215. Terminal: TERM_INPUT 0x0301, TERM_PASTE 0x0302, CLIPBOARD_WRITE 0x0307, TERM_VIEWPORT 0x0308, TERM_VIEWPORT_POLICY 0x0309. CHUNK 0x0501. Agent 0x0601-0603. WATCH_EVENT 0x0701. SITE_THEME_UPDATE 0x0801, SETTINGS_UPDATE 0x0802, NOTIFY_EVENT 0x0803. CANONICAL_COMMAND 0x0901, CANONICAL_EVENT 0x0902. Mesh: NODE_EVENT 0x0a01, RTC_SIGNAL 0x0a02, CARRIER_SWITCH 0x0a03, CARRIER_SWITCH_ACK 0x0a04, ENROLL_REDEEMED 0x0a05. Clients older than canonical v1.1 rejected at HELLO (`ws/index.ts:529-540`).

### 2.2 Canonical (`packages/shared/src/ws-borsh/canonical-state.ts`)
`CanonicalCommand` `:150`: SetPaneSubscriptions | TerminalInput | ResizePane | RequestScreen | RequestHistory | ResizePaneV11. `CanonicalEvent` `:279`: FeedReady | SourceMetadataSnapshot | SourceMetadataPatch | PaneData | SubscriptionApplied | ScreenBegin/Chunk/Commit | HistoryBegin/Chunk/Commit | SourceGap | Error. `CanonicalPaneTarget` `:84` `{deviceId, serverEpoch(16B), paneId}`; `CanonicalPaneData` `:190`. `SourceMetadata*` carries the whole device tree (`SOURCE_ENTITY_*`/`SOURCE_FIELD_*` `:19-41`).

### 2.3 Server dispatch chain
1. `WebSocketServer.handleBorshMessage` `apps/gateway/src/ws/index.ts:461` (HELLO gate `:474`, PING `:484`, CARRIER_SWITCH_ACK `:489`) → `dispatchBorshKind`.
2. `dispatchBorshKind` `apps/gateway/src/ws/borsh-dispatcher.ts:27`; handler map `createBorshKindHandlers` `:19` = tmux + agent + canonical.
3. `apps/gateway/src/ws/tmux-kind-handlers.ts` (device connect, tmux mutations, TERM_INPUT `:119`, TERM_PASTE `:130`), `tmux-viewport-handlers.ts` (RESIZE_PANE, APPLY_STACKED_LAYOUT, TERM_VIEWPORT), `canonical-kind-handlers.ts:10` → `host.getOrCreateCanonicalSession(ws).handleCommand`, `agent-kind-handlers.ts`.
4. `CanonicalFeedSession` `apps/gateway/src/ws/canonical-feed-session.ts` (map at `ws/index.ts:86`): `handleCommand` `:138` → `handleSetPaneSubscriptions` `:376`, `handleTerminalInput` `:417`, `handleResizePane` `:441`, `handleRequestScreen` `:458`, `handleRequestHistory` `:482`. **`resolveTarget(target, requestId)` `:548` is the single chokepoint** (used at `:424,:444,:463,:504`). `ensureDevice` `:370` / `attachDevice` `:164` / `attachDeviceExclusive` `:202` / `installAttachedDevice` `:220` (sends full metadata snapshot `:270`, metadata patch listener `:227`, retention consumer lease `:222`); `bootstrapInitialDevices` `:362` (`initialDeviceIds()`); input write `:438` `runtime.sendInputBytes(paneId, data)`; `options.resolveRuntime(deviceId)` wired at `ws/index.ts:328`.
5. `DeviceConnectionRegistry` `apps/gateway/src/ws/device-connection-registry.ts` `handleDeviceConnect` `:214`; `DeviceConnectionEntry` `ws/types.ts:14` `{runtime, clients:Set<GatewaySession>, canonicalClients?, lastSnapshot}`.
6. `DeviceSessionRuntime` `apps/gateway/src/tmux-client/device-session-runtime.ts`; retention `pane-retention.ts` + `retention/`.

### 2.4 Per-connection state
viewport claims `GatewaySession.viewportClaims` (`gateway-session.ts:21`; arbitration `apps/gateway/src/ws/viewport-policy.ts:46 resolveWinner` — narrowest visible client wins); `paneSizeEpochs` `:23`; subscriptions/attached devices in `CanonicalFeedSession` private fields `:60-79` (`CanonicalSubscriptionCoordinator` `:71`); fan-out membership `DeviceConnectionEntry.clients/canonicalClients`; sid/uid in SessionRegistry.

### 2.5 Where scope enforcement lives
A. `CanonicalFeedSession`: `resolveTarget` (covers input/resize/screen/history), `handleSetPaneSubscriptions` (filter panes, reject others with `SUBSCRIPTION_REJECTED_NOT_FOUND`), `attachDevice/ensureDevice` (refuse other devices), `bootstrapInitialDevices` (only Y), metadata snapshot/patch filtering (`CanonicalTransactionSender.sendMetadataSnapshot`, `onMetadataPatch` `:227`).
B. `dispatchBorshKind` kind allowlist keyed off a share scope on the session.

### 2.6 Allow vs block for a share
Allow: HELLO/PING/PONG/ERROR/CHUNK; DEVICE_CONNECT/DISCONNECT restricted to device Y (or pre-attach server-side and reject the kind); CANONICAL_COMMAND (SetPaneSubscriptions/TerminalInput/ResizePane(V11)/RequestScreen/RequestHistory, pane-scoped); TERM_VIEWPORT (decision: recipient participates in arbitration); CARRIER_SWITCH_ACK not needed.
Block: all TMUX_* mutations 0x0201-0x0215; TERM_PASTE (separate handler `tmux-kind-handlers.ts:130`) unless pane-checked; CLIPBOARD_WRITE (pane-filter); AGENT_*; SITE_THEME_UPDATE (write! `theme-settings-broadcaster.ts:37`); all `/api/*`.

### 2.7 Broadcasts to every ws session (leaks)
`ThemeSettingsBroadcaster.broadcastSiteThemeUpdateS2C` `theme-settings-broadcaster.ts:93`, `broadcastSettingsUpdate` `:110`, **`broadcastEventNotify` `:122`** (every device's WebhookEvent JSON to every socket) — all use `host.connectedClients` (populated `ws/index.ts:198 handleOpen`). `DeviceFeedBroadcaster.broadcastTmuxEvent` `device-feed-broadcaster.ts:39` to `entry.clients` (bells for all panes of device Y, `resolvePaneContext` embeds `settings.siteUrl` `:87`). `AgentWsHub.registerClient` unconditional at HELLO (`ws/index.ts:549`, `apps/gateway/src/agent/ws-hub.ts:76`).

## 3. Hub / relay / node topology
- Browser → `https://H/n/<N>/api/...` / `wss://H/n/<N>/ws`. `createHttpDispatch` `assemble-routes.ts:203` → `MeshHttpRuntime.handleRequest` `mesh-http.ts:207` → `Forwarder.handle` `forwarder.ts:119`; `parseNodePrefix`; self → `handleSelf` `:523` rewrite + re-dispatch (`isMeshRewritten` `assemble-routes.ts:218`); `/api/mesh-internal*` 403 `:130`. Remote: `peers.getLink(nodeId)` → `streams.openHttpStream/openWsStream`; link order direct WS → WebRTC DC → hub relay (`SecureChannelLink`); failover `forwarder-failover.ts`, `forwarder-unreachable.ts` (`NODE_UNREACHABLE` 503). On N: `acceptHttpStream/acceptWsStream` verify sid with viaNodeId=peerNodeId. Response headers allowlisted (`MESH_FORWARD_CSP`, `MESH_ALLOWED_MIME` `mesh-deps.ts:37,39`; `forwarder-headers.ts`).
- Relay = blind byte relay (`apps/gateway/src/relay/`, `relay-stream-router.ts:26 acceptRelayStream`): decodes only `{to}`; inner `SecureChannelLink` AES-256-GCM; relay knows tenantId, nodeIds, bytes, versions (`db/schema/relay.ts:37 relayNodes`), optional tenant `label` `:25`, `sealedPack` `:33`; no node names.
- Link badge popover: `apps/fe/src/node/device-node-badges.tsx` — `DeviceNodeBadges` `:243` (null for SELF `:265`, refreshes `/api/mesh/nodes` `:261`), `resolveLinkBadge` `:56`, `formatLinkBadgeLabel` `:72`, `linkDetailKind` `:86`, `buildLinkDiagnosticRows` `:178`, `directFailureRows` `:170`, `iceRows` `:142`, `NodeLinkDiagnostics` `:287` (`data-testid="ice-diagnostics"`). Untranslated values: `ice.connectionState`, `iceConnectionState`, candidate types, `selectedPair`, `link.peerAddress`, `failure.ws`/`failure.dc` free text `:173-175`. Mounted from `apps/fe/src/pages/DevicePage.tsx:40 PageActions`.
- Public URLs: `config.baseUrl` `apps/gateway/src/config.ts:300`, `config.hubPublicUrl` `:342`, `site_settings.site_url` `db/schema/settings.ts:10`; `apps/gateway/src/mesh/effective-site-url.ts:60 createMeshSiteSettingsLink` (`resolveMeshHubSelection` `:26`, `nodeAccessUrl(hub,nodeId) → <hub>/n/<nodeId>` `:56`, `effectiveSiteUrl()` `:83`); projection `apps/gateway/src/api/site-settings-link.ts:29 projectSiteSettings`, served `settings-routes.ts:45`. Tunnel: `apps/gateway/src/tunnel/` (`hostname.ts`, `named-config.ts`, `manager.ts`), UI `apps/fe/src/pages/settings/remote-access/`. Cloudflare Access guard `tunnel/access-guard.ts:64 guardEntryAccess`, exemptions `access-paths.ts:20-31`. Domain-access kill switch `api/domain-access-routes.ts:119 guardDomainAccess`, `mesh/domain-access-policy.ts` — both run before everything (`assemble-routes.ts:211-214`).

## 4. Frontend shell
- `apps/fe/src/main.tsx`: router `:328`; `/login` `:334` (`PageWrapper withSidebar={false}`); `/` → `RootLayout` `:189` (SidebarProvider, StatusBarSync, StandaloneLanding, FlowBridges, MeshNodesResident, RelayMetaKeyResident, AppSidebar, MainInset `:255` → NodeRuntimeBoundary → NodeRouteGate → NodeSessionInit → Outlet); `pageRoutes()` `:294` (index, devices, devices/:deviceId, devices/:deviceId/windows/:windowId/panes/:paneId, settings, file/:ref), also under `n/:nodeId` `:343`. `installSessionInterceptor` `:351` redirects to /login on 401. `AppRoot` `:364`. `page-modules.ts` (`IDLE_PRELOAD_PAGE_MODULES` `:17`).
- `apps/fe/src/page-wrapper.tsx:32 PageWrapper` header: left SidebarToggle/Brand `:60` + PageTitle; right `<PageActions/>` `:70`.
- Terminal page `apps/fe/src/pages/DevicePage.tsx` (`PageTitle` `:34`, `PageActions` `:40`). Toolbar: `packages/panels/src/device-console/page-actions.tsx:21 DeviceConsoleActions` → `device-console-toolbar.tsx` (`buildToolbarButtons` `:103`, `splitButtons` `:40`, `coreButtons` `:61`, `watchButton` `:81`, `terminalSettingsButton` `:93`, `ToolbarButton` `:21` `{key,testId,icon,label,onClick,disabled,badge}`, `DeviceConsoleToolbar` `:139`); model `use-device-console-actions.ts:28`. No tab bar: navigation via sidebar device tree (`packages/panels/src/device-tree/`). "Terminal tab" == `(deviceId, windowId, paneId)` route. Rendering `packages/panels/src/device-console/device-console.tsx:57` → `terminal-stage.tsx` (`SplitTerminalArea`).
- Share shell: add `pages/SharePage.tsx` + `page-modules.ts` entry; route as sibling of `/login` outside RootLayout (`main.tsx:331`), bare page (no PageWrapper); `createAppRuntime({features:{agentUi:false,watchUi:false,filesUi:false}})` (`packages/stores/src/runtime.ts:119`, `RuntimeFeatures` `:135`, resolved `:276`); keep session interceptor from redirecting share visitors; `serve-frontend.ts` SPA fallback serves any path; `localUiGuard` only guards `/api/*`. `useKeyboardAvoidance` lives in MainInset — share shell must re-create mobile keyboard handling.
- Stores `packages/stores/src`: `runtime.ts` (`RuntimeCore` `:146`, `HostServices` `:42`), `node-connection-manager.ts` (`SELF_NODE_ID`, `useNodeRuntime`), `tmux.ts`/`tmux-state.ts`, `pane-subscriptions.ts:25` (`sendPaneSubscriptions` `:38`, `requestPaneScreen`, `fetchPaneHistory`), `ui.ts`, `site.ts`, `viewport-policy.ts`. FE-local: `apps/fe/src/node/mesh-nodes.ts` (`refreshMeshNodes`), `apps/fe/src/components/global-device-provider.tsx` (`/api/devices`), `apps/fe/src/node/node-runtimes.ts`.

## 5. Settings page
`apps/fe/src/pages/SettingsPage.tsx`: `SettingsTab` union `:69`, `SETTINGS_TABS` `:80`, `OPTIONAL_SETTINGS_TABS=['relay']` `:94`, loaders `:46-58` + `lazyChunk` `:60-67`, `TAB_CHUNK_LOADERS` `:96`, `chunkPreloadOrder` `:108`, `TABS_USING_SITE_SETTINGS` `:113`, `SETTINGS_TAB_BAR` `:119` `{value,labelKey,icon}`, `settingsTabBarItems` `:142`, `settingsTabFromParam` `:157`; prefetch `apps/fe/src/pages/settings/data-prefetch.ts`. Table example: `apps/fe/src/pages/settings/relay/tenant-table.tsx:38` with `WideTableScroll`/`stickyActionColumn` from `settings/components/wide-table.tsx:13,16`; `danger-confirm-dialog.tsx`, `form-primitives.tsx`. `packages/ui` has no Table component.
i18n: `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json` + `manifest.json`; `bun run build:i18n`; core/rest split `packages/shared/src/i18n/core-keys.ts:8 I18N_CORE_KEY_PREFIXES` (share page outside lazy routes needs core keys or `ensureI18nRest()`; `apps/fe/src/i18n/core-coverage.test.ts` enforces).

## 6. Persistence
drizzle + bun:sqlite; `apps/gateway/src/db/client.ts` `getDb`; schema barrel `db/schema.ts` → `schema/{settings,devices,messaging,agent,users-auth,mesh,relay,mesh-relay}.ts`; migrations `apps/gateway/drizzle/` (last `0039_relay.sql`); `bun run --filter @tmex/gateway db:generate`; `db/migrate.ts:16 runMigrations` on boot (`runtime.ts:165`); `managed-migrations.ts`; convention: `*.migration.test.ts` per schema change. KV `db/kv.ts` `getGatewayKv/setGatewayKv`. Singleton settings row pattern `siteSettings` `schema/settings.ts:6` (`check id = 1` `:35`). Token table pattern `relayTenants` (`tokenHash`+`tokenEpoch`), `relayEnrollments` `:59`.

## 7. Terminal output capture
No recording exists. Retention: `apps/gateway/src/tmux-client/pane-retention.ts` + `retention/types.ts` — `PaneDataSegment` `:52` `{paneId, paneEpoch(16B), seqStart, seqEnd, data}`; `PaneScreenCheckpoint` `:85` `{paneId, paneEpoch, baseSeq, rows, cols, modes, data, historyCursor, capturedAt}`; `PaneReplayGap` `:58`, `PaneReplayPlan` `:65`, `PaneHistoryPage` `:95`; limits `:6-10`; `PaneRetentionConsumerCallbacks` `:119` `{onData,onGap}` via `runtime.attachPaneConsumer(callbacks)` → lease (see `canonical-feed-session.ts:222`). Parser `tmux-client/pane-stream-parser.ts`; headless ghostty `pane-emulator.ts`, `packages/ghostty-terminal/src/headless.ts:21 HeadlessTerminal`; `captureCanonicalScreen(paneId, byteLimit)`.
Read-only viewer: `packages/terminal-ui/src/components/TerminalPreview.tsx:49` (createTerminalController + FitAddon, no input). `TerminalProps` `components/types.ts:11`: `sizingMode 'report'|'follow'|'local'` `:23`, `viewportPan` `:28`, `autoFocus` `:29`, `onData?` optional `:36`; `TerminalRef.write(string|Uint8Array)` `:54`.
Recording format: per share store `(paneEpoch, baseSeq, rows, cols, modes, checkpointBytes)` once, then `(seqStart, seqEnd, bytes, wallClockMs)` segments; replay feeds checkpoint + segments.

## 8. Tests
`bun test`; root `bunfig.toml` preload forces `DATABASE_URL=:memory:`; `bun run test:unit` (`scripts/ci/unit-tests.ts`) splits gateway per `src/` subdir. Gateway fixtures: `ws/test-helpers.ts` (`createFakeCarrier` `:25`, `createGatewaySession`), `auth/test-db.ts`, `hub/hub-test-helpers.ts`, `relay/relay-test-harness.ts`, `mesh/integration/`. FE unit `cd apps/fe && bun test src/`. E2E `apps/fe/tests/*.spec.ts`, runner `scripts/run-e2e.ts`, helpers `tests/helpers/{device,tmux,ws-borsh,mesh,mesh-boot}.ts`; mesh via `TMEX_E2E_MESH=1`. Lint `biome check .` + `bun scripts/complexity/gate.ts`.

## Cross-cutting risks
1. GatewaySession has no principal → add share scope field; enforce in dispatcher + CanonicalFeedSession.
2. `connectedClients` broadcasts (notify/settings/theme) leak → exclude share sessions.
3. SourceMetadataSnapshot = whole device tree → filter to the shared window's panes.
4. `entry.clients` fan-out of bells for all panes → filter.
5. `agentWsHub.registerClient` unconditional → skip for share.
6. Viewport arbitration global per window (decision: recipient participates).
7. SITE_THEME_UPDATE is a write → block.
8. TERM_PASTE bypasses canonical → pane-check or block.
9. Cookie scoping: distinct cookie name + store; teach forwarder (`forwarder.ts:561,:645`) + `stream-targets.ts:152 verifyAuth`.
10. Revocation must push-close sockets on node N (5-min touchSocket is too slow); `closeSocketsForSid`, `SessionRegistry.listBySid` `:122`.
11. Domain-access + Cloudflare Access guards run first.
12. Client version gate at HELLO.
