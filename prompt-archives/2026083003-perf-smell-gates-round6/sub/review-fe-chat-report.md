## Findings

1. **should-fix** — [packages/panels/src/agent/use-agent-tab-actions.ts:218](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/agent/use-agent-tab-actions.ts:218), [composer-isolation.test.ts:144](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/agent/composer-isolation.test.ts:144)  
   `deps.current` is overwritten during render. If a concurrent session-switch render from A to B is interrupted or aborted, the still-visible controls for A can invoke actions against B, potentially sending or stopping the wrong session. React explicitly disallows non-initialization ref writes during render for this reason ([React `useRef` documentation](https://react.dev/reference/react/useRef)). Update the dependency ref in a layout effect so it reflects the committed UI; the current test manually mutates a plain ref and therefore cannot exercise this render/commit race.

2. **should-fix** — [packages/panels/src/agent/chat-thread.tsx:179](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/agent/chat-thread.tsx:179)  
   The window start is recalculated as `blocks.length - windowSize` on every append. With 500 blocks, block 300 is visible; when block 500 arrives, the slice starts at 301, so an unpinned user reading block 300 has it removed from under them. The rAF correctly avoids scrolling, but no anchoring occurs because `windowSize` did not change. Freeze the rendered range while unpinned and reset it to the latest 200 only when the user jumps back to the bottom.

3. **should-fix** — [packages/panels/src/files/files-tab.tsx:247](/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/files/files-tab.tsx:247)  
   A selected file beyond the first 500 entries is not mounted at all. For example, opening a direct route to entry 1000 leaves the expanded sidebar directory showing no selected row until the user manually clicks “show more.” Include the selected entry in the capped window or automatically reveal the directory when its selected path lies outside the first 500; add a routed-selection test alongside the current row-count tests.

## Verified OK

- History parsing is correctly invalidated by immutable message-array replacement; copy-on-write tool-result patches preserve unaffected block identities and do not mutate the base history.
- WeakMap caches are collectable with their source arrays/objects and do not introduce unbounded strong-reference retention.
- `advanceMarkdownSplit` matched full scanning across fenced blocks, lists, tables, trailing newlines, arbitrary prefix chunks, and non-prefix resets; a 100,000-document randomized probe also matched.
- Memoized chat rows receive stable primitive/object props during normal streaming, so unchanged rows genuinely skip rendering.
- The rAF auto-scroll checks pin state again inside the callback, coalesces updates, cancels on unmount, and does not access DOM APIs during SSR.
- Sidebar per-pane selectors preserve unaffected row references; pane grouping is node-scoped and WeakMap-backed.
- Persist serialization deduplication suppresses streaming writes while still persisting preference changes; the no-`window` path falls back safely through Zustand.
- Files-tree context and drag/drop handler memoization are effective for normal query refreshes.
- Verification: `packages/panels` 604/604, `packages/stores` 327/327, and the FE sidebar suite 26/26 tests passed.