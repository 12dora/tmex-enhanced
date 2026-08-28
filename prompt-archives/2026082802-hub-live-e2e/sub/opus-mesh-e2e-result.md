# Mesh browser e2e brought into the repo as Playwright specs

Branch: `chore/merge-hub-tabs` (worktree `/Users/konata/code/tmex-enhanced-wt-merge`).
Replaces the standalone harness `scripts/hub-e2e/split/browser.ts` with repo-native Playwright
specs that boot their own hub + node.

## Files changed

New:

| Path | Purpose |
|---|---|
| `apps/fe/tests/helpers/mesh-boot.ts` | Bun supervisor: boots the whole mesh, writes a state JSON, stays alive until SIGTERM |
| `apps/fe/tests/helpers/mesh.ts` | Spec-side helpers (state IO, boot/stop, login, logout, virtual authenticator, xterm buffer read, remote device/tmux helpers) |
| `apps/fe/tests/mesh.setup.ts` | Playwright setup project: spawns the supervisor, waits for state |
| `apps/fe/tests/mesh.teardown.ts` | Playwright teardown project: SIGTERMs the supervisor, removes tmp dir/state |
| `apps/fe/tests/mesh-login.spec.ts` | Password login → sidebar lists hub self node + joined node; terminal marker on the remote node via the entry |
| `apps/fe/tests/mesh-passkey.spec.ts` | CDP virtual authenticator → register passkey on `/account/security` → logout → passkey login |

Modified:

| Path | Change |
|---|---|
| `apps/fe/playwright.config.ts` | `chromium` now has `testIgnore` for mesh files; three mesh projects registered when `TMEX_E2E_MESH=1`; `webServer` list skipped when `TMEX_E2E_MESH_ONLY=1` |
| `apps/fe/scripts/run-e2e.ts` | Derives `TMEX_E2E_MESH` / `TMEX_E2E_MESH_ONLY` / `TMEX_MESH_E2E_STATE` from `--project` / `--grep`; standalone port picking skipped in mesh-only runs |
| `apps/fe/tests/global-setup.ts` | Early return when `TMEX_E2E_MESH_ONLY=1` (there is no standalone gateway in that mode) |
| `docs/hub/2026082801-hub-docker-e2e.md` | The single "不覆盖 … 浏览器 Playwright" bullet in 已知限制 now points at the new specs |

`apps/fe/tests/README.md` does not exist, so per the brief nothing was added there.
No other agent's files were touched (gateway healthz/env, `scripts/hub-e2e/*` left alone).

## How the mesh boot works

`mesh-boot.ts` runs under Bun and reproduces the docker-compose flow on localhost, from source:

1. Picks four free ports (hub HTTP from 19771, node HTTP, and two peer ports from 39771) and
   creates `/tmp/tmex-mesh-e2e-<pid>-<ts>/{hub,node}/app.env`. Master key is copied from
   `test.env` so the CLI and the servers agree; the password is randomly generated per run and
   only ever lives in the temp state JSON (nothing lands in the repo).
2. `bun packages/app/src/cli-auth-entry.ts hub user add alice --install-dir <hubDir>`
   (`TMEX_PASSWORD` via env, `TMEX_MIGRATIONS_DIR` pointed at `apps/gateway/drizzle`).
3. Starts the hub as `bun packages/app/src/runtime/server.ts` with `TMEX_ROLES=hub,node` and
   `TMEX_FE_DIST_DIR=apps/fe/dist`, waits for `/healthz`.
4. Spawns `enroll --ttl 10m` on the hub, scrapes `join token: …` from its stdout, then runs
   `hub join http://localhost:<hubPort> --token … --name mesh-node-b --insecure-local --no-restart`
   against the node install dir. It asserts the join actually persisted
   `TMEX_ROLES=node` / `TMEX_HUB_URL` into the node's `app.env`, then waits for `node admitted`
   from the enroll process and kills it.
5. Starts the node (`TMEX_ROLES=node`, its own peer port and tmux socket), waits for `/healthz`.
6. Does one API-level password login (same Argon2 → Ed25519 → delegation → challenge/login dance
   the browser does) purely to poll `/api/mesh/nodes` until the joined node is `online`.
7. Writes the state JSON (base URL, ports, username/password, uid, hub node id, remote node id,
   tmux socket names, supervisor pid, tmp dir) and then blocks forever.

On SIGTERM it kills both servers, `tmux -L tmex-mesh-e2e-{hub,node} kill-server` (dedicated
sockets, never the default one), and removes the temp dir.

Key design decisions:

- **The hub gateway serves the frontend directly** (`apps/fe/dist` via
  `packages/app/src/runtime/server.ts`), rather than putting vite in front of it. The vite dev
  proxy only forwards `/api` and `/ws`, not `/n/<nodeId>/api` or `/n/<nodeId>/ws`, so a vite-based
  mesh entry cannot reach remote nodes at all. Serving the built dist also matches the docker e2e
  and production topology. If `apps/fe/dist/index.html` is missing, mesh-boot builds the frontend
  once (`TMEX_MESH_E2E_BUILD_FE=1` forces a rebuild).
- **Entry origin is `http://localhost:<hubPort>`**, satisfying the WebAuthn requirement that the
  origin host be a domain or `localhost`.
- **Project dependencies, not a global `globalSetup`**: mesh must not boot for standalone runs.
  `mesh-setup` (teardown → `mesh-teardown`) is a dependency of the `mesh` project, and the whole
  trio only exists when `TMEX_E2E_MESH=1`.
- `packages/app`'s CLI code paths (`runHubUserAdd` / `runEnroll` / `runHubJoin`) are reused as
  child processes rather than re-implemented — each one opens its own SQLite singleton, so they
  cannot share a process. WAL + `busy_timeout=5000` makes the concurrent enroll/server access safe,
  exactly as in the docker harness.

## How to run

```sh
cd apps/fe
bun run scripts/run-e2e.ts --project mesh     # preferred
bun run scripts/run-e2e.ts --grep mesh        # equivalent; run-e2e derives the same env
```

Both forms set `TMEX_E2E_MESH=1`, `TMEX_E2E_MESH_ONLY=1` and a per-pid
`TMEX_MESH_E2E_STATE=/tmp/tmex-mesh-e2e-<pid>.json`. In mesh-only mode the standalone
gateway/vite webServers and the standalone `globalSetup` healthz assertion are skipped — mesh
boots its own two instances on freshly probed ports, so there is no way to hit the production
tmex on 9883.

Running the suite with no arguments is unchanged: `Total: 106 tests in 48 files`, mesh excluded.

## Test output

```
Running 5 tests using 1 worker

[mesh] hub=http://localhost:19771 node=mesh-node-b(687de4d9cc0c227a53aa63c1169af8e0) pid=18830
  ✓  1 [mesh-setup] › tests/mesh.setup.ts:4:1 › mesh: boot hub and node (3.0s)
  ✓  2 [mesh] › tests/mesh-login.spec.ts:21:1 › mesh: password login lists the hub self node and the joined node (662ms)
  ✓  3 [mesh] › tests/mesh-login.spec.ts:49:1 › mesh: terminal on the joined node echoes through the entry (1.8s)
  ✓  4 [mesh] › tests/mesh-passkey.spec.ts:19:1 › mesh: register a passkey on the entry node and log in with it (1.5s)
  ✓  5 [mesh-teardown] › tests/mesh.teardown.ts:4:1 › mesh: stop hub and node (203ms)

  5 passed (9.9s)
```

Three consecutive clean-boot runs, plus one `--grep mesh` run, all 5/5 green. After teardown no
`runtime/server.ts` / `mesh-boot.ts` processes remain and both mesh tmux sockets report
`no server running`.

Baselines:

- `bun test src/` in `apps/fe`: **333 pass, 0 fail** (24 files).
- `bunx tsc --noEmit -p apps/fe`: **0 errors**.
- `bunx biome check` on all 9 changed/new files: **clean**.
- Standalone regression sample `bun run scripts/run-e2e.ts tests/devices.spec.ts tests/terminal-ui.spec.ts --project chromium`: **4 passed**.

## Open issues / notes

1. **Remote node display name degrades to the node id on a hub entry.** Right after boot,
   `GET /api/mesh/nodes` on the hub returns `name === <nodeId>` for the joined node even though
   `GET /api/hub/nodes` has the correct `mesh-node-b`. `mesh-routes.ts` builds the name as
   `peer?.name ?? (isSelf ? 'self' : id)`, i.e. it only reads the `peers` table, which on a hub
   entry is populated asynchronously (and `onNodeList` deletes peer rows whenever the cert/uid
   check does not line up). The name settles to `mesh-node-b` later in the same process lifetime.
   Because of this the sidebar spec asserts node **ids** (section testids + the badge `title`
   suffix) rather than the display name. Worth a follow-up on the product side — either have
   `mesh-routes` fall back to the hub registry name, or make `mergeNodes`/`patchNodesWithEvent`
   prefer a non-empty name.
2. **`apps/fe/dist` is a real input.** The specs exercise the *built* frontend. If `dist` is stale,
   the specs test stale UI; mesh-boot only auto-builds when `index.html` is missing. Set
   `TMEX_MESH_E2E_BUILD_FE=1` to force a rebuild before a run.
3. **No RTC / direct link coverage.** `TMEX_STUN_SERVERS` is emptied and `TMEX_NATIVE_DIR` is not
   set, so hub↔node traffic goes over the uplink relay. That is enough for the browser flows here;
   `reach=lan`/DataChannel remains docker-e2e territory.
4. **Orphan supervisors on hard interrupts.** If a run is killed with SIGKILL between setup and
   teardown, the detached supervisor survives (it only reaps on SIGTERM/SIGINT). The next run
   simply picks different free ports; clean up manually with
   `pkill -f apps/fe/tests/helpers/mesh-boot.ts` if needed.
5. **Only one remote node.** The brief asked for "hub self node and a second node"; the harness
   boots exactly hub + one node. Adding a third is a matter of repeating the enroll/join block in
   `mesh-boot.ts`.
