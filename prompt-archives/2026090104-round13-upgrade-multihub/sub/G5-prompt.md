# G5 — CLI + runtime wiring + operations doc for multi-hub (active/standby)

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it strictly. Then read `prompt-archives/2026090104-round13-upgrade-multihub/plan-00.md` (§目标 3), `sub/G1-result.md`, `sub/G2-result.md`, `sub/G3-result.md` (they define the config keys `TMEX_HUB_MODE / TMEX_HUB_PRIORITY / TMEX_HUB_WRITER_EPOCH / TMEX_HUB_URLS`, `MeshHubStore`, `MeshRuntime.onNodeList(...)`, `HubRuntime.applyReplicatedNodeList(...)`, `HubRuntimeOptions` additions). Background: `docs/hub/2026082800-hub-node-operations.md`.

Note: `packages/app` is the npm `tmex-cli` package. Its **CLI** (`src/commands/**`, `src/cli/**`, `src/lib/**`) must stay Node.js-compatible (built with `bun build --target node`); the **runtime** (`src/runtime/**`) runs on Bun.

## Requirements

### A. Runtime wiring — `packages/app/src/runtime/assemble.ts` (and siblings under `src/runtime/` if the composition lives elsewhere)

1. Construct `MeshHubStore` once per process and pass it to both `HubRuntime` (options) and `MeshRuntime` (config/deps) per G2/G3 results.
2. Pass `mode/priority/writerEpoch/hubNodeId` from gateway config into `HubRuntimeConfig`.
3. Wire `meshRuntime.onNodeList((list, meta) => hubRuntime.applyReplicatedNodeList(list, meta))` when both roles run in-process; unsubscribe on shutdown.
4. Startup log line: `[hub] mode=<active|standby> priority=<n> writerEpoch=<n> publicUrl=<url>`.

### B. CLI — `packages/app/src/commands/hub.ts` (+ `src/cli/help.ts`, `src/lib/args.ts`, `src/types.ts` as needed)

Look at how `hub join` writes `app.env` keys and restarts the service (`src/lib/install.ts` helpers, service control in `src/lib/service.ts`) and reuse those helpers. New subcommands (all local, require an existing install; print 简体中文 like the other commands — follow existing i18n/lang handling if the CLI has it):

- `tmex hub standby --public-url <https-url> [--priority <n>]` — on an **already joined node**: set `TMEX_ROLES=hub,node`, `TMEX_HUB_MODE=standby`, `TMEX_HUB_PUBLIC_URL=<url>`, `TMEX_HUB_PRIORITY=<n|200>`, keep `TMEX_HUB_URL` (seed = current primary), then restart the service. Refuse if the node is not joined (no `node_identity`) or already `hub,node` with `active` mode (tell the user to `demote` first). Validate the URL is https (or http only with an explicit `--allow-insecure` like existing commands, if such a flag exists — otherwise https only).
- `tmex hub promote` — on a `hub,node` install: set `TMEX_HUB_MODE=active` and `TMEX_HUB_WRITER_EPOCH = max(current env value, max(mesh_hubs.writer_epoch)) + 1` (read `mesh_hubs` from the local sqlite DB the way other commands open the DB read-only; if unreadable fall back to env+1), print a red warning that the previous writer must be demoted/stopped first (split-brain), require `--yes` or interactive confirmation, restart the service.
- `tmex hub demote` — set `TMEX_HUB_MODE=standby`, restart.
- `tmex hub list` — print a table of `mesh_hubs` (node id short, name, mode, priority, writerEpoch, publicUrl, online, lastSeen) from the local DB, marking the writer (`pickWriterHub` logic; you may reimplement the tiny ordering rule locally to stay Node-compatible rather than importing gateway code).

Keep `hub join` behaviour unchanged (single seed URL); nodes learn other hubs from `node.list`.

### C. Docs — new `docs/hub/2026090104-multi-hub-standby.md` (简体中文, 中文标点, 面向初级工程师但专业简洁)

Sections: 背景（单 hub 的单点问题）、目标与非目标（第一阶段：主/备、单写者、有序 failover、复制；不做自动选主/多 primary/hub 间 relay/浏览器按 RTT 选 hub）、拓扑图、数据同步机制（key log/证书靠既有 catch-up；注册表由 `node.list` 投影；hub 集合 `mesh_hubs`；不复制 enrollment token）、故障切换与切回策略（阈值、make-before-break、generation 守卫）、写入围栏（`HUB_NOT_WRITER`、epoch 围栏、脑裂告警）、操作手册（standby/promote/demote/list 命令、主 hub 恢复前先 demote 的规则）、兼容性（旧节点忽略新字段/legacy encoder）、验收清单、已知限制。Also add a short cross-link paragraph in `docs/hub/2026082800-hub-node-operations.md` (部署矩阵 or 常见排障) pointing to the new doc.

## Tests (TDD)

`packages/app`: extend `src/commands/hub.test.ts` (or create one following neighbours) for the four subcommands (env writes, refusals, epoch computation, `--yes`), args/help parsing tests. Runtime wiring: if `assemble` has tests, extend them; otherwise a small unit test that the wiring passes the store/callbacks (mock runtimes).

Baselines: `cd packages/app && bun test src` (record before/after), `bunx tsc --noEmit -p .` → currently 1 pre-existing error (do not add more); also `bun run build:cli` must still succeed (Node target).

## Files you own

- `packages/app/src/runtime/assemble.ts` (+ tests), other `src/runtime/*` only for wiring
- `packages/app/src/commands/hub.ts` (+ test), `src/cli/help.ts`, `src/lib/args.ts`, `src/types.ts`, `src/lib/install.ts` only for additive env helpers
- `docs/hub/2026090104-multi-hub-standby.md`, cross-link lines in `docs/hub/2026082800-hub-node-operations.md`

Do NOT touch `apps/gateway/**`, `packages/shared/**`, `apps/fe/**`.

## Result file

`/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/G5-result.md` — commands/flags shipped, env keys written, wiring summary, test/tsc/build results. Write it, then exit.
