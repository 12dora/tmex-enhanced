# Round 10 用户 prompt 存档

## 2026-09-01 初始 prompt

> 继续开发, 请你分批commit并在最后push替换本机tmex, Think in English, Send English prompt.
> 并行任务：
> 1. 左侧栏接入设备,管理设备按钮组下移, 使其下缘和右侧下缘对齐(有2层, 里面是终端的边框, 外部还有1层黑框, 要求对齐外层边框), 并适当减小按钮上下的空隙, 这样留给终端列表更多显示空间, 但要依旧保持美观
> 2. 左侧栏上方tab切换器轻微上移, 是其和终端上缘对齐, , 这样留给终端列表更多显示空间
> 3. 管理设备, 设备卡片
>     1. 拖动避让过于灵敏, 有时还离得很远就开始避让了, 请你像ios图标移动一样, 使避让距离合理
> 4. 设置-节点管理
>     1. 操作新增升级按钮, 点击后升级该节点到最新版
> 5. 完成docs/backlog/2026090100-pending-tasks.md所列出的任务
>
> 注:
> 1. cursor（grok 4.6, high)担任后端编码
> 2. opus5(high)担任前端编码
> 3. codex（gpt-5.6-luna,  xhigh)探索代码
> 4. codex（gpt-5.6-sol,  high)担任code reviewer, codex存在过度防御的问题, 你应该自行判断问题是否修复
> 5. 你担任指挥官和planner, 激进并行, 合理控制每个agent的工作量, 避免单一agent上下文过大

## 2026-09-01 追加

> 完工后你需要删除除了legacy以外的所有分支/worktree,并把他们合并到main

## 背景

- 崩溃安全升级器：分支 `feat/crash-safe-upgrade`（e7cc4ac7），blocker 清单见 `docs/backlog/2026090100-pending-tasks.md` 与 `prompt-archives/2026083102-relay-files-switch-lan-round9/sub/review-J.md`。
- 本轮 worktree：`../tmex-enhanced-wt-r10`（feat/round10-ui-node-upgrade，UI+小修）、`../tmex-enhanced-wt-upg`（feat/crash-safe-upgrade merge main 后继续）。
