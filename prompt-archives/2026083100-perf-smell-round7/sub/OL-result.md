# OL：终端文字卡在旧颜色（"莫名变绿"）排查结果

## 结论先行

**没有复现出"脏位被消费但没落笔"的漏画路径。** round 6 的「行 dirty 消费即清 + 只画脏行」在
`packages/ghostty-terminal` 内部是自洽的：消费与绘制天然原子，不存在消费后早退的窗口。按要求
**没有交付任何投机性修复**，只交付了把不变量钉死的回归测试。

排查中确实抓到一个**真实的、可确定性复现的内核漏标脏**（6 步最小复现，见下），但它在 8000 帧
随机比对里只出现 1 次，且落在**视觉无感**的属性上（行尾空白 cell 的 `spacer-head` vs `narrow`，
两者都按默认背景绘制，像素完全一致）。它不足以解释用户看到的「几个字卡在绿色直到被选中」。

---

## 一、最关键的事实：内核的 state-level dirty 永远是 `full`

这一条决定了整个审计结论，先讲清楚。

查证 ghostty 内核（`vendor/ghostty` 是空 submodule，按 `ghostty-vt.meta.json` 里的
`ghosttyCommit: 43a05dc9…` 读的上游 `src/terminal/render.zig`）：

- `RenderState.update()` **只会抬高 `self.dirty`，从不降低**；把它清回 `.false` 是调用方的责任，
  要走 `ghostty_render_state_set(state, DIRTY, …)`。
- JS 侧**从来没调过**这个状态级 setter：`ghostty-wasm.ts` 的 `setRenderStateValue` 零调用点，
  `render-state.ts` 只用 `setRenderStateRowValue`（行级）。

推论：首帧之后 `readViewportMeta()` 从内核读到的 `dirty` **恒为 `'full'`**。
渲染器看到的 `'partial'` / `'clean'` **全部**来自 `iterateRows()` 结尾那段 JS 降级：

```
if (comparable && meta.dirty === 'full') {
  const changedRows = rows.reduce((n, row) => n + (row.dirty ? 1 : 0), 0);
  if (changedRows === 0) meta.dirty = 'clean';
  else if (changedRows < rows.length) meta.dirty = 'partial';
}
```

也就是说 `CanvasRenderer.render()` 里那个 `if (effectiveDirty === 'clean') return;` 的早退条件，
**等价于「本帧 rows 数组里一个脏行都没有」**——它和被绘制的 rows 同源、同一帧算出来的。
`comparable` 为 false 时（首帧 / 行列数变化 / 配色变化）不降级，`meta.dirty` 保持 `'full'`，
而此时每一行的 `previous` 都是 `null`，`changed` 必然为 true，全部行都脏 → 全画。

**所以「消费了 dirty 却早退不画」在结构上不可能发生**：唯一的早退分支要求零脏行。

---

## 二、复现手段（先复现再动手）

写了一套**逐 cell 像素预言机（oracle）**，不是靠眼睛看断言，而是重放绘制指令流反推屏幕状态：

1. 用 `FakeCanvasContext2D` 记录主画布的 `clearRect` / `fillRect` / `fillText`；
2. 把指令流回放成一张「每个 cell 现在是什么底色、什么字形、什么前景色」的网格；
3. 每帧和**真值**比对——真值来自一台喂入完全相同字节的镜像终端 + 每步全新的 render state
   （新 state 没有上一帧可比，必然逐 cell 全扫，是权威基线）。

**这套预言机是有牙的**：把 `canvas-renderer.ts` 的早退条件人为改成「每 7 帧顺手吞掉一次 partial」
后，它在 20 步左右就抓到停留在屏幕上的旧像素，并自动收敛出最小复现——抓到的形态和用户描述
一模一样（例如 `屏幕={"glyph":"h","fg":"rgb(0 170 0)"} 期望={空}`，即一个卡住的绿字）。改回来
即恢复全绿。

覆盖规模（全部无差异）：

| 层次 | 驱动内容 | 比对次数 |
| --- | --- | --- |
| 完整 controller（真 wasm + fake DOM） | 写入/换行/CUP/擦除/BSU-ESU/视口滚动/alt-screen/resize/DPR 1↔2/真实选区拖拽（含自动滚动）/主题切换/`refresh`/`forceFullRepaint`/裸 `schedule`/廉价选区层重绘/rAF 攒帧不 flush/宽字符 | 16 seed × 260 步，约 1700 次 |
| render-state 复用差分（120×40、20000 行 scrollback，跑到 wasm 内存 189→390 页） | 海量输出 + 提示符逐字打字 + 宽字符 + CJK + OSC 4 改调色板 + 随机 resize + 视口滚动 + alt-screen | 10 seed × 800 步，8000 帧逐 cell（字形/宽度/style/前景/背景）比对 |

---

## 三、唯一抓到的真实缺陷：内核漏标脏（视觉无感）

最小复现（自动 delta-debugging 收敛到 6 步，终端 120×40 起、scrollback 20000）：

```
resize(57×36) → ESC[16;88H → "宽字符 é ok" → ESC[14;34H
→ ESC[33m 长行+\r\n → ESC[0m 短行+\r\n
```

结果：视口第 15 行第 56 列（最后一列），复用路径读出 `spacer-head`，全扫基线读出 `narrow`。

**定责已经做实**：用 Proxy 截住 `getRenderStateRowValueResult(…, ROW_DATA_DIRTY, …)`，
打印内核每帧自报的行脏位：

```
[w] meta=partial 内核报第15行脏=1 …… cell56=spacer-head
[w] meta=partial 内核报第15行脏=0 …… cell56=spacer-head   ← 内容其实已变成 narrow
基准 cell56=narrow
```

最后一帧内核自报 **0（不脏）**，而该行内容确实变了。所以是**内核少标了脏**，JS 忠实地相信了它、
沿用上一帧的 cell。`readRow()` 里只有 `!reportedDirty && previous` 这一条分支会不读 cell 就复用，
其余路径（读了 cell 再逐 cell 比对）都不可能产出陈旧值。

**影响评估**：`spacer-head` 与 `narrow` 在这个 cell 上都是"无字形、无显式颜色"，
`drawRowBackground` 先把整行按默认底色铺满，`drawRowForeground` 对二者都跳过 → **落笔完全相同**。
把差异按「可见属性（字形/前景/背景/inverse/underline）」重新分类后，8000 帧里**可见差异 0 次**。

这条不能改内核（wasm 是预编译产物，`vendor/ghostty` 还是空 submodule），只能在 JS 侧兜底；
因为它没有可见后果、也不是用户报的现象，按"不上投机性修复"的要求**没有改**。建议见第六节。

---

## 四、按用户三次澄清逐条验证的假设

用户最终描述：打中文时几个新字变绿，继续打新字正常，**那几个绿字一直绿着，直到被选中才恢复**。

### 4.1 「同字形只换颜色 → 不重画」（协调者列为 must-have）——**不成立**

从内核一路验到 canvas 落笔指令，ASCII 与 CJK 双宽都正确重画：

- 绿色 `abc` → 原位 `ESC[H ESC[0m abc`：行被标脏，`fillText` 三次全部用 `rgb(238 238 238)`；
- 绿色 `你好世界` → 原位默认色重写：行被标脏，四个宽字形全部用新色重画；
- **模拟 TUI 逐字提交**（每次 `ESC[H ESC[2K` 整行重画，先绿后默认，逐字加长）：4 轮全部正确；
- 只改背景色（`ESC[42m` → `ESC[0m`，前景色不变）：同样正确重画。

原因在于 `isCellUnchanged()` 把 `style`、`fgColor`、`bgColor` 全都参与了比较（且都是内插实例，
比较退化成引用相等），内核对 SGR 重写也确实标脏。这 4 个用例已固化成回归测试。

### 4.2 「wasm 内存增长导致缓存视图失效读到脏数据」——**排除**

- `GhosttyBindings.view()` / `memoryBytes()` 缓存时都带 **buffer identity 校验**
  （`cachedViewBuffer === buffer`），`memory.grow` 换掉 ArrayBuffer 后必然重建；
- 带参数的 `view(ptr, len)`、`bytes(ptr, len)` 每次现造；`StructAllocation.view` 是 getter，
  也是现取；
- `render-state.ts` 的纪律是「先调 wasm、再取 `view()`」，没有跨 wasm 调用持有视图的地方；
- 补充：即便真持有了 detached view，规范行为是**抛 TypeError**，不会静默返回垃圾字节，
  与"颜色错一两帧后自愈"的形态对不上；
- 实测：打字场景下 wasm 内存**确实会增长**（109 → 111 → 239 页；大几何下 189 → 390 页），
  在跨越增长的 8000 帧比对中颜色读取零错误。

### 4.3 其余按任务清单逐条排除

| 路径 | 结论与依据 |
| --- | --- |
| `render-state.ts` 消费点 | `consumeReportedRowDirty()` 是唯一消费点，只被 `readRow()` 调用，只被 `iterateRows()` 调用，只被 `renderNow()` 调用；`renderNow()` 在 renderer 非空检查之后必然走到 `renderer.render()` |
| 生成器被中途丢弃 | `iterateRows()` 已作废 `previousRows` 并在未走完时不降级 dirty；下一帧全扫重建（已有测试覆盖，实测正确） |
| 同步输出（DECSET 2026）挂起 | 挂起期间 `write()` 直接 return，**根本没触发渲染，也就没消费**；ESU 那次写正常调度，150ms 兜底定时器也只是 `schedule()`。fuzz 里 BSU/ESU 随机穿插未产生任何漏画 |
| rAF 调度 / renderNow vs 计划帧 / `forceFullRepaint` | `consumeForceFull()` 在 renderer 非空检查之后才消费；`requestFullRepaint()` 取消排队帧后同步渲染。fuzz 覆盖攒帧、不 flush、`refresh`、裸 `schedule` |
| canvas 局部重绘缓存（`lastDrawnRows` / 光标行 / `cellDeviceWidth`） | `lastDrawnRows` 只用于调试；光标在独立图层且只擦上次矩形；几何变化一律经 `resize()` 检出并整块 wipe → 强制全画。像素预言机在 DPR 1↔2 抖动下无差异 |
| round 7 的廉价选区层重绘 | `scheduleSelectionRepaint()` **完全不碰 wasm**，不消费任何脏位；`renderNow()` 会取消排队中的选区帧。真实拖拽（含自动滚动）在 fuzz 中无差异 |
| 滚动时行身份漂移 | 内核用 `viewport_pin` 快照比对，**任何视口移动都判定为 redraw=true、整屏行全部标脏**（无 partial-scroll 优化）。实测视口滚动后 `meta.dirty=full` 且所有行 `dirty=true` |
| `colorCache` / `fontVariants` 键冲突 | `colorKey = (r<<16)|(g<<8)|b`，r/g/b 均来自 `getUint8`(0–255)，单射无冲突；`fontVariantIndex` 值域 0–3 对应长度 4 的数组。`setTheme()` 会清 `colorCache` |
| cell / row 对象被复用后原地改写 | 全链路只有「复用同一引用」或「新建对象」，**没有任何原地 mutation**；`graphemeScratch` 经 `slice()` 或共享只读常量物化，不存在别名 |

---

## 五、交付物

- 新增 `packages/ghostty-terminal/src/canvas-renderer.recolor.test.ts`（4 个用例，全绿）：
  把「同字形换色必须重画」这条不变量从内核脏位一路钉到 canvas 的 `fillText` 颜色，
  覆盖 ASCII、CJK 双宽、CJK 逐字提交整行重画、以及只改背景色四种形态。
- **没有修改任何生产代码**。

验证（均已实际执行）：

- `packages/ghostty-terminal`：`bun test` → **215 pass / 0 fail**（基线 211，新增 4）
- `bunx tsc --noEmit -p .` → **0 error**
- `bunx biome check`（改动文件）→ **clean**
- `packages/terminal-ui`：`bun test` → **325 pass / 0 fail**（与基线一致）
- `bun scripts/complexity/gate.ts` → 1 处 violation，位于
  `packages/panels/src/device-tree/sidebar-device-list.tsx:53`（264 行 > 261），
  **与本任务无关**（不在本任务负责范围内，是本 worktree 里并行改动的文件），本任务未碰
  `scripts/complexity/allowlist.json`

---

## 六、给下一步的建议（未实施，需拍板）

1. **现场埋点优先。** 由于本地无法复现，建议加一个可开关的诊断：在 `renderNow()` 里按低频
   （如每 N 帧）忽略脏位做一次全扫，把全扫结果与复用结果逐 cell 比对，命中差异时把
   `{step, y, x, 复用值, 基准值}` 打到 console。用户复现时一开就能立刻定责——**这是把
   "是不是我们漏画" 一次性问死的最短路径**。
2. **如果要给内核漏标脏兜底**：不必放弃 round 6 的收益，只需把陈旧窗口设上界——例如每
   K 帧（K=60，约 1 秒）强制一次 `comparable = false` 走全扫。代价是每秒一次全屏 cell 扫描，
   相对每帧扫描仍是 1/60 的开销；收益是任何内核漏标脏最多卡 1 秒而不是无限期。
   注意：用户描述的是"一直绿着直到选中"，**这条兜底并不能解释他们的现象**，所以我把它定位为
   健壮性加固而非 bug 修复。
3. **重点怀疑方向已转向本包之外。** 由于 canvas 是即时模式，"像素卡住"要么是我们没重画
   （已排除到 8000 帧无可见差异），要么是**位图/合成层层面的问题**。iOS PWA 下 WKWebView 在
   内存压力时丢弃 canvas backing store 是已知行为，而 `CanvasRenderer.resize()` 只比对自己缓存的
   几何字段、**不校验 `mainCanvas.width` 是否还等于期望值**（有意思的是 `layoutStale()` 恰恰校验了，
   只是仅供拖拽路径使用）。宿主侧 `terminal-ui` 已经在 `visibilitychange` / focus 上接了
   `forceFullRepaint()`，但只在**容器尺寸判定为"无需 resize"时**才触发全画。建议下一轮由负责
   terminal-ui/fe 的人核对这条链路，并考虑在可见性恢复时**无条件**全画一次。
4. 上面那套像素预言机 + 自动收敛最小复现的脚手架很有价值（能抓到人为注入的漏画并在 20 步内
   收敛），但它有约 300 行、单跑数秒。本次没有把它并入常驻测试；如果需要长期护栏，我可以把它
   拆成符合复杂度门禁的形式再提交。
