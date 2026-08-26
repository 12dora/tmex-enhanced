# Pane Stream Parser 状态机拆分 Prompt

日期：2026-08-27

## 上下文

code smell 清理批次 BE-4。`apps/gateway/src/tmux-client/pane-stream-parser.ts`（557 行）的 `createPaneStreamParser` 是单个闭包状态机：`push` 323 行、`processByte` 277 行嵌套 if/状态分支、`emitOsc` 129 行。工作目录为 git worktree `/Users/konata/code/tmex-enhanced-wt-smell`。其他 agent 并行改同一 worktree 的其他文件，禁止触碰 git 状态与范围外文件。

## 任务

行为保持重构：公共 `PaneStreamParser` 接口（`push` 等）与 callback 顺序必须字节级一致。

将闭包拆为：

- 主解析器：跨 chunk 缓冲、状态持久化、溢出上限、callback 时序
- 独立 handler：plain chars、ESC、CSI、OSC（title / kitty / clipboard / notifications）、DCS 与 tmux passthrough
- 解析状态用显式小型 state enum + struct，替换散落 boolean（若能减少分支）

建议新文件（均在 `apps/gateway/src/tmux-client/`）：

- `pane-stream/osc-handlers.ts`
- `pane-stream/csi-handler.ts`
- `pane-stream/tmux-passthrough-handler.ts`
- `pane-stream/parser-state.ts`

## 测试要求

重构前先加强测试：同一字节序列分别 (a) 整段喂入 (b) 在每个字节边界切开喂入，断言 callback 序列完全一致。golden 必须重构前后都通过。为抽出的模块补便宜的单测。

## 硬约束

- 不 `git commit` / `stash` / `checkout` / `add`
- 不改生成文件；不碰 production tmex、名为 `tmex` 的 tmux session、默认 tmux socket
- 只用 `bun`；验证临时实例不得占用生产端口
- 不改被其他模块使用的公开 API / 导出名（除非纯加法）
- 范围外：external-connection、pane-retention.ts、control-mode-*.ts
