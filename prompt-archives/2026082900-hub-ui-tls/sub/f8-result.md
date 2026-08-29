# F8 result — single source of truth for brand (logo + product name)

## What changed

New files

- `packages/shared/src/brand.ts` — `PRODUCT_NAME = 'tmex'`, `BRAND_LOGO_SRC = '/logo.png'`. Browser-safe, no imports. The constants had to live here (not in `apps/fe`) because `packages/stores` and `packages/panels` need the product name and cannot depend on the app.
- `apps/fe/src/components/brand.tsx` — `Brand({ className, size = 'md' | 'sm', showName = true, linkTo, linkComponent })` plus the exported hook `useBrandName()` and re-exports of `BRAND_LOGO_SRC` / `PRODUCT_NAME`. Renders `data-testid="brand"` (and `data-testid="brand-name"` for the name span).
- `apps/fe/src/components/brand.test.tsx` — fallback name, custom `siteName` from the site store, link wrapping, no-link, logo-only.
- `apps/fe/src/page-wrapper.tsx` — `PageWrapper` moved out of `main.tsx` verbatim, plus the new branding branch. Extraction was required to make the component testable: `main.tsx` runs the whole bootstrap (`createRoot`, `document.getElementById('root')`) at import time, so it cannot be imported from `bun test`.
- `apps/fe/src/page-wrapper.test.tsx` — `withSidebar=false` renders the brand and no sidebar trigger; `withSidebar=true` renders the trigger and no brand.

Modified

- `packages/shared/src/index.ts` — barrel re-export of the two constants; `packages/shared/src/index.test.ts` — export snapshot updated (that test locks the runtime export surface, so it fails without this).
- `packages/stores/src/site.ts` (`DEFAULT_SETTINGS.siteName`), `packages/stores/src/site-fallback.ts` (`getSiteNameFallback`) — now use `PRODUCT_NAME`.
- `packages/panels/src/device-console/page-title.tsx`, `packages/panels/src/device-console/use-device-console-effects.ts` — `settings?.siteName ?? PRODUCT_NAME`.
- `apps/fe/src/components/page-layouts/components/sidebar-title.tsx` — inline logo/name block replaced by `<Brand linkTo="/" linkComponent={NavLink} className="flex-1" />`. Layout, testids, `WsLatency`, theme menu, mesh-only nodes icon and settings icon unchanged; the `fetchSettings()` mount effect stays here.
- `apps/fe/src/components/page-layouts/components/sidebar-title.test.tsx` — new case asserting logo + product name + `href="/"`.
- `apps/fe/src/main.tsx` — `PageWrapper` removed (now imported from `@/page-wrapper`), unused imports dropped, console banner uses `PRODUCT_NAME`.
- `apps/fe/src/pages/settings/site-settings-form.ts` — `DEFAULT_SITE_NAME = PRODUCT_NAME` (last remaining product-name literal in the fe settings path).

After this change the only `'/logo.png'` literal in `apps/**` + `packages/**` (excluding `resources/fe-dist`) is `packages/shared/src/brand.ts`.

## Design decisions worth knowing

1. **`linkComponent` prop.** The sidebar must keep `NavLink` (it prefixes `/n/:nodeId` and closes the mobile drawer), but `NavLink` calls `useSidebar()`, which throws outside `SidebarProvider`. `/login`, `/account/security` and `/nodes` are mounted outside `NodeShell`, i.e. outside `SidebarProvider` — so `Brand` cannot pick `NavLink` on its own and the caller supplies it. Default is react-router's `Link`.
   Note the earlier assumption "no runtime on the sidebar-less pages" is wrong: `AppRoot` wraps the whole router in `RuntimeProvider` with the `self` runtime, so `useSiteStore` works everywhere; only the sidebar context is missing. `useBrandName()` still uses `useOptionalRuntime()` so the component also renders standalone (tests, future hosts).
2. **`Brand` never fetches settings.** `GET /api/settings/site` requires a session in mesh mode; calling it from the login page would 401 and the session interceptor would navigate to `/login` again, destroying the `next` query parameter. The brand therefore only reads the store; `SidebarTitle` keeps the `fetchSettings()` effect. Consequence: on a hard refresh of `/login` or `/nodes` the top bar shows `tmex` rather than a custom `siteName` until the shell loads settings.
3. **Top bar layout.** For `withSidebar=false` the brand replaces the sidebar trigger at the left of the header; the vertical separator before the page title is now rendered in both branches.

## Verification

```
cd apps/fe && bun test src/ && bunx tsc --noEmit -p .
cd packages/shared && bun test && bunx tsc --noEmit -p .
cd packages/stores && bun test && bunx tsc --noEmit -p .
cd packages/panels && bun test && bunx tsc --noEmit -p .
bunx biome check <changed files>
```

| package | baseline | after |
|---|---|---|
| apps/fe | 470 pass / 0 fail, tsc 0 | 459 pass / 2 fail, tsc 7 — all failures and all tsc errors are in `src/auth/session-key-store*`, `src/auth/use-session-key.ts` and `src/pages/LoginPage.tsx`, i.e. task F7's files while they were mid-edit. Nothing in my scope fails. |
| packages/shared | 344 / 0 | 344 / 0, tsc 0 |
| packages/stores | 257 / 0, tsc 1 | 257 / 0, tsc 1 (same pre-existing `host-services.test.ts` error) |
| packages/panels | 368 / 0 | 372 / 0, tsc 0 (extra tests come from a parallel task) |

`biome check` is clean on every file I touched except the pre-existing `useExhaustiveDependencies` warning in `main.tsx:81` (`StatusBarSync`), which is also present at `HEAD` (verified against `git show HEAD:apps/fe/src/main.tsx`).

## Coordination notes

- **brand.tsx was written twice by F7 while I worked.** The final file on disk is mine (constants from `@tmex/shared`, `useBrandName()` export, `size`/`showName`/`linkTo`/`linkComponent` props, `data-testid="brand"` / `"brand-name"`, plus `export default Brand`). F7's second draft had converged on the same prop names, so their `LoginPage` usage should compile unchanged; the commander should re-check that `brand.tsx` still contains `useBrandName` after F7 finishes.
- `packages/panels/src/device-console/*` is also listed as editable by F10 — my two edits there are one-line each (`'tmex'` → `PRODUCT_NAME` + one import line).

## Out-of-scope items left for others

- `apps/fe/src/auth/totp-uri.ts:56` (`issuer = 'tmex'`) and `apps/fe/src/pages/AccountSecurityPage.tsx:330` (`beginTotpSetup({ issuer: 'tmex' })`) still hardcode the product name as the TOTP issuer. `apps/fe/src/auth/**` belongs to F7, so I did not touch it. Suggested change: import `PRODUCT_NAME` from `@tmex/shared` in both places (the emitted `otpauth://` URI is byte-identical).
- `apps/fe/index.html` (`<title>tmex`, description, `/tmex.png`) and the gateway PWA manifest in `apps/gateway/src/api/system-routes.ts` remain hardcoded — static HTML and a server-generated manifest cannot consume the React constant. If a single source is wanted there too, the manifest route could import `PRODUCT_NAME` from `@tmex/shared` (the gateway already depends on it); `index.html` would need a vite `define`/transform.
- `packages/panels/src/device-management/device-form.ts` uses `'tmex'` as the default **tmux session name**, not as branding; left alone on purpose.
