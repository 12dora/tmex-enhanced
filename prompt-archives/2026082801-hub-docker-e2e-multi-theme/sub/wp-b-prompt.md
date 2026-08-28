# WP-B — frontend: theme picker menu in sidebar, remove dark-mode switch, i18n, e2e specs

## Scope (only these paths)
- `apps/fe/src/main.tsx`
- `apps/fe/src/components/page-layouts/components/sidebar-title.tsx` (+ a new component file next to it, e.g. `theme-menu.tsx`)
- `apps/fe/src/pages/settings/general-settings-tab.tsx`, `apps/fe/src/pages/settings/site-settings-form.test.ts` (only if it breaks)
- `apps/fe/tests/settings.spec.ts`, `apps/fe/tests/theme-broadcast.spec.ts`, `apps/fe/tests/theme-notify-2031.spec.ts`, `apps/fe/tests/theme-propagation.spec.ts`, `apps/fe/tests/ws-borsh-theme-resize.spec.ts` (update selectors/flows; do NOT run them)
- `packages/shared/src/i18n/locales/en_US.json`, `zh_CN.json`, `ja_JP.json`, then run `bun run build:i18n` (regenerates `resources.ts`/`types.ts` — commit-ready, never hand-edit or lint them)
- Nothing in `packages/theme`, `packages/stores`, `packages/terminal-ui`, `packages/panels`, `packages/ui` — other agents own those. `packages/ui/src/components/dropdown-menu.tsx` (Base UI Menu) is to be REUSED as is.

Other agents are concurrently implementing the frozen interface (`THEME_PRESET_META` etc. in `packages/theme`, `selectThemePreset` in `packages/stores`). Code against it; if tsc fails on those imports early on, poll (`grep -c selectThemePreset packages/stores/src/site.ts`, `grep -c THEME_PRESET_META packages/theme/src/index.ts`) and re-verify at the end against the real code.

## Task
1. Sidebar (`sidebar-title.tsx`): replace the Sun/Moon toggle button with a theme menu. Trigger: same 8×8 icon button styling, icon = `Palette` (lucide) — or Sun/Moon reflecting current appearance with a small indicator; keep `aria-label`/`title` = t('settings.theme'). `data-testid="theme-menu-trigger"`, plus `data-theme-preset` (current preset id or "") and `data-theme-appearance`. Menu = `DropdownMenu` + `DropdownMenuRadioGroup` with items: "Light" (`theme-option-light`), "Dark" (`theme-option-dark`), a separator, then all `THEME_PRESETS` in registry order (`theme-option-<id>`), each row showing a 3-color swatch from `THEME_PRESET_META[id].preview` plus the label (brand name, not translated) and a small light/dark hint. Light/Dark call `selectThemePreset(null, 'light'|'dark')`; presets call `selectThemePreset(id)`. Current selection: preset if set, else the appearance. Menu should work on mobile sidebar too (Base UI handles positioning; check `PaneSwitcherMenu.tsx` for a usage example).
2. `main.tsx`: keep `applyInitialTheme`/`applyInitialThemePreset` (they run before React mounts) but validate the persisted preset with `isThemePreset` (already does). Also make sure the `<meta name="theme-color">` sync effect (`ThemeColorSync`, ~line 75–92) re-runs when `themePreset` changes.
3. Settings → General: remove the dark-mode switch block (`general-settings-tab.tsx:98–109`) and now-unused imports/state. Do not add a picker there.
4. i18n: `settings.theme` → "Theme" / "主题" / "テーマ"; remove `settings.themeLight`/`settings.themeDark` ONLY if no other file references them (grep the whole repo excluding generated files; the sidebar currently uses them for aria — you are replacing that). Add keys you need (e.g. `settings.themeLight`/`themeDark` may simply stay for the two default items, `settings.themeMenuAppearanceLight`/`…Dark` hints). Keep all three locales in sync, then `bun run build:i18n`.
5. e2e specs: they currently click `settings-theme-toggle` on the settings page. Rewrite the flows to open the sidebar menu (`theme-menu-trigger`) and pick `theme-option-dark`/`theme-option-light`. Keep assertions about `.dark`, background colors, WS frames unchanged. Do not run Playwright.
6. Unit tests in `apps/fe/src` (`bun test src/`) must stay green; add a small test for the menu if there is an existing component-test pattern (check `apps/fe/src/**/*.test.tsx`).

Write the final report to `prompt-archives/2026082801-hub-docker-e2e-multi-theme/sub/wp-b-result.md`.
