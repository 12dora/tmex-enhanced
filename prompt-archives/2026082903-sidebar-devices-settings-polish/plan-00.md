# 侧栏 / 设备管理 / 设置 打磨（2026-08-29）

## 背景
分支 `chore/merge-hub-tabs`（worktree `tmex-enhanced-wt-merge`），承接 `2026082902-sidebar-devices-hierarchy` 之后的 UI 反馈。分工：codex(luna) 只读勘察 → Opus 做侧栏、Fable 5 做设备页（含 shared/gateway 小改）、指挥官自己改设置页 → codex(sol) 按 backend/panels/fe 三路 review → 指挥官裁决并分批 commit → 打包 tarball 升级本机。

## 任务清单
1. 侧栏：节点组间距收紧；窗口行/新建窗口缩进 `pl-10`→`pl-6`；节点头去徽标改纯文本并可拖拽排序（`tmex-ui.sidebarNodeOrder`）；「管理设备」高亮改精确匹配。
2. 设备页：离线节点保留卡片（快照/inventory）+ 手动连接；连接按钮 pending 态防闪烁；一层「分组」且节点绑定设备（shared 校验 + gateway 拦截 + 迁移 0025）；重设布局（`POST /api/device-folders/reset` + 确认框）；分组虚线边界 + 「移到最外层」落点；容器宽度统一；「远程本地设备」文案。
3. 设置：「节点」tab 改「多节点互联」；通知页开关两列、四个输入同一行。

## 验收
各包 `bun test` 全绿、tsc 不高于基线；tarball production 模式烟测（26 条迁移落库）；本机 `upgrade --apply-current-package`。

## 注意事项
- standalone（无 mesh 节点）时根层 self 节点不显示节点头、不可拖，分组只对 mesh 节点有意义。
- 迁移 0025 按旧树前序重编号 `sort_order`，设备 placement 直接删除（设备现在恒随节点）。
