# Q1 — relay live-test harness

## What was built

A process supervisor that boots a **three-process relay mesh from source** on 127.0.0.1, modelled on
`apps/fe/tests/helpers/mesh-boot.ts` (which it does **not** modify or duplicate).

| Instance | Roles | How it gets there |
|---|---|---|
| R | `relay,node` | `TMEX_RELAY_PUBLIC_URL=http://127.0.0.1:<portR>`, `TMEX_RELAY_ADMIN_TOKEN` pinned in `app.env`; relay password set via `POST /api/relay/password` with the admin bearer |
| A | `node` (empty `TMEX_HUB_URL`) | `tmex relay enroll <url> --password <relay pw> --install-dir <A>` — opens the tenant, signs `set-relays`, attaches |
| B | `standalone` → `node` | `tmex hub join --token r3.<…> --name relay-node-b --no-restart --install-dir <B>`, then A signs `admit-node` + a bumped `meta-key` |

Files (all new, nothing else touched):

- `apps/fe/tests/helpers/relay-boot.ts` (567 lines) — orchestration, env rendering, spawning,
  port/tmux allocation, cleanup on SIGTERM/SIGINT, progress logging, `--state` and `--mode hub`.
- `apps/fe/tests/helpers/relay-boot-auth.ts` (349 lines) — password→root-key login (Argon2 seed →
  Ed25519 root → delegation → challenge/login), per-node session cookies incl. `/n/<id>`,
  key-log record signing, `r3.` join-token minting, `admit-node` + `meta-key` admission.
- `apps/fe/tests/helpers/relay-boot-state.ts` (133 lines) — state JSON schema/builder and the
  `--mode hub` help text (split out to stay under the 600-line file limit).
- `docs/testing/2026090604-relay-live-harness.md` — Chinese doc: topology, exact commands, boot
  sequence, pitfalls, state schema, acceptance curls.

## Exact command to boot

```bash
cd /Users/konata/code/tmex-r32
bun apps/fe/tests/helpers/relay-boot.ts --state /tmp/tmex-relay-e2e.json
# prints progress, writes the state file, then stays resident; SIGTERM tears everything down
bun apps/fe/tests/helpers/relay-boot.ts --mode hub   # prints how to run mesh-boot.ts instead
```

Ports: gateway from 19851, peer from 39851 (first free triple). tmux sockets
`tmex-relay-e2e-r` / `-a` / `-b`. `NODE_ENV=test` is written into `app.env` **and** passed
explicitly to every spawned runtime/CLI. `TMEX_MASTER_KEY` comes from repo-root `test.env`,
`TMEX_MIGRATIONS_DIR=apps/gateway/drizzle`, `TMEX_FE_DIST_DIR=apps/fe/dist`
(built if `index.html` is missing, same as mesh-boot; `TMEX_RELAY_E2E_BUILD_FE=1` forces a rebuild).

## State JSON schema

```jsonc
{
  "mode": "relay",
  "supervisorPid": 70611,
  "tmpDir": "/tmp/tmex-relay-e2e-<pid>-<ts>",
  "username": "alice",
  "password": "<mesh password shared by A and B>",
  "uid": "<user id>",
  "tenantId": "<relay tenant id, 32 hex>",
  "relay": {
    "role": "relay,node", "name": "relay", "port": 19851, "peerPort": 39851,
    "baseUrl": "http://127.0.0.1:19851", "nodeId": "<R node id>",
    "tmuxSocket": "tmex-relay-e2e-r", "installDir": "<tmp>/relay",
    "cookie": "tmex_s_self=…",
    "publicUrl": "http://127.0.0.1:19851",
    "adminToken": "<b64url 32B>", "adminAuthHeader": "Bearer <adminToken>",
    "username": "relayop", "password": "<R local mesh password>",
    "relayPassword": "<relay join password>"
  },
  "a": {
    "role": "node", "name": "tmex", "port": 19852, "peerPort": 39852,
    "baseUrl": "http://127.0.0.1:19852", "nodeId": "<A node id>",
    "tmuxSocket": "tmex-relay-e2e-a", "installDir": "<tmp>/a",
    "cookie": "tmex_s_self=…; tmex_s_<Bid>=…"      // ready-to-use Cookie header
  },
  "b": {
    "role": "node", "name": "relay-node-b", "port": 19853, "peerPort": 39853,
    "baseUrl": "http://127.0.0.1:19853", "nodeId": "<B node id>",
    "tmuxSocket": "tmex-relay-e2e-b", "installDir": "<tmp>/b",
    "cookie": "tmex_s_self=…",                     // B's own origin
    "transport": "relay",
    "viaA": { "url": "http://127.0.0.1:19852/n/<Bid>",
              "cookie": "tmex_s_self=…; tmex_s_<Bid>=…" }
  },
  "tmuxSockets": { "relay": "tmex-relay-e2e-r", "a": "tmex-relay-e2e-a", "b": "tmex-relay-e2e-b" }
}
```

## Live verification on this machine (all green)

Ran the harness three times end to end (last run after the final refactor). Boot log:

```
[relay-boot] relay=19851 a=19852 b=19853 tmp=/tmp/tmex-relay-e2e-70611-…
[relay-boot] relay healthy
[relay-boot] node A healthy
[relay-boot] tenant attached id=505ede7afeb8f2d4097d3986914ceb88 metaEpoch=1
[relay-boot] r3 join token minted (len=271)
[relay-boot] node B redeemed the join token
[relay-boot] node B admitted id=a812b26f52725952a7eeb96d357a7be2
[relay-boot] node B healthy
[relay-boot] node B online id=a812b26f52725952a7eeb96d357a7be2
[relay-boot] node B reachable via /n/a812…7be2 transport=relay
[relay-boot] ready, state written to /tmp/tmex-relay-e2e.json
```

Checks with `curl` against the state file:

- `GET /api/mesh/relay/status` on A → `mode=relay`, `tenantId` set, `relays[0].online=true`,
  `attached=true`, `metaEpoch=2`, `nodesViaRelay=1`, `keyLog.caughtUp=true`, quota block present.
- `GET /api/mesh/nodes` on A → `[('tmex', online, null), ('relay-node-b', online, 'relay')]`.
  **Recorded transport is `relay`** — WebRTC never upgrades in this loopback setup
  (`endpoint backoff … 192.168.31.36 / 198.18.0.1`), so no `dc` / `ws-secure`.
- `GET http://127.0.0.1:19852/n/<Bid>/api/system/info` with `a.cookie` → **HTTP 200**, B's payload.
- `GET /api/system/info` on B directly with `b.cookie` → HTTP 200.
- `GET /api/relay/status` on R with `adminAuthHeader` → one tenant, `nodes=2`, `nodesOnline=2`,
  `config.hasPassword=true`, `passwordEpoch=1`.

Everything was stopped afterwards: supervisor gone, no `runtime/server.ts` processes left, all three
tmux sockets report "no server running", tmp dirs removed, no `test.env.local` created, production
tmex on 9883 untouched.

## Deviations from the task brief

1. **A cannot start as `standalone`.** `packages/app/src/runtime/assemble.ts` only mounts an
   `authSurfaceOnly` MeshHttpRuntime for standalone, so `/api/mesh/relay/*` does not exist and
   `tmex relay enroll` would 404. A therefore boots as `TMEX_ROLES=node` with empty
   `TMEX_HUB_URL` / `TMEX_HUB_PUBLIC_URL` — exactly the state a machine is left in after a relay
   join — and its user is created with `tmex hub user add` before the runtime starts (same pattern
   as mesh-boot). Everything else about the enroll is the real CLI command.
2. **`tmex enroll` has no relay branch**, so the `r3.` join token cannot be produced by the CLI at
   all — the only producer today is the web add-node wizard (`apps/fe/src/node/relay-join.ts`).
   `relay-boot-auth.ts` reproduces it over real HTTP with the same shared helpers
   (`GET /api/mesh/relay/join-material` → `createEnrollment(rootKey,…)` →
   `POST /api/mesh/relay/enrollments` → `encodeRelayJoinToken`), and likewise the post-redeem
   admission (`admit-node` record + `POST /api/mesh/relay/meta-key/prepare {op:'admit'}` →
   `meta-key` record). The B side is the genuine `tmex hub join --token r3.…` CLI path.
   **If those endpoints change, this helper must change with them.**
3. **Relay password is set through `POST /api/relay/password`** (admin bearer) rather than
   `tmex relay passwd`, which insists on two hidden TTY reads.
4. Split into three files instead of two so no file exceeds the 600-line limit
   (`apps/fe/tests/**` is excluded from `scripts/complexity/gate.ts` via its `/tests/` skip, but the
   limit was respected anyway).

## Pitfalls recorded (also in the doc)

- `transport` is `null` until a peer stream exists; the harness deliberately issues one
  `/n/<B>/api/system/info` request to force the link, then reads the node list. Without that it can
  stay `null` well past 20 s.
- `/n/<B>` needs **both** `tmex_s_self` (A) and `tmex_s_<Bid>` cookies; the harness logs into B
  through A and writes the combined header into `a.cookie` / `b.viaA.cookie`.
- Temp instances create a tmux session literally named `tmex`, but always inside the dedicated
  `-L tmex-relay-e2e-*` sockets — never the default socket. All `kill-server` calls carry `-L`.
- `bunfig` preload sets `NODE_ENV=test` for test processes only; spawned runtimes/CLIs get it
  explicitly in their `env`.
- No `test.env.local` is produced (the harness never goes through web setup); if another experiment
  creates one it must be deleted, since `loadEnv()` treats it as an override across instances.
- Runtimes take a few seconds to exit after SIGTERM — don't assert immediately.

## Gates

- `bunx biome check` on all three new files: clean.
- `bunx tsc --noEmit -p apps/fe`: 0 errors.
- No product source touched; no git operations performed.
