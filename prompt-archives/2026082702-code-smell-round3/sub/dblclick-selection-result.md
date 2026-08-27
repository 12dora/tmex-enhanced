# terminal-selection-canvas:131「双击选词」全量运行失败 —— 根因与修复

## 结论

根因**不在**双击 / 指针 / 选区状态机，而在 e2e 选区探针本身：
`__tmexE2eTerminalSelectionText` 是**整页唯一的全局**，而该用例是**分屏（两个终端控制器）**，
两个控制器**每一帧**都会往这个全局写自己的选区文本。空闲 pane 的任意一帧把有选区 pane 的
探针抹成 `null`；渲染循环是按需调度的（`TerminalRenderLoop`，无常驻 rAF），点击完成后本
pane 不再有帧把值写回来，于是探针**永久停在 null**，`expect.poll` 轮询满 10s 失败。

- 写入点：`packages/ghostty-terminal/src/terminal.ts:622`（`applyRenderSnapshot` → `updateSelectionTextProbe(snapshot.selectionText)`），
  每次 `renderNow()` 无条件执行。
- 探针实现：`packages/ghostty-terminal/src/terminal.ts:744-758`（修复前无归属判定，直接覆盖全局）。
- 按需渲染：`packages/ghostty-terminal/src/terminal-render-loop.ts:9-18`（`schedule()` 才有帧）。
- 分屏事实：`apps/fe/tests/terminal-selection-canvas.spec.ts:133` 用 `createTwoPaneSession`
  （`apps/fe/tests/helpers/tmux.ts:20-34`，**同一 window 两个 pane**），页面走
  `/devices/:id` → SplitTerminalArea 挂两个 `Terminal` → 两个 `GhosttyTerminalController`。
  代码里已有同一事实的记录：`apps/fe/tests/split-selection-persistence.spec.ts:56`
  「`__tmexE2eXterm` 是全局单例，分屏时只指向最后挂载的 pane」，该 spec 因此改用
  per-pane 的 toolbar DOM 而不是这个全局探针。

## 具体事件序列（产出 null 的那次）

1. `clickVisibleText(page,'dbltoken',2)` → Playwright 依次派发（已核对
   `node_modules/.bun/playwright-core@1.58.2/.../server/input.js:184-207` 与
   `chromium/crInput.js:96-148`，5 条 CDP 消息同序发出）：
   `mouseMoved(buttons=0)` → `mousePressed(clickCount=1)` → `mouseReleased(1)` →
   `mousePressed(2)` → `mouseReleased(2)`。
2. pane0 `mousedown(detail=1)` → `beginPointerSelection` → `'character'` 模式；
   `mouseup(1)` → `finishPointerDrag` 判定 `'clear'`（原地单击）→ `clearSelectionState()`
   → 探针 = `null`。
3. pane0 `mousedown(detail=2)` → `'word'` 模式，锚点/焦点覆盖 `dbltoken`；
   `mouseup(2)` → `'keep'` → 同步 `renderNow()` → 探针 = `'dbltoken'`。
4. **对侧空闲 pane（pane1）跑出一帧**（首屏 snapshot / legacy history 恢复 /
   `SETTINGS_UPDATE` 广播触发的 `setTheme` / layout 尺寸下发 …，全量运行下这些事件被拖后）
   → `applyRenderSnapshot` → `updateSelectionTextProbe(null)` → 探针 = `null`。
5. pane0 此后空闲，不再有帧 → `readSelectionText()` 恒为 `null` → 第 163 行轮询 10s 失败。

为什么隔离必过、全量必挂：pane1 的那些「迟到帧」在隔离运行里全部落在点击之前；全量运行
（gateway 忙、DB 大、网关后台任务已启动）把它们推到两次断言之间。为什么第 158 行的 drag
断言能过：`expect.poll` 第一次读发生在 mouseup 同步 `renderNow()` 之后、pane1 下一帧之前，
赢下了同一场竞态；双击断言在两次满负载运行里都输了。

为什么不在 pre-refactor 基线里：今天的改动集中改变了空闲 pane 的出帧时机 ——
`c0ad861`（pane 输出微任务合并）、`f624408` + `9a1ffad`（history 单次写入 + 写入前按 tmux
pane 几何 resize，非焦点 pane 现在也会因此多出 reset/resize/repaint 一帧）、
`201790f`/`c78055a`/`b953213`（SETTINGS_UPDATE 解码与广播 → 每个挂载的终端 `setTheme` →
`schedule()` 一帧）。竞态本身是旧的，被这些改动推到了必现区间。

## 已排除

- **双击窗口判定**：不存在时间窗逻辑，模式只看 `event.detail`
  （`terminal-selection.ts:38-46`，`terminal.ts:715`），CDP 显式带 `clickCount`，与负载无关。
- **`dragMove` 的 `buttons===0` 新分支**（`terminal-pointer-handlers.ts:174-178`）：
  双击序列里两个 mousedown 之间没有 mousemove；即使插入一条，它走的是 `'keep'` 分支并
  同步 `renderNow()`，探针仍为 `'dbltoken'`，不产生 null。
- **`begin()` 不再 `updateAutoScroll()`**：`begin` 只在 `hitTest` 失败时返回 false，
  与本次失败无关（若 hitTest 失败，drag 断言会先挂）。
- **选区求值读到脏行 / dirty-row 缓存**：`getLineModel` 命中空模型时
  `expandWord` 仍返回非空 anchor/focus（`selection-model.ts:117-146`），
  `serializeSelectionText` 最差返回 `''` 而非 `null`
  （`selection-model.ts:255-277`）。**任何成功的 `begin()` + 任意一帧渲染都不可能得到 null**，
  这条推理把根因唯一地收敛到「最后一次写探针的人写了 null」。
- **`reset`/`resize`/history 冲掉本 pane 选区**：会得到 null，但那要求事件精确落在双击
  之后的窄窗口；而对侧 pane 的抹除不需要任何时机巧合，且已用单测复现。
- **vite HMR 整页刷新**（上一轮的猜测）：无法解释「两轮全量都挂在同一断言」，且不需要
  它就能复现。

## 修复

`packages/ghostty-terminal/src/terminal.ts`

- 新增模块级 `selectionProbeOwner`（第 53-58 行注释说明）。
- `updateSelectionTextProbe`：写非空选区者取得归属；**只有归属者、或当前无人归属时**才能把
  探针清空。`dispose()` 走 `updateSelectionTextProbe(null)`，归属者销毁时正常释放。
- 生产行为零变化：per-instance 的 `onSelectionChange` 通知路径（选区工具条依赖它）未动。

## 回归测试

`packages/ghostty-terminal/src/terminal.canvas.test.ts`
`an idle controller frame must not erase the selection probe owned by another pane`：
同一模块实例创建两个控制器 → A 建立选区（探针 = `mock-canvas-line`）→ **B 出一帧** →
断言探针仍是 A 的文本；再验证归属者自清、归属释放后 B 可接管、归属者 dispose 释放探针。

把归属判定短路成 `true` 后该测试**精确复现线上失败**：

```
2273 |     paneB.refresh();
2274 |     expect(probe()).toBe('mock-canvas-line');
error: expect(received).toBe(expected)
Expected: "mock-canvas-line"
Received: null
```

## 验证

- `packages/ghostty-terminal`：`bun test` 189 pass / 0 fail（21 文件）。
- `packages/terminal-ui`：`bun test` 307 pass / 0 fail。
- `tsc --noEmit -p packages/ghostty-terminal/tsconfig.json`：干净。
- `biome check` 改动文件：无新增问题（`terminal.canvas.test.ts:2133/2135/2138` 的
  `noNonNullAssertion` 是 `setupTerminal` 里的既有问题，未触碰）。
- e2e（仅此一次）：`TMEX_E2E_GATEWAY_PORT=9765 TMEX_E2E_FE_PORT=9985 bun run
  scripts/run-e2e.ts tests/terminal-selection-canvas.spec.ts` → **4 passed (13.4s)**。
  注意：该 spec 隔离运行本来就通过，这一次只证明修复没有破坏既有语义（包括第
  176 行用例对「切 window / 重连 / resize 后探针必须为 null」的三条断言）；根因的证据是
  上面的单测复现。

## 遗留 / 建议（不在本次范围）

- `useTerminalBootSurface.ts:96` 在每个终端 boot 时**直接**把探针写 null（绕过归属判定）。
  分屏下若某个 pane 在另一 pane 已有选区时重挂，仍会抹掉探针。当前用例不触发（boot 早于
  一切选区），但同类竞态还在。
- `__tmexE2eXterm` 同样是全局单例、分屏下指向最后挂载的 pane，`getCanvasMetrics` 又取
  `document.querySelector('.xterm canvas')`（DOM 里第一个）。两者在分屏下并非同一个 pane
  时坐标会算错。建议后续把 `terminal-selection-canvas.spec.ts` 改成
  `createSinglePaneSession`，或像 `split-selection-persistence.spec.ts` 那样按
  `[data-pane-id]` 定位。

## 工作区状态

仅改动 2 个文件，无 commit / stash / push：

- `packages/ghostty-terminal/src/terminal.ts`
- `packages/ghostty-terminal/src/terminal.canvas.test.ts`
