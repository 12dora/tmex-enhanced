Scope reviewed: `packages/panels/**`, `apps/fe/**`, `packages/stores/**`, `packages/ui/**`. Estimates below are targets; rerun metrics after implementation.

### 1. Centralize device-tree pane actions

files:

- `packages/panels/src/device-tree/window-row.tsx`
- `packages/panels/src/device-tree/pane-row.tsx`
- `packages/panels/src/device-tree/device-tree-actions.ts`
- `packages/panels/src/device-tree/device-tree-actions.test.ts`

metric: `WindowRow` CC 24 / file 266L / function 220L; `PaneRow` CC 21 / file 208L / function 169L.

**Why it hurts** — Both rows independently construct nearly identical conditional action lists: agent session, cwd window, split directions, watch, and close. Feature flags or menu changes can diverge between window and pane behavior. Window-specific rename/close semantics and selected-pane fallback make copying especially error-prone.

**Concrete refactor** — Add `buildSharedPaneActionItems()` in `device-tree-actions.ts`. It should accept `deviceId`, `windowId`, `pane`, optional `sessionPane`, `agent`, `watchUi`, translation, and side-effect callbacks. Keep rename and close outside the helper. `WindowRow` preserves its `selectedPaneInWindow ?? tmuxWindow.panes[0]` fallback; `PaneRow` passes its own pane for both values. Add a table-driven test for agent/watch/cwd combinations and action ordering.

**Risk:** Medium. **Existing test coverage:** `apps/fe/tests/sidebar-close-confirm.spec.ts`, `sidebar-rename.spec.ts`, `sidebar-pane-menu-alignment.spec.ts`, `sidebar-click-no-pty-injection.spec.ts`. No direct unit coverage for action construction.

**Expected effect** — `WindowRow` ≈180L / CC≤8; `PaneRow` ≈145L / CC≤7; shared helper ≈90L / CC≤8.

### 2. Separate WatchDialog’s state machine from its views

files:

- `packages/panels/src/watch/watch-dialog.tsx`
- `packages/panels/src/watch/use-watch-dialog-model.ts`
- `packages/panels/src/watch/watch-dialog-content.tsx`
- `packages/panels/src/watch/watch-delete-dialog.tsx`

metric: `WatchDialog` CC 15 / file 430L / function 200L.

**Why it hurts** — One component owns view navigation, query loading, toggle/delete mutations, notification permission state, list rendering, form rendering, state rendering, and delete confirmation. Changes to invalidation or close/reset behavior can unintentionally affect unrelated views.

**Concrete refactor** — Move query/mutation/state logic into `useWatchDialogModel()`, preserving query keys, invalidation, reset-on-close behavior, and notification permission checks. Move the list, `WatchRuleRow`, and `WatchRuleStateView` into `watch-dialog-content.tsx`; move the delete confirmation into `watch-delete-dialog.tsx`. `WatchDialog` should only compose the model, dialog shell, content view, and delete dialog.

**Risk:** Medium. **Existing test coverage:** `apps/fe/tests/watch.spec.ts`, `apps/fe/tests/mobile-agent-watch.spec.ts`, `packages/panels/src/watch/watch-rule-draft.test.ts`. No direct dialog unit test.

**Expected effect** — `watch-dialog.tsx` ≈100L / `WatchDialog` CC≤5; model ≈100L; content retains the existing presentational views without mixing them with mutation logic.

### 3. Extract the device-console action model

files:

- `packages/panels/src/device-console/page-actions.tsx`
- `packages/panels/src/device-console/use-device-console-actions.ts`
- `packages/panels/src/device-console/device-console-actions-view.tsx`
- `packages/panels/src/device-console/deferred-terminal-settings-sheet.tsx`

metric: `DeviceConsoleActions` CC 21 / file 324L / function 213L.

**Why it hurts** — Route decoding, snapshot lookup, pane switching, split commands, input mode, watch-rule querying, refresh confirmation, terminal-settings lazy loading, and mobile/desktop rendering are coupled in one component. Query enablement and route normalization are easy to break while editing button JSX.

**Concrete refactor** — `useDeviceConsoleActions()` owns pane derivation, `canInteract`, watch query, input/refresh/settings state, and callbacks. `DeviceConsoleActionsView` renders the pane switcher and action buttons. Move `DeferredTerminalSettingsSheet` unchanged into its own file. Preserve button order, test IDs, route encoding, and query enablement exactly.

**Risk:** Medium. **Existing test coverage:** `apps/fe/tests/terminal-ui.spec.ts`, `terminal-focus.spec.ts`, `mobile-terminal-interactions.spec.ts`, `split-screen-desktop.spec.ts`, `watch.spec.ts`, `keyboard-behavior-settings.spec.ts`.

**Expected effect** — `page-actions.tsx` ≈60–80L / `DeviceConsoleActions` CC≤4; model ≈130L / CC≤8; view ≈120L.

### 4. Isolate DeviceDialog form state and auth-mode fields

files:

- `packages/panels/src/device-management/device-dialog.tsx`
- `packages/panels/src/device-management/use-device-dialog-model.ts`
- `packages/panels/src/device-management/device-dialog-fields.tsx`
- `packages/panels/src/device-management/device-form.ts`

metric: `DeviceDialog` CC 13 / file 406L / function 368L.

**Why it hurts** — Submission mutations, validation, form state, mode switching, field IDs/labels, and three SSH authentication branches coexist with a large form. The important transition (`local → auto`, `ssh + auto → agent`) is embedded inside JSX event handlers.

**Concrete refactor** — Add `useDeviceDialogModel()` for `formData`, `attempted`, mutation submission, pending state, and typed field updates. Extract `DeviceBasicFields`, `DeviceSshConnectionFields`, and `DeviceAuthFields` into `device-dialog-fields.tsx`. Keep `buildCreatePayload`, `buildUpdatePayload`, and `validateDeviceForm` in `device-form.ts`; preserve all auth-mode transitions and payload behavior.

**Risk:** Medium. **Existing test coverage:** `apps/fe/tests/devices.spec.ts`, `apps/fe/tests/ssh-device-connect.spec.ts`. No focused unit coverage for the component’s auth-mode state transitions.

**Expected effect** — `device-dialog.tsx` ≈120L / CC≤5; model ≈100L; fields ≈190L / auth branch CC≤6.

### 5. Turn Weixin login polling into an explicit flow hook

files:

- `packages/panels/src/settings/weixin-account-login-modal.tsx`
- `packages/panels/src/settings/use-weixin-account-login.ts`
- `packages/panels/src/settings/weixin-login-flow.ts`
- `packages/panels/src/settings/weixin-login-flow.test.ts`

metric: modal CC 9 / file 289L / function 254L; `pollBinding` CC 16 / 58L; `pollLogin` CC 12 / 44L.

**Why it hurts** — Timer cleanup, abort controllers, generation invalidation, two polling phases, baseline comparison, approval, and UI phase updates are interleaved. This is the highest async race risk in the settings scope.

**Concrete refactor** — Move timer/abort/generation handling and API calls into `useWeixinAccountLogin()`. Add pure helpers `classifyWeixinLoginStatus()`, `buildUserBaseline()`, and `findFreshUser()` in `weixin-login-flow.ts`. Keep endpoints, 1500ms polling, baseline semantics, approval ordering, and stale-generation guards unchanged. The modal should only render QR/status/footer state.

**Risk:** High. **Existing test coverage:** **NO existing test coverage** for the Weixin login flow. Add fake-fetch/timer tests for expired, error, confirmed→baseline, fresh-user approval, close cancellation, and restart races.

**Expected effect** — modal ≈75L / CC≤4; polling callbacks ≈40–50L each / CC≤10; pure flow helpers separately testable.

### 6. Split TerminalShortcutsEditor’s model, row, and add controls

files:

- `packages/panels/src/settings/TerminalShortcutsEditor.tsx`
- `packages/panels/src/settings/use-terminal-shortcuts-editor.ts`
- `packages/panels/src/settings/terminal-shortcuts-model.ts`
- `packages/panels/src/settings/terminal-shortcut-row.tsx`
- `packages/panels/src/settings/terminal-shortcut-add-panel.tsx`

metric: `TerminalShortcutsEditor` CC 10 / file 513L / function 306L.

**Why it hurts** — Server baseline synchronization, dirty tracking, mutation handling, drag ordering, key capture, manual parsing, row-local drafts, and all JSX live together. The code is readable, but lifecycle changes can accidentally alter dirty-state or save semantics.

**Concrete refactor** — Move `sameItems`, normalization, query/baseline synchronization, mutation, and editor callbacks into `useTerminalShortcutsEditor()`. Move `SortableShortcutRow` into its own file. Move capture, special-action buttons, and advanced manual entry into `terminal-shortcut-add-panel.tsx`. Keep `DndContext`, preview, icon switch, and save/reset composition in the parent.

**Risk:** Medium. **Existing test coverage:** `apps/fe/tests/terminal-shortcuts.spec.ts`, `apps/fe/tests/keyboard-behavior-settings.spec.ts`.

**Expected effect** — parent ≈140L / CC≤5; hook ≈160L; row and add panel each independently testable.

### 7. Extract the file-root form and client-routing model

files:

- `packages/panels/src/settings/files-tab.tsx`
- `packages/panels/src/settings/file-root-form-modal.tsx`
- `packages/panels/src/settings/use-file-root-form.ts`
- `packages/panels/src/settings/file-root-form-model.ts`

metric: `FileRootFormModal` CC 17 / file 556L / function 220L.

**Why it hurts** — The form mixes create/update mutations, grouped-device routing, source-client preservation for edits, reset-on-open behavior, validation, and rendering. The `deviceGroups` client-selection behavior is subtle and can regress when fields are rearranged.

**Concrete refactor** — Move the modal unchanged into `file-root-form-modal.tsx`. `useFileRootForm()` owns draft state, mutations, submit guards, and reset behavior. Put `resolveFileRootClient()`, device-option derivation, and path validation in `file-root-form-model.ts`. Preserve edit-client precedence, deduplicated root queries, and grouped Select rendering.

**Risk:** Medium. **Existing test coverage:** `apps/fe/tests/settings-files.spec.ts` only covers the empty state. **NO existing form regression coverage.**

**Expected effect** — `files-tab.tsx` ≈330L; modal ≈150L / CC≤6; hook/model ≈120L combined.

### 8. Deduplicate tmux optimistic reorder logic

files:

- `packages/stores/src/tmux.ts`
- `packages/stores/src/tmux-reorder.ts`
- `packages/stores/src/tmux-reorder.test.ts`

metric: file 377L; `createTmuxStore` 352L / CC 1; nested store initializer 326L / CC 1.

**Why it hurts** — `reorderWindows` and `reorderPanes` duplicate the same ID-to-item ordering algorithm. Future changes can make optimistic local order differ between windows and panes.

**Concrete refactor** — Add `reorderByIds<T extends { id: string }>()` with the current behavior: ordered known IDs first, unknown/current remainder afterward, preserving duplicates and existing item identity. Use it in both snapshot updates without changing transport payloads or empty-input guards.

**Risk:** Low. **Existing test coverage:** `packages/stores/src/tmux-reselect-retry.test.ts` covers adjacent store lifecycle only. **NO direct reorder coverage.** Add table-driven tests for known, unknown, partial, and duplicate IDs.

**Expected effect** — `tmux.ts` ≈330L; CC remains 1; helper ≈35L / CC≤2.

## Not worth doing

- `packages/stores/src/agent-event-router.ts` — already uses typed handler-table dispatch; handlers are cohesive and covered by `agent-event-router.test.ts`.
- `packages/stores/src/agent-session-actions.ts` — 489L factory / CC 1; mostly a readable action registry. A generic update helper saves little and does not reduce branching.
- `apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx` — 555L module already contains many small, coherent components; file splitting would only relocate JSX.
- `packages/panels/src/device-tree/device-row.tsx` — CC 16 is primarily the necessary expanded/loading/empty/list state; extracting flat JSX would not improve behavior or control flow.
- `packages/panels/src/agent/messages/tool-call-card.tsx` — 489L is already decomposed into tool-specific bodies and a registry-driven view model.
- `packages/panels/src/device-console/pane-selection-rules.ts` — pure decision helpers with dedicated tests; no mixed responsibilities.
- `apps/fe/src/pages/FilePage.tsx` — the CC 12 function is a shallow media/text fallback switch after view components were already extracted.
- `packages/panels/src/files/files-tab.tsx` — data hooks, recursive directory nodes, and file leaves are already separated.
- Telegram/Weixin/LLM list-row-form generic shells — explicitly rejected in `plan-01-result.md`; prior measurement showed approximately net-zero benefit, and domain-specific mutations/status/actions remain materially different.
- `packages/ui/src/components/sidebar/sidebar-provider.tsx` and `sidebar-layout.tsx` — design-system lifecycle and responsive branches are intentionally centralized; splitting increases semantic risk.

Archive note: the existing round-3 archive and metrics were read. This read-only environment prevented appending the current prompt/plan/result files.