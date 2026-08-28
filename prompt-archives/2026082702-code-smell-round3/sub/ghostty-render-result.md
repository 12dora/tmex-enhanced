# ghostty 渲染桥 P0 性能优化结果

范围：`packages/ghostty-terminal/src/{render-state,canvas-renderer,terminal-render-coordinator,ghostty-wasm}.ts` + `bench/`。
验证：`bun test` 175 pass / 0 fail（原 159 + 新增 16）；`bunx tsc --noEmit -p .` 0 error；biome 只剩 5 个 baseline 里就有的 `void in union` 报错（未新增）。

## 1. WASM 导出面调研：没有 dirty / 版本号 / damage API

对 `src/assets/ghostty-vt.wasm`（ghostty `43a05dc`）做了导出表与类型 JSON 的完整枚举，并逐个 data key 探测：

- **没有任何 damage / row-version / 内容哈希导出**。`ghostty_row_get` 的 8 个合法 key 里没有版本计数器；`GHOSTTY_RENDER_STATE_ROW_DATA_RAW` 返回的 u64 是行槽位句柄（写入内容不变，只在 style 出现时因高位 flag 变化），不能当内容指纹。
- **内核的 dirty 位在本构建里恒为真**：`ghostty_render_state_get(state, 3)` 每帧都返回 `2`（= `full`），每一行的 `row_dirty` 都返回 `1`，即使两帧之间完全没有写入。也就是说改动前 canvas 每帧都在全屏重画，`dirty === 'partial'` 分支从未被真实数据触发过。
- 存在一族此前未使用的批量导出 `ghostty_{cell,row,render_state,render_state_row,render_state_row_cells}_get_multi`。实测签名为 `(handle, count, keysPtr /* u32[] */, valuesPtr /* ptr[] */, outWrittenPtr)`，成功时 `outWritten = count`，失败时返回 `-2` 且 `outWritten` 是失败 key 的下标（可用于处理「该 cell 无 fg/bg 颜色」这种 `INVALID_VALUE`）。**实测收益接近 0，故未采用**，见第 4 节。

## 2. 基准（`bench/render-bridge.bench.ts`）

120×40，120 个计时帧（前 20 帧预热），`performance.now()`，走与测试相同的 `getGhosttyBindings()` 真 wasm。计时段 = `updateRenderState + iterateRows + LineModel 构建`（LineModel 只为「内容变化的行」构建，与 coordinator 一致）。

BEFORE 用 `git show HEAD:` 取出的原始四个文件 + **同一份 bench** 跑出，保证同口径。取 3 次运行的中位数。

| 场景 | BEFORE mean | AFTER mean | BEFORE p50 | AFTER p50 | 提升 |
|---|---|---|---|---|---|
| full update（40/40 行重写） | 6.75 ms | **1.37 ms** | 5.90 ms | 1.29 ms | 4.9× |
| single dirty row（1/40） | 6.41 ms | **1.24 ms** | 5.76 ms | 1.16 ms | 5.2× |
| 20% dirty rows（8/40） | 6.55 ms | **1.28 ms** | 5.74 ms | 1.19 ms | 5.1× |

下游效果（同一次运行统计）：

| 指标 | BEFORE | AFTER |
|---|---|---|
| 每帧被判为脏的行数（single dirty 场景） | 40.0 / 40 | **0.8 / 40** |
| 每帧被判为脏的行数（20% 场景） | 40.0 / 40 | **8.0 / 40** |
| `meta.dirty` 非 `full` 的帧数（single / 20%） | 0 / 120 | **120 / 120** |

即：主画布从「每帧重画 4800 个 cell」变成「每帧重画约 1~8 行」。这部分收益不在上表的毫秒数里（bench 不含 canvas），在真实浏览器里是更大的一块。

每 cell 的边界调用次数（120×40 单帧实测，稳态）：

| | BEFORE | AFTER |
|---|---|---|
| wasm 导出调用 | 24.82 / cell | **8.97 / cell**（−64%） |
| `bindings.view()` | 17.76 / cell | **7.82 / cell**（且不再每次 `new DataView`） |

微基准（每次调用平均）：`single_get` 8.3 ns、`get_multi(3 keys)` 23.5 ns、`allocBytes+freeBytes` 29 ns、`new DataView(memory.buffer)` 34 ns、缓存命中的 `bindings.view()` 15 ns（含调用开销）。

## 3. 改了什么

**`ghostty-wasm.ts`（最小改动，23 行）**
- `view()` 无参形态缓存整块 `DataView`，按 `memory.buffer` 的对象身份判失效。这是单点最大收益：改动前每读一个字段就 `new DataView`（34 ns），一个 cell 十几次。
- 身份检查不能省：实测把它换成「只要有缓存就返回」会立刻抛 `Underlying ArrayBuffer has been detached` —— `ghostty_render_state_update` 帧内会触发 `memory.grow`。同理，跨 wasm 调用持有 `DataView` 局部变量是不安全的，代码里所有 view 都在 wasm 调用之后重取。

**`render-state.ts`**
- **常驻暂存区**：每个 render state 一次性 `allocBytes` 一块 8 字节对齐的内存（u64 / u32 / u8 / `GhosttyStyle` / `GhosttyColorRgb` / `GhosttyRenderStateColors` / 64 个 codepoint 的 grapheme 缓冲），替代原先每次读取一对 `alloc/free`。懒分配，`createRenderState` 不碰 bindings（`render-state.leak.test.ts` 的假 bindings 才能继续工作），`dispose` 时归还。
- **调色板/meta 跨帧缓存**：`updateRenderState` 不再清空 `cachedMeta`，改为按 `snapshotVersion` 失效。颜色的真实变更信号是「把 `GhosttyRenderStateColors` 读进常驻暂存区后按字节比对」——每帧 1 次导出调用 + 784 字节 memcmp，换掉每帧重建 256 个 palette 对象。字节相同就整个 `GhosttyRenderColors` 对象复用（引用相等可判）。
- **对象内插**：style 按「8 个 bool + underline」打包成整数键内插，颜色按 `(r<<16)|(g<<8)|b` 内插；空 cell 复用同一个只读空 codepoints 数组，单 ASCII 码点复用预建的字符串/单元素数组表。整屏 4800 个 cell 通常只产生个位数 style 实例和几十个颜色实例。
- **逐 cell 比对 + 行复用**：因为内核没有版本号（第 1 节），行指纹只能在「反正要读」的过程中顺带算。读出每个 cell 的原始值后先和上一帧同位置比对（style/颜色已内插 → 退化成引用相等），相同就复用上一帧的 cell 对象（不新建）；整行 cell 全相同且 wrap 标志不变就复用整个行对象（含 `cells` 数组与 `text`），并把 `row.dirty` 置为 `false`。
- **`dirty` 降级**：完整迭代结束后，若上一帧覆盖同样几何且配色未变，把内核恒报的 `full` 按实际变化行数降级为 `partial` / `clean`。首帧、resize、主题切换一律保持 `full`（安全下限）；迭代被中途打断则不更新缓存也不降级。
- 同一 `snapshotVersion` 内重复 `iterateRows` 直接吐上一次的行，不重复读 wasm。

**`terminal-render-coordinator.ts`**
- `renderNow` 改成先 `iterateRows` 再 `readRenderSnapshotMeta`（降级发生在迭代结束）。
- LineModel 按 `row.cells` 数组的**对象身份**用 `WeakMap` 缓存。之所以不按「绝对行号 + row.dirty」跳过重建：那样在「滚动 + 屏外行被改写」的组合下可能取到过期模型；按数组身份则是数组换新即 miss，不存在过期窗口，且 `lineCache` 仍然每帧全量写入，语义与改动前完全一致。
- ±1 邻行重绘策略未动。

**`canvas-renderer.ts`**
- 颜色缓存键从 `"r,g,b"` 字符串改成打包整数；字体缓存从字符串键 Map 改成 4 个变体（regular/italic/bold/bold-italic）的定长数组，`resize()` 内随 `deviceFontSize` 失效。每 cell 不再产生临时字符串。
- **选区层**：记住上一次画过的矩形集与颜色，两者与画布尺寸都没变就整帧不碰这一层（没有选区的常态帧原本每帧一次全层 `clearRect`）。
- **光标层**：记住上一次画过的设备像素矩形与颜色，位置/形状/闪烁/颜色/宽度都没变就整帧跳过；需要重画时只 `clearRect` 上一格，只有画布被 resize 清空时才整层擦。`lastDrawnRows` 的旧行标记逻辑保持原样。

## 4. `*_get_multi` 为什么没用上

实测 `get_multi(3 keys)` = 23.5 ns，而 3 次 `single_get` = 24.9 ns —— 批量把 3 次边界穿越合并成 1 次只省了约 1 ns。**说明成本在 wasm 函数体内部（key 的 switch 分发 + 写回），不在 JS→wasm 的穿越本身**。按每 cell 能合并掉 4 次调用算，全屏收益约 4800 × 5 ns ≈ 24 µs/帧（占 1.28 ms 的 2%），而代价是要处理「fg/bg 缺省时整批返回 `-2`、需要按 `outWritten` 下标拆成多次重试」的分支。收益/风险不成比例，不采用；这个测量结论直接写进了下面的 ABI 建议。

## 5. 是否值得做「打包行」的 WASM ABI（Rust/Zig 侧）

**结论：现在不做。** 依据：

- **理论上限只有 2~2.5×**。当前每 cell 8.97 次 wasm 调用 × 8.3 ns ≈ 75 ns；打包行 ABI（一次调用把整行按定长 struct 写进调用方缓冲）能把它压到接近 0，同时因为「一次调用之后取一次 view 就能读完整行」可以再省掉 7.82 次/cell 的 view 重取（约 78 ns/cell）。合计约 150 ns/cell，对应 1.28 ms → 约 0.5 ms。
- **单次调用成本的构成决定了这一点**：如上一节，8.3 ns 里边界穿越只占很小一部分，批量化省不到；打包 ABI 赢在「彻底不做逐 key 分发」，而不是「少穿越」。所以别指望数量级。
- **代价是真实的**：`vendor/ghostty` 是钉死 commit 的上游 submodule，`scripts/build-wasm.sh` 会强制校验 submodule HEAD 与超项目记录一致。加 ABI 意味着长期背一个 fork patch，并在每次跟进 ghostty 时重新 rebase + 重编 wasm。
- **1.28 ms/帧在 16.7 ms 预算里已经不是瓶颈**，而且真正的大头（每帧全屏 canvas 重绘）已经被第 3 节的行级 dirty 判定拿掉了。

**什么时候该回头做**：
1. 视口显著变大（240×80 ≈ 19200 cell，按当前系数约 5 ms/帧，就该动手了）；
2. 或者——优先级更高——**上游 ghostty 补上真正的 damage / dirty 追踪**。那才是数量级的改动：现在「哪一行变了」只能靠把整屏读出来再逐 cell 比对，读取本身就是那 1.28 ms；有了 damage API 就可以整行跳过不读，空闲帧直接掉到几十微秒。如果要给上游提 PR，提 damage API 的性价比远高于提打包行 ABI；如果两者只能选一个自己 fork 实现，也应该选 damage 追踪。

## 6. 新增测试

- `src/render-state.cache.test.ts`（7 例，真 wasm）：无输入的第二帧整体复用行对象且 `dirty` 降级为 `clean`；写入只让被改的行失效、其余行 `cells` 数组保持同一实例且 `dirty='partial'`；同一 snapshotVersion 内重复迭代返回同一批行；**主题切换刷新调色板**（palette 实例换新、背景/前景/palette[1] 取到新值、当帧不降级仍为 `full`）；**resize 让整屏行缓存失效**；**滚动视口让被移动的行重新变脏**；style/颜色内插的引用相等。
- `src/canvas-renderer.layers.test.ts`（9 例）：选区层——无选区的连续帧完全不动笔、选区出现/变化/消失各触发一次重画、值相同的新数组不重画、仅颜色变化触发重画、画布被 resize 清空后必须重画；光标层——光标不动的连续帧完全不动笔、移动时只擦上一格（断言精确的 `clearRect` 矩形）、隐藏时擦掉上一格且持续隐藏不再动笔、resize 清空后整层擦并重画、仅光标颜色变化触发重画。

## 7. 注意事项 / 遗留

- `GhosttyRenderRow.dirty` 的语义变了：从「内核报的行脏位」（本构建恒为 `true`）变成「与上一帧相比内容真的变了」。比对覆盖了 canvas 实际读取的全部字段（codepoints/text、widthKind、hasText、style、fgColor、bgColor），加上「配色变化或几何变化则整屏作废」，不存在漏判。`forceFullRepaint` / canvas 位图被 resize 清空（issue #45 bug 3）两条强制全画路径未受影响。
- `GhosttyRenderCell.codepoints` 现在可能是跨 cell 共享的只读数组（空数组、单 ASCII 码点）。全仓库对它只有读（`canvas-renderer` 读 `.length` 和 `[0]`），已确认无写入方。
- `ghostty-wasm.ts` 存在与 biome 的历史格式漂移（HEAD 上 `biome check` 就报错），本次只加了 23 行、没有对该文件跑 `--write`。
- bench 不是测试，不会被 `bun test` 发现；手动跑：`bun packages/ghostty-terminal/bench/render-bridge.bench.ts`。
