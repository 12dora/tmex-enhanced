# Plan 00 结果：pane-stream-parser 状态机拆分

## 完成情况

行为保持重构已落地。公开 API（`createPaneStreamParser` / `PaneStreamParser` / 回调类型）未改名、未改签名。

## 文件

**改：**
- `apps/gateway/src/tmux-client/pane-stream-parser.ts`：557 行闭包 → 92 行工厂 + `processByte` switch 分发

**新（实现）：**
- `pane-stream/parser-state.ts` — `ParserPhase` 枚举、`ParserState` 结构体、上限常量、溢出/复位辅助
- `pane-stream/normal-handler.ts` — 普通字节 + BEL
- `pane-stream/esc-handler.ts` — ESC 分发到 OSC / ESC k / DCS / CSI
- `pane-stream/csi-handler.ts` — CSI 旁路观察，2031h/l
- `pane-stream/osc-handlers.ts` — OSC 状态机 + emitOsc（title / path / kitty / clipboard / notify / 133）+ ESC k 标题
- `pane-stream/tmux-passthrough-handler.ts` — DCS `tmux;` 探测、解包、溢出忽略、不完整 CSI 回填

**新（测试）：**
- `pane-stream-parser.golden.test.ts` — 整段 vs 逐字节喂入，callback+output 深等
- `pane-stream/*.test.ts` — emitOsc / 2031 / DCS 前缀 / 溢出辅助

## 验证

- 重构前 golden + 既有 parser 测试：82 pass
- 重构后 parser 相关：100 pass / 0 fail（既有 42 + golden 40 + 抽出模块 18）
- `bunx biome check` 本批 12 文件 clean
- 本批 tsc：无 pane-stream 错误。全包 tsc 基线 37，结束后约 39，增量来自并行批次（`ws/device-connection-registry.ts` 重复标识等），不在本范围
- 全包 `bun test` 新增失败均在 `ws/index.test.ts`（BE-1），与本拆分无关

## Bug 修复

无。刻意保持原语义，包括 OSC 99 `d` 缺省视为 done、`String(phase) === 'csi'` 打败 TS 收窄。
