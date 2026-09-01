# C2 — Frontend packages: bring 3 complexity-gate violations back under the limits

Worktree: `/Users/konata/code/tmex-enhanced-wt-r11`. Bun-only. **Other agents edit `apps/fe/src/node/**`, `apps/fe/src/components/page-layouts/**`, `packages/panels/src/files/**` and gateway files concurrently. Touch only the files listed (+ new sibling modules + their tests). Never run git commands.** Report in English as your final message (< 250 words).

`bun scripts/complexity/gate.ts` (part of `bun run lint`) fails with these violations (read `scripts/complexity/` for the rules; do **not** add allowlist entries, fix the code):

```
packages/panels/src/device-console/use-pane-size-sync.ts:20 usePaneSizeSync: 126 lines > 124
packages/panels/src/device-tree/sidebar-device-list.tsx:53 SideBarDeviceList: 265 lines > 264
packages/stores/src/tmux.ts:32 createTmuxStore: 374 lines > 358
```

Fix by extracting cohesive pieces with no behaviour change:
- `use-pane-size-sync.ts`: pull a pure helper (e.g. the decision "should rebuild history / which geometry to apply") into `pane-size-sync-plan.ts` with a unit test.
- `sidebar-device-list.tsx`: extract a sub-hook or a small subcomponent (e.g. the DnD/reorder wiring or the visibility subscription effect) into a sibling file.
- `stores/src/tmux.ts` `createTmuxStore`: move a cohesive action group (e.g. the new viewport actions `setPaneViewport` + related, or the resize/sync-size actions) into `tmux-viewport-actions.ts` following the pattern of the other `*-actions.ts` files in `packages/stores/src` (check how `agent-session-crud-actions.ts` is composed into its store).

Verification (must pass): `bun scripts/complexity/gate.ts` reports none of the three above (gateway violations are handled by another agent — ignore them); `cd packages/panels && bun test` (baseline 715 pass / 0 fail) and `bunx tsc --noEmit -p .` 0; `cd packages/stores && bun test` (baseline 412 pass) and `bunx tsc --noEmit -p .` (1 pre-existing error in `host-services.test.ts` allowed); `cd apps/fe && bunx tsc --noEmit -p .` 0; `bunx biome check <touched files>` clean.
