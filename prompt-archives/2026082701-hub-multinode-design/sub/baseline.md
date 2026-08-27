# Phase 0 基线（2026-08-27 22:37，commit 4a14ff2）

| 包 | bun test 摘要 | tsc 错误数 |
|---|---|---|
| apps/gateway |  1472 pass  0 fail Ran 1472 tests across 164 files. [26.98s]  | 27 |
| apps/fe |  9 pass  0 fail Ran 9 tests across 2 files. [49.00ms]  | 0 |
| packages/shared |  141 pass  0 fail Ran 141 tests across 13 files. [40.00ms]  | 0 |
| packages/ws-client |  75 pass  0 fail Ran 75 tests across 9 files. [235.00ms]  | 0 |
| packages/stores |  101 pass  0 fail Ran 101 tests across 16 files. [51.00ms]  | 1 |
| packages/api-client |  34 pass  0 fail Ran 34 tests across 4 files. [16.00ms]  | 5 |
| packages/panels |  196 pass  0 fail Ran 196 tests across 10 files. [234.00ms]  | 0 |
| packages/app |  90 pass  0 fail Ran 90 tests across 13 files. [531.00ms]  | 1 |
| packages/terminal-ui |  205 pass  0 fail Ran 205 tests across 16 files. [42.00ms]  | 0 |
| packages/ui |  14 pass  0 fail Ran 14 tests across 2 files. [13.00ms]  | 0 |
| packages/notifications |  15 pass  0 fail Ran 15 tests across 3 files. [12.00ms]  | 0 |
| packages/theme |  6 pass  0 fail Ran 6 tests across 2 files. [23.00ms]  | 10 |

注：apps/fe 单测用 `bun test src/`（裸 bun test 会误拾 Playwright spec）；e2e 基线见记忆 e2e-baseline-failures。
