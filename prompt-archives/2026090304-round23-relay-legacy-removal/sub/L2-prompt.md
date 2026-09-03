# Task L2 — replace `tailwind-merge` with a tiny in-repo class merger (Opus 子代理，Agent 工具 model: opus)

Read /Users/konata/code/tmex-r23/prompt-archives/2026090304-round23-relay-legacy-removal/sub/_common-rules.md FIRST and obey every rule (other agents edit the same worktree in parallel; touch only your scope; no git; write the result file last).

Result file (absolute): /Users/konata/code/tmex-r23/prompt-archives/2026090304-round23-relay-legacy-removal/sub/L2-result.md

Goal: drop the `tailwind-merge` dependency (≈94 KB rendered, ~7.7 KB gzip in the FE entry bundle) without visual regressions. `cn()` is defined once in packages/ui/src/utils.ts as `twMerge(clsx(inputs))` and used at ~195 call sites (packages/ui 98, packages/panels 74, terminal-ui 1, apps/fe 22). Callers DO rely on conflict resolution ("later class wins within a conflict group"), e.g. packages/ui/src/utils.test.ts cn('p-2','p-4') === 'p-4'; card.tsx:73; select.tsx:13,101,135; sheet-impl.tsx:94-124; sidebar/sidebar-primitives.tsx:14,25,36,47,72,131; sidebar/sidebar-menu.tsx:16,27,73,165,201; dialog-impl.tsx:79,112; tabs.tsx:16,46; dropdown-menu-impl.tsx:231; packages/panels code-viewer.tsx:74,81; markdown-preview.tsx:107,170; streaming-markdown.tsx:185,243; agent/chat-thread.tsx:191,201; apps/fe SettingsPage.tsx:160; agent-session-row.tsx:83,95.

## Scope
- packages/ui/src/utils.ts, packages/ui/src/utils.test.ts, new packages/ui/src/class-merge.ts (+ test)
- packages/ui/package.json: remove `tailwind-merge` dependency ONLY. Do NOT run bun install / touch bun.lock (commander does).
- Nothing else; do not edit call sites.

## Approach
1. Build an empirical conflict corpus (throwaway script in your scratch dir): grep every `cn(` call site across packages/ui, packages/panels, packages/terminal-ui, apps/fe, extract literal class lists and caller classNames where feasible; list which Tailwind utility groups actually collide (padding/margin/gap/width/height/size, text colour vs text size vs alignment, bg, border colour/width, rounded, flex/grid, position, display, overflow, opacity, shadow, ring, z-index, variants `hover:`/`data-[state=open]:`/`sm:`, arbitrary values, negatives, `!important`).
2. Implement `mergeClassNames(input: string): string`: split, dedupe, resolve conflicts via an explicit tested group table keyed by (variant chain, group), replicating tailwind-merge's documented conflict semantics (`p` clears earlier px/py/pt/…, later `px` after `p` keeps both; `mx` vs ml/mr; `inset` vs top/right/bottom/left; `rounded` vs rounded-t/…; border width vs colour; `size` vs w/h; `gap` vs gap-x/gap-y; `space-x`; text size vs colour vs align). Arbitrary values, negative prefix, `!` prefix, any number of variant prefixes. Unknown classes pass through in order.
3. Verify against tailwind-merge still in node_modules (dynamic import, skip if missing): equality on (a) the corpus, (b) ≥150 hand-written tricky cases, (c) 2 000 random combinations from the corpus token set. Fix every plausible divergence; document the rest.
4. Switch `cn` to `mergeClassNames(clsx(inputs))`, remove the dependency, extend utils.test.ts.
5. class-merge.ts ≤600 lines. `bun test` packages/ui (baseline 110), `bunx tsc --noEmit -p packages/ui`, biome, `bun run lint`.

Result file: group table, case counts, known divergences, visual-check list (Settings tabs, dialog/alert-dialog/sheet/dropdown/select, sidebar & device/file tree, agent chat/markdown/code viewer, TerminalPreview, mobile sidebar/node badges/agent session row).
