# EX4: e2e baseline failure root-cause analysis (read-only)

You are a read-only code explorer for the tmex monorepo. Playwright e2e specs live in `apps/fe/tests/`. Do NOT modify files or run the e2e suite. Output your FULL report as your final message.

## Goal

Five e2e cases fail on main (pre-existing baseline failures, NOT regressions). For each, statically analyze the spec + the product code it exercises, determine the most likely root cause, and propose a fix (fix the test if the expectation is stale; fix the product if it's a real bug). Cases:

1. `apps/fe/tests/sidebar-resize.spec.ts:40` — mobile sheet test; waits for a 'Toggle Sidebar' button for 90s and times out. Likely the accessible name/testid changed. Find what renders the sidebar toggle on mobile today.
2. `apps/fe/tests/mobile-mouse-reporting.spec.ts:205` — single-finger drag produces no motion events. Analyze the touch → mouse-reporting pipeline (ghostty/terminal input handling) and what the spec simulates; decide whether product regressed or the simulation no longer matches the input pipeline.
3. `apps/fe/tests/agent-session.spec.ts:404` — "running session enqueues further messages": times out waiting for `agent-chat-send` to become enabled/stable. Inspect the agent chat send-button enabled/disabled state machine and what the test does.
4. `apps/fe/tests/settings-llm.spec.ts:42` — inspect the spec and current settings-LLM UI; identify the stale selector/flow.
5. `apps/fe/tests/ws-borsh-theme-resize.spec.ts:39` — "cols drift 3 >= 2" style failure; inspect the resize/measure logic and the spec's tolerance; decide whether tolerance should widen or measurement is buggy.

## Output

Per case: spec excerpt (short), product-side anchors (file:line), root-cause verdict (test-stale vs product-bug vs flaky-timing, with confidence), and a concrete minimal fix plan. Note any cases needing a live run to confirm (they will be run separately). Also list which product files the fixes would touch, to plan file ownership across parallel agents.
