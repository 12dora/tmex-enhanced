# Round 10 计划：UI 微调 + 节点远程升级 + 崩溃安全升级器落地 + backlog 清偿

日期：2026-09-01。指挥官：Claude（Fable 5）。分工：cursor grok-4.6(high) 后端、Opus5(high) 前端、codex luna(xhigh) 探索、codex sol(high) 审查。

## 背景

- 上轮 v1.1.5 已全网上线（round9 档案 `prompt-archives/2026083102-relay-files-switch-lan-round9/`）。
- 崩溃安全升级器完整实现在 `feat/crash-safe-upgrade`（e7cc4ac7），review-J 判定 7 个 blocker 未随 1.1.4/1.1.5 发布；本轮修完发 1.1.6。
- backlog：`docs/backlog/2026090100-pending-tasks.md`。

## 工作区

- `../tmex-enhanced-wt-r10`（`feat/round10-ui-node-upgrade`，基于 main 77b6dba9）：UI 任务 + 节点升级 + P2 小修。
- `../tmex-enhanced-wt-upg`（`feat/crash-safe-upgrade`，已 merge main→1.1.5 基线）：升级器 blocker 修复。

## 任务

### A. UI（wt-r10，Opus）
1. 侧栏底部「接入设备/管理设备」按钮组下移，下缘与右侧终端区**外层黑框**下缘对齐；压缩按钮组上下空隙，给终端列表更多空间。
2. 侧栏顶部 tab 切换器轻微上移，与终端区上缘对齐。
3. 管理设备页设备卡片拖拽避让过灵敏（离很远就避让）→ 改成 iOS 图标式的合理避让距离（碰撞判定收紧，如按指针/卡片中心距离阈值）。
4. 设置-节点管理操作列新增「升级」按钮（依赖 C 的 API）。

### B. 节点远程升级（wt-r10，cursor 后端 + Opus 前端）
- 点击后让目标节点升级到最新版。需探索现有 Web 自升级（`apps/gateway/src/system/upgrade.ts` UpgradeController）与 mesh 通道，设计「hub/本机对远端节点下发升级指令」链路。

### C. backlog P2 小修（wt-r10）
1. SelectionToolbar 吞点击（终端 pointer-down 先收起工具条或挪出文本区）。
2. `node-login-<id>` testid 重复（Playwright strict-mode 冲突）。
3. hub-e2e driver select 硬编码 `windowId: null` → 带真实 windowId（指挥官自修）。
4. e2e 预存失败 5 例：`sidebar-resize:40`、`mobile-mouse-reporting:205`、`agent-session:404`、`settings-llm:42`、`ws-borsh-theme-resize:39`——逐条修测试或产品，同步 `docs/known-issues.md` KI-3 与 memory。

### D. 崩溃安全升级器（wt-upg，cursor）
- review-J 7 个 blocker（repair 误删执行中 staging、legacy 顶层目录过早删除、preflight 副作用需专用模式、1.0.2 healthz 兼容、serviceMode=none PID 所有权、SHA256SUMS fail-open、backup 阶段崩溃后双进程）+ should-fix（upgrade-db argv、native 离线复用、log FD 泄漏、1.0.2 shim、TLS readiness、Web controller 卡 executing 等）。
- 验收：codex 复审；scratch 演练（G5b 配方）；launchd（独立 label + scratch install dir）与 systemd（docker）双服务模式真实演练。

### E. 发版与收尾
- 合并 wt-upg → wt-r10 或各自并入 main；版本 1.1.6，CHANGELOG，GitHub Release（带 SHA256SUMS），升级本机生产 tmex（用户已授权）。
- 完工后：所有分支合入 main、push，删除除 legacy 外全部分支/worktree（r6/r7/r8/r9/r10/upg 及远端已合并分支）。

## 执行顺序

1. codex luna 并行探索：EX1 UI 几何、EX2 节点升级链路、EX3 升级器 blocker 落点核实、EX4 e2e 5 例失败原因。
2. 并行编码：C1 upgrader（wt-upg）、C2 节点升级后端、O1 侧栏对齐、O2 拖拽避让、O3 SelectionToolbar+testid；随后 O4 升级按钮 UI、e2e 修复。
3. 每批：包内 bun test + tsc 基线比对 + biome（仅改动文件）+ codex sol 审查 → 指挥官分批 commit。
4. 指挥官实测：临时实例截图核对 UI；升级器三演练；e2e 定向复跑。
5. 发版 1.1.6 → 升级本机 → 合并清理。

## 注意事项

- 严禁触碰生产 tmex（9883、`~/Library/Application Support/tmex/`）与名为 `tmex` 的 tmux session；测试用独立 socket。
- agent 不做 git 操作；共享 barrel/package.json/i18n build 由指挥官统一处理。
- macOS 无 timeout 命令；bun test 摘要有 ANSI 色；`apps/fe` 单测用 `bun test src/`。
- packages/app tsc 基线 1 条（@types/node）；gateway tsc 基线 21 条。
