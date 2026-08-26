# Pane Stream Parser 状态机拆分 Implementation Plan

> 行为保持重构。不改公开 API。先 golden，再拆文件。

**Goal:** 把 `createPaneStreamParser` 闭包状态机拆成显式 `ParserState` + 按协议族分文件的 handler，callback 顺序与输出字节与拆分前完全一致。

**Architecture:** `pane-stream-parser.ts` 只保留公开类型、工厂和 `push` 循环（跨 chunk 的 `ParserContext`、`processByte` 分发）。`pane-stream/parser-state.ts` 持有 phase 枚举、状态结构体、上限常量和溢出/复位辅助。handler 按字节协议族切开，通过共享 `ParserContext`（`state` / `options` / `output` / `processByte`）协作，以保留 DCS 解包后递归回喂、CSI 非法字节重入等现有控制流。

**Tech Stack:** Bun + TypeScript，既有 `bun:test`。

---

## 背景与注意事项

- 父计划：`prompt-archives/2026082700-code-smell-cleanup` 批次 BE-4。
- 公开导出必须保持：`PaneStreamNotification`、`PromptMarker`、`PaneStreamParserOptions`、`PaneStreamParser`、`createPaneStreamParser`。下游（control-mode-subscription、run-command、pane-emulator 等）只从 `pane-stream-parser.ts` 取类型/工厂。
- 关键行为锚点（不得漂移）：
  - OSC 吞掉、CSI 原样回填
  - tmux DCS passthrough 解包（内层 ESC 翻倍）后递归 `processByte`；解包期间 `inTmuxPassthrough` 抑制 CSI 2031 上报；解包若停在不完整 CSI 则回填并复位
  - OSC 99 kitty 按 id 聚合、最多 16 条 pending（FIFO 淘汰）
  - 溢出上限：OSC kind 16B、OSC payload 8KB、title 8KB、DCS 64KB、CSI 64B；warn 只打一次
- 验证：`apps/gateway` 下 `bunx tsc --noEmit -p .` 错误数不高于基线 37；`bun test` 无新增失败（已知 `local-external-connection.test.ts` 硬编码 `/Users/krhougs`）；`bunx biome check` 只扫本批文件。
- 不 commit；不碰范围内以外的 gateway 文件。

## Task 1: Golden tests（重构前必须绿）

**Files:**
- Create: `apps/gateway/src/tmux-client/pane-stream-parser.golden.test.ts`

覆盖现有测试里的代表性序列，外加容易在拆分时回归的边界：passthrough 末尾不完整 CSI、DCS 前缀失配、OSC kind 超长、kitty pending 淘汰、screen-title 中夹 ESC、UTF-8 OSC 52。

每个 fixture：`trace([whole])` 钉死 events+output；`trace(逐字节)` 与 whole 深等。

## Task 2: 抽出 state + handlers，主文件只做分发

**Create:**
- `apps/gateway/src/tmux-client/pane-stream/parser-state.ts`
- `apps/gateway/src/tmux-client/pane-stream/normal-handler.ts`
- `apps/gateway/src/tmux-client/pane-stream/esc-handler.ts`
- `apps/gateway/src/tmux-client/pane-stream/csi-handler.ts`
- `apps/gateway/src/tmux-client/pane-stream/osc-handlers.ts`
- `apps/gateway/src/tmux-client/pane-stream/tmux-passthrough-handler.ts`

**Modify:**
- `apps/gateway/src/tmux-client/pane-stream-parser.ts` — 公开类型 + `createPaneStreamParser` + `processByte` switch

控制流从原 if 链一对一搬迁，不改分支语义。

## Task 3: 抽出模块的便宜单测

**Create:**
- `apps/gateway/src/tmux-client/pane-stream/osc-handlers.test.ts`（`emitOsc` 各 kind）
- `apps/gateway/src/tmux-client/pane-stream/csi-handler.test.ts`（2031 识别 / passthrough 抑制）

## Task 4: 验证

- 既有 `pane-stream-parser.test.ts` + golden + 新单测全绿
- tsc 错误数 ≤ 37
- biome check 本批文件
