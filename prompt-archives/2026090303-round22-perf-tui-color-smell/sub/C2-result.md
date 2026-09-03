# C2 结果：render bridge 读取层扁平化

## 结论

T4 已完整落地，未修改 WASM 二进制或 `vendor/ghostty`。整屏更新在本机由改前首次实测的 mean 1.178 ms、p50 1.076 ms 降至最终三次复测中位数 mean 0.648 ms、p50 0.568 ms，分别为 1.82×、1.89×。滚动与 dirty 语义指标逐项保持不变。

## 改动

- `packages/ghostty-terminal/src/ghostty-wasm.ts`
  - 按当前 WASM 导出表补齐 `ghostty_render_state_row_cells_get_multi` 与 `ghostty_cell_get_multi` 的类型：前者 `(i32, i32, i32, i32, i32) -> i32`，后者 `(i64, i32, i32, i32, i32) -> i32`。
  - 文件仍为 1623 行，未放宽复杂度 allowlist。
- `packages/ghostty-terminal/src/render-state-read.ts`（新增，584 行）
  - 将 RAW、GLEN、STYLE、FG、BG 配成一组常驻 `get_multi` 查询，将 WIDE、HAS_TEXT 配成另一组；keys、values、written、各输出结构和 grapheme 缓冲均位于同一块持久连续 scratch。
  - `DataView` 提到 cell 循环外；仅 grapheme 超过 64 个 codepoint、`allocBytes` 可能触发 `memory.grow` 时重新获取。
  - 在单一 flat loop 内完成 style flag 解包、颜色 key 打包、intern、cell 引用复用比较。
  - 所有批量读取直接内联检查 `result !== 0`，并按失败字段保留原异常文本。
  - 当前 ABI 在可选 FG/BG 缺失时返回 `-2` 并停止；FG 缺失时只补读尚未尝试的 BG，保持四种组合（无颜色、仅 FG、仅 BG、FG+BG）的原 `null` 语义。
  - dirty 位仍在读取后立即且仅写回一次；行级提前复用和 shifted baseline 调用顺序未变。
- `packages/ghostty-terminal/src/render-state.ts`
  - 保留 snapshot/meta、生命周期和 `resolveShiftBaseline` / `settled[i+d]` 编排，将 row/cell 读取委托给新模块。
  - 952 行降至 431 行，低于 900 行门禁。
  - `isCellUnchanged` / `reuseUnchangedRow` 继续从原入口导出，既有调用与测试无需修改。
- `packages/ghostty-terminal/src/render-state-color.ts`
  - 增加按已打包 RGB key 内插的入口；缓存上限、清表时机与对象引用语义不变。
- `packages/ghostty-terminal/src/render-state-read.test.ts`（新增）
  - 5 个用例覆盖两组 `get_multi` 的逐 cell 调用、无 FG 时的 BG 回退、`>64` grapheme 强制 `memory.grow`、两组批量读取的错误传播。

`buildRowText` 仍使用原 `+=` 实现；未改 bench、shift helper、WASM 资产或任务禁改文件。

## 基准

命令：`bun packages/ghostty-terminal/bench/render-bridge.bench.ts`，Bun 1.3.14，120×40，200 个 measured frames。

改前在任何代码变更前连续跑了两次。首次结果如下；第二次 full-update mean/p50 为 1.264/1.093 ms，说明共享 worktree 并行负载主要影响 mean，p50 与探索报告的约 1.06 ms 一致。改后列为最终代码连续三次运行各指标的中位数；full-update mean 范围为 0.620–0.652 ms。

| 场景 | 改前 mean / p50 / p95（ms） | 改后 mean / p50 / p95（ms） | dirty/full 语义（前后相同） |
|---|---:|---:|---|
| full update | 1.178 / 1.076 / 1.746 | 0.648 / 0.568 / 0.908 | dirtyRows=40.0；non-full=0/200 |
| single dirty row | 0.068 / 0.065 / 0.086 | 0.041 / 0.039 / 0.049 | dirtyRows=0.9；non-full=200/200 |
| clean frames | 0.007 / 0.006 / 0.011 | 0.006 / 0.006 / 0.008 | dirtyRows=0.0；non-full=200/200 |
| 20% dirty rows | 0.286 / 0.265 / 0.362 | 0.175 / 0.165 / 0.184 | dirtyRows=8.0；non-full=200/200 |
| scroll +1 | 0.046 / 0.044 / 0.061 | 0.033 / 0.032 / 0.038 | dirtyRows=1.0；full=0/200 |
| scroll +3 | 0.107 / 0.095 / 0.139 | 0.070 / 0.064 / 0.070 | dirtyRows=3.0；full=0/200 |
| scroll -1 | 0.043 / 0.042 / 0.047 | 0.033 / 0.032 / 0.037 | dirtyRows=1.0；full=0/200 |

## 验证

- 改前：`cd packages/ghostty-terminal && bun test`：280 pass / 0 fail；tsc 为 9 个既有错误，全部来自并行任务文件 `terminal-render-coordinator.force-repaint-shift.test.ts` 的 Bun 测试全局类型。
- 最终：`cd packages/ghostty-terminal && bun test`：329 pass / 0 fail，1245 次断言，43 个文件。
- 指定 hard-invariant 测试加新增测试：35 pass / 0 fail。
- `bunx tsc --noEmit -p .`：0 error，未高于基线。
- `bunx biome check src/render-state.ts src/render-state-read.ts src/render-state-read.test.ts src/render-state-color.ts src/ghostty-wasm.ts`：通过。
- `bun scripts/complexity/gate.ts`：`complexity gate ok (1284 files, 11886 functions)`；未修改 `scripts/complexity/allowlist.json`。
- 当前 WASM SHA-256 仍为元数据锁定值 `7bde84bf8e962a3abecdd936bb7bb1a5e97548cd20d42d7d9c49567ddf9e4c9b`。

无未完成项。
