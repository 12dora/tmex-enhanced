# 第二十三轮 prompt 存档

## 2026-09-03 初始 prompt（用户原文）

继续开发, 请你分批commit并在最后push替换本机tmex, Think in English, Send English prompt.
任务：
1. prompt-archives/2026090303-round22-perf-tui-color-smell/plan-prompt.md 末尾「追问」段的遗留任务
2. 我准备新开一个角色 中继,该角色为公共中继服务器, 用来承担Hub的功能,但是无法看到或操控接入该中继的客户端, 也就是就算通过公共中继, 用户依旧是e2ee信息安全的. 该角色支持多个不同用户接入(例如为100个用户提供服务).
    1. 用户可以enroll中继, 中继可以有密码(用户必须输入密码才能使用中继), 修改密码后允许踢掉所有老用户或者保持老用户继续使用
    2. 在多节点互联页面有适当UI和状态监控(并同时支持API/命令行配置以及API获取状态健康等)
    3. 请你询问我并完成该部分设计,只问你没弄清的问题 /grilling
注:
1. cursor （grok 4.6, high）担任后端编码
2. opus5(high)子代理担任前端编码
3. codex（gpt-5.6-luna,  xhigh)探索代码
4. codex（gpt-5.6-sol,  high)担任code reviewer, codex存在过度防御的问题, 你应该自行判断问题是否修复
5. 你担任指挥官和planner, 激进并行
6. 为避免压缩轮数太多影响会话质量, 请你在适当时候为分工的agent开新会话, 而不是无限继续用老会话

## 任务 1 所指的 round22 遗留（用户已拍板）

1. 删 legacy 状态流：先补 canonical v1.1 尺寸语义（区分「补发尺寸」与「尺寸变更」），再删 legacy；最低可入网版本 1.1.22。
2. 首屏体积：只做 `tailwind-merge` 替换（194 处 `cn()`，需逐页目测）；`react-router` 不换。
3. 删三个只有测试引用的路由：`/api/tmux/tree`、`/api/settings/theme`、`POST /api/hub/nodes/:id/revoke`。
4. 删旧 7 个无 script 的 bench，只保留 round22 新增 4 个（render-bridge 除外）。
