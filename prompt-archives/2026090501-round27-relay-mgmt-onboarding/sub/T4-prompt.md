## Shared rules for every coding agent (read fully)

- Repo: /Users/konata/code/tmex-r27 (git worktree, branch feat/round27-relay-mgmt-onboarding). Bun monorepo: apps/gateway (Bun HTTP/WS gateway), apps/fe (React 19 + Vite + Tailwind v4 + @base-ui/react wrapped in packages/ui), packages/app (npm `tmex-cli`: installer CLI + runtime that assembles gateway + relay), packages/api-client, packages/shared (i18n + types).
- Other agents are editing the SAME worktree in parallel. Touch ONLY the files listed in your scope. Do NOT run git add/commit/stash/checkout/reset. Do NOT run formatters over directories; `bunx biome check --write <your files>` only.
- Runtime is Bun only. Tests: `bun test <path>` (in apps/fe use `bun test src/<path>`; never bare `bun test` there — it picks up Playwright specs). Type check: `bunx tsc --noEmit -p <package dir>`. Do not run e2e (Playwright).
- i18n: zh_CN is the source language at packages/shared/src/i18n/locales/zh_CN.json; en_US.json and ja_JP.json must get the same keys. NEVER edit packages/shared/src/i18n/resources.ts or types.ts (generated); after changing locale JSON run `bun run build:i18n` from the repo root (it regenerates them; that is expected). Edit only the sub-objects you own; other agents edit other sub-objects of the same JSON files — keep edits surgical (no reformatting, no key reordering).
- Copy style (very important, user demand): concise, professional, easy to understand, like copy in large mature software (macOS System Settings / GitHub / Tailscale). No chatty explanations, no second person (no 你/您/your), no filler. One short sentence per hint. Chinese uses full-width punctuation. Terms: 本机 (this machine), Hub, 中继 (relay role), 租户 (tenant that joins a relay), 运营者 (relay operator), 加入码 (join code), 接入密码 (relay access password). Long explanations go into tooltips, not inline text.
- Code style: no unnecessary comments (only for genuinely non-obvious logic, in Chinese like the existing code), standard English identifiers, keep functions small (complexity gate: cyclomatic ≤ 15, files ≤ ~400 lines preferred). Follow existing patterns in neighboring files (Card/Badge/Button/DropdownMenu from @tmex/ui, data-testid attributes, `useTranslation`).
- Base UI gotcha: `DropdownMenuLabel` must be inside `DropdownMenuGroup` or the page crashes at runtime. Menus/Dialogs render in a portal: static render tests cannot see their content, so export the menu/dialog content as a plain component and test it directly (see existing `RelayActionsMenuList`, `BulkActionsMenuList`).
- Tests: keep existing tests green; update tests that assert on things you intentionally changed; add focused tests for new pure logic (sorting/filtering/formatting/state mappings). Do not delete tests to make them pass.
- When done, write a result report (Markdown) to the absolute path given in your task: what changed (files), tests run with counts, anything left undone or uncertain. Then exit.
- Never touch the production tmex install (~/Library/Application Support/tmex, port 9883) or the tmux session named `tmex`. Do not start dev servers.

# Task T4 — Remote Access: make "无边缘连接" actionable (frontend, Opus, small)

Result file (write when done, then exit): /Users/konata/code/tmex-enhanced/prompt-archives/2026090501-round27-relay-mgmt-onboarding/sub/T4-result.md

## Scope (exclusive)
- apps/fe/src/pages/settings/remote-access/** (tunnel-model.ts/.test.ts, status-card.tsx, remote-access-tab.test.tsx as needed)
- Locale JSON sub-object `settings.remoteAccess.*` ONLY (zh_CN/en_US/ja_JP).

## Facts (verified)
The status "无边缘连接" (`settings.remoteAccess.connector.noConnections`) is computed in tunnel-model.ts ~line 37 as `connector.reachable === true && (readyConnections ?? 0) <= 0` from `GET /api/tunnel/status` (backend reads cloudflared's local metrics `/ready` JSON). On the user's machine it was CORRECT: cloudflared is running but has zero edge connections because a local proxy (Surge) routes `*.argotunnel.com` through a policy that cannot reach port 7844 (direct IPs work). So the UI must (a) not mislead about what it knows and (b) tell the user what to check.

## Requirements
1. In tunnel-model.ts, only classify `noConnections` when `reachable === true` and `readyConnections` is a finite number equal to 0; a null/undefined count with reachable true → `unknown`. Update tests.
2. When the connector state is `noConnections`, the existing degraded Notice (`settings.remoteAccess.degradedNotice`: 隧道进程运行中，但无边缘连接，公网地址当前不可达。) gets a second, actionable line (new key, e.g. `degradedHint`): zh 「cloudflared 连不上 Cloudflare 边缘（TCP/UDP 7844）。请检查代理或防火墙是否放行 *.argotunnel.com 与 *.cftunnel.com。」 en "cloudflared cannot reach the Cloudflare edge (TCP/UDP 7844). Check that the proxy or firewall allows *.argotunnel.com and *.cftunnel.com." ja equivalent. Keep it to those two lines; no extra paragraphs.
3. If the payload has `connector.lastError`, show it (truncated, mono, muted) under the hint as today's patterns do for errors; check status-card.tsx for where connector rows render.
4. Tests for the model change and the notice rendering. biome on touched files; `cd apps/fe && bun test src/pages/settings/remote-access` 0 fail; no new tsc errors in your files. `bun run build:i18n` from repo root after locale edits.
