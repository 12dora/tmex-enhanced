# Exploration X2 — Frontend terminal performance report

## Hot path summary

`WebSocket ArrayBuffer → Uint8Array view → Borsh envelope copy → TermOutput data copy → pane sink/coalescer → LF normalization → WASM copy → rAF → render-state cell scan → Canvas`

Live output does not use base64 or `TextDecoder`; the main costs are byte normalization, repeated WASM reads, canvas calls, and history replay.

## Findings

### HIGH value — Live LF normalization is two-pass and allocation-heavy

Locations: [`normalization.ts:14`](/Users/konata/code/tmex-enhanced-wt-r6/packages/terminal-ui/src/components/normalization.ts:14), lines 14–47; [`terminal-snapshot.ts:194`](/Users/konata/code/tmex-enhanced-wt-r6/packages/terminal-ui/src/components/terminal-snapshot.ts:194), lines 194–197.

For every live chunk containing bare LF, the code scans the entire buffer once to count CRs, allocates a new buffer, then scans and copies the entire buffer again. With the default 32 KiB coalescer threshold, a 10 MiB `y\n` stream becomes 320 normalizer calls and 320 allocations.

Bun measurement: 10 MiB split into 320 × 32 KiB chunks took 192–194 ms and produced 15 MiB of output. The same 10 MiB stream took about 262–265 ms for Ghostty parsing, so normalization alone consumed roughly three-quarters of the parser-side time in this workload.

Proposed fix: use a stateful reusable normalizer buffer and emit normalized chunks in one pass, preserving `previousEndedWithCR` across chunks. Longer term, move the LF/CR handling into the terminal parser or make the gateway provide canonical line endings.

Expected gain: removes the second scan and 320 short-lived arrays in this benchmark; likely saves tens to roughly 100 ms per 10 MiB and reduces GC pressure.

Risk: CR/LF behavior at chunk boundaries must remain byte-for-byte compatible.

Net line change: approximately +15 to +30 lines.

### HIGH value — Dirty-row tracking happens after a full cell walk

Locations: [`render-state.ts:712`](/Users/konata/code/tmex-enhanced-wt-r6/packages/ghostty-terminal/src/render-state.ts:712), lines 712–915; [`terminal-render-coordinator.ts:186`](/Users/konata/code/tmex-enhanced-wt-r6/packages/ghostty-terminal/src/terminal-render-coordinator.ts:186), lines 186–231.

`iterateRows()` still visits every row and every cell. `readRowCells()` performs multiple WASM reads per cell, builds a temporary cell array, and only afterward compares rows and downgrades the frame to `partial` or `clean`. Unchanged rows reuse their cell objects, but the WASM reads and temporary arrays have already happened; `Array.from(iterateRows())` also creates another per-frame row array.

Existing render-bridge measurement at 120×40:

- Full update: mean 1.139 ms/frame.
- One dirty row: mean 1.004 ms/frame.
- No-write clean frames: about 0.812 ms mean, 0.887 ms p95 in a separate run.

A 40× difference in changed rows produces only about a 12% render-bridge difference, showing that traversal—not painting—is dominating this layer.

Proposed fix: expose reliable dirty-row indices or row versions from Ghostty and check them before reading cells. When a row is clean and geometry is unchanged, reuse the previous row directly; retain the current full-scan fallback for ABI versions without dirty metadata.

Expected gain: one-row updates could skip roughly 39 rows / 4,680 cells at 120×40, saving about 0.8–1 ms per frame and scaling better across split panes.

Risk: incorrect dirty metadata could leave stale pixels, especially around scrolling, wrapping, and resize; tests need explicit fallback coverage.

Net line change: approximately +15 to +35 lines across the TypeScript/WASM bridge.

### HIGH value — Local selection drag synchronously runs the full render path

Locations: [`terminal-pointer-handlers.ts:157`](/Users/konata/code/tmex-enhanced-wt-r6/packages/ghostty-terminal/src/terminal-pointer-handlers.ts:157), lines 157–181; [`terminal-selection.ts:134`](/Users/konata/code/tmex-enhanced-wt-r6/packages/ghostty-terminal/src/terminal-selection.ts:134), lines 134–152; [`terminal.ts:165`](/Users/konata/code/tmex-enhanced-wt-r6/packages/ghostty-terminal/src/terminal.ts:165), lines 165–167.

Every drag `mousemove` calls `TerminalSelection.update()`, which calls `context.render()` synchronously. That enters `renderCoordinator.renderNow()`, rescans all rows/cells, recomputes selection text, updates the snapshot, and invokes CanvasRenderer. Pointer moves are not rAF-coalesced and repeated events within the same cell are not skipped.

At 120 pointer events/second, the measured 0.8–1 ms render-bridge cost alone consumes roughly 96–120 ms of CPU time per second per terminal, before canvas work.

Proposed fix: add a selection-only repaint path using cached `renderedRows` and `lineCache`, and schedule selection changes through rAF. Ignore updates that remain in the same cell, and compute selection text only when the anchor/focus actually changes or when copy is requested.

Expected gain: removes the full WASM cell scan from each drag event and limits selection painting to approximately one update per display frame.

Risk: selection may lag by one frame; auto-scroll and output/resize races must still force a full render.

Net line change: approximately +15 to +30 lines.

### HIGH value — Each history page replays the entire accumulated history

Locations: [`TerminalSurface.ts:236`](/Users/konata/code/tmex-enhanced-wt-r6/packages/terminal-ui/src/components/TerminalSurface.ts:236), lines 236–245; [`terminal-snapshot.ts:115`](/Users/konata/code/tmex-enhanced-wt-r6/packages/terminal-ui/src/components/terminal-snapshot.ts:115), lines 115–133.

Every fetched history page immediately calls `writeSnapshot()`, which resets Ghostty, resizes it, concatenates all pages received so far, reparses them, and requests a full repaint. This is O(P²) over a paging session.

Measured with 22 pages of approximately 126.6 KiB each using the real Ghostty parser:

- Current per-page replay: 522–542 ms.
- One final replay after all pages: 45–46 ms.

The benchmark’s `forceFullRepaint()` was a no-op, so actual browser cost is higher because full canvas repainting was excluded.

Proposed fix: batch validated history pages during a short fetch burst and rebuild the terminal once, or add a server/API response that returns multiple pages together. Preserve immediate commit for the final page or request completion.

Expected gain: the measured 22-page sequence improved by roughly 11× and changes cumulative replay from O(P²) toward O(P).

Risk: older history becomes visible with a small delay, and batching must preserve live-output ordering and rebase behavior.

Net line change: approximately +10 to +25 lines.

### MEDIUM value — Canvas rendering issues one draw call per glyph cell

Locations: [`canvas-renderer.ts:246`](/Users/konata/code/tmex-enhanced-wt-r6/packages/ghostty-terminal/src/canvas-renderer.ts:246), lines 246–300; [`canvas-renderer.ts:523`](/Users/konata/code/tmex-enhanced-wt-r6/packages/ghostty-terminal/src/canvas-renderer.ts:523), lines 523–557.

The renderer correctly supports partial dirty rows, but `drawRowForeground()` calls `fillText()` separately for each visible glyph cell. There is no application-level glyph atlas or text-run batching; `fontVariants` caches only the font CSS strings.

For dense 120×40 content such as `cat bigfile`, this is up to 4,800 `fillText()` calls per full frame, or roughly 288,000 calls/second at 60 FPS per pane. This is a static upper bound; sparse output such as `yes` has fewer visible glyphs but still scans every cell for backgrounds.

Proposed fix: merge adjacent narrow cells with identical foreground, font, and decoration state into text runs and issue one `fillText()` per run. Keep separate handling for wide characters, block elements, and decorated cells; an atlas can be considered later if run batching is insufficient.

Expected gain: plain rows could drop from approximately 120 calls to one or a few calls per row.

Risk: Unicode graphemes, wide cells, decorations, and glyph overflow make overly aggressive batching visually unsafe.

Net line change: approximately +20 to +40 lines.

### MEDIUM value — Borsh decoding copies live bytes twice

Locations: [`client.ts:249`](/Users/konata/code/tmex-enhanced-wt-r6/packages/ws-client/src/client.ts:249), lines 249–255; [`protocol-dispatcher.ts:43`](/Users/konata/code/tmex-enhanced-wt-r6/packages/ws-client/src/protocol-dispatcher.ts:43), lines 43–72; [`codec.ts:61`](/Users/konata/code/tmex-enhanced-wt-r6/packages/shared/src/ws-borsh/codec.ts:61), lines 61–84; [`transport-message-decoder.ts:125`](/Users/konata/code/tmex-enhanced-wt-r6/packages/ws-client/src/transport-message-decoder.ts:125), lines 125–132.

`new Uint8Array(event.data)` is a view and does not copy. However, runtime identity checks showed:

- `decodeEnvelope()` returns a payload that does not share the frame buffer.
- `decodePayload(TermOutputSchema)` returns `data` that does not share the envelope payload buffer.

A Bun benchmark decoding ten 1 MiB `TERM_OUTPUT` frames took approximately 29.7–30.5 ms and copied roughly 20 MiB of byte payloads in total, before the additional copy into WASM.

Proposed fix: add a validated zero-copy decoder for the envelope and `TermOutput` that returns `subarray()` views for byte fields. Keep the generic schema decoder for control/history messages and ensure the coalescer retains the backing frame as it already does.

Expected gain: removes two JS byte copies per live frame and reduces allocation/GC pressure; the measured 10 MiB decode cost is a likely upper bound for the saving.

Risk: custom wire parsing can drift from the schema and must retain strict bounds validation.

Net line change: approximately +20 to +50 lines, depending on whether borrowed-byte support is added to the schema library.

### MEDIUM value — Output coalescing only spans one task

Locations: [`pane-output-coalescer.ts:70`](/Users/konata/code/tmex-enhanced-wt-r6/packages/ws-client/src/pane-output-coalescer.ts:70), lines 70–90 and 129–135; [`terminal.ts:320`](/Users/konata/code/tmex-enhanced-wt-r6/packages/ghostty-terminal/src/terminal.ts:320), lines 320–344.

The default scheduler uses `queueMicrotask()`, so it combines synchronous pushes in one task but does not combine pushes arriving in later tasks. A probe produced one 2-byte emission for two same-task pushes, but separate 1-byte emissions for pushes separated by `setTimeout()` tasks.

Therefore, rAF coalesces the actual paint, but separate WebSocket messages can still cause separate normalizer calls, WASM writes, mode checks, and render scheduling.

The existing write benchmark measured the same 640 KiB total payload at 11.05 ms for 10,000 × 64-byte writes versus 10.05 ms for 1,000 × 640-byte writes.

Proposed fix: use a bounded time/byte scheduler, such as rAF or a 1–4 ms budget, while retaining immediate flushes before reset/history/snapshot events. Make the maximum added output latency explicit.

Expected gain: fewer WASM writes, mode probes, and normalizer allocations during packet-heavy streams; the measured small-write improvement is about 9%.

Risk: output may be delayed by up to one frame, which could affect terminal echo latency under low-throughput input.

Net line change: approximately +5 to +15 lines.

### LOW value — Direct DataChannel reassembly copies every fragment twice

Locations: [`fragment-core.ts:103`](/Users/konata/code/tmex-enhanced-wt-r6/packages/shared/src/link/fragment-core.ts:103), lines 103–137; [`data-channel-carrier.ts:99`](/Users/konata/code/tmex-enhanced-wt-r6/packages/ws-client/src/direct/data-channel-carrier.ts:99), lines 99–112.

Each inbound fragment is copied with `.slice()`, then all pieces are copied again into the completed frame. A 1 MiB frame uses 17 fragments; a Bun probe measured 100 frames in 22.1 ms, or approximately 0.221 ms per MiB frame.

Proposed fix: allocate one bounded reassembly buffer and copy each fragment directly into its final offset, tracking received indices separately. Preserve the current limits and timeout behavior.

Expected gain: removes one full-frame copy and 17 short-lived piece arrays per 1 MiB frame.

Risk: out-of-order fragments, duplicates, and failure cleanup must remain correct.

Net line change: approximately +20 to +40 lines.

### LOW value — Scrollback memory is bounded but multiplied per split pane

Locations: [`ghostty-wasm.ts:60`](/Users/konata/code/tmex-enhanced-wt-r6/packages/ghostty-terminal/src/ghostty-wasm.ts:60), lines 60–85; [`terminal.ts:173`](/Users/konata/code/tmex-enhanced-wt-r6/packages/ghostty-terminal/src/terminal.ts:173); [`useTerminalBootSurface.ts:37`](/Users/konata/code/tmex-enhanced-wt-r6/packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts:37), lines 37 and 171.

The UI requests 10,000 scrollback lines per terminal. Because controllers are initially created at 80 columns, that converts to 19 × 576 KiB, approximately 10.69 MiB of Ghostty scrollback budget per terminal. Four split panes can therefore grow to roughly 42.8 MiB before canvas and JS allocations; resizing wider does not increase the byte budget and reduces the effective retained-line count.

Proposed fix: use a shared memory budget or a smaller default for background split panes, while retaining the larger limit for the focused pane. Make the limit configurable if long scrollback is important.

Expected gain: lower WASM memory growth and pressure on mobile or multi-pane sessions.

Risk: users may lose older scrollback sooner.

Net line change: approximately +10 to +20 lines.

## Checked and already fine

- Live WebSocket output is binary and does not use base64 or `TextDecoder`; `TextDecoder` is limited to legacy history decoding.
- `writeVt()` uses bulk WASM writes and a reusable scratch buffer for payloads up to 256 KiB; there are no per-byte WASM calls.
- `TerminalRenderLoop` coalesces pending paints with rAF, and CanvasRenderer skips main-canvas work for clean frames.
- Font measurement runs on resize, not per glyph; font variants and CSS colors are cached.
- Pane output does not update Zustand state per chunk; the sink writes imperatively, so device-console React components do not re-render for every output frame.
- Resize handling is rAF-coalesced and additionally debounced by 150 ms.
- Input is immediate: `onData → sendInput → Borsh encode → WebSocket send`; a Bun probe measured approximately 2.1 µs per single-key payload plus envelope encoding, excluding network latency.
- Mouse-reporting motion has same-cell deduplication; the expensive unthrottled path is local text-selection drag.
- Direct carrier backpressure, fragment size limits, and queued-byte limits are bounded.
- `LinkMux` is not on the browser pane-output path; the direct pane carrier uses the fragmenter directly.

## Verification

Ran without modifying the worktree:

- 111 tests across 7 files passed.
- 35 tests across 4 files passed.
- Render bridge benchmark, VT write benchmark, history paging benchmark, Borsh decode probe, normalization probe, and direct-fragment probe all completed under Bun.
- No production tmex installation or production port was touched.