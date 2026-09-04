# Task V1 — Fix the canonical v1.1 version gate floor and make the "too old" toast say who is too old

Result file (write LAST): /Users/konata/code/tmex-r24/prompt-archives/2026090401-round24-relay-local-role/sub/V1-result.md

## Background (bug found in production today)
`packages/shared/src/ws-borsh/canonical-version.ts` sets `CANONICAL_V11_MIN_PEER_VERSION = '1.1.22'`, but:
- the browser (`packages/ws-client/src/client.ts` `handleHelloNegotiated`) also requires the HELLO_S2C capability `canonical-state-v1.1` (`packages/shared/src/capabilities.ts`), which only gateways ≥ 1.1.23 advertise (1.1.22 advertised only `canonical-state-v1`), and
- 1.1.22 browsers sent a hardcoded `clientVersion: '0.1.0'` (real version reporting arrived in 1.1.23).
So the real interoperability floor is **1.1.23**. Consequence in production: a 1.1.23 browser opening a remote 1.1.22 node's terminal (the entry forwards the node's HELLO_S2C; see `apps/gateway/src/mesh/stream-replay-state.ts` `peerVersion` / `rejectStaleNodeStream`, `apps/gateway/src/ws/canonical-gate.ts`) ends up with `stateFeedMode = 'unsupported'` and the toast `websocket.serverTooOld` = 「终端连接失败：Gateway 版本过低，请升级到 1.1.22 或更新版本。」 — wrong number, and it doesn't say *which* side/node is too old.

## Required changes
1. `CANONICAL_V11_MIN_PEER_VERSION` → `'1.1.23'`. Update every test/doc that pins the old value (grep `1.1.22` under packages/shared/src/ws-borsh, packages/ws-client, apps/gateway/src/ws, apps/gateway/src/mesh, apps/fe/tests/helpers (site-theme.ts reads the constant — fine), docs/ws-protocol/*, docs/terminal/*, docs/hub/*, CHANGELOG.md if it states the floor). Keep the `_dev` suffix handling.
2. Make the transport event `server-too-old` (`packages/ws-client/src/transport-types.ts`, emitted in `websocket-transport.ts` and `transport-message-decoder.ts`) carry **who** is too old and their version:
   - `side: 'gateway'` when the HELLO_S2C negotiated but lacked the capability/version (READY + unsupported path) — version = `client.serverVersion`;
   - `side: 'node'` when the gateway ERROR message matches `canonical-state-v1.1 required: node <ver> < <min>` (entry rejecting a stale node stream);
   - `side: 'client'` when it matches `...: client <ver> < <min>` (this browser is too old — e.g. a stale tab).
   Parse the version out of the message (add a shared parser next to `isCanonicalV11RequiredError` in `packages/shared/src/ws-borsh/canonical-version.ts`, with tests; keep the gateway-side formatters in `apps/gateway/src/ws/canonical-gate.ts` in sync — best: move the message *formatting* into the shared module too so both sides use one contract).
3. `packages/stores/src/tmux-event-router.ts` `'server-too-old'` handler: pick the i18n message by side, e.g.
   - node: 「节点 {{name}} 的 tmex 版本 {{version}} 过低，请升级到 {{minVersion}} 或更新版本。」 (name = the node runtime's node name if the stores runtime knows it — check `packages/stores/src/runtime.ts` / node runtime context for nodeId/name; if only the nodeId is available, show a short id; if nothing, omit the name clause);
   - gateway: 「Gateway 版本 {{version}} 过低，请升级到 {{minVersion}} 或更新版本。」;
   - client: 「网页版本过低，请刷新页面。」
   Add the keys under `websocket.*` in packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json (you own only the `websocket` sub-object), run `bun run build:i18n` at the repo root. Also make sure the toast is not re-fired in a loop on reconnect attempts (protocolFatal already stops reconnects for the ERROR path; check the READY+unsupported path does not spam on every visibility change — dedupe per connection if needed).
4. Tests: shared parser/formatter tests; ws-client decoder/transport tests for the three sides; stores router test for message selection; gateway canonical-gate tests for the new floor. Update existing expectations.
5. Docs: adjust the floor and the message contract in the ws-protocol/canonical docs you find referencing it (brief edits), and add a CHANGELOG.md entry under the unreleased/next version section if the file has one (look at the top of CHANGELOG.md for the format; version for this round is 1.1.24 — if there is no 1.1.24 section yet, create it following the existing style).

## Scope (files you own)
- packages/shared/src/ws-borsh/canonical-version.ts (+test), packages/shared/src/capabilities.ts only if needed
- apps/gateway/src/ws/canonical-gate.ts (+tests), apps/gateway/src/ws/index.ts and apps/gateway/src/mesh/stream-replay-state.ts ONLY for the message-formatting call sites
- packages/ws-client/src/transport-types.ts, websocket-transport.ts, transport-message-decoder.ts (+tests)
- packages/stores/src/tmux-event-router.ts (+test)
- i18n `websocket.*` sub-object in the three locale JSONs
- docs/ws-protocol/*, docs/terminal/*, docs/hub/* lines that state the floor; CHANGELOG.md (1.1.24 section only)
Other agents are editing apps/fe/src/pages/settings/**, packages/api-client, packages/app, apps/gateway/src/relay & mesh relay files in parallel — do not touch those.
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
