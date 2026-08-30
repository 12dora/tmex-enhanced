# Review Report

## Findings

- **Should-fix — [apps/fe/src/lazy-chunk.tsx:41](/Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/lazy-chunk.tsx:41): retry escalation counts clicks rather than failed retries.** While an import is pending, the retry button remains active and each click increments `attempts`; on a slow connection, the third click can reload the page before any retry has failed. The counter also resets whenever `ChunkRetry` unmounts, allowing repeated failures to bypass the cap after navigating away and back. Track an in-flight request, increment the failure count only in the rejection handler, and persist the count per loader if the cap must survive remounts; extend [lazy-chunk.test.tsx:29](/Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/lazy-chunk.test.tsx:29) with deferred/rejected retry and reload-escalation coverage.

No blocker or nit findings.

## Verified OK

- Folder-tree `containers` are memoized from the same `layout` and `implicitRootNodeIds` passed to all three consumers, with correct invalidation dependencies.
- `placedNodeIds.has()` preserves the previous `placements.some()` semantics; folders are intentionally single-level, and implicit-root handling remains unchanged.
- `reorderDevicesOptimistically` matches both previous inline implementations for unknown IDs, skipped `sortOrder` values, remainder order, duplicates, and hidden-device submission.
- tmux `reorderById` preserves the previous window and pane ordering behavior, including unknown IDs and untouched remainder ordering.
- With installed `rehype-highlight@7.0.2`, `no-highlight` makes `language()` return `false`; remark tagging reaches `<code>` through `hProperties`.
- Guarded fenced blocks retain block styling, inline code remains unaffected, explicit-language blocks still highlight, and the whole-document threshold matches the stated policy.
- `lazyChunk` correctly converts the initial rejection into a resolved retry component, re-imports through the original loader, caches successful recovery, avoids accessing `window` during SSR rendering, and reuses existing fallback i18n keys.
- Fresh verification: 72 targeted Bun tests passed across six files with 0 failures.