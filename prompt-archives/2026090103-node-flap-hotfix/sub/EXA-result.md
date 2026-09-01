# EXA report

## Scope note

The checkout is actually `v1.1.9` (`cd07b881`), not `v1.1.8`. I ran the requested `git diff v1.1.7..v1.1.8 -- packages apps/fe/src` and inspected the v1.1.8 sources. Current HEAD contains the follow-up fix that removed `markLoggedOut`; the v1.1.8 behavior is reconstructed below.

## Executive conclusion

The most likely v1.1.8 regression is a transient remote 401 being interpreted as a real node logout:

```text
remote ApiClient /n/<id>/api/*
→ entry forwarder / mesh link / remote session verification
→ 401
→ entry rewrites it as NODE_LOGIN_REQUIRED
→ session interceptor emits node auth-required
→ v1.1.8 markLoggedOut(id)
→ loggedIn=false
→ sidebar/device route removes the remote runtime subtree
→ silent login succeeds
→ loggedIn=true and the subtree/WS is recreated
```

This exactly matches “remote only”, “random”, “desktop”, and “auto-recovers”. The current follow-up explicitly documents that direct/relay switching and node-side `via` validation can produce a session-valid 401, and now only triggers a refresh instead of flipping `loggedIn` (`apps/fe/src/node/mesh-nodes.ts:531-540`).

## A. `markLoggedOut` and the 401 paths

Remote clients are prefixed with `/n/<id>` (`packages/api-client/src/node-url.ts:1-3`, `packages/api-client/src/node-url.ts:49-60`, `packages/api-client/src/node-url.ts:160-162`). The forwarder routes remote HTTP and WS separately (`apps/gateway/src/mesh/forwarder.ts:142-157`).

For HTTP, the entry forwards the node session cookie. Missing entry cookie returns 401 directly (`apps/gateway/src/mesh/forwarder.ts:254-285`). A link/open-stream failure is retried for GET/HEAD and ultimately becomes `NODE_UNREACHABLE` 503, not 401 (`apps/gateway/src/mesh/forwarder.ts:576-616`). However, once the request reaches the remote node, missing or invalid propagated auth returns 401 (`apps/gateway/src/mesh/stream-targets.ts:152-168`, `apps/gateway/src/mesh/stream-targets.ts:197-205`).

The critical behavior is that `applyAuthPolicy` rewrites every upstream 401 to:

```json
{ "code": "NODE_LOGIN_REQUIRED", "nodeId": "<target>" }
```

(`apps/gateway/src/mesh/forwarder.ts:663-668`, `apps/gateway/src/mesh/forwarder.ts:797-810`). Thus a stale session binding, relay reconnection race, remote restart/session-store reset, or remote-side `viaNodeId` verification race can look identical to genuine logout.

Potential remote 401-producing requests include:

- `/api/devices` and device mutations (`packages/api-client/src/devices.ts:26-45`)
- file roots, list/stat/content/browse, upload and download operations (`packages/api-client/src/file-resources.ts:17-22`, `packages/api-client/src/file-resources.ts:76-90`)
- `/api/mesh/rtc-config`, `/api/mesh/connection?cid=...`, `/api/rtc/authorize` (`apps/gateway/src/mesh/mesh-routes.ts:101-119`, `apps/gateway/src/mesh/mesh-routes.ts:325-351`)
- `/api/settings/site` and `/api/capabilities` (`packages/api-client/src/site.ts:6-14`, `packages/stores/src/site.ts:114-139`)
- agent sessions/messages/queue/confirmation APIs (`packages/api-client/src/agent.ts:40-90`)
- terminal shortcuts, watch rules, LLM providers, device folders, system info, and any other node-scoped `ApiClient.fetch` endpoint.

The direct controller calls the mesh RTC endpoints during every remote connection attempt (`packages/ws-client/src/direct/direct-carrier-controller.ts:526-614`). `NO_CONNECTION` is normally 404/409, but an invalid session is 401.

Auth challenge/login are auth-skipped for session verification (`apps/gateway/src/mesh/forwarder.ts:34-34`, `apps/gateway/src/mesh/stream-targets.ts:34-36`). Nevertheless, failed login itself commonly returns 401 (`apps/gateway/src/mesh/auth-routes.ts:272-285`), and `applyAuthPolicy` currently rewrites that too. That is another false `NODE_LOGIN_REQUIRED` source.

The interceptor listens to every `ApiClient` response with status 401 (`packages/api-client/src/client.ts:67-77`, `packages/api-client/src/auth/session-interceptor.ts:141-145`). For `NODE_LOGIN_REQUIRED`, it trusts `body.nodeId`; otherwise it derives the ID from `/n/<id>` (`packages/api-client/src/auth/session-interceptor.ts:89-125`). A malformed/invalid URL ID falls back to `self`; an arbitrary valid `body.nodeId` is not cross-checked against the URL. A stale/removed ID normally matches no row, but a wrong body ID could affect an unrelated existing row.

In v1.1.8, the mesh poller subscribed to this event and immediately called `markLoggedOut` (`apps/fe/src/node/mesh-nodes.ts:537-543`, v1.1.8). `useNodeLoginGate` then computed `needsLogin = online && !loggedIn` and started silent login (`apps/fe/src/auth/use-node-login.ts:86-104`). The sidebar replaced the runtime section with “sign in to this node” (`apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:432-449`). The Devices page selected `signedOut`, which removes `NodeRuntimeScope` entirely (`apps/fe/src/pages/devices/node-device-group.tsx:51-57`, `apps/fe/src/pages/devices/node-device-group.tsx:288-300`).

For a route page, `NodeRouteGate` replaces `GlobalDeviceProvider` and its page children (`apps/fe/src/node/node-runtime-boundary.tsx:59-70`), but the outer `NodeRuntimeBoundary` still holds its runtime reference. Therefore a route WS may survive; sidebar/device-scope runtimes can be released. If the release reaches zero, the connection is disposed after the 30-second grace period (`packages/stores/src/node-connection-manager.ts:235-247`, `packages/stores/src/node-connection-manager.ts:264-277`).

A remote WS with no entry cookie is upgraded into a reject socket and closed with 4401 (`apps/gateway/src/mesh/forwarder.ts:619-638`, `apps/gateway/src/mesh/mesh-http.ts:298-325`). The manager maps 4401 to node login required (`packages/stores/src/node-connection-manager.ts:134-152`). A remote stream auth failure instead resets the mesh stream; it does not produce an HTTP Response for the interceptor (`apps/gateway/src/mesh/stream-targets.ts:475-485`). The WebSocket API does not expose upgrade responses to `ApiClient` hooks.

## B. Hidden-tab heartbeat

The v1.1.8 client selects 30-second PING / 60-second PONG timeout whenever `document.visibilityState === 'hidden'` (`packages/ws-client/src/client.ts:562-579`). A minimized desktop browser also normally reports `hidden`; there is no desktop-specific exception.

On the primary remote path, application PING reaches the remote node through the entry forwarder and mesh stream. The remote gateway handles `KIND_PING` and sends PONG (`apps/gateway/src/ws/index.ts:453-460`, `apps/gateway/src/ws/index.ts:523-530`). The entry does not answer on behalf of the remote node. The forwarder can fail over a closed relay stream (`apps/gateway/src/mesh/forwarder.ts:334-341`, `apps/gateway/src/mesh/forwarder.ts:368-385`).

Relevant timeouts are:

- peer control heartbeat: 15s, three missed PONGs before dropping (`apps/gateway/src/mesh/peer-manager.ts:71-75`, `apps/gateway/src/mesh/peer-manager.ts:1857-1869`)
- peer idle: 5 minutes, but only when there are no active streams (`apps/gateway/src/mesh/peer-manager.ts:1911-1925`)
- uplink heartbeat: 15s, three misses (`apps/gateway/src/mesh/uplink-client.ts:40-45`, `apps/gateway/src/mesh/uplink-client.ts:626-642`)
- direct RTC DataChannel liveness: 3s interval / 10s timeout (`apps/gateway/src/mesh/rtc/liveness.ts:4-11`, `apps/gateway/src/mesh/rtc/data-channel-link.ts:113-164`)
- direct connection attempt timeout: 15s (`packages/ws-client/src/direct/direct-carrier-controller.ts:429-433`).

The nominal 30s browser cadence is below the approximately 100s external-proxy ceiling noted in the client (`packages/ws-client/src/client.ts:62-67`), but background timer throttling or suspension can exceed it. That can make the browser-side WS or direct RTC carrier drop and then reconnect. This is a plausible desktop-specific contributor, but it does not by itself produce a node “sign in” state.

The visibility transition ordering is sound: `setCadence` only replaces the interval and leaves an in-flight timeout unchanged (`packages/ws-client/src/heartbeat-controller.ts:34-46`); visible transition clears the old timeout before issuing a new PING (`packages/ws-client/src/client.ts:618-635`); PING clears/rearms the timer (`packages/ws-client/src/heartbeat-controller.ts:67-89`). There is no normal hidden→visible spurious timeout. A timeout already firing represents a genuine missed PONG.

## C. Keep-alive subscription

`subscribe={false}` only removes the pane from the wire subscription set; the terminal and sink remain mounted (`packages/terminal-ui/src/components/types.ts:32-35`, `packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts:102-114`). The subscription manager only sends a `set-pane-subscriptions` frame (`packages/stores/src/pane-subscriptions.ts:38-46`).

`applyKeepAliveStreamState` does not disconnect anything; it only prunes hidden panes and invalidates warm status (`packages/panels/src/device-console/terminal-keep-alive.ts:103-119`). It is driven by `!deviceConnected || isReconnecting` (`packages/panels/src/device-console/terminal-stage.tsx:330-337`). The “Disconnected” placeholder is driven by those device states, not by `subscribe=false` (`packages/panels/src/device-console/terminal-stage.tsx:451-465`).

Therefore keep-alive is an amplifier: after a real WS/transport interruption, hidden panes are dropped from the warm pool and visible panes require cold history replay. It is not the origin of a device-level disconnect.

## D. Mesh status refresh

REST projects `online` as:

```text
self || hubPresence || reachable peer link
```

(`apps/gateway/src/mesh/node-list-projection.ts:188-208`, `apps/gateway/src/mesh/address-class.ts:9-12`).

By contrast, a known `NODE_EVENT` directly assigns `online = event.status === 'online'` (`apps/fe/src/node/mesh-nodes.ts:43-76`). Known events are applied immediately (`apps/fe/src/node/mesh-nodes.ts:296-299`); the polling code only REST-refreshes unknown node IDs, not known events (`apps/fe/src/node/mesh-nodes.ts:521-530`). The fallback poll is now five minutes, with a 30-second refresh when returning to visibility (`apps/fe/src/node/mesh-nodes.ts:394-405`, `apps/fe/src/node/mesh-nodes.ts:554-560`).

The gateway generally suppresses intermediate offline during link promotion (`apps/gateway/src/mesh/peer-manager.ts:1936-1975`), but a genuine gap or simultaneous hub/uplink and peer loss can emit offline (`apps/gateway/src/mesh/mesh-runtime.ts:976-1007`). That event can briefly override a REST projection that would still say online.

`node-offline.ts` only derives a boolean (`apps/fe/src/node/node-offline.ts:25-41`). The sidebar offline branch has no runtime (`apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:436-449`), while the Devices page deliberately preserves `NodeRuntimeScope` in offline mode (`apps/fe/src/pages/devices/node-device-group.tsx:291-298`).

## Ranking and confirmation

1. **Very high: v1.1.8 false node logout from transient 401.**  
   Confirm with DevTools showing `/n/<id>/api/*` status 401 and `NODE_LOGIN_REQUIRED`, followed immediately by `loggedIn=false`, “sign in to this node”, silent `/auth/challenge`/`login`, then recovery. Minimal fix: the current v1.1.9 behavior—never optimistically flip `loggedIn`; refresh once per sweep (`apps/fe/src/node/mesh-nodes.ts:531-540`). Also stop rewriting auth-skipped login failures as node-session failures.

2. **Medium: hidden-tab heartbeat or direct RTC liveness.**  
   Confirm WS close/reconnect without HTTP 401, or `[mesh][rtc] liveness timeout`; peer/uplink logs should show missed-PONG/drop. Minimal fix: retain foreground heartbeat cadence for desktop/minimized windows, or ensure browser/proxy-safe intervals; consider increasing direct RTC liveness tolerance for suspended tabs.

3. **Medium-low: event-driven offline flap.**  
   Confirm decoded `NODE_EVENT offline → online` for the same node with no 401. Minimal fix: debounce offline events briefly or validate them against a fresh REST projection before changing the UI.

4. **Low: keep-alive itself.**  
   Confirm only pane subscription changes and cold history replay, with no WS close or node status change. It cannot independently create the reported node disconnect.