# Task G5 — Complexity-gate fixes for the password-join backend + small follow-ups

Result file (write LAST): /Users/konata/code/tmex-r24/prompt-archives/2026090401-round24-relay-local-role/sub/G5-result.md

Run `bun run lint` at the repo root (biome + `bun scripts/complexity/gate.ts`). The following violations were introduced by the just-committed relay password join (P1) and must be fixed WITHOUT adding allowlist entries and without changing behaviour (all existing tests must keep passing; add tests where you split logic):
- `packages/app/src/lib/relay-password-join.ts` — function CC 25 / ~175 lines: split into phases (kdf+proof+pack, log download+verify+replay, self-admit+persist, upload+env) in a new sibling module.
- `packages/shared/src/relay/relay-pack.ts` `kdfParamsFromWire` — CC over limit.
- `apps/gateway/src/relay/relay-pack-http.ts` `applyRelayKeyLogAppend` — CC over limit.
- `apps/gateway/src/relay/relay-runtime.ts` `routePublic` — CC over limit (use a route table like `apps/gateway/src/mesh/relay-routes.ts`).
- `apps/gateway/src/mesh/relay-pack-routes.ts` `handleMeshRelayPack` — CC over limit.
- Any other gate failure the run reports in apps/gateway, packages/app, packages/shared (fe violations are handled by another agent — report them, do not fix).
Also:
- `apps/gateway/src/relay/relay-routes.ts`: HTTP redeem now calls `deps.uplink.notifyQuota(tenant.id)` (commander wired it) — add a unit test asserting the call.
- `packages/shared/src/relay/relay-pack.ts`: double-check buffers holding seed/KEK/plaintext are zeroed after use in both seal and open paths; add a test that the plaintext buffer passed in is zeroed after `seal`.
- Docs: none.

Scope: exactly the files named above plus new sibling modules you create next to them and their tests. Do NOT touch apps/fe/**, packages/app/src/runtime/**, apps/gateway/src/hub/**, apps/gateway/src/mesh/relay-routes.ts, domain-access-policy.ts.
Baselines: gateway 4198 pass (2 known "Unhandled error between tests" noise — report if you can identify the source file), app 835, shared 645.
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
