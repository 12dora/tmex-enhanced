# RV5 — Review: cancel in-flight upgrade with zero leftovers (backend) + restore/stop in the Nodes UI (frontend)

You are a strict but pragmatic code reviewer. Read-only. Output the full review as your FINAL MESSAGE.

Repo `/Users/konata/code/tmex-enhanced-wt-r13`. Diff: `sub/RV5-diff.patch` (commits `8692c19c` backend, `fcf26ffd`+`d70616ba` frontend). Specs: `sub/G7-prompt.md` (incl. the user's hard requirement: no half-downloaded garbage after cancel), `sub/O3-prompt.md`; reports: `sub/G7-result.md`, `sub/O3-result.md`. Prior context: `sub/G4-result.md`, `sub/G4b-result.md`.

Review for:
1. **Leftover files after cancel** on every path (target download cancel, staged-start cancel, aborted PUT body, entry job cancel during download / during push / after push before start, crash mid-cancel + prune): any path that can leave `.part`, txn dirs, staged `.tgz`/sidecar, or a cache `.tgz` without `.sha256`. Race between cancel and the download finishing / `commitStarted`; double cancel; cancel while another job shares the same download (last-waiter abort logic).
2. Security/authorization of the new `DELETE` routes (same gating as PUT/POST? open-mode standalone? managed build?), and whether a cancel can kill a running applier (`executing`) under any interleaving.
3. Frontend: restore-on-mount correctness (which rows are queried, concurrency, abort on unmount, no duplicate watchers when the list re-renders/gains nodes, no restore loops), per-node AbortController lifecycle, cancel button state per phase, `UPGRADE_CANCELLED` handling never producing a failure toast, batch tally with cancelled, interaction with the row/batch mutual exclusion from RV1.
4. Mixed versions: entry 1.1.12 + target 1.1.11 (has staged-package but no DELETE routes) → what the user sees when pressing Stop; entry 1.1.11 + target 1.1.12.

Classify as **blocker / should-fix / nit** with file:line and a concrete failing scenario; be concise; say briefly what is fine.
