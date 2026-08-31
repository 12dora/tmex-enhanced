## Ground rules (read fully)

- Repo: Bun + TypeScript monorepo `tmex` (gateway `apps/gateway`, frontend `apps/fe`, shared packages under `packages/*`). Work ONLY inside the worktree `/Users/konata/code/tmex-enhanced-wt-r9` (branch `feat/round9-relay-files-perf`). `bun` is at `~/.bun/bin/bun` (add to PATH if missing). Everything runs on Bun, never Node.
- Several other agents are editing this same worktree concurrently. Touch ONLY the files listed in your "Owned files" section (plus new test files next to them). If you believe you must edit a file outside your scope, do NOT edit it — describe the needed change in your result file instead.
- Do NOT run any git command that changes state (no add/commit/stash/checkout/reset). Read-only git (log/blame/diff) is fine. The commander commits.
- NEVER touch the production tmex service (launchd, port 9883, `~/Library/Application Support/tmex/`) and NEVER run tmux commands on the default socket or against a session named `tmex`. Any tmux you need for tests must use an isolated socket (`tmux -L tmex-r9-<yourid>`).
- Do not run the dev server (`bun run dev`) and do not run Playwright e2e. Unit tests only: inside the package dir run `bun test` (for `apps/fe` use `bun test src/`). Before editing, record the baseline pass/fail counts of the packages you touch and `bunx tsc --noEmit -p .` error count; after editing, counts must not regress. Bun test summary lines carry ANSI colors — strip with `sed 's/\x1b\[[0-9;]*m//g'`. macOS has no `timeout` command.
- Run `bunx biome check <changed files>` (no `--write` on files you don't own; never lint generated files such as `packages/shared/src/i18n/resources.ts`, `types.ts`, `dist/*`).
- i18n: locale files are `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`. Edit only the sub-object assigned to you, keep all three languages in sync, then run `bun run build:i18n` at the repo root to regenerate `resources.ts`/`types.ts`. Copy rules for zh_CN (from `/Users/konata/code/tmex-copy-guidelines.md`, read it before writing copy): say 「本机」 not 「这台机器」, avoid 「你」, one short sentence per line, state before static explanation, qualifiers in parentheses, English buttons in Title Case.
- No unnecessary code comments. No TODOs, no "simplified version", no leaving work for later — finish the whole task. Do not widen scope.
- When finished, write a concise report (what changed, file list, test/tsc before→after numbers, anything out of scope the commander must do) to the absolute path given in "Result file", then exit. The commander polls for that file.

# Task G3 — mesh direct-dial tuning + link diagnostics in `/api/mesh/nodes` (gateway)

Owned files: `apps/gateway/src/mesh/peer-manager.ts`, `apps/gateway/src/mesh/node-list-projection.ts`, `apps/gateway/src/mesh/mesh-routes.ts`, `apps/gateway/src/mesh/address-class.ts`, `apps/gateway/src/mesh/mesh-runtime.ts` (only the parts that build the node list / PeerLinkProvider), and their tests. Do NOT touch the borsh `NodeEvent` encoding, `uplink-*.ts`, `rtc/*`, frontend, or api-client.
Result file: `/Users/konata/code/tmex-enhanced/prompt-archives/2026083102-relay-files-switch-lan-round9/sub/G3-result.md`

## Context (verified by code reading)
- `PeerManager.dial()` (`peer-manager.ts:1303`) tries dc → ws-secure → existing → relay. `dialWsSecure()` (~`:1420`) iterates the peer's cached endpoints (`userStore.listPeers()[].endpointsJson`, e.g. `["ws://43.248.129.233:39001/peer","ws://172.17.0.1:39001/peer"]`) with `PEER_CONNECT_TIMEOUT_MS = 3000` each. Endpoints come from the peer's `os.networkInterfaces()` enumeration so they include docker bridges, IPv6 globals, etc. On a LAN with 3–4 advertised addresses the sequential 3s timeouts make the first useful direct link slow or lose to relay.
- `LivePeer` has `remoteAddress` (null for relay) and `rttMs`; `emitLinkInfo()` (~`:1907`) publishes `reach/transport/rttMs` via `onLinkInfo`. `classifyPeerReach` in `address-class.ts`.
- `GET /api/mesh/nodes` → `mesh-routes.ts:91 handleNodes → collectNodes` → `projectMeshListNode()` in `node-list-projection.ts:141` (DTO fields today: `id, name, online, reach, transport, rttMs, direct_capable, isHub, loggedIn…`). The `PeerLinkProvider` interface (used by mesh-routes, implemented in mesh-runtime around `:696–1000`) exposes `listReach/transportOf/rttOf`.
- Log prefix helpers: `rtcLog` in `rtc/rtc-log.ts` (don't edit; just use `console`/existing `[mesh]` logging in peer-manager).

## Deliverable
A. **Endpoint ranking**: before dialing, order the peer's endpoints: (1) hosts in the same subnet as one of this machine's non-internal interfaces (use `os.networkInterfaces()` netmask/cidr; inject the interfaces function like `mesh-runtime.ts` already does with `stores.interfacesFn()` so it is testable), (2) other private addresses (reuse `address-class.ts` helpers), (3) public, (4) IPv6 after IPv4 within each tier. Deterministic, pure function with unit tests.
B. **Concurrent ("happy-eyeballs") ws-secure dial**: dial all ranked endpoints concurrently with a small stagger (e.g. 250ms between starts, so the best-ranked one usually wins without racing everything at once); the first successful handshake wins; every losing/in-flight attempt must be aborted and its socket closed (no leaked sockets, no late handshake completing after a winner — use the existing generation/stop guards). Overall timeout stays bounded (per-attempt 3s). Preserve all existing security checks (`isTrusted`, transcript verification) untouched — only the scheduling changes. Unit tests: one endpoint hangs, another succeeds → success within ~stagger, loser aborted; all fail → falls back to relay as before; stop() during race cancels everything.
C. **Per-peer direct-attempt record**: keep an in-memory `lastDirectAttempt` per nodeId: `{ at: number; ws?: string | null; dc?: string | null; endpointsTried: string[] }` populated from the dial path: `ws` = short reason of the *last* ws-secure failure (e.g. `timeout ws://10.110.88.3:39001/peer`, `refused …`, `handshake: …`), `dc` = the dcError message (e.g. `datachannel open timeout`, or `datachannel unavailable` when native missing / `direct_capable=false` when peer not capable). Cleared to `null` fields when a direct (dc/ws-secure) link is established. Also keep `linkSinceAt` (epoch ms when the current live link was installed) on `LivePeer`.
D. **Expose via REST only** (do not change the borsh NodeEvent). Extend `PeerLinkProvider` with optional `linkDetailOf?(nodeId): { peerAddress: string | null; linkSinceAt: number | null; endpoints: string[]; directFailure: { at: number; ws?: string | null; dc?: string | null } | null }` and add these optional fields to the `/api/mesh/nodes` DTO (`projectMeshListNode`), null/empty for self. For relay links `peerAddress` = the hub host (the uplink's `hubHost` is available on the runtime/uplink client — pass it in via deps rather than importing uplink internals). Keep the DTO shape exactly:
```ts
peerAddress?: string | null;
linkSinceAt?: number | null;
endpoints?: string[];
directFailure?: { at: number; ws?: string | null; dc?: string | null } | null;
```
Tests: projection includes the fields; route returns them; existing tests unchanged.

Run `bun test` in `apps/gateway` before and after and `bunx tsc --noEmit -p .` (baseline is ~21 pre-existing errors; must not grow). Report counts.
