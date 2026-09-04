# T2b — UI language must follow the saved/site language and the browser language on first paint (web + PWA)

Result file: /Users/konata/code/tmex-r26/prompt-archives/2026090403-round26-pwa-login-localtab/sub/T2b-result.md

## Scope (files you may edit)
- apps/fe/src/i18n/index.ts (+ new tests next to it), apps/fe/src/main.tsx (bootstrap only), apps/fe/src/main.test.ts
- packages/stores/src/site.ts, packages/stores/src/site-settings-loader.ts, packages/stores/src/site-language.test.ts (+ new tests)
- apps/fe/src/components/page-layouts/components/sidebar-title.tsx is owned by ANOTHER agent — do not edit it. Do not edit LoginPage, standalone-landing, packages/ui.

## Symptom
On https://tmexhub-sh.jiefakj.com (installed PWA and normal web) the UI comes up in English on a Simplified-Chinese device although the site language saved in Settings is zh_CN; only after opening the Settings page does it switch to Chinese.

## Diagnosis (already done — verify quickly, then fix)
- `apps/fe/src/i18n/index.ts:39-57` `detectBrowserLocale()` only reads `navigator.language` (not `navigator.languages`) and falls back to `en_US`.
- The saved site language lives server-side (`GET /api/settings/site`, `packages/api-client/src/site.ts:21`); the store applies it via `i18next.changeLanguage()` in `packages/stores/src/site.ts:101` — but that request is only issued after the first paint by `SidebarTitle` (`sidebar-title.tsx:23` useEffect) and by the Settings page form (`use-site-settings-form.ts:82/:127`).
- `packages/stores/src/site-settings-loader.ts:94-104`: when the settings request fails (401 before login, transient network error in the PWA, relay hiccup), the loader COMMITS the English default (`DEFAULT_SETTINGS.language = en_US`) — so a failed first request actively switches a Chinese browser to English until the Settings page succeeds.
- No localStorage cache of the language exists.

## Required behaviour
1. `resolveInitialLanguage()` (pure, exported, tested) with priority: (a) last-known site language cached in localStorage (`tmex.site.language` or similar; wrap every access in try/catch) → (b) `navigator.languages` in order, matching `zh*`→zh_CN, `ja*`→ja_JP, `en*`→en_US, else the manifest default. Apply it in `apps/fe/src/i18n/index.ts` initialisation so the FIRST render (login page included) is already in that language.
2. When the site settings load succeeds, apply the server language AND write it to the localStorage cache. When the site settings load FAILS, do NOT downgrade to `en_US`: keep the currently resolved language (only commit non-language defaults, or leave the store's `language` untouched). Keep the existing self/remote-node isolation semantics (`site-language.test.ts`) intact.
3. Make sure the language is applied before the root `createRoot` render in `main.tsx:380` (it already awaits the translation chunk; ensure the resolved language's chunk is what's awaited).
4. Web and PWA must share exactly this path (no `display-mode: standalone` special-casing).
5. Tests: `navigator.languages` matching; cache-over-browser priority; failure does not override; success writes cache; store test for "load failure keeps language". Keep `bun test src/` in apps/fe and `bun test` in packages/stores green.

Baselines: apps/fe `bun test src/` 2137/0, tsc 0; packages/stores `bun test` 418/0, tsc 1 error (a known test typing issue in host-services.test.ts, being fixed by another agent — ignore it).
