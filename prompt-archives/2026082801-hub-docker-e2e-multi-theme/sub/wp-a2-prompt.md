# WP-A2 — wire presets into terminal, panels and stores

## Scope (only these paths)
- `packages/stores/src/site.ts`, `packages/stores/src/ui.ts`, and their tests (`packages/stores/src/site-theme.test.ts`, `ui.test.ts`, add new tests as needed)
- `packages/terminal-ui/src/components/**` (`theme.ts`, `types.ts`, `Terminal.tsx`, `TerminalPreview.tsx`, `hooks/useTerminalBootSurface.ts`, tests)
- `packages/panels/src/device-console/device-console.tsx` (+ its hooks/sections under `packages/panels/src/device-console/` if the terminal theme is built there)
- `packages/panels/src/markdown/mermaid-block.tsx`

Another agent (WP-A1) is concurrently implementing `THEME_PRESET_META` / `resolveTerminalTheme` / new `THEME_PRESETS` in `packages/theme`. Code against the frozen interface. Until A1 lands, imports of `THEME_PRESET_META`/`resolveTerminalTheme` will fail tsc in your packages — that is expected; to verify your own work create a throw-away local shim ONLY inside your test files if needed, or simply wait and re-run at the end (poll `grep -c resolveTerminalTheme packages/theme/src/index.ts` every ~2 minutes; A1 usually finishes within 20–30 min). Final verification MUST be done against the real A1 code.

## Task
1. `packages/stores/src/ui.ts`: `themePreset: ThemePreset | null` stays; make the persisted value validated on rehydrate (`isThemePreset` else null) so stale ids from the removed design presets (`underground`, …) don't survive in localStorage.
2. `packages/stores/src/site.ts`: add `selectThemePreset(preset, fallbackAppearance?)` per the frozen interface; implement the rule "server-driven appearance change (setThemeFromS2C, fetchSettings result) with a mismatching preset appearance → themePreset = null". `updateTheme` itself (user action) must not reset the preset when called from `selectThemePreset`; but a direct `updateTheme('light')` while a dark preset is active should also clear the preset (appearance changed → preset no longer applies). Keep `applyThemePreset` side-effect consistent: the DOM attribute is currently applied by `ThemePresetSync` in `apps/fe/src/main.tsx` (out of your scope, it subscribes to `useUIStore().themePreset`, so just updating the store is enough).
3. Terminal: the terminal must receive the full `TerminalThemeColors` for the current (appearance, preset). Extend `TerminalTheme`/props so callers can pass either the legacy `'light'|'dark'` or a resolved colors object (backwards compatible — other call sites must keep compiling without change). `useTerminalBootSurface` must call `instance.setTheme(colors)` when the resolved colors change (preset switch at runtime), `TerminalPreview` should update live rather than recreate if feasible.
4. `device-console.tsx`: read `themePreset` from `useUIStore` alongside `theme` and pass `resolveTerminalTheme(theme, themePreset)` down.
5. `mermaid-block.tsx`: re-render on theme change (subscribe to `useUIStore` theme + themePreset instead of reading the DOM class once); pick mermaid `dark` vs `default` from the appearance.
6. Tests: stores (selectThemePreset, S2C mismatch reset, rehydrate validation), terminal-ui (theme resolution / setTheme called on change).

Write the final report to `prompt-archives/2026082801-hub-docker-e2e-multi-theme/sub/wp-a2-result.md`.
