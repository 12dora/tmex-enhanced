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

# Task G1 — bulk reorder API for file roots (gateway)

Owned files: `apps/gateway/src/api/file-root-routes.ts`, `apps/gateway/src/db/file-roots.ts`, and their test files (`*.test.ts` next to them; create if missing). Nothing else.
Result file: `/Users/konata/code/tmex-enhanced/prompt-archives/2026083102-relay-files-switch-lan-round9/sub/G1-result.md`

## Context
File roots (`file_roots` table) already have a `sortOrder` column and `GET /api/files/roots` orders by it (`apps/gateway/src/db/file-roots.ts:13`). `PATCH /api/files/roots/:id` accepts `sortOrder` one at a time. The frontend sidebar will get drag-to-reorder and needs a bulk endpoint, mirroring the existing device reorder: `PUT /api/devices/order` with body `{ deviceIds: string[] }` (see `apps/gateway/src/api/devices*.ts` / `apps/gateway/src/db/devices.ts:193` `reorderDevices` for the pattern, including how unknown ids and partial lists are handled and how it is tested in `apps/gateway/src/db/device-order.test.ts`).

## Deliverable
1. `PUT /api/files/roots/order` with JSON body `{ rootIds: string[] }`:
   - Validates body (array of non-empty strings, no duplicates) → 400 `INVALID_BODY` style consistent with the other file-root routes in this file.
   - Rewrites `sortOrder` in one transaction: listed roots get 0..n-1 in the given order; roots not listed keep relative order after them (same semantics as device reorder — check and match). Unknown ids are ignored (do not 404 the whole request) — but if *no* id matches, return 400.
   - Response: `{ roots: FileRootDto[] }` in the new order (reuse the existing list/projection helper used by `GET /api/files/roots`).
   - Same auth middleware as the sibling routes.
2. `reorderFileRoots(ids)` in `apps/gateway/src/db/file-roots.ts` with unit tests (transaction, partial list, unknown ids, stable ordering of unlisted roots).
3. Route test (request → 200 body order, 400 on bad body).

Run `bun test` in `apps/gateway` before and after; report counts.
