# F7 result — Login flow: real error causes, no internal copy, lazy per-node login

## What changed

### Login is now "sign in to this machine, then stop"

`loginToAllReachable()` (self login → `/api/mesh/nodes` → parallel login into every online node)
is gone. It is replaced by two functions in `apps/fe/src/auth/session-key-store.ts`:

| Function | Behaviour |
| --- | --- |
| `loginSelf({ api })` | Logs in `self` only, then fetches `/api/mesh/nodes` **once** to verify that the public key the entry presented in the challenge matches the hub-signed certificate in the member list. Returns `{ ok: true }` or `{ ok: false, code }` (`NODE_LIST_FAILED` / `NODE_PK_MISMATCH` / whatever the backend returned). No fan-out. |
| `ensureNodeLogin(nodeId, { api, node })` | Logs into one node using the in-memory session key. Single-flight per node id (concurrent callers share one promise); on success it calls `markLoggedIn(nodeId)` so the mesh store flips that row to `loggedIn: true` immediately. Returns `NO_SESSION_KEY` without issuing any request when the key is gone. |

The mesh-list fetch is deliberately kept in `loginSelf`: it is the only thing that catches an entry
presenting a key that was never certified. It is one request, so "navigate immediately" still holds
(`self` login + one list fetch, then `setPhase('done')` → `navigate(next)`).

The per-node progress store (`NodeLoginProgress`, `subscribeLoginProgress`, `getLoginProgress`,
`useLoginProgress`) existed only to drive the fan-out list on the login page and was deleted.

### TOTP decision (documented, as asked)

`apps/gateway/src/mesh/auth-routes.ts:786` (`checkTotp`) runs on **every** `/api/auth/login` whose
delegation method is `root` and whose account has TOTP enabled — so each node needs its own valid
code. The browser holds `k_totp` (the key that decrypts the server-side TOTP secret) but **not** the
secret, so it cannot generate a fresh code; and a code is only valid for ±1 step of 30 s
(`packages/shared/src/auth/totp.ts:48`), which is far shorter than a lazy login's lifetime.

Therefore: the raw code is cleared right after the self login (`clearTotpCode()`), `k_totp` stays in
memory, and a lazy login on a TOTP account returns `TOTP_REQUIRED` → the caller falls back to the
"Sign in to this node" button → `/login?node=` where the user types a fresh code. Keeping the raw
code alive would only buy ~90 s and would leave a live OTP in memory.

### Error mapping (`apps/fe/src/auth/login-errors.ts`, new)

`loginErrorKey(code, method)` / `loginErrorKeyFromException(err, method)` map a failure to an i18n
key. Raw codes and raw `Error.message` are never rendered any more — unknown codes fall to
`auth.errors.LOGIN_FAILED`.

- password path: `DELEGATION_BAD_SIGNATURE` / `BAD_SIGNATURE` / `ROOT_KEY_MISMATCH` /
  `BAD_DELEGATION` / `DELEGATION_METHOD_MISMATCH` → `auth.errors.wrongPassword`.
- passkey path: the same codes → `auth.errors.PASSKEY_VERIFY_FAILED` (there is no password in that
  flow, so "wrong password" would be a lie); `WebAuthnError('aborted')` → `auth.errors.PASSKEY_ABORTED`.
- shared: `TOTP_REQUIRED` / `TOTP_INVALID` / `NETWORK_ERROR` / `RATE_LIMITED` / `UNKNOWN_USER` /
  `NODE_PK_MISMATCH` / `NODE_LIST_FAILED` (→ `auth.login.nodeListFailed`) and the rest of the
  existing `auth.errors.*` inventory.

`isCredentialFailure(code)` decides whether the freshly derived session key is discarded. Previously
*any* failure wiped it; now a network error or a wrong authenticator code keeps the key, because the
key is what powers every later lazy node login.

### Login page (`apps/fe/src/pages/LoginPage.tsx`)

Renders exactly: `<Brand />`, username, password, authenticator code (only when `totpEnabled`),
one error line, Sign in, Sign in with passkey. Removed: the `ShieldCheck` + title + subtitle header,
the passkey **registration** link (`/account/security`), the "Signing in to:" public-node list, and
the per-node fan-out progress list. `?node=` still targets one node and blocks on it.

### Lazy login hooks

`apps/fe/src/auth/use-node-login.ts` (new) — `useNodeLoginGate(runtimeNodeId, { enabled })` returns
`{ status: 'ready' | 'pending' | 'blocked', code, retry }`:

- `self` / the entry's own node id, standalone (`mode: 'none'`), or a failed `/api/auth/mode` →
  always `ready`; no extra requests in single-node installs.
- a remote node whose state is not known yet (`/api/auth/mode` or `/api/mesh/nodes` still in flight)
  → `pending`. Rendering the subtree first and pulling it away afterwards would remount the whole
  shell (terminals, WS); both requests always settle, and either failing falls back to `ready`.
- online + not logged in → `pending` while `ensureNodeLogin` runs, `blocked` with the code if it fails.

`apps/fe/src/node/node-runtime-boundary.tsx` uses the gate for `/n/:id/*`: spinner while pending, and
on failure a full-screen fallback with the mapped reason, `NodeLoginButton`, and a link back to `/`
(the sidebar lives inside this boundary, so the fallback has to carry its own way out).

`sidebar-node-section.tsx`: an online-but-not-signed-in node no longer mounts anything on render. It
collapses to a single "Sign in" affordance (`sidebar-node-expand-<id>`); expanding enables the gate,
which silently logs in (spinner `sidebar-node-pending-<id>`), and on failure shows the mapped reason
plus the existing `NodeLoginButton` (which redirects to `/login?node=` when the key is gone).

`NodeLoginButton` now calls `ensureNodeLogin` instead of `loginToNode`, so a manual sign-in also
updates the mesh store immediately.

### File list

| File | Change |
| --- | --- |
| `apps/fe/src/auth/session-key-store.ts` | `loginSelf` + `ensureNodeLogin` replace `loginToAllReachable`; progress store deleted; `NODE_LIST_FAILED` added to `LoginFailureCode`; `resetNodeLoginsForTest`. |
| `apps/fe/src/auth/session-key-store.test.ts` | `loginToAllReachable` suite replaced by `loginSelf` (6 cases) and `ensureNodeLogin` (4 cases). |
| `apps/fe/src/auth/login-errors.ts` | **new** — failure code → i18n key, credential-failure predicate. |
| `apps/fe/src/auth/use-node-login.ts` | **new** — the lazy-login gate hook. |
| `apps/fe/src/auth/use-node-login.test.tsx` | **new** — 8 cases on gate status. |
| `apps/fe/src/auth/use-session-key.ts` | `useLoginProgress` removed. |
| `apps/fe/src/auth/NodeLoginButton.tsx` | uses `ensureNodeLogin`. |
| `apps/fe/src/auth/index.ts` | exports the two new modules. |
| `apps/fe/src/node/mesh-nodes.ts` | `markLoggedIn(nodeId)` helper only. |
| `apps/fe/src/node/node-runtime-boundary.tsx` | gate + pending / blocked screens. |
| `apps/fe/src/node/node-runtime-boundary.test.tsx` | existing cases seed a non-mesh store; 3 new gate cases. |
| `apps/fe/src/pages/LoginPage.tsx` | rewritten as described. |
| `apps/fe/src/pages/LoginPage.test.tsx` | registration-link expectation removed; brand, "no internal state", and the whole error-mapping table added. |
| `apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx` | collapsed sign-in affordance + gate. |
| `apps/fe/src/components/page-layouts/components/sidebar-device-list.test.tsx` | the "online but not signed in" case now asserts the collapsed affordance and that nothing auto-mounts. |
| `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json` | `auth.*` only (see below). |
| `packages/shared/src/i18n/{resources,types}.ts` | regenerated by `bun run build:i18n`. |
| `apps/fe/src/components/brand.tsx` | see "Incident" below. |

### i18n (`auth.*` only)

Removed (no longer rendered anywhere): `auth.login.subtitle`, `auth.login.registerPasskeyHere`,
`auth.login.allNodesFailed`, `auth.login.willSignIn`.
Added: `auth.errors.wrongPassword`, `auth.node.signInRequired`, `auth.node.backToLocal`.
`auth.login.nodeListFailed` is kept — it is now the text for `NODE_LIST_FAILED`.
Diff verified to touch nothing outside `translation.auth`.

## Incident — `apps/fe/src/components/brand.tsx`

The F7 prompt told me to create a placeholder if `brand.tsx` did not exist. It did not exist when I
listed the directory, but **F8 created it (and `brand.test.tsx`) in the meantime**, and my `Write`
overwrote it. The file is untracked, so git could not restore it.

I rebuilt it from `brand.test.tsx` and the two call sites F8 had already written
(`sidebar-title.tsx`, `page-wrapper.tsx`): exports `Brand`, `PRODUCT_NAME`, `BRAND_LOGO_SRC`; props
`className` / `size: 'sm' | 'md'` / `showName` / `linkTo` / `linkComponent`; site name from the site
store with `PRODUCT_NAME` fallback; renders outside a `RuntimeProvider` via `useOptionalRuntime`.
**All 5 of F8's `brand.test.tsx` cases and the new `sidebar-title.test.tsx` brand case pass**, and
`page-wrapper.tsx` type-checks against it.

One implementation detail my reconstruction had to get right and F8 should keep: the site name must
be read with `useSyncExternalStore(store.subscribe, () => store.getState()…)`, **not** with zustand's
`store(selector)` hook — under `renderToStaticMarkup` zustand serves `getInitialState()`, so the
selector hook always yields the default name and the "custom siteName wins" test fails.

**F8 should diff this file against what they intended and restore anything I lost.** I did not touch
`brand.test.tsx`, `sidebar-title.tsx`, `page-wrapper.tsx`, `main.tsx`, `packages/shared/src/brand.ts`
or the stores changes.

## How to verify

```bash
cd /Users/konata/code/tmex-enhanced-wt-merge
bun run build:i18n
cd apps/fe && bun test src/ && bunx tsc --noEmit -p .
cd ../../packages/shared && bun test && bunx tsc --noEmit -p .
cd ../.. && bunx biome check apps/fe/src/auth apps/fe/src/node \
  apps/fe/src/pages/LoginPage.tsx apps/fe/src/pages/LoginPage.test.tsx \
  apps/fe/src/components/brand.tsx \
  apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx \
  packages/shared/src/i18n/locales
```

Manual (needs a running mesh):

1. Wrong password on `/login` → "Wrong password.", not "Sign-in failed on every node."
2. `/login` shows no "Set up a passkey on this node" link and no node list / progress list.
3. Correct password → the local device list appears immediately; no requests are sent to other nodes.
4. Sidebar: other nodes stay collapsed with a "Sign in" row; expanding one signs in silently and the
   device tree appears.
5. Open `/n/<other>/devices` directly → spinner, then the page; if the session key is gone, the
   fallback screen with "Sign in" and "Back to this machine".

## Numbers

| Check | Before | After |
| --- | --- | --- |
| `apps/fe` — `bun test src/` | 481 pass / 0 fail | **511 pass / 0 fail** |
| `apps/fe` — `bunx tsc --noEmit -p .` | 0 errors | **0 errors** |
| `packages/shared` — `bun test` | 344 pass / 0 fail | **344 pass / 0 fail** |
| `packages/shared` — `bunx tsc --noEmit -p .` | 0 errors | **0 errors** |
| `bunx biome check` on changed files | — | clean |

The stated baseline was 470; the worktree was already at 481 when I started (other agents' tests
landed in between). No pre-existing test was made to fail.

## Open issues / out-of-scope requests

1. **"Navigate immediately" is verified indirectly.** `apps/fe` has no DOM test environment (only
   `react-dom/server`), so there is no way to click a button and assert `navigate()`. The guarantee
   is covered at the store level instead: `loginSelf` issues exactly one login call, to `self`, and
   returns (`session-key-store.test.ts`, "只登录 self…"). `LoginPage` navigates on `phase === 'done'`,
   which is set on that return.
2. **The gate blocks the whole shell on `/n/:id`.** `NodeRuntimeBoundary` wraps `RootLayout` in
   `main.tsx`, so a pending/blocked gate replaces the sidebar too. That is why the blocked screen
   carries its own "Back to this machine" link. A nicer split would put the gate inside
   `MainInset`'s `<Outlet>` — that is a `main.tsx` / `page-wrapper.tsx` change, outside my scope.
   **Requested from whoever owns `main.tsx`** (F8 moved `PageWrapper` into `page-wrapper.tsx`).
3. **`loginSelf` fetches `/api/mesh/nodes` but cannot seed the mesh store** — my scope on
   `mesh-nodes.ts` was "only a `markLoggedIn` helper". Adding a `setMeshNodes(nodes)` there would
   save the sidebar's duplicate fetch right after login. Small, safe follow-up.
4. **`markLoggedIn('self')` is a no-op before `/api/auth/mode` has landed** (it needs `entryNodeId`).
   Harmless — the sidebar's own refresh corrects it within one request — but item 3 would remove the
   window entirely.
5. **`AuthApi.listPublicNodes()` / `GET /api/auth/nodes` now has no frontend consumer.** The endpoint
   and client method are untouched (out of scope); someone should decide whether the pre-login public
   node list is still wanted anywhere.
6. **`auth.node.retryLogin` is still only used by `NodeLoginButton`'s own retry label**; it was not
   removed because that button is unchanged in that respect.
