You are a senior code reviewer (read-only). Repo: current directory (Bun + React + TypeScript monorepo). Review the uncommitted frontend change set for the "hub/node graphical entry + built-in HTTPS UI" feature.

Inputs:
- Diff: /private/tmp/claude-501/-Users-konata-code-tmex-enhanced/aa9de10f-9bbe-4a6a-8bda-48566133bc05/scratchpad/review-frontend.diff (apps/fe, packages/api-client, en_US locale). Read the full files in the repo when the diff lacks context.
- Design/contract: prompt-archives/2026082900-hub-ui-tls/plan-00.md, sub/api-contract-batch1.md, sub/api-contract-batch2.md
- Task specs/results: sub/f1-prompt.md, f1-result.md, f2-prompt.md, f2-result.md, f3-prompt.md, f3-result.md
- Existing conventions: sub/explore-frontend.md

Focus, in priority order:
1. Correctness bugs: wrong API paths/bodies vs. the contracts, state bugs (stale closures, missing invalidation, polling leaks/unmount), error mapping, restart-wait logic (startedAt comparison), navigation after restart, wizard validation gaps that let bad input through or block valid input.
2. Regressions in existing behaviour: the NodesPage → NodesManagement extraction (compare to git HEAD version of NodesPage.tsx — any dropped prop, effect, cleanup, or i18n key?), sidebar-title spacing/visibility, SettingsPage tab wiring.
3. Security/UX: secrets (Cloudflare token, passwords) not logged/persisted client-side; CA download link correctness; anything that could brick the user's instance (e.g., disabling the only listener) without warning.
4. Duplication worth collapsing: three restart-poll implementations exist (setup/use-restart-waiter.ts, local-machine-card.tsx inline, https/use-restart-now.ts) — propose the minimal consolidation.
5. Tests: what is untested that matters.

Output (markdown, English): a table of findings with severity (blocker / major / minor / nit), file:line, one-paragraph rationale, concrete fix. Then a short "what is fine" section. Do not pad; do not flag style-only issues; do not propose defensive code for impossible states.
