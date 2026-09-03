# EX1：终端渲染 / 滚动流畅度探索报告（第二十一轮）

基线：`/Users/konata/code/tmex-r21`，分支 `feat/round21-perf-idle-slim`（与 main 同）。只读探索，未改动任何源文件。

本报告的所有性能数字都是**本轮实测**，不是估算。测量脚本见第 4 节，环境：Apple Silicon macOS，Bun 1.3.14（WASM 桥）+ Headless Chromium 145 / DPR=2（canvas）。

---

## 0. 结论先行

用户说的「不流畅，特别是终端 scroll」有一个非常具体、可复现的根因链，而且**前六/七轮的性能工作没有覆盖到它**——那两轮的基准只测了「应用写入导致的脏行」场景（`bench/render-bridge.bench.ts` 的四个 scenario 全是 write 驱动），**从未测过 viewport 滚动**。

滚动一行的实际代价，实测：

| 阶段 | 实测耗时 | 说明 |
|---|---|---|
| WASM 渲染桥（`iterateRows` 全量读 cell） | **0.97 ms** | 120×40，滚一行 = 40/40 行全脏 |
| Canvas 前景遍（逐 cell `fillText`，3912 个可见 cell） | **2.7–6.2 ms** | 见 4.2 的两组数字 |
| Canvas 背景遍 | 0.59 ms | |
| 合计 | **≈ 4–8 ms / 每滚一行** | |

而这套流程是**在 wheel / touchmove 事件处理器里同步执行的**（`terminal.ts:420-427` 的 `scrollLines()` 直接调 `renderCoordinator.renderNow()`，不走 rAF）。macOS 触控板 / ProMotion 屏幕的 wheel 事件率是 60–120 Hz，iOS 的 `touchmove` 是 60–120 Hz，且两个监听器都是 `passive: false`（`terminal-pointer.ts:112`、`useMobileTouch.ts:24`）——**浏览器必须等这 4–8 ms 跑完才能合成下一帧**。120 Hz 下这就是 480–960 ms/s 的主线程占用，必然掉帧。

三个互相独立、可分批落地的修复方向（详见第 2 节 F1/F2/F3）：

1. **把滚动渲染从同步改成 rAF 合并**（S，零风险）——事件率与帧率解耦。
2. **Canvas 文本 run 批绘**（M）——实测 `fillText` 从 2.68 ms 降到 0.55 ms（4.9×）。第六轮把这一项判为 LOW 并推迟，**本轮实测证明该判断偏低**，见第 3 节。
3. **滚动感知的行复用 + canvas 纵向 blit**（M/L）——滚动帧的脏行从 40 降到 N（滚动格数），实测证明视口内容在滚动后是**精确的整行平移**（第 4.3 节的 probe），复用是安全的。

---

## 1. 管线现状（带 `file:line` 锚点）

### 1.1 路径 A：字节从网络到达 → 像素上屏

1. `packages/ws-client/src/pane-output-coalescer.ts:77` `PaneOutputCoalescer.push()`
   —— per-pane 有界窗口合并：攒够 32 KiB 立即下发，否则最多等 4 ms（`pane-output-coalescer.ts:11-13`）。**这一层是第六轮做的，已经很好，本轮无发现。**
2. → pane sink（`packages/ws-client/src/pane-sink-registry.ts`）→ `packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts`
3. → `GhosttyTerminalController.write()` — `packages/ghostty-terminal/src/terminal.ts:329`
   - `bindings.writeVt()`（`ghostty-wasm.ts:596`）用常驻 scratch + `encodeInto` 零拷贝写进 WASM 线性内存（≤256 KiB 走 scratch，更大走一次性分配）。已优化。
   - DECSET 2026（同步输出）激活期间挂起渲染，只留 fallback timer（`terminal.ts:344-353`）。
   - 否则 `renderCoordinator.scheduleFromOutput()`（`terminal.ts:355`）→ **rAF 合并**（`terminal-render-loop.ts:9-18`）。
4. rAF 回调 → `TerminalRenderCoordinator.renderNow()` — `terminal-render-coordinator.ts:233`
   - `bindings.readScrollbar()` → `updateRenderState()`（`render-state.ts:850`）
   - `Array.from(iterateRows(...))`（`render-state.ts:878`）——逐行：
     - `readRow()`（`render-state.ts:771`）先 `consumeReportedRowDirty()`（读后写回 0，`render-state.ts:301`）。**内核报 clean 且上一帧可比 → 整行沿用，一个 cell 都不读**（这是第六轮的核心优化，效果见 4.1 的 `clean frames` 0.008 ms）。
     - 内核报 dirty → `readRowCells()`（`render-state.ts:726`）**逐 cell 约 8 次 WASM 边界调用**：`nextRenderStateRowCell` / `readCellRaw` / `readGraphemeLen`(+`graphemes_buf`) / `WIDE` / `HAS_TEXT` / `readStyle` / fg color / bg color。style 与 color 走内插表（引用相等），cell 未变则复用上一帧对象。
     - `buildRowText()`（`render-state.ts:498`）逐 cell 字符串拼接出行文本。
   - `readRenderSnapshotMeta()`（`render-state.ts:865`）——必须在迭代完成之后读，因为 `iterateRows` 结尾会把内核恒报的 `dirty='full'` 按实际变化行数降级成 `partial`/`clean`（`render-state.ts:915-922`）。
   - `terminal-render-coordinator.ts:259-261` 为**每一行**建 `SelectionLineModel` 并写进 `lineCache`（`Map<绝对行号, model>`，**无上限**）。
   - `host.selectionRects()` / `host.selectionText()`（无选区时早退，`terminal-selection.ts:82`）。
   - → `CanvasRenderer.render()` — `canvas-renderer.ts:245`
     - `resize()`（`canvas-renderer.ts:330`）：几何/DPR 未变则早退；变了就重设 4 张 canvas 的位图（会清空，故返回 `wiped=true` 强制全画）。
     - `drawSelection()`（`canvas-renderer.ts:478`）：矩形集/颜色未变则整层跳过。
     - `dirty==='clean'` 且未 forceFull → 只更新光标层后返回（`canvas-renderer.ts:263`）。
     - 否则算重绘集：脏行 ±1 邻行（`canvas-renderer.ts:280-286`），**两遍**——先所有目标行 `drawRowBackground()`（`canvas-renderer.ts:509`），再所有目标行 `drawRowForeground()`（`canvas-renderer.ts:549`）。
     - `drawRowForeground` **逐 cell**：`fillStyle=`（`:564`）+ `font=`（`:579`）+ `fillText(单字符)`（`:580`）+ 装饰线。
     - 光标在独立 canvas 层（`cursor-layer.ts`），位置/形状/色未变整帧跳过；「落定」语义把输出中途帧的光标挂起（`terminal-render-coordinator.ts:299-337`）。
   - `host.onSnapshot()` → `terminal.ts:682` `applyRenderSnapshot()`：写 `TerminalBuffer`（xterm 兼容视图）+ `dom.updateScrollbar()`（`terminal-dom.ts:413`，**读 `viewport.clientHeight`**）。
   - `scheduleLinkOverlayUpdate()`（`terminal-render-coordinator.ts:294`）→ 150 ms 节流的链接下划线重扫。

### 1.2 路径 B：用户滚动 scrollback

**桌面（滚轮 / 触控板）**

1. `terminal-pointer.ts:112` `root.addEventListener('wheel', …, { passive: false })`
2. `terminal-pointer-handlers.ts:134` `createWheelListener` → 先 `showScrollbarTransient()`（**写 `thumb.style.opacity`**，`terminal-dom.ts:439-451`）→ `handleViewportGesture()`
3. `terminal.ts:512` → `consumeGestureAsPanX()`（`terminal.ts:525`）：pan 模式下 `dom.panMetrics()`（`terminal-dom.ts:220`）**每次 wheel 读 4 个布局属性**（`scrollLeft/scrollTop/scrollWidth/clientWidth/scrollHeight/clientHeight`）；非 pan 模式返回 null，无布局读。
4. → `TerminalInputBridge.handleViewportGesture()`（`terminal-input-bridge.ts:290`）
   - 鼠标上报模式 → `reportGestureAsMouse()`：**每一格滚动发一个 button 4/5 press**，逐个 `encodeMouseEvent` + `emitData`（`terminal-input-bridge.ts:327-350`）。
   - altScroll 模式 → 逐格发方向键（`terminal-input-bridge.ts:353`）。
   - 否则 `host.scrollLines(lines)`。
   - 格数换算：`consumeWheelDelta()`（`wheel-delta.ts:29`）——像素模式按 cellSize 累积，只消费整格，余量留下一次。**滚动是整行量化的，没有亚行（像素级）滚动**。
5. `terminal.ts:420` `scrollLines()` → `bindings.scrollViewportDelta()`（`ghostty-wasm.ts:674`，每次 `allocStruct`+`free`，实测 291 ns/次）→ **`renderCoordinator.renderNow()` 同步全渲染**（`terminal.ts:426`）。
6. 渲染结束后回到 `createWheelListener`，才 `event.preventDefault()`。

**移动端（触摸）**

1. `useMobileTouch.ts:24` `touchmove` `{ passive: false }`
2. `touch/gesture-machine.ts` → `touch/scroll-gesture.ts:89` `applyVerticalDelta()` → `feedViewportGesture()`（`scroll-gesture.ts:44`）
   - 亚行像素累积（`touch-geometry.ts:89`，增益 `TOUCH_SCROLL_GAIN = 1.3`），只喂整行。
   - → `terminal.handleViewportGesture({source:'touch'})` → 同上第 4–6 步。
3. **没有惯性 / 动量**：全仓 `grep -i 'momentum|inertia|fling|velocity'` 在 `terminal-ui` / `ghostty-terminal` / `apps/fe` 里**零命中**。手指离开屏幕滚动立刻停。

**选区拖拽时的滚动**：`terminal-selection.ts:16` `AUTO_SCROLL_INTERVAL_MS = 48`，`scrollViewportBy` + `context.render()` → 同步 `renderNow()`（`terminal.ts:170`）。

---

## 2. 排序发现

### F1 —— HIGH：滚轮/触摸滚动每个事件同步全渲染，不走 rAF

- **位置**：`packages/ghostty-terminal/src/terminal.ts:420-427`（`scrollLines`），同类还有 `terminal.ts:435`（`scrollToTop`）、`terminal.ts:444`（`scrollToBottom`）。触发者：`terminal-pointer-handlers.ts:134`（wheel，`passive:false`）、`terminal-ui/src/components/touch/scroll-gesture.ts:56/118`（touchmove，`passive:false`）。
- **机制**：`scrollLines()` 直接调 `renderCoordinator.renderNow()`，而 `renderNow()` 是完整的「读 WASM 全部行 → 建 40 个 LineModel → canvas 全量重画 → 写 buffer → 更新滚动条（读 `clientHeight`）→ 排链接 overlay」。输出路径有 `scheduleFromOutput()` 走 rAF 合并（`terminal-render-loop.ts:9-18`），**滚动路径被漏掉了**。一次滚动手势在一帧内可能派发 2 个以上 wheel/touchmove 事件，每个都跑一遍完整渲染，成果只有最后一次能上屏，前面的全部被覆盖——纯浪费。
- **实测代价**：滚一行 = 桥 0.97 ms + canvas 2.7–6.2 ms + 背景 0.59 ms ≈ **4–8 ms**。120 Hz 事件率 ⇒ 480–960 ms/s 主线程。且监听器非 passive，浏览器合成被阻塞在这段时间上。
- **用户可见影响**：这是「终端滚动不跟手 / 卡顿 / 掉帧」的**主因**。iOS PWA 上尤其明显（CPU 慢 3–5 倍，等于每次 touchmove 卡 20–40 ms）。
- **修复**：`scrollLines()` 改成 `renderCoordinator.schedule()`（rAF 合并）。滚动是纯视口变化、不影响输入回显延迟，与 `write()` 的 4 ms flush 语义无关，天然适合按帧节流。需要一并处理的：
  - `applyRenderSnapshot()` 里 `buffer.setViewport` 与 `dom.updateScrollbar` 也会推迟一帧——`scroll-gesture.ts:117-123` 的 `scrollLinesDirect` 用 `buffer.active.viewportY` 的前后差判断「是否真的滚动了」，改异步后这个判断会失效。建议给 `scrollLines()` 返回一个「offset 是否变化」的布尔（`readScrollbar` 前后比对，只是两次极廉价的 WASM 调用，见 `terminal.ts:165-168` 已有同样写法），把「是否 preventDefault」的判断与「是否渲染」解耦。
  - 手势结束（`touchend` / wheel 静默）时补一次 `renderNow()` 保证终态。
- **风险**：低。语义变化仅在于滚动结果晚一帧上屏（≤16.7 ms），而现状是晚 0 帧但整体掉到 20–30 fps。测试影响：`terminal-input-bridge.test.ts`、`wheel-delta.test.ts` 里对同步渲染有依赖的断言需要跟着 rAF 化。
- **大小**：S。

### F2 —— HIGH：Canvas 前景逐 cell `fillText`，未做 run 批绘 / 状态去重

- **位置**：`packages/ghostty-terminal/src/canvas-renderer.ts:549-572`（`drawRowForeground`），`:564` 每 cell 赋 `fillStyle`，`:579` 每 cell 赋 `font`，`:580` 每 cell 一次 `fillText(单字符)`。背景侧同理：`:527-539` 每个非默认底色 cell 一次 `fillRect`。
- **机制**：Canvas2D 的 `fillText` 每次调用都要走一遍「文本 → shaping → 绘制」的固定开销，单字符调用时这个固定开销占绝对主导。120×40 屏幕上约 3900 个可见 cell ⇒ 3900 次 `fillText` + 3900 次 `font=` + 3900 次 `fillStyle=`。
- **实测**（Chromium 145，DPR=2，3912 次操作）：

  | 操作 | 耗时 |
  |---|---|
  | `fillText` 逐 cell（3912 次单字符） | **2.68 ms** |
  | `fillText` 按 20 字符 run（196 次，字形总数相同） | **0.55 ms** |
  | `ctx.font =` 同值 3912 次 | 0.14 ms |
  | `ctx.font =` 三值轮换 3912 次 | 0.83 ms |
  | `ctx.fillStyle =` 同值 / 轮换 | 0.034 / 0.092 ms |

  整屏对比（模拟真实内容，含 18% 空白、6% 换色）：逐 cell **6.20 ms** vs run 批绘 + 状态去重 **1.38 ms**，**4.5×**。
- **用户可见影响**：滚动、`cat` 大文件、TUI 全屏重绘时的掉帧。是滚动帧里最大的单项开销。
- **修复**（分两步，第一步几乎零风险）：
  1. **状态去重**：`resolveFont()` / `toCss()` 的结果与「上次真正赋给 context 的值」比对，相同则不赋值。收益 ~0.14 ms/帧，改动 3 行，无行为变化。
  2. **run 批绘**：把同一行内**连续、同 fg 色、同字体变体、全 narrow、无块元素、无装饰线**的 cell 合并成一次 `fillText`。背景侧同样合并连续同底色 cell 为一次 `fillRect`。
- **风险**（这是第六轮判它 LOW 的原因，必须正面处理）：一次 `fillText` 里的字形按**字体自身的 advance** 排布，而渲染网格用的是 `deviceCellWidth = Math.round(cellWidth * dpr)`（`canvas-renderer.ts:79`），两者存在 <0.5 设备像素的残差，长 run 会累积漂移。三种可控方案：
  - （推荐）在 `resize()` 里用 `measureText('x'.repeat(k))` 量出真实 advance，算出每 cell 残差 `r`；`maxRun = clamp(floor(0.4 / |r|), 1, cols)`。`r≈0` 时 `maxRun=cols`（常见情形，因为 `cellWidth` 本来就是从字体量出来的），`r` 大时自动退化成今天的逐 cell 行为。**自调节、无回归下限**。
  - `ctx.letterSpacing`（Chromium 99+/Safari 17.4+/Firefox 126+）设成 `cellWidth - advance`，可做到精确对齐；特性检测失败时回落到上一条。
  - run 必须在 wide cell、spacer、块元素（`canvas-renderer.ts:141` `blockElementCodepoint`）、带装饰线（underline/strikethrough/overline）的 cell 处断开；装饰线仍逐 cell 画。
- **大小**：M。**必须配像素级回归测试**（仓库已有 `canvas-renderer.recolor.test.ts` / `issue45-cross-bug.test.ts` 的像素 oracle 惯例，第七轮附 3 用过 8000 帧像素比对，沿用即可）。

### F3 —— HIGH：滚动帧被当成「全屏变化」，40/40 行重读 + 重画，实际只是整行平移

- **位置**：`packages/ghostty-terminal/src/render-state.ts:878-923`（`iterateRows`，`previous` 恒取 `settled[rowIndex]`，没有位移概念）；配套 `canvas-renderer.ts:245` 无纵向 blit 能力。
- **机制**：滚动一行后，内核把视口内**每一行**都标 dirty（实测确认，见 4.3），于是 `readRow()` 对 40 行全部走 `readRowCells()` 全量读 cell；又因为 `previousRows[i]` 是**滚动前**第 i 行、和滚动后第 i 行内容不同，逐 cell 比对全部判为「变了」，`dirty` 无法降级，`meta.dirty` 保持 `'full'` → canvas 全量重画。
- **实测证据**（`probe.ts`，80×10 终端，200 行历史）：
  ```
  before offset 191  ["line-191","line-192","line-193"]  dirty=..........  meta=clean
  after  offset 190  ["line-190","line-191","line-192"]  dirty=DDDDDDDDDD  meta=full
  shift match (a[i] === c[i+1]): true
  ```
  即：**滚动后的视口内容是滚动前的精确整行平移**，位移量等于 `readScrollbar().offset` 的差值。40 行里有 39 行的内容一个字节都没变，却被完整重读、重建对象、重画。
- **代价拆解实测**（120×40，3000 行 scrollback，滚 1 行/帧 × 300 帧）：
  ```
  scrollDelta only                            0.001 ms
  + updateRenderState                         0.021 ms
  + iterateRows（读 cell + 建行对象）          0.971 ms   ← 全部在这里
  + buildLineModel ×40                        0.936 ms
  + normalizeVisibleLines                     1.036 ms
  ```
  对照 `render-bridge.bench.ts` 的 `clean frames (0/40)` = **0.008 ms**：如果 39 行能走复用路径，桥的开销是 **0.97 ms → ~0.03 ms（30×）**。
- **修复**（两半必须配套，缺一不可）：
  1. **桥侧**：`renderNow()` 已经在 `terminal-render-coordinator.ts:246` 读了 `scrollbar`，把 `offset` 的帧间差值 `d` 传给 `iterateRows`，让它用 `settled[rowIndex + d]` 当比对基线。安全前提（全部可在 coordinator 里判定）：`d !== 0`、`|d| < rows`、几何与配色未变（`iterateRows:891-895` 已有 `comparable` 判断）、**且自上一帧以来没有 `write()`**（`terminal-render-coordinator.ts:79` 的 `outputSinceRender` 正是这个信号）。不满足就走今天的全量路径。
     - 更激进的版本：满足上述前提时，对可复用的行**只消费 dirty 位、跳过 cell 读取**（每行 1 次 WASM 调用而不是 ~960 次）。dirty 位仍须消费清零，否则污染下一帧。
     - 细节：`readRow()` 的早退分支 `return previous`（`render-state.ts:779`）会带回旧的 `row.y`，位移复用时必须改成 `{...previous, y: rowIndex}`。
  2. **画面侧**：`meta.dirty` 降级成 `partial` 后，未变的行在 canvas 上的**像素位置也变了**，所以必须做纵向平移。实测（DPR=2，2160×1520 canvas）：
     - `ctx.drawImage(自身, …)` 自拷贝：**3.95 ms —— 是陷阱，比全量重画还慢**（Chromium 会强制回读）。
     - 经一张暂存 canvas 双缓冲：**0.32 ms**。
     - 平移 + 只画 1 行新曝光行：0.32 + 0.034 ≈ **0.35 ms** vs run 批绘的整屏 1.38 ms（4×），vs 今天的 6.2 ms（18×）。
     - 备选方案：把主 canvas 做成比视口高 2×overscan 行、用 CSS `transform: translateY` 滚动，overscan 耗尽才重画——效果更好但改动大（L），且要处理选区/链接/光标三层的同步平移。
- **用户可见影响**：与 F1/F2 叠加，是「滚动不流畅」的第三根支柱。单独落地 F3 收益也很大（滚动帧总成本 ≈ 7 ms → ≈ 0.4 ms）。
- **风险**：中。核心风险是「滚动的同时有输出到达」时误复用旧内容 —— 用 `outputSinceRender` 守卫可以完全排除（有输出就走全量路径，回到今天的行为）。必须补：滚动 + 输出交错、滚动到顶/底被 clamp（实际位移 ≠ 请求位移，所以要用 `readScrollbar` 前后的真实 offset 差）、软换行行、resize 期间。
- **大小**：M（桥侧）+ M（canvas 平移）。建议拆两个 commit，桥侧先落且**先不降级 dirty**（只验证行复用的正确性，用 `render-state.dirty.test.ts` 的既有夹具），确认无误后再开降级 + blit。

### F4 —— MED：`lineCache` 无上限，滚动 scrollback 会持续增长

- **位置**：`packages/ghostty-terminal/src/terminal-render-coordinator.ts:65`（`private readonly lineCache = new Map<number, SelectionLineModel>()`），填充在 `:259-261`，只在 `invalidateLines()`（`:174`，resize/reset）和 `dispose()` 时清空。
- **机制**：`renderNow()` 每帧把**当前视口每一行**的 `SelectionLineModel`（含一个长度 = cols 的 `colChars: (string|null)[]`）按绝对行号写进 Map。滚一遍 50 000 行 scrollback 就留下 50 000 个条目 × 每个 ~120 个字符串引用 ≈ 数十 MB，且永不释放。多个 pane 各自一份。
- **用户可见影响**：长会话 + 反复翻历史后内存涨、GC 停顿变长（表现为「用久了越来越卡」）。
- **修复**：改成 LRU，容量按「视口行数 × 常数」（比如 `max(2000, rows*20)`）。同时把 `:259-261` 的**急切填充**改成按需：`getLineModel()`（`:178`）本来就有「缓存未命中就从 `renderedRows` 现建」的回落路径，缓存唯一不可替代的作用是服务**跨出视口的选区文本序列化**（`terminal-selection.ts:87` `serializeSelectionText`）。因此可以只在 `selection.hasSelection() || selection.dragging` 时填充；无选区的帧（含全部滚动帧）省掉 40 次 `buildLineModel`。
- **风险**：低。要保证「开始拖选之前滚过的行」也能被序列化 —— 折中是「有选区时填充」+「LRU 保留最近 N 行」。
- **大小**：S。
- **备注**：第六轮「未做」清单里的 `scrollback 内存预算` 就是指这一类，这是其中最具体、最易落地的一处。

### F5 —— MED：滚动条更新每帧构成「写布局属性 → 读布局属性」循环（forced reflow）

- **位置**：`packages/ghostty-terminal/src/terminal-dom.ts:413-435` `updateScrollbar()` —— `:421` **读** `viewport.clientHeight`，`:432` **无条件写** `thumb.style.height`。
- **机制**：`thumb.style.height` 是**影响布局**的属性，每帧无条件赋值 ⇒ 布局树标脏；下一次 `updateScrollbar()` 开头读 `viewport.clientHeight` ⇒ 必须先跑一次同步布局才能给出答案。于是每一帧（在 F1 未修的情况下：**每一个 wheel / touchmove 事件**）都强制一次同步布局。而 `thumbHeight` 只在 `scrollbar.total` / `scrollbar.len` / `trackHeight` 变化时才真的会变——纯滚动期间它是常数，只有 `transform`（合成器属性，不触发布局）在变。另外 `showScrollbarTransient()`（`:439-451`）在 wheel 处理器最开头写 `thumb.style.opacity`，也参与污染。
  作用域是整个文档：全仓 `grep -E 'contain:|content-visibility'` **零命中**，终端根节点没有任何布局/绘制隔离。
- **修复**（都很小）：
  1. `thumb.style.height` / `opacity` 只在值真的变化时才赋（缓存上次写入值）。**这一条单独就能消除每帧的布局失效。**
  2. 缓存 `trackHeight`，只在 ResizeObserver（`useContainerResizeObserver.ts:17`）回调里刷新——轨道高度只随容器尺寸变。
  3. 给终端根（`terminal-dom.ts:36` 的 `root`）加 `contain: layout paint style`，把不可避免的 reflow 限制在终端子树内。
- **风险**：低。
- **大小**：S。

### F6 —— MED：pan 模式下每个 wheel 事件读 4 个布局属性

- **位置**：`packages/ghostty-terminal/src/terminal.ts:529`（`consumeGestureAsPanX` → `dom.panMetrics()`）→ `terminal-dom.ts:220-231`，读 `scrollLeft/scrollTop/scrollWidth/clientWidth/scrollHeight/clientHeight`。
- **机制**：follower / 移动端平移视口开启时（`setViewportPan(true)`），**每一个** wheel 事件在真正滚动之前先做一次布局读，且这次读发生在 `showScrollbarTransient()` 的样式写之后 ⇒ 又一次 forced reflow。非 pan 模式下 `panMetrics()` 返回 null（`terminal-dom.ts:222`），无此问题。
- **修复**：`overflowX/overflowY` 缓存，在 `setContentSurfaceSize()`（`terminal-dom.ts:214`，canvas 几何变化时回调）和 ResizeObserver 里失效；`scrollLeft/scrollTop` 是必须读的实时值但不触发 layout（如果没有 pending 样式写）。或者先按 `deltaX===0 && !shiftKey` 早退再读（`terminal.ts:534-537` 的 `raw===0` 判断目前在 `panMetrics()` **之后**，把它提前即可白捡一半）。
- **风险**：低。`raw===0` 提前判断是纯重排，零语义变化。
- **大小**：S。

### F7 —— MED：移动端触摸滚动无惯性；桌面滚动整行量化，无亚行平滑

- **位置**：`packages/terminal-ui/src/components/touch/scroll-gesture.ts`（无 velocity/fling 逻辑）；`packages/ghostty-terminal/src/wheel-delta.ts:42-47`（像素余量累积但只消费整格）。全仓 momentum/inertia/fling/velocity 零命中。
- **机制**：
  - 触摸：手指抬起 ⇒ 滚动立刻停。iOS 上任何原生列表都有惯性，终端没有，主观「不跟手/发涩」。
  - 滚轮：位移只能是 `cellHeight` 的整数倍（约 19–24 CSS px）。在 120 Hz 触控板上，一次缓慢滑动表现为一格一格的跳变，而不是连续位移。
- **修复**：
  - 惯性（S/M）：`touchend` 时按最后 ~100 ms 的位移算速度，用 rAF + 指数衰减（`v *= 0.95`/帧，低于阈值停）继续喂 `scrollLines`，任何新 touchstart 立刻取消。**必须先做 F1**，否则惯性期间每帧全渲染更糟。
  - 亚行平滑（M/L）：需要渲染层支持像素级 y 偏移（内容 canvas 多画一行 overscan + `transform: translateY(-frac)`）。与 F3 的「overscan + transform」备选方案是同一套基础设施，可以合并做。收益是主观流畅度的最大一块，但改动面也最大——**建议放在 F1/F2/F3 之后单独评估**。
- **风险**：惯性低；亚行平滑中高（影响选区命中测试、链接 overlay、光标层的坐标基准）。
- **大小**：惯性 S/M；亚行平滑 L。

### F8 —— LOW（原判 MED，静态复核后降级）：`backdrop-filter` 的实际影响面比预期小

**先说结论：我最初怀疑常驻 `backdrop-blur` 会造成每帧模糊重采样，静态复核后这个机制不成立，因此降级为 LOW。如实记录，避免误导实施方向。**

- **位置**：`apps/fe/src/page-wrapper.tsx:56`（`sticky top-0 … bg-background/95 backdrop-blur-sm`，设备/终端页也走这个 wrapper，`main.tsx:265/269`）；`packages/panels/src/device-console/editor-input-panel.tsx:62`；`packages/terminal-ui/src/components/SelectionToolbar.tsx:31`。
- **复核结论**：
  - `page-wrapper.tsx:56` 的 header 与页面内容是**兄弟节点**（内容在 `:75-85` 的独立 `flex-1 overflow-auto` 盒子里），终端不会滚到 header 底下 ⇒ 它的 backdrop 是静态的，不会每帧重采样。剩下的代价只是「多一个合成层 + 一个 backdrop root」，是常数级，不是每帧级。
  - `editor-input-panel.tsx:62` 的 `.editor-mode-input` 全仓**没有任何 CSS 规则**（只有这一处 className 字符串），它是普通流内块、不覆盖终端 ⇒ 同上，静态 backdrop。
  - **只有 `SelectionToolbar.tsx:31` 是真的浮在终端上方**（`absolute top-2 left-1/2 z-20 … backdrop-blur`）。选区存在期间如果终端还在输出，这一块确实会每帧重新模糊。但它是短暂的、面积很小。
- **建议**：把 `page-wrapper.tsx:56` 的 `backdrop-blur-sm` 去掉（背景已 95% 不透明，视觉贡献接近零，白省一个合成层）属于「顺手做」级别；`SelectionToolbar` 可换成不带模糊的实心背景。**不要把它当成滚动卡顿的解释**——真正的原因是 F1/F2/F3。
- **验证方式**：Chrome DevTools 的 Layers 面板 / Rendering → Layer borders，看 header 是否独立成层、以及 `SelectionToolbar` 出现时合成时间是否上升。**在拿到这个数据之前不要动它**。
- **风险**：纯视觉。**大小**：S。

### F9 —— MED：鼠标上报模式下每个 mousemove 做一次 `getBoundingClientRect`

- **位置**：`packages/ghostty-terminal/src/terminal-input-bridge.ts:244` `const rect = this.host.screenBounds();` → `terminal.ts:150` → `terminal-dom.ts:362` `this.screen?.getBoundingClientRect()`。调用者：`terminal-pointer-handlers.ts:100` 的 mousemove 监听（1003 any-event tracking 下裸悬停也上报）。
- **机制**：1003 模式（vim/tmux 开鼠标）下每次 mousemove 都要算 cell 坐标，而 `screenBounds()` 是 `getBoundingClientRect()`；且这之前刚跑过 `showScrollbarTransient()` 的样式写 ⇒ forced reflow @ 指针事件率。第七轮实测过 `encodeMouseEvent` 本身只要 218 ns 并判定「非热点」，**但没测 `getBoundingClientRect`**——后者在有布局待处理时可以是几十到几百微秒。
- **修复**：缓存 `screenBounds`，在 ResizeObserver / `setContentSurfaceSize` / scroll 容器变化时失效；或至少把 `showScrollbarTransient()` 的样式写推迟到读之后。
- **风险**：低—中（缓存失效遗漏会导致命中测试偏移；需要覆盖侧栏折叠、分屏拖动、键盘避让 transform 这几个改变位置的路径）。`use-keyboard-avoidance.ts` 用 transform 移动 `<main>`，transform 不触发 ResizeObserver，需要额外失效钩子。
- **大小**：S/M。

### F10 —— LOW/MED：链接下划线缓存键逐字符拼字符串

- **位置**：`packages/ghostty-terminal/src/terminal-links.ts:50-57`（`LinkMatchCache.detect`），`key += ch ?? ' '` 逐列拼接。
- **机制**：`renderNow()` 每帧末尾都排一次 `scheduleLinkOverlayUpdate()`（`terminal-render-coordinator.ts:294`），150 ms 节流 ⇒ 持续滚动时约 6–7 次/秒，每次为可见区的每条逻辑行拼一个约 120 字符的键（整屏 ~4800 次 `+=`），然后查 Map。
- **修复**：`models.map(m => m.colChars.join(' ')).join('')`（引擎的 join 走 rope，快得多）；更好的是滚动手势进行中直接抑制 overlay 重算，手势静默后跑一次。
- **风险**：低。
- **大小**：S。

### F11 —— LOW/MED：光标闪烁定时器不受焦点/可见性约束

- **位置**：`packages/ghostty-terminal/src/cursor-layer.ts:24`（`BLINK_INTERVAL_MS = 1000`）、`:220-227`（`startBlink`，`setInterval` 每秒切 `canvas.style.opacity`）。`terminal-dom.ts:470` 的 `setFocused()` 只管滚动条，不管光标。
- **机制**：只要内核报 `cursor.blinking` 就一直跑，**终端失焦时也跑，分屏下每个 pane 各跑一个**。每次触发一次合成器唤醒。后台标签页里浏览器把 `setInterval` 限流到 1 s —— 恰好等于本值，所以后台也照跑不误。
- **用户可见影响**：PWA 待机功耗（本轮任务 #2 的直接命中项）；以及交互上不符合终端惯例——失焦终端应该是静态/空心光标。
- **修复**：`setFocused(false)` 时 `stopBlink()` 并把光标画成静态（或空心）；`document.visibilitychange → hidden` 时也停。
- **风险**：低。需要一条「失焦→静态光标→重新聚焦恢复闪烁」的回归测试。
- **大小**：S。

### F12 —— LOW：`useHubNodes` 的 30 s 轮询没有可见性门控

- **位置**：`apps/fe/src/node/mesh-nodes.ts:843-846`（`setInterval(() => void coordinator.load(request), pollIntervalMs)`，`HUB_POLL_MS = 30_000`，`mesh-nodes.ts:506`）。
- **机制**：`startPolling()`（`mesh-nodes.ts:557`）那条主轮询回路是**有**可见性门控的（`browserVisibility()`，`mesh-nodes.ts:536`，并有「隐藏期间跳这一拍」的注释），但 `useHubNodes` 里这条裸 `setInterval` 没有。设置-节点页停留时，锁屏/切后台仍每 30 s 发一次 REST。
- **修复**：复用 `startPolling` 已有的 visibility 门控模式。
- **风险**：低。
- **大小**：S。

### F13 —— LOW：`scrollViewportDelta` 每次调用 alloc/free 一个 WASM 结构体

- **位置**：`packages/ghostty-terminal/src/ghostty-wasm.ts:674-691`（`allocStruct('GhosttyTerminalScrollViewport')` + `finally { behavior.free() }`）。
- **实测**：291 ns/次（其中 alloc+free 本身 28.9 ns）。相对滚动帧的 4–8 ms 可以忽略。
- **修复**：改用常驻 scratch（`render-state.ts` 的 `ensureScratch` 已有先例）。
- **判定**：**做 F1 之后收益趋近于零，建议不做**，列在这里只是为了排除。

### F14 —— LOW：滚动模式下的 `drawRowBackground` 冗余 `clearRect`

- **位置**：`canvas-renderer.ts:518-519`：先 `clearRect(0,y,width,h)` 再用不透明底色 `fillRect` 同一矩形。
- **实测**：整屏 40 次 clearRect ≈ 0.004 ms。**不值得改**，且 clearRect 对「位图被外部清空」的防护语义有价值（`canvas-renderer.ts:471` 的注释）。列出以排除。

---

## 3. 与第六/七轮的对账

### 已做、本轮不重复提

- 行 dirty 位「消费即清」+ 逐 cell 引用复用 + style/color 内插（第六轮）—— `render-state.ts:301/726/771`。实测印证：单脏行 0.074 ms、干净帧 0.008 ms。这是**输出路径**的核心优化，本轮所有发现都建立在它之上。
- `TERM_OUTPUT` 零拷贝解码、LF 规范化单趟、输出合并 4 ms 有界窗口（第六轮）—— `pane-output-coalescer.ts`。本轮无发现。
- 选区拖拽只重画选区层（第六轮）—— `terminal-render-coordinator.ts:132-150` `scheduleSelectionRepaint`。正确且有效。
- WASM 模式查询代际缓存、选区自动滚动空转零渲染、滚动条淡出单定时器（第七轮）—— `terminal.ts:336-340`、`terminal-dom.ts:439-468`。已验证仍在。
- `encodeMouseEvent` 模式查询（第七轮附 2 实测 218 ns，判定不修）—— **本轮不再提**。但同一路径上的 `getBoundingClientRect`（F9）第七轮没测，本轮补上。
- DPR 回落、canvas 位图被外部改写时强制全量重建（第六轮审查 / 第七轮附 3）—— `canvas-renderer.ts:469-473`。仍在，且是 F3 做 blit 时必须保留的安全网。
- 复杂度门禁 `scripts/complexity/gate.ts` + allowlist —— 本轮改 `canvas-renderer.ts` / `render-state.ts` 会撞 allowlist 锁值，需要用 `--tighten` 重新校准。

### 两轮明确「未做 / 推迟」，本轮重新评估

| 第六轮「未做」项 | 第六轮判定 | 本轮实测重估 |
|---|---|---|
| **canvas 文本 run 批绘** | LOW / 风险取舍，「Z1 确认非 HIGH」 | **判定偏低，应升为 HIGH**。第六轮的基准（`render-bridge.bench.ts`）只测 WASM 桥、**完全没测 canvas**，所以「非 HIGH」的结论没有 canvas 侧证据。本轮实测：逐 cell `fillText` 2.68 ms vs run 0.55 ms（4.9×），整屏 6.20 → 1.38 ms。风险（字形 advance 漂移）有自调节的 `maxRun` 方案可控。→ **F2** |
| **scrollback 内存预算** | LOW | 仍然成立，且找到了最具体的一处：`lineCache` 无上限 Map。→ **F4** |
| DataChannel 分片双拷贝 | LOW | 不在本次终端滚动范围内，未复查。 |
| locale 门控首屏 | LOW | 同上。 |
| 目录虚拟化 | LOW | 交由 FE 子代理复查（见第 5 节）。 |
| `hasWsSecureCandidate`/`shouldTryDc` 仍 `listPeers().find` | — | 不在终端路径，未复查。 |

| 第七轮「未做」项 | 第七轮判定 | 本轮重估 |
|---|---|---|
| `encodeMouseEvent` 每次查 ~8 个模式 | 附 2 实测后**明确判定不修**，已从待办移除 | **同意，不再提**。 |
| `link-detector.ts` 顶层 lookbehind | 附 3 已修（`buildFilePathPattern()` try/catch） | 已解决。 |
| ws-client overflow 无 toast | 附 3 已修 | 已解决。 |
| S1/S2 保留的内聚体（`ghostty-wasm.ts` 1624 行等） | 有意保留 | 本轮 F1/F2/F3 都不需要拆它们，`render-state.ts`（966 行）会因 F3 涨行，届时按 allowlist 处理。 |

**核心判断**：前两轮把终端性能工作全部押在「应用写入 → 脏行最小化」这条轴上，做得很彻底；但**滚动是另一条轴**（内核把整屏标脏、内容是平移而非改写），两轮的基准从未覆盖它，所以这条轴上的三个 HIGH（F1/F2/F3）至今原样存在。这与用户「特别是终端 scroll」的主观感受完全吻合。

---

## 4. 测量建议（含本轮已经跑通的脚本）

### 4.1 已有的基准：`packages/ghostty-terminal/bench/render-bridge.bench.ts`

`bun packages/ghostty-terminal/bench/render-bridge.bench.ts`，本机结果：

```
full update (40/40 rows rewritten)  mean=1.106ms  p95=1.384ms  dirtyRows/frame=40.0  non-full=0/120
single dirty row (1/40)            mean=0.074ms  p95=0.098ms  dirtyRows/frame=0.8   non-full=120/120
clean frames (0/40)                mean=0.008ms  p95=0.012ms  dirtyRows/frame=0.0   non-full=120/120
20% dirty rows (8/40)              mean=0.273ms  p95=0.316ms  dirtyRows/frame=8.0   non-full=120/120
wasm call cost: single_get=8.0ns  get_multi(3)=22.9ns  alloc+free=28.9ns  cached view()=13.5ns
```

**注意**：`ghostty_render_state_row_cells_get_multi` 这个导出目前**只在 bench 里被调用**，产品路径未用。实测 `get_multi(3)=22.9 ns` vs `3 × single_get = 24 ns` —— 打包 ABI 几乎没有收益，**不要按这个方向优化**。

**必须新增的 scenario**：`scroll +1 line/frame`、`scroll +3`、`scroll -1`。这是本轮暴露出的最大盲区。本轮验证用的脚本已跑通，建议直接固化进 bench：

```
scroll +1 line/frame   mean=1.121ms p95=1.412ms dirtyRows/frame=40.0 full=200/200 newLineModels/frame=40.0
scroll +3 lines/frame  mean=0.960ms p95=1.040ms dirtyRows/frame=40.0 full=200/200
scroll -1 line/frame   mean=0.986ms p95=1.074ms dirtyRows/frame=40.0 full=200/200
no scroll (idle)       mean=0.005ms p95=0.006ms dirtyRows/frame=0.0  full=0/200
scrollViewportDelta alone: 290.7ns/call
```

**F3 的验收指标**：`dirtyRows/frame` 从 40.0 降到 ≈滚动格数，`full=` 从 200/200 降到 0/200，`mean` 从 ~1.0 ms 降到 <0.1 ms。这三个数字直接写进 bench 输出，回归一眼可见。

### 4.2 canvas 侧：目前**没有任何基准**，需要新建

`packages/ghostty-terminal/bench/` 下全是 Bun 环境的 WASM 基准，canvas 只能在真实浏览器里测。建议新增 `apps/fe/tests/` 下一个 Playwright 基准（仓库已有 `@playwright/test` 1.58.2），或独立的 `bench/canvas.bench.mjs` 用 `playwright.chromium` 直接 `page.evaluate`。本轮实测（Chromium 145 headless，DPR=2，120×40 网格，3912 个可见 cell）：

```
── 整屏渲染（模拟真实内容：18% 空白、6% 换色、15% 斜/粗体）
full_naive  (逐 cell fillStyle+font+fillText)   6.196 ms
full_runs   (run 批绘 + 状态去重)               1.375 ms      ← 4.5×
one_row_runs(单行 run 批绘)                     0.034 ms
bg          (背景遍 clearRect+fillRect ×40)     0.590 ms

── 纵向平移
self_blit   (drawImage 同一张 canvas)           3.949 ms      ← 陷阱，比重画还慢
other_blit  (经暂存 canvas 双缓冲)              0.317 ms      ← 可用
clearrect_full                                  0.004 ms

── 单项隔离（各 3912 次）
fillText 逐 cell                                2.680 ms
fillText 按 20 字符 run（196 次）               0.552 ms      ← 4.9×
ctx.font =  同值                                0.140 ms
ctx.font =  三值轮换                            0.832 ms
ctx.fillStyle = 同值 / 轮换                     0.034 / 0.092 ms
```

**F2 的验收指标**：`full_naive → full_runs` 的比值；以及在真实终端上用 `CanvasRenderer.getDebugState().frameCount` + `performance.measure` 打点。
**F3 的验收指标**：滚动帧的 canvas 时间从 `full_*` 降到 `other_blit + one_row_runs ≈ 0.35 ms`。**务必用 `other_blit` 方案，不要用 `self_blit`。**

### 4.3 滚动语义 probe（证明行复用安全性）

固化成一条单元测试放进 `render-state.dirty.test.ts`：滚动 ±1 后断言 `rows[i].text === before[i∓1].text`，并断言 `readScrollbar().offset` 的差值等于位移量。这是 F3 的正确性地基。本轮 probe 输出：

```
before offset 191  ["line-191","line-192","line-193"]  rowDirty=..........  meta=clean
after  offset 190  ["line-190","line-191","line-192"]  rowDirty=DDDDDDDDDD  meta=full
shift match (a[i] === c[i+1]): true
```

### 4.4 端到端（证明用户感知，而不只是微基准）

1. **Chrome DevTools Performance，实机 + iOS 远程调试**：录制一次连续滚轮/触摸滚动，看
   - `wheel` / `touchmove` 事件处理器的 self time（F1 前应有 4–8 ms/事件的长条，F1 后应变成每帧一次 rAF）；
   - `Recalculate Style` / `Layout` 是否出现在事件处理器内部（F5/F6/F9 的 forced reflow 特征）；
   - `Composite Layers` 里 backdrop-filter 的耗时（F8）。
2. **Long Animation Frames API**（`PerformanceObserver({type:'long-animation-frame'})`）：在开发构建里挂一个观察器，把 `scripts` 里的 `sourceFunctionName` 打点，可以直接量到「滚动期间掉了多少帧」。
3. **既有诊断入口**：`packages/terminal-ui/src/components/terminal-diagnostics.tsx` 与 `apps/fe/tests` 的 `readTerminalInternals`（读 `lastViewportRows` / `lastRenderedRows` / `getDebugState().lastDrawnRows`）。`lastDrawnRows` 正是 F3 的天然断言点——滚动一行后它应该只含 1–3 个行号，而不是 0..39。
4. **待机功耗（任务 #2）**：Safari Web Inspector 的 Energy / Chrome 的 `chrome://tracing`，比较「终端聚焦」「终端失焦」「标签页隐藏」三态下的每秒唤醒次数，F11 的验收就看失焦/隐藏态是否降到 0。

---

## 5. 建议的落地顺序

| 顺序 | 项 | 大小 | 风险 | 预期收益（滚动帧总耗时） |
|---|---|---|---|---|
| 1 | **F1** 滚动走 rAF | S | 低 | 事件率 120 Hz → 帧率 60 Hz，主线程占用直接减半以上 |
| 2 | **F2** run 批绘 + 状态去重 | M | 中（有自调节兜底） | canvas 6.2 → 1.4 ms |
| 3 | **F5/F6** 布局读缓存 + `contain` | S | 低 | 消除每事件 forced reflow |
| 4 | **F4** lineCache LRU + 懒填充 | S | 低 | 内存 + 每帧 40 次 buildLineModel |
| 5 | **F11/F12** 失焦停闪 + 轮询可见性门控 | S | 低 | 待机功耗 |
| 6 | **F3** 位移感知行复用 + canvas blit | M+M | 中 | 桥 0.97 → 0.03 ms；canvas 1.4 → 0.35 ms |
| 7 | **F9** screenBounds 缓存 | S/M | 中 | 上报模式下的悬停流畅度 |
| 8 | **F10** 链接缓存键 + 滚动期抑制 | S | 低 | 边角 |
| 9 | **F7** 触摸惯性 | S/M | 低（必须在 F1 之后） | 移动端主观流畅度 |
| 顺手 | **F8** 去 backdrop-blur | S | 视觉确认 | 一个合成层，非滚动瓶颈 |
| — | **F7** 亚行像素级平滑 | L | 中高 | 主观流畅度上限，建议单独立项评估 |
| — | F13 / F14 | — | — | **判定不做**，已实测排除 |

F1 + F2 + F5 是一批低风险、可独立验证的改动，合计预期把滚动帧从 4–8 ms 压到 1.5–2 ms 且事件率减半 —— 单这一批就应该能把「滚动不流畅」变成「滚动流畅」。F3 是第二批，把余量再压一个数量级。

---

## 6. 附录 A：I/O 与 store 路径（ws-client / stores）

由并行子探索完成，前六/七/十二轮已做项已排除。**首要结论：终端字节路径上没有任何 React 参与**——`paneSinks → surfaceRef.current.write()`（`usePaneSinkRegistration.ts:88-90`）全程走 ref，没有 zustand `set`、没有 `setState`。这条路第六轮做得很扎实，本轮无 HIGH。

### W1 —— MED-HIGH：WebRTC 入站重组每字节拷两次
- `packages/shared/src/link/fragment-core.ts:115`（`chunk.subarray(8).slice()`）与 `:129-136`（`new Uint8Array(frame.bytes)` + `set`）；消费方 `packages/ws-client/src/direct/data-channel-carrier.ts:103`。
- `FRAGMENT_PAYLOAD_SIZE = 65528 - 8`（`fragment-core.ts:1-3`），终端输出帧几乎恒为**单分片**，两次拷贝纯属浪费。10 MiB 突发输出 ⇒ 20 MiB memcpy + GC 压力，且发生在「为了快才存在」的 LAN 直连路径上。
- **修复**：`total === 1` 时直接返回 `chunk.subarray(FRAGMENT_HEADER_SIZE)`。注意 `client.ts:61-66` 的 `toArrayBuffer` 会对带 offset 的 view 走 `slice()` 分支把收益吃掉，需要让 `dispatcher.handleFrame` 接受 `Uint8Array`。风险中（须确认无消费方跨同步边界持有该视图），~40 行。
- **这正是第六轮「未做」清单里的「DataChannel 分片双拷贝」**，至今未做，本轮建议做掉。

### W2 —— MED-HIGH（待机功耗）：RTC `getStats()` 每 2 s 轮询，无可见性门控
- `packages/ws-client/src/direct/direct-carrier-controller.ts:86`（`DEFAULT_STATS_INTERVAL_MS = 2000`）、`:1001-1014` `startStatsPolling`、`:1018-1038` `pollStats`、`:1055-1085` `publish`；启动于 `apps/fe/src/node/node-runtimes.ts:233`。
- 该文件 `grep -n 'visibility|hidden'` **零命中**（只在 `:1100-1113` 监听 `online` / `connection.change`）。直连活跃期间无条件每 2 s 调一次 `pc.getStats()`，`readSelectedPair`（`direct/ice-stats.ts:38-72`）每次分配 Map + 数组并遍历整份 stats report。更糟的是 `publish()` 的相等性判据里含 `rtt`（`:1073`）——它是 `currentRoundTripTime` 的实时浮点，几乎每拍都变 ⇒ 每 2 s 唤醒 `apps/fe/src/node/direct-diagnostics.ts:26` 的 `useSyncExternalStore` 订阅者重渲染。
- **这是本轮追踪到的最大单项待机开销**：30 次唤醒/分钟 + 一次完整 stats 遍历 + 一次 React 渲染，PWA 切后台也照跑。
- **修复**：按 `apps/fe/src/node/mesh-nodes.ts:537-543` 的既有模式加可见性门控（隐藏挂起、恢复时立即补一拍）；把 `rtt` 移出相等性判据或量化（如 round 到 5 ms）。风险低（纯诊断数据），~50 行。

### W3 —— MED：每个 agent 事件新建 `TextDecoder` + `JSON.parse`
- `packages/stores/src/agent-event-router.ts:404` `JSON.parse(new TextDecoder().decode(decoded.payload))`。
- 每个 `AGENT_EVENT`（含 token 速率的 `TEXT_DELTA`/`REASONING_DELTA`）新建一个 `TextDecoder`——小 payload 下构造比解码本身还贵。50–100 deltas/s 时就是 50–100 次构造/s，且与终端输出抢同一条主线程。
- **修复**：模块级 `const utf8Decoder = new TextDecoder()`（`packages/shared/src/ws-borsh/codec.ts` 已是这个写法）。**2 行，零风险。**

### W4 —— MED：每帧两次 pane key 字符串 + 空 gate 也照走
- `packages/ws-client/src/pane-sink-registry.ts:52-54` + `:177`；`packages/ws-client/src/pane-history-gate.ts:32-34` + `:79`。
- `dispatchPaneTerminalData` 拼一次 `` `${deviceId}:${paneId}` ``，紧接着 `historyGates.capture(frame)` 又拼一次**完全相同**的串，而且 `gates` 为空（绝大多数时候）也照拼照查。叠加 `codec.ts:129-136` 每帧两次 UTF-8 解码出的 `deviceId`/`paneId`。
- **修复**：`capture()` 开头 `if (this.gates.size === 0) return false;`；把已算好的 `key` 传进去。~15 行，风险低。

### W5 —— LOW-MED：每次按键 / 每次鼠标上报新建 `TextEncoder`
- `packages/ws-client/src/message-builder.ts:151`、`:167`。`buildTermInput` 既是按键路径也是鼠标上报路径 —— DECSET 1003 下每次指针移动都走它，120 Hz ⇒ 120 次构造/s，且在输入延迟关键路径上。
- **修复**：模块级 `TextEncoder`。3 行，零风险。
- 与第七轮附 2 的结论不冲突：那次测的是 `encodeMouseEvent` 的模式查询（218 ns，判定不修），这是同一路径上**另一处**分配，且修复是白捡的。

### W6 —— LOW-MED：coalescer 每 ≤4 ms 新建一个定时器
- `packages/ws-client/src/pane-output-coalescer.ts:73-74`、`:132-139`。持续 <32 KiB 输出时约 250 个 timer 对象/s，每个 node 连接一份。另外后台标签页 `setTimeout` 被钳到 ≥1000 ms，保活 pane 的未满阈值字节最长滞留 ~1 s（这是**正确**的省电取舍，但文件头注释没写，建议补上）。
- **修复**：复用单个已武装的 timer handle。~15 行，风险低。

### W7 —— LOW：`latency` 每次 PONG 都写 tmux store
- `packages/stores/src/tmux-event-router.ts:110-112`；唯一消费者是 `apps/fe/src/components/page-layouts/components/sidebar-title.tsx:79-83`。
- 每次心跳 PONG（可见 5 s / 隐藏 30 s）`ctx.setState({wsLatencyMs, wsLatencyRawMs})` ⇒ 全 app 的 tmux store 订阅者的 selector 全部重跑一遍，只为一个小组件读的值。
- **修复**：值未变时跳过 `set`（~5 行），或按第六轮「设备连接态按 `useSyncExternalStore`」的既有模式把延迟挪出 store（~40 行）。

### W8/W9/W10 —— LOW
- `pane-output-coalescer.ts:32-36` `sameEpoch` 用 `Array.prototype.every` + 闭包，改成 `for` 循环（`pane-history-gate.ts:36-42` 已有正确写法）。5 行。
- `packages/terminal-ui/src/components/terminal-snapshot.ts:73-74` 每张 history page 新建 encoder+decoder（WeakMap 记忆化，一页一次，最多 22 页）。~10 行。
- `packages/terminal-ui/src/components/TerminalSurface.ts:60-89` 用 `Uint8Array.from()`（走迭代器协议，是最慢的拷贝方式）深拷贝每份 snapshot（≤512 KiB）与 history page（≤256 KiB），`getDiagnosticState`（`:155-158`）连只读诊断也拷 epoch。改成 `new Uint8Array(x)` / `x.slice()`。~10 行。

### W11 —— VERY LOW：mesh/hub 轮询定时器隐藏时仍在空转
- `apps/fe/src/node/mesh-nodes.ts:570-580`/`:653-657`、`mesh-hubs.ts:193-205`/`:248-252`。第十二轮正确地让隐藏时**跳过工作**，但 `setInterval` 本身没清，仍每 300 s / 30 s 唤醒一次做空事。浏览器对后台 timer 有重钳制，影响可忽略，列出以求完整。
- 另确认：enrollment 轮询（`enrollment-engine.ts:420`，5 s）只在有待确认注册时武装（`:400-404`，10 分钟寿命），**不是**待机负担。
- 注意与我在 F12 提的 `useHubNodes`（`mesh-nodes.ts:843-846`，30 s）是**不同**的一处：那一处连「跳过工作」的门控都没有。

### W12 —— LOW：`paneSink` memo 身份抖动导致反复注销/重注册
- `packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts:63-107`，依赖链经 `runPostSelectResize`（`useTerminalResize.ts:117-122`）→ `reportSize`/`scheduler`。任一身份变化都重建 sink 对象 ⇒ 注销时 `outputs.flush`（`pane-sink-registry.ts:126-133`）+ 重注册时再 flush（`:100`），每次都截断当前合并窗口。无数据丢失（flush 契约被遵守），但丢批。
- **修复**：用 ref 持有回调，让 sink 对象在 `(deviceId, paneId, instance)` 生命周期内稳定。~20 行。

### 背压现状（已核实，无需改动）

**活跃渲染路径上没有任何丢弃或限流**——字节总会被写入，唯一的节流是 4 ms / 32 KiB 合并窗口，渲染由 ghostty 内部的 rAF 解耦。主线程跟不上时背压经 socket 接收缓冲 → TCP → gateway 发送缓冲传播，这正是第十七轮诊断的 `backpressure_gap → carrier failover` 回路。客户端的显式上界都是「失败即 rebase/refresh」而非静默丢数据：

| 界 | 值 | 位置 |
|---|---|---|
| 未挂载 pane 的待发输出 | 2 MiB | `pane-sink-registry.ts:49`, `:187-194` |
| 待处理 history page | 16 | `:50`, `:223-228` |
| fetch-history gate | 2 MiB / 3 s | `pane-history-gate.ts:20-21`, `:82-86` |
| legacy select 输出 gate | 4 MiB / 1000 帧 | `state-machine.ts:159-160`, `:549-564` |
| 出站 pending 队列 | 2 MiB / 2048 帧 | `pending-send-queue.ts:4-6`（第七轮做的） |
| carrier-switch 入站缓冲 | 1 MiB / 64 帧 | `carrier-switch.ts:46-47`, `:189-196` |
| DataChannel 出站 | 高水位 4 MiB / 低 1 MiB | `data-channel-carrier.ts:22-25` |
| DataChannel 入站重组 | 4 MiB pending / 1 MiB 帧 | `direct/fragmenter.ts:20-22` |
| surface history 保留 | ~1.9 MiB / 22 页 | `TerminalSurface.ts:20-21` |

心跳（`client.ts:68-73`、`:599-616`、`:650-677`；`heartbeat-controller.ts:71-84`）5 s 可见 / 30 s 隐藏、超时 10 s / 60 s，`visibilitychange` 上实时切换节奏——第十二轮已做，正确。重连是事件驱动退避而非探测（`reconnect-controller.ts:44`）。

**⇒ 待机功耗的唯一显著异常项是 W2（RTC stats 2 s 轮询）。**

---

## 7. 附录 B：FE / panels 渲染与待机

由并行子探索完成 + 我本人复核关键项。前六/七轮已做项（pane 输出绕开 store、按设备 tmux selector、agent 块/行 memo + 200 块窗口、`paneStateIndex`、`AgentTab` 窄订阅、mesh `startPolling` 可见性门控、agent store 的 `dedupedStorage()`、设置页 chunk 预热）**均已排除**。

### P1 —— HIGH：移动端 `follow` 键盘模式是一个永不停止的 rAF 循环，每帧对整个文档做「写→读」布局抖动

**我亲自复核，实际情况比子探索的描述更严重。**

- **位置**：`packages/terminal-ui/src/hooks/use-keyboard-avoidance.ts:203-213`（`startFollowLoop` → `followTick` → `compute()` → 再 `startFollowLoop`），入口 `:165-186`。驱动方 `apps/fe/src/main.tsx:208`。`follow` 是**默认模式**（`packages/stores/src/ui.ts:200` `keyboardBehaviorMode: 'follow'`）。
- **循环的进入条件不是「键盘弹起」，而是「终端聚焦且光标可见」**：`compute()` 的 follow 分支先调 `readActiveCursorRect()`（`utils/keyboard-cursor-bridge.ts:27`，聚焦终端注册的 getter，未聚焦/光标隐藏返回 null），拿到 rect 就无条件 `startFollowLoop()`。`readInset()` 在非避让容器聚焦时返回 0，但**并不会**让循环退出。⇒ **手机上只要终端聚焦，这个 60 Hz 循环就一直跑，键盘收起也跑。**
- **每帧做的事**（顺序即问题所在）：
  1. `readInset()` 读 `window.innerHeight` + `visualViewport.*`（`:125-144`）
  2. `readShortcutBarHeight()` 读 `offsetHeight`（`:120-123`）
  3. `readAppliedOffset()` 调 `window.getComputedStyle(mainEl).transform` + `new DOMMatrix(...)` 解析（`:88-96`）
  4. `alignShortcutToKeyboardTop()` 读 `stripEl.getBoundingClientRect().bottom`（`:111`）
  5. `setShortcutLift()` **写 `document.documentElement.style.setProperty('--tmex-kb-shortcut-lift', …)`**（`:100-103`）
  在 `<html>` 上写自定义属性会让**整个文档**的样式失效；下一帧的 `getComputedStyle` / `getBoundingClientRect` 就必须先跑一遍全量样式重算 + 布局。典型的 read-after-write thrash，60 次/秒。
- `commit()`（`:70-77`）对未变化的值早退，所以没有 React 重渲染——**但 DOM 读写照做**。
- **用户可见影响**：移动端/PWA 打字与滚动发涩、发烫。这与 F1（滚动同步渲染）在同一条主线程上叠加：滚动手势期间，每帧既有 4–8 ms 的终端渲染，又有这个循环的全文档重算。
- **修复**：
  1. 把 lift 变量从 `documentElement` 挪到快捷键栏元素本身（或它最近的包含块），把失效范围收紧到局部；
  2. `readAppliedOffset()` 改用「刚提交的值」而不是 `getComputedStyle` 回读（保留一次回读做初始同步即可）；
  3. strip 尺寸用 ResizeObserver 缓存，不每帧量；
  4. **加收敛退出**：连续 N 帧 offset/lift 稳定就 `stopFollowLoop()`，由 `visualViewport` 的 resize/scroll、focus 变化、光标移动事件重新武装。注释里写的「RAF 每帧调用，迭代收敛」——既然是收敛的，收敛后就该停。
  5. `setShortcutLift` 值未变时跳过 `setProperty`。
- **风险**：中（收敛行为本来就是测量驱动的，需要真机验证）。**大小**：M。

### P2 —— HIGH：侧栏拖拽改宽时，每个 pointermove 同步写 localStorage + 发布新 context + 每行重启 200 ms width 过渡

- **位置**：
  - `packages/ui/src/components/sidebar/sidebar-layout.tsx:174-178` `onPointerMove` 直接 `setWidth(...)`，**无 rAF 合并**（120 Hz 触控板 ⇒ 120 次/秒）。
  - `packages/ui/src/components/sidebar/sidebar-provider.tsx:47-52` `setWidth` 里 `viewportWidth()`（`width.ts:10`，读 `window.innerWidth`）**然后** `writeSidebarStorage(...)` → `storage.ts:12` **同步 `localStorage.setItem`**。
  - `sidebar-provider.tsx:110-138` `contextValue` 含 `width` / `isResizing` ⇒ 每次采样发布一个新 context 对象。
  - `packages/ui/src/components/sidebar/sidebar-menu.tsx:34` 每个菜单按钮带 `transition-[width,height,padding] duration-(--tmex-motion-layout)`，**没有** `isResizing` 门控（侧栏容器本身是有的，`sidebar-layout.tsx:90/:104`）⇒ 每次 pointermove 都给每一行重启一个 200 ms 的宽度过渡，全侧栏持续 layout+paint。
- **每次采样重渲染的消费者**（`useSidebar()` 的调用点，含逐行组件）：`sidebar-menu.tsx:68`（`SidebarMenuButton`，几乎每一行都用）、`packages/panels/src/files/files-node-roots.tsx:351`（**每个** `FileLeaf`，单目录最多 500）、`packages/panels/src/device-tree/window-row.tsx:16`、`device-tree-navigation.ts:247`、`apps/fe/src/components/page-layouts/components/agent-session-row.tsx:45/:115`、`apps/fe/src/page-wrapper.tsx:18`、`apps/fe/src/main.tsx:83/:206`。
- **放大器**：宽度变化每帧 resize 终端容器 → `packages/panels/src/device-console/use-viewport-claims.ts:180` 的 ResizeObserver → `measure()` → `calculateSizeFromContainer()`。
- **修复**：pointermove 走 rAF 合并；拖拽期间用 CSS 变量 / ref 驱动宽度，`pointerup` 才 `setState` + 落盘；把 `width`/`isResizing` 从 `SidebarContext` 里拆出去（独立 context 或 `useSyncExternalStore`）；`sidebar-menu.tsx:34` 的过渡加 `isResizing` 门控。
- **风险**：低—中（动了共享 UI 原语，键盘/折叠动画要保住）。**大小**：M。
- **注**：子探索复核了全部 context provider，`value` 都正确 memo 化（`global-device-provider.tsx:351`、`sidebar-agent-sessions.tsx:33-34`、`device-folder-tree.tsx:445-481`、`tool-call-card.tsx:438`），**唯一的例外就是 `SidebarProvider`**，且只因为这两个成员。

### P3 —— HIGH：editor 模式每一次按键都全量序列化并同步写整个 persisted UI store

- `packages/panels/src/device-console/use-editor-input.ts:156-168` `handleEditorChange` 每次 change 都 `setEditorDraft(draftKey, nextText)`。
- `packages/stores/src/ui.ts:259-265` `setEditorDraft` 展开 `editorDrafts` 并 `set()`。
- `packages/stores/src/ui.ts:186` 该 store 包在 `persist(...)` 里且**没有 `storage:` 覆盖**——对比 `packages/stores/src/agent.ts:166` 用了 `dedupedStorage()`。`partialize`（`ui.ts:280-298`）序列化 17 个 key，含 `editorHistory`（50 条）、全部 `editorDrafts` 和四张可见性/展开映射 ⇒ **每敲一个键一次完整 `JSON.stringify` + 同步 `localStorage.setItem`**。
- 次生：`use-editor-input.ts:67-73` 订阅 `paneEditorDraft` 又在 effect 里回灌 `setEditorText` ⇒ 每次按键两轮 `DeviceConsole` 渲染（`TerminalStage` 未 memo，`terminal-stage.tsx:513`）。再次生：`set()` 通知全 app 约 30 处 `useUIStore` 订阅者。
- **修复**：草稿持久化去抖（300 ms trailing + blur/unmount 时 flush），或把草稿放进非持久化切片；最低限度给 UI store 配上和 agent store 同款的去重存储适配器。
- **风险**：低（硬杀进程时有一个去抖窗口的草稿丢失）。**大小**：S。**性价比最高的一条。**

### P4 —— HIGH：文件树每一行都调 `useLocation()`，单目录 500 行，零虚拟化

- `packages/panels/src/files/files-node-roots.tsx:47-55` `useSelectedFilePath()` 里调 `useLocation()`，而它在**每个** `DirNode`（`:261`）和**每个** `FileLeaf`（`:352`）里被调用。React Router 每次导航都发布新的 location 对象 ⇒ **切一次 tmux pane（路由带 device/window/pane）就重渲染整棵已挂载的文件树**，`:222`/`:337` 的 `memo` 完全失效。
- 每个 `FileLeaf` 还额外调 `useSidebar()`（`:351`）、`useRuntime()`、`useNavigate()`、`useTranslation()`，并构造完整的 `ContextMenu` 子树（`:372-`）。
- `:45` `DISPLAY_CAP = 500`/目录，`showAll`（`:270`）可完全去掉上限；后端上限 2000。**全仓无任何窗口化库**（`react-window`/`react-virtual` 在 `packages/panels/package.json` 与 `apps/fe/package.json` 中均不存在）。
- **修复**：把选中态提到 context / `useSyncExternalStore`，只发布 `{rootId, path}` 并让行以相等性判断订阅；或由父列表把 `isSelected` 传下去。第一步先加 `content-visibility: auto` + `contain-intrinsic-size` 到行上（廉价、无行为变化）。真正的解是把扁平化后的树虚拟化。
- **风险**：选中态修复低；虚拟化中（根节点拖拽、`ContextMenu` portal）。**大小**：S（选中态）/ L（虚拟化）。

### P5 —— MED：设备树每次导航重渲染全部行

`packages/panels/src/device-tree/sidebar-device-list.tsx:59` → `useDeviceTreeSelection()` → `device-tree-navigation.ts:226` 的 `useLocation()`；`selectedWindowId`/`selectedPaneId` 作为 props 传给**每个** `DeviceRow`（`sidebar-device-list.tsx:218-219`），`device-row.tsx:16` 的 `memo` 永远 bail 不掉。同型问题在 `apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:230/:293/:396/:422`（单个 node section 里四次独立 `useLocation()`）。**修复**：只传 `isSelected`（设备层已这么做），让 `WindowRow`/`PaneRow` 各自按 id 从 context/外部 store 派生选中态。低风险，M。

### P6 —— MED：三处仍在订阅整张 map，且位置很高

- `packages/panels/src/device-console/page-title.tsx:22` `useTmuxStore(s => s.snapshots)` —— 顶栏标题会因**任意**设备的 `metadata-snapshot`/`metadata-patch` 重渲染（`tmux-event-router.ts:164-178` 无条件替换整张 map）。
- `packages/panels/src/files/files-node-roots.tsx:105` `useTmuxStore(s => s.deviceConnected)` —— 每次连接/断开都是新对象（`tmux-event-router.ts:120-122/:135-138`），触发 `selectVisibleFileRoots` 重跑 + `FilesNodeRoots` 与所有 `FilesNodeSection` 重渲染。
- `apps/fe/src/components/global-device-provider.tsx:135-138` —— 一个 **provider** 里四张整表订阅（`connectedDevices`/`deviceConnected`/`deviceErrors`/`deviceReconnecting`），`:139-142` 的 `useMemo` 只要任一变化就产出新 `slices` 对象，级联到 `usePendingSettlement`（`:112-131`）与 `useDeviceStatusStore`（`:243-256`）。
- **修复**：标题收窄到 `snapshots[deviceId]`；文件树按行收窄到 `deviceConnected[root.deviceId]` 或用 `useShallow`；provider 里把四张 map 放 ref、经既有的 `DeviceStatusStore` 发布。**全仓只有 3 处 `useShallow`**（都在 `use-sidebar-agent-sessions.ts:324/334`），这个工具明显被低估使用。低风险，各 S。

### P7 —— MED：agent 聊天 200 块无虚拟化、无 containment

`packages/panels/src/agent/chat-thread.tsx:22`（`WINDOW_STEP = 200`）、`:212` 渲染 `threadRows(blocks.slice(hidden))`。行已 memo（第六轮），流式期间没问题；**初次挂载 / 切会话 / 点「显示更早」**（`:171-176`，窗口无上限增长）要付 200 块的全价，其中含 markdown 渲染与 `Collapsible`。**修复**：先给每个块外壳加 `content-visibility: auto` + `contain-intrinsic-size`（廉价、无行为变化），再虚拟化。低风险，S / L。

### P8 —— MED：文件树按目录轮询 + 聚焦重取风暴

`packages/panels/src/files/use-directory-listing.ts:12` `LIST_POLL_MS = 30_000`、`:29-37` —— **每个展开的目录节点一个 `useQuery`**，各带 30 s 轮询 + `refetchOnWindowFocus: true`。展开 20 个目录 ⇒ 空闲时每 30 s 发 20 个请求，每次切回标签页 **20 个并发请求**；`files-node-roots.tsx:102` 再叠一次聚焦重取；mesh 模式还要乘以节点数。`refetchIntervalInBackground: false`（`:37`）已经把定时器门控在聚焦态，这点是对的，但**没有抖动/错峰**。**修复**：按 `nodeKey` 哈希错开间隔，或改成按 root 的单一 watch/invalidate 事件；给聚焦重取加并发上限。低风险，S。

### P9 —— MED：终端旁边的布局型过渡

`packages/panels/src/device-console/command-input-collapse.tsx:66-71` `transition-[grid-template-rows,opacity,translate]` 200 ms。`grid-template-rows` 是**布局属性**，而该元素是终端的 flex 兄弟（`device-console.tsx:151-172`）⇒ 这 200 ms 里约 12 帧每帧重排终端容器并触发它的 ResizeObserver。同类：`packages/panels/src/device-folders/folder-section.tsx:212`、`packages/ui/src/components/collapsible.tsx:20`（被 `device-row.tsx:44` 用于每个设备子树）、`packages/ui/src/components/progress.tsx:11`（`transition-[width]`）。**修复**：编辑器面板改成绝对定位覆盖层上做 `transform: scaleY` / `opacity`；或给折叠外壳加 `contain: layout` 让终端不被重排。中风险（视觉打磨是刻意的），M。

### P10 —— MED：dnd-kit 每个列表一个 `DndContext`，sensors 每次渲染重建

- `packages/panels/src/device-tree/device-tree-dnd.tsx:28-34` `useDeviceTreeSensors()` 给 `useSensor` 传的是**字面量对象** ⇒ `useSensors` 每次渲染返回新数组 ⇒ `DndContext` 每次渲染拿到新的 `sensors` prop。
- `:86-105` 每个设备列表、**每个 window 的 pane 列表**（`window-pane-list.tsx:59`）、每个文件根列表（`files-node-roots.tsx:167`）、每个 node section（`sidebar-device-list.tsx:130`）各起一个完整 `DndContext` + `SortableContext`。10 设备 × 5 window ⇒ 约 50 个并存的 `DndContext`。
- `:110-128` `useSortableRow` 每次渲染返回全新对象（含新 `style`、新 `dragHandleProps`），击穿 `DeviceRowHeader`/`DeviceTreeRowShell`/`DirectoryNodeView` 上的 `memo`。
- **修复**：sensor 选项提到模块常量；`useSortableRow` 的返回值 `useMemo` 化；考虑整个侧栏一个 `DndContext` + 多个作用域化的 `SortableContext`。中风险（拖拽语义脆弱：纵向修饰符、指针优先碰撞、嵌套列表），M。

### P11 —— MED：一个 hook 里九次 agent store 订阅，随 40 ms flush 全部重跑

`packages/panels/src/agent/use-agent-tab-state.ts:109-136` 九次 `agentStore(...)`，其中七次各自独立重算 `activeSessionIdOnNode(state, nodeId)`。flush 节奏 `packages/stores/src/agent-delta-buffer.ts:7` `DELTA_FLUSH_MS = 40` ⇒ 流式期间 25 次/秒 × 9 个 selector，还要叠上其它 agent store 订阅者（每个侧栏 pane 行的 `useSessionsForPane`、`use-pane-agent-state.ts`）。**修复**：合成一次 `useShallow` selector，`activeSessionIdOnNode` 只查一次。低风险，S。

### P12 —— MED：CSS 层面的三件事

- **全仓零 `contain:` / 零 `content-visibility`**（跨 `apps/fe/src`、`packages/panels/src`、`packages/ui/src`、`packages/theme/src` 验证），而文件树/设备树/聊天块都是深层嵌套的重复行。
- `apps/fe/src/index.css:189-194` `.kb-floating-shortcuts { will-change: transform }` **无条件**——键盘收起时图层仍被提升，占移动 GPU 显存。
- `apps/fe/src/index.css:114-117`、`:119-123` 两条**通配符 `*`** 规则设置 `scrollbar-*` / `border-color` / `outline-color` / `-webkit-user-drag`；样式重算成本随节点数线性上升，而节点数正好在 1000+ 的文件树里最大。
- **修复**：给文件树行、设备树行、聊天块加 `contain: content` + `content-visibility: auto` + `contain-intrinsic-size`；`will-change` 改成由 `data-kb-open` 属性条件触发。**注意**：containment 要加在行的**内容元素**上，不要加在 `ContextMenuTrigger` 的祖先上，否则会裁掉 popover。低—中风险，S。

### P13 —— LOW

- `packages/panels/src/device-console/terminal-stage.tsx:513` 与 `packages/terminal-ui/src/components/Terminal.tsx:19` **都没有 `memo`**。每次 `DeviceConsole` 渲染（P3 的每次按键、活跃设备的每个 `metadata-patch`，`use-console-targets.ts:34`）都重跑 `Terminal` 的六个 hook。单次便宜，但在打字关键路径上。S。
- `packages/panels/src/device-console/use-mobile-viewport.ts:15-22` `resize` 监听器每次事件读 `window.innerWidth`（侧栏拖拽、移动端地址栏收缩时连续触发）。`setIsMobile` 对相等值早退所以不重渲染，但布局读照做。对照 `packages/ui/src/hooks/use-mobile.ts:10-21` 的正确 `matchMedia` 写法。S。
- `packages/panels/src/agent/chat-thread.tsx:167-176` `handleScroll` → `isPinnedToBottom(el)` 读 `scrollHeight`/`scrollTop`/`clientHeight`（`:49-53`）。同函数内前面没有样式写，且 `setShowJumpToBottom` 对相等值早退 ⇒ 今天是良性的，但它是本次范围内唯一未合并的滚动期布局读。改 rAF 合并或底部 `IntersectionObserver` 哨兵。S。
- `apps/fe/src/components/page-layouts/components/agent-session-row.tsx:26` `motion-safe:animate-pulse` 在 agent 运行全程持续跑，让合成器不休息；`chat-thread.tsx:93-97` 三个交错 pulse 点同理。纯 opacity 动画，合成器友好，但 PWA 续航非零。若在意待机功耗，`document.hidden` 时暂停。S。
- `packages/panels/src/settings/llm-provider-models.tsx:76-110` 全量模型渲染在 `max-h-56 overflow-y-auto` 里，每次 `toggleModel`（`:26-28`）map 整个数组；`apps/fe/src/pages/settings/nodes/management/nodes-table.tsx` 每个节点一个 `<tr>` 无窗口化。**都被真实数据规模兜住了，仅记录，不建议动。**

### 已复核为干净、不要重复立项

- 所有 context provider 的 `value` 都正确 memo 化，唯一例外是 `SidebarProvider`（P2）。
- 三个目录内**没有** `useStore(s => ({...}))` 这种对象字面量 selector，也没有无 selector 的 `useStore()`。
- `applyLegacyStateSnapshotDiff` 对未触及的 window/pane 保持对象身份（`packages/shared/src/ws-borsh/legacy-snapshot-draft.ts:34-49`），所以按设备的 selector 确实能正确 bail。
- `useViewportClaims` 按 cols/rows 去重（`use-viewport-claims.ts:44-56`），侧栏拖拽不会刷爆 gateway。
- ws 心跳按可见性调速（5 s / 30 s）。
- `use-agent-tab-model.ts:23-30` 的 `blocks` 与 `confirmationByToolCallId` memo 正确。

### 三份报告的交叉确认

- **延迟写 store**：W7（I/O 视角）与 P-M5（渲染视角）是同一处 `tmux-event-router.ts:110-112`，两条独立路径各自发现 ⇒ 置信度高，建议直接做（值未变时跳过 `set`，5 行）。
- **`useHubNodes` 无可见性门控**：F12（我）与 P-L2（子探索）指向同一处 `mesh-nodes.ts:843-846`。
- **零 containment**：F5（终端根）与 P12（列表行）指向同一个系统性缺失，建议一次性引入。
- **`backdrop-blur`**：子探索按静态扫描列为 MED，我按 DOM 层级复核后**降级为 LOW**（见 F8），以我的复核为准。
