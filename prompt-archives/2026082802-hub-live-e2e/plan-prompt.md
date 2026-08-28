# prompt 存档

## 2026-08-28 任务下达

> 继续开发, 请你分批commit并在最后push, Think in English, Send English prompt.
> 任务：
> 1. worktree /Users/konata/code/tmex-enhanced-wt-hub（分支 feat/hub-node）的hub功能已经开发完毕, 请你进行实际的端到端验证.
>     1. 测试机器:
>         1. 远程服务器（43.248.129.233，ssh 10022，凭据见会话，不落档），供你测试hub. 该机为公网服务器有ai.jiefakj.com域名指向
>         2. 本机docker生成一些容器
>         3. https://home-tmex.konata.tv, 这是cf tunnel的入口, 需要登录, 用户名（见会话）, 密码是动态验证码, 你触发登录后我告诉你. 这台机器位于NAT下
>     2. 测试每台机器当node/hub情况下的可用性, 内网穿透可用性, 传输中网络突然切断再恢复等正常和异常场景, 解决遇到的任何问题
>     3. 测试完清理掉遗留
> 2. 完成遗留任务 prompt-archives/2026082801-hub-docker-e2e-multi-theme/leftovers.md
> 3. 由你进行调试, 涉及到编码时分配任务
> 注:
> 1. grok（4.6, high)担任后端编码
> 2. opus5(high)担任前端编码
> 3. codex（gpt-5.6-luna, xhigh)探索代码
> 4. codex（gpt-5.6-sol, high)担任code reviewer, codex存在过度防御的问题, 你应该自行判断问题是否修复
> 5. 你担任指挥官和planner, 激进并行, 合理控制每个agent的工作量, 避免单一agent上下文过大

备注：`feat/hub-node` 已合入 `chore/merge-hub-tabs`（worktree `../tmex-enhanced-wt-merge`），`wt-hub` worktree 已不存在，本任务在 `wt-merge` 上进行。
