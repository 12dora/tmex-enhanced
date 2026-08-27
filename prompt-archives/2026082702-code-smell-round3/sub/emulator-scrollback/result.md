# emulator-scrollback

## 背景

`packages/ghostty-terminal` 把 `createTerminal(cols, rows, scrollbackLines)` 从「把行数当字节」修成真正的行→字节预算后，gateway 的 `DEFAULT_SCROLLBACK = 5000` 不再被 PageList 下限夹成约 1129 行，而是每个 headless pane 真的按 5000 行分配（80 列约 5.5 MiB，200 列约 13.6 MiB）。所有 `HeadlessTerminal` 共用一块只增不减的 wasm 线性内存。

## 核验结论

| 主张 | 结果 |
| --- | --- |
| `PaneEmulator.render()` 只读 viewport | 成立：`this.terminal.render()` → `formatViewport`，不读 history |
| 历史分页走 tmux `capture-pane` | 成立：`pane-history-reader` / `session-commands.capturePaneText` |
| emulator scrollback 无人读 | 成立：`apps/gateway` 内 `readScrollbar` 零命中；`run-command*` 走 `tap` 字节流 + `render()` viewport；`read-screen` 的 `historyLines` 只在 capture fallback 里交给 tmux |
| wasm 单例、线性内存只增不减 | 成立：`getGhosttyBindings()` 缓存；`free()` 不缩 `memory.buffer` |

没有消费者按行读 emulator 回滚。最小可用值理论上是 0（viewport 仍完整）。取 **256**：几百行量级，覆盖 seed 多写的 `\r\n` 和偶发超高 pane；低于 ghostty PageList 下限（约 900–1100 行 / 创建时约 5.5 MiB），因此空闲创建成本与 0 相同，但灌满后不会再按 5000 行扩页。

## 改动

- `apps/gateway/src/tmux-client/pane-emulator-create.ts`：`DEFAULT_SCROLLBACK` `5000` → `256`
- `apps/gateway/src/tmux-client/pane-emulator-create.test.ts`：钉死默认值；50 个默认 emulator 灌 8000 行后，用 `getGhosttyBindings().buffer().byteLength`（即 `WebAssembly.Memory.buffer`）断言增量 `< 384 MiB`
- 未改 `pane-emulator.ts`（常量不在那里）
- 未改 `packages/ghostty-terminal`

## 实测（独立进程）

80 列、写 8000 空行：

- `scrollback=256` × 50：约 252 MiB（停在 PageList 下限）
- `scrollback=5000` × 50：约 652 MiB

TDD：改常量前两条都红（`5000 !== 256`；增量 `682885120` 不低于 `402653184`）；改后绿。

## 验证

- `cd apps/gateway && bun test src/tmux-client/pane-emulator-create.test.ts src/tmux-client/pane-emulator.test.ts`：21 pass / 0 fail
- `cd apps/gateway && bun test`：1869 pass / 0 fail（195 files）
- `bunx tsc --noEmit -p .`：25 errors，与基线一致，不含本次文件
- `bunx biome check --write` 于上述两个文件：clean

## 未做 / 注意

- **未**把默认值降到 0：行为等价（PageList 下限），256 表达「故意只要几百行」。
- ghostty PageList 仍会按约 1k 行 / 5.5 MiB 保底，256 挡不住这块下限；挡的是 5000 行预算在大量输出时继续 `memory.grow`。
- 测试从 `packages/ghostty-terminal/src/ghostty-wasm` 相对导入 `getGhosttyBindings`（包 exports 只有 `.` / `./headless`）。未改 ghostty-terminal。
