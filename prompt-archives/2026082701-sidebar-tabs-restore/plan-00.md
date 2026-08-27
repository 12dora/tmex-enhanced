# 计划：恢复侧边栏 Tab 式 UI（个人分支）

## 背景

上游 commit `465c94b`（配套 `0706f73` 高度修复、`8c4dc4d` e2e 更新）把侧边栏 Panes / Agent / Files 三个互斥 Tab 改成了三个并列 Collapsible 分区，默认全展开。用户偏好旧版 Tab 式 UI。`main` 保持上游风格用于给主线提 PR；本分支 `feat/sidebar-tabs-ui`（worktree `../tmex-enhanced-wt-tabs`）供用户自用，最终 push 到 origin 并以 docker 上线。

## 目标

1. 侧边栏回到 Tab 互斥切换（`sidebarTab: 'panes' | 'agent' | 'files'`，默认 `panes`，不持久化）。
2. 功能不丢失：逐条核对 `465c94b` 及之后与分区相关的改动（footer 设备管理入口常驻——保留；程序化"展开 agent 分区"的调用点改为 `setSidebarTab`；Agent 分区 `min-h` 与分区内滚动在 Tab 模式下不再需要）。
3. 顺手修复侧边栏相关旧代码的坏味道（`sidebar-agent-sessions.tsx` 554 行等）与发现的 bug。
4. 分批 commit、push origin，docker compose 上线。

## 注意事项

- 严禁触碰生产 tmex（9883、`~/Library/Application Support/tmex/`）与名为 `tmex` 的 tmux session。
- 不改版本号/CHANGELOG（见记忆 fork-release-local-install）。
- i18n key 改回 `sidebar.tab.*` 后必须 `bun run build:i18n` 重建生成文件，不要手改/lint `resources.ts`、`types.ts`。
- e2e 基线失败见记忆 e2e-baseline-failures。

## 任务清单

- [ ] A（Opus）：源码回退——app-sidebar.tsx、stores/ui.ts(+test)、stores/index.ts、i18n locales、agent-tab.tsx、rsync-install-flow.ts、use-terminal-shortcut-actions.ts、use-agent-tab-actions.ts、sidebar-agent-sessions.tsx 调用点、SettingsPage tabTriggerClassName 共享
- [ ] B（Opus）：e2e specs 更新为 `sidebar-tab-*` 交互
- [ ] C（Codex luna）：探索侧边栏/页面布局相关代码坏味道与潜在 bug；docker 部署链路检查
- [ ] D：按 C 的结果分派重构/修 bug
- [ ] E（Codex sol）：review 每批 diff
- [ ] 验证：`bun test`、`tsc --noEmit`、biome、相关 e2e
- [ ] 分批 commit、push、docker compose up

## 验收标准

- 侧边栏顶部三 Tab，互斥切换；快捷键/agent 引导/rsync 流程能正确切到对应 Tab。
- 包内测试与 tsc 无新增错误；e2e 对比基线无新增失败。
- docker 容器健康并可访问。
