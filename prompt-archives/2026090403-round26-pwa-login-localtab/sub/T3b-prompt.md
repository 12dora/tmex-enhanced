# T3b — gateway: expire stale per-node session cookies on via_mismatch; carry a safe reason in NODE_UNREACHABLE; filter non-admitted relay members; explicit relay dial context

Result file: /Users/konata/code/tmex-r26/prompt-archives/2026090403-round26-pwa-login-localtab/sub/T3b-result.md

## Scope (files you may edit)
- apps/gateway/src/mesh/forwarder.ts (+ tests), apps/gateway/src/auth/cookies.ts (+ tests) if you need a cookie-clearing helper
- apps/gateway/src/mesh/relay-node-list.ts (+ tests)
- apps/gateway/src/mesh/relay-wiring.ts, apps/gateway/src/mesh/relay-uplink-client.ts, apps/gateway/src/mesh/relay-dial.ts (+ tests)
- apps/gateway/src/mesh/peer-manager.ts ONLY for the log line in `acceptRelay()` catch (see 4)
- packages/shared types if a response type needs a new optional field.
Do NOT edit apps/gateway/src/relay/relay-hardening.test.ts, apps/gateway/src/mesh/auth-routes.ts (another grok agent, T1, owns them), and nothing under apps/fe, packages/panels, packages/api-client, packages/stores.

## Production bug (root cause confirmed)
Entry B (roles relay,node) was a hub, left, and re-joined as a relay member → its node id changed. Browsers still hold per-node cookies `tmex_s_<target>` that were issued through B's OLD node id. Target nodes validate the session's `viaNodeId` (`apps/gateway/src/mesh/stream-targets.ts:152-169`, `auth/node-session-store.ts:79-98`) and answer `401 via_mismatch`; the forwarder rewrites it to `{"error":"via_mismatch","code":"NODE_LOGIN_REQUIRED","nodeId"}` (`forwarder.ts:805-842`). The node-list projection reports `loggedIn:true` merely because the cookie exists (`node-list-projection.ts:238-253`), so the UI never re-logs-in.

## Tasks
1. Forwarder: when the target answers 401 and the forwarder rewrites it to `NODE_LOGIN_REQUIRED` (both `via_mismatch` and `missing auth`/expired variants), append a `Set-Cookie` header on the entry's response that expires the stale `tmex_s_<targetNodeId>` cookie (same path/attributes the login route uses when setting it — look at how `/n/:id/api/auth/login` sets the per-node cookie via `auth/cookies.ts` and mirror Path/SameSite/Secure/HttpOnly so the browser actually deletes it). Then a page reload shows `loggedIn:false` and the login gate runs. Also do the same for the WebSocket path if the entry proxies the WS upgrade and can see a 4401 NODE_LOGIN_REQUIRED before upgrading (only if there is an HTTP response to attach it to; otherwise skip and say so). Tests in the forwarder test file.
2. `NODE_UNREACHABLE` (503, `forwarder.ts:593-597`): include a safe `reason` field derived from the underlying error class (e.g. `not_admitted`, `no_link`, `handshake_failed`, `relay_reset:<reason>` using the relay stream reset reason from `relay-stream-router.ts` reasons `self-target|unknown-target|offline|quota-streams|open-failed`, `timeout`) — never leak stack traces, hostnames or tokens. Extend the response type in packages/shared if one exists. Tests.
3. `apps/gateway/src/mesh/relay-node-list.ts:67-79` `relayListToNodeList()`: filter out members whose `status !== 'admitted'` (pending/revoked must not appear as reachable nodes) — check what the relay's node list (`apps/gateway/src/relay/relay-node-list.ts:20-38`) actually sends so you use the right field, and that the "pending approval" UI in the nodes management page (which needs pending nodes listed somewhere) still gets them from its own endpoint, not from this list. Tests.
4. `peer-manager.ts:1115-1131` `acceptRelay()` catch: log a single structured line `[mesh][relay] accept failed node=<id> reason=<safe message>` before `stream.reset('handshake-failed')` so target-side canonical HELLO failures (e.g. `no node_certs for <id>`) are diagnosable.
5. `relay-wiring.ts:110-146` constructs `RelayUplinkClient` without a `dial` context, so `relay-uplink-client.ts:348-358` re-reads `process.env` via `relayDialContextFromEnv()`. Pass an explicit `RelayDialContext` built once from the runtime config (roles, `TMEX_RELAY_PUBLIC_URL`, `GATEWAY_PORT`) so the self-loopback dial (`relay-dial.ts:49-68`) does not depend on late env reads. Keep behaviour identical when the env is the source. Tests.

Verify: `cd apps/gateway && bun test src/mesh src/relay src/auth` → 0 fail (the pre-existing "2 errors" in src/relay from relay-hardening.test.ts are being fixed by T1 — ignore them if still present), `bunx tsc --noEmit -p .` ≤ 1 error (known TS5097 baseline), biome clean on touched files.
