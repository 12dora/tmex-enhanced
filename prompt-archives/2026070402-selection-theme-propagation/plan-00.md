# 分屏 Selection 清空修复 + 主题动态传递

## TL;DR

> **Quick Summary**: 修复分屏下「A 持续输出导致 B 的文字选择被清空」bug；并把 dark/light 主题状态做成「跨设备跨网页广播同步 + OSC 11 拦截代答 + SIGWINCH 推送」的完整链路，让 tmux pane 内的 Coding Agent（OpenCode / Claude Code / Codex）能感知并切换主题。
>
> **Deliverables**:
> - 分屏 selection 在持续输出场景下稳定保留
> - SiteSettings 加 theme 字段，gateway 持久化 + WS 广播
> - 网页/设备并发切主题走 last-writer-wins + 服务器 timestamp
> - gateway pane-stream-parser 拦截 OSC 11/10 查询并基于当前主题代答（绕过 tmux 不转发的硬伤）
> - gateway 主题切换时向 pane 进程组发 SIGWINCH（纯 signal，不带 winsize）
> - Bug 1 + Bug 2 端到端 e2e 验收
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 4 waves
> **Critical Path**: Wave1 spike → Wave2 基础架构 → Wave3 核心实现 → Wave4 集成验证

---

## Context

### Original Request

用户提出两个任务（同会话）：

1. **Bug**: 分屏模式下 A pane 的 TUI 持续输出，在 B pane 中选取文字后 selection 立即被清空。
2. **新功能**: 把 dark/light 主题动态传给终端，让 pane 内的 Coding Agent（OpenCode / Claude Code / Codex / omp）能自己切换主题；参考 omp/opencode/claudecode/codex 的实现。

用户在规划期间陆续补充三条关键决策：
- OSC 11 + SIGWINCH **两个路径都要**支持同步 color scheme
- dark/light mode 需要**跨设备跨网页广播同步**
- 处理客户端 resize 时也要发主题同步消息；**避免主题同步导致终端尺寸意外变化**

### Interview Summary

**已确认决策**（用户用 question 工具回答）：
- 主题真源：扩展 SiteSettings（gateway SQLite 持久化 + WS 广播）
- 并发策略：Last-writer-wins + timestamp
- 不跟随系统 prefers-color-scheme（保持手动切换）
- OSC 11 应答 / SIGWINCH 实现层：Gateway 拦截代答
- 测试策略：TDD（RED-GREEN-REFACTOR）+ e2e
- 在新 worktree 实现

**Research Findings**:
- Bug 1 候选根因：`packages/ghostty-terminal/src/terminal.ts:593` `resize(cols, rows)` 内必清 selection；`SplitTerminalArea.tsx:200-206` effect 依赖 `[geometry]`，A 输出可能让 `tmuxWindow.layout` 抖动 → geometry 重算 → B.resize → selection 被清。**未实证**，需 spike。
- Bug 2 已有基础：前端已实现主题切换 + tmux window-style 同步（`stores/tmux.ts:148-152,378-389`），gateway 已实现 `setWindowStyle`（`ws/index.ts:911-915` + local/ssh `configureWindowStyle`）；但 OSC 11 在 tmux 内被拦截，TUI 启动后不重查。
- Coding Agent 兼容性矩阵：OpenCode/Claude Code/Codex 启动时查 OSC 11；Codex 在 tmux 内 OSC 11 失败（issue #19741/#22761，tmux 不转发）；Codex 用 OnceLock 缓存**启动后不重查**；omp 不查 OSC。
- 行业机制：OSC 11 是事实标准；SIGWINCH 是 iTerm2+tmux 的事实约定；Mode 2031 是新标准（Ghostty/kitty/VTE 支持）。

### Metis Review

**Identified Gaps**（已纳入 plan）：

1. **OSC 应答注入路径可行性未验证**（最高风险）：tmux `send-keys -l` 会把字节当按键处理，shell readline 会吃掉。需 spike 验证 tmux 是否有 raw pty write 通道（如 `pipe-pane` 双向、control mode `%output` 反向、或持 fd 直接 write）。
2. **Bug 1 根因未实证**：layout 抖动假设可能错，需打日志确认 B pane selection 丢失时的实际调用栈。
3. **pane-stream-parser 白名单语义未确认**：OSC kind 白名单 `{0,1,2,9,52,99,133,777,1337}` 不含 11，「不含」是「丢弃」还是「透传」决定拦截实现层。
4. **SIGWINCH 发送能力未验证**：tmux control mode 可能不暴露 arbitrary signal，需通过 `display-message -p '#{pane_pid}'` + `kill(2)` 或 SSH channel exec。
5. **SiteSettings 迁移路径**：DB schema 加列、前端 useUIStore 与 useSiteStore 关系、生产平滑升级。
6. **v1 scope creep 风险**：OSC 4 调色板、Mode 2031、Claude Code 主题文件热重载、omp 主题文件、自定义色——全部明确排除出 v1。

---

## Work Objectives

### Core Objective

修复分屏 selection bug + 把 dark/light 主题做成端到端动态传递系统（跨设备跨网页广播 + OSC 11 拦截代答 + SIGWINCH 推送），让 tmux pane 内的 Coding Agent 能在启动时正确探测主题、在主题切换时尽力同步（best-effort）。

### Concrete Deliverables

- Bug 1：分屏 A 输出 + B 选取场景下，B 的 selection 稳定保留 ≥30s
- Bug 2：SiteSettings.theme 字段 + gateway 持久化 + GET/POST `/api/settings/theme`
- Bug 2：WS 消息 `KIND_SITE_THEME_UPDATE`（广播给所有连接的网页）
- Bug 2：pane-stream-parser 扩展：拦截 OSC 11/10 查询并代答（基于当前主题色）
- Bug 2：gateway runtime 新增 `signalPaneGroup(paneId, signal)` 能力，主题切换时对所有已连接设备的所有 pane 发 SIGWINCH
- Bug 2：前端 useUIStore.theme 改为从 useSiteStore 派生（保留 localStorage 作为离线 fallback）
- Bug 2：主题色单一真源迁移到 `@tmex/shared`（前端 + gateway 共享一份定义）
- Bug 2：客户端 last-writer-wins（用**服务器 timestamp**，客户端只上报意图）
- e2e 测试覆盖两个 bug 的关键路径

### Definition of Done

- [ ] `bun test` 全过（含新增单测）
- [ ] `bun run typecheck` 无新增告警
- [ ] biome 对改动文件无新增告警
- [ ] e2e（playwright + 独立 tmux session）：分屏 selection + 主题切换 + 跨设备广播 全部通过
- [ ] 不触碰生产 tmex（端口 9883、`~/Library/Application Support/tmex/`、tmux session `tmex`）

### Must Have

- Bug 1 修复（实证根因后修，不能瞎猜）
- SiteSettings.theme 字段 + 持久化 + API
- WS 广播主题变化（KIND_SITE_THEME_UPDATE）
- pane-stream-parser 拦截 OSC 11/10 查询并代答
- gateway 主题切换时对所有 pane 进程组发 SIGWINCH（**纯 signal，绝不调 ioctl TIOCSWINSZ**）
- 客户端 last-writer-wins（服务器 timestamp）
- 主题色单一真源在 `@tmex/shared`
- TDD：每个修复/功能先写单测
- worktree 内干活

### Must NOT Have (Guardrails)

- ❌ **OSC 4 调色板代答**（v1 排除，列入 follow-up；无主流 agent 在 v1 验收集内查 OSC 4）
- ❌ **Mode 2031 / DECRQM 状态查询代答**（v1 排除；OpenCode 运行中切换作为 best-effort 不保证）
- ❌ **Claude Code 主题文件 watcher 热重载**（v1 不写 `~/.claude/theme.json`；运行中切换靠 OSC + SIGWINCH 路径）
- ❌ **omp 主题文件写入**（omp 不查 OSC，明确排除出 v1 验收）
- ❌ **prefers-color-scheme 跟随系统**（用户已明确拒绝）
- ❌ **per-pane 主题**（v1 主题全局，所有 pane 同步切）
- ❌ **自定义主题色 / 多预设**（v1 只支持 dark/light 二态）
- ❌ **多 UserSettings 表 / 多用户 theme**（singleton siteSettings 即可）
- ❌ **客户端带 timestamp 上报**（必须服务器侧 `Date.now()` 分配 timestamp，避免时钟漂移）
- ❌ **主题同步附带 TIOCSWINSZ**（SIGWINCH 必须纯 signal，绝不改尺寸）
- ❌ **触碰生产 tmex / tmux session `tmex`**（AGENTS.md 硬约束）
- ❌ **使用 tmux `send-keys -l` 注入 OSC 应答**（会触发 shell readline 副作用）
- ❌ **保留双路径但不一致**：tmux window-style 路径（已存在）保留，但色值必须与 OSC 代答色强一致（同源 `@tmex/shared`）

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** - ALL verification is agent-executed. No exceptions.

### Test Decision

- **Infrastructure exists**: YES（bun test + playwright）
- **Automated tests**: TDD（RED-GREEN-REFACTOR）
- **Framework**: bun test（单测）+ Playwright（e2e）

### QA Policy

每个 task 必须包含 agent-executed QA 场景。证据保存到 `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`。

- **前端 UI**: Playwright（playwright skill）- 导航、交互、DOM 断言、截图
- **TUI / CLI**: interactive_bash（tmux）- 独立 socket（如 `tmex-e2e-bug1`）
- **API**: Bash (curl) - 发请求、断言 status + JSON
- **WS 协议**: bun test + 手工 borsh 编码
- **OSC 行为**: bun test + byte stream fixture

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1（spike 实证 + 基础架构，4 个并行 + 2 个独立 quick）:
├── Task 1: worktree + prompt-archives 存档 [quick]
├── Task 2: Bug 1 根因实证 spike [deep]
├── Task 3: pane-stream-parser OSC 11 行为 + raw pty write 通道调研 spike [deep]
├── Task 4: SIGWINCH 发送能力调研 spike [deep]
├── Task 5: SiteSettings.theme schema migration + API endpoint [quick]
├── Task 6: 主题色单一真源迁移到 @tmex/shared [quick]

Wave 2（核心修复 + 实现，依赖 Wave 1 spike 结论）:
├── Task 7: Bug 1 修复（基于 Task 2 spike 结论）[deep]
├── Task 8: gateway OSC 11/10 拦截代答（基于 Task 3 spike）[deep]
├── Task 9: gateway SIGWINCH 推送（基于 Task 4 spike）[unspecified-high]
├── Task 10: WS 主题广播协议 + 服务器 timestamp last-writer-wins [unspecified-high]
├── Task 11: 前端 useUIStore.theme 改为从 useSiteStore 派生 [visual-engineering]

Wave 3（集成 + 优化）:
├── Task 12: 主题切换 × resize 互踩处理（用户硬性约束）[deep]
├── Task 13: SSH 设备 OSC 代答时延 + 并发场景验证 [unspecified-high]
├── Task 14: e2e 测试套件（bug 1 + bug 2 + 跨设备广播）[unspecified-high]

Wave FINAL（4 个并行 review，全部 APPROVE 才算完成）:
├── F1: Plan Compliance Audit (oracle)
├── F2: Code Quality Review (unspecified-high)
├── F3: Real Manual QA (unspecified-high + playwright)
└── F4: Scope Fidelity Check (deep)
```

**Critical Path**: Task 2/3/4 spike → Task 7/8/9 → Task 12 → Task 14 → F1-F4
**Parallel Speedup**: ~65% faster than sequential
**Max Concurrent**: 6 (Wave 1)

### Dependency Matrix

| Task | Depends On | Blocks |
|---|---|---|
| 1 | - | 2,3,4,5,6（提供 worktree 环境） |
| 2 | 1 | 7 |
| 3 | 1 | 8 |
| 4 | 1 | 9 |
| 5 | 1 | 10, 11 |
| 6 | 1 | 8, 10, 11 |
| 7 | 2 | 12, 14 |
| 8 | 3, 6 | 12, 14 |
| 9 | 4 | 12, 14 |
| 10 | 5, 6 | 11, 12, 14 |
| 11 | 5, 10 | 12, 14 |
| 12 | 7, 8, 9, 10, 11 | 14 |
| 13 | 8, 9 | 14 |
| 14 | 7-13 | F1-F4 |

### Agent Dispatch Summary

- **Wave 1**: 6 - T1 → `quick`, T2 → `deep`, T3 → `deep`, T4 → `deep`, T5 → `quick`, T6 → `quick`
- **Wave 2**: 5 - T7 → `deep`, T8 → `deep`, T9 → `unspecified-high`, T10 → `unspecified-high`, T11 → `visual-engineering`
- **Wave 3**: 3 - T12 → `deep`, T13 → `unspecified-high`, T14 → `unspecified-high`
- **FINAL**: 4 - F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high` + playwright, F4 → `deep`

---

## TODOs

- [ ] 1. **worktree 设置 + prompt-archives 存档**

  **What to do**:
  - 在主仓执行 `git worktree add` 创建新 worktree（命名 `split-theme` 或类似），base commit 取当前 main HEAD
  - 验证 worktree 内 `bun install` 可用（Bun-only，不能踩 Node 兼容）
  - 在 worktree 内创建 `prompt-archives/2026070402-selection-theme-propagation/` 文件夹
  - 写 `plan-prompt.md`：归档用户原始需求（两个任务）+ 三条关键决策（OSC 11 + SIGWINCH / 跨设备广播 / resize 同步）
  - 把本 plan 复制为 `plan-00.md`
  - 后续实现完成后补 `plan-00-result.md`

  **Must NOT do**:
  - 不在主仓工作区改任何代码
  - 不开新 tmux session 名为 `tmex`（生产）
  - 不触碰 `~/Library/Application Support/tmex/`

  **Recommended Agent Profile**:
  - **Category**: `quick` — 纯文件 + git 操作，逻辑简单
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: NO（其他 task 都需要 worktree 环境）
  - **Parallel Group**: Wave 1 头部
  - **Blocks**: 2, 3, 4, 5, 6
  - **Blocked By**: None

  **References**:
  - `AGENTS.md` 干活原则段（worktree / 严禁触碰 / 三套环境 / 先存档）
  - `prompt-archives/2026070200-split-screen/plan-prompt.md` 同类存档参考

  **Acceptance Criteria**:
  - [ ] `git worktree list` 列出新 worktree
  - [ ] `prompt-archives/2026070402-selection-theme-propagation/plan-prompt.md` 存在
  - [ ] `prompt-archives/2026070402-selection-theme-propagation/plan-00.md` 存在
  - [ ] worktree 内 `bun --version` 输出可用版本

  **QA Scenarios**:
  ```
  Scenario: worktree 与存档齐备
    Tool: Bash
    Preconditions: 主仓干净（git status 无未提交改动）
    Steps:
      1. 跑 `git worktree list` → 输出包含 split-theme 路径
      2. 跑 `ls prompt-archives/2026070402-selection-theme-propagation/` → 列出 plan-prompt.md 和 plan-00.md
      3. 在 worktree 内跑 `bun --version` → 输出形如 1.x.x
    Expected Result: 三个断言全部满足
    Failure Indicators: 任何一步报错或文件缺失
    Evidence: .sisyphus/evidence/task-01-worktree-setup.txt
  ```

  **Commit**: YES
  - Message: `chore(spike): worktree + prompt-archives 存档`
  - Files: `prompt-archives/2026070402-selection-theme-propagation/*`

---

- [ ] 2. **Bug 1 根因实证 spike**

  **What to do**:
  - 在 worktree 起临时 dev 实例：`TMEX_TMUX_SOCKET=tmex-e2e-bug1 GATEWAY_PORT=19884 FE_PORT=19664 NODE_ENV=development bun run dev`（**端口严格避让 9883/19883/19663**）
  - 独立 tmux socket：`tmux -L tmex-e2e-bug1 new-session -d -s test`（**严禁默认 socket**）
  - 通过 dev 实例连接该 socket，开 split-pane（splitRight）
  - A pane 跑持续输出：`for i in $(seq 1 100000); do echo "tick $i $(date +%N)"; sleep 0.05; done`
  - B pane 用鼠标拖拽选取一段文字，**观察 selection 是否立即消失**
  - 在以下位置加临时 `console.debug` 日志（带唯一前缀 `[bug1-spike]`）：
    - `packages/ghostty-terminal/src/terminal.ts:584` `resize()` 入口：log cols/rows + 调用栈
    - `packages/ghostty-terminal/src/terminal.ts:1599` `clearSelectionState()` 入口：log 调用栈
    - `packages/ghostty-terminal/src/terminal.ts:548` `reset()` 入口：log
    - `apps/fe/src/components/terminal/SplitTerminalArea.tsx:200` geometry effect：log geometry 引用 + col/row
    - `apps/fe/src/ws-borsh/state-machine.ts:241` onResetTerminal：log deviceId/paneId
    - `apps/fe/src/ws-borsh/pane-sink-registry.ts:80` dispatchPaneReset：log
  - 浏览器 DevTools 收集 B pane selection 消失瞬间的所有 `[bug1-spike]` 日志
  - 输出根因报告到 `.sisyphus/evidence/task-02-bug1-root-cause.md`，包含：
    - 重现条件、日志时间线、调用栈分析
    - 根因结论（resize 触发 / reset 触发 / 其他）
    - 推荐 fix 方向（resize 不清 selection / effect short-circuit / layout 稳定化 / focusPane 路径修正）
  - **临时日志在 spike 完成后必须移除**

  **Must NOT do**:
  - 不修复 bug（修复在 Task 7）
  - 不触碰默认 socket 上的任何 session（特别是名为 `tmex` 的）
  - 不用 port 9883 / 19883 / 19663

  **Recommended Agent Profile**:
  - **Category**: `deep` — 实证调试，需要系统化假设验证
  - **Skills**: [`systematic-debugging`]

  **Parallelization**:
  - **Can Run In Parallel**: YES（与 T3/T4 并行）
  - **Parallel Group**: Wave 1
  - **Blocks**: 7
  - **Blocked By**: 1

  **References**:
  - `packages/ghostty-terminal/src/terminal.ts:584-597` resize 内 clearSelectionState(false)
  - `packages/ghostty-terminal/src/terminal.ts:1599-1617` clearSelectionState 实现
  - `apps/fe/src/components/terminal/SplitTerminalArea.tsx:200-206` geometry effect
  - `apps/fe/src/ws-borsh/pane-sink-registry.ts:80-91` dispatchPaneReset
  - `apps/fe/src/ws-borsh/state-machine.ts:241-245` onResetTerminal 触发点
  - `prompt-archives/2026070200-split-screen/plan-00.md` 分屏架构（focusPane 轻量路径）
  - `prompt-archives/2026061104-selection-column-space/plan-00-result.md` selection 模型历史
  - `docs/terminal/2026041600-ghostty-wasm-runtime.md` ghostty 渲染机制

  **WHY Each Reference Matters**:
  - `terminal.ts:584` 是首选根因候选，spike 要确认 resize 是否被调
  - `SplitTerminalArea:200` 是 resize 触发链路顶端，需要看 geometry 是否抖动
  - `pane-sink-registry:80` 验证是否走 reset 路径（备选根因）
  - `state-machine:241` 验证焦点切换是否错误触发完整 select

  **Acceptance Criteria**:
  - [ ] `.sisyphus/evidence/task-02-bug1-root-cause.md` 存在
  - [ ] 报告含明确根因结论（不是「可能是…」）
  - [ ] 报告含推荐 fix 方向（含具体 file:line）
  - [ ] 临时 console.debug 日志全部移除（git diff 干净）
  - [ ] dev 实例进程已关闭（`lsof -i :19884` 无输出）

  **QA Scenarios**:
  ```
  Scenario: 重现 + 定位根因
    Tool: Bash + 人工分析 DevTools 日志
    Preconditions: dev 实例 + 独立 tmux socket 已起
    Steps:
      1. 浏览器打开 http://localhost:19664，连接 tmex-e2e-bug1 socket 的 test session
      2. 在 pane A 跑 `for i in $(seq 1 100000); do echo "tick $i"; sleep 0.05; done`
      3. 在 pane B 拖拽选取一段文字，mouseup
      4. DevTools 过滤 [bug1-spike] 日志，记录 selection 消失瞬间的所有日志
      5. 截图 selection 消失前后的浏览器画面
    Expected Result: 日志清晰显示根因（resize 调用栈 / reset 调用栈 / 其他）
    Failure Indicators: 无法重现 bug，或日志不足以定位根因 → 报告里明确写「需要二次 spike」
    Evidence: .sisyphus/evidence/task-02-bug1-root-cause.md（含日志、截图路径、结论）

  Scenario: spike 后清理
    Tool: Bash
    Steps:
      1. 跑 `git diff packages/ apps/ | grep "console.debug.*bug1-spike"` → 无输出
      2. 跑 `lsof -i :19884` → 无输出
      3. 跑 `tmux -L tmex-e2e-bug1 ls` → 输出 no server 或空（已清理）
    Expected Result: 三步全部干净
    Evidence: .sisyphus/evidence/task-02-cleanup.txt
  ```

  **Commit**: NO（spike 不提交代码，只提交 evidence 报告）
  - Files: `.sisyphus/evidence/task-02-bug1-root-cause.md`

---

- [ ] 3. **pane-stream-parser OSC 11 行为 + raw pty write 通道调研 spike**

  **What to do**:
  - 读 `apps/gateway/src/tmux-client/pane-stream-parser.ts` 全文，重点：
    - line 340-353 OSC kind 白名单 `{0,1,2,9,52,99,133,777,1337}` 的语义（**放行**白名单还是**识别**白名单）
    - OSC kind 11 在白名单外时的实际行为（**丢弃** vs **透传给 tmux** vs **不解包**）
    - OSC state machine 是否跨 chunk 安全
  - 写 bun test 单测：向 parser 喂 `ESC]11;?\a`（8 字节）和分两次喂（`ESC]11` + `;?\a`），断言行为
  - 调研 tmux control mode / tmux CLI 向 pane pty **注入 raw 字节**的可行路径（按优先级）：
    1. `tmux send-keys -t pane -l <hex>`：实证 shell readline 是否会吃 OSC 字节（应该会，**不可用**）
    2. `tmux pipe-pane -t pane -o <fifo>`：是否双向（man tmux 确认 pipe-pane 是 pane stdout → 外部命令，单向，**不可用**）
    3. tmux control mode 是否暴露 `%send-raw` 或类似的 raw stdin 注入命令（man tmux + 源码 grep）
    4. **直接持 pane pty master fd**：tmux 是否暴露 pane pty fd 给 control client？（**关键路径，要查 tmux 源码或社区**）
    5. 替代方案：tmux `display-message -p '#{pane_pid}'` 拿 pid，gateway 通过 `/proc/<pid>/` 找 pty fd 直接 write（Linux）/ `lsof`（macOS）— **跨平台 / 权限问题**
    6. **B plan**：让 ghostty-wasm 自己回答 OSC 11（如果 wasm 暴露此能力），跳过 gateway 注入
  - 调研 ghostty-wasm 的 OSC 11 应答能力：`packages/ghostty-terminal/src/ghostty-wasm.ts` + vendor/ghostty 源码，确认 wasm 是否会主动响应 OSC 11 query（设置 theme 后自动应答）
  - 输出 `.sisyphus/evidence/task-03-osc-write-channel.md`：含白名单语义结论、raw write 可行路径排序、ghostty-wasm 能力结论、推荐实现方案（**含 fallback**）

  **Must NOT do**:
  - 不实现 OSC 代答（在 Task 8）
  - 不改 parser 代码

  **Recommended Agent Profile**:
  - **Category**: `deep` — 调研涉及 tmux 内部机制、跨平台 pty 操作
  - **Skills**: [`systematic-debugging`]

  **Parallelization**:
  - **Can Run In Parallel**: YES（与 T2/T4 并行）
  - **Parallel Group**: Wave 1
  - **Blocks**: 8
  - **Blocked By**: 1

  **References**:
  - `apps/gateway/src/tmux-client/pane-stream-parser.ts:340-353` OSC 白名单
  - `apps/gateway/src/tmux-client/control-mode-subscription.ts` parser 调用链
  - `packages/ghostty-terminal/src/ghostty-wasm.ts` wasm 应答能力
  - `packages/ghostty-terminal/src/terminal.ts` ghostty theme 设置（line 754 setTheme）
  - vendor/ghostty submodule 源码（OSC 应答逻辑）
  - tmux 源码 `input.c`（OSC 11 应答逻辑，可参考实现） + `cmd-send-keys.c` + `cmd-pipe-pane.c`
  - tmex 历史背景：`prompt-archives/2026061105-tmux-osc-color-reply/result-00.md`（OSC 11 tmux 代答历史）
  - 行业参考：openai/codex issue #19741（OSC 11 tmux 不转发问题）

  **WHY Each Reference Matters**:
  - `pane-stream-parser.ts:340` 是 OSC 拦截实现入口
  - `control-mode-subscription.ts` 决定 parser 何时被调用
  - `ghostty-wasm.ts` 关键：如果 wasm 自己能答 OSC 11，方案完全不同（前端方案 vs gateway 方案）
  - tmux 源码 `input.c` 是 OSC 11 应答的事实实现，可借鉴字节格式

  **Acceptance Criteria**:
  - [ ] `.sisyphus/evidence/task-03-osc-write-channel.md` 存在
  - [ ] 报告含白名单语义明确结论（丢弃 / 透传 / 不识别）
  - [ ] 报告含 ≥3 个 raw write 路径的可行性排序（含 fallback）
  - [ ] 报告含 ghostty-wasm 是否会自己答 OSC 11 的结论（关键架构决策）
  - [ ] 推荐实现方案明确（含 fallback）

  **QA Scenarios**:
  ```
  Scenario: parser 行为单测
    Tool: Bash (bun test)
    Preconditions: bun test 环境可用
    Steps:
      1. 创建临时 test 文件 `pane-stream-parser-osc-spike.test.ts`
      2. 测试用例 1：喂 `ESC]11;?\a` 单 chunk，断言 parser 输出（透传 / 丢弃 / 回调）
      3. 测试用例 2：分两次喂 `ESC]11` + `;?\a`，断言跨 chunk 行为一致
      4. 测试用例 3：喂 `ESC]11;rgb:aa/bb/cc\a`（设置），断言行为
      5. 跑 `bun test pane-stream-parser-osc-spike.test.ts`
    Expected Result: 三个测试用例都跑过，行为明确
    Evidence: .sisyphus/evidence/task-03-parser-test-output.txt

  Scenario: 调研报告完整
    Tool: 人工 review
    Steps:
      1. 读 .sisyphus/evidence/task-03-osc-write-channel.md
      2. 检查 6 个调研路径是否都有结论（含 N/A 说明）
      3. 检查推荐方案是否含 fallback
    Expected Result: 报告可作为 Task 8 实施的完整 spec
    Evidence: .sisyphus/evidence/task-03-osc-write-channel.md
  ```

  **Commit**: NO（spike 报告 + 临时测试，不进主仓代码）
  - Files: `.sisyphus/evidence/task-03-osc-write-channel.md`

---

- [ ] 4. **SIGWINCH 发送能力调研 spike**

  **What to do**:
  - 调研 tmux control mode / CLI 是否暴露「向 pane 进程组发 arbitrary signal」的命令：
    1. `man tmux` 搜 `signal` / `kill`：确认 `kill-pane` / `kill-window` / `kill-session` 之外是否有 `signal-pane` 或类似
    2. tmux 源码 `cmd-*.c` grep `signal` / `SIGWINCH`
    3. 验证 `display-message -p -t <pane> '#{pane_pid}'` 拿 pid + 外部 `kill(2)` 是否可发 SIGWINCH（同 uid 应该可以）
  - 调研「进程组」语义：pane 内可能有子进程（如 vim + shell），SIGWINCH 发给前台进程组（pgid）还是单个 pid？
    - tmux `#{pane_pid}` 返回的是 pane 直接子进程 pid（通常 shell），shell 的子进程（如 vim）怎么收？
    - 实证：pane 内跑 `vim`，gateway 发 SIGWINCH 给 pane_pid，vim 是否 redraw
  - SSH 设备路径：通过 external-connection 的 exec channel 跑 `kill -WINCH -<pgid>` 是否可行？
    - `apps/gateway/src/tmux-client/ssh-external-connection.ts` 现有 exec 入口
  - 实证主流 TUI 收到 SIGWINCH 后的行为（**对 Bug 2 验收至关重要**）：
    - vim：redraw + 是否重查 OSC 11？（vim 启动时查 OSC 11 缓存，SIGWINCH 未必触发重查）
    - less / more：redraw
    - htop / top：redraw
    - OpenCode / Claude Code / Codex：读源码确认 SIGWINCH handler 是否触发 OSC 11 重查（**关键假设验证**）
  - 输出 `.sisyphus/evidence/task-04-sigwinch-capability.md`：含 tmux 能力结论、pgid 语义、SSH 路径、TUI 行为矩阵、推荐实现方案

  **Must NOT do**:
  - 不实现 SIGWINCH 推送（在 Task 9）
  - 不向生产 tmux session 发任何 signal

  **Recommended Agent Profile**:
  - **Category**: `deep` — 跨平台 signal 语义、TUI 行为调研
  - **Skills**: [`systematic-debugging`]

  **Parallelization**:
  - **Can Run In Parallel**: YES（与 T2/T3 并行）
  - **Parallel Group**: Wave 1
  - **Blocks**: 9
  - **Blocked By**: 1

  **References**:
  - `apps/gateway/src/tmux-client/local-external-connection.ts:265-281` sendInput（注入字节路径，可借鉴）
  - `apps/gateway/src/tmux-client/ssh-external-connection.ts` exec channel
  - `apps/gateway/src/tmux-client/device-session-runtime.ts:11-54` runtime 接口
  - tmux 源码 `cmd-display-message.c` + `cmd-kill-pane.c`
  - 行业参考：
    - ghostty discussion #2755（SIGWINCH × tmux × OSC 11 的事实约定）
    - OpenCode source `packages/opencode/src/cli/cmd/tui/util/terminal.ts`（OSC 11 探测时机）
    - Codex source `codex-rs/tui/src/terminal_probe.rs` + `terminal_palette.rs`（OnceLock 缓存验证）
    - Claude Code 反编译 `systemTheme.ts` + `systemThemeWatcher.ts`（watcher 是否在 SIGWINCH 触发时重查）

  **WHY Each Reference Matters**:
  - `local-external-connection.ts:265` 是现有的「向 pane 注入字节」参考实现，spike 要对比 signal 路径与 send-keys 路径的差异
  - tmux 源码决定 SIGWINCH 能否不通过外部 kill 发送（更优雅的方案）
  - OpenCode/Codex/Claude Code 源码决定 SIGWINCH 路径的 ROI（如果都不重查 OSC 11，SIGWINCH 路径就没用，只对 new agent 生效）

  **Acceptance Criteria**:
  - [ ] `.sisyphus/evidence/task-04-sigwinch-capability.md` 存在
  - [ ] 报告含 tmux signal 能力结论
  - [ ] 报告含 pgid 语义结论（vim 子进程能收到）
  - [ ] 报告含 SSH 路径可行性
  - [ ] 报告含 TUI 行为矩阵（vim/less/htop/OpenCode/Claude Code/Codex 是否在 SIGWINCH 后重查 OSC 11）
  - [ ] 推荐实现方案含「SIGWINCH 是否值得做」的判断（如果 TUI 都不重查，要写明 fallback）

  **QA Scenarios**:
  ```
  Scenario: SIGWINCH 实证（local）
    Tool: Bash + tmux
    Preconditions: 独立 tmux socket tmex-e2e-sig
    Steps:
      1. tmux -L tmex-e2e-sig new-session -d -s test
      2. tmux -L tmex-e2e-sig send-keys -t test 'vim' Enter
      3. 等 vim 启动（sleep 1）
      4. tmux -L tmex-e2e-sig display-message -p -t test '#{pane_pid}' → 拿 pid
      5. kill -WINCH <pid>
      6. 截图 vim 状态（观察是否 redraw）
    Expected Result: vim 收到 SIGWINCH 后 redraw（屏幕可能有视觉反馈）
    Evidence: .sisyphus/evidence/task-04-vim-sigwinch.png

  Scenario: 调研报告完整
    Tool: 人工 review
    Steps: 读报告，6 个调研点都有结论
    Expected Result: 可作为 Task 9 的实施 spec
    Evidence: .sisyphus/evidence/task-04-sigwinch-capability.md
  ```

  **Commit**: NO
  - Files: `.sisyphus/evidence/task-04-sigwinch-capability.md`

---

- [ ] 5. **SiteSettings.theme schema migration + API endpoint**

  **What to do**:
  - 读 `apps/gateway/src/db/schema.ts` 找 siteSettings 表定义
  - 给 siteSettings 表（singleton id=1）加 `theme` 列：
    - 类型：text，CHECK in ('dark', 'light')
    - DEFAULT 'dark'（保持现状）
    - NOT NULL
  - 生成 drizzle migration（`bun run db:generate` 或等价脚本）
  - 读 `apps/gateway/src/api/index.ts` + `apps/fe/src/stores/site.ts` 现有 site settings API
  - 新增端点：
    - `GET /api/settings/theme` → `{ theme: 'dark'|'light', serverTimestamp: number }`
    - `POST /api/settings/theme` body `{ theme: 'dark'|'light' }` → 服务器分配 `serverTimestamp = Date.now()`，写库，返回 `{ theme, serverTimestamp }`
    - **不采纳客户端 timestamp**（避免时钟漂移）
  - gateway 内存维护 `currentTheme` + `currentThemeTimestamp`（启动时从 DB 加载）
  - TDD：先写测试（bun test 覆盖 GET/POST、CHECK 约束拒绝非法值、DEFAULT 'dark'）

  **Must NOT do**:
  - 不实现 WS 广播（在 Task 10）
  - 不实现 useUIStore 改造（在 Task 11）
  - 不破坏现有 SiteSettings 其他字段

  **Recommended Agent Profile**:
  - **Category**: `quick` — 加列 + 两个 endpoint，模式清晰
  - **Skills**: [`test-driven-development`]

  **Parallelization**:
  - **Can Run In Parallel**: YES（与 T2/T3/T4/T6 并行）
  - **Parallel Group**: Wave 1
  - **Blocks**: 10, 11
  - **Blocked By**: 1

  **References**:
  - `apps/gateway/src/db/schema.ts` siteSettings 表
  - `apps/gateway/src/api/index.ts` 现有 settings API
  - `apps/fe/src/stores/site.ts` 现有 useSiteStore
  - `packages/shared/src/index.ts` SiteSettings 类型
  - `prompt-archives/2026061301-env-three-tier/` 三套环境约束（migration 不能从仓库 env 自动应用，仅 upgrade 时）
  - `apps/gateway/src/config.ts` 配置加载模式

  **WHY Each Reference Matters**:
  - `db/schema.ts` 是 schema 真源，drizzle migration 必须基于此生成
  - `api/index.ts` 是现有 API 模式（响应格式、错误处理、auth）
  - `stores/site.ts` 是前端消费模式参考（fetchSettings 流程）
  - `packages/shared/src/index.ts` 是前后端共享类型，新字段必须同步

  **Acceptance Criteria**:
  - [ ] siteSettings 表加 theme 列的 migration 文件存在
  - [ ] `GET /api/settings/theme` 返回正确格式
  - [ ] `POST /api/settings/theme` 写库 + 返回 serverTimestamp
  - [ ] POST 拒绝非法 theme 值（如 'blue'）
  - [ ] 单测覆盖全部 happy path + 边界
  - [ ] `bun test` 全过
  - [ ] biome + typecheck 无新增告警

  **QA Scenarios**:
  ```
  Scenario: GET 默认 theme
    Tool: Bash (curl)
    Preconditions: dev gateway 起在 :19884，DB 已 migrate
    Steps:
      1. curl http://localhost:19884/api/settings/theme
    Expected Result: 200 OK，body `{"theme":"dark","serverTimestamp":<number>}`
    Evidence: .sisyphus/evidence/task-05-get-default.txt

  Scenario: POST 更新 theme
    Tool: Bash (curl)
    Steps:
      1. curl -X POST -H "Content-Type: application/json" -d '{"theme":"light"}' http://localhost:19884/api/settings/theme
      2. curl http://localhost:19884/api/settings/theme
    Expected Result: POST 返回 200 `{"theme":"light","serverTimestamp":<t1>}`；GET 返回相同 theme + timestamp
    Evidence: .sisyphus/evidence/task-05-post-update.txt

  Scenario: 非法 theme 拒绝
    Tool: Bash (curl)
    Steps:
      1. curl -X POST -H "Content-Type: application/json" -d '{"theme":"blue"}' http://localhost:19884/api/settings/theme
    Expected Result: 400 或 422，DB 未变更
    Evidence: .sisyphus/evidence/task-05-reject-invalid.txt
  ```

  **Commit**: YES（groups with T6）
  - Message: `feat(theme): SiteSettings 加 theme 字段 + API`
  - Files: `apps/gateway/src/db/schema.ts`, `apps/gateway/src/db/migrations/*`, `apps/gateway/src/api/index.ts`, `packages/shared/src/index.ts`, 测试文件
  - Pre-commit: `bun test`

---

- [ ] 6. **主题色单一真源迁移到 @tmex/shared**

  **What to do**:
  - 读 `apps/fe/src/components/terminal/theme.ts` 全文，确认 XTERM_THEME_DARK/LIGHT 字段（bg/fg/cursor/selectionBackground/16-color）
  - 新建 `packages/shared/src/appearance.ts`：
    - 定义 `TerminalThemeColors` 类型（含 bg/fg/cursor/selectionBackground/16-color）
    - 导出 `TERMINAL_THEME_DARK` / `TERMINAL_THEME_LIGHT`（从 `apps/fe/src/components/terminal/theme.ts` 移植）
    - 导出 `getTmuxWindowStyle(theme)` 工具函数
    - 导出 `getOsc11ResponseColor(theme)` 返回 OSC 11 应答用的 rgb 字符串（如 `rgb:2626/2626/2626`）
  - 改 `apps/fe/src/components/terminal/theme.ts`：从 `@tmex/shared` 重新导出，保持现有 import path 兼容
  - 改 `apps/fe/src/stores/tmux.ts:148-152` `sendWindowStyleForCurrentTheme` 引用 shared
  - TDD：单测断言颜色值前后端一致、`getOsc11ResponseColor` 格式正确

  **Must NOT do**:
  - 不改前端 ghostty-wasm 的 theme 应用逻辑（line 332-338）
  - 不改主题切换 UI
  - 不删除前端 theme.ts（保留 re-export 避免大改 import）

  **Recommended Agent Profile**:
  - **Category**: `quick` — 纯重构 + 单测
  - **Skills**: [`test-driven-development`]

  **Parallelization**:
  - **Can Run In Parallel**: YES（与 T2/T3/T4/T5 并行）
  - **Parallel Group**: Wave 1
  - **Blocks**: 8, 10, 11
  - **Blocked By**: 1

  **References**:
  - `apps/fe/src/components/terminal/theme.ts:14-72` XTERM_THEME_DARK/LIGHT 现有定义
  - `apps/fe/src/components/terminal/theme.ts:69-72` getTmuxWindowStyle
  - `apps/fe/src/stores/tmux.ts:148-152` sendWindowStyleForCurrentTheme
  - `packages/shared/src/index.ts` 导出模式
  - `packages/shared/src/tmux-layout.ts` shared 包内 ts 文件组织参考

  **Acceptance Criteria**:
  - [ ] `packages/shared/src/appearance.ts` 存在并导出 TERMINAL_THEME_DARK/LIGHT + getTmuxWindowStyle + getOsc11ResponseColor
  - [ ] 前端 theme.ts 改为 re-export（行为不变）
  - [ ] 单测覆盖：颜色值前后端一致、getOsc11ResponseColor 格式（`rgb:RRRR/GGGG/BBBB` 16-bit per channel）
  - [ ] `bun test` 全过
  - [ ] typecheck + biome 干净

  **QA Scenarios**:
  ```
  Scenario: 颜色值前后端一致
    Tool: Bash (bun test)
    Steps:
      1. 跑单测断言 TERMINAL_THEME_DARK.background === '#262626'
      2. 跑单测断言 getOsc11ResponseColor('dark') === 'rgb:2626/2626/2626'
      3. 跑单测断言 getOsc11ResponseColor('light') === 'rgb:e1e1/e1e1/e1e1'
    Expected Result: 全部断言通过
    Evidence: .sisyphus/evidence/task-06-color-consistency.txt

  Scenario: 前端行为回归
    Tool: Playwright
    Steps:
      1. 启动 dev 实例 + 独立 tmux session
      2. 打开浏览器到 dark 主题，截图终端背景色
      3. 切到 light 主题，截图
      4. 断言两张截图背景色与 XTERM_THEME_DARK/LIGHT 一致
    Expected Result: 视觉无回归
    Evidence: .sisyphus/evidence/task-06-fe-regression-{dark,light}.png
  ```

  **Commit**: YES（groups with T5）
  - Message: `refactor(theme): 主题色单一真源迁移到 @tmex/shared`
  - Files: `packages/shared/src/appearance.ts`, `packages/shared/src/index.ts`, `apps/fe/src/components/terminal/theme.ts`, 测试

---

- [ ] 7. **Bug 1 修复（基于 Task 2 spike 结论）**

  **What to do**:
  - 读 `.sisyphus/evidence/task-02-bug1-root-cause.md`，按 spike 推荐方向实施
  - **TDD**：先写测试重现 bug（ghostty-terminal 单测 / SplitTerminalArea 集成测试）
  - 根据根因选择修复路径（可能多个叠加）：
    - **路径 A（resize 清 selection）**：改 `packages/ghostty-terminal/src/terminal.ts:593`，`resize()` 不再无条件 clearSelectionState；改为智能保留（仅当 viewport 范围真的变化时裁剪 selection 到新 viewport）
    - **路径 B（effect short-circuit）**：改 `apps/fe/src/components/terminal/SplitTerminalArea.tsx:200-206`，每个 pane 调 resize 前先判断 `term.cols === pane.cols && term.rows === pane.rows`，相等则跳过
    - **路径 C（layout 字符串稳定化）**：useMemo 解析结果做内容哈希稳定化（同字符串返回旧引用）
    - **路径 D（focusPane 路径修正）**：如 spike 发现 onUserSelectPane 走了完整 select，修正为同窗 focusPane 轻量路径
  - 验证：spike 用过的重现 case 必须通过（A 输出 + B 选取，selection 保留 ≥30s）
  - 不破坏现有 e2e：`terminal-selection-canvas` / `terminal-clipboard` / `ws-borsh-switch-barrier` 全过
  - 注意回归：现有「焦点切换清 selection」语义（plan-00-result.md 提到的 expected 行为）必须保留——切换**焦点 pane** 仍清 selection，但**对端 pane 输出**不清

  **Must NOT do**:
  - 不修复路径以外的「相关」问题（scope creep）
  - 不改 selection 模型（selection-model.ts）
  - 不破坏跨窗切换清 selection 的现有语义

  **Recommended Agent Profile**:
  - **Category**: `deep` — 修复涉及 ghostty 内部状态机或 React effect 副作用
  - **Skills**: [`test-driven-development`, `systematic-debugging`]

  **Parallelization**:
  - **Can Run In Parallel**: YES（与 T8/T9/T10/T11 并行）
  - **Parallel Group**: Wave 2
  - **Blocks**: 12, 14
  - **Blocked By**: 2

  **References**:
  - `.sisyphus/evidence/task-02-bug1-root-cause.md` spike 报告（**首选参考**）
  - `packages/ghostty-terminal/src/terminal.ts:584-597` resize
  - `packages/ghostty-terminal/src/terminal.ts:1599-1617` clearSelectionState
  - `packages/ghostty-terminal/src/selection-model.ts` selection 模型（裁剪到 viewport 用到）
  - `apps/fe/src/components/terminal/SplitTerminalArea.tsx:200-206` geometry effect
  - `apps/fe/src/components/terminal/SplitTerminalArea.tsx:184-190` 焦点切换 effect
  - `apps/fe/src/pages/DevicePage.tsx` isSplitView / onUserSelectPane / focusPane 路径
  - `apps/fe/src/stores/tmux.ts` focusPane / selectPane action
  - `prompt-archives/2026070200-split-screen/plan-00.md` 分屏架构（focusPane 设计意图）
  - `prompt-archives/2026061104-selection-column-space/plan-00-result.md` selection 模型
  - `e2e/specs/terminal-selection-canvas.spec.ts` 现有 selection e2e（回归基线）

  **WHY Each Reference Matters**:
  - spike 报告是首选，决定具体修复路径
  - `selection-model.ts` 路径 A 需要用其裁剪函数
  - `DevicePage` 路径 D 需要确认 onUserSelectPane 在分屏下的实际调用
  - 现有 e2e 是回归基线，不能破坏

  **Acceptance Criteria**:
  - [ ] TDD：先写重现测试（red），再修复（green），再重构（refactor）
  - [ ] spike 报告推荐路径全部实施
  - [ ] A 输出 + B 选取场景，selection 保留 ≥30s
  - [ ] 焦点切换场景仍清 selection（语义保留）
  - [ ] 现有 selection 相关 e2e 全过
  - [ ] `bun test` 全过 + typecheck + biome 干净

  **QA Scenarios**:
  ```
  Scenario: 修复后 selection 保持
    Tool: Playwright
    Preconditions: dev 实例 + 独立 tmux socket
    Steps:
      1. 浏览器打开 dev URL，分屏 splitRight
      2. A pane 跑 `for i in $(seq 1 600); do echo "tick $i"; sleep 0.05; done`（30s）
      3. B pane 拖拽选取一段文字（如 prompt 输出）
      4. 等待 5s / 15s / 30s 各截图
      5. 断言 selection 高亮 DOM（如 .xterm-selection-layer 内有 rect）在 30s 后仍存在
    Expected Result: 30s 后 selection 高亮仍在
    Failure Indicators: 任何时间点 selection 高亮消失
    Evidence: .sisyphus/evidence/task-07-selection-persist-{5s,15s,30s}.png

  Scenario: 焦点切换仍清 selection（语义保留）
    Tool: Playwright
    Steps:
      1. 分屏 A/B，B 选取文字
      2. 点击 A pane 切焦点
      3. 截图 B
    Expected Result: B 的 selection 被清空（保留现有 expected 语义）
    Evidence: .sisyphus/evidence/task-07-focus-clears-selection.png

  Scenario: 现有 e2e 回归
    Tool: Bash (bun test)
    Steps:
      1. bun test e2e/specs/terminal-selection-canvas.spec.ts
      2. bun test e2e/specs/terminal-clipboard.spec.ts
      3. bun test e2e/specs/ws-borsh-switch-barrier.spec.ts
    Expected Result: 全过（既有失败按现状 baseline）
    Evidence: .sisyphus/evidence/task-07-regression.txt
  ```

  **Commit**: YES
  - Message: `fix(split): 修复分屏对端输出时本端 selection 被清空`
  - Files: 改动的 ghostty-terminal / SplitTerminalArea / 相关测试
  - Pre-commit: `bun test`

---

- [ ] 8. **gateway OSC 11/10 拦截代答（基于 Task 3 spike）**

  **What to do**:
  - 读 `.sisyphus/evidence/task-03-osc-write-channel.md`，按推荐方案 + fallback 实施
  - **方案 A（若 ghostty-wasm 自己答 OSC 11）**：前端方案
    - 验证 ghostty-wasm 在 setTheme 后会自动应答 OSC 11
    - 验证应答字节流从 ghostty-wasm → terminal.ts → 反向注入 pane stdin（关键：注入路径）
    - 改 ghostty-terminal terminal.ts：在 setTheme 后，若收到 OSC 11 query，主动调 bindings.writeToPty 注入应答（如 wasm 暴露此 API）
  - **方案 B（gateway 拦截代答，主推）**：
    - 改 `apps/gateway/src/tmux-client/pane-stream-parser.ts`：
      - OSC state machine 内识别 `OSC 10 ; ? ST` 和 `OSC 11 ; ? ST`（注意跨 chunk 安全）
      - 拦截查询（吃掉这些字节不传给前端，避免 ghostty-wasm 重复处理）
      - 触发回调 `onOscColorQuery(kind: 'fg'|'bg')`
    - 改 `apps/gateway/src/tmux-client/control-mode-subscription.ts`：注入 `onOscColorQuery` 回调，调 gateway 的应答注入
    - gateway ws/index.ts 维护 `currentTheme` 内存状态（来自 SiteSettings.theme）
    - 应答注入路径（按 spike 推荐排序）：通过 spike 验证可行的 raw pty write 通道注入 `ESC]11;rgb:RRRR/GGGG/BBBB ST` 字节
    - **严格 per-pane**：应答只发给查询方 pane，不能广播（参考 Codex issue #4759 stdin 污染教训）
  - **方案 C（fallback，B 不可行时）**：纯 SIGWINCH 路径，让 TUI 重发 OSC 11（仅 TUI 配合时有效）
  - 主题色来源：`getOsc11ResponseColor(currentTheme)` from `@tmex/shared/appearance`
  - gateway currentTheme 变化时（来自 Task 10 WS 广播），下次 OSC 查询自然拿到新色，无需主动通知
  - TDD：byte stream fixture 单测（OSC 11 单 chunk / 跨 chunk / 设置非查询 / 与其他 OSC 混合）
  - 实证：dev 实例 + 独立 tmux socket + 一个 mock TUI（写一个简单脚本发 OSC 11 然后读 stdin）验证代答到达

  **Must NOT do**:
  - 不实现 OSC 4 调色板代答（v1 排除）
  - 不用 `tmux send-keys -l` 注入应答（spike 已证不可行）
  - 不向 ghostty-wasm 同步 OSC 应答（避免双路径冲突）

  **Recommended Agent Profile**:
  - **Category**: `deep` — byte stream 解析 + 跨进程注入，高风险
  - **Skills**: [`test-driven-development`, `systematic-debugging`]

  **Parallelization**:
  - **Can Run In Parallel**: YES（与 T7/T9/T10/T11 并行，但 T8 与 T9 有概念关联）
  - **Parallel Group**: Wave 2
  - **Blocks**: 12, 14
  - **Blocked By**: 3, 6

  **References**:
  - `.sisyphus/evidence/task-03-osc-write-channel.md` spike 报告（**首选参考**）
  - `apps/gateway/src/tmux-client/pane-stream-parser.ts:340-353` OSC 白名单
  - `apps/gateway/src/tmux-client/control-mode-subscription.ts:51-154` parser 调用
  - `apps/gateway/src/tmux-client/local-external-connection.ts:265-281` sendInput（注入路径参考）
  - `apps/gateway/src/tmux-client/local-external-connection.ts:497-508,627-663` setWindowStyle / configureWindowStyle（已存在的代答基础设施）
  - `apps/gateway/src/ws/index.ts:911-915` handleSetWindowStyle
  - `packages/shared/src/appearance.ts`（T6 产出）主题色真源
  - 行业参考：
    - tmux 源码 `input.c` OSC 11 应答实现（字节格式参考）
    - OpenAI Codex `terminal_probe.rs` + `terminal_palette.rs` OSC 11 查询格式
    - Codex issue #4759 stdin 污染教训（应答字节隔离）

  **WHY Each Reference Matters**:
  - spike 报告决定方案选择（A/B/C）
  - `pane-stream-parser.ts:340` 是拦截实现入口
  - `local-external-connection.ts:265` sendInput 是字节注入参考，但 OSC 应答需要 raw 通道（不能走 send-keys）
  - `appearance.ts` 是色值真源，必须用 getOsc11ResponseColor

  **Acceptance Criteria**:
  - [ ] pane-stream-parser 识别 OSC 10/11 查询（跨 chunk 安全）
  - [ ] 拦截查询不传给前端
  - [ ] 代答字节注入到查询方 pane（**严格 per-pane**）
  - [ ] 单测：OSC 11 单 chunk / 跨 chunk / 设置非查询 / 混合 OSC 全过
  - [ ] 实证：mock TUI 收到正确格式代答
  - [ ] 主题切换后，下次 OSC 查询拿到新色（端到端）
  - [ ] `bun test` 全过

  **QA Scenarios**:
  ```
  Scenario: OSC 11 查询代答（mock TUI）
    Tool: Bash
    Preconditions: dev 实例 + 独立 tmux socket，OSC 拦截已部署
    Steps:
      1. 创建 mock TUI 脚本：`printf '\e]11;?\a'; head -c 50 /dev/stdin | xxd`
      2. tmux -L tmex-e2e-osc send-keys -t test 'sh mock.sh' Enter
      3. 等待 1s
      4. capture-pane：`tmux -L tmex-e2e-osc capture-pane -t test -p`
    Expected Result: capture-pane 输出含 `1b5d3131 3b726762 3a...` 即 ESC]11;rgb:...
    Failure Indicators: pane 内看不到代答字节（被 shell 吃了 / 注入路径错）
    Evidence: .sisyphus/evidence/task-08-osc-reply.txt

  Scenario: 跨 chunk 安全
    Tool: Bash (bun test)
    Steps:
      1. 单测：parser 喂 `Buffer.from([0x1b, 0x5d, 0x31, 0x31])`（ESC]11）+ 下一 chunk `;?\a`
      2. 断言 onOscColorQuery 回调被调用一次
    Expected Result: 测试通过
    Evidence: .sisyphus/evidence/task-08-cross-chunk-test.txt

  Scenario: 主题切换后下次查询拿到新色
    Tool: Bash
    Steps:
      1. 默认 dark，mock TUI 查 OSC 11 → 应返 rgb:2626/2626/2626
      2. POST /api/settings/theme {"theme":"light"}
      3. mock TUI 再查 OSC 11 → 应返 rgb:e1e1/e1e1/e1e1
    Expected Result: 两次查询返回不同色
    Evidence: .sisyphus/evidence/task-08-theme-switch.txt
  ```

  **Commit**: YES
  - Message: `feat(theme): gateway 拦截 OSC 11/10 查询并代答当前主题色`
  - Files: pane-stream-parser.ts, control-mode-subscription.ts, ws/index.ts, local/ssh-external-connection.ts, 测试
  - Pre-commit: `bun test`

---

- [ ] 9. **gateway SIGWINCH 推送（基于 Task 4 spike）**

  **What to do**:
  - 读 `.sisyphus/evidence/task-04-sigwinch-capability.md`，按 spike 推荐方案实施
  - **如果 spike 结论是 SIGWINCH 路径无效（TUI 不重查 OSC 11）**：本任务降级为 stub，只为 Task 12 的 resize 同步留接口；明确文档说明「SIGWINCH 路径仅对支持 TUI 生效，Codex 等不重查的 agent 需重启」
  - **如果 spike 结论是 SIGWINCH 有效**：
    - `apps/gateway/src/tmux-client/device-session-runtime.ts` 接口加 `signalPaneForegroundGroup(deviceId, paneId, signal: 'SIGWINCH')`
    - `local-external-connection.ts` 实现：
      - `display-message -p -t <pane> '#{pane_pid}'` 拿 pid
      - 找前台进程组：`ps -o tpgid= -p <pid>` 或读 `/proc/<pid>/stat`
      - `Bun.process.kill(-<pgid>, 'SIGWINCH')`（负数表示进程组）
    - `ssh-external-connection.ts` 实现：通过 SSH exec channel 跑 `kill -WINCH -<pgid>`
    - gateway ws/index.ts 加 `handleSetTheme` 钩子：theme 变化时（来自 POST /api/settings/theme），对所有已连接设备的所有 pane 发 SIGWINCH
    - 节流：同一设备同主题 1s 内去重
  - **绝不调 ioctl TIOCSWINSZ**（用户硬性约束）
  - TDD：mock external-connection 单测验证调用
  - 实证：vim 在 dark/light 切换后 redraw（如果 vim 收到 SIGWINCH）

  **Must NOT do**:
  - 不附带新 winsize（绝不调 TIOCSWINSZ）
  - 不向生产 tmux session 发 signal
  - 不向已离线设备发（gateway 自然跳过）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — 跨平台 signal 语义，中高复杂度
  - **Skills**: [`test-driven-development`]

  **Parallelization**:
  - **Can Run In Parallel**: YES（与 T7/T8/T10/T11 并行）
  - **Parallel Group**: Wave 2
  - **Blocks**: 12, 14
  - **Blocked By**: 4

  **References**:
  - `.sisyphus/evidence/task-04-sigwinch-capability.md` spike 报告（首选）
  - `apps/gateway/src/tmux-client/device-session-runtime.ts:11-54` runtime 接口
  - `apps/gateway/src/tmux-client/local-external-connection.ts:265-281,497-663` sendInput / setWindowStyle（实现模式参考）
  - `apps/gateway/src/tmux-client/ssh-external-connection.ts` SSH exec channel
  - `apps/gateway/src/tmux-client/device-session-runtime.test.ts:31,108` mock 模式（test 写法参考）
  - Bun 文档 `Bun.process.kill`

  **WHY Each Reference Matters**:
  - spike 报告决定本任务工作量（有效 vs stub）
  - `device-session-runtime.ts` 是接口真源，必须先扩接口
  - `device-session-runtime.test.ts:31` 现有 mock 模式，新接口测试沿用

  **Acceptance Criteria**:
  - [ ] runtime 接口加 signalPaneForegroundGroup（即使 stub 也加接口）
  - [ ] local / ssh 双实现（或 stub 含 TODO 注释 + 文档说明）
  - [ ] POST /api/settings/theme 后调用一次（节流去重生效）
  - [ ] 单测：mock external-connection 验证调用次数 + 参数
  - [ ] 实证：vim 在主题切换后 redraw（如 SIGWINCH 有效）
  - [ ] 不调 TIOCSWINSZ（grep 改动文件无 `TIOCSWINSZ`）

  **QA Scenarios**:
  ```
  Scenario: SIGWINCH 触发 vim redraw（如有效）
    Tool: Bash + tmux
    Preconditions: dev 实例 + 独立 tmux socket，vim 在 pane 内运行
    Steps:
      1. tmux send-keys -t test 'vim' Enter，等启动
      2. 截图 vim 当前状态
      3. POST /api/settings/theme {"theme":"light"}
      4. 等待 500ms，截图 vim
    Expected Result: 第二张截图 vim 有 redraw 痕迹（如状态栏变化、屏幕闪动）— 或文档说明 vim 不重查 OSC 11 时如何识别
    Evidence: .sisyphus/evidence/task-09-vim-redraw-{before,after}.png

  Scenario: 不附带 TIOCSWINSZ
    Tool: Bash
    Steps:
      1. git diff 改动文件 | grep TIOCSWINSZ
    Expected Result: 无输出
    Evidence: .sisyphus/evidence/task-09-no-winsize.txt

  Scenario: 节流去重
    Tool: Bash (bun test)
    Steps:
      1. mock external-connection
      2. 1s 内连发 5 次 theme 变化
      3. 断言 signalPaneForegroundGroup 调用 ≤1 次
    Expected Result: 测试通过
    Evidence: .sisyphus/evidence/task-09-throttle.txt
  ```

  **Commit**: YES
  - Message: `feat(theme): gateway 主题切换时向 pane 前台进程组发 SIGWINCH`
  - Files: device-session-runtime.ts, local/ssh-external-connection.ts, ws/index.ts, 测试
  - Pre-commit: `bun test`

---

- [ ] 10. **WS 主题广播协议 + 服务器 timestamp last-winner-wins**

  **What to do**:
  - `packages/shared/src/ws-borsh/kind.ts`：加 `KIND_SITE_THEME_UPDATE`（选未占用 kind，参考现有 0x020d-0x0212 split 系列，新 site-level 用 0x0300 段）
  - `packages/shared/src/ws-borsh/schema.ts`：定义 schema
    - C2S payload: `{ theme: Enum8<0=dark, 1=light> }`（不带 clientTimestamp，避免时钟漂移）
    - S2C payload: `{ theme: Enum8, serverTimestamp: u64 }`
  - `packages/shared/src/ws-borsh/index.ts` 导出
  - `apps/fe/src/ws-borsh/message-builder.ts` 加 buildSiteThemeUpdate（C2S）
  - `apps/gateway/src/ws/index.ts`：
    - handler `handleSiteThemeUpdate(ws, decoded)`：
      - 校验 theme ∈ {'dark','light'}
      - `Date.now()` 分配 serverTimestamp
      - 写 SiteSettings 表（调 Task 5 的 service）
      - 更新内存 currentTheme + currentThemeTimestamp
      - **触发 OSC 代答色更新**（Task 8 的 currentTheme 同源）
      - **触发 SIGWINCH 推送**（Task 9 的 handleSetTheme 钩子）
      - 广播 KIND_SITE_THEME_UPDATE（S2C）给所有 connected ws clients（**包括发送方**，确认一致性）
  - `apps/fe/src/stores/tmux.ts` 监听 S2C：
    - 收到时调 `useUIStore.getState().setTheme(decoded.theme)`
    - **不引发向 gateway 回送 C2S**（避免循环）
  - last-writer-wins：服务器串行处理 POST/WS，最后到达的胜出，serverTimestamp 严格递增
  - TDD：单测覆盖 borsh 序列化 round-trip、广播路由、并发覆盖（两 client 几乎同时发，最后写入的胜出）
  - 文档：`docs/ws-protocol/` 加新 kind 说明（日期编号规则）

  **Must NOT do**:
  - 不让客户端带 timestamp 上报（必须服务器侧）
  - 不在 setTheme 时回送 C2S（避免循环）
  - 不破坏现有 KIND_TERM_* / KIND_TMUX_* 协议

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — ws-borsh 协议扩展 + 并发控制
  - **Skills**: [`test-driven-development`]

  **Parallelization**:
  - **Can Run In Parallel**: YES（与 T7/T8/T9/T11 并行，但 T10 与 T11 紧耦合）
  - **Parallel Group**: Wave 2
  - **Blocks**: 11, 12, 14
  - **Blocked By**: 5, 6

  **References**:
  - `packages/shared/src/ws-borsh/kind.ts:28` KIND_TMUX_SET_WINDOW_STYLE（kind 编号参考）
  - `packages/shared/src/ws-borsh/schema.ts:117` TmuxSetWindowStyleSchema（schema 模式参考）
  - `packages/shared/src/ws-borsh/index.ts:28` 导出模式
  - `apps/fe/src/ws-borsh/message-builder.ts:110` buildTmuxSetWindowStyle（builder 模式）
  - `apps/fe/src/stores/tmux.ts:148-152,378-389` sendWindowStyleForCurrentTheme + 主题监听（改造点）
  - `apps/gateway/src/ws/index.ts:371-372,911-915` KIND_TMUX_SET_WINDOW_STYLE handler + handleSetWindowStyle
  - `apps/gateway/src/ws/index.ts:448` HelloS2C.capabilities（可考虑加 'tmex-site-theme-v1'）
  - `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md` 协议规范
  - `prompt-archives/2026021402-tmux-rewrite-ws-borsh/` ws-borsh 历史背景

  **WHY Each Reference Matters**:
  - kind.ts / schema.ts 决定 kind 编号和数据布局
  - 现有 TMUX_SET_WINDOW_STYLE 是最相似的 C2S+S2C 模式，复用其架构
  - `stores/tmux.ts:378-389` 是前端响应主题变化的入口
  - `ws/index.ts:911` 是 gateway 处理主题变化的核心，要在此挂 OSC + SIGWINCH 触发

  **Acceptance Criteria**:
  - [ ] KIND_SITE_THEME_UPDATE 在 kind.ts / schema.ts / index.ts 定义
  - [ ] gateway handler 完整：校验 → 写库 → 内存更新 → 触发 OSC/SIGWINCH → 广播
  - [ ] 前端监听 S2C，更新 useUIStore，不回送 C2S
  - [ ] 单测：borsh round-trip、广播路由、并发 last-writer-wins
  - [ ] 实证：两浏览器窗口，A 切主题，B <1s 同步
  - [ ] 现有 ws-borsh e2e 全过（回归）

  **QA Scenarios**:
  ```
  Scenario: 跨网页广播同步
    Tool: Playwright（两 context）
    Preconditions: dev 实例 + 两个浏览器 context 都连上
    Steps:
      1. Context A 和 B 都打开 dev URL，记录初始 theme
      2. Context A 调用 setTheme('light')
      3. 等 1s
      4. Context B 内读 useUIStore.theme
    Expected Result: Context B 的 theme === 'light'
    Evidence: .sisyphus/evidence/task-10-cross-window-sync.txt

  Scenario: 并发 last-writer-wins
    Tool: Bash (buntest)
    Steps:
      1. mock 两个 ws client
      2. 几乎同时发 theme=dark 和 theme=light
      3. 断言最终 SiteSettings.theme 等于后到达的，且 serverTimestamp 严格递增
      4. 断言广播 S2C 含最终 theme
    Expected Result: 测试通过
    Evidence: .sisyphus/evidence/task-10-concurrent.txt

  Scenario: 不回送循环
    Tool: Bash (bun test)
    Steps:
      1. mock ws client 发 C2S theme=light
      2. 收 S2C 后立即再发 C2S（模拟前端误回送）
      3. handler 应正常处理（不无限循环）
      4. 单测：前端 stores/tmux.ts 监听 S2C 时不触发 C2S buildSiteThemeUpdate
    Expected Result: 单测验证 stores/tmux.ts 的监听器不调 send
    Evidence: .sisyphus/evidence/task-10-no-loopback.txt
  ```

  **Commit**: YES
  - Message: `feat(theme): WS 主题广播协议 KIND_SITE_THEME_UPDATE + 服务器 timestamp LWW`
  - Files: packages/shared/src/ws-borsh/*, apps/gateway/src/ws/index.ts, apps/fe/src/stores/tmux.ts, apps/fe/src/ws-borsh/message-builder.ts, 测试, docs/ws-protocol/*
  - Pre-commit: `bun test`

---

- [ ] 11. **前端 useUIStore.theme 改为从 useSiteStore 派生**

  **What to do**:
  - 读 `apps/fe/src/stores/ui.ts:44-114` 现有 useUIStore
  - 读 `apps/fe/src/stores/site.ts:36-73` useSiteStore
  - **改造方案**：
    - useSiteStore 增加 `theme` 字段（从 GET /api/settings/theme 加载）
    - useUIStore.theme 改为 getter：从 useSiteStore.theme 读取（保留 useUIStore 兼容现有 import）
    - 或：useUIStore 直接删除 theme 字段，所有调用方改用 useSiteStore（评估改动量后决定）
  - **localStorage 作为离线 fallback**：
    - 启动流程：先读 localStorage 即时反馈 → fetch /api/settings/site 覆盖
    - 切换流程：调 `useSiteStore.updateTheme(newTheme)` → 内部发 WS C2S（Task 10） → 乐观更新本地 state → 等 S2C 确认
    - 离线场景：写 localStorage，等重连后上报
  - **同步现有钩子**：
    - `apps/fe/src/main.tsx:24-41` applyInitialTheme() 继续读 localStorage 避免首屏闪烁
    - `apps/fe/src/stores/tmux.ts:378-389` useUIStore.subscribe(theme) 改为订阅 useSiteStore
    - `apps/fe/src/components/terminal/Terminal.tsx:187-194,332-338` useMemo(terminalTheme) + setTheme 逻辑保持，订阅源改
    - `apps/fe/src/pages/SettingsPage.tsx:77-98` setTheme UI 调用方改
    - `apps/fe/src/components/page-layouts/components/sidebar-title.tsx:26-30` 同上
  - TDD：单测覆盖派生正确性、localStorage fallback、离线场景、回送避免
  - 视觉回归：dark → light → dark 切换流畅，无闪烁

  **Must NOT do**:
  - 不删除 localStorage 'tmex-ui'（保留离线 fallback）
  - 不破坏现有 useUIStore 其他字段（sidebarCollapsed / inputMode / terminalFontSize 等）
  - 不引入 prefers-color-scheme（v1 排除）

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering` — 涉及前端 store 重构 + 主题切换 UX
  - **Skills**: [`test-driven-development`, `frontend-design`]

  **Parallelization**:
  - **Can Run In Parallel**: NO（紧耦合 T10，且改前端多文件）
  - **Parallel Group**: Wave 2 末尾
  - **Blocks**: 12, 14
  - **Blocked By**: 5, 10

  **References**:
  - `apps/fe/src/stores/ui.ts:44-114` useUIStore 现状
  - `apps/fe/src/stores/site.ts:36-73` useSiteStore 现状
  - `apps/fe/src/main.tsx:1-50` applyInitialTheme
  - `apps/fe/src/stores/tmux.ts:148-152,378-389` 主题监听
  - `apps/fe/src/components/terminal/Terminal.tsx:187-194,332-338,296` theme 应用
  - `apps/fe/src/components/terminal/theme.ts:69-72` getTmuxWindowStyle
  - `apps/fe/src/pages/SettingsPage.tsx:77-98` 主题切换 UI
  - `apps/fe/src/components/page-layouts/components/sidebar-title.tsx:26-30` 主题切换 UI 入口

  **WHY Each Reference Matters**:
  - ui.ts + site.ts 决定 store 重构方案
  - main.tsx applyInitialTheme 不能破坏（首屏闪烁风险）
  - tmux.ts:378 是订阅源切换点
  - Terminal.tsx:332 是终端实例色应用点

  **Acceptance Criteria**:
  - [ ] useSiteStore 加 theme 字段 + 加载逻辑
  - [ ] useUIStore.theme 派生（或保留兼容）
  - [ ] localStorage 'tmex-ui' 仍作为离线 fallback
  - [ ] 切主题：乐观更新本地 → 等 S2C 确认（不回送 C2S）
  - [ ] 离线场景：写 localStorage，重连后上报
  - [ ] 单测覆盖全部场景
  - [ ] 现有终端 setTheme / tmux window-style / applyInitialTheme 行为不回归

  **QA Scenarios**:
  ```
  Scenario: 切换流畅无闪烁
    Tool: Playwright
    Steps:
      1. 打开 dark 主题，截图
      2. 切到 light，立即截图（0ms / 100ms / 500ms）
      3. 切回 dark
    Expected Result: 截图无中间闪烁状态
    Evidence: .sisyphus/evidence/task-11-theme-switch-{0,100,500}ms.png

  Scenario: 离线 fallback
    Tool: Playwright
    Steps:
      1. 离线（mock fetch 失败）
      2. 切主题 → 应写 localStorage
      3. 重启浏览器（清空内存 state）
      4. 应用启动读 localStorage → 应反映切过的主题
      5. 重连 gateway → 等 S2C 可能覆盖
    Expected Result: 离线期间主题切换本地生效，重连后与服务器同步
    Evidence: .sisyphus/evidence/task-11-offline-fallback.txt

  Scenario: 终端实例同步
    Tool: Playwright
    Steps:
      1. 打开终端（dark）
      2. 切到 light
      3. 截图终端背景色 → 应与 XTERM_THEME_LIGHT.background 一致
    Expected Result: 终端背景色跟随主题切换
    Evidence: .sisyphus/evidence/task-11-terminal-sync.png
  ```

  **Commit**: YES
  - Message: `refactor(theme): 前端主题真源迁移到 useSiteStore + localStorage fallback`
  - Files: apps/fe/src/stores/*, apps/fe/src/components/terminal/Terminal.tsx, apps/fe/src/pages/SettingsPage.tsx, 测试
  - Pre-commit: `bun test`

---

- [ ] 12. **主题切换 × 客户端 resize 互踩处理（用户硬性约束）**

  **What to do**:
  - 用户硬性约束：「处理客户端 resize 时也要发主题同步消息；避免主题同步导致终端尺寸意外变化」
  - **resize 路径发主题同步**：
    - `apps/fe/src/components/terminal/useTerminalResize.ts` 在 `reportSize('resize' | 'sync')` 成功后，**附加**触发一次主题同步消息（如 `useTmuxStore.getState().syncThemeAfterResize()`）
    - 该同步消息走 KIND_TMUX_SET_WINDOW_STYLE（已有路径，不动 tmux 真状态）+ 触发 gateway OSC 代答色更新（Task 8 currentTheme 同源）
    - 节流：与 resize 防抖同节奏（150ms）
  - **主题同步不带尺寸**：
    - gateway handleSetWindowStyle / handleSiteThemeUpdate 内绝不调 resize-window / resize-pane
    - gateway SIGWINCH 推送绝不调 ioctl TIOCSWINSZ（Task 9 已锁定，本任务 audit）
  - **gateway 去重缓存**：
    - 维护 `lastBroadcastTheme` + `lastBroadcastSize` per device
    - 同主题不重发 OSC/SIGWINCH（Task 9 已节流，本任务 audit）
    - resize 路径触发的主题同步如主题未变，gateway 跳过广播
  - **跨客户端并发**：
    - 客户端 A resize + 客户端 B 切主题几乎同时 → gateway 串行处理（已有 WS 串行模型） → 一致性自然达成
  - e2e：快速切主题 × 同时拖浏览器窗口尺寸，验证 pane cols/rows 稳定

  **Must NOT do**:
  - 不改 KIND_TERM_RESIZE 协议本身（保持纯 resize 语义）
  - 不在 SIGWINCH 推送时附带 winsize
  - 不让主题同步消息触发 resize-window

  **Recommended Agent Profile**:
  - **Category**: `deep` — 并发解耦 + 副作用 audit
  - **Skills**: [`systematic-debugging`, `test-driven-development`]

  **Parallelization**:
  - **Can Run In Parallel**: NO（依赖 Wave 2 所有任务完成）
  - **Parallel Group**: Wave 3 头部
  - **Blocks**: 14
  - **Blocked By**: 7, 8, 9, 10, 11

  **References**:
  - `apps/fe/src/components/terminal/useTerminalResize.ts:108-168` reportSize
  - `apps/fe/src/components/terminal/useTerminalResize.ts:170-205` scheduleResize 防抖
  - `apps/fe/src/components/terminal/SplitTerminalArea.tsx:200-281` 分屏 resize effect + RO
  - `apps/gateway/src/ws/index.ts` handleTermResize / handleSetWindowStyle / handleSiteThemeUpdate
  - `apps/gateway/src/tmux-client/local-external-connection.ts:265-281` sendInput
  - `apps/gateway/src/tmux-client/local-external-connection.ts:627-663` configureWindowStyle
  - `.sisyphus/evidence/task-04-sigwinch-capability.md` SIGWINCH 不带 winsize 验证

  **WHY Each Reference Matters**:
  - `useTerminalResize.ts:108` 是 resize 后挂主题同步的入口
  - `SplitTerminalArea.tsx:200` 分屏 resize 与主题同步的协同点
  - gateway ws/index.ts 是 audit 重点（确认 handler 间不互踩）

  **Acceptance Criteria**:
  - [ ] resize 成功后触发主题同步（节流 150ms）
  - [ ] gateway 主题相关 handler（set-window-style / site-theme-update）不触发 resize-window / resize-pane
  - [ ] SIGWINCH 推送不附带 TIOCSWINSZ
  - [ ] gateway lastBroadcastTheme/Size 缓存生效，重复广播跳过
  - [ ] e2e：快速切主题 × 同时 resize 浏览器，pane cols/rows 稳定（变化 <2 cells）
  - [ ] bun test + typecheck + biome 干净

  **QA Scenarios**:
  ```
  Scenario: 切主题不导致尺寸变化
    Tool: Playwright
    Steps:
      1. 分屏稳定后记录 A/B cols/rows（用 __tmexE2eTerminal.cols/rows）
      2. 快速切主题 dark → light → dark 5 次
      3. 再次记录 cols/rows
    Expected Result: cols/rows 与初始一致（变化为 0）
    Evidence: .sisyphus/evidence/task-12-theme-no-resize-impact.txt

  Scenario: resize 触发主题同步
    Tool: Bash (bun test) + DevTools
    Steps:
      1. mock：浏览器 resize 触发 KIND_TERM_RESIZE
      2. 单测断言：150ms 内同时发出 KIND_TMUX_SET_WINDOW_STYLE（或 site-theme-update）
    Expected Result: 测试通过
    Evidence: .sisyphus/evidence/task-12-resize-triggers-theme-sync.txt

  Scenario: 高频切换互踩
    Tool: Playwright
    Steps:
      1. 模拟：100ms 内连发 5 次 resize + 3 次主题切换
      2. 等待 2s 收敛
      3. 验证：最终 pane 尺寸 = 浏览器测量尺寸，最终主题 = 最后一次切换
    Expected Result: 收敛后状态正确，无中间错乱
    Evidence: .sisyphus/evidence/task-12-concurrent-storm.txt
  ```

  **Commit**: YES
  - Message: `feat(theme): resize × 主题同步解耦 + 服务器去重缓存`
  - Files: useTerminalResize.ts, ws/index.ts, 测试
  - Pre-commit: `bun test`

---

- [ ] 13. **SSH 设备 OSC 代答时延 + 并发场景验证**

  **What to do**:
  - 读 Task 8 + Task 9 实现，确认 SSH 路径
  - **时延优化**：
    - SSH channel 写入代答字节后立即 flush（如 ssh-external-connection.ts 用 stream API）
    - 监控：在 ssh external-connection 加 timing log（仅 dev 环境，`if (config.debug)`）
  - **Codex 100ms 超时窗口**：
    - 实证：SSH 设备 pane 跑 codex（如可用），观察 OSC 11 代答到达时延
    - 如果 >100ms：考虑在 SSH channel 层本地代答（即 ssh-external-connection 内直接处理 OSC 拦截，不 round-trip gateway 主进程）— 评估架构成本
  - **并发场景**：
    - 多个 SSH 设备同时切主题：gateway 串行处理，无丢消息
    - 同一 SSH 设备多 pane 同时查 OSC 11：parser per-pane，应正常
  - SSH channel 断连重连后代答状态恢复

  **Must NOT do**:
  - 不向生产 SSH 设备发请求（用 mock SSH 或测试设备）
  - 不破坏 SSH external-connection 现有 sendInput 路径

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — SSH 时延调优 + 并发验证
  - **Skills**: [`systematic-debugging`]

  **Parallelization**:
  - **Can Run In Parallel**: YES（与 T12 部分并行，与 T14 串行）
  - **Parallel Group**: Wave 3
  - **Blocks**: 14
  - **Blocked By**: 8, 9

  **References**:
  - `apps/gateway/src/tmux-client/ssh-external-connection.ts` SSH channel 操作
  - `apps/gateway/src/tmux-client/ssh-external-connection.ts:396-403,639-680` setWindowStyle / configureWindowStyle
  - `apps/gateway/src/tmux-client/ssh-external-connection.test.ts` 测试模式
  - `.sisyphus/evidence/task-03-osc-write-channel.md` SSH 注入路径调研结论
  - OpenAI Codex `terminal_probe.rs` 100ms 超时常量

  **Acceptance Criteria**:
  - [ ] SSH OSC 代答时延 <500ms（LAN）/<3s（WAN）
  - [ ] Codex 在 SSH 设备内启动探测不超时（如可用 Codex 实证）
  - [ ] 多 SSH 设备并发切主题无丢消息
  - [ ] SSH 断连重连后代答状态恢复
  - [ ] 单测 + 集成测试覆盖

  **QA Scenarios**:
  ```
  Scenario: SSH OSC 代答时延
    Tool: Bash + timing log
    Preconditions: mock SSH 设备（或测试 SSH host）
    Steps:
      1. 在 SSH pane 内发 OSC 11 查询
      2. timing log 记录 t_query / t_reply
      3. 重复 10 次取平均
    Expected Result: 平均时延 <500ms（LAN）
    Evidence: .sisyphus/evidence/task-13-ssh-latency.txt

  Scenario: 多设备并发切主题
    Tool: Bash
    Steps:
      1. mock 3 个 SSH 设备连上
      2. 几乎同时切主题（POST /api/settings/theme）
      3. 验证每个设备的 OSC 代答色一致 + SIGWINCH 都收到
    Expected Result: 3 个设备状态最终一致
    Evidence: .sisyphus/evidence/task-13-multi-device.txt

  Scenario: SSH 重连恢复
    Tool: Bash
    Steps:
      1. SSH 设备正常连上，记录主题
      2. 断开 SSH（mock 网络中断）
      3. 期间切主题（gateway 已广播，SSH 设备离线）
      4. SSH 重连
      5. 验证 SSH 设备 OSC 代答色 = 最新主题色
    Expected Result: 重连后状态同步
    Evidence: .sisyphus/evidence/task-13-ssh-reconnect.txt
  ```

  **Commit**: YES
  - Message: `perf(theme): SSH 设备 OSC 代答时延优化 + 并发场景验证`
  - Files: ssh-external-connection.ts, 测试
  - Pre-commit: `bun test`

---

- [ ] 14. **e2e 测试套件（bug 1 + bug 2 + 跨设备广播）**

  **What to do**:
  - 新增 `e2e/specs/split-selection-persistence.spec.ts`：
    - 桌面 1280×800：split-pane，A 跑持续输出 30s，B 选取文字，断言 selection 在 5s / 15s / 30s 后仍在
    - 多 pane 场景（2×2 split）：任一 pane 输出不影响其他 selection
    - 焦点切换仍清 selection（保留现有 expected 语义）
  - 新增 `e2e/specs/theme-propagation.spec.ts`：
    - 单网页：切 dark → light，断言 xterm 背景色变化（DOM 断言 .xterm-screen background）
    - tmux window-style 更新（curl /api/settings/theme 验证）
    - pane 内 mock TUI 发 OSC 11 → 断言收到正确代答（用 capture-pane 或 stdin pipe 验证字节）
    - 跨网页：两 context，A 切主题，B <1s 同步（DOM 断言）
    - 跨设备：mock SSH 设备 + local 设备，切主题两端同步
    - 主题 × resize 互踩：快速切主题 + 同时 resize，pane 尺寸稳定
  - 新增 `e2e/specs/theme-broadcast.spec.ts`（如内容多则独立）：
    - 并发 last-writer-wins：两网页几乎同时切不同主题，最终一致
    - 离线 fallback：离线切主题，重连后同步
  - 全套 e2e 在 dev 实例（独立 socket + 独立端口）跑过
  - 回归：现有 e2e 全过

  **Must NOT do**:
  - 不向生产 tmex / 生产 tmux session 发请求
  - 不在 e2e 内启动真实 Coding Agent（用 mock TUI 发 OSC 11）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — e2e 测试编写 + 实证
  - **Skills**: [`test-driven-development`, `webapp-testing`]

  **Parallelization**:
  - **Can Run In Parallel**: NO（依赖前面所有实现完成）
  - **Parallel Group**: Wave 3 末尾
  - **Blocks**: F1-F4
  - **Blocked By**: 7, 8, 9, 10, 11, 12, 13

  **References**:
  - `e2e/specs/split-screen-desktop.spec.ts` 分屏 e2e 模式
  - `e2e/specs/split-screen-mobile.spec.ts` 分屏移动端 e2e
  - `e2e/specs/terminal-selection-canvas.spec.ts` selection e2e（回归基线）
  - `e2e/specs/terminal-clipboard.spec.ts` clipboard e2e
  - `e2e/specs/ws-borsh-switch-barrier.spec.ts` ws-borsh 切换 e2e
  - `prompt-archives/2026070200-split-screen/plan-00-result.md` 现有 e2e 适配说明
  - `.sisyphus/evidence/task-02-bug1-root-cause.md` bug 1 重现条件
  - `.sisyphus/evidence/task-03-osc-write-channel.md` OSC mock TUI 写法

  **WHY Each Reference Matters**:
  - 现有 e2e 是模式参考 + 回归基线
  - spike 报告提供重现条件，e2e 必须覆盖

  **Acceptance Criteria**:
  - [ ] 三个新 e2e spec 文件存在
  - [ ] 全部 happy path 通过
  - [ ] 现有 e2e 回归全过
  - [ ] e2e 证据截图 / log 全部保存

  **QA Scenarios**:
  ```
  Scenario: e2e 全过
    Tool: Bash
    Preconditions: dev 实例 + 独立 tmux socket
    Steps:
      1. TMEX_TMUX_SOCKET=tmex-e2e-2 GATEWAY_PORT=19885 FE_PORT=19665 bun run test:e2e
    Expected Result: 新增 spec + 现有 spec 全过（既有失败按 baseline）
    Evidence: .sisyphus/evidence/task-14-e2e-full.txt
  ```

  **Commit**: YES
  - Message: `test(e2e): 分屏 selection 持久性 + 主题动态传递 + 跨设备广播`
  - Files: e2e/specs/split-selection-persistence.spec.ts, e2e/specs/theme-propagation.spec.ts, e2e/specs/theme-broadcast.spec.ts
  - Pre-commit: `bun test`

---

## Final Verification Wave（MANDATORY — after ALL implementation tasks）

> 4 review agents 并行。ALL must APPROVE。汇总结果给用户，**等用户明确 okay 才标记完成**。
> **不要在用户 okay 前标记 F1-F4 为已勾选。** 拒绝或用户反馈 → 修复 → 重跑 → 再汇报 → 等 okay。

- [ ] F1. **Plan Compliance Audit** — `oracle`
  读完整 plan。对每条 "Must Have"：验证实现存在（读文件 / curl endpoint / 跑命令）。对每条 "Must NOT Have"：搜代码库找禁止模式 — 找到就 file:line reject。检查 `.sisyphus/evidence/` 内证据文件。对比 deliverables 与 plan。
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  跑 `bun run typecheck` + biome + `bun test`。审查所有改动文件：`as any` / `@ts-ignore` / 空 catch / console.log / 注释掉的代码 / 未用 import。检查 AI slop：过度注释、过度抽象、通用名（data/result/item/temp）。
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high` + `playwright` skill
  从干净状态起。执行**每个 task 的每个 QA scenario**——按精确步骤、抓证据。测跨 task 集成（多个功能协同）。测边界：空状态、非法输入、快速操作。保存到 `.sisyphus/evidence/final-qa/`。
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  对每个 task：读 "What to do"、读实际 diff（git log/diff）。1:1 验证——spec 内的都建了（无遗漏）、spec 外的都没建（无 creep）。检查 "Must NOT do" 合规。检测跨 task 污染：Task N 改了 Task M 的文件。标记未声明改动。
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **Wave 1**: `chore(spike): bug1/theme spike 实证与基础架构` - 各 spike 报告 + SiteSettings migration + 主题色 shared
- **Wave 2**: `fix(split): 修复分屏 selection 在对端输出时被清空` + `feat(theme): OSC 11 拦截代答 + SIGWINCH 推送 + WS 广播`
- **Wave 3**: `feat(theme): resize × theme 同步解耦 + e2e 验证`
- **Final**: `test(e2e): 分屏 selection + 主题动态传递验收`

每个 commit 前：`bun test` + `bun run typecheck` 必须通过。

---

## Success Criteria

### Verification Commands

```bash
# 单测全过
bun test apps/gateway packages apps/fe/src

# 类型检查
bun run typecheck

# Lint
bun run lint

# e2e（独立 tmux socket + dev 端口）
TMEX_TMUX_SOCKET=tmex-e2e GATEWAY_PORT=19883 FE_PORT=19663 bun run test:e2e split-screen selection
TMEX_TMUX_SOCKET=tmex-e2e GATEWAY_PORT=19883 FE_PORT=19663 bun run test:e2e theme-propagation
```

### Final Checklist

- [ ] Bug 1：分屏 A 持续输出 + B 选取，selection 保持 ≥30s
- [ ] Bug 2：网页切主题 → 所有已连接设备的所有 pane OSC 代答新色 + SIGWINCH
- [ ] Bug 2：跨网页/跨设备广播 last-writer-wins 一致性达成
- [ ] Bug 2：OpenCode/Claude Code 启动探测拿到正确主题色（OSC 11 代答）
- [ ] Bug 2：Codex 启动探测拿到正确主题色（OSC 11 代答，绕过 tmux 拦截）
- [ ] Bug 2：主题切换 × 客户端 resize 不互踩
- [ ] Bug 2：SSH 设备 OSC 代答时延 <500ms（LAN）
- [ ] Bug 2：升级流程平滑（siteSettings migration + localStorage fallback）
- [ ] 所有 "Must NOT Have" 缺席
- [ ] 所有测试 + e2e 通过
