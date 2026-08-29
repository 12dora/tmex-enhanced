# Plan 00：侧栏清理、设备管理层级系统、tab i18n

## 背景
延续 `2026082901-nodes-settings-devices-polish`（分支 `chore/merge-hub-tabs`，worktree `tmex-enhanced-wt-merge`）。三节点测试环境：远程 hub `ai.jiefakj.com:18443`、本机生产 `konata-mac`（严禁触碰）、容器 `tmex-node-docker`（29883，代码在 `/opt/tmex`，数据 `/var/lib/tmex`）。

## 分工
- 指挥官（本会话）：计划、存档、tab i18n 文案、分批 commit、push、docker 上线、实测。
- codex luna(xhigh)：只读探索，产出代码地图（`sub/explore-*-result.md`）。
- Opus(high)：任务 1 侧栏三项（`device-tree` + `page-layouts`）。
- Fable 5(high) 子代理：任务 2 设备管理（可自行调 cursor-agent grok 写后端）。
- codex sol(high)：分批 review，指挥官判断是否修。

## 任务
1. 侧栏：全部未勾选显示时整节不渲染；去掉设备行内重复的 node 徽标；去掉行内电源按钮。
2. 设备管理：修「+」崩溃；设备分组（可嵌套文件夹，拖拽）；真实类型/连接状态与连接-断开；卡片去重属性；按类型编辑表单。
3. 侧栏 tab 文案 i18n（zh_CN：终端/智能体/文件；ja_JP 同步）。

## 验收
- 包内 `bun test src/`、`tsc --noEmit` 不低于基线；biome 通过。
- 临时实例实测「+」、分组拖拽、连接/断开。
- push 后用 `npm pack` tarball 更新 `tmex-node-docker`。
