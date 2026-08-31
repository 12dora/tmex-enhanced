## BLOCKER

None.

## SHOULD-FIX

- **Wizard state survives tunnel removal.** [`remote-access-tab.tsx:56`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/pages/settings/remote-access/remote-access-tab.tsx:56) retains `chosenPath`, `chosenMode`, hostname, confirmation, and exposure acknowledgement after `status.config.mode` transitions back to `off`. A tunnel created and removed during the same mount therefore leaves the tunnel branch selected, keeps the status card visible, and may retain a previously confirmed named-tunnel draft. Detect the configured→off transition and reset all tunnel-specific local state.

- **The Devices “+” button is still not always a menu.** [`DevicesPage.tsx:190`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/pages/DevicesPage.tsx:190) falls back to `DeviceManagementActions` when the target registry is empty. This happens transiently before targets register and persistently when no node is ready, making “Add remote node” unavailable—the opposite of the stated always-open-menu behavior. Always render `AddDeviceMenu`; hide its separator and existing-node group when `targets` is empty.

- **The direct-connection onboarding promises functionality the wizard does not provide.** [`en_US.json:138`](/Users/konata/code/tmex-enhanced-wt-r8/packages/shared/src/i18n/locales/en_US.json:138), with equivalent zh/ja copy, says selecting Direct connection obtains a fixed HTTPS address. The direct branch explicitly only configures access protection and expects the user to provision networking and HTTPS themselves ([`direct-step.tsx:1`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/pages/settings/remote-access/direct-step.tsx:1)). Rewrite all three locales to distinguish “named tunnel provides an address” from “direct connection requires your own fixed HTTPS entry.”

- **`GuideTabs` exposes tabs without tab panels.** [`guide-tabs.tsx:24`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/components/side-panels/connect-devices/guide-tabs.tsx:24) ends the Base UI `Tabs` root immediately after the tab list; the conditionally rendered guide content is outside it. Consequently the tabs have no `aria-controls`, and the content has no `tabpanel`/`aria-labelledby` relationship. The SSR tests do not detect this. Keep each branch inside a matching `TabsContent`, or implement the selectors as an appropriately labelled segmented radio group.

- **The new radio cards have no visible keyboard focus.** [`wizard.tsx:436`](/Users/konata/code/tmex-enhanced-wt-r8/apps/fe/src/pages/settings/remote-access/wizard.tsx:436) visually hides the focusable radio, but the surrounding card has no `:focus-visible` styling. Keyboard users can move through both connection-method and tunnel-type choices without seeing focus. Add a `:has(input:focus-visible)` ring/outline to the label, or restructure the input and label to use `peer-focus-visible`.

## NIT

- **Enabled-state copy is written as an action.** [`en_US.json:424`](/Users/konata/code/tmex-enhanced-wt-r8/packages/shared/src/i18n/locales/en_US.json:424) says “Turns on sign-in protection” under “Local sign-in is on”; zh_CN and ja_JP have the same state/action mismatch. Change it to an enabled-state description in all three locales.

Targeted tests pass (`170 pass`), and the front-end TypeScript check passes. No remaining production call sites were found for `sidebar.nodes`, the `nodes` panel, or `settings.remoteAccess.mode.direct`; `WizardMode` and `AddDeviceMenuList` call sites are updated, and the changed locale key sets are aligned.