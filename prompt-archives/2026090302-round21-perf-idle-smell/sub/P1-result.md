# P1：终端 Canvas 与 render bridge 滚动性能结果

## 结果概览

本任务完成 F2、F3、F4，并补齐滚动桥与 Chromium Canvas 基准。纯滚动帧现在只读取新曝光行；Canvas 使用按行 run 批绘，并通过可见主画布与备用画布之间的 ping-pong 双缓冲完成单次纵向 copy；选区行模型缓存改为有界 LRU，常态滚动不再每帧急切构建全部行模型。

最终验证结果：

- `ghostty-terminal`：263 pass / 0 fail。
- `terminal-ui`：379 pass / 0 fail。
- `panels`：757 pass / 0 fail。
- 三个包的 `bunx tsc --noEmit -p .` 均为 0 error。
- 本任务 8 个变更文件的 `bunx biome check` 通过。

测试数量高于任务给出的基线，是因为本轮其他并行任务也在同一 worktree 增加了测试；最终结果以当前 worktree 的完整测试为准。

## F2：Canvas run 批绘

实现位置：

- `packages/ghostty-terminal/src/canvas-renderer.ts:398`：在 `resize()` 中测量 `x` 重复串的实际 advance，按 `clamp(floor(0.4 / |residual|), 1, cols)` 计算最大文本 run；残差较大的字体自动退化到单 cell 绘制。
- `packages/ghostty-terminal/src/canvas-renderer.ts:559`：缓存最后一次实际写入主 context 的 `fillStyle`，跳过重复赋值；字体同理。
- `packages/ghostty-terminal/src/canvas-renderer.ts:575`：连续同背景色的普通窄 cell 合并为一次 `fillRect`。
- `packages/ghostty-terminal/src/canvas-renderer.ts:625`：连续同前景色、同字体变体的普通窄 cell 合并为一次 `fillText`。
- wide、spacer、块元素和带 underline/strikethrough/overline 的 cell 均会断开 run；块元素和装饰线仍走原有逐 cell 路径。空窄 cell 在 run 内转换为空格，保持后续字形的网格位置。

像素回归覆盖：

- run 批绘与 `maxRun=1` 回退路径逐像素一致。
- 前景色、字体变体、空 cell、宽字符、spacer、块元素和装饰线边界均已覆盖。
- 相同背景的相邻 cell 确认合并为一个矩形。
- 连续第二帧验证 `font` / `fillStyle` 状态去重。

### Canvas 基准

命令：

```bash
cd packages/ghostty-terminal
bun bench/canvas.bench.mjs
```

环境：Playwright Chromium 145.0.7632.6，DPR 2，120×40，3965 个可见字形 cell。完整绘制使用批量采样并在每批后强制栅格完成；ping-pong 使用逐 rAF 的可见画布主线程提交耗时。

| 场景 | mean | p95 | 对比 |
|---|---:|---:|---:|
| 逐 cell 完整屏幕 | 5.034 ms | 5.700 ms | 基线 |
| run 批绘完整屏幕 | 1.557 ms | 1.680 ms | 3.23× |
| 逐 cell 前景 | 4.528 ms | 5.650 ms | 基线 |
| run 批绘前景 | 1.102 ms | 1.230 ms | 4.11× |
| 3912 次单字形 `fillText` | 2.771 ms | 3.134 ms | 基线 |
| 20-cell 字形 run | 0.618 ms | 0.692 ms | 4.48× |
| 单行 run 批绘 | 0.036 ms | 0.047 ms | — |

完整屏幕场景同时包含背景铺色等固定成本，因此整体收益为 3.23×；隔离 `fillText` 后复现了约 4.5× 的收益。

## F3：滚动感知的行复用与 Canvas blit

### render bridge

- `packages/ghostty-terminal/src/terminal-render-coordinator.ts:257` 使用相邻两次真实 `readScrollbar().offset` 的差值，不使用请求滚动量，因此顶端/底端 clamp 后不会产生虚假位移。
- 只有无输出、未执行 resize/reset/history 行失效时，协调器才把位移候选交给 `iterateRows()`。
- `packages/ghostty-terminal/src/render-state.ts:883` 仅在位移非零、绝对值小于视口行数、行列几何一致且 palette 未变时启用 shifted baseline。
- 复用行仍逐行消费并清除内核 dirty 位，但不再读取 cell；复用后的行对象写入新 `y`。新曝光行继续走原有完整读取路径。
- 只有完整迭代结束才发布 `appliedScrollDelta`；中断迭代不会留下可供 Canvas 使用的位移。
- 输出与滚动交错、resize/reset、palette 变化或非法位移均回退原有比较路径。

### Canvas 双缓冲

最初验证了常见的“两跳 scratch”实现，即 `main → scratch → main`。在强制栅格口径下，它为 4.161 ms，未优于 self-blit 的 4.088 ms，因此没有交付该实现。原因是第二次 copy 会立即依赖第一次跨 context copy 的结果，触发同步等待。

最终实现位于 `packages/ghostty-terminal/src/canvas-renderer.ts:810`：

1. 第一次有效滚动时才创建备用位图并插入图层，未滚动 pane 不承担额外 bitmap 内存。
2. 当前可见主画布把保留区域一次性复制到备用画布的目标位置。
3. 交换 `main` / `scratch` 角色与可见性，随后只在新的主画布上补画曝光行及既有的相邻保护行。
4. 下一帧反向复用两张画布，不再复制回原画布。
5. resize、DPR 变化、外部位图尺寸失效或 `drawImage` 不可用时强制全量重画。
6. `dispose()` 同时移除两张主/备用画布并释放备用位图。

逐 rAF 的可见画布基准中，最终 ping-pong blit 为 mean 0.055 ms、p95 0.100 ms；单行补画为 mean 0.036 ms。测试对连续两个方向的滚动都与全量重画像素 oracle 做了逐像素比较。

### render bridge 前后对比

命令：

```bash
cd packages/ghostty-terminal
bun bench/render-bridge.bench.ts
```

before 取自 EX1 在相同 120×40 / 200 帧场景的原始测量；after 为本任务最终代码的独立复测。

| 场景 | before mean / p95 | after mean / p95 | dirtyRows/frame | full frames | mean 收益 |
|---|---:|---:|---:|---:|---:|
| scroll +1 | 1.121 / 1.412 ms | 0.046 / 0.077 ms | 40.0 → 1.0 | 200/200 → 0/200 | 24.4× |
| scroll +3 | 0.960 / 1.040 ms | 0.097 / 0.109 ms | 40.0 → 3.0 | 200/200 → 0/200 | 9.9× |
| scroll -1 | 0.986 / 1.074 ms | 0.042 / 0.048 ms | 40.0 → 1.0 | 200/200 → 0/200 | 23.5× |

三种滚动场景均达到脏行数约等于实际滚动距离、`full=0/200`；mean 均低于 0.1 ms。

## F4：有界、懒填充的选区行模型缓存

实现位置：`packages/ghostty-terminal/src/terminal-render-coordinator.ts:34-35`、`:274-288`、`:400-424`。

- LRU 容量为 `max(2000, rows * 20)`。
- 无选区的普通渲染与滚动不再逐行构建并写入 `lineCache`。
- 选区活动期间先刷新当前可见行，保证输出改变可见内容时，选区序列化不会读到旧模型。
- 显式 `getLineModel()` 查询仍按需写入 LRU，保证选择起点在滚动前后可继续访问；自动链接 overlay 使用不写 LRU 的读取路径。
- cache hit 会刷新最近使用顺序；超过容量时删除最旧条目。resize/reset 继续整体清空缓存。

测试覆盖了空闲帧不填充、选区活动时填充、输出后模型刷新、2000 条最小容量、`rows * 20` 大视口容量、最近访问刷新和淘汰顺序。

## 新增文件

- `packages/ghostty-terminal/bench/canvas.bench.mjs`
- `packages/ghostty-terminal/src/canvas-renderer.scroll-runs.test.ts`
- `packages/ghostty-terminal/src/render-state.scroll-shift.test.ts`
- `packages/ghostty-terminal/src/terminal-render-coordinator.performance.test.ts`

同时扩展了 `packages/ghostty-terminal/bench/render-bridge.bench.ts` 的三个滚动场景。

## 验证命令

```bash
cd packages/ghostty-terminal && bun test
cd packages/terminal-ui && bun test
cd packages/panels && bun test
cd packages/ghostty-terminal && bunx tsc --noEmit -p .
cd packages/terminal-ui && bunx tsc --noEmit -p .
cd packages/panels && bunx tsc --noEmit -p .
cd /Users/konata/code/tmex-r21 && bunx biome check \
  packages/ghostty-terminal/src/canvas-renderer.ts \
  packages/ghostty-terminal/src/render-state.ts \
  packages/ghostty-terminal/src/terminal-render-coordinator.ts \
  packages/ghostty-terminal/src/canvas-renderer.scroll-runs.test.ts \
  packages/ghostty-terminal/src/render-state.scroll-shift.test.ts \
  packages/ghostty-terminal/src/terminal-render-coordinator.performance.test.ts \
  packages/ghostty-terminal/bench/render-bridge.bench.ts \
  packages/ghostty-terminal/bench/canvas.bench.mjs
```

## 风险与注意事项

- 文本 run 的安全上限依赖当前字体与设备像素 cell 宽度的实测残差；字体不适合批绘时会自动降为单 cell，不会强行保留长 run。
- ping-pong 备用位图在首次有效滚动时懒分配。滚动过的 pane 会保留一张与主画布同尺寸的备用 bitmap，这是单次安全 blit 的空间成本。
- LRU 使跨视口选区的可回溯窗口有明确上限；容量至少为 2000 行，大视口按 20 倍视口行数扩展。
- Canvas 基准同时给出强制栅格与逐 rAF 主线程提交两种口径；二者不能直接相加。前者用于比较绘制算法和识别同步 copy，后者用于衡量最终 ping-pong 滚动回调对主线程的占用。
