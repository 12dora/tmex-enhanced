# Issue #45 终端体验四 bug 研究报告

> 来源：4 路并行 explore agent + 1 路整合 + Metis 验证。本报告整合自 `.sisyphus/plans/issue-45-terminal-experience.md` 的 Context 段，并纳入 Metis 的关键修正。

## 摘要

Issue #45 报告 4 个终端体验 bug。研究通过 4 路并行 explore 深挖每个 bug 的根因，再用 Metis 验证研究成果。最终置信度：bug 2/3 高（根因清晰）、bug 4 中（4 候选，最高杠杆候选 C 已代码强验证）、bug 1 低（静态分析无法定位，需 Playwright 动态诊断）。

## bug 1：分屏后鼠标坐标差一行

**置信度：低**（静态分析反复推导"鼠标链路理论上正确"，与用户报告矛盾，必须 Playwright 动态诊断）

**3 个候选**（按概率）：

| 候选 | 位置 | 描述 |
|---|---|---|
| ① selectSize race（最可能） | `apps/fe/src/pages/DevicePage.tsx:286-294` vs `apps/fe/src/components/terminal/SplitTerminalArea.tsx:217` | `getSelectSize` 分屏分支用未扣标题栏的 rect 算 rows，与 `reportWindowSize`（扣 `titleBarStackDepth × PANE_V_OVERHEAD_PX`）不一致 |
| ② cellDimensions 时序 | `packages/ghostty-terminal/src/terminal.ts:1517-1547` | 字体异步加载下 cellWidth 可能按 fallback 测量 |
| ③ inline strut | `packages/ghostty-terminal/src/terminal.ts:336-343` | `.xterm-screen` 继承 root `lineHeight=1.2`，可能创建 strut 把 Canvas 推下一行 |

**关键诊断**：动态比对 `canvasRect.top` vs `screenRect.top`：不等 → 候选 ③；等但 row 偏 → 候选 ①。

**推荐首选方案**：A（鼠标坐标基准从 `.xterm-screen` 改为 Canvas，治本）；B（统一 selectSize）；C（`.xterm-screen` 加 `lineHeight:'0'` 防御）。

## bug 2：单窗口触发分屏后老 pane 清屏

**置信度：高**（根因完全确认，3 个连锁问题）

**根因 1（主因 / gateway 路由 bug）** `apps/gateway/src/ws/index.ts:1304-1308`：`broadcastTerminalHistory` 用 `selectedPanes[deviceId] === paneId` 决定走 barrier 还是 fetch 路径。split 时 P1 的 barrier 事务进行中（`context.paneId=P1`），但前端随后发 `focusPane(P2)`（`handleFocusPane` 行 1025）把 `selectedPanes[dev]` 改为 P2。当 P1 的 barrier history 回调到达时，`selectedPanes`(P2) ≠ P1 → 走 fetch 分支 → P1 无 `pendingHistoryFetches` → **history 丢弃**。

**根因 2（触发因 / 前端盲目 select）** `apps/fe/src/pages/DevicePage.tsx:516-521`：isSplitView 翻转 effect 盲目清空 `lastDispatchedSelectRef`，导致 select effect 对 URL 还指向的 pane（往往是 P1）派发完整 select，触发根因 1 竞态。

**根因 3（兜底失效 / fetch 焦点竞态）** `apps/fe/src/components/terminal/SplitTerminalArea.tsx:161-172`：fetch effect 首跑时若 `focusedPaneId` 还是 P1，P1 被误判为焦点跳过 fetch 但永久入 `fetched` Set，后续不再重试。

**Metis 关键修正**：barrier 自身已有过滤器（`switch-barrier.ts:224` `context.paneId !== paneId`）和状态机（`ACKED`/`HISTORY_APPLIED`）。修复**必须保留 barrier 状态机**，路由逻辑改为「有待处理的 ACKED 事务 → barrier 路径；否则 → selectedPanes 回退」，避免对正常 pane 切换的双重发送。

**推荐方案**：A（gateway 优先事务 paneId 路由，低风险必修）+ B（前端 select effect 加 active pane 守卫，治本）。

## bug 3：TUI 运行一段时间后清屏只剩局部

**置信度：高**（主因清晰 ~70%）

**主根因** `packages/ghostty-terminal/src/canvas-renderer.ts:147-193`（render）+ `:232-287`（resize）：`render()` 第一行调 `resize()`，resize 在 cols/rows/dpr/deviceCellWidth/deviceCellHeight 任一变化时 `canvas.width = width; canvas.height = height`（line 274-279），**HTML5 标准行为是整张清空 bitmap**；紧接着 render 用 `frame.meta.dirty` 决定重画范围——`'clean'`→只画光标 return，`'partial'`→只画脏行，只有 `'full'` 才全画。ghostty 的 dirty 是消费型（`vendor/ghostty/src/terminal/render.zig:261`），canvas 层 dpr 变化根本不通知 ghostty。

**既有证据**：
- 既有单测 `terminal.canvas.test.ts:1542-1548` 证明 `dirty='clean'` 时 `lastDrawnRows=[]`（smoking gun）
- 既有 e2e `apps/fe/tests/terminal-mouse-recovery.spec.ts:384` 已记录此 bug 预期但当前 flaky
- 全代码库无 `devicePixelRatio` 变化监听（无 matchMedia resolution）

**🚨 Metis 关键修正（重要）**：研究 agent 误判 commit `b6acd52`（Apr 17）引入 bug 3 回归。Metis 通过 git log 证明：
- b6acd52 **根本没有触及 canvas-renderer.ts**（canvas-renderer 的历史为 `64a265f → f0d0864 → a1da752 → 0072431 → 841a8bc → 880fa59`，无 b6acd52）
- 代码库**从未存在** `forceFullRepaint`/`force:true`/`needsFullRepaint` 符号（`git log -S` 返回空）
- b6acd52 是多部分 commit，包含 4 个无关关键修复（mouse-tracking leak、alt-screen 1049 wrap、new-window routing、pendingCreateWindowAt），**严禁 revert**

**因此 bug 3 修复必须是增量式**（在 canvas-renderer resize 增加 wiped 返回值 + terminal.ts 新增 forceFullRepaint 方法），不是 revert 任何历史 commit。`useTerminalResize.ts:257-275` 当前走 `term.refresh()`（只是 `render()` 别名），缺 force-full 语义——但这不是回归，是原本就缺的能力。

**触发条件**：推测是 dpr 变化（浏览器 Cmd+/- 缩放、显示器切换、macOS 显示缩放）最可能；备选 cols/rows 变化（真实 resize）和标签页可见性切换（rAF 暂停）。Wave 0 必须先加诊断日志确认。

**推荐方案**：A（`resize()` 返回 `wiped` boolean，render 据此强制 `effectiveDirty='full'`，必做）+ B（`terminal.ts` 加 `forceFullRepaint()`，viewport restore 调用替代 `refresh()`）。

## bug 4：中文 IME 快速输入出现空白

**置信度：中**（4 候选，建议先验证 C）

| 候选 | 概率 | 位置 | 描述 |
|---|---|---|---|
| **C（最高杠杆）** | ~15% | `packages/ghostty-terminal/src/terminal.ts:1405-1417` | `syncTextareaPositionToCursor` 在 IME composition 期间创建**全新** renderState 调 `updateRenderState`（line 1409），与主 `render()`（line 1450 在持久 renderState 上）走相同 WASM 绑定 → Ghostty 是 per-terminal 消费型 → rAF render 看到 `dirty='clean'` 漏画 |
| A | ~45% | `terminal.ts:1054-1072, 1074-1124, 1150-1175` | compositionend/input/beforeinput 去重时序竞态，`lastCompositionCommit` 40ms 窗口 + compositionstart 立即清零可能丢字符或重复 emit |
| B | ~35% | `apps/gateway/src/tmux-client/local-external-connection.ts:265-281` + `pane-stream-parser.ts:212-456` | sendInput 串行化 + tmux %output UTF-8 字节拆包（parser 不检测 UTF-8 边界） |
| D | ~5% | `vendor/ghostty/src/terminal/render.zig:475` | Ghostty 内核 row.dirty 不重置（.wasm 是预构建二进制，重建需用户确认） |

**候选 C 已被 Metis 代码强验证**：`syncTextareaPositionToCursor` 调 `updateRenderState` 会消费全局 dirty。**修复已就绪**：line 1454 已缓存 `this.lastCursor = meta.cursor`。`syncTextareaPositionToCursor` 应改读 `this.lastCursor` 而非重调 `updateRenderState`（加 null-guard，首次渲染前是 undefined）。

**推荐方案**：C1（`syncTextareaPositionToCursor` 改读 `this.lastCursor`），可能同时缓解 bug 3；不足时再补 A/B。

## 跨 bug 关键关联

- **bug 3 主因（#1 canvas-renderer resize+dirty）与 bug 4 独立**
- **bug 4 候选 C = bug 3 根因 #3**（同一 mechanism：`syncTextareaPositionToCursor` 调 `updateRenderState` 消费 dirty）—— 最高杠杆修复点，C1 可能同时修两者残留
- bug 1 / bug 2 与其他 bug 机制独立
- bug 2 是数据流/路由问题；bug 1/3/4 是前端渲染/坐标问题
- 与 issue41 修复（`2026063000-issue41-output-stall`）无机制重叠（issue41 是 gateway 输出卡死，本 bug 是前端 canvas 渲染失步）

## 实施顺序建议（按证据强度 + 杠杆）

1. **bug 2 方案 A+B**（gateway 路由修复 + 前端 select 守卫）——证据最强，必修
2. **bug 3 方案 A+B**（canvas-renderer resize 返回 wiped + forceFullRepaint）——主因清晰，零副作用
3. **bug 4 根因 C 验证 + 修复 C1**（`syncTextareaPositionToCursor` 不调 `updateRenderState`）——最高杠杆，可能同时修 bug 3 残留
4. **bug 1 Playwright 动态诊断 → 决定方案**——先确诊候选 ①/③，再实施

## 测试策略

- TDD（RED-GREEN-REFACTOR）适用于 bug 2/3/4-C（根因已确认）
- bug 1 诊断优先（根因确定后再 TDD）
- bug 4 候选 A/B/D 作为 fallback，仅当 C1 不足时启动
- 所有 e2e 必须在 worktree dev 实例（端口 19663/19883）+ 独立 tmux socket `tmux -L tmex-e2e` 上跑
- 严禁触端口 9883 / `~/Library/Application Support/tmex/` / 默认 socket 上的 tmex session
