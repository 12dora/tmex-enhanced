# grok-driver-history result

Harness `--capture-seq` now counts `SEQ_<n>` from both `TERM_HISTORY` (0x306) and live `TERM_OUTPUT` (0x305).

## What changed

- `scripts/hub-e2e/driver/seq.ts`
  - `mergeSeqNumbers` unions two number lists, unique + sorted.
  - `analyzeSeqSources(historyText, outputText, …)` reuses the existing gap/contiguity logic and reports unique-marker counts `fromHistory` / `fromOutput` (overlap is allowed; `found` is the union).
- `scripts/hub-e2e/driver/seq.test.ts`
  - Overlapping history+live, history-only, live-only, interior gap across the union, failover-style 1..400 history with 200..400 live, custom prefix.
- `scripts/hub-e2e/driver/terminal.ts`
  - Decodes `TermHistorySchema` vs `TermOutputSchema` into separate buffers.
  - Still logs `ws kind=… seq=…` for every frame (including history).
  - Capture JSON now includes `fromHistory` and `fromOutput`.
- `scripts/hub-e2e/build-driver.sh` regenerated `driver-dist/`.

`run.sh` was not touched.

## How verified

- TDD: new `seq.ts` tests were RED (`mergeSeqNumbers` export missing), then GREEN.
- `bun test scripts/hub-e2e/driver/` — **38 pass / 0 fail**.
- `bunx biome check` on `seq.ts`, `seq.test.ts`, `terminal.ts` — clean.
- No package `tsc` (scripts are outside `tsconfig.json` include).
- `scripts/hub-e2e/build-driver.sh` — bundled; `driver-dist/terminal.js` contains `KIND_TERM_HISTORY`, `analyzeSeqSources`, and JSON `fromHistory`/`fromOutput`.

## Open issues

- Chunked `KIND_CHUNK` reassembly is still not implemented. Default max frame is 1MiB; SEQ_1..400 plus typical pane scrollback fits in one `TERM_HISTORY` frame, so H2/L5 is not blocked. Huge scrollback above 1MiB would still be missed.
