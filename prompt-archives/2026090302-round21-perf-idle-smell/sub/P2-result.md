# P2 执行结果：终端滚动的事件级开销（F1 / F5 / F6）

分支 `feat/round21-perf-idle-slim`，worktree `/Users/konata/code/tmex-r21`。对应 EX1 报告的 F1（HIGH）、F5（MED）、F6（MED）。

---

## F1 —— 滚动渲染改为 rAF 合并

`packages/ghostty-terminal/src/terminal.ts`

- `scrollLines(amount)`：`renderCoordinator.renderNow()` → `renderCoordinator.schedule()`（走既有的 `TerminalRenderLoop`，与输出路径的 `scheduleFromOutput()` 同一条 rAF 合并回路）。一帧内的 N 次 wheel / touchmove 只出一帧，且渲染不再阻塞合成。
- 签名由 `=> void` 改为 `=> boolean`，返回「视口偏移是否真的变了」：`scrollViewportDelta` 前后各读一次 `readScrollbar().offset`（实测 8–290 ns/次，相对原先 4–8 ms 的同步渲染可忽略），与 `terminal.ts:165-168` 选区自动滚动已有的写法一致。
- 偏移没变（贴顶 / 贴底 / alt-screen）时**不排帧**：以前这种空滚动也要跑一遍全渲染。
- `consumeGestureAsPanX` 的 `raw === 0` 早退挪到 `dom.panMetrics()` 之前（见 F6）。

`packages/terminal-ui/src/components/touch/scroll-gesture.ts`

- `scrollLinesDirect` 原先用 `buffer.active.viewportY` 的前后差判「是否真的滚动了」，而 `viewportY` 只在渲染落地时更新——渲染推迟一帧后这个判据会失效（表现为触摸滚动永远不 `preventDefault`）。改为优先采用 `scrollLines` 的布尔返回值；返回 `void` 的旧终端实现仍回落到 viewportY 前后差比对。
- `atTopWhilePullingDown` 相应改为「向上滚且未产生位移」，与原先「前后 viewportY 都 ≤ 0」等价。

`packages/terminal-ui/src/components/touch/types.ts`：`TerminalScroller.scrollLines` 放宽成 `(amount: number) => boolean | void`（必须容纳 `CompatibleTerminalLike` 声明的 `=> void`，否则 `Terminal.tsx` 的 instance 不可赋值；biome 的 `noConfusingVoidType` 就地 ignore 并写明理由）。

**手势终态**：`schedule()` 排的 rAF 一定会触发，最后一个 wheel / touchmove 事件自然带出终帧，不需要额外的 touchend 收尾；已用测试锁死。

### 有意未做

`scrollToTop()` / `scrollToBottom()` **保持同步 `renderNow()`**，只加了布尔返回值。理由：

1. 它们是一次性动作（快捷键、切 pane 归位、`activateRenderTarget`），没有事件率问题，改成 rAF 零收益；
2. 调用方紧接着就同步读 `buffer.active.viewportY`——`apps/fe/tests/mobile-terminal-interactions.spec.ts:362` 在同一个 `page.evaluate` 里 `term.scrollToBottom()` 后立刻读 `viewportY` 并断言 `before.viewportY === before.baseY`，推迟一帧会让这条 e2e 必然失败。

## F5 —— 消除滚动条更新的强制同步布局

`packages/ghostty-terminal/src/terminal-dom.ts`

1. **写前比对（协调者补充的首要项，已落地）**：`thumb.style.height` / `transform` / `opacity` 只在值真的变化时才赋。`height` 是影响布局的属性，原先每帧无条件重写 ⇒ 布局树每帧失效 ⇒ 下一次读 `clientHeight` 必跑同步布局。纯滚动期间 `thumbHeight` 是常数，只有合成器属性 `transform` 在变。`showScrollbarTransient()` / `armScrollbarFade()` / `setFocused(false)` 的 opacity 写也统一走同一个去重入口。
2. **轨道高度缓存**：`viewport.clientHeight` 由 `readTrackHeight()` 缓存，失效点为 `setContentSurfaceSize()`、`setViewportPan()` 与新增的 `ResizeObserver`（观察 `.xterm-viewport` 的内容盒——平移开启后滚动条出现/消失只改它、不改 root）。测到 0 不入缓存，避免首帧未布局时把 0 永久粘住（也覆盖无 `ResizeObserver` 的环境）。`dispose()` 里 disconnect。
3. **`contain: layout paint style`** 加在终端根节点（`createRootElement`）。root 本身已是 `overflow: hidden` 的绝对定位块、且已是所有绝对定位后代的包含块，因此 `paint` 隔离不改变任何可见裁剪或包含块语义；helper textarea、滚动条轨道、canvas 各层都在 root 内部，SelectionToolbar 由 React 渲染在 `.xterm` 之外、不受影响。**未降级为 `layout style`**。

## F6 —— pan 模式的布局读

`packages/ghostty-terminal/src/terminal.ts`：`raw === 0` 早退前移到 `dom.panMetrics()` 之前——纯纵向滚轮（绝大多数事件）从此一个布局属性都不读。

`packages/ghostty-terminal/src/terminal-dom.ts`：`panMetrics()` 的 `overflowX/overflowY` 走 `readPanOverflow()` 缓存（失效点同 F5）；`scrollLeft/scrollTop` 仍实时读——它们是平移每一步都在变的必要值，且不触发布局。

---

## 新增测试

- `packages/ghostty-terminal/src/terminal.scroll-raf.test.ts`（6 例）：同帧三次滚动只渲染一次（渲染计数探针挂在 mock 的 `updateRenderState` 上）且终态在下一帧落屏；手势结束后仅靠已排队的 rAF 也画出终帧、无残留帧；贴顶 / 贴底如实回报「没滚动」且不排帧；滚轮手势仍被消费（`preventDefault` 语义不变）；跳顶跳底保持同步渲染。
- `packages/ghostty-terminal/src/terminal-dom.layout-cache.test.ts`（5 例）：根节点带 `contain`；40 次滚动只写 1 次 `height`、1 次 `opacity`、40 次 `transform`，且 `clientHeight` 只读 1 次；同偏移重复更新零样式写；`ResizeObserver` 回调后轨道高度重新量；未布局（0）不入缓存。
- `packages/terminal-ui/src/components/touch/scroll-gesture.test.ts`（5 例）：`scrollLines` 报告成功即视为已消费（viewportY 未更新也算）；贴顶报告失败 ⇒ 不消费 + `atTopWhilePullingDown`；贴底不消费但不算下拉到顶；不足一行不调用；返回 `void` 的旧终端回落到 viewportY 比对。
- `packages/terminal-ui/src/components/touch/gesture-machine.test.ts`：测试替身 `scrollLines: (amount) => calls.push(...)` 改为块体（`calls.push` 返回 number，新签名下不再被 void 特例接受）。

## 验收

| 项 | 结果 |
|---|---|
| `packages/ghostty-terminal` `bun test` | 248 pass / 0 fail（基线 228 + 本任务 11 + 并行 agent 9） |
| `packages/terminal-ui` `bun test` | 363 pass / 0 fail（基线 358 + 本任务 5） |
| `packages/panels` `bun test` | 747 pass / 0 fail（同基线） |
| 两包 `bunx tsc --noEmit -p .` | 0 error |
| 改动文件 `bunx biome check` | 通过 |
| `scripts/complexity/gate.ts` | 我的文件零违规（当前失败项全部来自并行 agent 的在途改动与既有条目） |

过程中一度看到 `terminal.canvas.test.ts` 与 `render-state.scroll-shift.test.ts` 失败，均来自并行 agent 的 F3/F4 在途改动（`render-state.ts` / `terminal-render-coordinator.ts`），最终复跑已全绿；我未触碰这两个文件。

## 遗留 / 建议

- `TerminalInputBridge.handleViewportGesture` 仍在 `host.scrollLines(lines)` 之后无条件 `return true`（该文件不属本任务范围）。因此桌面滚轮在 scrollback 到边时仍会 `preventDefault`——与改动前行为一致。若希望到边后把滚轮交还给页面，改这一行即可（现在 `scrollLines` 已有布尔返回值），但那是行为变更，需要单独评估。
- F7 的触摸惯性依赖 F1 已落地，现在可以做了。
