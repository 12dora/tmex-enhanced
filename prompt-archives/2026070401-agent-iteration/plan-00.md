# Agent 迭代：终端信息补全 / 屏幕尺寸光标 / 步进式提示词 / i18n / 流式等待 / 标题栏 emoji / send_input 重构 / tool call 单行简报 / pane 失效主动停止

## Context

用户提出 9 项对 agent（tmex 终端助手）的迭代需求：补全「获取终端信息」工具字段、`read_screen` 返回尺寸+光标、提示词加入「一步一步执行+危险操作心智+流式等待」、补全 tool call i18n、引导模型等待流式输出、pane 标题栏显示绑定 agent emoji（区分输出中）、`send_input` 重构支持 modifier+任意键/控制字符（带安全开关）/编码兼容性检查、提示词同步上述工具说明、前端 tool call 改单行简报+点击弹窗看详情，以及 **ssh/tmux session 被外部杀掉等 pane 失效场景下 agent 必须主动停止而非不停尝试交互**。

最终效果：agent 对终端的感知更完整、操作更稳健可观测、pane 失效时快速停止、前端更紧凑且能看清工具详情。

## 关键事实（已核实）

- 后端工具注册：`apps/gateway/src/agent/run.ts:624-667 buildTools` 调 `createTerminalTools`（`apps/gateway/src/agent/tools/terminal.ts:90`）注册 `read_screen`/`send_input`/`get_pane_info`/`run_command`；`web_search`/`fetch_url` 来自 `tools/web.ts`。
- `get_pane_info` 工具（terminal.ts:234-254）当前返回 `PaneInfo`（cols/rows/cursorX/cursorY/alternateScreen/currentCommand）+ capturedAt，**不含** title/path/session/window/分屏。`PaneInfo` 定义在 `apps/gateway/src/tmux-client/capture-history.ts:36-43`，由 `PANE_META_FORMAT`（:46）解析。
- `read_screen`（terminal.ts:99-147）已返回 cols/rows/alternateScreen/capturedAt，**不含** cursorX/cursorY。
- `send_input`（terminal.ts:149-232）仅支持 `text`(string) + `keys`(enum `SEND_INPUT_KEYS`，13 个：enter/tab/escape/backspace/arrow/ctrl_c/ctrl_d/ctrl_z/ctrl_l/ctrl_u)，无 modifier 组合、无控制字符直发、无编码检查。`KEY_SEQUENCES`（:42-56）硬编码转义序列。底层 `sendInput`（local-external-connection.ts:265 / ssh-external-connection.ts:170）走 `tmux send-keys -H` hex，已按 UTF-8 编码（input-encoder.ts）。
- `run_command`（terminal.ts:256-318，执行体 run-command.ts:141-320）：发命令后 poll，已处理 `--More--` 续翻、alternate 进入 TUI、expect 早退、超时。run_command 本身同步等到完成；「等待流式」问题在**模型连续发起多个 run_command 调用**时，靠提示词约束。
- system prompt：`apps/gateway/src/agent/prompts/system-prompt.tsx`，组件式组装（Doc/Section/Item）。段落：Identity / Environment / RealEnvironment / WindowSize / TerminalTools / NetworkDevices / CodingAgents / UntrustedContent / Credentials / Intent / Safety / General / Custom。`TerminalTools`（:91-130）讲工具用法。无「一步一步」「不要塞一堆命令」「等待流式」「控制字符安全」段落。
- `environment.ts`（:8-42）注入 deviceName/deviceType/host/username/port/tmuxSession/timezone/nowIso/gatewayOs/gatewayShell。**缺** locale/encoding/TERM。
- tmux snapshot（snapshot-format.ts）`PANE_SNAPSHOT_FORMAT` 已采集 `pane_title`/`pane_current_command`/`pane_current_path`；`StateSnapshotPayload.session.windows[].panes[]`（shared/index.ts:421-443 TmuxPane）含 title/customName/currentCommand/currentPath/width/height/left/top。分屏可由 `window.panes.length` 或 `window.layout` 判定。
- 设备类型：DB `devices.type`('local'|'ssh')（schema.ts:67），已在 environment。
- **snapshot 缓存查询已存在**：`apps/gateway/src/tmux/snapshot-directory.ts` 的 `getDeviceSnapshot(deviceId): StateSnapshotPayload | null`（全局注册表，run.ts:42 已 import）。`get_pane_info` 可直接读缓存拿 title/path/window/session/分屏，无需新增 runtime 方法或新发 tmux 命令。
- TERM/encoding/locale：tmux `set-environment` 注入 `TERM_PROGRAM=ghostty`+`COLORTERM=truecolor`（local-external-connection.ts:586-609），是 gateway 注入值，非 pane 实际 `$TERM`/`$LANG`。**决策：locale/encoding/TERM 作为「设备/入口主机维度」从 gateway 进程侧 `process.env` 注入 prompt 与工具返回，pane 级真实值靠 prompt 引导 agent 自探（已有 RealEnvironment 段）。**
- **PaneEmulator 无 cursor 读取 API**：`packages/ghostty-terminal/src/headless.ts` 的 `HeadlessTerminal` 仅暴露 `render()/size()/resize()/isAlternateScreen()`，ghostty-wasm.ts 无 readCursor 接口。故 `read_screen` 的 emulator 分支光标返回 null，仅 capture 分支用 `info` 取光标。
- 前端 tool call 渲染：`apps/fe/src/components/agent-panel/messages/tool-call-card.tsx`，卡片式（`ToolCallCard` L298-391），每个 tool 有专用 body（SendInputBody/ReadScreenBody/WebSearchBody/FetchUrlBody/GenericBody）。返回值用 `CollapsedText`（L71-85）折叠 `<pre>`，无 modal。可复用 `apps/fe/src/components/ui/dialog.tsx`（Dialog/DialogContent/...，基于 @base_ui/react）。
- 前端 i18n tool key：`packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` `agent.tool.{send_input,read_screen,web_search,fetch_url,input,result,screen,denied}`（zh_CN:754-762）。**缺** `run_command`/`get_pane_info`。tool-call-card.tsx:307-309 仅 4 个工具走 `t()`，其余 raw 名。i18n 由 `packages/shared/scripts/build-i18n.ts` 从 JSON 生成 `resources.ts`/`types.ts`（生成文件，禁止手改/lint）。
- pane 标题栏：`apps/fe/src/components/terminal/SplitTerminalArea.tsx:535-575`，显示 `PaneBellIcon`(🔔，bell 时) + `paneDisplayName`(customName||title||'Pane') + `paneMetaText`(command@path) + 关闭按钮。无 agent 绑定状态/emoji。agent 绑定解析在 `agent-tab.tsx:160-198 resolveBinding`，仅用于 sidebar chip，未传到终端区。
- agent 输出状态：`AgentSessionDto.status`（shared/index.ts:782）= `idle|running|waiting_confirmation|stopped|error`。前端 store `useAgentStore.sessions: Record<string, AgentSessionDto>`（agent.ts:71）。`inProgress[sessionId]`（agent.ts:318）有流式 texts/toolCalls。"正在输出"判据：`status === 'running'` 且该 session 绑定该 pane。全局所有 sessions 可遍历 `sessions` map 得到「paneId→session」映射。
- prompt-archives：本任务存档目录 `prompt-archives/2026070401-agent-iteration`，含 `plan-prompt.md`（本 prompt）与 `plan-00.md`（本 plan）、`plan-00-result.md`（执行后）。**AGENTS.md 要求先存档 prompt 再干活——执行阶段第一步必须先建目录+拷贝 prompt。**（plan mode 下无法写非 plan 文件，故执行阶段补做。）
- **pane/runtime 失效保护现状（有缺口）**：`recordTerminalFailure`（run.ts:669-676）在 terminal 工具连续失败 `TERMINAL_FAILURE_LIMIT=2` 次后设 `terminalFatal=true` → abort → finishError。底层：`capturePaneText`/`getPaneInfo` 在 `!connected` 时 throw（local-external-connection.ts:514-515/528-529），pane 被杀时抛 `TmuxTargetMissingError`（target-missing.ts:5，capturePaneText 用 `runTmux(argv,'silent')` :520）。**漏洞 1（emulator 死循环）**：`sendInput` 在 `!connected` 时**静默 return**（local-external-connection.ts:266-268，不抛错）；`read_screen` 的 emulator 分支（terminal.ts:121-130）不调 capture/getPaneInfo 的抛错路径，`emulator.render()` 返回陈旧渲染态 + success（重置 streak）。pane 被杀但 connection 未断时，emulator 保留旧屏 → read_screen success + send_input 静默失败 → 模型看到旧屏反复操作，**永不触发 fatal**。这是「不停尝试交互」的核心场景。**漏洞 2（无 device close → agent 停止）**：push supervisor `handleClose`（push/supervisor.ts:342-358）只通知连接告警 + release runtime + 重连，**不通知 agent supervisor**；agent run 持有的 runtime 底层已断（`DeviceSessionRuntime.terminated=true`，device-session-runtime.ts:104/111-113），但 run.ts 与 terminal.ts **从不检查 `runtime.isTerminated`**。**漏洞 3（pane 在 snapshot 消失无感知）**：snapshot 周期刷新，pane 被杀后 snapshot 里该 pane 消失，但 agent 工具不读 snapshot 校验 pane 存在性（get_pane_info 新阶段会读 snapshot，可顺带校验）。
- `paneEmulatorRegistry.shutdownPane(deviceId, paneId)`（pane-emulator.ts:231-241）存在但**无调用方**——pane 关闭/runtime 断开时 emulator 不会被强制销毁，只在 run 结束 release（run.ts:404-411）或 LRU 驱逐时 dispose。

## Approach

### 阶段 0：存档（执行第一步）
1. `mkdir -p prompt-archives/2026070401-agent-iteration`，将本对话用户原始 prompt 拷入 `plan-prompt.md`，本 plan 拷入 `plan-00.md`。

### 阶段 1：后端 `get_pane_info` 补全字段（需求 1）
目标：`get_pane_info` 返回终端完整元信息。改 `apps/gateway/src/tmux-client/capture-history.ts` 与 `apps/gateway/src/agent/tools/terminal.ts`，纯读 snapshot 缓存，不新增 runtime 方法。

2. 扩 `PaneInfo`（capture-history.ts:36-43）新增可选字段：`title: string | null`、`currentPath: string | null`、`sessionId: string | null`、`sessionName: string | null`、`windowId: string | null`、`windowName: string | null`、`splitPaneCount: number | null`（同 window pane 数，>1 即分屏）。`cursorX`/`cursorY`/`cols`/`rows`/`alternateScreen`/`currentCommand` 已有。
3. `createTerminalTools` 的 `CreateTerminalToolsOptions`（terminal.ts:66-75）新增 `deviceId: string` 字段；run.ts:628-635 调用处传 `deviceId: session.deviceId!`（runtime && session.paneId 分支里 deviceId 非 null）。
4. `getPaneInfoTool`（terminal.ts:234）执行时：调 `getDeviceSnapshot(options.deviceId)`（从 `../tmux/snapshot-directory` import），遍历 `session.windows[].panes[]` 找目标 pane，取 `pane.title`/`pane.currentPath`/`window.name`/`window.id`/`session.id`/`session.name` 与 `window.panes.length`（splitPaneCount）。合并进 `PaneInfo` 返回。**不新发 tmux 命令**。
5. 工具内读 `process.env.TERM/TERM_PROGRAM/LANG/LC_ALL`，返回 `term`/`termProgram`/`locale`（`LANG ?? LC_ALL`）/`encoding: 'utf-8'`，标注为「entry-host/gateway 侧值，pane 实际值需自探」。
6. 更新 `getPaneInfoTool` 的 `description`（terminal.ts:235）说明返回字段。
7. 失败/缺失处理：snapshot 不可用或 pane 找不到时新字段返回 `null`，不 throw（沿用 `fail()`）；`getDeviceSnapshot` 返回 null 时新字段全 null。

### 阶段 2：`read_screen` 返回尺寸+光标（需求 2）
8. 改 `readScreen`（terminal.ts:99-147）返回值新增 `cursorX`/`cursorY`。emulator 分支（:121-130）：emulator 无 cursor API → `cursorX: info?.cursorX ?? null`、`cursorY: info?.cursorY ?? null`（info 由 `runtime.getPaneInfo` 取，capture 分支同样用 info）。两分支都加 `cursorX`/`cursorY`。

### 阶段 3：prompt 注入终端环境信息补全（需求 1 的 prompt 侧）
9. 改 `apps/gateway/src/agent/prompts/environment.ts`：`AgentEnvironmentInfo`（:8-20）新增 `term: string | null`、`termProgram: string | null`、`locale: string | null`、`encoding: string | null`（'utf-8'）。`collectAgentEnvironment`（:22-42）从 `process.env.TERM/TERM_PROGRAM/LANG/LC_ALL` 读取（local 设备直接读；ssh 设备这些是 gateway 侧值，设为 null 并由 prompt 说明是入口主机值）。
10. 改 `system-prompt.tsx` 的 `Environment`（:29-53）渲染新字段：`Terminal: {env.term}` / `Locale: {env.locale}` / `Encoding: {env.encoding}`，仅在非 null 时渲染，加一句「这些是入口主机（tmex gateway）侧的值，pane 实际可能不同——用 `get_pane_info` 或自探确认」。

### 阶段 4：send_input 重构（需求 6）
11. 重构 `SEND_INPUT_KEYS`/`KEY_SEQUENCES`（terminal.ts:24-56）为 **modifier+key 组合模型**。新输入 schema：
    - `text?: string`（保留，UTF-8 文本，max 16384）
    - `combos?: Array<{ modifiers?: string[]; key: string }>` —— `modifiers` 枚举 `['ctrl','alt','meta','shift']`（可多选），`key` 枚举所有可发按键：单字符 a-z/0-9/符号、`enter`/`tab`/`escape`/`backspace`/`space`/`up`/`down`/`left`/`right`/`home`/`end`/`pageup`/`pagedown`/`insert`/`delete`/`f1`-`f12`。
    - `rawControlChars?: string`（**新**，默认禁用，需 session 级开关开启才接受）—— 允许发送任意控制字符（C0）。**安全**：后端校验该 session 的 `allowControlChars`（新增 schema 字段 `agent_sessions.allowControlChars integer boolean default false`，migration）；关闭时该参数被工具拒绝并返回提示。前端 agent UI 提供开关；prompt 强调仅必要时使用。
    - 保留向后兼容：旧 `keys: string[]` 形式映射为 `combos`（grep 确认仅前端 tool-call-card 展示，无其他后端消费）。
12. 实现组合编码 `encodeCombo({modifiers, key})` 生成 ANSI 序列：Ctrl+字母 = `String.fromCharCode(key.charCodeAt(0) & 0x1f)`（a→\x01）；Alt+键 = `\x1b`+key；Meta = `\x1b`+key 或平台特有；Shift+字母 = 大写；方向键 `\x1b[A` 等；功能键 `\x1bOP`(F1)~`\x1b[24~`(F12)。参考 `packages/ghostty-terminal/src/ghostty-keycodes.ts`（执行时核实）。给出完整映射表实现。
13. 编码兼容性检查：`TextEncoder.encode()` 得 UTF-8 字节；tmux send-keys -H 已按 UTF-8 hex，tmux 自身按 locale 解释——**后端只保证 UTF-8 输出，编码兼容性靠 prompt 提示 agent 先 `locale` 自探，工具不阻断**（避免过度工程）。检测到 surrogate/孤立代理时返回 warning。
14. 安全开关 UI（阶段 7 前端）：agent session 设置加 `allowControlChars` toggle。

### 阶段 5：prompt 步进/危险/流式等待/工具说明更新（需求 3、5、7）
15. 新增段落 `Pacing`（system-prompt.tsx，插在 `Safety` 后）：
    - 「一次只做一步：发起一个操作后等结果，再决定下一步。不要在一次回复里塞多个 run_command/send_input。」
    - 「终端可能正在执行生产相关、不可逆的危险工作。每一步都先说明你打算做什么、为什么，执行后报告结果与当前状况，让用户能及时纠偏。」
    - 「考虑用户的心智与心情：危险/破坏性操作前用平实语言说明风险并等明确确认；不要让用户在不知情时承担后果。」
16. 新增段落 `StreamingOutput`（插在 `TerminalTools` 后）：
    - 「当需要连续多个 run_command 时，若上一条命令可能仍在流式输出（如 `tail -f`、`build`、`watch`），先 read_screen 确认是否回到提示符/完成，不要抢着发下一条。」
    - 「run_command 会等到命令完成或超时；若 status='timeout' 或输出仍在增长，用 read_screen 复核再决定。」
17. 更新 `TerminalTools`（:91-130）：
    - `send_input` 说明改为支持 modifier+key 组合与（开启时）控制字符，强调控制字符仅必要时用、有安全开关。
    - `get_pane_info` 说明改为返回完整元信息（含 title/path/session/window/分屏/入口侧 TERM/locale/encoding）。
    - `read_screen` 说明加「含尺寸 cols/rows 与光标位置 cursorX/cursorY」。
    - `run_command` description（terminal.ts:257）补一句：「For long-running streaming commands (`tail -f`, `watch`, `top`, `npm run dev`) do NOT use run_command — it blocks until completion or timeout and will misjudge slow streams as done; use send_input + read_screen instead.」**不改 run_command 执行逻辑**：其完成判定靠 OSC133 标记 / 提示符重现 / 静默 600ms，不读屏渲染态，自身不会因「等待时读屏」而乱；流式长跑命令本就不该用 run_command（会进 TUI 或持续输出），靠描述+提示词引导模型改用 send_input+read_screen。
18. `Environment` 段加 TERM/locale/encoding（阶段 3 已做）。
19. `CodingAgents` 段已有「Never interrupt a generating agent — wait」——与流式等待呼应，不重复改。

### 阶段 6：tool i18n 补全（需求 4）
20. `packages/shared/src/i18n/locales/zh_CN.json` `agent.tool` 加：`run_command`/`get_pane_info`（中文名）；`en_US.json`/`ja_JP.json` 同步。
21. 改 `tool-call-card.tsx:306-309`：把 `['send_input','read_screen','web_search','fetch_url']` 扩为含 `run_command`/`get_pane_info`，其余仍 raw 名。
22. 跑 `bun run build:i18n` 重建 `resources.ts`/`types.ts`（生成文件，禁止手改）。

### 阶段 7：前端 pane 标题栏 agent emoji（需求 5）
23. 新建 selector hook：从 `useAgentStore` 派生「paneId→活跃 session 与输出状态」。判据：遍历 `sessions`，匹配 `session.deviceId === deviceId && session.paneId === paneId && session.status !== 'stopped' && session.status !== 'error'`（即 idle/running/waiting_confirmation 算绑定）；`running` 或 `inProgress[sessionId].texts.length>0 || toolCalls.length>0` = 输出中。
24. 改 `SplitTerminalArea.tsx` 标题栏（:547 附近）：`PaneBellIcon` 旁加 `PaneAgentBadge`：绑定且输出中 = `🤖`(动画/`✨`)；绑定空闲 = `🤖`(静态灰)；无绑定 = 无。i18n tooltip 文案 `agent.paneBadge.bound`/`agent.paneBadge.generating`（加 i18n key，3 语言）。
25. `PaneAgentBadge` 用 selector 选目标 pane 的 session 状态，避免全标题栏重渲染。

### 阶段 8：前端 tool call 单行简报+详情弹窗（需求 8）
26. 重构 `ToolCallCard`（tool-call-card.tsx:298-391）：
    - 默认单行简报：`图标 + tool名(i18n) + 行为摘要(input 关键字段截断) + 状态图标(spinner/check/error/denied)`，**不**展开 input/output。
    - 点击整行 → 打开 `Dialog`（复用 `ui/dialog.tsx`），modal 内展示完整 input（JSON pretty）+ output（按 tool 类型友好渲染：read_screen 的 screen `<pre>`、web_search 结果列表、图片内联等）。modal `max-h-[80vh] overflow-auto`。
    - 审批按钮（pendingApproval）仍在卡片内显示，不进 modal。
    - 错误文本仍在卡片内显示（不进 modal）。
27. 各 tool「行为摘要」提取器：send_input=`text` 前 40 字 + keys badges 数；read_screen=`(screen N rows)`；run_command=`command` 前 60 字；web_search=`query`；fetch_url=`url`；generic=input 前 60 字。
28. modal 内 output 渲染沿用现有 body 组件（SendInputBody/ReadScreenBody/...）但去掉折叠，全展开 + 滚动。
29. i18n key：`agent.tool.details`/`agent.tool.close`（3 语言）。
30. 单行简报样式：紧凑 `h-6`，与现有卡片边框统一，hover 提示可点。

### 阶段 9：pane/runtime 失效主动停止（需求 9，最关键）
目标：pane 被杀、ssh 断开、tmux session 消失等场景下，agent 快速停止 run 并置 error，而非靠失败计数或死循环。三层防护：工具层主动校验、run 层周期性自检、device close 主动通知。

33. **工具层：read_screen/send_input/run_command/get_pane_info 执行前校验 runtime 活性**。在 `createTerminalTools`（terminal.ts:90）注入一个 `isRuntimeAlive: () => boolean` 闭包（run.ts 传入：`() => runtime != null && !runtime.isTerminated`，`TerminalRuntimeLike` 扩展可选 `readonly isTerminated?: boolean`，device-session-runtime.ts 已有 :111-113）。每个 terminal 工具 execute 开头：`if (!options.isRuntimeAlive?.()) return fail('Terminal connection is no longer available.');` —— 这覆盖 emulator 分支（漏洞 1）：即使 emulator 还在，runtime 已 terminated 时直接 fail 并 `recordTerminalFailure`，连续 2 次 fatal。**但单次 fail 仍可能被模型绕过**（改用非 terminal 工具），故必须配合步骤 34。
34. **run 层：周期性 runtime 自检 + pane 存在性校验**。在 `runOnce`（run.ts:423）的 streamText 循环里，每个 step 边界（ onFinish 钩子内、:493 steer 判定旁）加 `if (runtime && runtime.isTerminated) { this.terminalFatal = true; this.terminalFatalMessage = 'terminal connection lost during run'; this.abortController.abort(); }`。**pane 存在性**：在工具层 `getPaneInfoTool`（terminal.ts:234）和 `readScreen` 已读 snapshot（阶段 1 步骤 4 / 阶段 2），若 snapshot 中目标 pane 不存在（遍历后未找到）且 `getDeviceSnapshot` 非 null，视为 pane 已死 → `fail('Bound pane no longer exists in snapshot.')` + `onFailure`（计入 fatal streak）。**不新增 step 边界轮询**：利用已有的 onFinish/streamIdle 机制，在 step 边界检查 `runtime.isTerminated` 即可（streamText 的 onFinish 在每个 step 结束触发，:478-500）。
35. **device close → agent supervisor 主动停止**。push supervisor `handleClose`（push/supervisor.ts:342-358）与 watch `onClose`（watch/service.ts:392）触发时，**通知 agent supervisor 停止该 device 上所有 running session**。实现：在 `AgentSupervisor`（supervisor.ts）新增 `stopSessionsForDevice(deviceId: string, reason: string): void`，遍历 `getAgentSessionsByDeviceAndStatus(deviceId, 'running'|'waiting_confirmation')`，对每个 `requestStop('shutdown')`... 但 shutdown 语义是「进程退出保持 running 等恢复」——这里要的是**error 收尾**。新增 `AgentStopReason = 'manual' | 'shutdown' | 'pane_lost'`（run.ts:260 stopReason 类型，:298 requestStop 入参）：`pane_lost` → `finishError(session, 'terminal connection lost: pane/device unavailable')`，status='error'，不自动恢复。push/watch 的 `onClose` 调 `agentSupervisor.stopSessionsForDevice(deviceId, 'pane_lost')`。**需在 push supervisor 与 agent supervisor 间建立引用**：push supervisor 构造时注入 `onDeviceClose?: (deviceId) => void` 回调，或用全局事件总线（仿 `registerSnapshotLookup` 模式，`apps/gateway/src/agent/` 下新增 `device-close-bus.ts` 的 `registerDeviceCloseListener`/`notifyDeviceClose`）——**优先用后者**（解耦，与现有 snapshot-directory 模式一致）。
36. **emulator 强制销毁**：device close 或 pane 在 snapshot 消失时，调 `paneEmulatorRegistry.shutdownPane(deviceId, paneId)`（pane-emulator.ts:231，已存在无调用方）。在 run 层 `terminalFatal` 触发时（:671-675）调 `paneEmulatorRegistry.shutdownPane(this.runtimeDeviceId!, this.session.paneId!)`，使后续 read_screen 的 emulator 分支 `emulator.isDisposed` 为 true 走 capture 回退（capture 也会 fail）或直接 fail。run.ts:404-411 的 release 块也补调 shutdownPane（兜底）。
37. **提示词**：在 `TerminalTools` 段（system-prompt.tsx:91-130）补一句：「If read_screen/get_pane_info/send_input returns a connection-lost or pane-missing error, STOP immediately — do not retry the same tool; report the situation to the user.」归入阶段 5 步骤 17 一起改。
38. **失败/边界**：runtime.isTerminated 检查可能在 step 中途失效——靠 streamText 的 abortSignal 传播（abortController.abort 后 streamText 抛 abort）。pane 存在性靠 snapshot 刷新延迟（pane 刚死 snapshot 尚未刷新时仍可能读到旧 snapshot 含该 pane）——可接受，下一次工具调用会 fail。`isRuntimeAlive` 为可选（旧测试 stub runtime 无 isTerminated）→ `?.()` 容错返回 true（不阻断测试）。

### 阶段 10：prompt 存档与文档
39. 执行完成后写 `prompt-archives/2026070401-agent-iteration/plan-00-result.md` 总结。
40. 若有架构决策值得记录，写 `docs/agent/2026070401-agent-iteration.md`（背景/设计/验收），否则跳过。

## Critical files & anchors

- `apps/gateway/src/agent/tools/terminal.ts:90-326` — createTerminalTools，所有 4 个工具定义与 send_input 重构核心；阶段 9 步骤 33 注入 isRuntimeAlive。
- `apps/gateway/src/tmux-client/capture-history.ts:36-66` — PaneInfo 接口与 PANE_META_FORMAT，扩字段源。
- `apps/gateway/src/tmux/snapshot-directory.ts:15` — getDeviceSnapshot，get_pane_info 读缓存入口 + 阶段 9 pane 存在性校验。
- `apps/gateway/src/agent/prompts/system-prompt.tsx:91-130` — TerminalTools 段，工具说明更新；新增 Pacing/StreamingOutput 段插入点。
- `apps/gateway/src/agent/prompts/environment.ts:8-42` — AgentEnvironmentInfo 与 collectAgentEnvironment，补 TERM/locale/encoding。
- `apps/gateway/src/agent/run.ts:423-500,669-676` — runOnce/streamText onFinish step 边界（阶段 9 步骤 34 自检点）、recordTerminalFailure fatal 路径（:669-676，步骤 36 shutdownPane 兜底）。
- `apps/gateway/src/push/supervisor.ts:342-358` — handleClose，阶段 9 步骤 35 device close → agent 通知接线点。
- `apps/gateway/src/tmux-client/device-session-runtime.ts:104,111-113` — isTerminated，runtime 活性判据源。
- `apps/fe/src/components/agent-panel/messages/tool-call-card.tsx:298-391` — ToolCallCard，单行简报+modal 重构主战场。
- `apps/fe/src/components/terminal/SplitTerminalArea.tsx:535-575` — 标题栏，插 PaneAgentBadge。
- `packages/shared/src/i18n/locales/zh_CN.json:754-762` — agent.tool i18n，加 run_command/get_pane_info/details。

## Verification

1. **后端单测**：`bun test apps/gateway/src/agent/tools/terminal.test.ts`（扩用例覆盖 get_pane_info 新字段、read_screen 光标、send_input combo 编码、rawControlChars 开关拒绝/通过、isRuntimeAlive 校验：runtime.isTerminated=true 时 4 个工具都 fail）。
2. **pane 失效单测**（阶段 9 专项）：`bun test apps/gateway/src/agent/run.test.ts` 扩用例：(a) runtime.isTerminated=true 时 runOnce 在 step 边界 abort → finishError（status='error'）；(b) pane 在 snapshot 消失时 getPaneInfoTool/readScreen fail + onFailure 计数；(c) device close → agentSupervisor.stopSessionsForDevice → requestStop('pane_lost') → finishError。新增 `apps/gateway/src/agent/device-close-bus.test.ts` 覆盖总线注册/通知。
3. **prompt 快照**：`apps/gateway/src/agent/prompts/system-prompt.test.ts`（已有）扩用例断言 Pacing/StreamingOutput 段存在、Environment 含 TERM/locale/encoding 行（当 env 非空）、TerminalTools 含 connection-lost STOP 提示。
4. **i18n 构建**：`bun run build:i18n` 后 `grep -n run_command packages/shared/src/i18n/resources.ts` 确认生成。
5. **前端**：`bun run --filter @tmex/fe build` 通过；手测起 dev server（worktree 内 `bun run dev`，端口避生产），打开 agent 面板：tool call 单行简报显示、点击弹窗看详情、pane 标题栏 agent emoji 出现/区分输出中。
6. **E2E 冒烟（pane 失效）**：worktree 内起 dev，创建 agent session 绑定某 pane，发一条让模型用 run_command + read_screen 的请求；**在 agent 运行中用 `tmux -L tmex-e2e kill-pane` 杀掉该 pane**，确认 agent 在 1-2 个 step 内停止并 status='error'，而非继续尝试交互。再测：杀掉整个 tmux session（`tmux -L tmex-e2e kill-session`），确认 device close → agent 立即 error。
7. 全量测试：`bun test`（不跑 live integration）。

环境隔离：所有验证在 worktree（`development.env` 端口 19663/19883，显式覆盖 `TMEX_FE_DIST_DIR`/`GATEWAY_PORT`/`TMEX_BIND_HOST`，禁用生产 9883/socket `tmex`）。`bun run dev` 前若需主仓 dev 数据按 AGENTS.md 拷 `tmex.db{,-shm,-wal}`，绝不读生产库。E2E 杀 pane 用独立 tmux socket `tmux -L tmex-e2e`，绝不在默认 socket操作。
## Assumptions & contingencies

- **pane 失效保护语义**：`pane_lost` 作为新 AgentStopReason，区别于 `shutdown`（进程退出保持 running 等恢复）与 `manual`（用户停止）。`pane_lost` 走 finishError，status='error'，需用户手动重新发消息才会再跑（sendMessage 设回 running）。这是有意为之——pane 失效后自动重试无意义（pane 可能已永久消失）。
- **device-close-bus 解耦**：仿 `snapshot-directory.ts` 注册表模式，push/watch supervisor 不直接持有 agent supervisor 引用，通过全局总线 `registerDeviceCloseListener`/`notifyDeviceClose` 解耦。若执行时发现 push supervisor 已持有 agent supervisor 引用，可直连，但默认走总线。

- **PaneEmulator 光标**：已核实 `HeadlessTerminal`（packages/ghostty-terminal/src/headless.ts）无 cursor 读取 API，ghostty-wasm.ts 亦无。read_screen 的 emulator 分支光标返回 null（capture 分支用 info）。已坐实，非假设。
- **snapshot 缓存可用性**：已核实 `getDeviceSnapshot` 全局注册表存在且 run.ts 已 import。`get_pane_info` 读缓存即可，不新发 tmux 命令。已坐实。
- **send_input 旧 `keys` 兼容**：仅前端展示与模型生成路径使用；模型按新 schema（combos）生成，旧 `keys` 形式后端兼容映射为 combos（执行阶段 grep 确认无其他后端消费 `keys`）。前端 tool-call-card 的 SendInputBody 改读 `combos`（兼容 `keys`）。
- **控制字符安全开关存储**：新增 `agent_sessions.allowControlChars` 列（migration）。若 migration 风险大，备选：复用 `writeMode='confirm'` 作为代理开关——但语义不精准。**默认加 DB 字段**；若用户偏好不加，退回备选并在 plan-00-result 注明。
- **标题栏 emoji 选取**：默认 `🤖`（绑定）+ 动画（输出中）。若用户偏好其他符号，执行时按现有 `🔔` bell 风格保持一致即可。
- **modal 复用**：直接用 `ui/dialog.tsx`，不新建组件。
- **prompt 归档**：plan mode 下无法写 prompt-archives，执行阶段第一步补做；AGENTS.md 强制要求。