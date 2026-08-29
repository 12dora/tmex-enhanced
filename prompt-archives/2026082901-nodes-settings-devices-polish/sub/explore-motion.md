# tmex Frontend Animation and Motion Inventory

> Output-file note: no output path was supplied, and this session is read-only. I could not persist a file; the complete report is provided below.

## 1. Existing tooling and conventions

### Dependencies and Tailwind

- Frontend dependencies include `tailwindcss-animate` and `tw-animate-css` at `apps/fe/package.json:50-54`.
- Only `tailwindcss-animate` is wired into CSS: `apps/fe/src/index.css:1-7`.
- `apps/fe/tailwind.config.ts:3-30` defines colors only; it has no `keyframes`, `animation`, or animation plugin configuration.
- Tailwind scans shared packages through `apps/fe/src/index.css:3-5`.
- No `framer-motion`, `motion/react`, `AnimatePresence`, `motion.*`, `useSpring`, or equivalent usage was found.
- `shadcn` exists as a CLI dependency/script at `apps/fe/package.json:13,50`, but the UI primitives import `@base-ui/react`, not Radix:
  - Dialog: `packages/ui/src/components/dialog.tsx:3`
  - Sheet: `packages/ui/src/components/sheet.tsx:3`
  - Tabs: `packages/ui/src/components/tabs.tsx:3`
  - Tooltip: `packages/ui/src/components/tooltip.tsx:1`

### Existing CSS animations

- Custom `scroll` keyframes and `--animate-scroll` are declared at `apps/fe/src/index.css:45-53`.
- Custom `pulse-dot` keyframes are declared at `apps/fe/src/index.css:55-65`.
- No in-repository consumer of `animate-scroll` or `pulse-dot` was found.
- Custom `bell-blink` is declared and consumed at `apps/fe/src/index.css:195-211`.
- `bell-blink` is used for pane notifications at `packages/panels/src/device-tree/pane-row-content.tsx:14-18` and `packages/panels/src/device-console/page-title.tsx`.
- The theme package contains design tokens but no animation or transition declarations:
  - `packages/theme/src/tokens.css:1-105`
  - `packages/theme/src/themes.css:1-791`
  - `packages/theme/src/index.ts:1-25`

### Existing utility patterns

- Popup enter/exit classes use `animate-in`, `animate-out`, `fade-in-0`, `fade-out-0`, `zoom-in-95`, `zoom-out-95`, and directional slide classes.
- Common durations are hard-coded:
  - `duration-100`: dialogs, menus, selects, tooltips.
  - `duration-150`: progress bars.
  - `duration-200`: sheets, sidebar layout, tabs.
  - `0.12s`: keyboard avoidance.
  - `300ms`: connection indicator.
- Existing utilities include `transition-all`, `transition-colors`, `transition-transform`, `animate-spin`, and `animate-pulse`.
- No shared motion constants, `motion.ts`, `<Reveal>`, stagger helper, or reduced-motion rule exists.
- No `prefers-reduced-motion`, `motion-safe`, or `motion-reduce` usage was found.

### Local motion implementations

- `ConnectionIndicator` has its own phase machine (`hidden`, `entering`, `visible`, `exiting`) and uses two `requestAnimationFrame` calls at `packages/panels/src/connection-indicator.tsx:7-46`.
- Its inline enter/exit motion is `transform` and `opacity` over `300ms` at `packages/panels/src/connection-indicator.tsx:53-66`.
- Keyboard avoidance uses inline `transform`/`height` transitions at `apps/fe/src/main.tsx:164-184`.
- Device-tree drag reordering receives a transition from `@dnd-kit` at `packages/panels/src/device-tree/device-tree-dnd.tsx:77-95`.

## 2. Surface inventory

| Surface | Current motion state | Concrete suggestion |
|---|---|---|
| Desktop sidebar collapse | Sidebar gap uses `transition-[width] duration-200 ease-linear`; container uses `transition-[left,right,width] duration-200 ease-linear` at `packages/ui/src/components/sidebar/sidebar-layout.tsx:77-110`. | Preserve the existing 200ms layout motion; add `motion-reduce:transition-none`. Do not animate while resizing. |
| Mobile sidebar | Mobile sidebar uses the shared Sheet with `animation="top-down"` at `packages/ui/src/components/sidebar/sidebar-layout.tsx:41-73`. | Keep the current top-down Sheet motion; standardize its duration through shared tokens. |
| Sidebar hover actions | Session menus fade via `transition-opacity` at `apps/fe/src/components/page-layouts/components/agent-session-row.tsx:48-63`. Sidebar action visibility changes opacity but only declares `transition-transform` at `packages/ui/src/components/sidebar/sidebar-menu.tsx:105-132`. | Add `transition-opacity duration-150` to hover-only action wrappers. |
| Sidebar collapsible groups | Chevron rotation exists at `apps/fe/src/components/page-layouts/components/nav-main.tsx:56-62`; `CollapsibleContent` itself has no motion at `packages/ui/src/components/collapsible.tsx:13-16`. | Add a subtle content fade/translate on open; validate Base UI panel behavior before attempting height animation. |
| Sidebar tab switching | `AppSidebar` conditionally mounts panes, agent, or files at `apps/fe/src/components/page-layouts/components/app-sidebar.tsx:35-80`; no content transition. | Wrap the active content in `<Reveal>` with a 150ms fade-up. Avoid animating the entire sidebar width. |
| Route/page transitions | Routes mount `PageWrapper` directly at `apps/fe/src/main.tsx:238-255`. Page content has no animation class at `apps/fe/src/page-wrapper.tsx:52-56`. Lazy loading only changes state at `apps/fe/src/use-page-module.ts:54-66`. | Add a short page-content fade for ordinary pages. Exclude or minimize it for terminal pages to avoid disrupting xterm content. |
| Settings tab bar | Settings uses controlled `Tabs` and six tab values at `apps/fe/src/pages/SettingsPage.tsx:38-123`. Triggers use `transition-colors duration-200` through `pillTabTriggerClassName` at `packages/ui/src/components/tabs.tsx:82-87`. | Keep the active-pill transition. Animate only the newly mounted panel with `<Reveal>`, not the tab bar. |
| Generic tab primitive | `TabsTrigger` has `transition-all` and an underline opacity transition at `packages/ui/src/components/tabs.tsx:56-68`; `TabsContent` has no animation at `packages/ui/src/components/tabs.tsx:72-79`. | Add an opt-in content motion class or let consumers use `<Reveal>`; avoid forcing animation on every tab consumer. |
| Dialogs | `DialogOverlay` and `DialogContent` use fade, zoom, `animate-in/out`, and `duration-100` at `packages/ui/src/components/dialog.tsx:26-55`. | Existing motion is appropriate. Centralize duration and add reduced-motion handling; do not add per-dialog variants. |
| Alert dialogs | Alert dialog overlay and popup use the same fade/zoom pattern at `packages/ui/src/components/alert-dialog.tsx:25-59`. | Reuse Dialog motion tokens and reduced-motion behavior. |
| Sheets | `SheetContent` supports `slide`, `fade`, `bottom-up`, and `top-down` at `packages/ui/src/components/sheet.tsx:38-56`; overlay motion is at `:26-33`. | Keep the existing API. Standardize durations and disable transforms under reduced motion. |
| Dropdowns/context menus/selects | Dropdown menus animate at `packages/ui/src/components/dropdown-menu.tsx:48-55,130-147`; context menus at `packages/ui/src/components/context-menu.tsx:21-47`; selects at `packages/ui/src/components/select.tsx:57-93`. | These are the strongest existing motion surfaces. Normalize timing/easing only; avoid adding item-by-item animations. |
| Tooltips | Tooltip popup uses fade, zoom, and directional slide classes at `packages/ui/src/components/tooltip.tsx:26-61`; provider delay defaults to `0` at `:5-14`. | Add a fast shared duration and reduced-motion override. Consider a small nonzero delay only if hover density becomes distracting. |
| Popovers | No standalone `packages/ui/src/components/popover.tsx` was found. A custom diagnostic popup is conditionally rendered without motion at `apps/fe/src/node/device-node-badges.tsx:101-132`. | Either migrate the custom popup to a shared primitive or add `animate-in fade-in-0 zoom-in-95 duration-100` locally. |
| Toasts | `ThemedToaster` uses Sonner with `duration: 6000` at `apps/fe/src/main.tsx:96-120`; notification calls are centralized in `apps/fe/src/lib/sonner-notification-sink.ts:17-30`. | Let Sonner own toast enter/exit motion. Apply reduced-motion globally rather than duplicating toast CSS. |
| Transfer toasts | Transfer content is rendered inside Sonner at `packages/panels/src/files/transfer-toast.tsx:56-87`; progress width uses `transition-[width] duration-150` from `packages/ui/src/components/progress.tsx:7-13`. | Keep progress interpolation; do not animate each progress update or add a second toast transition. |
| Device list cards | Device management switches between loading, error, empty, and card-grid branches at `packages/panels/src/device-management/device-management-panel.tsx:123-174`. Cards have no enter/exit motion. | Use a one-time staggered reveal for initial cards only. For removal animation, introduce deferred removal/presence state rather than a CSS-only class. |
| Device tree rows | `DeviceRow` conditionally mounts `DeviceWindowList` without height/opacity motion at `packages/panels/src/device-tree/device-row.tsx:24-37`. Window creation and row hover use color transitions at `packages/panels/src/device-tree/device-window-list.tsx:27-46` and `window-row-header.tsx:42-52`. | Animate only expansion content with a short reveal. Avoid layout animation during live tmux updates. |
| Device-tree reorder | Sortable rows use `transform` and the dnd-kit-provided `transition` at `packages/panels/src/device-tree/device-tree-dnd.tsx:77-95`. | Preserve dnd-kit geometry motion. Add no independent transition that could conflict with drag calculations. |
| Nodes table rows | Rows are mapped directly with stable `key={row.id}` at `apps/fe/src/pages/nodes/nodes-table.tsx:55-67`; empty state is static at `:68-74`. No add/remove motion exists. | A one-time fade on newly observed rows is acceptable. True exit motion requires a two-phase removal model; do not fake it with permanent row animations. |
| Loading states | Page spinners use `animate-spin`, for example devices at `apps/fe/src/pages/DevicesPage.tsx:35-40`, login at `apps/fe/src/pages/LoginPage.tsx:43-47`, and nodes at `apps/fe/src/pages/NodesPage.tsx:19-27`. Terminal loading uses spinners at `packages/panels/src/device-console/terminal-stage.tsx:25-34,85-100`. | Add a global reduced-motion rule. Consider skeletons for stable card layouts; do not animate terminal output or every data refresh. |
| Skeletons | `Skeleton` is `animate-pulse` at `packages/ui/src/components/skeleton.tsx:3-9`; the only shared consumer found is sidebar loading at `packages/ui/src/components/sidebar/sidebar-menu.tsx:149-177`. | Add `motion-reduce:animate-none` or global reduction. Keep pulse for loading placeholders, not status indicators. |
| Buttons | Shared `Button` uses `transition-all` at `packages/ui/src/components/button.tsx:6-16`; no active press transform exists. Raw terminal shortcut buttons have hover/active colors but no transition at `apps/fe/src/index.css:167-182`. | Add `active:scale-[0.98]` or `active:translate-y-px` to the shared Button only if touch testing is good. Add `transition-colors` to raw shortcut buttons. |
| Inputs/select controls | Inputs and textareas use `transition-colors` at `packages/ui/src/components/input.tsx:6-16` and `packages/ui/src/components/textarea.tsx:5-15`; select trigger uses it at `packages/ui/src/components/select.tsx:38-53`. | Keep focus/color transitions; add reduced-motion variants for consistency. |
| Switches | Switch track uses `transition-all`; thumb uses `transition-transform` at `packages/ui/src/components/switch.tsx:13-25`. | Existing motion is appropriate. Add reduced-motion handling; do not add bounce or spring behavior. |
| Checkboxes | No standalone `packages/ui/src/components/checkbox.tsx` was found. Dropdown checkbox items have no indicator transition at `packages/ui/src/components/dropdown-menu.tsx:151-181`. | If a shared Checkbox is added later, use a short opacity/scale checkmark transition. Do not introduce a new checkbox dependency solely for animation. |
| Terminal open/close | `DeviceConsole` conditionally mounts `EditorInputPanel` at `packages/panels/src/device-console/device-console.tsx:144-174`; terminal notices and terminal canvas have no enter/exit motion. | Fade the editor panel or status notice only. Keep the terminal canvas mount behavior stable, especially during reconnect. |
| Terminal split | Split panes are absolutely positioned from calculated geometry at `packages/terminal-ui/src/components/SplitTerminalArea.tsx:109-141`; pane width/height are inline styles at `packages/terminal-ui/src/components/split/SplitPaneView.tsx:100-111`. | Do not animate pane width/height; it would fight terminal resizing. Keep gutter color transition at `packages/terminal-ui/src/components/SplitTerminalArea.tsx:207-223`. |
| Terminal pane title bars | Focus changes use `transition-colors` at `packages/terminal-ui/src/components/split/SplitPaneView.tsx:120-126`; close buttons have hover only at `:147-160`. | Add a subtle opacity/color transition to the close affordance. Avoid pane scale or geometry animation. |
| Pane switcher/tab menu | Pane switcher trigger has no transition; its dropdown inherits shared menu motion at `packages/terminal-ui/src/components/PaneSwitcherMenu.tsx:20-80`. | Add `transition-colors` to the trigger and leave menu motion centralized. |
| Terminal selection toolbar | Toolbar mounts/unmounts immediately at `packages/terminal-ui/src/components/SelectionToolbar.tsx:21-32`; buttons have hover only at `:34-65`. | Add a 100–150ms fade/translate reveal, but preserve `preventFocusSteal`. |
| Login page | Login form mounts statically at `apps/fe/src/pages/LoginPage.tsx:189-273`; submit uses `Loader2 animate-spin` at `:251-258`; errors are static at `:241-249`. | Add a subtle initial fade and an error `aria-live` region with opacity transition. Keep loading text and focus behavior unchanged. |
| Credential prompt | Custom overlay/card has no transition at `apps/fe/src/auth/credential-prompt.tsx:245-250`; busy state uses a spinner at `:274-284`. | Add shared fade/scale classes or migrate to Dialog if focus semantics permit. |
| Wizard steps | Path cards use `transition-colors` at `apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.tsx:103-139`; forms are conditionally mounted at `:83-98`. | Reveal the selected form with a short fade-up. Key the reveal by `path`; do not animate the entire wizard layout. |
| Wizard result states | Become/join forms replace the form with a result card immediately at `apps/fe/src/pages/settings/nodes/setup/become-hub-form.tsx:123-155` and `join-hub-form.tsx:93-120`. | Use the same `<Reveal>` for form-to-result replacement. |
| Status badges | Device connection dots are static color classes at `packages/panels/src/device-tree/device-connection-control.tsx:8-18,57-66`; device status chips are static at `apps/fe/src/pages/devices/node-device-group.tsx:72-93`. Reconnecting uses a spinner at `packages/panels/src/device-status-badge.tsx:26-44`. | Do not pulse stable online/offline states. Use `motion-safe:animate-pulse` only for reconnecting/connecting if additional emphasis is needed. |
| Agent status dots | Running agent sessions pulse at `apps/fe/src/components/page-layouts/components/agent-session-row.tsx:19-34`; generating pane sparkle pulses at `packages/terminal-ui/src/components/split/SplitPaneView.tsx:27-40`. | Preserve attention pulse, but disable it under reduced motion. |
| Copy feedback | Copy state swaps icon/text after clipboard success and resets after 2 seconds at `apps/fe/src/pages/nodes/enrollment-section.tsx:227-263`, `local-machine-card.tsx:504-525`, and `https/parts.tsx:150-170`. | Add a short icon opacity/scale transition and `aria-live="polite"`; keep the existing keys `nodes.actions.copy` and `nodes.actions.copied`. |
| Empty states | Device empty state is static at `packages/panels/src/device-management/device-management-panel.tsx:143-162` with `device.noDevices` and `device.addDevice`; node empty state is static at `apps/fe/src/pages/nodes/nodes-table.tsx:68-74` with `nodes.empty`; terminal empty state is static at `packages/panels/src/device-console/device-console.tsx:41-49`. | Use a one-time fade-up for the empty-state block. Avoid bouncing icons or repeated animation when data changes. |

## 3. Minimal shared motion proposal

### A. Theme-level CSS foundation

Add `packages/theme/src/motion.css` and export it from `packages/theme/package.json` alongside the existing CSS exports at `packages/theme/package.json:7-16`.

Recommended contents:

- Motion tokens:

  - `--tmex-motion-fast: 100ms`
  - `--tmex-motion-standard: 150ms`
  - `--tmex-motion-layout: 200ms`
  - `--tmex-motion-slow: 300ms`
  - Standard ease-out and ease-in curves.

- One shared reveal keyframe, for example opacity plus `translateY(4px)`.
- One shared class such as `.tmex-reveal`.
- A global `@media (prefers-reduced-motion: reduce)` rule that reduces or disables transitions, animations, and smooth scrolling.
- Keep existing Tailwind `animate-in`/`fade-in-*` utilities; do not duplicate the `tailwindcss-animate` plugin.

Import it from `apps/fe/src/index.css` near the existing theme imports at `apps/fe/src/index.css:11-14`.

### B. UI-level helper

Add `packages/ui/src/components/motion.tsx`. The package wildcard export already exposes `src/components/*.tsx` through `packages/ui/package.json:9-12`.

Keep it dependency-free. Provide:

- `motionClassNames` constants for `fade`, `fadeUp`, and standard durations.
- A small `<Reveal>` component that applies the shared class and accepts `className`.
- An optional `<Stagger>` helper using CSS variables for static, bounded lists only.
- No React animation runtime and no new motion dependency.

Recommended usage:

```tsx
<Reveal key={activeTab} className="duration-150">
  <SettingsPanel />
</Reveal>
```

All new consumer animations should use `motion-safe:*` or have the theme-level reduced-motion rule as a fallback.

## 4. Three non-overlapping implementation buckets

### Bucket 1 — Theme foundation

Files:

- `packages/theme/src/motion.css` — new.
- `packages/theme/package.json` — CSS export.
- `apps/fe/src/index.css` — import only.

Work:

- Define motion tokens and reveal keyframes.
- Add reduced-motion behavior.
- Do not change feature components.

### Bucket 2 — Shared UI primitives

Files:

- `packages/ui/src/components/motion.tsx` — new.
- `packages/ui/src/components/button.tsx`
- `collapsible.tsx`
- `dialog.tsx`
- `alert-dialog.tsx`
- `sheet.tsx`
- `tooltip.tsx`
- `dropdown-menu.tsx`
- `context-menu.tsx`
- `select.tsx`
- `tabs.tsx`
- `switch.tsx`
- `skeleton.tsx`
- `progress.tsx`
- `packages/ui/src/components/sidebar/**`

Work:

- Replace scattered hard-coded durations where practical.
- Add reduced-motion variants.
- Add optional Collapsible content motion.
- Preserve existing Dialog/Sheet/Menu behavior.
- Avoid changing feature-specific layouts.

### Bucket 3 — Feature consumers

Files:

- `apps/fe/src/auth/**`
- `apps/fe/src/components/page-layouts/**`
- `apps/fe/src/node/**`
- `apps/fe/src/pages/**`
- `packages/panels/src/**`
- `packages/terminal-ui/src/**`

Work:

- Adopt `<Reveal>` for route content, settings panels, wizard branches, empty states, copy feedback, and terminal notices.
- Add initial-only list reveals where stable keys exist.
- Add reduced-motion classes to local inline transitions.
- Do not animate terminal pane geometry, xterm output, or high-frequency tmux updates.
- Do not add stable-online pulsing.

Agents can work in these buckets concurrently after agreeing on the `motion.css` class names and `motion.tsx` API. No bucket should edit another bucket’s files.