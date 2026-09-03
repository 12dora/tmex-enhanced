# EX2：Claude Code 输入框文字「莫名变浅绿」排查结果

worktree `/Users/konata/code/tmex-r22`（`feat/round22-perf-tui-color-smell`，base = main @ 1.1.21）。
未改动任何 `apps/` `packages/` 生产代码；新增复现测试一个（见「复现测试」）。

## 结论先行

**找到并确定性复现了根因，是 round 21 的回归。**

`TerminalRenderCoordinator.forceFullRepaint()` 会把 `outputSinceRender` 清成 `false`。这个标记在
round 21 之前只有一个消费者（光标落定），round 21 给它加了第二个消费者——**位移感知行复用的
安全门**。于是「窗口 focus / 标签页切回 / history 注入触发 forceFullRepaint」与「同一批输出里
既追加了行（视口下移）又原位重画了输入框」撞车时：

1. `scrollDelta` 被算成非 0，`iterateRows()` 走位移复用；
2. 位移复用对每一行传 `reuseReportedDirty = true`，`readRow()` **消费掉内核的行 dirty 位之后
   直接返回上一帧的行对象，一个 cell 都不读**——这一批输出里的原位重画整批被丢弃；
3. 因为脏位已经被消费，之后的帧内核报 clean，**屏幕永久卡在上一帧的文字与颜色**，
   直到别的操作重新把这些行标脏。

对 Claude Code 这种 Ink TUI 而言，被丢掉的正是「输入框整块原位重画」，于是输入框卡在上一帧的
配色上——用户看到的就是「输入框里的字变成一种奇怪的浅绿」，而且不会自愈。

## 一、证据链

### 1.1 差分 fuzz（模型层）

脚本：`<scratchpad>/ex2/oracle.ts` + `fuzz.ts`（临时文件，未入库）。
两台同样喂字节的终端：一台走生产的跨帧复用 + 位移复用 + 「canvas 只画脏行」绘制计划
（`resolveEffectiveDirty` / `wantsScrollBlit` / `shouldDrawAllRows` / `expandNeighborRows` 都用生产函数），
并维护一个屏幕模型模拟 canvas 上真正留下的像素；另一台**每帧新建 render state 全扫**当真值。
每帧逐 cell 比对 `text | widthKind | 属性 | fg | bg`。

序列是 Ink 形态：`ESC[y;1H ESC[2K` 逐行重画一个 4 行输入框（边框 + `>` 提示 + hint），
颜色在 `默认 / 32 / 92 / 38;5;114 / 38;2;152,195,121 / 2(dim)` 之间随机切换，
穿插 `DECSET 2026` 包裹的原子帧、追加输出、±1~3 行与整屏级的滚动。

| 模式 | 语义 | 结果（30 seed × 300 步） |
|---|---|---|
| A | 只 forceFull（不清 `outputSinceRender`） | **0/30 发散** |
| B | forceFull + 清 `outputSinceRender`（**当前生产行为**） | **13/30 发散** |
| C | B + 额外置 `rowShiftInvalidated`（拟议修复） | **0/30 发散** |

模式 B 抓到的典型发散（`TEST_THEME`）：

```
{"y":11,"x":0,"screen":"╰|narrow||85,255,85|-","truth":"╭|narrow||-|-"}
{"y":13,"x":0,"screen":"╭|narrow||-|-","truth":"╭|narrow||152,195,121|-"}
{"y":12,"x":0,"screen":"╭|narrow|F|-|-","truth":"╭|narrow||152,195,121|-"}
```

`85,255,85` = `#55ff55`（bright green），`152,195,121` = `#98c379`（浅绿）。
**屏幕上留着浅绿/亮绿，真值是默认色；或反过来**——正是用户描述的形态。

另外：**不带 forceFull 时 40 seed × 400 步零发散**，说明 round 21 的位移复用、
canvas ping-pong blit、只画脏行这套绘制计划本身是自洽的，唯一的洞在那个被复用的标记上。

### 1.2 最小确定性复现（协调器层）

`packages/ghostty-terminal/src/zz-ex2-repro.test.ts`（新增，2 例）。用生产的
`TerminalRenderCoordinator`，6 行 × 32 列，最后 4 行当输入框：

```
绿色画一遍输入框 → renderNow ×2（成为 settled 基线）
writeVt("\r\n" + 用默认色原位重画 4 行输入框)   // 一批输出：既滚动又原位重画
coordinator.noteOutput()                          // 与 terminal.write() 等价
coordinator.forceFullRepaint()                    // 抢在 rAF 之前出帧
```

断言输入框 4 行前景色应全为 `default`，实测：

```
immediate: ["0,170,0", "0,170,0", "default", "default"]   // 上两行卡在绿色
later:     ["0,170,0", "0,170,0", "default", "default"]   // 再画 2 帧仍不自愈
scrollDelta: 1                                            // 位移复用被启用
```

对照用例：在 `forceFullRepaint()` 之前先调 `invalidateLines()`（即置 `rowShiftInvalidated = true`，
拟议修复的等效动作）→ **通过**。

### 1.3 修复验证

把协调器复制到 scratchpad 并打上拟议补丁（`<scratchpad>/ex2/fixed-coordinator.ts`）：

- 上面的复现用例：`2 pass / 0 fail`
- 既有 `terminal-render-coordinator.performance.test.ts`（改成 import 补丁版）：`4 pass / 0 fail`
- fuzz 模式 C：0/30 发散

（按任务要求没有改动仓库里的生产文件。）

## 二、是不是 round 21 回归

**是。**

- base `e4ae3dd2` 的 `iterateRows(resources)` 没有 `scrollDelta` 参数，`readRow()` 没有
  `reuseReportedDirty`：任何报脏的行都会被逐 cell 重读比对，不存在「消费脏位却不读 cell」的路径。
- base 的 `canvas-renderer.ts` 里 `scrollDelta / blitRows / scratchCanvas / assignedMainFillStyle`
  出现次数为 **0**。
- 引入 commit：`11a32de5 perf(terminal): canvas run 批绘 + 位移感知行复用 + 有界懒填充行模型缓存`。
- `forceFullRepaint()` 里那句 `this.outputSinceRender = false` 在 base 就有，但那时它只喂光标落定，
  无害。round 21 给同一个标记接上了第二个消费者，才把它变成漏画开关。

注意：round 21 自己的审查已经修过**同一形态**的另一个洞（`2098fb1f`：DECSET 2026 期间不排帧 ⇒
`outputSinceRender` 为 false ⇒ 位移复用吞脏行），修法是让 `terminal.write()` 无条件先
`noteOutput()`。`forceFullRepaint()` 这条同源的路径当时漏掉了。

**但要诚实说明**：用户在 round 6/7 就报过「文字莫名变绿」（见
`prompt-archives/2026083100-perf-smell-round7/sub/OL-result.md`，当时未能复现、未交付修复），
那是 1.1.x 早期、**还没有位移复用**的版本。本次找到的机制**解释不了那次报告**。
两种可能：(a) 早期那次另有真因（round 7 已排除了同字形换色、wasm 视图失效、脏位消费点、
选区层、colorCache 冲突等，剩下的怀疑方向是浏览器丢弃 canvas backing store）；
(b) 早期那次描述与本次实为不同现象。本次这条是能被确定性复现、能被测试钉死的那条。

## 三、真实触发条件（为什么是「有时候」）

`forceFullRepaint()` 的调用点（`packages/terminal-ui/src`）：

| 调用点 | 触发时机 | 是否危险 |
|---|---|---|
| `terminal-viewport-restore.ts:38` ← `useTerminalResize.ts:161-189` | **`window` focus、`document.visibilitychange` 转可见**（容器尺寸没变时走 `forceFullRepaint`，即常态） | **危险** |
| `terminal-snapshot.ts:191` `writeRestoredHistory` | legacy 历史回填后（几何未变时不会 `invalidateLines`） | **危险** |
| `terminal-snapshot.ts:133` `writeCanonicalSnapshot` | 前面有 `reset()`/`resize()` ⇒ `rowShiftInvalidated=true` | 安全 |
| `terminal-render-target.ts:72` `activateRenderTarget` | 前面先 `scrollToBottom()` 同步渲染过一帧 ⇒ `scrollDelta=0` | 安全 |
| `useTerminalBootSurface.ts:224` | 冷启动一次性 | 基本安全 |

于是最常见的现场是：**Claude Code 正在流式输出 → 你切到别的窗口/标签页几秒 → 切回来**。
切走期间 rAF 不跑，输出在内核里堆积；切回时 focus 事件同步调 `forceFullRepaint()`。
只要这段时间视口下移了 `1 ~ rows-1` 行（即输出不多不少，正好几行），位移复用就会启用，
把这批输出里所有的**原位重画**（Ink 的整框重绘）丢掉。切走太久（下移 ≥ rows 行）反而安全，
因为 `Math.abs(scrollDelta) < meta.rows` 不成立。这就是「有时候」。

## 四、拟议修复（未应用）

把 `outputSinceRender` 的两种语义拆开：**光标落定门**只在 `forceFullRepaint` 时可以解除，
**行模型门**任何时候都不能。

```diff
--- a/packages/ghostty-terminal/src/terminal-render-coordinator.ts
+++ b/packages/ghostty-terminal/src/terminal-render-coordinator.ts
@@
-  // 自上一帧渲染以来是否有应用输出写入：有则这一帧可能落在应用整屏重绘的中途，
-  // 光标状态不落笔（见 scheduleFromOutput / CanvasRendererFrame.cursorSettled）。
-  private outputSinceRender = false;
+  // 自上一帧渲染以来是否有应用输出写入。两个消费者语义不同，必须分开持有：
+  // - cursorPendingOutput：这一帧可能落在应用整屏重绘中途，光标不落笔
+  //   （见 scheduleFromOutput / CanvasRendererFrame.cursorSettled）；
+  // - rowsPendingOutput：行模型可能已被这批输出改写，位移复用不能启用。
+  // forceFullRepaint 只解除前者；解除后者会让位移复用把同一批输出里的原位重画整批
+  // 丢弃并消费掉行脏位，屏幕永久卡在上一帧（Claude Code 输入框「莫名变绿」）。
+  private cursorPendingOutput = false;
+  private rowsPendingOutput = false;
@@
   noteOutput(): void {
-    this.outputSinceRender = true;
+    this.cursorPendingOutput = true;
+    this.rowsPendingOutput = true;
   }
@@
   forceFullRepaint(): void {
     this.loop.requestFullRepaint();
     // 显式的「立刻把真实状态画出来」请求（DOM 重插入、tab 切回、history 注入）：
     // 光标也必须按当刻状态落笔，不能继续挂起。
-    this.outputSinceRender = false;
+    this.cursorPendingOutput = false;
     this.renderNow();
   }
@@
     const scrollDelta =
-      this.outputSinceRender || this.rowShiftInvalidated
+      this.rowsPendingOutput || this.rowShiftInvalidated
         ? 0
         : scrollbar.offset - this.viewportOffset;
@@
     const meta = readRenderSnapshotMeta(this.renderState);
     this.rowShiftInvalidated = false;
+    this.rowsPendingOutput = false;
@@
   private consumeCursorSettled(): boolean {
-    const fromOutput = this.outputSinceRender;
-    this.outputSinceRender = false;
+    const fromOutput = this.cursorPendingOutput;
+    this.cursorPendingOutput = false;
@@
     this.cursorSettleFrame = requestAnimationFrame(() => {
       this.cursorSettleFrame = null;
-      if (this.outputSinceRender) {
+      if (this.cursorPendingOutput) {
         return;
       }
```

一行版的等效修复（若想把改动面压到最小）：在 `forceFullRepaint()` 里加
`this.rowShiftInvalidated = true;`。语义上略勉强（此时行身份映射其实是有效的，
失效的是「无输出」这个前提），但行为等价，fuzz 模式 C 验的就是它。**推荐上面的拆分版**，
因为这已经是同一个标记第二次被当成两件事用了（第一次是 `2098fb1f` 的同步输出）。

### 建议一并加固（可选，非本 bug 必需）

`readRow()` 在 `reuseReportedDirty=true` 时**连 cell 都不读**，等于把正确性完全押在
「调用方保证这段时间没有输出」上，一旦这个前提被破坏就是永久性错画。更稳的形态是：
`reuseReportedDirty` 只用来**跳过内核脏位这一个信号**，仍然逐 cell 比对
`settled[i+d]`（round 21 的收益主要来自 WASM 桥的 24× 而不是省掉这次比对；
`readRow` 的 fast path 可以保留给 `!reportedDirty` 的情形）。这条是设计取舍，需要用户拍板。

## 五、被证伪的假设（都做了实测，不是推断）

| 假设 | 结论 | 证据 |
|---|---|---|
| H1 run 批绘的 `fillStyle`/`font` 去重缓存在 **ping-pong 换画布**后泄漏 | **证伪** | `<scratchpad>/ex2/canvas-color.ts`：真实 `CanvasRenderer` + 补了 `drawImage`/`insertBefore` 的 fake DOM，跑 **903 帧、其中 272 帧真的走了 ping-pong blit**，逐条 `fillText` 校验其 `fillStyle` 是否等于模型里该 cell 的解析色（含 inverse），**mismatch = 0**。代码上 `blitRows()` 在换 context 之后把两个 assigned 缓存都置 null，`resize()` 末尾同样置 null。 |
| H1' 背景遍/前景遍之间、脏行局部重绘之间 `fillStyle` 状态泄漏 | **证伪** | 同上；fake context 记录的是**落笔当刻的 fillStyle**，去重错误必然被抓到。 |
| H2 位移复用抄到配色已变的行（不含本文根因的那条路径） | **证伪** | fuzz 模式 A（护栏完好）40 seed × 400 步零发散，含 DECSET 2026 原子帧、贴边 clamp、整屏级跳转。 |
| H3 SGR → 颜色解析错（dim/bold/inverse/256 色/truecolor/位域读错） | **证伪** | `readStyle()` 的 8 个 flag 逐位从 WASM 结构体偏移读，`key = underline*256 + flags` 单射；`internColor` 的 `key=(r<<16)|(g<<8)|b` 单射；`createAnsi256Palette()` 的 16 + 6³ 立方 + 24 灰阶完全符合标准。fuzz 里 `38;5;114` / `38;2;152;195;121` / `2` / `1` / `7` 全部跑过，真值比对零差异。（**独立发现**：`style.faint` 被解析出来但渲染器从不使用——SGR 2 的暗色不生效。这是既有的表现缺陷，不是本 bug，也不产生绿色。） |
| H4 行缓存哈希碰撞（比对项不含颜色） | **证伪** | `isCellUnchanged()` 把 `text / codepoints.length / widthKind / hasText / style / fgColor / bgColor` 全参与比较，且 style 与颜色都是内插实例、比较退化为引用相等。 |
| H5 主题里有一个「碰巧是浅绿」的回落色 | **证伪** | `packages/theme/src/preset-palettes.ts` 里没有任何缺省/回落路径指向绿色；`colors.foreground` / `colors.background` / `colors.cursor` 都直接来自 WASM render state。屏幕上出现的绿是**上一帧应用自己画的绿**被留住了，不是我们凭空造的。 |

## 六、顺带发现（不属于本 bug，建议本轮或下轮处理）

1. **round 21 的 canvas ping-pong blit 在测试里从未被执行过。**
   `test-support/fake-dom.ts` 的 `FakeCanvasContext2D` 没有 `drawImage`、`FakeElement` 没有
   `insertBefore`，`blitRows()` 因此恒返回 `false`，所有 canvas 测试都退回「整屏重画」。
   本次是在 scratchpad 里给 fake DOM 补上这两个方法才测到它。建议把这两个方法补进
   `fake-dom.ts`，让 `canvas-renderer.scroll-runs.test.ts` 之类真正覆盖 blit 路径。
2. **`GhosttyRenderCellStyle.faint` 从内核读出来但渲染器完全忽略**（`canvas-renderer.ts` 里
   grep 不到 `faint`）。SGR 2 的暗色在 tmex 上和正常前景色一模一样。Claude Code 的
   placeholder / hint 大量用 dim，视觉上会偏亮。
3. `forceFullRepaint()` 这类「清标记 + 同步渲染」的写法本身脆弱：它是这一轮里
   **第二个**踩在 `outputSinceRender` 双语义上的洞。拆分标记之外，值得在
   `renderNow()` 里给「本帧允许走位移复用」加一条单独的、只在 rAF 正常路径上为真的前提。

## 七、复现测试

`/Users/konata/code/tmex-r22/packages/ghostty-terminal/src/zz-ex2-repro.test.ts`（新增，未提交）

- 第 1 例在当前 main 上 **fail**（就是本 bug）；
- 第 2 例（先 `invalidateLines()`）**pass**，是修复的对照。
- 全包基线：`bun test` → **279 pass / 1 fail**，唯一的 fail 就是第 1 例。

是否保留由你决定；若采用第四节的拆分修复，建议把第 1 例改成常驻回归（把
`invalidateLines()` 对照那例合并进去），文件名换成 `terminal-render-coordinator.output-guard.test.ts`
之类。

## 八、仍存在的不确定性

1. **本机没有抓到用户现场的那一帧。** 上面的复现是「用生产协调器 + 生产渲染计划 + 真 WASM
   内核」在实验室里构造出来的，机制与用户描述（浅绿、只在输入框、不自愈）完全吻合，
   但没有用户现场的 draw plan 佐证。
2. **round 6/7 那次报告解释不了**（见第二节）。如果修完之后用户仍偶尔看到，
   说明还有第二条路径，那大概率在浏览器合成层（round 7 已把包内排查到 8000 帧无可见差异）。
3. **具体那抹「浅绿」来自 Claude Code 的哪个元素**未考证——取决于当时框体处于
   plan / accept-edits / 普通哪种状态。这不影响定责：卡住的是「上一帧应用自己画的颜色」。

### 若要在生产构建里取证（万一修完仍复现）

在 `renderNow()` 里加一个 `localStorage` 开关（比如 `tmex.debug.render-audit`）：
开启后每帧额外用一个**临时 render state**（挂在同一 terminal 上不行，脏位是破坏性的——
需要用 `formatViewport` 的 palette 输出当真值，或临时在同一句柄上先全扫再复用比对），
把 `{frameNo, y, x, 复用值, 真值, scrollDelta, dirty, forceFull}` 打到 console
并保留最近 N 条。命中差异时同时 dump 该帧的 draw plan（`renderRows` 的 y 列表 +
每个 run 的 `{y, x0, len, fillStyle}`）。这是把「是不是我们漏画」一次问死的最短路径，
round 7 也提过同一条建议。
