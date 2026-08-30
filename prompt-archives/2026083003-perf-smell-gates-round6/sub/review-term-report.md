## Findings

- **should-fix** — [packages/ghostty-terminal/src/canvas-renderer.ts:455](/Users/konata/code/tmex-enhanced-wt-r6/packages/ghostty-terminal/src/canvas-renderer.ts:455): `drawSelectionOnly()` bypasses the renderer’s DPR/cell-dimension synchronization. After browser zoom or moving between displays, if the terminal grid remains the same size, selection dragging continues using the old backing-store dimensions until another full render occurs; reproduced with DPR 1→2, where the canvas remained 40 px instead of 80 px and a cell remained 10×20 instead of 20×40. The DPR test at [canvas-renderer.layers.test.ts:259](/Users/konata/code/tmex-enhanced-wt-r6/packages/ghostty-terminal/src/canvas-renderer.layers.test.ts:259) exercises `renderFrame()`, not the optimized selection-only path, so it misses the regression. Before using the fast path, compare current DPR/cell dimensions against the last full-render layout and call `renderNow()` on mismatch; add a direct DPR-change test for `drawSelectionOnly()`.

## Verified OK

- Row dirty consume-and-clear preserves viewport scrolling, resize/reflow, theme changes, alternate screen transitions, and row content in real-WASM differential tests.
- Cursor metadata is still read every full frame and the cursor layer updates even when row dirty state is `clean`.
- Interrupted row iteration clears `previousRows` before consuming dirty bits and writes the cache back only after complete traversal.
- Selection rAF requests are coalesced and canceled by full rendering, `cancelPending()`, and disposal; selection text is derived from the latest selection state.
- LF normalization scratch views are consumed synchronously by live writes; snapshot/history paths either write synchronously or copy into the combined payload before another normalization call.
- History batching preserves page ordering, flushes before live output, and makes delayed callbacks inert after replacement or disposal.
- Pane-output control events flush buffered output before reset/history/snapshot/rebase/sink changes; reset/disposal discards buffered zero-copy views.
- `decodeEnvelopeView` and `decodeTermOutputView` preserve schema field order, byte offsets, trailing-byte behavior, and truncation bounds while retaining the intended source-buffer views.
- Full suites passed for terminal-ui (323), shared (376), and ws-client (268); Ghostty’s affected tests passed 80/80. Its full suite reached 197 passes, with four unrelated failures because the read-only sandbox rejected temporary-directory creation.