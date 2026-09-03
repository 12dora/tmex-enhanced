# FIX-A：终端渲染 review 修复结果

## 结论

已修复 review 发现的四个问题，并为每个问题增加回归测试。滚动位移复用仍然保留，真实 WASM 基准的三个滚动场景均保持 `full=0/200`，且平均耗时低于 `0.1 ms`。

## 修复内容

### 1．同步输出期间滚动吞掉真实脏行

- 在 `TerminalRenderCoordinator` 中增加独立的 `noteOutput()`，将“自上帧起发生过写入”与“立即排渲染帧”拆开。
- `GhosttyTerminalController.write()` 在每次 WASM 写入成功后立即记录输出状态；DECSET 2026 激活时仍不立即排帧，150 ms 兜底仅负责排帧。
- 因此，同步输出期间用户滚动触发的帧会将 `scrollDelta` 降为 `0`，走完整行比对，不再以 `reuseReportedDirty=true` 丢弃已消费的 dirty 位。
- 新增真实 WASM 控制器测试：写入 `DECSET 2026 + CHANGED`、在兜底帧前滚一行，断言首帧读到 `CHANGED`，且紧接的 clean 帧仍保留新内容。

### 2．`scrollLines()` 边界返回值未传穿

- `InputBridgeHost.scrollLines` 与 `CompatibleTerminalLike.scrollLines` 的返回类型改为 `boolean | void`。
- 本地视口手势现在返回宿主的真实 boolean；旧宿主返回 `void` 时仍按历史行为视为已消费。
- 新增桥接层的 `false` 传穿与 `void -> true` 兼容测试，并在控制器层覆盖 scrollback 顶部、底部的返回值和不排帧语义。

### 3．2000 行 LRU 截断长选区

- 无选区时仍使用 `max(2000, rows * 20)` 的有界 LRU。
- 选区活动时，缓存上限临时扩展到终端当前 `scrollbar.total`；生产路径的绝对行键均落在该有界区间内，因此活动选区行不会被 2000 行上限提前淘汰。
- 选区结束的当帧立即恢复普通上限并执行淘汰，缓存不会长期维持扩展状态。
- 新增超过 2000 个有效绝对行的选区复制测试，断言开头行仍在且序列化文本不丢失，选区结束后缓存回落到 2000 行。

### 4．跨视口边界的软换行链接丢失

- 链接 overlay 仍只按 150 ms 节流扫描，但会将它已经按需构建的可见行模型写入 LRU。这不会恢复每帧无条件填充全视口的开销。
- `getLineModel()` 优先使用当前可见行，避免 overlay 回填后在同一绝对行内容变化时读到旧缓存。
- 新增 10×3 真实 WASM 测试：URL 跨两个软换行，滚动到续行处于视口顶部后，断言续行仍有下划线且 `linkAt()` 返回完整 URL。

## 验证结果

| 项目 | 结果 |
|---|---|
| `packages/ghostty-terminal && bun test` | `278 pass / 0 fail`（基线 272，新增 6） |
| `packages/ghostty-terminal && bun test --randomize` | seed `3091478608`，`278 pass / 0 fail` |
| `packages/terminal-ui && bun test` | `379 pass / 0 fail` |
| `packages/panels && bun test` | `786 pass / 0 fail`（并行任务已新增其他测试） |
| 三个包 `bunx tsc --noEmit -p .` | 均为 `0 error` |
| `bunx biome check` | 全部改动文件通过 |
| `git diff --check` | 通过 |
| `bun scripts/complexity/gate.ts` | `ok (1243 files, 11640 functions)` |

## 渲染桥基准

`packages/ghostty-terminal/bench/render-bridge.bench.ts`，120×40，200 个计量帧：

| 场景 | mean | p50 | p95 | dirtyRows/frame | full |
|---|---:|---:|---:|---:|---:|
| `scroll +1 line/frame` | `0.042 ms` | `0.041 ms` | `0.047 ms` | `1.0` | `0/200` |
| `scroll +3 lines/frame` | `0.091 ms` | `0.088 ms` | `0.095 ms` | `3.0` | `0/200` |
| `scroll -1 line/frame` | `0.040 ms` | `0.040 ms` | `0.044 ms` | `1.0` | `0/200` |

## 改动文件

- 实现：`terminal-render-coordinator.ts`、`terminal.ts`、`terminal-input-bridge.ts`、`types.ts`。
- 测试：`terminal-render-coordinator.performance.test.ts`、`terminal-input-bridge.test.ts`、`terminal.scroll-raf.test.ts`、`terminal.canvas.test.ts`、`terminal.synchronized-output-scroll.test.ts`。

`types.ts` 未出现在文件范围的枚举中，但任务正文明确要求修正其中的 `CompatibleTerminalLike`；本次仅修改了该接口的一行返回类型及 Biome 兼容说明。
