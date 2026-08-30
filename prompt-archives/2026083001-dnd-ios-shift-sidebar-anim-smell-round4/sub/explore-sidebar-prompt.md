You are a read-only code explorer for a Bun + React monorepo (tmex). Do NOT modify files. Write a concise technical markdown report to stdout with file:line references.

Topic: the left sidebar in `apps/fe/src/components/page-layouts/` (app-sidebar.tsx, sidebar-node-section.tsx, sidebar-device-list*.tsx, nav-main.tsx, sidebar-agent-sessions.tsx, use-sidebar-agent-sessions.ts) and how it changes when the user switches between terminal windows of different nodes (routes like `/n/:nodeId/...` vs self routes; see `NodeRuntimeBoundary`, `useRouteNodeId`, `RootLayout` in apps/fe/src). The sidebar already uses framer-motion / `motion` somewhere (check `packages/ui` and existing `motion`/`AnimatePresence` usages in apps/fe and packages/panels for the established animation vocabulary, durations, easings and any `useReducedMotion` handling).

User complaint: when switching between terminal windows belonging to different nodes, the sidebar content changes abruptly ("stiff") — sections appear/disappear, the active node section expands/collapses, lists re-render with no transition. They want elegant, sensible animation.

Please find out:
1. Precisely which sidebar parts change on a node switch (which node section is highlighted/expanded, which device list / agent-session list is shown, remote vs self differences, header/title), and what triggers those changes (route param, store, query). Identify whether components are unmounted/remounted (keys, conditional rendering) or just re-rendered with different props.
2. What animation primitives already exist in the repo (framer-motion version, existing `AnimatePresence`, `layout` props, CSS transitions in tailwind config, the `motion` wrappers in packages/ui) and the conventions used elsewhere (e.g. side panels, dialogs, device page).
3. Whether the sidebar has existing tests that would constrain a change (sidebar-device-list.test.tsx, sidebar-title.test.tsx, e2e specs under apps/fe/e2e that touch the sidebar).
4. Propose a concrete, minimal animation design: which elements get `layout` animation, which get enter/exit (`AnimatePresence` with `initial={false}` on mount), height/opacity transitions for expanding node sections, stagger or not, suggested durations/easings consistent with the codebase, reduced-motion fallback, and any pitfalls (layout thrash with virtualized lists, `key` choices so that the list doesn't remount on every switch, scroll position preservation).

Keep the report under ~250 lines.
