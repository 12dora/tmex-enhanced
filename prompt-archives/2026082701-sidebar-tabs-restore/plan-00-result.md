# 执行结果：恢复侧边栏 Tab 式 UI（个人分支）

分支 `feat/sidebar-tabs-ui`（worktree `../tmex-enhanced-wt-tabs`），已 push 到 origin；`main` 保持上游 UI 用于 PR。

## 调查结论

用户升级前用的是 0.17.0（2026-07-05）。0.17.0 → HEAD 的用户可见 UI 变化清单见 `sub/explore-ui-diff-result.md`；用户决策：恢复三 Tab 侧栏 + 连接/断开按钮与状态点（含设备卡片 Connect、终端「已断开」占位），保留 URL 高亮、设备树折叠记忆及全部零散样式/修复。

## 提交

| commit | 内容 |
|---|---|
| a0a6304 | 侧栏回到 Panes/Agent/Files 互斥 Tab；`sidebarTab` store；`pillTabTriggerClassName` 共享；i18n `sidebar.tab.*`；e2e 改为 Tab 驱动 |
| bbc8d0e | 恢复设备连接/断开 UI：`DeviceConnectionAdapter` 经可选 prop 注入面板；连接意图持久化在 `GlobalDeviceProvider`（`tmex:connectedDevices` / `tmex:disconnectedDevices`）；主动断开抑制自动订阅；`disconnectDevice` 立即落地断开态 |
| b93fa76 | Docker：compose 重复 `environment` key、workspace 清单缺失、镜像缺 drizzle/wasm、uid 冲突、生产 env 契约、nginx `/healthz` 反代、`.dockerignore` |
| 097248f | 坏味道与 bug：`sidebar-agent-sessions.tsx` 554→151 行拆分；device-tree 对话框/action 拆分；空 pane 窗口 Agent 动作崩溃、`decodeURIComponent` 抛错、查询失败伪装为空态、拖拽并发、pending 导航 TTL；agent 跨设备 rebind、切 pane 草稿残留、加载中误判孤立；侧栏折叠状态受控持久化、localStorage 安全访问；`nav-main` 去除 `<a><button>` 嵌套；connect 去重在断开时清除 |
| 0e70e1d | `SidebarMenuButton` 带 tooltip 时保留自定义 render |
| 98e5cbb | gateway：pending connect 被同 socket 的 disconnect 作废（连接 generation） |
| a429bd7 | review 修复：session 写入统一重算 `sessionOrder`、`loadSessions` 单飞、设备未就绪不判孤立、路由变化清 pending 导航 |

## 验证

- 单测：stores 108 / panels 239 / ui 16 / fe 45 / gateway 1473，全部通过；tsc apps/fe、panels、ui 0 错误（stores 仅既有 1 条基线错误）。
- e2e 全量：94 passed / 9 failed / 1 skipped。失败中 8 个为基线既有（见记忆 e2e-baseline-failures），`split-screen-desktop.spec.ts:61` 单独重跑通过，属时序抖动。
- Code review（codex-sol）三轮：review-01 一条 low（旧 localStorage 残留键，与旧实现一致，不修）；review-02 两条已修；review-03 五条已修（其一在提交前已修）。
- Docker：`docker compose up -d` 后 gateway healthy，`http://localhost:3300/healthz` 返回 ok，SPA 200。3000 被其它项目占用，`.env`（gitignored）设 `TMEX_PORT=3300` 与 `TMEX_MASTER_KEY`。

## 未做 / 备注

- 坏味道扫描中跳过：嵌入宿主 `hostAppPath` 路由（仅影响内嵌宿主）、`withdrawQueuedMessage` 失败重复排队（需后端原子接口）、`DeviceTreeContext` 替代 prop drilling（L，风险大）。
- 完整清单：`sub/explore-smells-result.md`。
