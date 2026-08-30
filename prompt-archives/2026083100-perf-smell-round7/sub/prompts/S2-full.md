# Code smell exploration (round 7, phase 2)

You are a read-only explorer for the tmex monorepo at /Users/konata/code/tmex-enhanced-wt-r7 (Bun runtime). Write your REPORT in Simplified Chinese, identifiers in English. This repo has had SIX prior smell-cleanup rounds — most big offenders are either fixed or DELIBERATELY RETAINED. A complexity gate (`bun scripts/complexity/gate.ts`, thresholds CC>15 / >120-line functions / >900-line files) runs in CI with `scripts/complexity/allowlist.json` locking ~118 known exemptions WITH documented reasons — read that file first and do NOT re-report anything already allowlisted unless you have a concrete, low-risk refactor that would actually remove the entry (not just move lines between files).

Known intentionally-retained (do not re-report): protocol flat dispatchers (emitOsc, encodeMouseEvent, classifySshError, control-mode parse, dispatchPaneStreamByte), dev scripts, parsers where syntax=branching (sanitizeBunPath, runInit, gesture-machine, createWatchRuleDraft, parseIpv6ToBytes, decodeLegacyStateSnapshotDiff), pure-conditional JSX (DeviceRow), cohesive large files (local-external-connection, agent/supervisor, canonical-feed-session, external-tmux-core, ws-client/state-machine, api/agent, messaging-routes, tmux-command-handlers, ws-client/client, sidebar-agent-sessions, agent-session-actions, tool-call-card, peer-manager, ghostty-wasm, uplink-server). SSH/local external-connection reconnect merging was explicitly rejected twice.

What IS valuable this round:
- functions that grew NEAR the thresholds recently (git log helps: changes from the last ~10 days), especially freshly-added code from rounds 6-7
- REAL duplication: same non-trivial logic maintained in 2+ places that can share one implementation without new abstraction layers
- mixed responsibilities that cause actual coupling pain (a change in X forces edits in Y), not aesthetic concerns
- dead code, unused exports, obsolete compat paths
- files that crossed 900 lines or entries where allowlist values are now far above actual (tightening opportunities — list file+current value)

Report format: ranked [HIGH/MED/LOW] items with file:line evidence, why it hurts, concrete refactor approach, risk; honest "nothing HIGH" if so. Section `## allowlist 收紧` listing entries whose current metrics are now below their locked values. Do not modify files.
## Scope: frontend — apps/fe/src/**, packages/panels/src/**, packages/stores/src/**, packages/terminal-ui/src/**, packages/ghostty-terminal/src/**, packages/ws-client/src/**, packages/ui/src/**. Write report to /Users/konata/code/tmex-enhanced-wt-r7/prompt-archives/2026083100-perf-smell-round7/sub/S2-report.md
