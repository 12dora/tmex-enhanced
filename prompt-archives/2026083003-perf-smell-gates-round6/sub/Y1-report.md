# Exploration Y1 Report

## Executive summary

The largest remaining issue is unbounded agent-history retention across sessions. Startup also still includes substantial route-specific code, especially Ghostty terminal code and authentication crypto. Huge tool outputs are bounded server-side, but opening a large result still mounts the entire string into one `<pre>`.

Verification performed:

- In-memory Vite production build: 5,342 modules, entry `1,342,429` raw bytes.
- Real store simulation: 200 sessions opened and histories loaded.
- 500 KiB `ToolCallCard` SSR benchmark.
- Targeted Bun tests: `138 pass`, `0 fail`, `445 expect()` calls.
- No intentional repository edits were made.

## Findings

### 1. HIGH — Agent histories remain retained for every session ever opened

**Files:** [`packages/stores/src/agent-session-crud-actions.ts:196-206`](/Users/konata/code/tmex-enhanced-wt-r6/packages/stores/src/agent-session-crud-actions.ts:196), [`packages/stores/src/agent-session-crud-actions.ts:238-260`](/Users/konata/code/tmex-enhanced-wt-r6/packages/stores/src/agent-session-crud-actions.ts:238), [`packages/stores/src/agent-history-sync.ts:54-91`](/Users/konata/code/tmex-enhanced-wt-r6/packages/stores/src/agent-history-sync.ts:54), [`packages/stores/src/agent-state.ts:47-58`](/Users/konata/code/tmex-enhanced-wt-r6/packages/stores/src/agent-state.ts:47)

`setActiveSession()` loads and retains the complete history, but switching sessions only unsubscribes from the previous session. `loadSessions()` removes missing session metadata, yet does not remove the corresponding `messages`, `historyLoaded`, `inProgress`, or queued state. Only explicit `deleteSession()` performs complete per-session cleanup.

A real store simulation opened 200 sessions, loaded one 1 KiB message into each, then refreshed the server list to empty:

```json
{
  "listed": 0,
  "retainedMessages": 200,
  "messageArrays": 200,
  "bytes": 228400,
  "activeSubscriptions": { "self": null }
}
```

These are retained store objects, not a V8 heap snapshot. At 100 KiB average history per session, the same pattern would retain roughly 20 MiB before object overhead. This is separate from Round 1’s bounded rendering of the currently displayed history.

Proposed fix: add a bounded LRU or byte-budget cache for inactive histories, keeping the active session and live/pending sessions pinned. Evicted histories can be refetched when reopened. The remote-list reconciliation path should also call the existing per-session cleanup for sessions that disappeared remotely.

- Expected gain: memory becomes bounded instead of proportional to the number of historically opened sessions.
- Risk: reopening an evicted session incurs a history request; live sessions must be excluded from eviction.
- Estimated net LOC: `+12` (`+15 / -3`).

### 2. HIGH — The terminal-ui root import pulls Ghostty into every initial route

**Files:** [`apps/fe/src/main.tsx:29`](/Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/main.tsx:29), [`packages/terminal-ui/src/index.ts:3-13`](/Users/konata/code/tmex-enhanced-wt-r6/packages/terminal-ui/src/index.ts:3), [`packages/terminal-ui/src/index.ts:57`](/Users/konata/code/tmex-enhanced-wt-r6/packages/terminal-ui/src/index.ts:57)

`main.tsx` imports only `useKeyboardAvoidance`, but imports it from the package root. That root exports `Terminal`, `TerminalSurface`, `SplitTerminalArea`, and related modules, causing the Ghostty terminal graph to enter the initial chunk.

Measured in-memory build:

| Build | Entry raw size | Ghostty modules in entry |
|---|---:|---:|
| Current root import | 1,342,429 bytes | Present |
| Subpath import for `useKeyboardAvoidance` | 1,201,954 bytes | 0 |

The subpath-only variant removed `140,475` raw bytes from the entry, approximately 10.5%.

Proposed fix: import `useKeyboardAvoidance` from its direct subpath, preserving the root package import only for actual terminal consumers. The current package export map already resolves this subpath; an explicit export can be added if a more stable public contract is preferred.

- Expected gain: approximately 140 KiB raw from every initial load.
- Risk: package export/type-resolution regressions; verify with the normal frontend build.
- Estimated net LOC: approximately `+1` (`+1 / -1`).

The sidebar also statically imports the device tree:

- [`apps/fe/src/components/page-layouts/components/app-sidebar.tsx:14,82-85`](/Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:14)
- [`packages/panels/src/device-tree/device-tree-dnd.tsx:1-20`](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/device-tree/device-tree-dnd.tsx:1)

`@dnd-kit` contributes about `130,021` rendered bytes to the entry. It is only needed by the panes/device-tree tab, so lazy-loading that tab could reduce non-panes routes, but the default panes tab makes this a lower-priority optimization.

### 3. HIGH — Authentication crypto is statically included through the resident node-login path

**Files:** [`apps/fe/src/auth/NodeLoginButton.tsx:9`](/Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/auth/NodeLoginButton.tsx:9), [`apps/fe/src/auth/session-key-store.ts:19-35`](/Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/auth/session-key-store.ts:19), [`packages/shared/src/auth/root-key.ts:1-2`](/Users/konata/code/tmex-enhanced-wt-r6/packages/shared/src/auth/root-key.ts:1), [`apps/fe/src/node/node-runtime-boundary.tsx:64-68`](/Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/node/node-runtime-boundary.tsx:64)

The resident sidebar/node-route path imports `session-key-store`, which statically imports Argon2 and Ed25519/X25519 helpers even though most users do not immediately perform node login.

The entry contains these rendered module contributions:

- `hash-wasm`: `43,800` bytes
- selected `@noble/curves` modules: `107,287` bytes

Together they represent approximately `151,087` rendered raw bytes of authentication crypto. Some curve code may be shared with direct-link code, so this is an upper-bound saving estimate rather than an additive guarantee.

Proposed fix: split lightweight session-key state and subscription functions from the login implementation. Dynamically import the password/passkey login and crypto helper only when `ensureNodeLogin()` is actually invoked. The existing security panel is already lazy, so the remaining resident path is the main opportunity.

- Expected gain: potentially up to approximately 151 KiB raw from the initial entry, plus avoiding early Argon2/WASM initialization.
- Risk: async login behavior and circular imports; preserve existing secret-zeroing guarantees.
- Estimated net LOC: approximately `+6` (`+10 / -4`).

### 4. MEDIUM — Large tool results mount as one unbounded `<pre>` when opened

**Files:** [`packages/panels/src/agent/messages/tool-call-card.tsx:49-60`](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/agent/messages/tool-call-card.tsx:49), [`packages/panels/src/agent/messages/tool-call-card.tsx:391-429`](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/agent/messages/tool-call-card.tsx:391), [`packages/panels/src/agent/messages/tool-call-card.tsx:218-225`](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/agent/messages/tool-call-card.tsx:218)

The collapsed card is cheap: SSR of an actual card containing a synthetic 500 KiB output produced only `1,266` bytes, with no `<pre>` and no payload in the HTML. However, opening the details dialog sets `DetailsExpandedContext` to true and renders the entire output as one text node inside a single `<pre>`. `max-h-64` limits the viewport, not the DOM or string size.

The card also scans output for image-like values on every render. For base64-like strings, `asImageSrc()` performs whitespace removal and creates another large data-URI string even while the dialog is closed.

There is no syntax highlighter in this card, so this is primarily a DOM, memory, layout, and copy/selection cost—not a synchronous highlighting freeze. The gateway already caps `run-command` output at 256 KiB and stores a tool result once rather than repeating it in every delta:

- [`apps/gateway/src/agent/tools/run-command-buffer.ts:1`](/Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/agent/tools/run-command-buffer.ts:1)
- [`packages/stores/src/agent-event-router.ts:176-210`](/Users/konata/code/tmex-enhanced-wt-r6/packages/stores/src/agent-event-router.ts:176)

Proposed fix: render only a bounded preview, such as 64 KiB or a fixed number of lines, and offer copy/download for the complete retained result. Restrict image extraction to known image-producing tools or to outputs below a size threshold.

- Expected gain: opened DOM size and layout work stay bounded; large temporary copies are avoided.
- Risk: users need an explicit full-output action.
- Estimated net LOC: approximately `+6` (`+10 / -4`).

### 5. MEDIUM — Locale loading blocks creation of the React tree and first paint

**Files:** [`apps/fe/src/main.tsx:320-330`](/Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/main.tsx:320), [`apps/fe/src/i18n/index.ts:28-53`](/Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/i18n/index.ts:28)

`main.tsx` waits for `i18nReady` before calling `createRoot()`. The current locale is dynamically loaded from a separate chunk, so no React shell can paint until that request and module evaluation complete.

Measured locale chunk sizes were approximately:

- `zh_CN`: 48,047 raw bytes
- `ja_JP`: 57,112 raw bytes
- `en_US`: 75,630 raw bytes

Other initial REST/WS work is started from post-mount effects and is not obviously serial: device query, mesh polling, mesh WS setup, capabilities loading, and watch WS setup begin from separate effects. The locale promise is the clear serial first-render gate.

Proposed fix: render a minimal shell immediately using a bundled fallback locale, then apply the detected locale when its chunk resolves. This trades a possible short untranslated/fallback state for earlier first paint.

- Expected gain: removes one locale request/parse delay from first paint; exact time depends on network conditions.
- Risk: fallback text flash and small layout shifts.
- Estimated net LOC: approximately `+4` (`+8 / -4`).

## Startup entry composition

Measured with Rollup’s `renderedLength` per module; these are raw post-tree-shaking contributions, not gzip sizes.

| Rank | Module | Rendered bytes | Route need |
|---:|---|---:|---|
| 1 | `react-dom-client.production.js` | 552,879 | Global |
| 2 | `react-router` development chunk | 212,673 | Global |
| 3 | `@dnd-kit/core` | 104,382 | Panes/device tree |
| 4 | `tailwind-merge` | 94,067 | Global UI |
| 5 | `i18next` | 80,859 | Global |
| 6 | `sonner` | 64,265 | Global notifications |
| 7 | `hash-wasm` | 43,800 | Login/auth actions |
| 8 | `ghostty-wasm.ts` | 38,480 | Terminal routes |
| 9 | `@noble/curves/abstract/curve.js` | 29,635 | Auth/direct link |
| 10 | `@noble/curves/abstract/modular.js` | 28,648 | Auth/direct link |
| 11 | `@noble/curves/abstract/edwards.js` | 28,459 | Auth/direct link |
| 12 | `direct-carrier-controller.ts` | 27,394 | Remote-node routes |
| 13 | `tabbable` | 27,293 | Global dialogs/focus |
| 14 | Base UI `FloatingFocusManager` | 25,670 | Global dialogs |
| 15 | `@floating-ui/dom` | 25,468 | Global overlays |

## Duplicate dependency versions

The build contains these multi-version packages, but they occur in dynamic diagram/markdown chunks rather than the initial entry:

- `d3-shape`: `3.2.0`, `1.3.7`
- `d3-array`: `3.2.4`, `2.12.1`
- `cose-base`: `2.2.0`, `1.0.3`
- `layout-base`: `2.0.1`, `1.0.2`
- `d3-path`: `3.1.0`, `1.0.9`
- `katex`: `0.17.0`, `0.16.47`

No same-version duplicate import path was found in the entry. These are worth addressing only if dynamic diagram or markdown chunk size becomes a separate budget concern.

## Checked and already fine

- Pane mount/release counts are symmetric and device cleanup removes subscription maps: [`packages/stores/src/pane-subscriptions.ts:58-75`](/Users/konata/code/tmex-enhanced-wt-r6/packages/stores/src/pane-subscriptions.ts:58).
- Pane sinks unregister on unmount; pending output is capped at 2 MiB and device cleanup discards orphaned buffers: [`packages/ws-client/src/pane-sink-registry.ts:97-133`](/Users/konata/code/tmex-enhanced-wt-r6/packages/ws-client/src/pane-sink-registry.ts:97).
- Terminal resize, wheel listeners, render targets, and terminal surfaces have cleanup paths.
- Reconnect callbacks use unsubscribe closures; visibility listeners and reconnect timers are guarded against duplication.
- Direct-carrier attempts cancel timers, abort signals, close peer connections, and remove signaling listeners.
- Tool output is not duplicated into every delta; the complete result is stored once.
- `fetch_url` truncates returned text to 16 KiB.
- Agent/Files/Settings page modules and the security side panel are already lazy-loaded.
- The targeted lifecycle and state tests passed: 138 tests, 0 failures.

Final read-only status showed existing or concurrent workspace changes in gateway test helpers, `packages/stores/src/agent-persist-gate.test.ts`, and `prompt-archives/`; they were left untouched.