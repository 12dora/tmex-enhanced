# 终端鼠标事件补全（Shift 豁免 / motion 去重 / 移动端触摸 / 1003 悬停 / 水平滚轮）

## Context

上一轮修复（同分支 `worktree-fix-tui-mouse-drag-bugs`，已完成未提交）解决了鼠标坐标偏一行与刷新/切窗后拖拽模式丢失。本计划补齐鼠标事件支持的剩余缺口（gap 清单 1/2/3/4/5）：

1. **Shift 豁免**：鼠标上报模式（vim/opencode）下用户完全无法本地选择复制文本；跟随 xterm 约定，Shift+左键拖拽走本地选择。
2. **motion 同 cell 去重**：目前每个 mousemove 都发一条 SGR（每条 = 一次 ws 消息 + 一次 `tmux send-keys` 子进程），真实终端只在跨 cell 时发。
3. **移动端触摸映射**：TUI 开鼠标上报时 tap 靠浏览器合成鼠标事件碰运气、拖拽被自定义滚动手势吞掉。产品决策（用户已确认）：**单指=拖拽，双指=滚轮，tap=点击**；非上报模式行为不变。
4. **1003 悬停 motion**：any-event tracking 下裸悬停不上报，opencode（实测 1003+1006）的 hover 交互收不到。
5. **水平滚轮**：`deltaX` 无人消费；编码器已支持按钮 6/7→SGR 66/67（`ghostty-wasm.ts mouseButtonCode`），只差 terminal.ts 派发。

原清单项目 8（分屏边框拖拽 resize）**已存在**（`SplitTerminalArea.tsx` `split-gutter` + `handleGutterPointerDown` → `KIND_TMUX_RESIZE_PANE` → `resize-pane -x/-y`），是 gap 分析时看漏，本计划不含。

改动集中在 `packages/ghostty-terminal/src/terminal.ts`（A-D + 触摸 API）与 `apps/fe/src/components/terminal/useMobileTouch.ts`（E）。dev 实例已在 19663/19883 运行。

## 关键现状（已确认）

- 上报判定：`getInputRoutingState().mouseReporting`（private，DECSET 9/1000/1002/1003 任一开，`terminal.ts:1287`）。
- 唯一上报入口 `emitMouseInput`（`terminal.ts:1383`）→ `encodeMouseEvent`（`ghostty-wasm.ts:1146`）。
- mousedown 在 selectSurface（`:907`）、拖拽 move/up 在 window（`:1008/:1025`）；悬停 mousemove（`:961`）在上报时直接 return；滚轮 `handleViewportGesture`（`:709`）只吃 deltaY，上报分支逐行发按钮 4/5。
- 触摸：`useMobileTouch.ts` 单指滚动 + 500ms 长按 word 选择 + 右缘 36px 滚动条热区 bypass；touchstart/end passive:true、touchmove passive:false；tap 不 preventDefault → 浏览器在 touchend 后合成 mousedown/mouseup/click（click→focus 唤起软键盘）。
- `pressedMouseButtons` 被 `clearSelectionState`（`:1749`）无差别清空——触摸不得复用该状态。
- alt-screen 退出时 `write()` 调 `clearMouseTrackingModes`（`:556`）——拖拽可能中途失效，`emitMouseInput` 返回 false 是唯一中止信号。

## 实施内容

### A. Shift 豁免本地选择（`terminal.ts`）

- mousedown（`:917`）：`mouseReporting && event.shiftKey && event.button === 0` → 不上报，落入既有本地选择分支，置成员 `mouseReportBypassed = true`。
- window move/up listener 判定改为 `mouseReporting && !this.mouseReportBypassed`（整次拖拽会话稳定走选择）；up 时复位。
- Shift+中/右键、Shift+滚轮不豁免（修饰位照常编码，与 xterm 默认一致）。

### B. motion 同 cell 去重（`terminal.ts` `emitMouseInput`）

- 新成员 `lastMotionCell: {col,row} | null`；用与编码器一致的 float cell 换算（`floor(x/cellW)`、`floor(y/cellH)`）：
  - motion 且 1016 未开启 且同 cell → return false（不编码不发）；
  - press 记录当前 cell（press 后同 cell motion 不发，xterm 语义）；release 清 null。
- `clearMouseTrackingModes`、`restoreModeSnapshot`、`reset` 时清 null。

### C. 1003 悬停 motion（`terminal.ts` `:961-974`）

- 悬停 mousemove：上报模式下若 `isModeEnabled(1003)` → `emitMouseInput({action:'motion', button:null, anyButtonPressed:false})`（SGR code 35），受 B 去重约束；否则维持现状。编码器已放行（`ghostty-wasm.ts:1162`），无需改。

### D. 水平滚轮（`terminal.ts`）

- `GhosttyViewportGesture` 增加 `deltaX?: number`；wheel 监听传入。
- `handleViewportGesture` 上报分支：deltaX 独立累积器（与 deltaY 的 `wheelPixelDelta` 同构，按 cellWidth 折算列步进），每列一个 press：deltaX<0 → 按钮 6（SGR 66 左），>0 → 按钮 7（SGR 67 右）。入口守卫从 `deltaY===0 即 return` 调整为 X/Y 皆零才 return。
- 非上报模式 deltaX 不消费（现状不变）。

### E. 移动端触摸映射（`useMobileTouch.ts` + `terminal.ts` 新 API）

**terminal.ts 新增公开 API**（补进 `types.ts` 与 `TerminalScroller` 鸭子类型；`Terminal.tsx` 的 adapter 直通 instance 无需改）：

```ts
isMouseReporting(): boolean
// = !disposed && !disableStdin && getInputRoutingState().mouseReporting

sendTouchMouseEvent({action:'press'|'motion'|'release', clientX, clientY}): boolean
// button=左键、mods=0；anyButtonPressed: press/motion=true、release=false；
// press 时对齐桌面副作用（clearSelectionState + showScrollbarTransient）；
// 不写 pressedMouseButtons/mouseDragActive（被 clearSelectionState 共享清空，
// 触摸按钮状态由 hook 状态机独占）；返回 false = 模式已关/编码失败 → hook 中止手势

noteTouchHandled(): void
// touchend 时刻起 ~500ms 合成鼠标抑制窗；mousedown/mouseup 监听器入口检查后 return；
// 不检查 isTrusted（保证 e2e 可用合成 MouseEvent 验证）；click 不抑制（只做 focus，无害）
```

**useMobileTouch 状态机**（reporting 与否在 touchstart 一次性快照；`DRAG_START_THRESHOLD_PX === LONG_PRESS_MOVE_TOLERANCE_PX = 12` 单一常量，消除长按/拖拽竞态）：

- `IDLE → touchstart(单指)`：命中滚动条元素 → BYPASS；reporting → PENDING（记起点、武装长按定时器）；否则 SCROLL（现状）。
- `PENDING → 越阈 move` → DRAG_REPORT：清定时器，**以起点坐标发 press** + 当前坐标 motion，touchmove preventDefault；bypass 判定冻结（防拖入右缘热区吞 motion 卡键）。
- `PENDING → touchend`（tap）→ **press+release 都用起点坐标**（防 wobble 跨 cell）+ `terminal.focus()`（touchend 是合法 user activation，软键盘正常唤起）+ `noteTouchHandled()` + **touchend preventDefault**（规范保证抑制 compat mouse 序列，为此 touchend 监听改 `passive:false`；时间窗做兜底——iPadOS 外接鼠标误伤窗收在 500ms 内可接受）。
- `PENDING → 500ms 长按` → SELECT：现有本地 word 选择路径（移动端的"Shift 豁免"对应物）。SELECT 结束的 touchend 也要 preventDefault + noteTouchHandled——**顺带修一个现存 bug**：长按选择后合成 mousedown 会命中 reporting 分支清掉选择并发杂散 press。
- `PENDING → 第二指` → WHEEL：双指**质心**跟踪（触点数变化只重锚不产生 delta），delta 喂现有整行量化逻辑 → `handleViewportGesture`（上报分支已发 wheel 64/65，零改动）；拖拽中加入的第二指忽略。
- `DRAG_REPORT → touchend` → release（当前坐标）+ noteTouchHandled + preventDefault；`→ touchcancel` → **必须发 release**（最后 motion 坐标，防 TUI 卡左键）；`→ emit 返回 false` → 静默回 IDLE（alt-screen 退出中途关模式）。
- 非 reporting（SCROLL/SELECT/BYPASS）：行为与现状完全一致；reporting 下滚动条 bypass 收窄为"直接命中滚动条元素"（36px 热区在 TUI 下是死区）。
- 不做拖拽边缘 autoScroll（桌面上报路径也没有；坐标已被钳制到边缘，TUI 自己滚）。

### F. 测试与验证

- **ghostty-terminal 单测**（复用 FakeDom/FakeBindings 基建，`terminal.canvas.test.ts`）：
  - Shift+左键 mousedown（1000 开）不产生 mouse 事件、走本地选择；无 Shift 照常上报；
  - 同 cell 两次 motion 只 1 次 encode 调用、跨 cell 恢复、1016 开启不去重、release 后重置；
  - 1003 悬停 mousemove 产生 button-less motion，1002 下不产生；
  - wheel deltaX（上报模式）产生按钮 6/7 调用，非上报不产生；
  - sendTouchMouseEvent 三态 + 返回 false 语义 + noteTouchHandled 抑制合成 mousedown/mouseup（合成 MouseEvent 验证）。
- **fe e2e**：
  - 桌面：python TUI（`--alt`，1000+1002+1006）Shift+拖拽 → 本地选区出现（`__tmexE2eTerminalSelectionText`）且 TUI 日志无 SGR；给 `issue45-mouse-tui.py` 加 `--all`（开 1003）验证悬停 motion 到达。
  - 移动端：扩展 `mobile-terminal-interactions.spec.ts`（hasTouch 上下文、合成 TouchEvent 不产生 compat mouse，天然无 ghost click）——tap → TUI 日志 press+release 同 cell；单指拖 → `\x1b[<32;` ≥1 条（去重使条数不稳定，不断言精确值）；新增 `multiTouchSwipe` 辅助（双 Touch 同向移动）→ wheel 64/65；非 reporting 的滚动/长按选择既有用例不回归。
- **回归**：ghostty-terminal / fe src / gateway 单测分包全绿；e2e 子集（mouse 系列、mobile 系列、split 系列、render-regressions）全绿；`tsc --noEmit` 与 biome 不新增错误。
- **真实验收**：dev 实例 + opencode——桌面 Shift 选择复制、1003 悬停、拖拽、水平滚轮；Playwright 移动上下文验证触摸三手势。

## 交付物与流程

- 按仓库规则归档 plan/prompt/result 到 `prompt-archives/2026070502-tui-mouse-drag-bugs/`（plan-01 系列，与上一轮修复同分支连续交付）。
- 不含：侧键 8-11、1016 像素模式、tmux copy-mode/右键菜单、分屏 gutter（已存在）。
- 测试一律独立 tmux socket（tmex-e2e）与独立 session，严禁触碰生产 `tmex` session / 9883 服务。
