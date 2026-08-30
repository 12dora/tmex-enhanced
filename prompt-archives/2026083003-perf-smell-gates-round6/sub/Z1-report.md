# Exploration Z1 — Round 3 Verification Report

Compared BASE `19dd4992` with HEAD `47888267` using Bun 1.3.14. All existing benchmarks were rerun; HEAD-only benches were reproduced against BASE with inline harnesses. No repository files were modified.

## Benchmark comparison

All values are milliseconds; canonical-state and snapshot-diff rows were converted from `µs/op`. `*` means HEAD is more than 10% slower.

| Benchmark / scenario | BASE | HEAD | Ratio |
|---|---:|---:|---:|
| render bridge — full update | 1.940 | 1.864 | 0.96× |
| render bridge — single dirty row | 1.152 | 0.137 | 0.12× |
| render bridge — 20% dirty rows | 1.175 | 0.280 | 0.24× |
| render bridge — clean frame | n/a | 0.015 | n/a |
| write-vt — legacy bytes | 11.71 | 17.21 | 1.47×* |
| write-vt — scratch bytes, current path | 11.50 | 12.29 | 1.07× |
| write-vt — legacy string | 12.81 | 16.22 | 1.27×* |
| write-vt — scratch string, current path | 11.00 | 10.98 | 1.00× |
| write-vt — allocation overhead | 0.94 | 0.91 | 0.97× |
| write-vt — coalesced ×10 | 10.28 | 10.29 | 1.00× |
| canonical validation — PaneData64 reader | 0.001100 | 0.000856 | 0.78× |
| canonical validation — 4 KiB reader | 0.000134 | 0.000116 | 0.87× |
| canonical validation — 31 KiB reader | 0.000119 | 0.000120 | 1.01× |
| canonical validation — 16 subscriptions reader | 0.001847 | 0.001726 | 0.93× |
| canonical validation — invalid payload reader | 0.000138 | 0.000135 | 0.98× |
| legacy snapshot diff — 4×4 | 0.001512 | 0.000829 | 0.55× |
| legacy snapshot diff — 10×8 | 0.002369 | 0.003417 | 1.44×* |
| legacy snapshot diff — 20×10 | 0.005058 | 0.005490 | 1.09× |
| legacy snapshot diff — 40×16 | 0.007145 | 0.006428 | 0.90× |
| history paging — legacy pure path | 200.3 | 188.6 | 0.94× |
| history paging — batched pure path | 37.2 | 44.0 | 1.18×* |
| history paging — real Ghostty per-page | 509.5 | 528.4 | 1.04× |
| history paging — real Ghostty batched | 44.0 | 45.9 | 1.04× |
| agent thread — legacy | 75.2 | 74.2 | 0.99× |
| agent thread — cached | 67.8 | 8.7 | 0.13× |
| normalization — bare LF current path | 160.1 | 7.4 | 0.05× |
| normalization — CRLF current path | 98.1 | 8.1 | 0.08× |

The >10% results are not actionable product regressions:

- The write-vt regressions are in diagnostic legacy allocation paths; the current scratch string path is unchanged and scratch bytes are only 7% slower.
- Canonical deserialize diagnostics also varied substantially for tiny inputs, while the new reader path improved. The existing deserialize implementation was not changed.
- The 10×8 snapshot-diff and pure history results have no corresponding production-path change; real Ghostty history replay is within 4%.
- WASM accessor microbenchmarks varied by 27–46%, but the absolute difference was approximately 4–16 ns.

## Unit and type-check verification

All nine unit suites passed:

| Package | Result |
|---|---|
| `packages/shared` | 376 passed, 0 failed |
| `packages/ws-client` | 268 passed, 0 failed |
| `packages/stores` | 334 passed, 0 failed |
| `packages/panels` | 617 passed, 0 failed |
| `packages/terminal-ui` | 323 passed, 0 failed |
| `packages/ghostty-terminal` | 198 passed, 0 failed |
| `packages/ui` | 47 passed, 0 failed |
| `packages/api-client` | 132 passed, 0 failed |
| `apps/fe` | 880 passed, 0 failed |

Type checking matches the stated baseline:

- Pass: shared, ws-client, panels, terminal-ui, ghostty-terminal, ui, apps/fe.
- Baseline error count: stores 1, api-client 5.
- No new TypeScript errors were observed.

## Findings

### HIGH — Large Markdown files can freeze the frontend during automatic language detection

File: [packages/panels/src/markdown/markdown-preview.tsx:135](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/markdown/markdown-preview.tsx:135), invoked by [apps/fe/src/pages/FilePage.tsx:222](/Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/pages/FilePage.tsx:222)

`MarkdownPreview` enables `rehype-highlight` with `detect: true`. Untyped code blocks therefore call synchronous `lowlight.highlightAuto`, testing the text against many grammars during React rendering. A direct benchmark using the installed versions measured 10.24 seconds for a 1 MiB untyped block; the gateway accepts Markdown/text files up to 2 MiB at [apps/gateway/src/files/categorize.ts:5](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/files/categorize.ts:5).

Fix: disable automatic detection for large or untyped blocks, while retaining explicit fenced-language highlighting. A size-aware gate matching the existing 64 KiB CodeViewer threshold preserves small-block convenience; the simplest one-token fix is setting `detect: false`.

Expected gain: removes the measured ~10-second main-thread stall for a 1 MiB untyped block.

Risk: globally disabling detection removes heuristic highlighting for unlabeled short fences.

Estimated net LOC: −1 for global disable, or approximately +10–25 for a size-aware implementation.

### MEDIUM — The 200-block chat window removes older content from browser find and anchors

Files: [packages/panels/src/agent/chat-thread.tsx:198](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/agent/chat-thread.tsx:198), [packages/panels/src/agent/chat-thread.tsx:220](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/agent/chat-thread.tsx:220)

Only `blocks.slice(hidden)` is rendered, with a default window size of 200. The existing test confirms that with 500 messages, older content is absent from the DOM until “Show earlier” is clicked. This changes behavior from BASE: browser find-in-page cannot find older messages, and any DOM-based message anchor outside the active window cannot resolve.

Fix: add a target-expansion API for application search and deep-link anchors so the requested block is loaded before scrolling. If native browser find must remain supported, retain a lightweight searchable text index or avoid removing older text entirely.

Expected gain: restores search/deep-link behavior without affecting the normal bounded render path.

Risk: jumping to a very old target may temporarily mount many rows and must preserve scroll position.

Estimated net LOC: approximately +15–30.

### MEDIUM — Lazy chunk rejection has no local retry boundary

Files: [apps/fe/src/pages/SettingsPage.tsx:37](/Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/pages/SettingsPage.tsx:37), [apps/fe/src/pages/SettingsPage.tsx:187](/Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/pages/SettingsPage.tsx:187), [apps/fe/src/pages/FilePage.tsx:225](/Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/pages/FilePage.tsx:225)

The new Settings tabs and Markdown preview use `React.lazy` with `Suspense`, which correctly handles slow pending downloads. However, these boundaries handle loading only; the repository has no local `ErrorBoundary` around these nested imports, so a transient chunk 404 or failed network fetch bubbles out instead of offering retry. Existing tests cover successful lazy resolution, not rejected imports.

Fix: wrap these lazy regions in a small error boundary with retry/reload behavior, or use a retrying dynamic-import helper. Add one rejected-import test for Settings and Markdown.

Expected gain: recover from stale-cache and transient chunk failures without breaking the current page.

Risk: retrying a permanently missing deployment chunk can loop unless capped.

Estimated net LOC: approximately +25–50.

## Checks that are already fine

- Input echo: [useTerminalInput.ts:58](/Users/konata/code/tmex-enhanced-wt-r6/packages/terminal-ui/src/components/hooks/useTerminalInput.ts:58) sends keystrokes synchronously; the 4 ms coalescer only handles inbound output.
- Zero-copy output: decoder tests confirm views retain the WebSocket frame buffer, and pending unmounted output is explicitly copied.
- Dirty-row isolation: two render states sharing a terminal handle retain independent row caches; the probe produced the expected unequal snapshots.
- History ordering: [TerminalSurface.ts:178](/Users/konata/code/tmex-enhanced-wt-r6/packages/terminal-ui/src/components/TerminalSurface.ts:178) flushes history before live output; ordering tests pass.
- Lazy loading on slow networks: Settings and FilePage show Suspense fallbacks, and successful delayed-resolution tests pass.
- Device removal: device status subscriptions reconcile against the current device list and remove stale entries.
- Multi-node history budget: active sessions on two nodes are protected by the eviction tests.
- Agent cache correctness: delta updates create new segment objects, so the WeakMap cache does not retain stale mutable results.
- CodeViewer large-file guard: known-language and unknown-language paths are bounded before expensive highlighting.

After this round, one HIGH-value frontend hotspot remains: Markdown automatic language detection. The remaining chat-window and lazy-import issues are MEDIUM. The explicitly deferred canvas batching, DataChannel double copy, scrollback budget, locale first paint, and directory virtualization items are not re-reported.