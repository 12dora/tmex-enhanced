# EX1：剩余「不流畅」热点探索与量化（第二十二轮）

基线：`/Users/konata/code/tmex-r22`，`feat/round22-perf-tui-color-smell`（base = main `c462f3bd`，1.1.21）。只读探索，未改动任何源文件。
所有数字均为**本轮实测**，环境 Apple Silicon macOS / Bun 1.3.14（WASM 桥）/ Headless Chromium 145 DPR=2（canvas）。

---

## 0. 结论先行

第二十一轮把**滚动**这条轴修完了（bench 里 `scroll +1` 的 `full=0/200`、`dirtyRows=1.0`、mean 1.12 → 0.061 ms，已复现确认）。剩下的「不流畅」不在滚动上，集中在六处，按影响排序：

1. **保活池里 2 个看不见的 pane 仍跑完整渲染管线**——写入、WASM 桥、canvas 落笔一步不少，只是 `opacity:0`。可见 pane 的每一帧要和它们抢同一条主线程（T1）。
2. **每次击键回显被硬加 20 ms 定时器延迟**（服务端 batcher 16 ms + 客户端 coalescer 4 ms，两处都是「先起 timer 再等」而非 leading-edge）。局域网 RTT ~1 ms 时，延迟的 95% 是这两个定时器（T2）。
3. **r21 刚接通的 canonical 引入了一条客户端回归**：每帧输出解码从 legacy 的 353 ns 变成 96.6 µs（约 270×），全在浏览器主线程上（T5）。
4. **渲染桥的热点不在 WASM，在包着 WASM 的那层 JS**。整屏重绘帧 1.06 ms 里真正的 WASM 读只占 95 ns/cell，另外 116 ns/cell 是 JS 包装层。**扁平化重写实测 2.25×，完全不需要动 WASM、不需要 fork ghostty**（T4）。
5. **borsh 编码器逐字节写**（第三方 `@zorsh` 的 `bytes()` 实现），网关每帧终端输出付两遍。融合写入器实测 **113×**（T3）。
6. **终端画布之外还有三条独立的重渲染放大链**：`snapshots[deviceId]` 整对象订阅把 125 patch/s 放大成整页重渲染（U4）；mesh 侧栏三处不稳定引用让 `DeviceRow`/设备树的 memo **100% 失效**（U6，3 行可修）；agent 会话里未封口的大代码块每 40 ms 全量重 parse，150 KB 时吃掉 **14% 主线程**（U3）。

**两条明确的否定结论（都有实测）**：
- **字形图集（glyph atlas）不值得做**——逐 cell `drawImage` 比 r21 已落地的 run 批绘 `fillText` **慢 4 倍**（2.35 ms vs 0.60 ms）。
- **fork ghostty 加批量读导出不值得做**——纯 JS 扁平化已经 2.25×，而 fork 会破坏 `verify:wasm` 的上游锁定不变量并绑上 zig 工具链。

**两条常见 checklist 项在本仓已清零，不要再查**：返回新对象的 zustand selector（148 处调用零命中）、裸字面量 context value（9 个 context 全部 `useMemo`）。

---

## 1. 实测数据（含精确命令）

### 1.1 渲染桥（现有 bench，确认 r21 成果仍在）

```
cd /Users/konata/code/tmex-r22
bun packages/ghostty-terminal/bench/render-bridge.bench.ts
```
```
full update (40/40 rows rewritten) mean=1.061ms p50=1.001ms p95=1.280ms dirtyRows/frame=40.0 non-full=0/200
single dirty row (1/40)            mean=0.067ms p50=0.064ms p95=0.084ms dirtyRows/frame=0.9  non-full=200/200
clean frames (0/40)                mean=0.006ms p50=0.005ms p95=0.006ms dirtyRows/frame=0.0
20% dirty rows (8/40)              mean=0.268ms p50=0.253ms p95=0.331ms dirtyRows/frame=8.0
scroll +1 line/frame               mean=0.061ms p50=0.043ms p95=0.142ms dirtyRows/frame=1.0  full=0/200
scroll +3 lines/frame              mean=0.098ms                        dirtyRows/frame=3.0  full=0/200
scroll -1 line/frame               mean=0.041ms                        dirtyRows/frame=1.0  full=0/200
wasm call cost: single_get=7.9ns get_multi(3)=24.2ns alloc+free=40.0ns new DataView=35.7ns cached view()=14.0ns
```

r21 的滚动优化确认生效。**剩下唯一还贵的场景是 `full update`（TUI 整屏重绘 / `cat` 大文件），1.06 ms。**

### 1.2 整屏重绘帧的阶段拆分（本轮新脚本）

脚本：`$SCRATCH/phase-split.ts`（120×40，写 40 行 + 完整读一帧，300 帧取均值）

```
write      0.143 ms/frame    30 ns/cell   ← VT 解析（WASM 内部）
update     0.013 ms/frame     3 ns/cell
iterate    1.012 ms/frame   211 ns/cell   ← 82%，全部在这里
meta       0.000 ms/frame
line       0.032 ms/frame     7 ns/cell   （buildLineModel ×40）
```

**`iterateRows` 是 VT 解析本身的 7 倍。**

### 1.3 `iterateRows` 内部逐步归因（本轮新脚本）

脚本：`$SCRATCH/cell-steps.ts`（用裸 exports 逐步复现 `readRowCells` 的每一步，3 pass 取稳定值）

| 累计到哪一步 | ns/cell | 增量 |
|---|---:|---:|
| L0 迭代骨架（`row_iterator_next` + dirty 位消费即清） | 6 | 6 |
| L1 `+readCellRaw`（u64 → **BigInt**） | 28 | +22 |
| L2 `+`grapheme len / buf | 42 | +14 |
| L3 `+`wide / hasText（**BigInt 入参**回传 wasm） | 60–68 | +22 |
| L4 `+`style 结构体（8 个 u8 flag + underline） | 86 | +20 |
| L5 `+`fg / bg 颜色 | **94–95** | +8 |

**关键结论：真正的 WASM 读只有 ~95 ns/cell，而 `iterateRows` 实测 211 ns/cell —— 另外 ~116 ns/cell（55%）是纯 JS 包装层开销。**

### 1.4 `bindings.view()` 的单项代价（本轮新脚本 `$SCRATCH/cell-attrib.ts`）

```
bindings.view()  (cached, no-arg)                8.6 ns
bindings.buffer()  (memory.buffer getter)        7.8 ns   ← view() 的成本几乎全是这个
held DataView.getUint32                          2.7 ns
bindings.view().getUint32 (via accessor)        10.4 ns   ← 每次多付 7.7 ns
held DataView.getBigUint64                      15.4 ns   ← BigInt 装箱
exports.<simple get>                             6.3 ns
```

`ghostty-wasm.ts:407` 的 `view()` 每次都要读一次 `exports.memory.buffer`（WASM memory buffer getter 不是免费属性），而热路径上每 cell 调用十余次。

模拟「把 `view()` 变成零开销常量」的上限（`$SCRATCH/view-hoist-sim.ts`）：

```
baseline (real view())    mean=1.118ms  per-cell=233ns
view() 零开销（上限模拟）    mean=0.996ms  per-cell=207ns   →  1.12x（11% 时间消失）
```

单独提 `view()` 只值 11%（JIT 把单态 getter 内联得不错），**不要指望它单独救场**。

### 1.5 `get_multi` 打包读（本轮新脚本 `$SCRATCH/multi-read.ts`）

只换 ABI 形态（5 项 cells-handle 读 → 1 次 `ghostty_render_state_row_cells_get_multi`；2 项 raw-cell 读 → 1 次 `ghostty_cell_get_multi`）+ 把 `view()` 提到循环外：

```
逐项 get（现状 ABI 形态）        0.421 ms/frame   88 ns/cell
get_multi 打包 + view 提外      0.332 ms/frame   69 ns/cell   →  1.27x
```

**注意**：r21 EX1 引用 bench 里的 `get_multi(3)=22.9ns vs 3×single=24ns` 得出「打包 ABI 几乎没有收益」——那个微基准只测了**导出调用本身**，没测被省掉的 JS 侧 `ensureScratch`/`assertReadResult`/`view()` 链。实测在真实读取形态下是 1.27×，结论需要修正为「**单独用 get_multi 收益有限，但它是扁平化重写的必要组成部分**」。

### 1.6 扁平化重写的完整收益（本轮新脚本 `$SCRATCH/full-sim.ts`）

把整个 `readRowCells + readRow` 用「`get_multi` + 循环外持有 DataView + 内联 style/color 内插 + 内联复用比对 + 内联 rowText」重写成一个平坦循环，语义等价（同样的内插、同样的引用相等复用、同样的 dirty 消费即清）：

```
真实 iterateRows（现状）           1.061 ms/frame  221 ns/cell
扁平化 get_multi 版（等价语义）      0.472 ms/frame   98 ns/cell
加速 2.25x
```

**整屏重绘帧的桥开销 1.06 ms → 0.47 ms，无需任何 WASM 改动。**

诚实的余量说明：模拟版省略了 `wrap`/`wrapContinuation` 两个**行级**读（每行 2 次，非每 cell，约 +0.005 ms/帧）、`INTERN_LIMIT` 上限守卫、`assertReadResult` 的错误码检查（可改成内联判 `!== 0`，成本 ~1 ns/次）、以及 grapheme > 64 的 alloc 回落路径。补回后实际预期 **1.8–2.0×**（1.06 → 0.53–0.59 ms），而不是 2.25×。

### 1.7 VT 写入吞吐（本轮新脚本 `$SCRATCH/throughput.ts`）

```
writeVt 32KiB (string)        0.523 ms/次  →  60 MiB/s
writeVt 32KiB (Uint8Array)    0.509 ms/次  →  61 MiB/s
writeVt 32KiB (SGR 密集)       0.607 ms/次  →  52 MiB/s
```

对照现有 `bun packages/ghostty-terminal/bench/write-vt.bench.ts`：
```
legacy bytes (alloc/copy/free)     1113 ns/write(64B)
scratch bytes                      1050 ns/write
overhead removed: alloc+copy+free    88 ns/write
coalesced x10 (same total bytes)    984 ns/write
```
写入侧已经优化到位（常驻 scratch + `encodeInto`），**60 MiB/s 的 VT 解析是 WASM 内部成本，无 JS 侧可省**。`cat` 一个 10 MB 文件 ≈ 170 ms 纯解析，这是下限。

### 1.8 Canvas（现有 bench，确认 r21 成果）

```
bun packages/ghostty-terminal/bench/canvas.bench.mjs
```
```
canvas bench — Chromium 145.0.7632.6, DPR 2, 120x40   visible glyph cells: 3965
per-cell full screen  mean=4.833ms      run-batched screen   mean=1.477ms   speedup 3.27x
per-cell foreground   mean=4.325ms      batched foreground   mean=0.981ms   speedup 4.41x
3912 single glyphs    mean=2.700ms      20-cell glyph runs   mean=0.596ms   speedup 4.53x
one run-batched row   mean=0.031ms
self blit (raster)    mean=4.049ms      two-hop scratch      mean=4.150ms   ping-pong blit mean=0.038ms
```

### 1.9 字形图集 vs run 批绘（本轮新脚本 `$SCRATCH/atlas.bench.mjs`）

同一内容（3935 个可见字形，120×40，DPR 2，Chromium 145）：

```
run-batched fillText                mean=0.599 ms
per-cell drawImage(atlas canvas)    mean=2.350 ms      ← 慢 3.9×
per-cell drawImage(ImageBitmap)     mean=2.411 ms      ← 慢 4.0×
```

**结论：字形图集在这个引擎上是负收益，明确不做。** 原因是 run 批绘已经把 3935 次调用压到约 200 次，而图集方案**必然退回逐 cell 一次 `drawImage`**（每个 cell 的字形/颜色组合不同），调用次数反弹 20 倍，`drawImage` 的单次成本又不比 `fillText` 低多少。

### 1.10 `buildRowText` 微基准（本轮新脚本 `$SCRATCH/rowtext.ts`）

```
+= concat      612 ns/行  →  40 行/帧 = 0.024 ms/frame
array join     935 ns/行  →  40 行/帧 = 0.037 ms/frame
```
现状的 `+=` 已经比 `join` 快。**不要改。**

### 1.11 网络路径实测（并行子探索）

```
bun apps/gateway/bench/pane-stream-parser.bench.ts
```
```
parser/plain-ascii             1.00MiB   50.1ms   1598.2 MB/s
parser/ansi-heavy              1.00MiB  426.9ms     46.9 MB/s
parser/osc-kitty-clipboard     1.00MiB  400.5ms     30.0 MB/s
parser/tmux-passthrough        1.12MiB  424.8ms     36.9 MB/s
unescape/unescaped             1.00MiB    2.0ms  40267.6 MB/s
unescape/escaped               1.00MiB   71.6ms   1116.8 MB/s
```

```
bun apps/gateway/bench/frame-sizer.bench.ts     # maxData=32679 即使 cap=1MiB —— canonical 的 32 KiB 硬顶
bun packages/shared/bench/canonical-validation.bench.ts
```
```
PaneData 31 KiB — deserialize 92.281 µs/op   |   reader scan 0.119 µs/op
```

线上帧尺寸与编解码成本（一次性脚本，见 §5）：

```
payload |legacy frame|canon frame| legacy oh | canon oh
      1 |         69 |       119 |        68 |      118
  32000 |      32068 |     32118 |        68 |      118
TERM_INPUT 单击键 "a": legacy=70B  canonical=135B (+93%)

=== encode（网关，每输出帧）===
 32000 B  legacy encodePayload 112.8 µs | encodeEnvelope 110.8 µs | canonical encodeEvent 114.9 µs
=== decode（客户端，每输出帧）===
 32000 B  legacy view 353.3 ns | canonical decodeCanonicalEventPayload 96.641 µs | peek 0.725 µs
=== 融合编码器 vs 现状（输出逐字节相同）===
  64 B : 2.009 µs → 267.7 ns (7.5×)   |  32000 B : 211.4 µs → 2.349 µs (90×)
4096 B : 33.89 µs → 678.9 ns (50×)    |  65536 B : 447.7 µs → 3.969 µs (113×)
```

deflate 取舍（合成但形态贴近的样本）：
```
shell-prompt  raw=53200B  L6=522B (101.9×, 1730 MB/s)  L1=822B  (64.7×, 3053 MB/s)
log-lines     raw=67790B  L6=2406B (28.2×,  601 MB/s)  L1=5131B (13.2×, 1634 MB/s)
tui-repaint   raw=50163B  L6=1874B (26.8×,  451 MB/s)  L1=3379B (14.8×, 2021 MB/s)
```

### 1.12 React/UI 实测（并行子探索）

| 场景 | 实测 |
|---|---|
| `highlight.js` 500 KB TS（已知语言） | **232.3 ms**，产出 1.79 MB HTML / 35,619 `<span>` |
| `highlight.js` 63 KB `highlightAuto` | **284.6 ms**（16 KB → 135.8 ms） |
| `react-markdown` 未封口块 45 KB / 每 40 ms | 均值 1.70 ms（末 3.06 ms）⇒ ~43 ms/s |
| `react-markdown` 未封口块 150 KB / 每 40 ms | 均值 **5.70 ms**（末 **13.10 ms**）⇒ **~143 ms/s = 14% 主线程** |
| `advanceMarkdownSplit` 增量扫描（150 KB） | 0.088 ms/delta —— **不是瓶颈** |
| 文件树 500 行 SSR：纯 `<button>` | 1.74 ms |
| 　　　　　　`+useTranslation` | 6.85 ms |
| 　　　　　　`+ContextMenu.Root+Trigger` | **29.18 ms（17× 基线）** |

### 1.13 各包测试基线（本轮实跑）

```
bun test packages/<pkg>
```
| 包 | 结果 |
|---|---|
| ghostty-terminal | 279 pass / **1 fail** — 唯一失败是 `packages/ghostty-terminal/src/zz-ex2-repro.test.ts`，**未跟踪文件**，是并行的 EX2 探索者刚写的浅绿色 bug 复现（`git status` 显示 `?? zz-ex2-repro.test.ts`）。排除后 279/279 全绿 |
| terminal-ui | 379 pass / 0 fail |
| ws-client | 382 pass / 0 fail |
| stores | 435 pass / 0 fail |
| shared | 451 pass / 0 fail |
| panels | 786 pass / 0 fail |

---

## 2. 排序的优化项

> 角色约定：backend = cursor(grok)；complex-perf = codex；frontend = opus5。

### T1 — HIGH ★★★ 保活池里看不见的 pane 仍跑完整渲染管线

- **位置**：`packages/panels/src/device-console/terminal-keep-alive.ts:25`（`KEEP_ALIVE_LIMIT = 3`）、`:28`（`KEEP_ALIVE_COLD_DELAY_MS = 60_000`）；`packages/panels/src/device-console/terminal-stage.tsx:280`（隐藏槽 `style={{ opacity: 0, pointerEvents: 'none', zIndex: 0 }}`）；`packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts:88-90`（`surfaceRef.current?.write(...)`）；`packages/ghostty-terminal/src/terminal.ts:355`（`write()` 结尾无条件 `renderCoordinator.schedule()`）；`packages/ghostty-terminal/src/terminal-render-coordinator.ts:249`（`renderNow()` 全程没有任何可见性判定）。
- **根因**：保活池同时挂 3 个终端实例，隐藏实例用 `opacity:0` 而非停止渲染。60 秒宽限期内它们**保持 wire 订阅**（`coldPanes` 之外），于是每一次输出都完整跑一遍 `writeVt → iterateRows → 建 40 个 LineModel → canvas 两遍落笔 → updateScrollbar`。r21 只把**光标闪烁动画**在隐藏子树里停掉了（`cursor-layer.ts:33` 的 `[data-tmex-terminal-hidden] canvas.blink{animation:none}`），渲染本体没动。
- **代价**：按 §1 实测，一个整屏重绘帧 ≈ 桥 1.06 ms + canvas 1.48 ms + 写入 0.14 ms ≈ **2.7 ms**。三个 pane 同时有输出（很常见：一个跑构建、一个 tail 日志、一个在看）= **8.1 ms / 帧**，占满 16.7 ms 预算的一半；手机上（慢 3–5 倍）直接 25–40 ms/帧，可见 pane 必然掉帧。而其中 2/3 是**画给没人看的画布**。
- **改法**：给 `GhosttyTerminalController` 加 `setRenderSuspended(boolean)`：挂起时 `write()` 照常 `writeVt`（保活的价值就在这里——终端状态留在 WASM 里，切回是即时的）但**不排帧**；恢复时走一次 `requestFullRepaint()` + `renderNow()`。`terminal-stage.tsx` 在 `visible` 变化时调用。需要同时挂起的还有 `scheduleLinkOverlayUpdate`（150 ms 节流的链接重扫）与 `cursorSettle` 定时器。
- **预期收益**：多 pane 场景下终端渲染成本 −67%；隐藏 pane 的每帧 rAF 唤醒归零（PWA 节电直接受益，且不依赖机器是否空闲）。
- **风险**：低—中。要覆盖的边界：① 恢复时必须 `forceFull`（canvas 位图没被清但 dirty 位已被消费即清，不强制会白屏——这正是 issue #45 bug 3 的同一族问题）；② resize 发生在挂起期间时几何要重算；③ e2e 探针（`apps/fe/tests` 里按文档序取 `.xterm canvas`）读的是可见实例，不受影响；④ 选区/滚动位置在挂起期间不应被丢弃。
- **角色**：frontend（`terminal-stage.tsx` 接线）+ complex-perf（`terminal.ts` / `terminal-render-coordinator.ts` 的挂起语义与恢复不变量）。**建议由 codex 做核心、opus5 接线。**

### T2 — HIGH ★★★ 每次击键回显被硬加 20 ms 纯定时器延迟

- **位置**：服务端 `apps/gateway/src/ws/terminal-output-batcher.ts:1`（`DELAY_MS = 16`，timer 在 batch **创建时**就位于 `:140`，所以孤立回显等的是**整整 16 ms**，不是「最多 16 ms」）；canonical 完全镜像于 `apps/gateway/src/ws/canonical/pane-stream.ts:143`。客户端 `packages/ws-client/src/pane-output-coalescer.ts:13`（`DEFAULT_PANE_OUTPUT_FLUSH_MS = 4`，`ensureScheduled()` 在 `:129-139` 首次 push 时起 `setTimeout(flush, 4)`），**小回显块同样吃满 4 ms**。
- **根因**：两处都是「trailing-edge 合并窗口」。合并的价值只在**持续高频**时存在；孤立的一帧等窗口到期，纯亏。
- **代价**：网络 RTT 之上确定性 **+20 ms**，再叠加渲染器 rAF（最多 +16.7 ms）。局域网 RTT ~1 ms 时，**「敲键到上屏」的 95% 是这两个定时器**。生产 `ws-metrics` 显示常态是 ~8.8 个 `%output`/s、平均 79 B —— 这个速率下 16 ms 窗口几乎合并不到任何东西，纯粹在加延迟。
- **改法**：**leading-edge 发射**。pane 缓冲为空且距上次 flush ≥ delay 时立即发出，随后进入 delay 长度的 cooldown 合并窗口。持续输出时行为完全不变（缓冲永远非空），打字时延迟归零。`pane-stream.ts:106` 注释担心的「整屏重绘几十个 `%output`」场景由 cooldown 窗口保住。
- **预期收益**：击键往返 **−20 ms**。这是本轮对「手感」影响最直接的一项。
- **风险**：中低（顺序安全：仅在缓冲为空时直发，不会乱序）。需要补：突发流量下 flush 频率不上升的断言测试。
- **角色**：backend（网关两处）+ frontend（ws-client 一处），两处改动对称且都很小。

### T3 — HIGH ★★★ borsh 序列化逐字节写，是网关输出路径最大的 CPU 项

- **位置**：`node_modules/.bun/@zorsh+zorsh@0.4.0/.../dist/src/registry.js:377-394` —— `b.bytes()` 的 write 是 `for (i) writer.writeUint8(value[i])`。经由 `packages/shared/src/ws-borsh/codec.ts:37`（`encodeEnvelope`）与 `:55`（`encodePayload`）。热调用点 `apps/gateway/src/ws/legacy-feed-broadcaster.ts:272`、`apps/gateway/src/ws/index.ts:631-642`（`sendChunked → encodePayloadFrames → encodeEnvelope`，**每客户端一次**）。
- **根因**：终端字节被慢速循环序列化**两遍**（一次进 payload、一次进 envelope）。
- **实测**：64 KiB TERM_OUTPUT 帧 `encodePayload+encodeEnvelope` = **447.7 µs**；手写融合帧写入器（DataView + `.set()`，输出**逐字节相同**）= **3.97 µs** → **113×**。32 KiB：211.4 → 2.35 µs（90×）。序列化上限 **140 MB/s**，而同仓的 pane-stream parser 跑 **1598 MB/s** —— **borsh 编码是 parser 成本的约 11 倍，是输出管线的实际瓶颈**。
- **改法**：`codec.ts` 加融合快路径（`encodeTermOutputFrame` / `encodeCanonicalEventFrame`），header + payload 一次写进同一 buffer；schema 编码器保留，用「同输入两者字节相同」的等价性测试锁死。
- **预期收益**：140 MB/s → ~16 GB/s。直接降低网关 CPU（对 r21「待机 CPU 未能证明改善」那条遗留也有帮助——那台机器的 CPU 正是被终端输出管线占着）。
- **风险**：低（输出字节相同，可测）。**角色**：complex-perf（codex）。

### T4 — HIGH ★★ 渲染桥读取层扁平化（2.25× 实测，不需要动 WASM）

- **位置**：`packages/ghostty-terminal/src/render-state.ts:709-753`（`readRowCells`）与 `:755-793`（`readRow`）；每个读函数（`readCellRaw:255`、`readRawCellBool:277`、`readRawCellEnum:288`、`readStyle:355`、`readCellColor:334`、`readGraphemeLen:399`）都各自 `ensureScratch()` + `assertReadResult()` + `bindings.view()`。
- **根因**：见 §1.3 / §1.6。**热点不是 WASM 边界（95 ns/cell），而是包在外面的 JS 层（116 ns/cell）**：每 cell 约 8 次 `ensureScratch`（函数调用 + null 检查）、8 次 `assertReadResult`、12 次 `bindings.view()`（每次读一遍 `memory.buffer`）、2 次颜色 Map 内插 + 1 次 style Map 内插、`isCellUnchanged` 的 7 字段比较。
- **改法**（三件一起做才有 2.25×，单做任一件只有 1.1–1.3×）：
  1. `ghostty_render_state_row_cells_get_multi` 把 RAW/GLEN/STYLE/FG/BG 五项合成一次调用，输出写进**连续**的常驻 scratch；`ghostty_cell_get_multi` 把 WIDE/HAS_TEXT 合成一次。
  2. `const view = bindings.view()` 提到**行循环外**（唯一可能 `memory.grow` 的是 grapheme > 64 的 `allocBytes` 回落，在那条分支里重取即可）。
  3. 把 style flag 解包、颜色打包键、复用比对**内联**进同一个平坦循环，去掉每读一次的 `ensureScratch`/`assertReadResult` 调用链（错误码改成内联 `!== 0` 判断）。
- **预期收益**：整屏重绘帧的桥开销 **1.06 ms → 0.53–0.59 ms**（保守）/ 0.47 ms（实测模拟）。与 T1 叠加后，多 pane 场景的终端总成本从 8.1 ms/帧降到约 2.1 ms/帧。
- **风险**：中。`render-state.ts` 是 r21 位移复用逻辑的宿主，改动必须保住：dirty 位「消费即清」、行/cell 的引用相等复用（canvas 的 dirty 降级依赖它）、位移基线 `resolveShiftBaseline`。**必须配 `render-state.dirty.test.ts` / `render-state.cache.test.ts` / `canvas-renderer.scroll-runs.test.ts` 全绿 + bench 的 `dirtyRows/frame`、`full=` 两个数字不变。** 会撞复杂度 allowlist（`render-state.ts` 会涨行），需 `--tighten` 重新校准。
- **角色**：complex-perf（codex）。这是本轮最典型的「复杂性能调优」任务。

### T5 — HIGH ★★ canonical 客户端用通用反序列化器解每一帧 PaneData

- **位置**：`packages/ws-client/src/canonical-state-client.ts:232` → `packages/shared/src/ws-borsh/canonical-state.ts:346`（`CanonicalEventEnvelopeSchema.deserialize`）。
- **实测**：32 KB PaneData = **96.6 µs**；已存在的 `peekCanonicalPaneDataHeader`（`canonical-state.ts:376`，走 `canonical-scan` 单遍校验）= **0.72 µs**（**133×**，且常数时间）。legacy 对应物 `decodeTermOutputView`（`codec.ts:110`）本来就是 **353 ns**。
- **根因**：r21 刚把 canonical 接通（本轮之前它从未真正跑过），**客户端每帧输出解码从 353 ns 变成 96.6 µs（约 270×）**，而且全在浏览器主线程上。这是 r21 引入的**回归**，且正好落在用户抱怨的时间点上。
- **改法**：扩展 `peekCanonicalPaneDataHeader` 顺带返回 `data` 的 subarray；`handleEventPayload` 先走这条零拷贝路径，其余事件类型才 fallback 全量 decode。生命周期假设与 `decodeTermOutputView` 一致（coalescer 在 concat 处已复制）。
- **风险**：低。**角色**：complex-perf 或 frontend。**优先级仅次于 T1/T2——它是新引入的回归。**

### T6 — MED-HIGH ★★ mesh 中继为读一个 `kind` 而全量慢解每一帧

- **位置**：`apps/gateway/src/mesh/stream-replay-state.ts:75`（`tryDecodeEnvelope`，被 `noteOutbound:81` / `noteInbound:149` 调用，即 `apps/gateway/src/mesh/forwarder.ts:169` 与 `:387` —— **hub 中继会话的每一帧、两个方向**）；`apps/gateway/src/mesh/stream-targets.ts:542` 同理（link 的 node 侧）。
- **根因**：两处只需要 `env.kind` / `env.seq`，却先付了整个 payload 的逐字节拷贝。
- **收益**：换成 `decodeEnvelopeView`（`codec.ts:88`），32 KiB 帧 ~110 µs → ~350 ns（**约 300×**），远端节点会话每帧每跳省 110–220 µs。
- **风险**：低（需逐分支复核 payload 留存；`noteOutbound` 各分支 slice 的是 `bytes` 而非 `env.payload`，安全）。
- **角色**：backend。顺带把 `apps/gateway/src/ws/index.ts:259` 的入站 `decodeEnvelope` 一并换掉（70 B 击键只有 ~1 µs，但 1 MiB 粘贴要 ~7 ms 的逐字节循环）。

### T7 — MED ★★ 移动端触摸滚动无惯性、桌面滚动整行量化

- **位置**：`packages/terminal-ui/src/components/touch/scroll-gesture.ts`（全仓 `momentum|inertia|fling|velocity` **零命中**，本轮复核确认 r21 未做）；`packages/ghostty-terminal/src/wheel-delta.ts:42-47`（像素余量累积但只消费整格）。
- **根因**：手指抬起滚动立刻停；滚轮位移只能是 `cellHeight` 的整数倍（19–24 CSS px），120 Hz 触控板上表现为一格一格跳变。
- **为什么现在做**：r21 已经把 F1（rAF 合并）做完了，惯性的前置条件已经满足；r21 明确把它列为「建议放在 F1/F2/F3 之后」。**这是滚动这条轴上剩下的最后一项，也是主观「跟手」感受的最大一块。**
- **改法**：惯性（S/M）—— `touchend` 时按最后 ~100 ms 位移算速度，rAF + 指数衰减（`v *= 0.95`/帧，低阈值停）继续喂 `scrollLines`，任何 `touchstart` 立刻取消。亚行平滑（L）—— 内容 canvas 多画 overscan 行 + `transform: translateY(-frac)`，需要同步平移选区/链接/光标三层的坐标基准，**建议本轮只做惯性，亚行平滑单独立项**。
- **风险**：惯性低；亚行平滑中高。**角色**：frontend。

### T8 — MED ★ 每个终端 5 张全尺寸 canvas，保活池 ×3

- **位置**：`packages/ghostty-terminal/src/canvas-renderer.ts:155-164`（main / link / selection / cursor / **scratch**）；`scratchCanvas` 在 `:796-800` 被 resize 到与主画布同尺寸，只在 `blitRows` 里用作 ping-pong 中转。
- **代价**：iPhone DPR=3、390×740 CSS ⇒ 每张 ~10.4 MB，5 张 = **52 MB / pane**，保活 3 个 = **156 MB**。Safari 在 200–400 MB 附近开始回收标签页 —— 这是移动端 PWA「用一会儿就白屏/重载」的一个真实候选原因。
- **改法**：`scratchCanvas` 改成**模块级单例**（blit 在一帧内同步完成，多实例不会重入），按最大需求尺寸分配；或按需创建 + 空闲释放。省 1/5，保活池下省 (N−1) 张。
- **风险**：低（需一条「两个终端实例交替 blit 结果正确」的测试）。**角色**：frontend。
- **备注**：`blitRows` 用的是 ping-pong（`canvas.bench.mjs` 实测 0.038 ms），**不是** self-blit（4.05 ms 的陷阱）。这条已经做对了，不要动。

### T9 — MED ★ legacy 背压直接杀连接，而不是补一次快照

- **位置**：`apps/gateway/src/ws/websocket-send-guard.ts:151-154`（首次 `ws.send` 返回 −1 即进背压）、`:97-98`/`:121-125`（随后每帧终端输出静默丢弃）、`:208-231` → `:349-369`（drain 时因 `skippedFrame` **terminate 整条 socket**）；第二道杀手是 `apps/gateway/src/runtime.ts:218-219` 的 `backpressureLimit: 1 MiB` + `closeOnBackpressureLimit: true`。
- **根因**：tmux 侧从不被暂停（`apps/gateway/src/tmux-client/` 无任何 read-pause），多余字节在 socket 处丢掉后只能靠断线重连 + 全量历史重放恢复。canonical 这条**已经做对了**（`canonical/pane-stream.ts:234-292` 记账丢弃字节并排显式 `pane_gap` 让客户端 rebase）。
- **改法**：legacy 照抄 canonical —— drain 时发 `LIVE_RESUME` / 快照刷新，而不是 `terminate('backpressure_gap')`。
- **收益**：消掉慢链路上「`cat bigfile` → 断线 → 全历史重放 → 再断」的循环。**风险**：中（改故障路径）。**角色**：backend。

### T10 — MED ★ permessage-deflate 完全没开

- **位置**：`apps/gateway/src/runtime.ts:217-219` 只设了背压参数；全仓 `perMessageDeflate|Sec-WebSocket-Extensions` **零命中**，Bun 默认关闭，浏览器自动发的扩展 offer 在握手时被拒。
- **实测（合成但形态贴近的样本）**：shell 提示符 101.9×（L6）/64.7×（L1），日志行 28.2×/13.2×，TUI 重绘 26.8×/14.8×；吞吐 451–1730 MB/s（L6）、1634–3053 MB/s（L1）。真实混合输出更接近 3–8×，但**压缩的 CPU 只有当前 borsh 编码开销的 1/3 左右**。
- **前置（必须先修）**：三处假设「wire size == plaintext size」——`packages/shared/src/link/websocket-link.ts:27` 与 `pump()`（`:154-165`，用明文长度预测 `getBufferedAmount()`）、`apps/gateway/src/ws/websocket-send-guard.ts:48-53`/`:127-135`、`CanonicalFrameSizer`。
- **注意**：对 WebRTC 直连**毫无帮助**（SCTP 无压缩），受益的恰好是中继/远端这条最需要的路径。
- **风险**：中（走 env 开关灰度）。**角色**：backend。**建议排在 T3 之后**——先把编码器修快，再决定要不要压缩。

### T11 — MED ★ WebRTC 直连每字节拷 2–3 次（r21 未修，仍开着）

- **位置**：浏览器侧 `packages/shared/src/link/fragment-core.ts:115`（`chunk.subarray(8).slice()`）、`:126-131`（`new Uint8Array(frame.bytes)` + `set`）；网关侧再加 `apps/gateway/src/mesh/rtc/data-channel-carrier.ts:68` 的 `copyBytes(toUint8Array(msg))`。**确认未修**：`git log -- fragment-core.ts` 只有两个 2026-08-30 的 commit，早于 r21。
- **对照**：主 ws 路径是 **0 拷**（`client.ts:328` → barrier → `toArrayBuffer`（`:60-66` 直接返回 buffer）→ `decodeEnvelopeView`）。**「加速用的直连比它要加速的 ws 还差」。**
- **击键永远不分片**（`total = 1`），却仍付 4 次堆分配、2 次拷贝、Map insert+delete、`order.indexOf`+`splice`（`:189-195`）、`expire` 全表扫（`:184-186`）。
- **最便宜的改法**：`assemble` 在 `total === 1` 时直接返回 `piece`；去掉 `data-channel-carrier.ts:68` 的冗余 `copyBytes`（只给 `:69` 的 9 字节 liveness 探针留一份）。覆盖压倒性多数的单片场景。
- **风险**：低—中（需确认返回视图的生命周期，目前 `:115` 的 `slice()` 把这个问题遮住了）。**角色**：complex-perf。

### T12 — LOW-MED ★ 客户端心跳无视服务端协商值（5 s vs 15 s）

- **位置**：网关在 HELLO_S2C 播报 `heartbeatIntervalMs: 15000`（`apps/gateway/src/ws/index.ts:548`），客户端硬编码 `DEFAULT_HEARTBEAT_INTERVAL_MS = 5000`（`packages/ws-client/src/client.ts:68`），**全仓没有任何代码读这个协商字段**。
- **代价**：12 PING + 12 PONG/min，每条 28 B 应用层 / ~105 B 上线 ≈ **2.5 KB/min、24 次唤醒/min** —— 空闲会话上字节数第 1、唤醒数第 2 的项。采纳协商值可 3× 削减。15 s ping / 30 s timeout 仍远在 `client.ts:70-71` 注释所依据的 ~100 s Cloudflare Tunnel 预算内。
- **代价面**：死连接检出 10 s → 30 s，属产品决策，建议配更紧的 timeout 系数。**角色**：frontend。

### T13 — LOW-MED ★ canonical 每帧多 50 B，且把最大帧砍半

- **位置**：`CANONICAL_STATE_MAX_FRAME_BYTES = 32 KiB`（`packages/shared/src/ws-borsh/canonical-state.ts:13`）对 legacy 的 `GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES = 64 KiB`（`terminal-output-batcher.ts:2`）→ **同样输出、两倍帧数**。
- **实测线上帧尺寸**（deviceId = 36 字符 uuid，paneId = `%12`）：legacy TERM_OUTPUT = payload + **68 B**；canonical PaneData = payload + **118 B**。击键：legacy TERM_INPUT **70 B**，canonical **135 B**（+93%）。多出的 50 B = serverEpoch(16)+paneEpoch(16)+seqStart/seqEnd(16)+version/tag(3)。生产常态是平均 79 B 的小帧，**开销占比 legacy 46% / canonical 60%**。
- **改法**：从 PaneData 的 `CanonicalPaneTarget` 去掉 `serverEpoch`（订阅 generation 已经钉死它）= 免费省 16 B/帧；提高 canonical 帧上限需要 v1.1 协议决策。
- **判断**：**先做 T3/T5 再回来量**，不要先动线格式。**风险**：中（wire format）。**角色**：backend。

### T14 — LOW ★ `clearTextarea()` 每次击键无条件写 DOM

- **位置**：`packages/ghostty-terminal/src/terminal-dom.ts:450-454`（`this.helperTextarea.textContent = ''`），被 `terminal-input.ts` 的 keydown/keyup/beforeinput/input/composition 路径调用共 11 处。
- **根因**：`textContent = ''` 即使已经是空串也会使 contenteditable 子树的布局失效；随后 `positionTextareaAtCursor` 会读几何。
- **改法**：`if (this.helperTextarea.textContent !== '')` 守卫。3 行。
- **收益**：击键路径上少一次样式/布局失效。**风险**：极低。**角色**：frontend。**顺手做**。

---

## 2.5 终端画布之外的 React/UI 卡顿（并行子探索，独立实测）

先记两条**已清零、别再当 checklist**的：全量扫过 `apps/fe/src` 与 `packages/{panels,terminal-ui,ui,stores}/src` 的 148 处 store 调用，**「返回新对象/数组的 zustand selector」零命中**；9 个 `createContext` 的 Provider value **全部已 `useMemo`，裸字面量零命中**。

### U1 — HIGH ★★★ 终端字号 / 行高输入每敲一键重建全部已挂载的 ghostty 实例

- **位置**：`packages/panels/src/settings/terminal-settings-panel.tsx:129`、`:152`（`onChange` 直接 `setTerminalFontSize` / `setTerminalLineHeight`）；`packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts:294-295,323`（effect deps 含 `fontSize`/`lineHeight` → cleanup + 重建 controller）；`packages/terminal-ui/src/components/TerminalPreview.tsx:161`（预览也整块重建，含 `await loadTerminalFonts`）；`packages/stores/src/ui.ts:239`（`deferredKeys: ['editorDrafts']`，字号不在内）。
- **根因**：这个面板不止在设置页——`packages/panels/src/device-console/page-actions.tsx:41` 把它以 sheet 挂在**设备页工具栏**上，面板打开时下面是活着的终端（保活 3 个，分屏下是该 window 全部 pane）。按住数字输入框的上下箭头（约 30 次/秒），每一次都是「N 个 ghostty controller dispose + 重建 + 重放 history」加一次 17 键快照同步落盘。
- **改法**：`fontSizeInput`/`lineHeightInput` 的本地草稿态已存在，改成 onBlur / debounce 提交；把 `terminalFontSize`、`terminalLineHeight` 加进 `deferredKeys`。
- **收益**：连续调节从 O(30×N 次终端重建) 降到 1 次。**风险**：低（语义从即改即生效变成松手生效，需产品确认）。**角色**：frontend。

### U2 — HIGH ★★ `CodeViewer` 在 render 内同步跑 highlight.js

- **位置**：`packages/panels/src/code-viewer/code-viewer.tsx:213`（`useMemo(() => highlightCode(...))`）、`:196-200`。
- **实测**：500 KB TS（已知语言）**232.3 ms**，产出 1.79 MB HTML / 35,619 个 `<span>`；195 KB → 92.6 ms；63 KB 未知扩展名走 `highlightAuto` **284.6 ms**；16 KB → 135.8 ms。
- **根因**：护栏（`AUTO_DETECT_LIMIT = 64 KB`、`HIGHLIGHT_LIMIT = 512 KB`）是按「1 MiB 冻 7.7 s」标定的，**阈值内仍有 ~285 ms 的硬冻结（17 帧）**。512 KB–2 MiB 区间虽跳过高亮，仍要一次性注入 2 MB 文本 + `Array.from({length: 6万}).join('\n')` 的行号栏。
- **改法**：highlight 挪出渲染路径（Worker 或 `startTransition` + 分块）；行号栏改 CSS counter；大文件按行块渲染 + `content-visibility: auto`。
- **风险**：中（hljs 的 span 跨行，分块要按 emitter 分行或改 lowlight 产 hast 再切）。**角色**：complex-perf。

### U3 — HIGH ★★ 流式 markdown 的未封口块每 40 ms 全量重 parse

- **位置**：`packages/panels/src/markdown/streaming-markdown.tsx:130-136`、`:148-151`；节流源 `packages/stores/src/agent-delta-buffer.ts:6`（`DELTA_FLUSH_MS = 40`）。
- **根因**：分块策略本身没问题（sealed 块命中 memo），但 agent 常见输出是**一个从不封口的大代码块**（补丁 / 长文件），`openStart` 一直不推进，每 40 ms 把整个尾块喂一遍 `react-markdown`。
- **实测**：45 KB 未封口块每次 flush 均值 1.70 ms（末尾 3.06 ms）⇒ ~43 ms/s；**150 KB 时均值 5.70 ms（末尾 13.10 ms）⇒ ~143 ms/s，即 14% 主线程**。
- **改法**：尾块检测到「已开围栏、未闭合」时短路，直接渲染 `<pre><code>{tail}</code></pre>`，封口后再交回 `MarkdownBlock`（围栏内本来就不解析 markdown）。
- **风险**：低。**角色**：complex-perf。**这是「agent 会话页越用越卡」的直接解释。**

### U4 — HIGH ★★ 整对象订阅 `snapshots[deviceId]`，把 metadata patch 放大成整页重渲染

- **位置**：生产侧 `apps/gateway/src/tmux-client/metadata/types.ts:5`（`DEFAULT_FLUSH_INTERVAL_MS = 8` ⇒ 上界 **125 patch/s**，来源是 OSC 0/2 标题、OSC 7 cwd、`refresh-client -B` 的 `pane_current_command`）；消费侧 `packages/stores/src/tmux-event-router.ts:179-186` 整张 `snapshots` 换引用，`packages/shared/src/ws-borsh/legacy-snapshot-draft.ts:35,110-118` 的 COW 里 `session` 与 `windows` 数组**必换引用**；放大点 `packages/panels/src/device-console/terminal-stage.tsx:237`（`useDeviceLivePaneIds` 订阅整个 snapshot）、`use-console-targets.ts:34`、`packages/terminal-ui/src/components/split/SplitPaneView.tsx:75`（**无 memo**）、`packages/terminal-ui/src/components/Terminal.tsx:19`（**无 memo**）。
- **旁证**：`packages/panels/src/device-tree/sidebar-device-list.tsx:137` 的注释「本组件订阅了 snapshots，终端每次输出都会重渲染」正是作者自己观察到的同一现象。
- **改法**（三步逐步收敛）：(a) `useDeviceLivePaneIds` 改订阅派生字符串键而非 snapshot 对象；(b) `memo` 包住 `SplitPaneView` 与 `Terminal`（内部回调已全部 ref 化，只需把 `() => {}` 字面量 props 提成常量）；(c) 评估 `DEFAULT_FLUSH_INTERVAL_MS` 8 → ~50。
- **风险**：(a)(b) 低；(c) 中（影响标题/cwd 可见延迟）。**角色**：complex-perf（a/b 可 frontend 做）。
- **与 T1 的关系**：T1 停的是隐藏 pane 的**画**，U4 停的是全体 pane 的**React 重渲染**，两者互补，都要做。

### U5 — MED-HIGH ★ 文件树每一行常驻一个 `ContextMenu.Root`

- **位置**：`packages/panels/src/files/files-node-roots.tsx:338-403`（`FileLeaf` 每行一个 `<ContextMenu>` + 两次 `useTranslation` + `useFileNodeActions`）、`:47`（`DISPLAY_CAP = 500`）、`:307-317`（「显示全部」可到后端上限 2000）。
- **实测**（SSR 基准，500 行，20 次均值）：纯 `<button>` 1.74 ms → `+useTranslation` 6.85 ms → `+ContextMenu.Root+Trigger` **29.18 ms（17× 基线）**。真实 DOM 挂载更贵。
- **触发时机不止首次展开**：`use-directory-listing.ts:36` 的 `LIST_POLL_MS = 30_000` 每 30 s refetch，新 `entry` 对象打穿 `FileLeaf` 的 memo，500 行全量重渲染。
- **改法**：右键菜单提到树根做**一个**共享 `ContextMenu`，行只在 `contextmenu`/长按时把自己的 `entry` 写进 target store。
- **风险**：中（长按手势要自己接一遍，e2e 有依赖）。**角色**：complex-perf。
- **备注**：这比 r21 遗留的「文件树虚拟化」更值得先做——**虚拟化解决的是行数，这一条解决的是每行 17 倍的单价**。

### U6 — MED-HIGH ★ mesh 侧栏三处不稳定引用打穿 memo（3 行改动）

- `apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:372-376`：`expansionKeyFor` 内联箭头 ⇒ `sidebar-device-list.tsx:173/187/196` 三处依赖 ⇒ `DeviceRow` 的 memo（`device-row.tsx:16`）**100% 失效**，且「每渲染对每台可见设备调一次 `ensureDeviceSubscribed`」。
- `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:90`：`drag={{ sortable, dragHandleLabel }}` 字面量 ⇒ `memo(SidebarNodeRuntimeSection)` 永远 bail 不掉 ⇒ 整个 node 的设备树全量重渲染。
- `apps/fe/src/pages/devices/node-device-group.tsx:243`：`nodeDeviceContext(node)` 每渲染新对象 ⇒ 穿过 `device-management-panel.tsx:112-115` → `device-grid.tsx:114-117` 的 `cardProps` ⇒ `memo(SortableDeviceCard)` 对全页卡片失效。
- **触发频率**：mesh `NODE_EVENT`（RTT 事件节流 10 s，ping 周期 15 s）⇒ 链路有抖动时**每个远端 peer 每 10–15 s 一次全树重渲染**；拖拽分节时每帧一次。
- **改法**：三处各加一个 `useCallback`/`useMemo`。**风险**：极低。**角色**：frontend。**性价比最高的一条。**

### U7 — MED ★ 分屏拖拽无 rAF 合并 + 每 pointermove 全文档 `querySelectorAll` + rect

- **位置**：`packages/terminal-ui/src/components/split/useSplitDragInteractions.ts:88-91`（splitter `onMove` 直接 `setDragState`）、`:161-180`（标题栏 `onMove` 每次 `resolveTarget`）、`:44-55`（`collectSidebarCandidates`：两次 `document.querySelectorAll` + 每个窗口行/侧栏一次 `getBoundingClientRect`）。
- **根因**：r21 已在侧栏 resizer 上修掉同一类问题（`packages/ui/src/components/sidebar/resize-controller.ts` 的 rAF 合并 + 单次落盘），**分屏这条没跟上**。触控板 pointermove 约 120 Hz，一帧两次；rect 读发生在 React 刚提交完浮动标签 `left/top` 之后 ⇒ 每帧两次强制同步布局，布局范围含整棵已展开侧栏（可达上千行）。
- **改法**：照抄 `createSidebarResizeController` 的形状；`collectSidebarCandidates` 的 rect 在 pointerdown 时量一次缓存。**风险**：低。**角色**：frontend。

### U8 — MED ★ 快捷键编辑器每键约 6N 次 `JSON.stringify`

- `packages/panels/src/settings/use-terminal-shortcuts-editor.ts:43-51`（`normItem`）、`:206-212`（effect deps 含 `items`）、`:214-217`（`dirty` useMemo）。默认 12 条无上限 ⇒ 每敲一个字符约 72 次 stringify，同帧还要重跑 N 次 `useSortable` 并给 `SortableContext` 喂新数组。payload 输入框已用本地草稿 + onBlur，**只有 label 那条没跟上**（`shortcut-list.tsx:93 → :353`）。
- **改法**：`normItem` 改逐字段比较；`:206` 的 effect 用 ref 读 `items`；label 输入框对齐 payload 写法。**风险**：低。**角色**：frontend。

### U9 — MED ★ 站点设置草稿 state 挂在页级

- `apps/fe/src/pages/settings/use-site-settings-form.ts:73`，在 `apps/fe/src/pages/SettingsPage.tsx:142` **无条件**页级调用。每一次按键 → SettingsPage 重渲染 → 7 个 `TabsTrigger` + 整个活动 tab。放大因素：**settings 三个目录里 `React.memo` 出现次数为 0**（已 grep 验证）。notifications tab 下意味着 Telegram / 微信 / Webhooks 三张卡每键全量重渲染。
- **改法**：草稿 state 下沉到真正用它的两个 tab，或给三张子卡加 memo。**风险**：低。**角色**：frontend。

### U10 — MED ★ `ToolCallCard` 每张卡常驻一个关闭的 Dialog root

- `packages/panels/src/agent/messages/tool-call-card.tsx:471-475`（无条件渲染 `<Dialog open={false}>`）；`ChatThread` 窗口 `WINDOW_STEP = 200`（`chat-thread.tsx:22`）⇒ 工具密集会话里上百个 base-ui Dialog root 常驻。另 `tool-brief.ts:12,60` 对未知工具 `JSON.stringify(call.input, null, 2)` 后只取前 60 字符。
- **改法**：`{dialogOpen && <ToolDetailsDialog .../>}`；`asText` 先截断再序列化。**风险**：极低。**角色**：frontend。

### U11 — MED ★ 目录选择器 2000 行未虚拟化 + 每次高亮一次全列表属性选择器

- `packages/panels/src/settings/directory-picker-modal.tsx:174`（`entries.map`）、`:322-327`（每次 `highlight` 变化 `querySelector('[data-picker-index="N"]')` + `focus()`）。后端硬截断 2000（`apps/gateway/src/files/categorize.ts:4`）⇒ 打开 `/usr/bin`、`node_modules` 一次铺 2000 个 button ≈ 6000+ 节点。仓库内**无任何虚拟化方案**（`react-window`/`Virtuoso` 零引用）。
- **改法**：`ref` 数组代替 `querySelector`（5 行，立省线性扫描）；超阈值上 `content-visibility: auto`。**风险**：低。**角色**：frontend。

### U12 — LOW-MED ★ 每个 pane/window 行渲染都重建 action 数组

- `packages/panels/src/device-tree/use-row-action-items.ts:7`、`:40`（都无 `useMemo`）；`buildPaneActions`（`device-tree-actions.ts:133`）每次造 6–8 个对象 + 同样多闭包 + 6–8 次 `t()`。调用点 `pane-row-content.tsx:64` / `window-row-header.tsx:88`，**每行每渲染一次**，而菜单未打开时完全用不上（`DropdownMenuContent` 懒渲染）。跟随 U4 的 metadata patch 频率放大。
- **改法**：`useMemo`，或挪到菜单打开时才构造。**风险**：极低。**角色**：frontend。

---

## 3. 明确「不值得做」（含理由与实测）

| 项 | 判定与理由 |
|---|---|
| **字形图集 / `ImageBitmap` 缓存** | **实测 4× 负收益**：run 批绘 0.599 ms vs 逐 cell `drawImage` 2.350 ms（atlas canvas）/ 2.411 ms（ImageBitmap）。r21 的 run 批绘已经把 3935 次绘制压到约 200 次，图集方案必然退回逐 cell 一次调用，调用次数反弹 20 倍。**不做。** |
| **fork ghostty 加「整行批量读」导出** | 理论上能把 §1.3 的 95 ns/cell 再压到 ~20 ns/cell，但：① `vendor/ghostty` 是**上游锁定的 submodule**（`.gitmodules` 指 ghostty-org/ghostty，本地未 checkout），`packages/ghostty-terminal/scripts/ghostty-wasm.ts` 的 `verify:wasm` 用 gitlink commit 做校验，fork 会破坏这条不变量并绑上 zig 工具链维护成本；② **T4 的纯 JS 扁平化已经实测 2.25×，且完全不需要它**。**先做 T4，做完再量；除非那时仍是瓶颈，否则不做。** |
| **单独提 `bindings.view()` 到循环外** | 实测只值 **11%**（JIT 把单态 getter 内联得不错）。它是 T4 的组成部分，**不要当独立项去做**——单做会消耗一次 `render-state.ts` 的改动预算却只换来 0.12 ms。 |
| **单独用 `get_multi`** | 实测只值 **1.27×**（读取层 88 → 69 ns/cell）。同上，是 T4 的组成部分而非独立项。 |
| **把 `buildRowText` 的 `+=` 改成 `join`** | **实测 `join` 更慢**（935 vs 612 ns/行），且全帧只占 0.024 ms。**不改。** |
| **把 `row.text` 改成惰性求值** | 想法成立（`row.text` 在生产渲染路径上零消费者，只被 e2e 与 `terminal-diagnostics.tsx:166` 读），但收益就是上面那 0.024 ms/帧，而惰性 getter 会在 40 个对象上加一层间接。**不值得。** |
| **`readScrollbar` 的 `allocStruct`/`free` 与三次 `new DataView`** | `ghostty-wasm.ts:820-843`，实测约 400 ns，每帧一次 ⇒ 占 2.7 ms 帧的 0.015%。**排除。** |
| **canvas 背景遍的冗余 `clearRect`** | `canvas-renderer.ts:530`，整屏 40 次 ≈ 0.004 ms，且对「位图被外部清空」的防护语义有价值。**排除（r21 已判定，本轮复核维持）。** |
| **把客户端 pane 合并改成 rAF** | `pane-output-coalescer.ts:4` 的注释是对的：一帧 16.7 ms 比 4 ms 更糟。**正解是 T2 的 leading-edge，不是换成 rAF。** |
| **换掉 borsh 线格式** | 已经是二进制，**没有 JSON 信封、没有 base64**（唯一的 JSON-in-borsh 是 `state-snapshot-diff.ts:83` 的元数据 diff，不在输出路径）。问题在编码器实现（T3），不在格式。 |
| **在 WebRTC datachannel 上做用户态压缩** | 直连的价值是 RTT；它本来就已经每字节 2–3 拷（T11），再加 deflate 是拿它唯一的长处换它通常不需要的字节。 |
| **RTC liveness 3 s → 15 s（r21 的 O13）** | 仍是 3 s（`apps/gateway/src/mesh/rtc/liveness.ts:4`），但它**已有空闲抑制**（`:139` 区间内有入站就跳过），且**根本不在浏览器路径上**（`ChannelLiveness` 只存在于 node↔node 的 `DataChannelLink`；浏览器的 `DataChannelCarrier` 只应答不主动探测）。r21 的判断成立，**维持不做**。 |
| **给客户端发送加 `bufferedAmount` 检查** | `client.ts:570-574`。输入帧 ~70 B，pending 队列已有 2 MiB / 2048 帧上限且溢出时丢输入（`websocket-transport.ts:322-345`）。无实际问题。 |
| **REST 轮询 / 服务端定时广播** | 终端会话期间只剩一个 `GET /api/mesh/nodes`（300 s、有可见性门控、单 owner，约 0.2 req/min）；`apps/gateway/src/ws/` 下**没有任何 `setInterval`**，两个 30 s 指标窗口是在入站事件上求值。**没得优化。** |
| **`page-wrapper` 的 `backdrop-blur`** | r21 已移除，本轮复核确认。剩下的 `backdrop-blur` 只在对话框遮罩与 `SelectionToolbar.tsx:31`（短暂、面积小）。**不是卡顿来源。** |
| **终端根的 `contain`** | r21 已落地（`terminal-dom.ts:40` `root.style.contain = 'layout paint style'`）。**已完成。** |
| **`lineCache` 无上限（r21 F4）** | 已修：`terminal-render-coordinator.ts:66-68` 有 LRU 上限 + 只在 `selectionActive` 时填充。**已完成。** |
| **WebGL / WebGPU 渲染器** | run 批绘后整屏 1.48 ms，桥修完后 0.5 ms，合计约 2 ms/帧。重写渲染层的收益不足以抵消「字形对齐 / 块元素自绘 / 选区/链接/光标四层 / DPR / 像素 oracle 测试」这一整套已经验证过的正确性资产。**本轮不做。** |
| **「路由切换重挂终端页」** | **不存在**。读了 `react-router@7.13.0` 的 `_renderMatches`（`dist/development/chunk-JZWAC4HX.mjs:5920-5985`），`RenderedRoute` 不带 key；`devices/:deviceId` 与 `.../panes/:paneId` 的 `element` 是同 type + 同 props（`moduleLoader` 是模块级常量），React 按位置复用，**切 pane 不重挂**。 |
| **优化 `advanceMarkdownSplit` 的增量扫描** | 实测最坏 0.088 ms/delta（150 KB 未封口块）。钱全在 `react-markdown` 那一步（U3），**别优化错地方**。 |
| **排查「返回新对象的 zustand selector」/「裸字面量 context value」** | 全量扫过 148 处 store 调用与 9 个 `createContext`，**两类均零命中**。本仓已清零，从 checklist 里删掉。 |
| **CSS 合成层 / `transition: all` / `will-change`** | `backdrop-blur` 共 6 处，全在 dialog/sheet 遮罩与 `SelectionToolbar`/`ResolvingOverlay` 上，**都不覆盖持续重绘的表面**；`transition: all` 仅 1 处（`sidebar-layout.tsx:210` 的 SidebarRail，不参与内容动画）；`will-change: transform` 已用在唯一需要的地方（`index.css:193`）。**这条轴没有可摘的果子。** |
| **侧栏 ~900 个 `useTranslation` / ~230 个 `useSortable`** | 真实存在（3 node × 4 设备 × 6 窗口 × 2 pane ≈ 144 pane 行），但改成 prop 传文案是几十个文件的大 diff，收益要在虚拟化之后才谈得上。**先做 U6，再重新量。** |
| **`ChatThread` 虚拟化** | `WINDOW_STEP = 200` 已封顶，且吸底/锚点回写逻辑（`chat-thread.tsx:140-185`）与虚拟化天然冲突。收益不抵风险。 |
| **`dnd-kit` 的 `MeasuringStrategy.Always`** | `device-folder-tree.tsx:486`。是拖拽期唯一的同步布局来源，但 `:485` 的注释说明了为什么必须 Always（分组自动展开、占位条插拔）。**已知取舍，记录不改。** |
| **给 react-query 轮询加可见性门控** | 已由 query-core 5.90.20 的 `queryObserver.js:215` + `focusManager.js:60` 全局兜住，仓库内无一处 `refetchIntervalInBackground: true`。**不用做。** |
| **隧道 tab 空闲 10 s 轮询** | `remote-access/tunnel-model.ts:509-513` 是唯一没有「空闲即停」出口的轮询，但切走 tab 即卸载、页面隐藏时 `focusManager` 自动跳过。影响面太小。 |
| **文件树虚拟化（r21 遗留）** | 不是不做，而是**次序在 U5 之后**：虚拟化解决行数，U5 解决每行 17 倍的单价。先把 `ContextMenu.Root` 提到树根，再量还需不需要虚拟化。 |

---

## 4. 建议的落地顺序与分工

### 4.1 第一批（低风险 / 高确定性，建议并行铺开）

| 序 | 项 | 角色 | 大小 | 预期 |
|---|---|---|---|---|
| 1 | **T2** leading-edge 发射（网关 + 客户端） | backend + frontend | S+S | 击键 −20 ms，**手感提升最直接** |
| 2 | **U6** mesh 侧栏三处不稳定引用 | frontend | XS（3 行） | 挡住「每 10–15 s 全树重渲染」 |
| 3 | **U1** 终端字号/行高 onBlur + `deferredKeys` | frontend | S | 设置面板不再冻结 |
| 4 | **T5** canonical 客户端零拷贝解码 | codex / opus5 | S | 每帧 96.6 µs → 0.72 µs（**修 r21 回归**） |
| 5 | **U4(a)(b)** 窄订阅 + `Terminal`/`SplitPaneView` 加 memo | frontend | S | 每次 metadata patch 不再整页重渲染 |
| 6 | **T1** 隐藏保活 pane 挂起渲染 | codex 核心 + opus5 接线 | M | 多 pane 终端渲染 −67%，PWA 节电 |
| 7 | **U3** 未封口块短路渲染 | codex | S | agent 会话主线程 −14% |

### 4.2 第二批（性能纵深）

| 序 | 项 | 角色 | 大小 | 预期 |
|---|---|---|---|---|
| 8 | **T3** borsh 融合编码器 | codex | M | 网关输出编码 113× |
| 9 | **T4** 渲染桥读取层扁平化 | codex | M/L | 整屏帧桥开销 1.06 → 0.55 ms |
| 10 | **T6** mesh 中继换 view 解码 | backend | S | 每帧每跳 −110~220 µs |
| 11 | **U2** CodeViewer 高亮出渲染路径 | codex | M | 消掉 ~285 ms 硬冻结 |
| 12 | **U5** 文件树共享 ContextMenu | codex | M | 500 行渲染 29.2 → ~7 ms |
| 13 | **U7** 分屏拖拽 rAF 合并 + rect 缓存 | frontend | S | 拖拽期每帧两次强制布局归零 |
| 14 | **T7** 触摸惯性 | frontend | S/M | 移动端主观跟手 |
| 15 | **T8** scratch canvas 单例 | frontend | S | 移动端显存 −20% |
| 16 | **T9** legacy 背压补快照 | backend | M | 慢链路不再断线重放 |
| 17 | **T11** WebRTC 单片零拷贝 | codex | S | 直连每帧少 2 次拷贝 |

### 4.3 顺手 / 后置

| 项 | 角色 | 说明 |
|---|---|---|
| **U8** 快捷键 label 草稿化、**U9** 站点设置草稿下沉、**U10** Dialog 条件渲染、**U11** picker ref 数组、**U12** action 数组 memo、**T14** `clearTextarea` 守卫、**T12** 采纳协商心跳 | frontend | 全部 XS–S、风险极低，适合打包成一个「顺手」commit |
| **T10** permessage-deflate | backend | 需先修三处 wire-size 假设；**排在 T3 之后**再决定 |
| **T13** canonical 帧头瘦身 / 帧上限 | backend | 协议决策，做完 T3/T5 再量 |
| **U4(c)** metadata flush 8 → 50 ms | backend | 影响标题/cwd 可见延迟，需确认无测试依赖 8 ms |
| T7 亚行像素级平滑 | — | L，主观流畅度上限，改动面大，**单独立项** |

**如果只做三件**：**T2**（击键 −20 ms）、**U6**（3 行挡住全树重渲染）、**T1**（隐藏 pane 停渲染）。这三条分别对应用户描述的三种不流畅——「打字有延迟感」「侧栏一抖整页卡一下」「多开几个 pane 就卡」——合计改动量小、风险低、可独立验证。

---

## 5. 复现脚本位置

本轮新写的一次性测量脚本全部在 scratchpad，**未进仓库**（工作区仅有并行探索者的 `?? zz-ex2-repro.test.ts` 与本目录）：

```
/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/0685432d-fa27-4053-992e-6fa2f83cfd6c/scratchpad/
  cell-attrib.ts     view()/buffer()/DataView/导出调用的单项微基准
  cell-steps.ts      readRowCells 逐步归因（L0..L5，3 pass）
  phase-split.ts     整屏帧的 write/update/iterate/meta/line 拆分
  view-hoist-sim.ts  view() 零开销上限模拟
  multi-read.ts      get_multi 打包读 vs 逐项 get
  full-sim.ts        扁平化重写 vs 真实 iterateRows（2.25×）
  throughput.ts      writeVt 吞吐（MiB/s）
  rowtext.ts         buildRowText += vs join
  atlas.bench.mjs    字形图集 vs run 批绘（playwright/chromium）
  fused-encoder.bench.ts / wire.bench.ts   融合 borsh 编码器、线上帧尺寸、deflate 取舍（复制到 apps/gateway/bench/ 后跑）
  md-bench.ts / md-render-bench.tsx        streaming-markdown 增量分块、react-markdown 每 delta 重 parse
  hljs-bench.ts / auto-bench.ts            highlight.js 已知语言 / highlightAuto（需放 packages/panels/ 下解析 workspace 依赖）
  ctx-bench.tsx                            文件树行成本（纯 button / +useTranslation / +ContextMenu）
```

全程未起 dev server、未碰 9883、未碰 `~/Library/Application Support/tmex/`、未对任何 tmux session 做任何操作。

建议把其中三条**固化进仓库 bench**（它们是 T4 的验收指标）：

- `render-bridge.bench.ts` 增加「整屏帧的阶段拆分」输出（write / iterate / line 三个数），让 T4 的收益一眼可见；
- `canvas.bench.mjs` 增加 atlas 对照组，把「不做图集」这个结论钉在回归里，避免下一轮再提一次；
- `full-sim.ts` 的 `ns/cell` 作为 T4 的门禁数字。
