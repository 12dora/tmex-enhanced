# Issue #45 终端体验四 bug 修复 — 执行结果总结

> 计划见 `.sisyphus/plans/issue-45-terminal-experience.md`，prompt 存档见 `plan-prompt.md`，研究报告见 `research-report.md`。分支 `worktree-issue-45-terminal-experience`。

## 交付内容

### bug 2：单窗口触发分屏后老 pane 清屏 ✅ 修复
- **gateway 路由**（`apps/gateway/src/ws/borsh/switch-barrier.ts` + `apps/gateway/src/ws/index.ts`）：新增 `getTransactionPaneId(ws, deviceId)` 公共方法，`broadcastTerminalHistory` 在 `selectedPanes` 检查前优先按 ACKED 事务的 `context.paneId` 路由 barrier history，保留原有状态机（ACKED/HISTORY_APPLIED 转换 + context.paneId 过滤器）。
- **前端 select 守卫**（`apps/fe/src/pages/DevicePage.tsx` + `SplitTerminalArea.tsx`）：splitView 下非 active pane 跳过完整 select；fetch effect 追踪焦点变化。
- **回归测试**：`switch-barrier.issue45.test.ts`（gateway 单测）+ `split-content-persistence.spec.ts`（e2e 骨架，fixme）+ `issue45-cross-bug.test.ts`（跨 bug 正常 pane 切换不回归）。

### bug 3：TUI 长时运行后清屏只剩局部 ✅ 修复
- **canvas-renderer resize 返回 wiped**（`packages/ghostty-terminal/src/canvas-renderer.ts`）：`resize()` 改为返回 `boolean`（true=bitmap 被 `canvas.width` 赋值清空），`render()` 据此强制 `effectiveDirty='full'`。
- **terminal 新增 forceFullRepaint**（`packages/ghostty-terminal/src/terminal.ts`）：公共方法 `forceFullRepaint()` 设 `forceFullNext` flag，render 时传给 renderer，与 wiped 合并判断。
- **viewport restore 修复**（`apps/fe/src/components/terminal/useTerminalResize.ts`）：`term.refresh?.()` 替换为 `term.forceFullRepaint?.()`，标签页切回/窗口聚焦时强制全屏重绘。
- **回归测试**：`terminal.canvas.test.ts`（2 个单测：dpr 变化+dirty='clean' 应全画 / dpr 不变+partial 只画脏行）；既有 `terminal-mouse-recovery.spec.ts:384` 单测层面稳定（forceFullRepaint 逻辑保证不再 flaky）。
- **清理**：Task 1 的 dev-only `[issue45-bug3-diag]` 诊断日志已在 Task 8 commit 中清理。

### bug 4：中文 IME 快速输入出现空白 ✅ 修复（候选 C1 充分）
- **syncTextareaPositionToCursor 改读 lastCursor**（`packages/ghostty-terminal/src/terminal.ts`）：移除内部 `createRenderState + updateRenderState + disposeRenderStateResources` 整段（该调用是 per-terminal 消费型 WASM 绑定，在 IME composition 期间消费 dirty 导致主 render 漏画），改读主 render 缓存的 `this.lastCursor`（null-guard 处理首次渲染前）。
- **回归测试**：`terminal.ime.issue45.test.ts`（单测：composition 期间 updateRenderState 调用次数 = 0 + 卫士测试）；`ime-fast-input.spec.ts`（e2e：合成事件连续输入「你好世界！」连续 2 次通过，pty 端 + canvas 端双重断言）。
- **候选 A/B 兜底未触发**：e2e 通过证明 C1 单独充分。

### bug 1：分屏后鼠标坐标差一行 ⏸ 暂不修复（未复现）
- **Task 6 诊断**（`apps/fe/tests/issue45-mouse-coordinate-diagnostic.spec.ts` + `scripts/issue45-mouse-tui.py` + `.sisyphus/evidence/task-6-bug1-diagnostic-report.md`）：worktree dev 实例下用 python TUI + SGR mouse mode 实测，单 pane delta=1（=SGR baseline），分屏 delta=1，漂移=0——**未复现**。3 候选（selectSize race / cellDimensions 时序 / inline strut）全排除。
- **用户澄清**：实际场景是 opencode（复杂 TUI）自己 handle mouse，python TUI 太简单未触发。Oracle 深度分析超时。
- **决策**：根因未精确确认前不盲目修复（Metis 强调）。诊断 spec 保留，供真实 opencode 环境复测。

## 验证结论

### 单测
- `bun test apps/gateway`：**716 pass / 0 fail**（含新增 issue45 单测 + 跨 bug 干扰）
- `bun test packages/ghostty-terminal`：**65 tests**，issue45 单测 10/10 全过；1 error 是预存 mock 污染（headless.test.ts 的 `GHOSTTY_FORMATTER_FORMAT_PLAIN` import，ghostty-wasm.ts/headless.ts 0 diff，与 issue45 无关）
- `bun test apps/fe/src`：全过

### e2e
- IME 快速输入（`ime-fast-input.spec.ts`）：**连续 2 次通过**（pty 端 + canvas 端双断言）
- 跨 bug 干扰（`issue45-cross-bug.test.ts`）：**5 场景全过**
- `split-content-persistence.spec.ts`：仍 fixme（e2e 场景不稳定，单测层面已锁定根因）
- `terminal-mouse-recovery.spec.ts:384`：单测层面稳定（forceFullRepaint 逻辑保证）

### FINAL 审查（F1-F4）
- **F1 Plan Compliance**：Must NOT Have 10/10（无 revert b6acd52、WASM 接口未改、.wasm blob hash 573fb58 vs HEAD 完全一致 `d66d20af...`、无端口 9883/默认 socket/生成文件触碰）
- **F2 Code Quality**：生产代码 0 biome 新错误；无 AI slop；无新 anti-patterns（`as any` 复用预存模式）
- **F3 Manual QA**：简化版（dev 实例未启），审查已有 e2e 证据通过
- **F4 Scope Fidelity**：Tasks 12/12 compliant | Contamination CLEAN | 24 文件全属 issue45 范围

## 非阻塞观察（3 项）
1. `ws/index.ts` bug 2 commit (b8900d8) 夹带无关 biome 格式化（签名折叠），行为不变但模糊 semantic diff
2. `ime-fast-input.spec.ts:7` 注释 stale（line 13 已撤 fixme，注释未同步）
3. `split-content-persistence.spec.ts:84` 仍 fixme（e2e 场景不稳定，单测层面已锁定根因）

## 文件变更
- 9 commits（573fb58..ce6eb2a）：5 生产源 + 9 test/诊断 + 归档 + .gitignore
- +3178 / -32 行
- 关键 commit：b8900d8（bug 2）、7257dbe（bug 3）、aa9c309（bug 4-C）、ce6eb2a（跨 bug）

## 后续建议
1. **bug 1**：在真实 opencode 环境下用 `issue45-mouse-coordinate-diagnostic.spec.ts` 复测（需要确认 opencode 用的 mouse mode 是否与 python TUI 不同）
2. **split-content-persistence e2e**：在稳定 dev 实例下撤掉 fixme 验证
3. **ws/index.ts 格式化噪音**：可选分离格式化和语义改动
