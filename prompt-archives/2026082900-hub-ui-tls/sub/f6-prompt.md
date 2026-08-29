# Task F6 — Copy rewrite for every hub/node-facing screen (three locales)

Goal (user's words): "重写 hub/node 页所有文案，使文案简洁专业易懂，就像大型软件里的文案一样；删除冗余/啰嗦文案。例如'join 串'，普通用户就很难看懂。"

Scope of screens: Settings → Nodes tab (`nodes.machine.*`, `nodes.setup.*`, `nodes.https.*`), the Nodes page (`nodes.*` incl. columns/status/reach/actions/enrollment/rename/revoke/badge), `settings.tabGroup.nodes`, `sidebar.nodes`, the login page and account-security page namespaces (find them in the locale files: `login.*`, `account.*`/`security.*` or whatever they are named), and any hub/node related toasts/errors. Locale sources: `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json`. Keys must stay unchanged (only values); if a key is unused you may leave it.

Rules:
- Write like a mature product (think GitHub / Tailscale / 1Password settings pages): short sentences, one idea per string, no hedging, no implementation jargon (no "join 串", "SPKI", "keylog", "uplink", "redeem", "PoP", "epoch", "self-admit", "enrollment"), no explaining internals unless the user must act on it. Prefer verbs on buttons ("Add node", "Install add-on", "Copy join code").
- Glossary — define and apply consistently across all three languages; put the table at the top of your result file:
  hub → en "hub" / zh "中枢" (or "Hub" if you judge the loanword reads better — decide and be consistent) / ja 「ハブ」; node → "节点"/「ノード」; join token → en "join code" / zh "加入码" / ja 「参加コード」; enrollment → "adding a node" / "添加节点"; direct add-on → "direct connection add-on" / "直连插件"; self-signed private CA → "private certificate authority (CA)" / "私有证书颁发机构（CA）"; passkey → "passkey"/"通行密钥"/「パスキー」; TOTP → "authenticator code" / "验证码（TOTP）".
- Chinese: 简体中文（中国大陆）, 中文标点, 专业口吻; Japanese: natural です・ます body, noun-ending labels.
- Help texts: keep only what changes a user's decision (e.g. "Needs a public HTTPS address"); cut everything else. Long paragraphs → at most two short sentences.
- Error messages: state what happened and what to do next, ≤ 2 sentences.
- Preserve interpolation placeholders (`{{name}}` etc.) and pluralization keys exactly.
- Do not touch keys outside the hub/node/login/account-security surfaces (general settings, terminal, files, agent, etc. are out of scope).

After editing run `bun run build:i18n` from the repo root. Then run `cd apps/fe && bun test src/` — tests that assert on exact copy may fail; update only the string expectations in those tests (files under `apps/fe/src/pages/**`, `apps/fe/src/components/**`), never the behaviour under test.

Scope (files): the three locale JSON files, generated i18n via the script, apps/fe test files whose string assertions you must update. Nothing else.
Baseline: apps/fe `bun test src/` 470/0 tsc 0; packages/shared 344/0.
Result: `prompt-archives/2026082900-hub-ui-tls/sub/f6-result.md` — include the glossary, a before/after sample of ~10 representative strings per language, and the test numbers.
## Ground rules (apply to every task)

- Repo: /Users/konata/code/tmex-enhanced-wt-merge (branch chore/merge-hub-tabs). Bun monorepo (Bun 1.3.14); NOT Node-compatible. If `bun` is not on PATH, `source ~/.zshrc`.
- Other agents are editing this same worktree IN PARALLEL. Touch ONLY the files/directories listed in your scope. If you believe you need to change a file outside your scope, do not edit it — describe the needed change in your result file instead.
- NEVER run any git command that changes state (no add/commit/stash/checkout/reset). Read-only git (status/diff/log) is fine. The commander commits.
- NEVER touch the production tmex service (launchd, port 9883, ~/Library/Application Support/tmex/) nor the tmux session named `tmex`. Do not run e2e (Playwright). Any ad-hoc server you start must use a scratch DB and ports in 20000-29999 and must be killed before you finish.
- Never lint/format generated files: packages/shared/src/i18n/resources.ts, types.ts, resources/fe-dist/*, dist/*. i18n: edit the three locale JSON sources, then run `bun run build:i18n` from the repo root.
- Code comments only where logic is non-obvious. Variable names in standard English. No TODOs, no stubs, no "simplified version" — finish the task fully. Do not restructure unrelated code.
- Verify before finishing: inside each package you touched run `bun test` (apps/fe: `bun test src/`), `bunx tsc --noEmit -p .` (error count must not exceed the baseline given to you), and `bunx biome check <changed files>`. macOS has no `timeout` command. Strip ANSI when parsing test summaries: `sed 's/\x1b\[[0-9;]*m//g'`.
- Follow the exploration report(s) given to you; if the code differs from the report, trust the code and note the discrepancy.
- Write your final report (English, markdown) to the result path given: what you changed (file list), how to verify, test/tsc numbers before/after, open issues, and any out-of-scope changes you need from others. The result file is the completion signal — write it last.
