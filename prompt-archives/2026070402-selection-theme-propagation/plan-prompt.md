# 分屏 Selection 清空修复 + 主题动态传递

## 用户原始需求

用户在同一会话中提出两个任务：

1. **Bug 1（分屏 selection 清空）**：分屏模式下 A pane 的 TUI 持续输出，在 B pane 中选取文字后 selection 立即被清空。
2. **Bug 2（主题动态传递）**：把 dark/light 主题动态传给终端，让 pane 内的 Coding Agent（OpenCode / Claude Code / Codex / omp）能自己切换主题；参考 omp/opencode/claudecode/codex 的实现。

## 三条关键决策（用户在规划期间补充）

1. **OSC 11 + SIGWINCH 两个路径都要**支持同步 color scheme。
2. dark/light mode 需要**跨设备跨网页广播同步**。
3. 处理客户端 resize 时也要发主题同步消息；**避免主题同步导致终端尺寸意外变化**。

## 规划期间已确认决策（用户用 question 工具回答）

- 主题真源：扩展 SiteSettings（gateway SQLite 持久化 + WS 广播）
- 并发策略：Last-writer-wins + timestamp
- 不跟随系统 prefers-color-scheme（保持手动切换）
- OSC 11 应答 / SIGWINCH 实现层：Gateway 拦截代答
- 测试策略：TDD（RED-GREEN-REFACTOR）+ e2e
- 在新 worktree 实现

## 环境约束（AGENTS.md 硬约束）

- 干活必须在 worktree 里（本任务已创建 `.claude/worktrees/split-theme`）
- 严禁触碰生产 tmex（端口 9883、`~/Library/Application Support/tmex/`、tmux session `tmex`）
- 三套环境：development / test / production，配置由 `loadEnv()` 统一加载
- Bun-only 运行时，不兼容 Node.js
- 先存档再干活

## 相关存档

- 完整 plan：`prompt-archives/2026070402-selection-theme-propagation/plan-00.md`
- 执行结果（待补）：`prompt-archives/2026070402-selection-theme-propagation/plan-00-result.md`