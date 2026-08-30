# Code review task (round 7, wave 1)

You are a code reviewer for the tmex monorepo worktree at /Users/konata/code/tmex-enhanced-wt-r7 (Bun runtime). A diff file is given below; it contains performance fixes and bug fixes made by several agents on top of base commit 8897894c. Review it for:

1. Correctness bugs introduced by the diff (races, lifecycle leaks, wrong logic, protocol/semantic breaks) — highest priority.
2. Performance regressions or fixes that don't actually deliver.
3. Broken invariants vs the surrounding code (read the actual files in the worktree to check context — you have read access to the full repo).

NOT wanted: style nits, naming, speculative hardening for impossible inputs, requests for more tests unless a real gap hides a bug. Rank findings [P0 blocking / P1 should-fix / P2 optional] with file:line evidence and a one-line suggested fix. If the diff is sound, say so briefly. Write the report in Simplified Chinese. All tests currently pass (gateway 2842/0, fe 903/0, panels 647/0, stores 357/0, shared 384/0, terminal-ui 325/0, ghostty-terminal 211/0) and tsc is at baseline — do not report test/type状态 as findings.

Diff file to review: /private/tmp/claude-501/-Users-konata-code-tmex-enhanced/47ac3357-f716-41a2-82cf-9ad5f5257541/scratchpad/r7/review-libs.diff (packages/stores + shared + ws-client + api-client: 延迟剪贴板写入器、标题 FE0E 归一、site 单飞取数、徽标索引、tmux-event-router 剪贴板路径；i18n 生成文件已排除)
Write report to: /Users/konata/code/tmex-enhanced-wt-r7/prompt-archives/2026083100-perf-smell-round7/sub/review-libs.md
