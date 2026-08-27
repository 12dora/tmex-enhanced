# 测试套件腐化与低价值审计报告

审计范围约 63.5k 行测试代码：单元测试约 53.8k 行，Playwright spec 约 9.75k 行。已对照近期拆分提交，包括 `19999cb`、`000d8bb`、`681eed8`、`f6dac7b`，并保留 issue45 等固定问题回归测试。

以下按优先级排序，同级内按“可节省行数 × 置信度”排序。行数变化均为估算的测试代码净变化。

## P0：明确值得处理

### 1. 删除非回归用途的鼠标坐标诊断 spec

- 文件位置：[apps/fe/tests/issue45-mouse-coordinate-diagnostic.spec.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/fe/tests/issue45-mouse-coordinate-diagnostic.spec.ts:8)（L8–15、L432–523）；专用配置：[apps/fe/diagnostic-issue45.config.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/fe/diagnostic-issue45.config.ts:3)（L3–16）。
- 证据：文件明确写着“`Task 6 诊断 spec（非回归测试）`”和“`严禁修复：本 spec 只测量、只产出报告`”。最终断言只有 `createRes.ok`、结果非空和报告长度大于 500。
- 历史证据：提交 `16997e8 test(issue#45): bug 1 mouse coordinate diagnostic (not reproduced)` 已明确该问题未复现。
- 建议：从 Playwright 测试目录删除；若未来仍需人工诊断，将其移至显式 diagnostics 脚本目录，不纳入测试发现。
- 预计变化：约 `-523` 行测试代码。
- 风险：低。
- 优先级：P0。

### 2. 删除只验证 AI SDK 行为的 spike 测试

- 文件位置：[apps/gateway/src/llm/ai-sdk.spike.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/llm/ai-sdk.spike.test.ts:1)（L1–362）。
- 证据：文件只导入 `@ai-sdk/openai-compatible`、`ai` 和 `zod`；测试直接调用 `streamText`、`stepCountIs`、`tool`，例如 `describe('ai sdk spike (bun runtime)')` 和 L90 的直接 SDK 调用，没有导入任何 tmex 生产模块。
- 这些用例测试的是 AI SDK 的流式输出、工具循环、审批和 JSON round-trip，而不是 tmex 的 `AgentRun`、工具路由或持久化逻辑；后者已由 [apps/gateway/src/agent/run.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/run.test.ts:343) 等覆盖。
- 建议：删除整个 spike 文件。若仍需要在依赖升级时验证 SDK 兼容性，改成显式 opt-in 的依赖升级 smoke test。
- 预计变化：约 `-362` 行。
- 风险：低。
- 优先级：P0。

### 3. 删除永远不执行的 split-content fixme

- 文件位置：[apps/fe/tests/split-content-persistence.spec.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/fe/tests/split-content-persistence.spec.ts:4)（L4–16、L22–138）。
- 证据：文件只有一个 `test.fixme('issue-45 bug 2...')`；注释明确写着“简单单→split 场景下老 pane 内容未稳定丢失”，并说明协议层根因已由 [apps/gateway/src/ws/switch-barrier.issue45.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/switch-barrier.issue45.test.ts:101)（L101–150）精确覆盖。
- `readInkFirstCanvas` 和 `readInkByPane` 两个约 60 行的 canvas 采样 helper 只服务于这个跳过的测试。
- 建议：删除该 fixme 文件；保留 `switch-barrier.issue45.test.ts` 作为固定问题回归测试。若需要 UI 级复现，另建不进入默认 suite 的诊断项目。
- 预计变化：约 `-138` 行。
- 风险：中低。会失去未稳定的 UI 复现尝试，但不会失去当前协议层回归保护。
- 优先级：P0。

### 4. 删除被禁用且带阻塞式 shell sleep 的 OSC11 探针

- 文件位置：[apps/fe/tests/theme-propagation.spec.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/fe/tests/theme-propagation.spec.ts:173)（L173–242）。
- 证据：该段是 `test.fixme`，内部写入 `/tmp/tmex-osc11-mock-*.py`，并在异步测试中执行 `execSync('sleep 0.5')`。同文件 L244–375 已有正常执行的跨页广播、window-style 和 resize 主题测试。
- 建议：删除 L173–242；OSC11 探索性验证不应作为默认 Playwright 测试。
- 预计变化：约 `-70` 行，并消除至少数秒无意义等待。
- 风险：低。
- 优先级：P0。

### 5. 删除 Telegram 启动测试中的纯占位断言

- 文件位置：[apps/gateway/src/telegram/service.startup.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/telegram/service.startup.test.ts:1)（L1–12）。
- 证据：文件注释写明“`i18n 相关功能在 i18n/index.test.ts 中已经测试`”，唯一测试实际是 `expect(true).toBe(true)`。
- 建议：删除整个文件。真实翻译行为已在 [apps/gateway/src/i18n/index.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/i18n/index.test.ts:15)（L15–29）覆盖。
- 预计变化：约 `-12` 行。
- 风险：低。
- 优先级：P0。

## P1：值得处理

### 6. 抽取 Playwright 中重复的设备、canvas 和终端文本 helper

- 文件位置：
  - [apps/fe/tests/terminal-clipboard.spec.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/fe/tests/terminal-clipboard.spec.ts:6)（L6–58）
  - [apps/fe/tests/terminal-selection-canvas.spec.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/fe/tests/terminal-selection-canvas.spec.ts:21)（L21–76）
  - [apps/fe/tests/ime-fast-input.spec.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/fe/tests/ime-fast-input.spec.ts:65)（L65–118）
  - [apps/fe/tests/terminal-file-links.spec.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/fe/tests/terminal-file-links.spec.ts:17)（L17–53）
  - [apps/fe/tests/theme-broadcast.spec.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/fe/tests/theme-broadcast.spec.ts:29)（L29–40）
  - [apps/fe/tests/theme-propagation.spec.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/fe/tests/theme-propagation.spec.ts:32)（L32–43）
  - [apps/fe/tests/terminal-render-regressions.spec.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/fe/tests/terminal-render-regressions.spec.ts:111)（L111–122）
  - [apps/fe/tests/terminal-mouse-gestures.spec.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/fe/tests/terminal-mouse-gestures.spec.ts:28)（L28–41、L71–83）
- 证据：多个文件重复相同的 `request.post('/api/devices')`、canvas 等待逻辑和 `window.__tmexE2eXterm.buffer.active` 可见文本遍历。例如 clipboard 与 selection 文件都重复：

  > `const buffer = term.buffer.active;`
  >
  > `const line = buffer.getLine(y);`
  >
  > `lines.push(line ? line.translateToString(false) : '');`

- 建议：新增 `apps/fe/tests/helpers/device.ts`，统一提供 `createLocalDevice`、`waitForCanvasTerminal`、`readVisibleTerminalText`、`focusTerminal`；通过参数支持 `translateToString(true/false)` 和 renderer probe 差异。保留 `measureInkRatio`、鼠标协议和 issue45 专用 helper。
- 预计变化：删除约 450–520 行重复 helper，新增约 90–120 行共享 helper，净减少约 `-350 至 -420` 行。
- 风险：中低。需要注意不同测试对设备名称参数顺序和 canvas probe 断言略有差异。
- 优先级：P1。

### 7. 合并 Ghostty 三个 issue45 测试文件中的 Fake DOM 基建

- 文件位置：
  - [packages/ghostty-terminal/src/terminal.canvas.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/terminal.canvas.test.ts:10)（L10–691）
  - [packages/ghostty-terminal/src/terminal.ime.issue45.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/terminal.ime.issue45.test.ts:13)（L13–479）
  - [packages/ghostty-terminal/src/issue45-cross-bug.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/issue45-cross-bug.test.ts:26)（L26–547）。
- 证据：三个文件都分别实现了 `FakeElement`、`FakeCanvasElement`、`FakeDocument`、`FakeWindowTarget`、`createFakeBindings`、`installFakeDom` 和 `TEST_THEME`。例如三处都存在：

  > `class FakeElement`
  >
  > `class FakeCanvasElement extends FakeElement`
  >
  > `function installFakeDom()`

- 建议：新增 `packages/ghostty-terminal/src/test-support/fake-dom.ts`，抽取通用 DOM、RAF、canvas、document、window、基础 bindings 和测试主题；canvas 文件额外保留鼠标事件扩展，IME/cross-bug 文件保留 render-state 特殊 mock。
- 不应删除 issue45 断言：`terminal.canvas.test.ts` L2338–2513、`terminal.ime.issue45.test.ts` L491–541、`issue45-cross-bug.test.ts` L558–684 都应保留。
- 预计变化：删除约 750–950 行重复 scaffolding，新增约 250–400 行共享 helper，净减少约 `-350 至 -500` 行。
- 风险：中。`mock.module`、模块缓存和不同 FakeEvent 类型需要统一清理策略。
- 优先级：P1。

### 8. 将共享 SessionCommands 行为从 local/SSH 巨型测试中移出

- 文件位置：
  - [apps/gateway/src/tmux-client/local-external-connection.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/local-external-connection.test.ts:826)（L826–872、L926–959、L1385–1463）
  - [apps/gateway/src/tmux-client/ssh-external-connection.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/ssh-external-connection.test.ts:590)（L590–673、L1025–1086）
  - [apps/gateway/src/tmux-client/external/session-commands.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/external/session-commands.test.ts:208)（L208–237）
  - 生产委托：[apps/gateway/src/tmux-client/external/session-commands.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/external/session-commands.ts:127)（L127–153）。
- 证据：
  - local/SSH 都重复测试 `selectWindow` 遇到缺失目标后刷新 snapshot；
  - local/SSH 都重复测试 `resizePane` 不设置 `window-size latest`；
  - local/SSH 都重复测试自定义 `defaultWorkingDir` 的 `configureSessionOptions` 和 `ensureSession`；
  - 新 collaborator 已直接测试 `configureSessionOptions` 和 `ensureSession`：

  > `await new SessionCommands(host).configureSessionOptions();`
  >
  > `await new SessionCommands(createdHost.host).ensureSession()`

- 建议：在 `session-commands.test.ts` 增加 `selectWindow`、`resizePane` 的直接 collaborator 测试，然后删除两个 transport monolith 中对应的四组行为测试，以及重复的 `ensureSession` 测试。保留每种 transport 的连接/命令序列 smoke test，继续验证 argv 到本地命令和 SSH shell quoting 的边界。
- 预计变化：删除约 300 行，新增约 60–80 行 collaborator 测试，净减少约 `-220 至 -250` 行。
- 风险：中。若完全删除 transport 层断言，会失去 SSH quoting 的部分保护，因此应保留连接和 createWindow 的 transport smoke test。
- 优先级：P1。

### 9. 删除 local/SSH 中重复的主题 no-op 测试

- 文件位置：
  - [apps/gateway/src/tmux-client/local-external-connection.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/local-external-connection.test.ts:1699)（L1699–1760）
  - [apps/gateway/src/tmux-client/ssh-external-connection.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/ssh-external-connection.test.ts:1138)（L1138–1170、L1315–1331）
  - [apps/gateway/src/tmux-client/external/theme-subscription.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/external/theme-subscription.test.ts:28)（L28–41）
- 证据：local 和 SSH 都验证 `signalThemeChange` 不产生 `send-keys`；shared collaborator 已验证无订阅 pane 时不发送：

  > `controller.signalThemeChange('%1', 'dark');`
  >
  > `expect(sent).toEqual([]);`

  生产核心也只是统一委托给 `ThemeSubscriptionController`：[external-tmux-core.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/external-tmux-core.ts:248)（L248–250）。
- 建议：在 `theme-subscription.test.ts` 增加一个 `connected=false` 用例，删除 local/SSH 四个 transport-level no-op 测试。
- 预计变化：删除约 112 行，新增约 8–12 行，净减少约 `-100` 行。
- 风险：中低。
- 优先级：P1。

### 10. 删除 outcome resolver 中复制生产 if 链的笛卡尔积测试

- 文件位置：[apps/gateway/src/agent/outcome-resolver.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/outcome-resolver.test.ts:10)（L10–58、L167–216）；生产实现：[outcome-resolver.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/outcome-resolver.ts:28)（L28–72）。
- 证据：测试侧 `abortedBranch` 和 `spec` 几乎逐行复制生产实现：

  > `function spec(signals: RunOnceSignals): RunOnceDecision {`
  >
  > `if (signals.stalled) ...`
  >
  > `if (signals.stopReason) ...`

  随后对 512 种组合执行 `actual` 与 `spec(signals)` 比较。
- 建议：删除 `BOOLS`、`STOP_REASONS`、`abortedBranch`、`spec` 及 L167–216 的笛卡尔积测试；保留 L76–165 的显式优先级测试，它们已覆盖每个优先级边界和 abort 子优先级。
- 预计变化：约 `-96` 行。
- 风险：低。复制 oracle 并不能独立验证生产逻辑，显式边界测试更易维护。
- 优先级：P1。

### 11. 将 snapshot malformed-row 固定问题从两个 transport 测试合并为一个 collaborator 回归测试

- 文件位置：
  - [apps/gateway/src/tmux-client/local-external-connection.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/local-external-connection.test.ts:317)（L317–364）
  - [apps/gateway/src/tmux-client/ssh-external-connection.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/ssh-external-connection.test.ts:504)（L504–557）
  - [apps/gateway/src/tmux-client/external/snapshot-projector.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/external/snapshot-projector.test.ts:35)（L35–49、L136–145）。
- 证据：local 和 SSH 两个测试来自同一修复提交 `ec95f15 fix(gateway): harden tmux snapshot parsing`，都构造 underscore-rendered 行并断言：

  > `expect(snapshots[0]).toEqual({ deviceId: ..., session: null });`
  >
  > `expect(JSON.stringify(snapshots[0])).not.toContain('@0_0_bash_1');`

- 建议：在 `snapshot-projector.test.ts` 增加一个明确的 underscore malformed-row 回归用例，然后删除 local/SSH 两份 transport 包装测试。保留一个 transport snapshot smoke test 验证连接 wiring。
- 预计变化：删除约 102 行，新增约 12–15 行，净减少约 `-85 至 -90` 行。
- 风险：低中。固定问题仍保留一次，且现在测试直接位于实际拥有解析逻辑的 collaborator。
- 优先级：P1。

### 12. 统一 Gateway WS 测试中的 fake socket、entry 和 envelope helper

- 文件位置：
  - [apps/gateway/src/ws/switch-barrier.issue45.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/switch-barrier.issue45.test.ts:23)（L23–99）
  - [apps/gateway/src/ws/issue45-cross-bug.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/issue45-cross-bug.test.ts:28)（L28–133）
  - [apps/gateway/src/ws/event-notify-broadcast.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/event-notify-broadcast.test.ts:16)（L16–24）
  - [apps/gateway/src/ws/settings-broadcast.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/settings-broadcast.test.ts:23)（L23–31）
  - [apps/gateway/src/ws/site-theme-update.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/site-theme-update.test.ts:14)（L14–24）
  - [apps/gateway/src/ws/borsh-dispatcher.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/borsh-dispatcher.test.ts:13)（L13–23）
- 证据：多个文件重复相同结构：

  > `data: { borshState: createBorshClientState() },`
  >
  > `sent: [] as Uint8Array[],`
  >
  > `send(message: Uint8Array) { this.sent.push(message); }`

  两个 issue45 文件还重复 `setupEntry` 和 `envelopeKind`。
- 建议：新增 `apps/gateway/src/ws/test-helpers.ts`，提供 `createBorshTestWs({ registerSession, returnByteLength })`、`setupConnectionEntry`、`envelopeKind`。通过选项兼容是否注册 `sessionStateStore` 以及 `send` 返回 byte length。
- issue45 行为测试本身应保留，只抽取基建。
- 预计变化：删除约 120–135 行，新增约 35–45 行，净减少约 `-80 至 -100` 行。
- 风险：低中。
- 优先级：P1。

### 13. 共享 Agent 测试中的 SSE mock server

- 文件位置：
  - [apps/gateway/src/agent/run.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/run.test.ts:27)（L27–113）
  - [apps/gateway/src/agent/supervisor.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/supervisor.test.ts:34)（L34–106）。
- 证据：两个文件分别复制了 `chunk`、`sseResponse`、`slowSseResponse`、`RecordedRequest`、`createMockChatServer` 和 server cleanup；核心实现完全相同：

  > `const server = Bun.serve({ port: 0, fetch: async (req) => { ... } });`

- 建议：新增 `apps/gateway/src/agent/test-support/mock-chat-server.ts`，统一 `chunk`、SSE response 和 Bun server；`run.test.ts` 的 `hangingSseResponse` 保留为 watchdog 专用 helper。
- 不删除 supervisor/run 的真实 `AgentRun` 集成测试，只减少 scaffolding。
- 预计变化：删除约 145 行，新增约 70–75 行，净减少约 `-65 至 -75` 行。
- 风险：低。
- 优先级：P1。

### 14. 统一 Watch 测试中重复的 rule/state fixture

- 文件位置：
  - [apps/gateway/src/watch/evaluation-pipeline.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/watch/evaluation-pipeline.test.ts:14)（L14–54）
  - [apps/gateway/src/watch/evaluator.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/watch/evaluator.test.ts:11)（L11–51）
  - [apps/gateway/src/watch/notifier.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/watch/notifier.test.ts:8)（L8–33）。
- 证据：三个文件重复构造完整的 `WatchRuleRecord`，前两个还重复完整的 `WatchRuleStateRecord`：

  > `id: 'rule-1'`
  >
  > `deviceId: 'device-1'`
  >
  > `intervalSeconds: 30`
  >
  > `cooldownSeconds: 600`

- 建议：新增 `apps/gateway/src/watch/test-fixtures.ts`，提供 `makeWatchRule(overrides)` 和 `makeWatchRuleState(overrides)`；各测试只覆盖 `pattern`、`conditionPrompt`、`fireMode` 等差异。
- 预计变化：删除约 105 行，新增约 40 行，净减少约 `-60 至 -65` 行。
- 风险：低。
- 优先级：P1。

### 15. 删除 WebSocketServer 中已由 DeviceConnectionRegistry 覆盖的 closeAll 竞态测试

- 文件位置：
  - [apps/gateway/src/ws/index.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/index.test.ts:216)（L216–260）
  - [apps/gateway/src/ws/device-connection-registry.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/device-connection-registry.test.ts:23)（L23–54）。
- 证据：两处都创建 gate，启动未完成的 connection，调用 `closeAll()`，释放 gate，然后断言 pending 结果为 `null`、entry 被清理、runtime 被释放。collaborator 测试已经直接覆盖 generation race。
- `index.test.ts` L131–167 仍覆盖已有连接在 server shutdown 时释放，因此不会完全失去 facade 的 closeAll 保护。
- 建议：删除 `index.test.ts` L216–260，保留 registry collaborator 测试和已有 shutdown release 测试。
- 预计变化：约 `-45` 行。
- 风险：低。
- 优先级：P1。

### 16. 合并 IME issue45 中只证明路径存在的 sanity 测试

- 文件位置：
  - [packages/ghostty-terminal/src/terminal.ime.issue45.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/terminal.ime.issue45.test.ts:491)（L491–582）
  - 跨 bug 测试：[packages/ghostty-terminal/src/issue45-cross-bug.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/issue45-cross-bug.test.ts:615)（L615–684）。
- 证据：主测试 L491–541 已派发 `compositionstart/update` 并断言 composition 期间 `updateRenderState` 调用为 0、rAF 后调用为 1；第二个测试 L543–582 只是再次派发 `compositionstart`，然后检查 `style.left`：

  > `test('issue45 syncTextarea path is exercised by composition events (sanity)', ...)`

- 建议：把 `style.left` 的一条有效断言合并进主测试，删除整个 sanity 测试。跨 bug 测试继续保留。
- 预计变化：净减少约 `-35` 行。
- 风险：低中。
- 优先级：P1。

## 明确不建议删除的项目

- [apps/gateway/src/tmux-client/local-external-connection.eagain.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/local-external-connection.eagain.test.ts:140) 与 [local-external-connection.integration.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/local-external-connection.integration.test.ts:76) 不是重复：前者测试 socket 注入、EAGAIN、版本和 fake command，后者启动真实 tmux 验证 live output、bell、布局和订阅。
- `supervisor.test.ts` 中的 AgentSupervisor 集成测试不建议删除；它们实际走数据库、run 生命周期、队列和 stop/resume 语义。此次只建议抽取 SSE mock。
- `terminal.canvas.test.ts` 中 issue45 bug3、resize、e2e probe surface 测试不建议删除，尤其是提交 `95a19b2` 明确修复了 e2e probe 所需接口。
- `issue45-cross-bug.test.ts`、`switch-barrier.issue45.test.ts`、`ime-fast-input.spec.ts` 和 `terminal-render-regressions.spec.ts` 都仍是有效回归保护。
- `apps/fe/tests/ssh-device-connect.spec.ts` 的 `test.skip(!targetName, ...)` 是显式外部 SSH 环境门控，不属于腐烂占位测试；应考虑归入 opt-in integration project，但不建议直接删除。

只读审计未修改文件，也未运行测试。