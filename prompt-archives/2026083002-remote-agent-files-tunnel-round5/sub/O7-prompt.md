# Task O7 — Terminal page header: command input box animation + tooltips on all icon buttons

Read `common-rules.md` in this directory first (ground rules; you MAY run `bun run build:i18n` yourself).

## Scope (files you own)
- The terminal page header/toolbar components: find them (start from packages/panels/src/device-console/device-console-toolbar.tsx, terminal-stage.tsx, and apps/fe/src/components/page-layouts/components/sidebar-title.tsx / nav-main.tsx; also the layout header in apps/fe/src/components/page-layouts/**). List every file you touch in the report.
- packages/ui/src/** if the Tooltip primitive needs a small extension (check what exists first — there is a Tooltip in @tmex/ui; the device card uses it).
- packages/theme/src/motion.css / @tmex/ui/motion only if you need a new keyframe (prefer existing `--tmex-motion-*` tokens; see docs on motion in `packages/theme`).
- i18n: ADD keys only, in a new sub-object you name (e.g. `translation.toolbar.*`) or existing per-component objects; three locales; another agent (O6) is editing the same JSON files for a wording sweep — make targeted edits (do not rewrite files), re-read before each edit, and never delete keys.

## Requirements
1. Command input box: clicking the top-right icon expands a command input (find it). Entering and leaving currently snaps with no transition. Add an elegant, fast animation consistent with the app's motion language (`packages/theme/src/motion.css`, `--tmex-motion-fast`/`--tmex-motion-base` tokens, `motion-reduce:` variants): expand = width/opacity + slight translate, ~150–200 ms ease-out; collapse = reverse, ease-in; input receives focus after opening; Escape closes; no layout jump of the neighbouring buttons (animate a wrapper with fixed final width, or use grid-template-columns 0fr→1fr). Honour `prefers-reduced-motion`.
2. Tooltips: every icon-only button in the top-left and top-right areas of the terminal page (and of the sidebar header if it has icon-only buttons) gets a hover/focus tooltip with a short title (2–4 words, product-grade: e.g. 「分栏」「新建窗口」「命令」「切换侧栏」「主题」「全屏」…). Use the existing Tooltip primitive from @tmex/ui with a consistent delay (e.g. 400 ms) and placement (bottom for top bars). Also make sure each such button has an `aria-label` equal to the tooltip text. Do not add tooltips to buttons that already show a text label.
3. Tests: a rendering test that every icon button in the header exposes an aria-label / tooltip content (static render), and a small test for the command box open/close state (class names or data-state).
4. Verify: panels / fe / ui tests + tsc + biome.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r5/prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/O7-result.md
