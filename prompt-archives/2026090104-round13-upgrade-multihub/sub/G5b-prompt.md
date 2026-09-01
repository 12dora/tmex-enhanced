# G5b — CLI `hub allow|disallow`, `hub standby` prints node id, docs update for the authorized-hub allowlist

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it strictly. Then read `sub/G5-prompt.md`, `sub/G5-result.md`, `sub/RV3-result.md` (blocker 1) and `sub/G3b-prompt.md` (the hub-side change you are complementing).

## Background

Security review found that any authenticated node could advertise itself as a hub and take over the writer role. The hub side now only accepts hub advertisements from node ids listed in the new env `TMEX_HUB_PEERS` (comma-separated 32-hex node ids of the *other* authorized hubs). Operators need a CLI to manage that list and the docs must describe the new two-step flow.

## Requirements

1. `tmex hub allow <nodeId> [<nodeId>...]` — on a `hub,node` install: validate 32-hex, add to `TMEX_HUB_PEERS` (de-dup, keep order), restart the service unless `--no-restart`. `tmex hub disallow <nodeId>` removes. Both print the resulting list. Refuse on non-hub installs.
2. `tmex hub standby ...` (existing) must print, at the end, the local node id and the exact command to run on the active hub: `tmex hub allow <thisNodeId>` (and say the standby is ignored until that is done). `tmex hub promote` must warn if `TMEX_HUB_PEERS` is empty (a promoted hub that authorizes no peers can never be fenced by the old writer — fine — but also the old writer must have this hub in its list; print the reminder).
3. `tmex hub list` — add a column `authorized` (yes if the id is in the local `TMEX_HUB_PEERS` or is self).
4. Runtime wiring (`packages/app/src/runtime/assemble.ts`): pass `hubPeers: gatewayConfig.hubPeers` into the mesh runtime config if `MeshRuntimeConfig` exposes such a field by the time you get there (check `apps/gateway/src/mesh/mesh-runtime.ts` `MeshRuntimeConfig`; the hub side reads `authorizedHubIds` from `config.hubPeers ?? gatewayConfig.hubPeers`, so if the mesh config has no field, nothing to do — say so).
5. Docs `docs/hub/2026090104-multi-hub-standby.md`: update 操作手册 with the allowlist step (standby → prints id → active runs `tmex hub allow` → standby appears in `hubs[]`), the `TMEX_HUB_PEERS` key, the security rationale (why an allowlist is required under the "any single compromised point only affects itself" model, and that phase 2 should move authorization into a user-signed `admit-hub` key-log record), and the restart-after-fencing behaviour (a fenced hub stays standby across restarts until explicitly promoted). Keep 简体中文 + 中文标点.

## Tests

Extend `packages/app/src/commands/hub.test.ts` for allow/disallow (validation, de-dup, refusal on non-hub, `--no-restart`), the standby hint output, list column. `cd packages/app && bun test src && bunx tsc --noEmit -p .` (1 pre-existing error) and `bun run build:cli`.

## Files you own

`packages/app/src/commands/hub.ts` (+test), `src/cli/help.ts`, `src/lib/args.ts` (+test), `src/lib/install.ts` (additive env helper), `src/i18n/index.ts` (messages), `src/runtime/assemble.ts` (+test) for item 4 only, `docs/hub/2026090104-multi-hub-standby.md`. Do NOT touch `apps/gateway/**`, `packages/shared/**`, `apps/fe/**`, `docs/hub/2026082800-hub-node-operations.md` (another agent adds the env line there).

## Result file

`/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/G5b-result.md`. Write it, then exit.
