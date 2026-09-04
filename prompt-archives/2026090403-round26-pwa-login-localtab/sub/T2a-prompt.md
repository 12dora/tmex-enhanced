# T2a — login page: no prefilled username; PWA first-open focus on the sidebar close button

Result file: /Users/konata/code/tmex-r26/prompt-archives/2026090403-round26-pwa-login-localtab/sub/T2a-result.md

## Scope (files you may edit)
- apps/fe/src/pages/LoginPage.tsx, apps/fe/src/pages/LoginPage.test.tsx (and any pure helper you extract next to it)
- apps/fe/src/components/standalone-landing.tsx (+ test), apps/fe/src/lib/standalone.ts / standalone.test.ts
- apps/fe/src/components/page-layouts/components/sidebar-title.tsx (+ test)
- packages/ui/src/components/sidebar/sidebar-layout.tsx, packages/ui/src/components/sheet-impl.tsx ONLY if you need to thread an `initialFocus` prop through (keep the change minimal and backwards compatible)
Do NOT touch apps/fe/src/i18n/*, apps/fe/src/main.tsx, packages/stores (another agent owns them).

## Bug A — username prefilled with a UUID
`LoginPage.tsx:202` does `useState(mode.username ?? '')`. On nodes that joined a mesh via `tmex relay join`/`hub join`, the backend stores the key-log genesis uid (a UUID) as the user's `username`, so the login form is prefilled with a UUID. The product decision: the username field must have NO default value, ever. Implement:
1. Initial state `''` — never prefill from `mode.username`. Keep `autoComplete="username"` so the browser's own autofill still works.
2. `resolveLoginUid(mode, username)` (`:188`): the protocol identity is `mode.uid`. Return `mode.uid` when: the typed username is empty, OR `mode.username` is null/empty, OR the typed username equals `mode.username`, OR `mode.username === mode.uid`. Otherwise return the typed username (multi-user future). A backend agent is concurrently changing `/api/auth/mode` to return `username: null` when the stored name is the uid, so handle both.
3. The required-fields check at `:250` must allow an empty username when `mode.uid` exists (password still required). Make sure the error message path for a genuinely missing identity is still correct.
4. Update `LoginPage.test.tsx` (currently asserts the prefill `alice` at :87): assert the field is empty on mount, that submitting with an empty username uses `mode.uid`, that typing a different name when `mode.username` is null still uses `mode.uid`, and that typing the real username still works. Add a small pure-function test for `resolveLoginUid`.

## Bug B — PWA cold start focuses the "close sidebar" button (blue focus ring top-left)
Chain: `apps/fe/src/components/standalone-landing.tsx:31` calls `setOpenMobile(true)` on mobile standalone launch at `/`; the mobile sidebar is a Base UI Sheet (`packages/ui/src/components/sidebar/sidebar-layout.tsx:44-51`) whose first tabbable element is the close button in `sidebar-title.tsx:31`, and Base UI Dialog moves focus to the first tabbable on open. Fix:
1. Keep the product behaviour "PWA launch at `/` opens the sidebar so the user sees the device list" but suppress the focus move for that automatic open only: thread an `initialFocus={false}` (Base UI Popup prop; check the installed `@base-ui-components/react` version in node_modules for the exact prop name/semantics — read the source, don't guess) through `SheetContent`/`Sidebar` for the auto-open case, OR blur the focused element right after the auto-open in `StandaloneLanding` (`requestAnimationFrame` + `document.activeElement.blur()` if it is inside the sidebar). Prefer the `initialFocus` route if the prop exists; manual opens must keep normal focus management.
2. `sidebar-title.tsx:13` close button: add `outline-none focus-visible:ring-2 focus-visible:ring-ring` (match the project's `Button` component classes at `packages/ui/src/components/button.tsx:7`) so a focus ring only shows for keyboard navigation.
3. Tests: extend `standalone.test.ts` / `standalone-landing` tests (happy-dom, `matchMedia` mocked to mobile) to assert that after the auto-open `document.activeElement` is `document.body` (or at least not the close button), and a test that a manual open does not pass `initialFocus={false}`.

Baselines: `cd apps/fe && bun test src/` = 2137 pass / 0 fail; `bunx tsc --noEmit -p .` in apps/fe = 0 errors; packages/ui `bun test` 370/0.
