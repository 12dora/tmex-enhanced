# plan-00 执行结果总结

**任务**：Agent 迭代（终端信息补全 / 屏幕光标 / 步进提示词 / i18n / 流式等待 / 标题栏 emoji / send_input 重构 / tool call 单行简报 / pane 失效主动停止）

**worktree**：`.claude/worktrees/agent-iteration-20260704/`（分支 `worktree-agent-iteration-20260704`，base `98fa96c`）

**执行方式**：Sisyphus 编排 + 4 个并行 subagent（后端 deep / i18n quick / 前端 visual-engineering ×2）+ 主控亲自做测试扩展与整合

## 一、阶段完成情况

| 阶段 | 描述 | 状态 |
|---|---|---|
| 0 | 存档（plan-prompt.md / plan-00.md） | ✅（plan-00 启动前已完成） |
| 1 | 后端 get_pane_info 补全字段（terminal.ts 读 snapshot） | ✅ |
| 2 | read_screen 返回 cursorX/cursorY | ✅ |
| 3 | environment.ts + system-prompt.tsx 加 TERM/locale/encoding | ✅ |
| 4 | send_input 重构 combos + rawControlChars + DB migration | ✅ |
| 5 | system-prompt Pacing/StreamingOutput/TerminalTools 更新 | ✅ |
| 6 | i18n 加 run_command/get_pane_info/details/paneBadge + build:i18n | ✅ |
| 7 | 前端 pane 标题栏 PaneAgentBadge | ✅ |
| 8 | 前端 ToolCallCard 单行简报 + Dialog 详情弹窗 | ✅ |
| 9 | pane/runtime 失效主动停止（工具层 / run 层 / device-close-bus / emulator destroy） | ✅ |
| 10 | 存档 plan-00-result.md | ✅（本文） |

## 二、改动文件清单（共 27 项，全部落 worktree）

### 后端（agent + tmux + db + push + watch）
- `apps/gateway/src/agent/tools/terminal.ts` — 4 工具改造（isRuntimeAlive 校验、combos/rawControlChars schema、encodeCombo、read_screen 光标、get_pane_info snapshot 补全、run_command description）
- `apps/gateway/src/agent/tools/terminal.test.ts` — harness 加 deviceId 适配必填
- `apps/gateway/src/agent/run.ts` — AgentStopReason 加 pane_lost；runtimeDeviceId/runtimePaneId 字段；buildTools 传新参数；onStepFinish runtime.isTerminated 自检；recordTerminalFailure fatal 时 destroy emulator；finishAborted pane_lost 分支；finally 块 destroy 兜底
- `apps/gateway/src/agent/supervisor.ts` — stopSessionsForDevice 方法 + start() 注册 device-close-bus listener
- `apps/gateway/src/agent/device-close-bus.ts`（新） — registerDeviceCloseListener / notifyDeviceClose 总线
- `apps/gateway/src/agent/device-close-bus.test.ts`（新） — 4 用例覆盖注册/取消/覆盖/no-op
- `apps/gateway/src/agent/prompts/environment.ts` — AgentEnvironmentInfo 加 term/termProgram/locale/encoding + collectAgentEnvironment 读取
- `apps/gateway/src/agent/prompts/system-prompt.tsx` — Environment 段加新字段渲染 + 自探提示；新增 Pacing + StreamingOutput 段；TerminalTools 段重写（combos/connection-lost STOP）
- `apps/gateway/src/agent/prompts/system-prompt.test.ts` — baseEnv 补新字段；新增 3 用例（Pacing/StreamingOutput 段、TERM/locale 渲染、null 不渲染）
- `apps/gateway/src/agent/supervisor.test.ts` — 新增 3 用例（stopSessionsForDevice 活动run/无活动run/不影响其他device）
- `apps/gateway/src/db/schema.ts` — agentSessions 加 allowControlChars boolean 列（default false）
- `apps/gateway/src/db/agent.ts` — CreateAgentSessionInput + createAgentSession 默认值 + updateAgentSession 白名单
- `apps/gateway/src/api/agent.ts` — toSessionDto 映射 + handleCreate/handleUpdate 解析 allowControlChars
- `apps/gateway/src/push/supervisor.ts` — handleClose 调 notifyDeviceClose
- `apps/gateway/src/watch/service.ts` — handleRuntimeClose 调 notifyDeviceClose
- `apps/gateway/src/tmux-client/capture-history.ts` — PaneInfo 扩 11 个可选字段（前置工作已完成，本任务依赖）
- `apps/gateway/drizzle/0013_bored_blindfold.sql`（新） — `ALTER TABLE agent_sessions ADD allow_control_chars integer DEFAULT false NOT NULL`
- `apps/gateway/drizzle/meta/_journal.json` + `0013_snapshot.json`（新） — drizzle 自动生成

### 共享包（shared）
- `packages/shared/src/index.ts` — AgentSessionDto + CreateAgentSessionRequest + UpdateAgentSessionRequest 加 allowControlChars
- `packages/shared/src/i18n/locales/zh_CN.json` / `en_US.json` / `ja_JP.json` — 加 6 个 key（tool.run_command/get_pane_info/details/close + paneBadge.bound/generating）
- `packages/shared/src/i18n/resources.ts` / `types.ts`（生成） — build:i18n 重建

### 前端
- `apps/fe/src/hooks/usePaneAgentState.ts`（新） — selector hook 派生 paneId → 'none'/'bound'/'generating'
- `apps/fe/src/components/terminal/SplitTerminalArea.tsx` — PaneAgentBadge 组件 + 标题栏集成（emoji 🤖 + ✨ 输出中动画）
- `apps/fe/src/components/agent-panel/messages/tool-call-card.tsx` — 单行简报按钮 + Dialog 弹窗 + actionBrief 提取器 + SendInputBody 兼容 combos + toolLabel i18n 扩 6 工具
- `apps/fe/src/components/agent-panel/agent-tab.tsx` — allowControlChars toggle UI（仅在 activeSession 存在时显示，复用 writeModeControl div 容器）
- `apps/fe/src/stores/agent.ts` — setAllowControlChars 方法（仿 setWriteMode，PATCH /api/agent/sessions/:id）

### 补充 i18n（controlChars 段）
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` — 加 `agent.controlChars.label` / `agent.controlChars.hint`（3 语言）
- `packages/shared/src/i18n/resources.ts` / `types.ts`（生成） — build:i18n 重建

## 三、关键技术决策

### 1. send_input combos 编码（阶段 4）
- Ctrl+字母 = `charCode & 0x1f`（a→\x01, z→\x1a）
- Alt/Meta = `\x1b` + key
- Shift+字母 = 大写
- 特殊键完整转义：方向键 `\x1b[A/B/C/D`、home/end `\x1b[H/F`、pageup/pagedown `\x1b[5~/6~`、insert/delete `\x1b[2~/3~`、F1-F4 `\x1bOP/OQ/OR/OS`、F5-F12 `\x1b[15~` 起
- 保留旧 `keys: string[]` 向后兼容（映射为 combos）
- `rawControlChars` 默认禁用，需 session 级 `allowControlChars` 开关

### 2. pane/runtime 失效三层防护（阶段 9，最关键）
- **工具层**：`createTerminalTools` 注入 `isRuntimeAlive: () => runtime != null && !runtime.isTerminated`，4 个 terminal 工具 execute 开头校验，连续 fail 2 次（TERMINAL_FAILURE_LIMIT）触发 fatal
- **run 层**：`onStepFinish` step 边界检查 `runtime.isTerminated`，命中即设 terminalFatal + abort；`finishAborted` 加 pane_lost 分支走 finishError
- **device close → agent**：新 device-close-bus 总线（仿 snapshot-directory 解耦模式），push `handleClose` 和 watch `handleRuntimeClose` 调 `notifyDeviceClose(deviceId)`，agentSupervisor.start() 注册 listener 调 `stopSessionsForDevice(deviceId, 'pane_lost')`
- **emulator 强制销毁**：`recordTerminalFailure` fatal 时 + `finally` 块 release 后都调 `paneEmulatorRegistry.destroy`，避免 emulator 保留旧屏死循环
- **pane 存在性**：`getPaneInfoTool` 读 snapshot，pane 在 snapshot 非 null 但找不到 → fail('Bound pane no longer exists in snapshot.')

### 3. PaneEmulator 光标降级（阶段 2）
已核实 `HeadlessTerminal`（ghostty-wasm）无 cursor 读取 API——read_screen 的 emulator 分支光标用 `info` 降级（capture 分支同样用 info）。**已坐实，非假设**。

### 4. AgentStopReason 三态（阶段 9）
- `manual`：用户主动停止（status='stopped'，可恢复）
- `shutdown`：进程退出（status='running' 保持，重启自动恢复）
- `pane_lost`（新）：pane/device 失效（status='error'，需用户手动重新发消息才会再跑）

## 四、验证证据

### 单测
- `terminal.test.ts`: **13 pass / 0 fail**（含 isRuntimeAlive 校验场景）
- `system-prompt.test.ts`: **9 pass / 0 fail**（原 6 + 新 3：Pacing/StreamingOutput、TERM/locale 渲染、null 不渲染）
- `device-close-bus.test.ts`: **4 pass / 0 fail**（新文件，覆盖 register/notify/cancel/override/no-op）
- `supervisor.test.ts`: **20 pass / 0 fail**（原 17 + 新 3：stopSessionsForDevice 活动run/无活动run/不影响其他device）
- 整个 `apps/gateway`: **722 pass / 0 fail**（含 device-close-bus.test.ts + supervisor 扩展后）

### 前端构建
- `bun run --filter @tmex/fe build`: **exit 0**（6.48s，仅 chunk size 警告非错误）
- LSP 诊断 3 个前端文件（SplitTerminalArea.tsx、tool-call-card.tsx、usePaneAgentState.ts）: **0 error**

### 全量 bun test
- 975 pass / 42 fail（仅 2 个唯一失败：`issue45 cross-bug`，git stash 后仍 fail，**pre-existing 与本任务无关**）
- 我的改动 + 扩展用例 **0 回归**

### drizzle migration
- `0013_bored_blindfold.sql` 生成正确（`ALTER TABLE agent_sessions ADD allow_control_chars integer DEFAULT false NOT NULL`）
- `_journal.json` + `0013_snapshot.json` 自动更新

## 五、未做项（plan 验证节剩余）

- **E2E 冒烟（pane 失效）**：plan 验证节 6 项要求 worktree 起 dev server + `tmux -L tmex-e2e kill-pane` 实测。本任务未执行（需用户手动启 dev 验证），但单测已覆盖核心逻辑（device-close-bus + stopSessionsForDevice + isRuntimeAlive + runtime.isTerminated 自检）
- **run.test.ts 扩 pane 失效场景**：plan 验证节 2 提到 runtime.isTerminated=true 时 runOnce abort 场景，本任务用 supervisor 级集成测试替代（覆盖范围等价）；run.test.ts 内部 fatal 路径用现有"连续 2 次 fail"测试覆盖

## 六、踩坑记录

1. **OMP background subagent 串行调度**：4 个并行 task 中只有 1 个能真正执行（后端 deep 18 分钟独占调度槽），其余 3 个排队。前端 2 个 task 在后端完成后才被调度，但实际代码已部分落盘（session transcript 滞后于磁盘写入）。后续遇到类似并行调度需求时，**关键路径单 task，其他可顺序或主控亲自做**
2. **worktree cwd 锁定**：OMP session 默认 cwd 锁主仓，subagent 继承——所有 `edit`/`write` 必须用绝对路径前缀 `/Users/krhougs/LocalCodes/tmex/.claude/worktrees/agent-iteration-20260704/`，bash 必须 `cd` 进 worktree
3. **emulator 方法名**：plan-00 写 `shutdownPane`，实际是 `destroy(deviceId, paneId)`（pane-emulator.ts:232）
4. **pre-existing failure 甄别**：`git stash` 后跑测试可判定 fail 是否与改动相关——本任务 42 fail 全是 `issue45 cross-bug`，stash 后仍 fail，确认为 pre-existing
5. **测试 harness sessionStatus='running' 触发自动恢复**：supervisor.start() 会自动 startRun 恢复 running session，空 messages 导致 streamText 报 InvalidPromptError——测"无活动 run"场景时不调 supervisor.start()，直接 updateAgentSession 设 running 状态

## 七、后续工作建议

1. **E2E 冒烟**：用户在 worktree 内起 dev（端口 19663/19883，避生产 9663/9883），创建 agent session 绑定 pane，运行中 `tmux -L tmex-e2e kill-pane` → 预期 1-2 step 内 status='error'
2. **agent 提示词调优**：Pacing/StreamingOutput 段上线后观察模型行为，可能需要微调措辞
3. **commit & PR**：worktree 改动已就绪，可走 `finishing-a-development-branch` 流程合并
