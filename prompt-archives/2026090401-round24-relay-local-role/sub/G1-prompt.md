# Task G1 — Backend: relay roles for the local machine (setup route, leave target role, local status)

Result file (write LAST): /Users/konata/code/tmex-r24/prompt-archives/2026090401-round24-relay-local-role/sub/G1-result.md

READ FIRST: `prompt-archives/2026090401-round24-relay-local-role/sub/EX1-report.md` sections A1–A4 (precise file:line map), and `docs/relay/2026090304-relay-role.md` §1, §10 (初始化), §12.

## Background
1.1.23 added the relay role (`TMEX_ROLES=relay` / `relay,node`, env keys `TMEX_RELAY_PUBLIC_URL`, `TMEX_RELAY_ADMIN_TOKEN`; tenant admission password hashed in `relay_config.password_hash`, set via `POST /api/relay/password`). Today the web can only switch a standalone machine to `hub,node` (`POST /api/setup/hub` → `becomeHub`) or `node` (`POST /api/setup/join` → `joinHub`), and `/api/local/leave` can only go back to `standalone`. The web 本机 card will now offer all five roles; this task provides the backend.

## Deliverables
### 1. `POST /api/setup/relay` (standalone only, like the other setup routes)
Body: `{ role: 'relay' | 'relay,node', relayPublicUrl: string, relayPassword?: string | null, username?: string, password?: string, directEnable?: boolean }`.
- Validate `relayPublicUrl` with the same rule the CLI uses (`normalizeRelayUrl` — find it in packages/app or packages/shared; https required, loopback http allowed in non-production).
- Write env via the existing staged-env / `patchOwnedEnvKeys` machinery: `TMEX_ROLES=<role>`, `TMEX_RELAY_PUBLIC_URL`, `TMEX_HUB_URL=''`, `TMEX_HUB_PUBLIC_URL=''`, and `TMEX_RELAY_ADMIN_TOKEN` (keep an existing value if present in the env file, else generate with `generateRelayAdminToken()` from packages/app/src/lib/install.ts). Never return the admin token in the response.
- `relayPassword` (tenant admission password; may be null/empty = no password): hash with the existing Argon2id helper in `apps/gateway/src/relay/relay-password.ts` and store via `RelayConfigStore` (`apps/gateway/src/relay/relay-config-store.ts`) into `relay_config` (table exists from migration 0039 on every install; the RelayRuntime is not running in standalone — write the row directly through the store using `deps.auth.db`, creating the config row if missing exactly the way RelayRuntime would on first start so that the runtime picks it up after restart; also bump `password_epoch` semantics consistently with `POST /api/relay/password`). Never write the password to app.env.
- `role === 'relay,node'`: additionally bootstrap the local mesh user exactly like `becomeHub` does (`ensureNodeIdentity` + `bootstrapUserWithSelfAdmit`, `user_exists` 409 on conflict, username/password validation reused). The node stays without an uplink after restart; the web will later enroll it to its own relay through the normal enroll flow (another task makes the node dial loopback when the relay host equals its own `TMEX_RELAY_PUBLIC_URL`). Verify in a test that after this setup the roles parse to `relay,node`, the user exists, and `getLocalStatus` reports `role: 'relay,node'`.
- `role === 'relay'`: no user, no identity. Response for both: `{ ok: true, role, relayPublicUrl, hasPassword, restarting: true }` (plus `fingerprint` for relay,node like becomeHub). Restart via `withSetupTransition` like the others.
- Put the implementation in a NEW file `packages/app/src/runtime/relay-setup-service.ts` (setup-service.ts is 746 lines and must not grow; you may move shared helpers it needs into a new `setup-shared.ts` if that keeps every touched file ≤ 600 lines — note: setup-service.ts is already over the limit; do not make it worse, reduce it if you touch it substantially).
- Register in `packages/app/src/runtime/setup-routes.ts` and make sure `assemble-routes.ts` / `assemble.ts` pass whatever deps are needed (e.g. a relay config store factory). `assemble-routes.ts` is 598 lines — if you must add more than a couple of lines there, extract.

### 2. `/api/local/leave` gains `targetRole`
Body `{ expectedRole, targetRole?: 'standalone' | 'relay' }` (default `'standalone'`, backwards compatible).
- `relay,node → relay`: clear mesh membership (users, certs, nodes, peer_cache, hub trust, mesh_relays, mesh_secrets …) but KEEP relay operator state (relay_config, relay_tenants, relay_nodes, relay_enrollments, relay_key_log, metering) and keep `TMEX_RELAY_PUBLIC_URL` / `TMEX_RELAY_ADMIN_TOKEN`; write `TMEX_ROLES=relay`.
- `relay,node → standalone`: clear both mesh membership AND relay operator state; clear the two relay env keys.
- `node|hub,node → standalone`: unchanged behaviour (also make sure the relay env keys are cleared/absent — today `STANDALONE_ENV` only overrides hub keys; EX1 A3 notes this leak).
- `targetRole:'relay'` from `node` / `hub,node` is a 400 (`invalid_target`); the web does that as leave → restart → setup relay.
- Split `MeshMembershipStore.clearAll()` (`apps/gateway/src/auth/mesh-membership-store.ts`) into `clearMeshMembership()` and `clearRelayOperatorState()` (+ keep `clearAll()` = both). Find the full relay table list in `apps/gateway/src/db/schema/*relay*` / migration 0039.
- Result `{ ok, fromRole, targetRole, restarting: true }`.

### 3. `/api/local/status` relay block
Add `relay: null | { publicUrl: string | null, hasPassword: boolean, tenantCount: number, nodesOnline: number, currentNodes: number }` — non-null iff roles.relay. Read from the RelayRuntime (config store + tenant store; `countActiveNodes` per tenant summed for `currentNodes`; online count from the runtime's registry/uplink server — expose a small `snapshotForLocalStatus()` on RelayRuntime in `apps/gateway/src/relay/relay-runtime.ts` if nothing suitable exists). Inject through `SetupServiceDeps`/`LocalRouteDeps` as an optional `relayStatus?: () => Promise<...>` so tests can stub it. Never expose token/hash.
Also add `relayPublicUrl` is covered by `relay.publicUrl`; keep the existing fields untouched.

### 4. api-client types
`packages/api-client/src/local/types.ts`: `LocalStatusResponse.relay`, new `SetupRelayRequest/Response`, `LeaveRequest.targetRole`; `packages/api-client/src/local/setup-api.ts`: `setupRelay()`; `local-api.ts` leave signature. Update their tests.

### 5. Tests
Colocated bun tests for the setup route (both roles, validation errors, `not_standalone`, password hashing round-trip readable by `verifyRelayPassword`, env keys written/cleared, admin token preserved), leave targetRole matrix, store split, local status relay block. Baselines: packages/app 798 pass + 1 known env failure (`scripts/build-runtime.test.ts`), apps/gateway 4141, api-client 201 (+5 pre-existing tsc errors there).

## Scope (files you own)
- packages/app/src/runtime/setup-routes.ts, setup-service.ts, relay-setup-service.ts (new), setup-shared.ts (new, optional), membership-reset.ts, local-routes.ts, assemble-routes.ts, assemble.ts, assemble-relay.ts, and their tests
- apps/gateway/src/auth/mesh-membership-store.ts (+test), apps/gateway/src/relay/relay-config-store.ts, relay-password.ts, relay-runtime.ts (only to add the snapshot accessor), relay-tenant-store.ts only if a counting helper is missing
- packages/api-client/src/local/** (+tests)
- docs: append a short section to docs/relay/2026090304-relay-role.md §10 「网页」 describing the new route and leave semantics (keep it brief)
Do NOT touch: apps/gateway/src/mesh/** (another agent), apps/gateway/src/relay/relay-routes.ts / relay-uplink-*.ts / relay-admin-routes.ts (another agent), packages/shared/**, apps/fe/**, packages/app/src/commands/**.
## Common rules (apply to every task)

- Repo: Bun-only TypeScript monorepo at /Users/konata/code/tmex-r24 (git worktree, branch feat/round24-relay-local-role, base = main 1.1.23). Bun is /opt/homebrew/bin/bun (if not on PATH, read ~/.zshrc). Runtime code runs on Bun 1.3.x; only packages/app's install CLI stays Node-compatible.
- OTHER AGENTS ARE EDITING THIS SAME WORKTREE IN PARALLEL. Touch ONLY the files listed in your scope (plus new files you create inside your scope directories). Do not reformat or "clean up" files outside your scope. If a change outside your scope is unavoidable, do NOT make it — describe it precisely in your result file under "需要指挥官处理".
- NO git operations at all (no add/commit/stash/checkout/reset/worktree). The commander commits.
- Do not run `bun install`, do not edit lockfiles or package.json dependencies unless your scope says so.
- Do not touch generated files: packages/shared/src/i18n/resources.ts, packages/shared/src/i18n/types.ts, packages/shared/src/i18n/locales/generated/*, resources/fe-dist/*, dist/*. i18n keys live in packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json (all three must be updated together, same key set) and are regenerated with `bun run build:i18n` at the repo root (you MAY run that if your scope includes i18n changes). Edit only the sub-objects named in your scope; other agents edit other sub-objects of the same JSON files.
- Copy (UI text) rules: read /Users/konata/code/tmex-copy-guidelines.md before writing any user-facing text. Key points: "Hub" means hub role; "中继" means the relay role ONLY; "本机" not "这台机器"; no second person; full-width Chinese punctuation.
- Never touch the production tmex service (port 9883, ~/Library/Application Support/tmex) and never touch a tmux session named `tmex`. Any temporary gateway instance must set TMEX_TMUX_SOCKET to an isolated socket (e.g. tmex-r24-<task>) and use ports other than 9883/9663/19883/19663. Never run `tmux kill-server` on the default socket.
- Do not run the Playwright e2e suite (apps/fe/tests) — the commander runs it. In apps/fe, unit tests are `bun test src/`.
- Code style: TypeScript, biome. No unnecessary comments; comments only for genuinely complex logic, written in Simplified Chinese. Identifiers in English. Follow patterns in neighbouring files. Keep every file under 600 lines (complexity gate; `bun run lint` at repo root runs biome + the gate). Do not add entries to the complexity allowlist. When a file you must touch is already near 600 lines, split it (moving code into new files inside your scope is fine).
- Verify before finishing: (1) `bunx tsc --noEmit -p <package>` for each package you touched must not add errors versus baseline (baseline: packages/stores 1, packages/theme 9, packages/api-client 5 pre-existing errors; everything else 0); (2) `bun test` inside each touched package (apps/fe: `bun test src/`) must pass — baselines: gateway 4141, shared 621, app 798 (+1 known env failure in scripts/build-runtime.test.ts), fe 1883, ws-client 392, stores 411, panels 911, ui 370, api-client 201, terminal-ui 394, theme 52; (3) `bunx biome check <your files>`. macOS has no `timeout` command; bun test summary lines carry ANSI colours.
- Write tests for new behaviour (bun test, colocated `*.test.ts(x)`). Deterministic; no sleeps over 100 ms.
- Never hardcode credentials in scripts or tests beyond obvious fixture values.
- When completely done, write your result report (Simplified Chinese, concise, technical) to the ABSOLUTE result path given in your task — list files changed, tests added, verification output summary, anything the commander must handle — and only then exit. The result file must be the LAST thing you write.
