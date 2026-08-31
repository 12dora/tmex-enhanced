# O3 结果：单屏 pane 切换「保活 + warm select」

worktree：`/Users/konata/code/tmex-enhanced-wt-r9`（`feat/round9-relay-files-perf`）。未提交（commander 提交）。

## 设计

### 1. 保活池（A）

新增 `packages/panels/src/device-console/terminal-keep-alive.ts`：纯 reducer + 进程内单例。

- 池模型极简：`{ deviceId, panes[], limit, visiblePaneId, visibleIsWarm }`，`panes` 按**最近可见优先**排序，长度上限 `KEEP_ALIVE_LIMIT = 3`。
- `retainKeepAlivePane(pool, deviceId, paneId)`：目标已是可见 pane 时**原样返回**（幂等），因此可以安全地在 render 期间调用，不受 StrictMode 双渲染影响（fe 确实开了 StrictMode）。`visibleIsWarm` = 这次切换**之前**目标是否已在池中——这正是 warm 判定。
- `deviceId` 变化整池重建；`dropHiddenKeepAlivePanes` 只留可见实例（断线时用）；`releaseKeepAlive()` 在保活分支卸载时清空。
- **渲染顺序 = MRU**，即可见实例恒为第一个 DOM 节点。这是为了让 `document.querySelector('.xterm canvas')` 之类按文档序取终端的探针（`apps/fe/tests/terminal-viewport-render.spec.ts` 就是这么写的）仍然拿到可见实例。代价是切换时 React 会重排 2–3 个 DOM 节点——canvas 位图不随 DOM 移动丢失，尺寸不变也不会触发 ResizeObserver。

`terminal-stage.tsx` 单屏分支重写为 `KeepAliveTerminalStack`：

```
<div flex-col data-virtual-keyboard-avoid>
  <div ref={terminalContainerRef} class="relative min-h-0 flex-1">
    {panes.map(pid => <div class="absolute inset-0 flex" data-testid="terminal-keep-alive-pane"
                          data-pane-id data-visible aria-hidden style={visible?undefined:{visibility:'hidden',pointerEvents:'none'}}>
                        <Terminal .../></div>)}
  </div>
  {shortcutsSlot}
</div>
```

- 用 `visibility:hidden` + `absolute inset-0`（**不是** `display:none`）：隐藏实例保留布局盒，`getBoundingClientRect` / ResizeObserver 与可见实例完全一致，cols/rows 不会漂移。
- 快捷键栏从 `Terminal` 的 `children` 提到栈外（与分屏分支同构）。原因：它占据终端下方空间，如果只给可见实例，隐藏实例的测量盒会更高、行数不一致。提到外面后只渲染一份。
- 分屏分支完全未动，且分屏时不渲染保活栈（`SplitTerminalArea` 自己管全部 pane）。
- `deviceConnected === false` 时 render 期先 `dropHiddenPanes()`：断线期间隐藏实例的 live 流已断，留着切回去会看到旧内容；可见实例照旧保持挂载（原「重连要看得清已有内容」的行为不变）。

### 2. warm 切换跳过 history（B）

- **不给 warm 切换起 select 事务**。`packages/stores/src/tmux-selection-actions.ts` 的 `selectPane` 新增第 5 参 `options?: { warm?: boolean }`：warm 时 `wantHistory=false`，且**完全不 dispatch `SELECT_START`**。
  - 于是不会有 `onResetTerminal` / `onApplyHistory` 打到活着的终端上（`SelectStateMachine.handleLiveResume` 在 `wantHistory:false` 且状态为 ACKED 时是会调 `onResetTerminal` 的——绕开它的唯一干净办法就是不起事务，且 `ws-client` 不在我的 owned 范围）。
  - 网关回来的 `selection-ack` / `live-resume` 因为没有匹配事务（token 校验失败或无事务）被静默忽略，无副作用。
  - 副作用是 warm select 没有 ack 超时/失败重试。可接受：warm select 只是切 tmux 焦点，输入是按 `(deviceId,paneId)` 直发的，不依赖 active pane。
- **缺口防护（重要）**：冷 select 的 `SELECT_START` 会取消上一笔事务并**丢弃它门控缓冲的 live 字节**。以前上一个 pane 会被卸载所以无所谓；现在它还挂着，那段字节就是真缺口。store 里记了一张 `gappedPanes`：冷 select 取消掉别的 pane 的在途事务时把那个 pane 标记为「有缺口」，之后它的 warm 请求被**否决**、退回冷路径（reset+history，落到仍挂载的实例上，完全正确，只是慢一次）；该 pane 再走过一次冷 select 后标记清除。
- 接缝：
  - `use-pane-route-reconciliation.ts`：`resolveSelectDispatch` 判 `select` 后再问 `isWarmSelectTarget(deviceId, paneId)`（render 已经把目标置为可见，所以这里读到的就是本次切换的判定）。warm 时不写 `lastFullSelectWindowRef`（没有做过完整 select）。
  - `use-pane-selection-dispatch.ts` 的 `followSelection`（tmux 侧 active 变化跟随）：此时路由还没改，用 `isRetainedPane(deviceId, paneId)`（切换前查询口）。

### 3. 焦点 / 全局探针 / 渲染循环（C）

- 复用 `Terminal` 已有的 `autoFocus` / `focused` 两个 prop（分屏就是这么用的）：可见实例 `true`，隐藏实例 `false`。
  - `useTerminalInput` 据此 `instance.focus()` + `setFocused()`；
  - `useTerminalBootSurface` 的 `setE2eTerminalProbe` 只在 `autoFocus` 为真时执行，且切走的实例不会清探针（无 cleanup），所以 `__tmexE2eXterm` / `__tmexE2eTerminal*` 恒指向可见实例。
- `terminalRef`（控制台共用，快捷键/editor/尺寸同步都用它）改由 `usePaneTerminalBinder` 转接：每个 pane 一个引用恒定的 ref 回调，登记进 map，可见 pane 变化时用 effect 把 `terminalRef.current` 指到新实例（与 `useSplitPaneTerminals.registerTerminal` 同一套做法）。
- **渲染循环保持运行，未做暂停**。理由：`TerminalRenderLoop` 是 damage-driven 的（只有 `schedule()` 被调用才排一帧），空闲隐藏实例没有 rAF 开销；只有该 pane 真的在出字时才画一次隐藏 canvas，而那个解析本来就必须做。因此也不需要「显示时强制全量重绘」——位图一直是对的。

### 4. 启动快路径（D）

- 新增 `packages/terminal-ui/src/components/hooks/terminal-fonts-cache.ts`：按 `fontId:fontSize` 缓存。已加载时 `ensureTerminalFonts()` **同步返回 `undefined`**，在途时返回共享 Promise。
- `TerminalSurfaceLifecycleDeps.loadResources` 放宽为 `Promise<void> | void`；`boot()` 里 `if (resources !== true && !(await resources)) return;` —— 资源已就绪时**一次 await 都不走**，`createSurface()` + `surface.initialize()` 的同步段在同一 tick 内执行。同步抛错也仍然落到 `TERMINAL_RESOURCE_ERROR_MESSAGE` 状态（有测试覆盖）。
- 首次 resize 去重：`TerminalResizeReporter` 记 `lastMeasuredRect`；`Terminal.tsx` 的 ResizeObserver 首次投递（observe 立刻给的那一次）若容器像素尺寸与上次测量一致（±0.5px）则直接跳过，不再排一轮 150ms 防抖测量。

### 5. 新增 sizing mode `'local'`

隐藏实例既不能用 `report`（多实例互抢整窗尺寸），也不能用 `follow`（`follow` 连本地测量都跳过，浏览器窗口变化后隐藏实例的 cols/rows 会和 tmux 侧脱节，切回来就是错行）。新增 `'local'`：照常 measure + `applyTerminalSize`，但**不 emit、不记 `lastReportedSize`/`pendingLocalSize`、不触发 `onResizeSettled`**。

## 改动文件

新增：
- `packages/panels/src/device-console/terminal-keep-alive.ts` / `.test.ts`
- `packages/terminal-ui/src/components/hooks/terminal-fonts-cache.ts` / `.test.ts`
- `packages/stores/src/tmux-selection-warm.test.ts`

修改：
- `packages/panels/src/device-console/terminal-stage.tsx` / `terminal-stage.test.tsx`
- `packages/panels/src/device-console/use-pane-route-reconciliation.ts`
- `packages/panels/src/device-console/use-pane-selection-dispatch.ts`
- `packages/stores/src/tmux-selection-actions.ts`
- `packages/terminal-ui/src/components/Terminal.tsx`
- `packages/terminal-ui/src/components/types.ts`
- `packages/terminal-ui/src/components/useTerminalResize.ts`
- `packages/terminal-ui/src/components/terminal-resize-reporter.ts` / `.test.ts`
- `packages/terminal-ui/src/components/hooks/terminal-surface-lifecycle.ts` / `.test.ts`
- `packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts`

**越界一处（需 commander 确认）**：`packages/stores/src/tmux-state.ts` —— 只给 `selectPane` 的类型加了可选第 5 参 `options?: { warm?: boolean }`（纯增量、4 行）。不改它 TS 过不了，且该文件不属于任何其他 agent 的 owned 范围。

`pane-subscriptions.ts` 最终**未改**。保活让 `set-pane-subscriptions` 的消息数不增反平（以前切换是「卸旧+挂新」两条，现在是「挂新」一条 + 淘汰时一条）。本想加微任务合并，但收益远小于订阅集合出错的风险，放弃。

## 测试

| 包 | 之前 | 之后 |
|---|---|---|
| packages/panels | 650 pass（本 worktree 起点已被别的 agent 推到 659） | **671 pass / 0 fail**，tsc 0 |
| packages/terminal-ui | 325 / 0 | **332 pass / 0 fail**，tsc 0 |
| packages/stores | 368 / 0 | **373 pass / 0 fail**，tsc 1（`host-services.test.ts:93` 既有） |
| packages/ghostty-terminal | 216 / 0 | **216 pass / 0 fail**，tsc 0 |
| apps/fe (`bun test src/`) | 1070 / 0 | **1079 pass / 0 fail**，tsc 0 |

`bunx biome check` 对全部改动文件 clean。

新增覆盖：保活池 MRU/淘汰/设备切换/幂等/可见优先/断线降级（9 例）；stage 静态渲染的可见 vs 隐藏结构 + 分屏不受影响（3 例）；warm vs cold 的 `wantHistory` 与「不起事务 ⇒ 不 reset」+ 缺口否决与解除（5 例）；`'local'` sizing mode 只对齐不上报 + `lastMeasuredRect`（2 例）；字体缓存共享/同步短路/按 size 区分（3 例）；lifecycle 同步资源路径不 await + 同步失败仍报错（2 例）。

## 对网关的假设（需 G2 / commander 确认）

1. `select-pane` 带 `wantHistory:false` 时，网关**只切 tmux 的 active pane/window、回 `KIND_TERM_SELECTION_ACK`、立即恢复 live**，不做 capture、不发 `KIND_TERM_HISTORY`。（前端此时不起事务，多发的 history 会被 `dispatchPaneHistory` 的 token gate 判 miss、再交给状态机、状态机无事务 ⇒ 丢弃；不会炸，但会白花一次 capture。）
2. `wantHistory:false` 的 `select-pane` **仍然接受并应用 `cols`/`rows`**（我们照常带上，保证 tmux 侧几何跟着可见终端走）。
3. 网关会为**所有已订阅 pane**推送 output，包括不在当前 active window 里的 pane（tmux control mode 本身就是这样）。保活的正确性完全建立在这条上：隐藏实例靠持续 live 保持缓冲最新。若某条链路（relay / companion）对非 active window 的 pane 静默不推，warm 切换会看到过期画面——**这是最需要实测确认的一条**。
4. 订阅集合从「1 个 pane」变成「最多 3 个」。若网关有订阅上限并通过 `subscription-applied.rejectedPaneIds` 拒绝，被拒 pane 会走 rebase 自愈；N=3 应该远低于任何上限，但请留意。

## 需要 commander 实测的手工脚本

在仓库内起临时实例（**不要碰 9883 的生产服务**），浏览器开 DevTools：

1. **warm 切换无占位、无 history**
   - 进入某设备，打开 pane A（单 pane window），等内容出来。
   - 切到 pane B（另一个单 pane window），等内容出来。
   - 切回 A。**期望**：不出现 `[data-testid="terminal-boot-placeholder"]`（"加载中"），内容瞬时呈现且**包含切走期间 A 产生的新输出**（切走前在 A 里跑 `while true; do date; sleep 1; done` 最直观）。
   - Network → WS → 帧：切回 A 的那条 `select-pane` 里 `wantHistory` 应为 `false`，且**其后没有 `KIND_TERM_HISTORY`**。
   - Elements：`[data-testid="terminal-keep-alive-pane"]` 应有 2 个，第一个 `data-visible="true"`，第二个带 `aria-hidden="true"` 且 `style="visibility:hidden;..."`。

2. **首次访问仍是冷路径**：第一次进 A、第一次进 B 都应看到 `wantHistory:true` + history 重放。

3. **LRU 淘汰**：依次访问 A→B→C→D，回到 A。期望 A 是冷切换（占位一闪），保活槽里只剩 D/C/B。

4. **切设备清池**：设备 1 的 A→B 后切到设备 2，再切回设备 1 的 A —— 应为冷切换，且设备 2 页面下 DOM 里没有设备 1 的终端残留。

5. **分屏不受影响**：把某 window 拆成 2 pane（进入分屏），点击非焦点 pane 仍走轻量 `focus-pane`；退出分屏回单屏后第一次切换是冷的。

6. **断线/重连**：A→B 后断开设备，隐藏实例应立刻从 DOM 消失（只剩可见的 B）；重连后 B 走完整 select 重拉 history。

7. **窗口尺寸**：A→B 后把浏览器窗口拉大/缩小，再切回 A。期望 A 的排版正确（不错行）——这条验证 `'local'` sizing mode。

8. **e2e**（我没有跑，请 commander 在跑 e2e 时重点看）：`terminal-viewport-render.spec.ts`（`.xterm canvas` 按文档序取，我已把可见实例排到最前）、`single-pane-window-switch-resize.spec.ts`（正好是切窗口场景，现在第二次切回会走 warm）、`ws-borsh-pane-route.spec.ts`、`sidebar-click-no-pty-injection.spec.ts`。

## 已知取舍 / 后续

- 移动端也启用了保活（N=3）。三个 WASM 终端实例在低端手机上内存/能耗的影响没有实测；如果需要，把 `KEEP_ALIVE_LIMIT` 按 `isMobile` 降到 1 是一行改动（但 `terminal-stage.tsx` 目前不给池传 limit，需要加一个入参）。
- `prepareResources` 在 fe 里恒返回 `Promise.resolve()`（`device-console.tsx` 的 `?? Promise.resolve()`），所以启动路径仍会走一次微任务。真正的开销（4 次 `document.fonts.load` + `Promise.all`）已经去掉。若要做到完全同步，需要 `device-console.tsx` 在宿主没传 `prepareTerminalResources` 时返回 `undefined` —— 那个文件不在我的 owned 范围，没动。
- warm 切换不做尺寸上报（可见实例的 `runPostSelectResize` 只在 `onReset` / 实例更换时触发），这是刻意的：保活实例的几何一直跟着容器走，无需再抖一次。

---

## Review follow-up：warm 切换遗留旧事务导致 pane 冻结（blocker，已修）

### 复现与成因

Reviewer 的判断成立，而且比描述的更早触发——**第二步就已经冻结**，不必等切回去：

1. 冷 select `%1`：客户端起事务（token T1）+ 输出门控 BUFFERING；收到 `SWITCH_ACK(T1)` → `ACKED`；history 还没到。
2. 用户切到保活中的 `%2`（warm）：我原来的实现**不 dispatch `SELECT_START`**，所以客户端那笔 T1 事务和它的门控原封不动地留着。但网关对**每次** select 都开新事务并取消上一笔（`tmux-command-handlers.ts:104` / `switch-barrier.ts:92`），`%1` 那个 token 的 history/live-resume 永远不会来了。
3. 于是 `%1` 的 live 一直被灌进这个孤儿门控（`handleOutput` 里 `transaction.paneId === paneId` 命中 BUFFERING 分支），而且每一帧都会 `armProgressDeadline` 续上 5s 期限，**连超时兜底都不会触发** → `%1` 永久冻结。第 3 步再 warm 切回 `%1` 时，新 token 的 ACK/LIVE_RESUME 因 `validateToken` 不匹配被忽略，画面继续冻着。

根因是我把「不起事务」当成了 warm 的实现手段，却没处理「网关侧事务是无条件轮换的」这一事实：**客户端任何未落定的旧事务，在下一次 select 下发时都已经失去了对应的服务端 barrier，必须就地清掉。**

### 修法

`packages/stores/src/tmux-selection-actions.ts` 新增纯函数 `resolveSelectPaneDecision()`，把取舍显式化：

```ts
resolveSelectPaneDecision({ paneId, warmRequested, targetGapped, inFlightPaneId })
  -> { wantHistory, abandonPaneId, gapPaneId }
```

- `inFlightPaneId === paneId`（目标自己那笔 select 还没落定）→ **强制冷路径**，`SELECT_START` 生成的新 token 接管门控；不记缺口（冷 select 本身就会拿到权威 history）。
- `inFlightPaneId` 是别的 pane → `abandonPaneId = gapPaneId = inFlightPaneId`：下发前显式 `selectMachine().abandonPane()` 作废它（`cancelTransaction` 会 `stopOutputBuffering` 丢弃门控 + 清 timer + 清 deferred），同时记入 `gappedPanes`，于是那个 pane 的下一次 warm 请求被否决成冷 select 去修缺口。目标本身该 warm 就 warm。
- `targetGapped` → 否决成冷（原有逻辑保留）。
- 冷路径原先「顺带记缺口」的分支也归并进同一个决策，不再散落在 `if` 里。

`selectPane` 里的调用顺序：读在途事务（`atomicScreen` 链路不走选择事务，直接传 `null`）→ 决策 → `abandonPane` → `markPaneGapped` → 冷路径才 `clearPaneGap` + `SELECT_START` → 发 `select-pane`。

**没有用到任何 owned 范围外的 API**：`abandonPane(deviceId, paneId)` 早已挂在 `core.selectMachine()` 上（`handleSnapshotPaneRemoval` 就在用），语义正好是「作废该 pane 的事务并丢弃门控」，不需要动 `ws-client`。

### 测试

`packages/stores/src/tmux-selection-warm.test.ts`：

- 把 fake select machine 改成会真正建模门控归属——`SELECT_START` 起门控、`abandonPane` 释放门控，并暴露 `gateOwner()` / `abandoned` / `ackCurrent()`，这样「有没有留下悬空门控」是可断言的（之前 `abandonPane: () => true` 的假实现掩盖了这个 bug）。
- 纯函数 6 例：冷、warm 无事务、目标有缺口被否决、别的 pane 在途（作废 + 记缺口 + 目标仍 warm）、目标自己在途（强制冷）、冷 select 压过别的 pane 在途仍记缺口。
- 回归 3 例：
  - `warm switch away from an un-settled pane tears down its stale transaction`：冷 `%1` ACKED → warm `%2`，断言 `abandoned == ['%1']`、`gateOwner() === null`、本次 `wantHistory:false`。
  - `cold %1 ACKED → warm %2 → warm %1`（reviewer 点名的那条）：断言切回 `%1` 是**冷**下发（`wantHistory:true` + `SELECT_START`）、门控归 `%1`、没有第二个 pane 留着悬空门控。
  - `warm select onto the pane whose own select is still in flight goes cold`：`inFlightPaneId === paneId` 分支。

### 复测结果（全绿）

| 包 | 结果 |
|---|---|
| packages/panels | 676 pass / 0 fail，tsc 0 |
| packages/terminal-ui | 332 pass / 0 fail，tsc 0 |
| packages/stores | 382 pass / 0 fail，tsc 1（`host-services.test.ts:93` 既有） |
| packages/ghostty-terminal | 216 pass / 0 fail，tsc 0 |
| apps/fe (`bun test src/`) | 1084 pass / 0 fail，tsc 0 |

`bunx biome check` 对 `packages/stores/src`、`packages/panels/src/device-console`、`packages/terminal-ui/src/components` 共 189 个文件 clean。改动仍只落在 owned 文件里（外加此前已报备的 `tmux-state.ts` 类型增量）。

### 追加的手工验证步骤

在原脚本第 1 条之后加一条**抢切**用例：

9. **在 select 未落定时抢切**：在 pane `%1` 里跑 `yes` 之类持续输出的命令，然后**快速**点 `%1` → `%2` → `%1`（每步间隔 < 300ms，即赶在 history 到达之前切走）。期望：
   - `%1` 最终**不冻结**，输出持续滚动；
   - WS 帧里切回 `%1` 的那条 `select-pane` 是 `wantHistory:true`（被缺口否决成冷路径），随后有 `KIND_TERM_HISTORY`；
   - 反复抢切十几次后 `%1`/`%2` 都能正常刷新，没有哪个 pane 卡住不动。

---

## Review follow-up 2（全量 diff 复审 6 项 + 复杂度门禁）

### 1. 缺口生命周期：只有落定的冷 select 才算补洞（blocker）

前一轮我已经加了「warm 打断在途事务 → 作废 + 记缺口」。这一轮补的是**清除时机**：原来
`clearPaneGap()` 在冷 select **发出时**就跑了，等于「发起即认为补好」。ACK 超时、被拒、
或还没落定就切走，缺口都会被错误地清掉，下一次切回去又变成 warm，缺口永久留在画面上。

改法：账本从「一个 Set」变成「Set + 补洞记录」，抽到新模块
`packages/stores/src/pane-stream-gaps.ts`：

- `beginRepair(deviceId, paneId)`：为补洞下发冷 select 时登记，**不清缺口**；
- `settleRepair(deviceId, hasInFlightTransaction)`：状态机把事务摘掉的路径只有「完成」和
  「失败」，失败必定先回调 `onSelectFailed`（走 `abortRepair`）。因此「事务已离场且补洞记录
  还在」= 落定，此时才清缺口。求值时机是下一次 `selectPane`——正好是缺口唯一起作用的地方；
- `abortRepair(deviceId)`：`handleSelectFailed` 里调用，缺口保留；
- `markGapped()` 会顺手作废指向同一 pane 的补洞记录，覆盖「补洞途中又被打断」。

`maybeReselectCurrentPane()`（重连 / select 失败重来）现在先 `markGapped(current)` 再冷
select：这两条路径下终端都没拿到过权威 history，本来就该按缺口处理，由这次冷 select 补。

**测试全部换成真实 `SelectStateMachine`**（`tmux-selection-warm.test.ts` 重写，注入
`SelectTimerScheduler` 控超时，通过 transport 事件 `selection-ack` / `legacy-history` /
`live-resume` 经真实 router 驱动，`dispatchPaneHistory` 返回 false 让 token gate 落到状态机）：

- `cold in-flight → warm interrupt`：断言 `machine.getTransaction()` 变 undefined、
  `machine.isBuffering()` 变 false（孤儿门控确实没了）、命令 `wantHistory:false`；
- `gap recovery cold select → timeout → revisit still cold`：补洞 select ACK 后触发 progress
  超时，再访问仍是 `wantHistory:true`；
- 对照组 `gap recovery that completes`：补洞走完 history + live-resume 后，再访问才是 warm；
- `warm 不给活着的终端打 reset`：断言 `dispatchPaneReset`/`dispatchPaneApplyHistory` 零调用。

### 2. 流中断必须撤销 warm 资格（blocker）

`dropHiddenKeepAlivePanes` 只裁了 `panes`，`visibleIsWarm` 还留着 true —— 断线时仍挂着的
可见实例同样错过了那段输出，重连后切回它会 `wantHistory:false`，拿一张永不刷新的旧屏。

改名并修正语义为 `invalidateKeepAliveStream(pool)`：裁掉隐藏实例 **且** `visibleIsWarm=false`。
新增测试 `reconnecting → disconnected → reconnected leaves the visible pane cold`。

store 侧还有第二道独立防线（第 1 项的 `maybeReselectCurrentPane` 先记缺口），两者都失效才会漏。

### 3. StrictMode 下保活其实从未生效（should fix，实测零 warm 的真因）

确认成立。旧实现把池放在模块级单例，用 `useEffect(() => releaseKeepAlive, [])` 清理。
StrictMode 挂载会跑「setup → cleanup → setup」，那次模拟 cleanup 把全局清空了，而 render 期
的 retain 不会重跑 —— 于是每次挂载后池都是空的，第一次切换就把本该保活的实例卸载了。

改法（`useOwnedKeepAlivePool`）：

- 池归组件实例（`useRef`），render 期推进（`retainKeepAlivePane` 对同一可见 pane 幂等，
  StrictMode 双渲染安全）；
- **提交阶段**用 `useLayoutEffect`（无依赖，每次提交都跑）把只读快照发布给 select 下发侧。
  子组件的 layout effect 早于父组件的 passive effect，所以 `usePaneRouteReconciliation` 在
  同一次提交里读到的就是这一帧的 warm 判定；
- cleanup 是 `unpublishKeepAlivePool(owner)`，**按 owner 判定归属**：迟到的旧实例 cleanup 清不掉
  后来者刚发布的快照；StrictMode 的 setup→cleanup→setup 结束时仍是发布态。

**关于 `createRoot(<StrictMode>)` 挂载测试**：本仓库没有 DOM 测试环境（`happy-dom` /
`jsdom` 都不在依赖里，panels/apps/fe 的组件测试一律走 `react-dom/server` 静态渲染），加依赖
超出本任务范围。折中做法是把 `useOwnedKeepAlivePool` 的契约（render 推进 / layout 发布 /
owner 撤销）按 React 的真实调用序列在单测里复现：`terminal-keep-alive.test.ts` 里的
`createStackInstance().strictModeCommit()` 就是 setup→cleanup→setup，断言
`isRetainedPane()` 在模拟重挂载后仍为 true、跨切换 `%1` 仍挂着、切回是 warm——**这三条断言在旧
实现上会失败**。另加「迟到 cleanup 不清后来者」「真实卸载才清空」两例。
如果需要真正的浏览器语义验证，建议放进 e2e（下面手工脚本第 1 条即可覆盖）。

### 4. e2e 探针跟随可见实例（should fix）

`setE2eTerminalProbe` 现在同步 `__tmexE2eTerminalSelectionText`（`hasSelection()` 时取
`getSelection()`，否则 null），不再把上一个 pane 的旧选区留在整页唯一的全局上。
探针 effect 同时改为依赖 `bootState.status`：`autoFocus` 为真但实例未就绪（启动中 / 启动失败）
时调 `clearE2eTerminalProbes()` 把终端/引擎/渲染器/选区指针一并清空，避免指向别的 pane。

### 5. 字体快路径在真实应用里从未命中（should fix）

`DeviceConsole` 的 `prepareResources` 里的 `?? Promise.resolve()` 让 `loadResources()` 恒返回
Promise。已按授权改 `device-console.tsx:96`（去掉 `?? Promise.resolve()`），并把
`TerminalProps` / `SplitTerminalArea` / `SplitPaneView` / `TerminalStageProps` 的
`prepareResources` 放宽为 `() => Promise<void> | void`。

`createLifecycleDeps` 的 `loadResources` 抽成 `loadTerminalResources(prepareResources, fontId,
fontSize)`（`terminal-fonts-cache.ts`），三例测试直接打这个生产路径：无宿主钩子 + 字体命中
缓存 → **同步返回 undefined**；宿主钩子返回 Promise → 仍然 gate；字体未缓存 → 仍然 gate。
配合已有的 lifecycle 测试（`resources already loaded (void return) build the surface without
awaiting`），整条「命中缓存 → 同 tick 建控制器」是被覆盖的。

### 6. `gappedPanes` 的清理（should fix）

- **快照更新**：`handleSnapshotPaneRemoval` 开头无条件调用
  `gaps.retainLivePanes(deviceId, snapshotPaneIds(...))`，丢掉快照里已不存在的 pane，
  并连带作废指向它们的补洞记录（否则一条悬空补洞记录会去清别人的缺口）。
- **断开**：新增 `TmuxSelectionActions.handleDeviceDisconnected(deviceId)`（取消重选排队 +
  `gaps.resetDevice`）。**需要你补一行接线**：`packages/stores/src/tmux-event-router.ts`
  的 `'device-disconnected'` 分支里加 `ctx.selection.handleDeviceDisconnected(event.deviceId)`
  （该文件不在我的 owned 范围）。不接也不会错——断开后重连必定走
  `maybeReselectCurrentPane`，那里已经重新记缺口并冷 select；这一行纯粹是账本卫生（否则
  条目留到下次快照更新才被裁）。账本本身以 `resetDevice` 单测覆盖。

### 复杂度门禁

`bun scripts/complexity/gate.ts` 现在只剩 4 条违规，**全部在 `apps/gateway`**（mesh-runtime /
peer-manager / node-list-projection / tmux-command-handlers，属其他 agent 的改动范围）。
我的四个文件全部回到锁内，靠真实拆分（没有动 allowlist）：

| 文件 | 之前 | 现在 | 拆到哪 |
|---|---|---|---|
| `use-pane-selection-dispatch.ts` | 164 > 157 | 通过 | 新 `use-select-request.ts`（select 尺寸换算 + 最近下发记账） |
| `use-pane-route-reconciliation.ts` | 148 > 138 | 通过 | 新 `use-route-target-recovery.ts`（路由回落 + 首次自动选中，两个只改路由的 effect） |
| `Terminal.tsx` `<anon>` | 261 > 245 | 通过 | 新 `hooks/useTerminalHandle.ts`（命令式句柄）+ `hooks/useContainerResizeObserver.ts` |
| `tmux-selection-actions.ts` `createTmuxSelectionActions` | 164 > 127 | 通过 | 新 `pane-stream-gaps.ts`（缺口账本 + 取舍判定）、`select-pane-dispatch.ts`（一次下发的全过程）、`reselect-retry.ts`（重选排队） |

顺带：`device-console.tsx` 因为我加的注释一度 130 > 128，已把说明挪到 `prepareTerminalResources`
的 prop 文档上（组件体外），回到锁内。

### 本轮新增/改动文件

新增：`packages/stores/src/{pane-stream-gaps,select-pane-dispatch,reselect-retry}.ts`、
`packages/stores/src/pane-stream-gaps.test.ts`、
`packages/panels/src/device-console/{use-select-request,use-route-target-recovery}.ts`、
`packages/terminal-ui/src/components/hooks/{useTerminalHandle,useContainerResizeObserver}.ts`。

改动（除已报备的 `tmux-state.ts` 外）新增一处授权改动：`packages/panels/src/device-console/device-console.tsx`。

### 复测（全绿）

| 包 | 结果 |
|---|---|
| packages/panels | 679 pass / 0 fail，tsc 0 |
| packages/terminal-ui | 335 pass / 0 fail，tsc 0 |
| packages/stores | 386 pass / 0 fail，tsc 1（`host-services.test.ts:93` 既有） |
| packages/ghostty-terminal | 216 pass / 0 fail，tsc 0 |
| apps/fe (`bun test src/`) | 1084 pass / 0 fail，tsc 0 |

`bunx biome check`：`packages/stores/src` + `packages/panels/src/device-console` +
`packages/terminal-ui/src/components` 共 197 个文件 clean。

### 手工验证补充

第 3 项的浏览器语义只能在真实 StrictMode 下确认，请务必跑原脚本第 1 条并检查
**DOM 里确实有 2 个 `[data-testid="terminal-keep-alive-pane"]`**（这一条之前一定是失败的）。
另加：

10. **重连后不吃旧屏**：`%1` → `%2` → `%1`（此时是 warm），断开设备再重连，等 `%1` 恢复输出后
    切到 `%2` 再切回 `%1`。期望切回 `%1` 的那条 `select-pane` 是 `wantHistory:true`（断线撤销了
    warm 资格），画面是新的，不是断线前的旧屏。

---

## Review follow-up 3（保守化：任何流连续性存疑就撤销 warm）

### B1 — 自动重连没被当成流中断（blocker）

确认成立，而且比描述更严重：`error/reconnecting` 只置 `deviceReconnecting`、`deviceConnected`
仍为 true，所以保活栈完全没察觉；旧 select 事务也没人清，等 `reconnected` 到达时
`maybeReselectCurrentPane` 会因为 `getTransaction()` 非空**直接早退**——重连后连冷 select 都
不会发，画面就停在断线前那一屏。

改法分两侧：

- **store/router**：`TmuxSelectionActions.handleDeviceDisconnected` 升级为
  `handleDeviceStreamInterrupted(deviceId)`：取消重选排队 + `selectMachine().cleanup()` +
  作废补洞记录 + **把该设备快照里所有 pane 一并记缺口**（中断期间谁都可能漏字节，恢复后每个
  pane 都得各自走一次落定的冷 select 才重新有 warm 资格）。
  `tmux-event-router.ts` 里新增 `isDeviceStreamInterruption()`：`device-event` 的
  `disconnected` 与 `error/reconnecting` 都走这条路；`device-disconnected` 事件也改调它
  （`selectMachine().cleanup()` 收敛到这一处，不再散在两个地方）。
- **前端保活池**：栈读的中断条件从 `!deviceConnected` 改成
  `!deviceConnected || isReconnecting`。

测试：`tmux-selection-warm.test.ts` 走真实事件链
`connected → error/reconnecting → reconnected`，断言中断后事务与门控都没了、重连后当前 pane
拿到 `wantHistory:true` 的完整 select；再断言该设备**任意** pane 的 warm 请求都退回冷路径。
路由层另加两例（reconnecting / device-event disconnected 都触发 `handleDeviceStreamInterrupted`）。

### B2 — 不再从「事务消失」反推补洞成功（blocker）

确认成立：门控溢出会置 `outputGapped`、跳过 reset/apply 改由 rebase 重建画面，但事务照常摘除，
旧的 `settleRepair` 推断会把一张仍然有洞的屏当成补好了。

`settleRepair` 整个删掉，换成两个**显式观察点**，镜像状态机自身的判定条件，在 router 派发
事件**之前**读事务（新模块 `select-transaction-observers.ts`）：

- `observeSelectHistory`：`token 命中 && state === 'ACKED' && !outputGapped` ⇒ 记
  `historyCommitted`（这正是状态机真会调 `onResetTerminal`/`onApplyHistory` 的条件）；
- `observeSelectLiveResume`：`token 命中 && state === 'HISTORY_APPLIED' && !outputGapped`
  ⇒ `completeRepair`（要求 `historyCommitted` 已记，否则不清缺口）。

于是 `cancelTransaction` / `cleanup` / `abandonPane` / ACK 超时 / 被拒 / 门控溢出——**任何**
没有走完这两步的结局，缺口都留着。补洞记录带 selectToken，别的 token 的信号一律忽略。

测试：`tmux-selection-warm.test.ts` 用真实状态机（`maxBufferedBytes: 8`）真实驱动溢出路径——
补洞 select ACK 后灌一帧 64 字节 live 触发 `output buffer overflow`，再发 history + live-resume，
断言事务已摘除但缺口仍在、下次访问仍是 `wantHistory:true`。账本层另有
「有 live-resume 无 history commit ⇒ 缺口保留」「token 不匹配的信号被忽略」等 8 例。

### B3 — 快照删除的 pane 会赖在池里（blocker）

池新增两个概念：

- `retainLiveKeepAlivePanes(pool, livePaneIds)`：隐藏实例里已不在快照的直接卸载。
  **可见 pane 永不裁**（快照可能只是还没追上，它的失效交给路由对账）。栈通过新的
  `useDeviceLivePaneIds(deviceId)`（读 store 快照）拿到存活集合。
- `generation` 进 React key（`keepAlivePaneKey`）。裁掉任何 pane 时换代，
  于是「同一提交内先删后加同一个 id」也拿不到旧实例；`applyKeepAliveStreamState` 在**流恢复
  时**换代，tmux 重启复用 pane id 的情况下可见实例也会重挂一个空终端。

关于换代时机的取舍：换代放在**恢复**而不是**进入中断**，是为了保住既有的
「重连期间保持 Terminal 挂载，用户还能看清已有内容」行为（有测试锁住 key 在中断期间不变）。
**这是一处用户可见变化**：重连恢复的那一刻可见终端会重挂，先闪一下加载态再由冷 select 重建，
不再直接把旧内容留在屏幕上。

测试：隐藏 pane 被快照删除 ⇒ 卸载 + 换代 + 深链回来是冷；可见 pane 不被裁；快照没变化时池对象
原样返回；栈生命周期层另有一例走「%1 隐藏 → 快照删除 → 深链回 %1 ⇒ cold」。

### S1 — 排队中的 report 任务可能在实例隐藏后才执行

`TerminalResizeReporter` 现在从 `deps.getGate()` **在执行时**取准入条件（`report()` 的 `gate`
参数降级为仅测试用的显式覆盖）；`useTerminalResize` 把 gate 与回调都写进**渲染期同步更新**的
ref（回调 ref 原先在 passive effect 里更新，「渲染完成 → effect 执行」之间触发的任务会拿到上一帧
的回调）。副产品：`scheduleResize` 引用变稳定，ResizeObserver 的 effect 不再随 gate 变化重挂。

测试（真实 `TerminalResizeScheduler` + 手动 timers）：report 态排队 → 切成 local → 跑任务 ⇒
零 handler 调用，但本地 cols/rows 仍然对齐；反向用例（local 排队 → 切回 report ⇒ 照常上报）。

### 新增文件

`packages/stores/src/select-transaction-observers.ts`（顺带把 `createTmuxSelectionActions`
压回 127 行锁内）。

### 复测

| 包 | 结果 |
|---|---|
| packages/panels | 685 pass / 0 fail，tsc 0 |
| packages/terminal-ui | 337 pass / 0 fail，tsc 0 |
| packages/stores | 394 pass / 0 fail，tsc 1（`host-services.test.ts:93` 既有） |
| packages/ghostty-terminal | 216 pass / 0 fail，tsc 0 |
| apps/fe (`bun test src/`) | 1084 pass / 0 fail，tsc 0 |

`bunx biome check` 198 文件 clean。
**`bun scripts/complexity/gate.ts`：`complexity gate ok (1107 files, 9236 functions)`** —— 全仓零违规
（上一轮剩下的 4 条 gateway 违规也已被对应 agent 清掉）。

### 手工验证补充

11. **自动重连（不断线）**：`%1` → `%2` → `%1`（warm），制造一次网络抖动让网关发
    `reconnecting`（不要真的断开设备）。期望：隐藏实例立刻从 DOM 消失；恢复后可见终端**重挂一次**
    （短暂加载态）并由 `wantHistory:true` 的 select 重建；之后 `%2` / `%1` 的第一次切换都是冷的。
12. **pane 被别处关掉**：`%1` → `%2`（`%1` 隐藏保活），在别的客户端 `tmux kill-pane` 掉 `%1`。
    期望：`%1` 的隐藏槽立刻从 DOM 消失；之后深链回同名 pane 一定是冷启动。

---

## Review follow-up 4（终轮：H1 / H2 / S1 / S2）

### H1 — 网关 WS 自身重连也是流中断（blocker）

`connection-state` 之前只更新状态。backoff 期间隐藏保活实例的输出没人收，而 READY 之后只有
`device-connected` 路径会重选**当前** pane，隐藏的 B 就带着断裂缓冲继续算 warm。

`tmux-event-router.ts` 里用一张 `WeakMap<ctx, boolean>` 记「传输层是否曾经 READY 过」；
**曾经 READY 且现在离开 READY** 时，对 `connectedDevices` 里的每个设备调
`handleDeviceStreamInterrupted` 并 `paneSinks.cleanupDevicePaneState`（丢掉该设备的 pending
缓冲与 history gate）。首连过程中的 `WS_CONNECTING` / `HELLO_NEGOTIATING` 不触发。

测试两例：`READY → RECONNECT_BACKOFF → READY` 后隐藏 pane 切回是 `wantHistory:true`；
`WS_CONNECTING → READY` 的首连不算中断，warm 仍然成立。

### H2 — 池级 generation 会误伤可见实例（blocker）

确认成立，两种触发都会把**可见**终端卸掉：删掉一个隐藏 pane、或流恢复。后者尤其糟——
在冷 history 到达前就卸载，必然白闪一屏，而且 history 可能落到还没注销的旧 sink 上。

`generation: number` 换成 `incarnations: Record<paneId, number>`，key 变成
`${deviceId}:${paneId}#${incarnation}`：

- 只有**被快照确认删除的那个 pane** 自己的化身号 +1（`retainLiveKeepAlivePanes`），
  同一 id 再出现时拿到新 key、重挂空终端；别的 pane 的 key 一动不动；
- `applyKeepAliveStreamState` 两个方向都**不再碰任何 key**：进入中断只裁隐藏实例 +
  取消 warm 资格，恢复只取消 warm 资格。可见终端全程挂着，内容由缺口账本保证的那次
  冷 select 用 reset + history 原子替换。

因此上一轮报告里「重连恢复时可见终端会重挂、先闪一下加载态」那条用户可见变化**已撤销**，
重连体验回到原样（保持挂载、内容原地替换）。

测试：把之前断言「可见 key 会变」的两例反转成断言 key 不变（它们编码的是这个 bug）；
新增「删除隐藏 pane 不打扰可见实例的 key」。

### S1 — 观察点必须比对事务 token（should fix）

两个观察点原先只看事务状态，没比对 `transaction.selectToken`。真正的泄漏路径是：
补洞事务 T3 的 history 先落地（记下 `historyCommitted`），随后门控溢出，`LIVE_RESUME(T3)`
因为 `outputGapped` 直接 return —— **补洞记录留在账本里**；等后来某笔无关事务 T4 走到
`HISTORY_APPLIED` 时，一条迟到的 `LIVE_RESUME(T3)` 会命中「状态 OK 且不 gapped」的判定，
`completeRepair(T3)` 又正好匹配那条泄漏的记录，把 `%1` 的缺口错误清掉。

改法：抽出 `currentTransaction()` 先比对 token（与状态机的 `validateToken` 同义）；
token 命中但 `outputGapped` 时走 `gaps.abortRepair(deviceId, selectToken)` —— 新增的
token-aware 作废，只删这笔记录、**保留缺口**。

回归测试按上述真实序列构造（history → overflow → LIVE_RESUME(T3) → 另一笔事务到
HISTORY_APPLIED → 重放 LIVE_RESUME(T3)），并**实测过**：把观察点还原成修复前的写法后该用例
立刻失败（13 pass / 1 fail），恢复后 14 pass。

### S2 — atomicScreen 链路不该用这本账（should fix）

整屏原子下发的链路根本不跑选择事务，缺口永远没人补，warm 会永久退化。按「取更简单的那个」：
`atomicScreen` 为真时**完全不记缺口**（新增模块级 `usesGapLedger(core)`，守住
`handleDeviceStreamInterrupted` 的 `markDeviceGapped` 与 `maybeReselectCurrentPane` 的
`markGapped` 两处唯一入口）。那条路径的画面由 canonical 快照重建，每个终端实例挂载时自己拉。
中断后的第一次切换仍然是冷的——保活池那侧照样裁隐藏实例、撤 warm 资格，与账本无关。

测试：atomic 链路走 `reconnecting → reconnected` 后，warm 切换仍然是 `wantHistory:false`。

### 复测

| 包 | 结果 |
|---|---|
| packages/panels | 686 pass / 0 fail，tsc 0 |
| packages/terminal-ui | 337 pass / 0 fail，tsc 0 |
| packages/stores | 398 pass / 0 fail，tsc 1（`host-services.test.ts:93` 既有） |
| packages/ghostty-terminal | 216 pass / 0 fail，tsc 0 |
| apps/fe (`bun test src/`) | 1084 pass / 0 fail，tsc 0 |

`bunx biome check` 198 文件 clean。
`bun scripts/complexity/gate.ts`：**我的文件零违规**（`createTmuxSelectionActions` 把
`usesGapLedger` 提到模块级后回到 127 行锁内）。剩余 4 条全部在 `packages/app`
（init / upgrade / upgrade-apply，属另一位 agent 本轮的改动范围）。

### 手工验证修订

- 上一轮的第 11 条**改判**：自动重连恢复后，可见终端**不应该**重挂/闪加载态——它应当保持挂载，
  内容被 `wantHistory:true` 的那次 select 原地替换。隐藏实例仍应在中断瞬间从 DOM 消失。
- 新增 13：**网关 WS 抖动**（不是设备断开）。`%1` → `%2` → `%1`（warm）后，让浏览器与网关之间的
  WS 断一下（如重启 gateway 进程或断网几秒）。恢复后切到 `%2` 再切回 `%1`，两次都应是
  `wantHistory:true`；DOM 里隐藏槽在 backoff 期间就该消失。

---

## Review follow-up 5（e2e `terminal-selection-canvas` 回归定位）

### 结论先说：不是 FE 的锅，是**旧渲染本来就是坏的**，屏障拿掉之后画面变正确，反而把 spec 里的一个隐含假设戳破了。

### 定位过程（三次二分，每次都实跑）

| 配置 | 结果 |
|---|---|
| 全量 HEAD | 1 failed / 3 passed |
| **我的 FE 改动全部回退到 base**（panels + terminal-ui + stores 共 34 个文件），gateway 保持 HEAD | **仍然 1 failed**（同样的 `Received: null`） |
| 我的 FE 保持 HEAD，**gateway 的 4 个文件回退到 base** | **4 passed** |
| 只把 `apps/gateway/src/ws/borsh/switch-barrier.ts` 单独恢复到 HEAD | 又 1 failed |

即：**单文件 `switch-barrier.ts`（G2 拿掉 450ms 屏障那次改动）可以独立开关这个失败**，与我改的任何文件无关。
（回退用 `git show <rev>:<path>`，只读 git，跑完全部还原成 HEAD，`git status` 已确认干净。）

### 为什么屏障一拿掉这个用例就挂：旧画面是**花的**

从两次运行的 trace 里把 `evaluateExpression` 的返回值拉出来对比同一时刻的屏幕内容：

**base（有 450ms 屏障）——画面是错的：**
```
row0: PANE0_READY        '
row1: dragtargetpline\r\n'      <- 回显被 live 覆盖成了乱码
row2: dbltoken keep
row3: tripline
row4: sh-3.2$
```

**HEAD（屏障已拿掉）——画面是对的：**
```
row0: PANE0_READY
row1: sh-3.2$ printf 'dragtarget\r\ndbltoken keep\r\ntripline
row2: \r\n'
row3: dragtarget
row4: dbltoken keep
row5: tripline
```

旧行为下，屏障期间到达的 live 字节与 history 基线错位，把 shell 回显那一行冲成了
`dragtargetpline\r\n'`。于是三个待测词恰好都落在**第 0 列**（x=358），spec 点得到、也点得中。

屏障拿掉后画面恢复正确，回显行完整存在。而 spec 的 `findVisibleTextRange` 是**从上往下取第一个命中**，
回显行 `printf 'dragtarget\r\ndbltoken keep\r\ntripline` 里三个词全都有，于是：

- `dragtarget` 命中回显行 row1 col16 → x=486；
- `dbltoken` 命中回显行 row1 col30 → x=598（正好比前者右 14 格 = `dragtarget\r\n` 的字面量长度）。

而 `SelectionToolbar` 是 `absolute top-2 left-1/2 -translate-x-1/2`，容器 top=114、宽 440px、
中心 x≈574，工具条约 46px 高：**占据 x∈[444,704]、y∈[122,168]**。
第一步拖拽成功（那时还没有选区、工具条未出现），随后工具条弹出；第二步双击的
(598,138) 正落在工具条的按钮上 → 点到的是工具条而不是画布 → 选区被清 → 探针恒为 `null`。
这也解释了失败截图里终端整个消失：点到的是 Paste/Copy，后续按键把 pane 里的 shell 搞退出了。

### 改动：spec 本身编码了这个 bug，改 spec

`apps/fe/tests/terminal-selection-canvas.spec.ts` 的 `findVisibleTextRange`：

1. **跳过 shell 回显行**（`text.includes("printf '")`）。这些用例要点名的一律是命令的**输出**，
   回显行只是因为字面量里含有待测词才被命中——旧画面把回显冲花了才碰巧没命中它。
2. 改用 `page.waitForFunction` 轮询到输出行出现为止。回显与输出不在同一帧到达，
   原来的一次性查找 + 「屏幕里出现 dragtarget 就继续」会抢跑到只有回显的时刻。

产品代码一行未改（我的 owned 文件本轮零改动）。

### 顺带记一个**既有**产品问题（本轮不处理，超出「不要新增机制」的边界）

`SelectionToolbar` 浮在终端顶部居中且吃指针事件：**一旦有选区，pane 顶部约 3 行、水平居中的区域就点不到画布了**，
用户想在那里重新划词会点到工具条。这与保活/热切换无关，屏障改动之前就存在，只是旧画面把目标挤到第 0 列所以没暴露。
要修的话方向是「在终端内按下指针时先收起工具条」或把工具条挪出可视文本区，属于独立的一次交互改动，建议单开任务。

### 验证

- `apps/fe/tests/terminal-selection-canvas.spec.ts` 全文件（4 例）在**完整 HEAD**（含 G2 的屏障改动 + 我的全部改动）下
  连续跑 **2 次，4 passed / 0 failed**（12.1s、11.9s）。
- 单元：panels 686 / terminal-ui 337 / stores 398 / apps/fe 1084，全部 0 fail；
  tsc 仅 stores 那条既有的 `host-services.test.ts:93`。
- `bunx biome check` 199 文件 clean。
- `bun scripts/complexity/gate.ts`：我的文件零违规；剩余 5 条全在 `packages/app`
  （`upgrade-apply` / `init` / `direct` / `upgrade`，另一位 agent 的改动范围）。
