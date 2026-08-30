# Exploration X1 — Frontend performance report

No repository files were modified. The scratchpad was also read-only, so benchmarks were executed from Bun stdin. Targeted tests passed: 86 tests, 0 failures across 8 files.

## 1. HIGH — Entire chat history stays mounted and all rows re-render

- Location: [`chat-thread.tsx:97`](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/agent/chat-thread.tsx:97), [`tool-call-card.tsx:432`](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/agent/messages/tool-call-card.tsx:432)
- Hot path/cost: `ChatThread` maps every historical block; there is no virtualization. Message components are not memoized, so every streaming update executes all historical user, assistant, reasoning, and tool-card components.
- Evidence: Rendering 1,000 synthetic assistant blocks with `react-dom/server` took 231.5 ms and produced 349 KB of HTML. Tool cards additionally recreate dialog wrappers and inspect resolved outputs on each render.
- Fix: Add a variable-height virtualized history list or bounded history window, and render each block through keyed memoized row components. Keep historical block and tool-call references stable so only the live tail or changed tool card updates.
- Expected gain: Largest improvement to scroll smoothness and DOM/layout cost; initial and incremental work becomes proportional to visible rows.
- Risk: Variable-height virtualization, focus restoration, accessibility, and scroll anchoring need careful testing.
- Net LOC: approximately +60 to +140 lines, possibly plus a virtualizer dependency.

## 2. HIGH — Full persisted history is parsed again on every delta flush

- Location: [`use-agent-tab-model.ts:27`](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/agent/use-agent-tab-model.ts:27), [`agent-thread.ts:51`](/Users/konata/code/tmex-enhanced-wt-r6/packages/stores/src/agent-thread.ts:51), [`agent-message-parser.ts:144`](/Users/konata/code/tmex-enhanced-wt-r6/packages/stores/src/agent-message-parser.ts:144)
- Hot path/cost: `inProgress` changes every 40 ms, invalidating the `blocks` memo. `buildThreadBlocks()` then reparses all messages and recreates all block objects before appending the live tail.
- Evidence: 2,000 simple messages parsed 500 times took 48.8 ms total, about 0.098 ms per flush; a tool-heavy 2,000-message case took about 0.396 ms per `buildBlocksWithConfirmations()` call. A 2,000-delta stream therefore allocates roughly four million block records.
- Fix: Cache parsed persisted messages by the `messages` array reference and build a separate immutable live overlay. Apply live tool-result updates only to affected cached blocks, rather than rebuilding the historical block list.
- Expected gain: Removes one full history scan and large allocation burst from every flush; benefits grow with history length and mobile hardware.
- Risk: Live tool-result updates and stale-message cleanup must avoid mutating cached historical objects.
- Net LOC: approximately +15 to +35 lines.

## 3. HIGH — Growing streaming Markdown is reparsed as a whole

- Location: [`streaming-markdown.tsx:95`](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/markdown/streaming-markdown.tsx:95), [`streaming-markdown.tsx:78`](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/markdown/streaming-markdown.tsx:78)
- Hot path/cost: Every streamed text update rescans the complete current answer with `splitMarkdownBlocks()`, and the current Markdown block is reparsed by `ReactMarkdown`.
- Evidence: Static rendering of one 30.8 KB streaming block took 66.0 ms; 77 KB took 105.2 ms; 154 KB took 239.6 ms. These are SSR measurements rather than browser frame measurements, but they show the parser can exceed a 16.7 ms frame budget for long answers.
- Fix: While streaming, render plain preformatted text or throttle rich Markdown parsing to one update per animation frame/100 ms, then parse fully when the turn finishes. If rich streaming Markdown is required, retain finalized blocks and reparse only the current tail.
- Expected gain: Prevents long single responses from monopolizing the main thread during token streaming.
- Risk: Markdown formatting appears delayed or changes when the final parse runs.
- Net LOC: approximately -10 to +20 lines.

## 4. MEDIUM — The composer and input subtree participate in every stream render

- Location: [`agent-tab.tsx:13`](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/agent/agent-tab.tsx:13), [`use-agent-tab-actions.ts:176`](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/agent/use-agent-tab-actions.ts:176), [`agent-composer.tsx:185`](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/agent/agent-composer.tsx:185)
- Hot path/cost: Each `inProgress` update rerenders `AgentTab`, recreates action callbacks, and recreates the `modelPicker` and `writeModeControl` React nodes. The controlled textarea remains local-state based, but its component still rerenders alongside the stream.
- Evidence: The `inProgress` selector changes on every 40 ms flush; `useAgentTabActions()` returns fresh callback objects on each parent render, and no composer component is memoized.
- Fix: Isolate `ChatInput`/`AgentComposer` behind memoized boundaries and stabilize stream-independent callbacks with `useCallback` or refs. Pass primitive model/control props instead of freshly created control nodes where possible.
- Expected gain: Improves typing latency and reduces competition between input updates and stream rendering.
- Risk: Callback stabilization can introduce stale state if dependencies are incomplete.
- Net LOC: approximately +10 to +25 lines.

## 5. MEDIUM — Auto-scroll performs layout-sensitive work every flush

- Location: [`chat-thread.tsx:57`](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/agent/chat-thread.tsx:57), [`chat-thread.tsx:71`](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/agent/chat-thread.tsx:71)
- Hot path/cost: Since `blocks` changes every flush, the effect repeatedly reads `scrollHeight` and writes `scrollTop`. After Markdown or card layout changes, the read can force layout before the write.
- Evidence: The backend and frontend both use a 40 ms stream cadence, so this path can run up to 25 times per second while pinned. No `ResizeObserver` or `requestAnimationFrame` coalescing is used.
- Fix: Coalesce auto-scroll into one `requestAnimationFrame` callback per frame and use a bottom sentinel or `scrollIntoView()` where appropriate. Avoid reading and writing layout on every commit when the user is already clearly pinned.
- Expected gain: Reduces forced-layout pressure and scroll jitter during streaming.
- Risk: Incorrect pin-state detection can unexpectedly move the user while reading history.
- Net LOC: approximately -5 to +10 lines.

## 6. LOW — Synchronous localStorage write occurs on every delta flush

- Location: [`agent.ts:44`](/Users/konata/code/tmex-enhanced-wt-r6/packages/stores/src/agent.ts:44), [`agent.ts:128`](/Users/konata/code/tmex-enhanced-wt-r6/packages/stores/src/agent.ts:128)
- Hot path/cost: Zustand `persist` writes synchronously after every `set()`, including delta flushes. The persisted payload is limited to `activeSessionIdByNode` and `defaultWriteMode`, not message history.
- Evidence: 2,000 real store delta flushes caused 2,000 `setItem` calls and serialized 180 KB total; the in-memory storage benchmark took 4.27 ms. Browser `localStorage` is synchronous, so actual latency depends on the browser.
- Fix: Gate persistence on changes to persisted fields or move those preferences into a separate store. Keep conversation data out of localStorage.
- Expected gain: Small on the current payload, but removes avoidable synchronous work from the stream path.
- Risk: Persisted active-session changes may be delayed slightly.
- Net LOC: approximately -5 to +15 lines.

## Already checked and currently fine

- Delta buffering already coalesces updates at 40 ms and clones only the small `inProgress` arrays, not the full message history: [`agent-delta-buffer.ts:41`](/Users/konata/code/tmex-enhanced-wt-r6/packages/stores/src/agent-delta-buffer.ts:41).
- Agent selectors return stable primitive/reference slices; the main changing selector is `inProgress`: [`use-agent-tab-state.ts:102`](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/agent/use-agent-tab-state.ts:102).
- Agent persistence deliberately excludes messages, sessions, and streaming state: [`agent.ts:128`](/Users/konata/code/tmex-enhanced-wt-r6/packages/stores/src/agent.ts:128).
- The sidebar session controller subscribes to sessions/order/active ID, not messages or `inProgress`: [`use-sidebar-agent-sessions.ts:165`](/Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts:165).
- Agent and pane-tree views are mutually exclusive in the sidebar, so the session list is not simultaneously rendering during chat streaming: [`app-sidebar.tsx:82`](/Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:82).
- Agent messages use the lighter GFM-only `StreamingMarkdown`; the highlight.js/KaTeX/Mermaid `MarkdownPreview` path is not used by assistant messages: [`assistant-message.tsx:18`](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/agent/messages/assistant-message.tsx:18).
- History fetches are debounced and in-flight requests are deduplicated; persistence events do not directly fetch on every delta: [`agent-event-router.ts:282`](/Users/konata/code/tmex-enhanced-wt-r6/packages/stores/src/agent-event-router.ts:282).