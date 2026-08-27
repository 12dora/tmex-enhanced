# Task C5-3 — CLI wiring left over from C5-1 / C5-2

Context: `sub/c5-1-result.md` "协调者必须接线" items 1–3 and `sub/c5-2-result.md` "指挥官 / 其他 agent 必须接的钩子". Files: `packages/app/src/**`.

1. `packages/app/src/cli-node.ts`: delegate to `main()` from `src/index.ts` (keep the file as the bundle entry; make sure `build:cli` still works — check `packages/app/scripts/*` / `package.json` for the entry reference). Verify that auth commands load install env before importing gateway `config`/`crypto` (already designed that way in `index.ts` — add a test that `dispatchCli(['hub','user','add', ...])` with a temp install dir does not evaluate gateway config with an empty `TMEX_MASTER_KEY`).
2. `packages/app/src/i18n/index.ts`: `cli.help` for en/zh-CN now comes from `cli/help.ts` — make `t('cli.help')` and the new help one source of truth (either remove the old key and route through `cliHelpText`, or generate it). Update tests.
3. `packages/app/src/types.ts` `InitConfig`: add `role`, `hubUrl`, `hubPublicUrl`, `peerPort`, `stunServers` as the shared type; `commands/init.ts` uses it.
4. `commands/init.ts`: after the runtime is deployed, `if (shouldEnableDirectForRoles(role)) await enableDirect({ installDir })` (non-fatal, logs result); `commands/upgrade.ts`: after `deployRuntimeFiles`, `await reenableDirectIfNeeded({ installDir })`; `lib/install.ts` `writeRunScript`: export `TMEX_NATIVE_DIR=<installDir>/native`. Tests with fakes (no network).
5. `hub join` prints the reminder about opening `TMEX_PEER_PORT` on the LAN firewall (design §5) — add if missing.

File scope: `packages/app/src/**` except `runtime/**` and `commands/direct.ts`. Acceptance: `cd packages/app && bun test src` green (baseline 140), tsc ≤ 1, biome clean. Result: `prompt-archives/2026082701-hub-multinode-design/sub/c5-3-result.md`.
