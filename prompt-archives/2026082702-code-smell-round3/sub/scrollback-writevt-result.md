# scrollback 单位修复 + writeVt/pane 输出合并

## 一、TASK 1：scrollback 单位 bug（行 vs 字节）

### 结论

`GhosttyBindings.createTerminal` 把调用方的「行数」直接写进 `GhosttyTerminalOptions.max_scrollback`，
而 ghostty 把该字段当**字节**预算。修复方式是在 wrapper 内换算，调用方语义不变（仍传行数），
所以 `terminal.ts` / `headless.ts` / `TerminalPreview.tsx` / `useTerminalBootSurface.ts` 的调用点
**一行未改**（只有形参名 `scrollback` → `scrollbackLines`，位置参数不受影响）。

### 实测出的 ghostty 行为（`bun` 直接驱动真实 wasm 测得，非推算）

- PageList 按**整页**切分预算，单页 **576 KiB**；预算做**向下取整**，不对齐白丢将近一页。
- 每页容纳行数 = `floor(589824 / bytesPerRow)`，实测 80 列 589 行 / 160 列 296 行 / 200 列 237 行。
- 反解每行字节：`bytesPerRow ≈ 12.39 * cols + 10.2`（三个列宽拟合误差 < 0.5 字节）。
- 容量阶梯：`capacity = rowsPerPage * floor(bytes / 576KiB) - c0`，`c0` 实测 91（80 列）~127（160 列），
  即首页有一部分被活动屏占走。
- 旧代码传 10000 / 100000 / 1000000 都只得到 1129 行历史，因为字节数被 `PageList.minMaxSize` 的下限兜住。

### 换算公式（`packages/ghostty-terminal/src/ghostty-wasm.ts`）

```
lines      = clamp(floor(scrollbackLines), 0, 10000)
bytesPerRow= 13 * cols + 16                       // 对实测 12.39*cols+10.2 留 ~5% 余量（样式/宽字符更重）
pages      = ceil((lines + 192) * bytesPerRow / 576KiB)   // 192 覆盖 c0（91~127）
bytes      = pages * 576KiB                        // 对齐整页，抵消 PageList 的向下取整
```

- **上限 10000 行**：与前端 `TERMINAL_SCROLLBACK` 一致，防止调用方误传巨值把内存打爆。
  10000 行 @80 列 ≈ 19 页 ≈ 10.7 MiB（页是**按需**分配的，不是预留）。
- **cols 依赖**：ghostty 没有创建后修改 `explicit_max_size` 的入口，`resize` 也不改，
  所以预算按**创建时的 cols** 定档。`GhosttyTerminalController.create` 用的是 `DEFAULT_COLS = 80`，
  之后 resize 到 200 列时实际能留住的行数按 cols 反比降到约 4300 行。已在代码注释里写明；
  要彻底解决需要 ghostty 侧提供 setter（超出本次范围）。

### 回归测试

新增 `packages/ghostty-terminal/src/ghostty-wasm.scrollback.test.ts`（4 例，跑真实 wasm）：

1. 80 列请求 3000 行、写 4000 行文本 → 保留 ≥ 3024 行；
2. 160 列同上；
3. 请求 10000 行 → 保留 ≥ 10024 行（直接钉死「退化成 1129 行」的旧行为）；
4. 请求 1e6 行 → 被夹到 10000 行档位。

**与任务书的偏差（需要知悉）**：任务书要求断言「≈ 3000 + 24（±5%）」。实测页粒度在 80 列是
**589 行**（占 3000 的 19.6%），且每行实际占用随内容（样式、宽字符）浮动约 10%，
任何换算都不可能稳定落在 ±5% 里——只有「向下取整到 2883 行」这一个点能勉强命中 ±5% 的下沿（-4.7%），
但那意味着**用户要 3000 行只给 2854~2883 行**。我选择「保证不少于请求值」的语义，
断言写成 `[请求值+rows, 请求值+rows+1100]`（1100 = 一页 + 内容浮动余量，实测最大超出 1007 行）。

测试为了不拖慢 suite（见下）用空行喂满行槽：行槽按行计，空行同样占一整格，
容量测量因此更稳定，且省掉 MB 级写入。

**副作用提醒（超出本次范围，建议后续处理）**：
`apps/gateway/src/tmux-client/pane-emulator-create.ts` 的 `DEFAULT_SCROLLBACK = 5000` 以前因为这个
bug 实际只有约 500~1100 行；修好之后每个 pane 模拟器的回滚预算变成真的 5000 行
（80 列 ≈ 5.5 MiB，200 列 ≈ 13.6 MiB），而所有 `HeadlessTerminal` **共用同一个 wasm 线性内存且只增不减**。
gateway 侧的 `PaneEmulator.render()` 只取 viewport（`formatViewport`），历史分页走 tmux `capture-pane`
（`pane-history-reader.ts`），也就是说这块回滚**根本用不到**。建议把 gateway 的
`DEFAULT_SCROLLBACK` 降到几百行。

### 客户端 history 预算对齐（`TerminalSurface.ts`，仅常量）

- 旧值 `8 MiB / 64 页`，远超终端能留住的量：多缓存的分页写进去也会被 ghostty 立刻挤掉。
- 新值：
  - `MAX_SURFACE_HISTORY_BYTES = 10_000 * 200 = 2,000,000`（≈1.9 MiB）
    —— `TERMINAL_SCROLLBACK` 10000 行 × 每行原始 VT 保守 200 字节（80~200 列一行含 SGR 的保守估计；
    实测纯文本一行 80~160 字节，200 留了 25%~150% 余量）。
  - `MAX_SURFACE_HISTORY_PAGES = 22` —— gateway 单页最多 `MAX_CAPTURE_LINES = 512` 行
    （`pane-history-page.ts`），`ceil(10000 / 512) = 20`，再留 2 页余量。
- 触顶只是 `stop_paging`（不触发 rebase），调低无风险。
- `TerminalSurface.test.ts` 里「64 页累积后按行号升序」那条改成显式 `maxHistoryPages: 64`
  ——它验证的是排序，不该跟默认预算耦合。

## 二、TASK 2：writeVt scratch + pane 输出合并

### writeVt 复用常驻缓冲（`ghostty-wasm.ts`）

- ≤256 KiB 的写入走常驻 scratch（按 2 的幂增长，最小 4 KiB）：`Uint8Array` 直接 `set` 进线性内存；
  字符串走 `encodeInto` **直接写进 wasm 内存**，省掉中间那个 JS `Uint8Array`。
- >256 KiB（历史回放这类 MB 级 payload）仍走一次性 alloc/free，避免常驻缓冲被永久撑大。
  **这就是「dispose/resize 时释放」的替代方案**：`GhosttyBindings` 是全局单例、没有 dispose 入口，
  给它加个没人调用的 `releaseScratch()` 是死代码；用「常驻容量硬上限 256 KiB」把内存问题从源头封死。
- `memory.grow` 会换掉 `ArrayBuffer`：新增的 `memoryBytes()` 与既有 `view()` 同一套缓存策略
  （按 buffer identity 失效），且所有取视图的动作都在 `allocBytes` 之后、跨 wasm 调用前后不留旧视图。

### bench（`packages/ghostty-terminal/bench/write-vt.bench.ts`，10k × 64 B，10 轮取中位数）

```
legacy bytes (alloc/copy/free)     10.85 ms  (1085 ns / write)
scratch bytes                      10.33 ms  (1033 ns / write)   -4.8%
legacy string (encode + alloc)     11.15 ms  (1115 ns / write)
scratch string (encodeInto)        10.68 ms  (1068 ns / write)   -4.2%
overhead removed: alloc+copy+free   0.86 ms  (  86 ns / write)
coalesced x10 (same total bytes)    9.70 ms  ( 970 ns / write)   -6.1%
```

诚实结论：**vt 解析本身占了绝大头**（64 字节 ≈ 1 µs，约 16 ns/cell），
每次调用的固定成本只有 alloc/copy/free 的 ~86 ns + 调用开销 ~60 ns。
所以 scratch 稳定省 4~5%，wasm 层面的合并再省 6%。
合并真正的收益在 JS 侧：每少一帧就少一次 sink 派发、少两次 `isTerminalModeEnabled`（alt-screen 判定）、
少一次渲染调度和一次 TerminalSurface 记账。

### per-pane 合并（新文件 `packages/ws-client/src/pane-output-coalescer.ts`）

- 同一 pane 的连续输出按引用攒进 chunk 列表，在**微任务边界**（`queueMicrotask`，不是定时器）
  或攒够 **32 KiB** 时拼成一帧下发；一个调度周期只排一个回调，遍历顺序即 pane 插入顺序。
- 严格保序：同 pane 字节按到达顺序拼接；`paneEpoch` 变化时先把旧 epoch 冲出去再开新缓冲；
  合并帧取首帧 `seqStart`、末帧 `seqEnd`。
- **flush 时机**（任何会改变画面基线的事件都先 flush 再执行）：
  `reset` / `applyHistory` / `screenSnapshot` / `historyPage` / `rebase` / sink 换绑 / sink 注销，
  以及 history gate 放行那批缓冲后立即 flush（本来就是攒好的批，没必要再等边界）。
- **dispose 的选择：flush，不丢**。注销 sink 时把在途字节冲给正在卸载的 sink
  （`TerminalSurface.write` 对已 dispose 的目标是安全空操作），这样「任何 sink 状态变化都先 flush」
  没有例外，读代码时不用记特例。
- **例外是链路级拆除**：`cleanupDevicePaneState` / `reset()` 直接丢弃在途字节 —— 连接已断，
  这些是无主的流中片段，与既有 pending 缓冲的处置保持一致。
- 字节按引用暂存不复制：flush 必定发生在同一宏任务内，解码缓冲此期间不会被复用。

**能覆盖多少场景（诚实说明）**：浏览器里每条 WS 消息是独立宏任务，
微任务合并只能合并**同一宏任务内**的连续帧（history gate 回放、挂载时的 pending 重放、
一次 tick 内多帧）。跨消息合并需要 timer/rAF 边界，会直接抬高交互延迟，任务书也明确禁止，
所以没做。跨消息那部分的成本由 scratch buffer 消化，两者互补。

### 测试

- 新增 `pane-output-coalescer.test.ts`（8 例）：合并、单次调度回调、跨 flush 保序、
  32 KiB 阈值同步下发、epoch 切换先 flush、seq 元数据合并、空 flush 不产生空帧、`discardMatching`。
- `pane-sink-registry.test.ts` 新增 7 例：合并成一次 `onOutput`、reset/applyHistory 前先 flush、
  注销时 flush、换绑时归上一任 sink、32 KiB 立即下发、device 清理时丢弃。
- 既有测试的必要调整：
  - 3 例「dispatch 后同步断言」加 `await Promise.resolve()`（微任务边界）；
  - `history gate buffers live output` 的期望从两条 output 变成合并后的一条 `live-1live-2`；
  - `connection.test.ts` 里「每个连接持有独立注册表」同样改成 await 一次微任务
    （该文件不在原始 scope 内，但不改就会因本次行为变更而红，改动仅两行 await）。

## 三、验证结果

| 包 | 测试 | tsc |
| --- | --- | --- |
| ghostty-terminal | 185 pass / 0 fail（基线 175 + 本次 4 + 并行 agent 6） | 0 |
| terminal-ui | 301 pass / 0 fail | 0 |
| ws-client | 99 pass / 0 fail（基线 82 + 本次 15 + 并行 agent 2） | 0 |
| stores（连带验证） | 214 pass / 0 fail | — |

`biome check` 对本次新增/修改文件全绿；`ghostty-wasm.ts` 只做 `biome lint`（全绿）+ 逐行核对，
新增代码零格式漂移，未对该文件跑 `--write`（存量漂移会污染 diff）。

## 四、踩到的坑（下一位改这个包的人需要知道）

跑 `bun test` 时会看到 `terminal-selection.ts` 的 `stepAutoScroll` 抛
`TypeError: resources.bindings is undefined` 并**中断整个 suite**（只跑完 20 个文件）。
根因是既有的 `setInterval` 泄漏：某个用例开了 auto-scroll 拖拽后终端被 dispose，
48 ms 的 interval 没被清掉；平时 suite 总时长不足 48 ms 所以从没暴露，
我最初那版回归测试多花了 60 ms 就把它触发了。
改成空行喂测（整文件 <10 ms）后不再触发，但**泄漏本身还在**
（`terminal-selection.ts` / `terminal.ts` 的 dispose 未 `stopAutoScroll`，均不在本次 scope）。
下次谁往这个包里加稍慢的测试文件，就会再次撞上——建议单独修掉。
