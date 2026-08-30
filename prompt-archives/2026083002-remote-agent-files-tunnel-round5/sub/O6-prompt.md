# Task O6 — Full i18n sweep: untranslated strings + "pane" → "terminal" wording

Read `common-rules.md` in this directory first (ground rules; you MAY run `bun run build:i18n` yourself).

## Scope (files you own)
- packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json — ALL sub-objects (you are the only agent editing these JSONs in this batch, except O7 who ADDS a few new keys under a new `header`/tooltip sub-object it names in its report — do not delete keys you do not recognise; re-read the file before each edit).
- Any component/page file that contains hard-coded user-visible English/Chinese strings (in apps/fe/src, packages/panels/src, packages/terminal-ui/src, packages/ui/src) — but ONLY the string-literal lines (replace with `t('…')`); do not restructure. Another agent (O7) edits the header/toolbar components of the terminal page (top-left/top-right icon buttons, the command input box) — if a hard-coded string lives in those components, list it in your report instead of editing.
- Tests that assert on copy.

## Requirements
1. Systematic scan: (a) for every key, compare zh_CN/ja_JP values against en_US — values that are identical to English (and are not proper nouns / technical tokens like "tmux", "SSH", "WebSocket", "Hub", "Cloudflare", "OTP", "HTTPS", "URL", "ID", "Agent" when used as a product word — see item 3) are untranslated; translate them. (b) grep components for JSX text / `title=` / `placeholder=` / `aria-label=` / toast strings that are literals instead of `t()`; move them to locale keys (three languages). Write a small script in your scratch dir to do the comparison, and put the resulting table (key, before, after) in your report.
2. Wording: the product word "pane" is replaced by "terminal" in COPY ONLY (not in code identifiers, routes, paneId, data-testids, or API field names): zh_CN "Pane"/"pane"/"窗格" → "终端", en_US "pane" → "terminal", "panes" → "terminals", "Pane" → "Terminal"; ja_JP "ペイン" → "ターミナル". Beware of collisions where "terminal" already means the tmux device/window ("终端" is already used for the terminal page/tab) — read each string and keep it unambiguous (e.g. "在所选终端中" is fine; "终端页" stays). Similarly ensure "agent" is rendered as "智能体" in zh_CN wherever it is a common noun ("Agent 会话" → "智能体会话"), and "file(s)" as "文件".
3. Keep tone consistent with mature large-scale software: concise, no exclamation marks, Chinese punctuation in zh_CN, polite plain Japanese (です/ます) in ja_JP.
4. After editing run `bun run build:i18n`, then `cd packages/shared && bun test` (key parity test), then panels / fe / terminal-ui test suites + tsc; fix tests that asserted the old copy.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r5/prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/O6-result.md
