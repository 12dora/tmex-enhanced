# EX5 — Mesh SSO exploration report

## Conclusion

The repository already contains the safe cryptographic mechanism needed for cross-node silent login. The browser can reuse an in-memory, user-signed `delegation` and temporary session key to authenticate to node B, while B still issues its own node-local session cookie.

The current gap is primarily frontend behavior:

- `loginSelf()` deliberately logs in only the entry node.
- The devices page renders a manual “Sign in to this node” button instead of invoking the existing silent-login gate.
- `sk_sess` and `delegation` are memory-only, so a full page reload, new PWA document, or expired session forces manual reauthentication.
- TOTP password sessions also require a new code for each target node.

I recommend extending the existing in-memory delegation flow. Do not add node-signed or hub-signed user assertions, and do not persist the raw password.

## 1. Current per-node authentication model

The browser does not connect directly to a remote node origin. The API client explicitly documents that the browser connects to the entry node and addresses remote nodes through `/n/<nodeId>` paths; remote REST and WebSocket URLs are constructed as `/n/<id>/api/...` and `/n/<id>/ws`. [`packages/api-client/src/node-url.ts:1`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/packages\/api-client\/src\/node-url.ts:1)

The existing API methods are:

- `POST /n/<B>/api/auth/challenge` with `{ uid }`
- `POST /n/<B>/api/auth/login` with `login`, `sig`, `delegation`, `delegation_sig`, and optional TOTP data.

[`packages/api-client/src/auth/auth-api.ts:124`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/packages\/api-client\/src\/auth\/auth-api.ts:124) [`packages/api-client/src/auth/types.ts:119`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/packages\/api-client\/src\/auth\/types.ts:119)

For an HTTP request to B, the entry forwarder extracts only `tmex_s_<B>` from the browser cookie jar and passes that session ID as the peer-stream `auth` field. It does not forward the browser’s raw cookie header. [`apps/gateway/src/mesh/forwarder.ts:576`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/gateway\/src\/mesh\/forwarder.ts:576)

The remote WebSocket path behaves equivalently: `/n/<B>/ws` requires `tmex_s_<B>`, then opens a peer WS stream carrying that session ID. [`apps/gateway/src/mesh/forwarder.ts:619`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/gateway\/src\/mesh\/forwarder.ts:619)

The peer target verifies the session locally with `viaNodeId` equal to the peer link’s node ID. Invalid, expired, revoked, or wrong-`via` sessions are rejected before the target request is dispatched. [`apps/gateway/src/mesh/stream-targets.ts:152`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/gateway\/src\/mesh\/stream-targets.ts:152)

For successful remote login, B creates a session in B’s own `node_sessions` table. The internal `x-tmex-set-session` header is converted by the entry into `Set-Cookie: tmex_s_<B>`, while the SID is not exposed in the JSON response. [`apps/gateway/src/mesh/auth-routes.ts:760`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/gateway\/src\/mesh\/auth-routes.ts:760) [`apps/gateway/src/mesh/forwarder.ts:774`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/gateway\/src\/mesh\/forwarder.ts:774)

The browser therefore has two distinct credential layers:

- Per-node HttpOnly cookies such as `tmex_s_<B>`.
- A module-level in-memory `sk_sess`, delegation, and optional TOTP key. The frontend explicitly avoids localStorage, cookies, and persistent storage for these secrets. [`apps/fe/src/auth/session-key-store.ts:1`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/fe\/src\/auth\/session-key-store.ts:1)

The peer transport may be relay, secure peer WS, or WebRTC/DataChannel. This affects terminal latency and bandwidth, but not the authentication model. Browser RTC signaling is routed through the entry and target session bindings. [`apps/gateway/src/mesh/mesh-runtime.ts:1011`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/gateway\/src\/mesh\/mesh-runtime.ts:1011)

## 2. Identity and trust model

Each node has a local copy of the user record, but this is not a conventional independent password database. `users` contains `id`, `username`, `root_public_key`, KDF parameters, root epoch, and TOTP metadata; it contains no password hash. [`apps/gateway/src/db/schema.ts:490`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/gateway\/src\/db\/schema.ts:490)

The browser derives the root key from the entered password, creates a temporary session key, signs a delegation with the root key, and immediately clears the seed and root-key material. [`apps/fe/src/auth/session-login.ts:53`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/fe\/src\/auth\/session-login.ts:53)

B resolves the user locally by ID or username, then verifies a root delegation against B’s local `rootPublicKey`; passkey delegations are checked against B’s local `user_keys` record. [`apps/gateway/src/mesh/auth-routes.ts:301`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/gateway\/src\/mesh\/auth-routes.ts:301) [`apps/gateway/src/mesh/auth-routes.ts:695`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/gateway\/src\/mesh\/auth-routes.ts:695)

Thus the mesh has a shared user identity represented by the same user ID/root key across enrolled nodes, while each node maintains its own local session table and local copy of user/key-log state. A matching username alone is insufficient; B must have the corresponding user ID and root/passkey trust material.

Node membership is based on user-authorized node certificates. `node_certs` stores the certificate, authorization, signatures, owning `userId`, and revocation sequence. `peer_cache` stores only operational metadata. [`apps/gateway/src/db/schema.ts:580`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/gateway\/src\/db\/schema.ts:580) [`apps/gateway/src/db/schema.ts:652`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/konata\/code\/tmex-enhanced-wt-r11\/packages\/shared\/src\/roles.ts:1)

The premise that the current node list is hub-signed is inaccurate. `NodeListMessage` contains version, key-log head, RTC data, node metadata, and optional hub metadata, but no signature field. [`packages/shared/src/uplink/codec.ts:514`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/packages\/shared\/src\/uplink\/codec.ts:514) The node list is sent over an authenticated uplink, while actual node public keys are obtained from locally validated `node_certs`; the uplink client ignores list entries without a matching, non-revoked certificate. [`apps/gateway/src/hub/uplink-server.ts:1065`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/gateway\/src\/hub\/uplink-server.ts:1065) [`apps/gateway/src/mesh/uplink-client.ts:571`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/gateway\/src\/mesh\/uplink-client.ts:571)

Peer mutual authentication proves node identity, not user authority. The handshake verifies the peer transcript with the node public key from `node_certs`. [`apps/gateway/src/mesh/peer-protocol.ts:143`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/gateway\/src\/mesh\/peer-protocol.ts:143) `packages/shared/src/roles.ts` defines only `standalone`, `node`, and `hub,node`; there is no trust level or trusted-node role. [`packages/shared/src/roles.ts:1`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/packages\/shared\/src\/roles.ts:1)

The current uplink control union has node authentication, node lists, key-log exchange, and RTC signaling, but no user token-exchange or hub-session message. [`packages/shared/src/uplink/codec.ts:208`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/packages\/shared\/src\/uplink\/codec.ts:208)

## 3. Why the prompt appears today

`loginSelf()` intentionally logs in only the entry node and leaves other nodes for lazy login. [`apps/fe/src/auth/session-login.ts:375`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/fe\/src\/auth\/session-login.ts:375)

The entry projects `loggedIn` by checking whether the browser has `tmex_s_<nodeId>`. A newly visited node therefore appears signed out until B has issued its own cookie. [`apps/gateway/src/mesh/node-list-projection.ts:197`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/gateway\/src\/mesh\/node-list-projection.ts:197)

For ordinary remote routes, `useNodeLoginGate()` already attempts `ensureNodeLogin()`. If the in-memory session key exists, it silently performs the challenge/login sequence; if it does not, it returns `NO_SESSION_KEY`. [`apps/fe/src/auth/use-node-login.ts:39`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/fe\/src\/auth\/use-node-login.ts:39) [`apps/fe/src/auth/session-key-store.ts:122`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/fe\/src\/auth\/session-key-store.ts:122)

The devices aggregation page is different: an online but unsigned-out node renders `NodeLoginButton` directly rather than mounting the silent-login gate. [`apps/fe/src/pages/devices/node-device-group.tsx:150`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/fe\/src\/pages\/devices\/node-device-group.tsx:150) The button itself silently logs in only if `sk_sess` still exists; otherwise it navigates to `/login?node=<id>`. [`apps/fe/src/auth/NodeLoginButton.tsx:33`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/fe\/src\/auth\/NodeLoginButton.tsx:33)

The existing mesh helper confirms the important failure mode: full `goto()` or `reload()` loses `sk_sess`, so the remote button falls back to the manual login page. [`apps/fe/tests/helpers/mesh.ts:227`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/fe\/tests\/helpers\/mesh.ts:227)

The login form is already prefilled from the target node’s `mode.username`, while the password remains empty. [`apps/fe/src/pages/LoginPage.tsx:69`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/fe\/src\/pages\/LoginPage.tsx:69)

Therefore:

- SPA route switch with a live non-TOTP session should be silent.
- Devices-page first use currently requires clicking the button.
- Reload/new document requires manual credentials by design.
- A password session with TOTP requires a fresh code for each node. [`apps\/fe\/src\/auth\/session-key-store.ts:129`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/fe\/src\/auth\/session-key-store.ts:129)

## 4. Design option analysis

### (a) Credential replay

Raw username/password replay would work only when B has the same mesh user identity. The network request still would not contain a password: the frontend would derive the root key, create a delegation, and use the existing challenge/login protocol.

Memory-only reuse is reasonable and is already represented by `sk_sess` plus delegation. Persisting the raw password in IndexedDB creates a substantially larger device-storage, backup, malware, and XSS exposure. It also conflicts with the explicit memory-only design.

Recommendation: use the existing ephemeral delegation/session key, not raw password persistence. This is the secure form of option (a).

### (b) Node-signed assertion

This is incompatible with the present trust boundary. A node private key proves “I am node A”; it does not prove that the user authorized a login to B. The architecture explicitly treats node identity as insufficient for user access. [`docs/hub/2026082700-hub-node-architecture.md:135`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/docs\/hub\/2026082700-hub-node-architecture.md:135)

If B accepted `{sub, aud:B, iat, exp, nonce}` signed by A, compromising A would let the attacker mint assertions for any locally recognized user. Requiring the same local username or UID would not fix this: the compromised A could still assert that UID.

If this option were chosen despite that trade-off, B would need to verify A’s current non-revoked certificate, exact `aud=B`, a short TTL, a one-time nonce stored in B, and the subject’s local account. It would still intentionally change the current compromise result.

### (c) Hub-mediated assertion

The hub is not currently the user trust root. It transports node lists and relays encrypted streams; user authorization is rooted in the user’s key log and root/passkey keys. [`docs/hub/2026082700-hub-node-architecture.md:160`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/docs\/hub\/2026082700-hub-node-architecture.md:160)

Making the hub sign SSO assertions would make hub compromise equivalent to user impersonation across nodes. Audience, nonce, TTL, and revocation would reduce replay but would not remove that new root-of-trust dependency.

### (d) Proxy everything through the home node

HTTP and WS proxying already exists. It still requires B’s own session ID, and B verifies that ID locally. [`apps/gateway/src/mesh/forwarder.ts:601`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/gateway\/src\/mesh\/forwarder.ts:601)

Proxying all APIs and terminals through A without authenticating B would require A to impersonate the user to B, which is effectively option (b), or would make A a permanent trusted application server for B. It also adds bandwidth, latency, and terminal failure coupling. It would prevent the existing direct browser/node transport optimization from providing its intended benefit.

## 5. Security boundary

A stolen B session cannot be replayed to A or another node: the SID is stored only in B’s `node_sessions`, and verification requires the expected `viaNodeId`. [`apps/gateway/src/auth/node-session-store.ts:79`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/gateway\/src\/auth\/node-session-store.ts:79)

A compromised ordinary node A, possessing only A’s node key and database, cannot forge B’s user delegation or B session. The existing integration test explicitly rejects forged HTTP, WS, and delegation credentials. [`apps/gateway/src/mesh/integration/mesh.integration.test.ts:889`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/gateway\/src\/mesh\/integration\/mesh.integration.test.ts:889)

A compromised active entry is different: it already holds or can proxy active sessions and can operate on nodes whose sessions have been established through it. The architecture documents this as an intentional entry compromise impact. [`docs/hub/2026082700-hub-node-architecture.md:306`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/docs\/hub\/2026082700-hub-node-architecture.md:306)

The invariant should be:

> B accepts automatic login only from a user-signed root/passkey delegation, for the same local UID/root identity, through the current entry path; B issues a fresh B-local session bound to that entry. Node membership alone never grants user authority.

No additional per-node opt-in is required for the same user’s enrolled nodes: node enrollment and `admit-node` already represent explicit mesh membership. An opt-in would be necessary only if the product later allows “any user authenticated by node A” to access B.

Automatic attempts should be silent with a small progress state. On credential/auth failure, show the existing manual form with the username prefilled. Network failures should remain retryable rather than being mislabeled as credential failures. The existing interceptor already scopes remote 401s to the individual node instead of redirecting the whole application. [`packages/api-client/src/auth/session-interceptor.ts:108`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/packages\/api-client\/src\/auth\/session-interceptor.ts:108)

## 6. Recommendation and implementation split

### Recommended protocol

Choose option (a) only in its secure, ephemeral form: reuse the existing `sk_sess` and user-signed delegation.

No new gateway endpoint, uplink message, database table, or database column is required.

The existing contract remains:

1. `POST /n/<B>/api/auth/challenge` with `{ uid }`.
2. Verify B’s returned `nodePk` against the admitted mesh-node projection.
3. `POST /n/<B>/api/auth/login` with the existing Borsh `Login`, session-key signature, user delegation, and optional TOTP.
4. B issues `tmex_s_<B>` through `x-tmex-set-session`.

The delegation TTL is 18 hours; node sessions are 18 hours sliding with a seven-day hard limit; login challenges are 60 seconds. [`packages/shared/src/auth/delegation.ts:6`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/packages\/shared\/src\/auth\/delegation.ts:6) [`apps/gateway/src/auth/node-session-store.ts:6`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/gateway\/src\/auth\/node-session-store.ts:6)

The delegation itself is intentionally mesh-wide, but a login signed with it is bound to B through the one-time challenge, `target`, `target_pk`, UID, and entry. [`packages/shared/src/auth/encoding.ts:74`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/packages\/shared\/src\/auth\/encoding.ts:74) [`packages/shared/src/auth/login.ts:52`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/packages\/shared\/src\/auth\/login.ts:52) This satisfies EX4: a B-local session cannot be replayed elsewhere, while the user delegation is deliberately reusable for another enrolled target.

### Frontend changes — Medium

- Invoke `useNodeLoginGate()` from `NodeDeviceGroup` for online signed-out nodes.
- Render a spinner while the existing `ensureNodeLogin()` attempt is in progress.
- Leave `NodeLoginButton` as the fallback when there is no session key, TOTP is required, or credentials are rejected.
- Preserve `/login?node=<id>&next=<path>` navigation and existing username prefill.
- Avoid background fan-out to every node; authenticate only when the user opens or expands that node.
- On `NODE_LOGIN_REQUIRED`, attempt one silent login if the in-memory session exists; do not retry arbitrary non-idempotent writes indefinitely.
- Add a visible but non-sensitive notice when automatic authentication fails.

### Backend changes — Small

No production protocol changes are needed. Add regression coverage around the existing two-node harness:

- One delegation authenticates to B and receives only `tmex_s_<B>`.
- An A-target login cannot be replayed against B.
- An A SID cannot authenticate to B.
- Revoking A invalidates B sessions whose `viaNodeId` is A.
- Existing forged-node and forged-delegation tests remain passing.

The current in-process mesh integration suite already contains the appropriate two-node setup and compromise tests. [`apps/gateway/src/mesh/integration/mesh.integration.test.ts:846`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/gateway\/src\/mesh\/integration\/mesh.integration.test.ts:846)

### Frontend and e2e tests

Extend `apps/fe/tests/mesh-login.spec.ts` with a mesh-project case that:

1. Logs into the home node.
2. Navigates to Devices through SPA navigation.
3. Opens the remote node.
4. Confirms the remote node becomes logged in without showing or filling the password form.
5. Reloads before remote login and confirms the documented manual fallback.
6. Covers TOTP-required fallback.

The Playwright configuration registers this suite under the `mesh` project, and the existing helper already documents the reload/session-key behavior. [`apps/fe/playwright.config.ts:29`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/fe\/playwright.config.ts:101) [`apps/fe/tests/helpers/mesh.ts:227`](\/Users\/konata\/code\/tmex-enhanced-wt-r11\/apps\/fe\/tests\/helpers\/mesh.ts:227)

Both agents should agree first on the existing auth contract in `packages/shared/src/auth/encoding.ts`, `packages/shared/src/auth/login.ts`, and `packages/api-client/src/auth/types.ts`. No `uplink` contract change is needed.