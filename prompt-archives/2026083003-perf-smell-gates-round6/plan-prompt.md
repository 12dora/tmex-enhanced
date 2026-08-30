# Prompt 存档（2026-08-30，第六轮：性能热点调优 + code smell 第五轮 + 复杂度门禁）

## 原始 prompt

继续开发, 请你分批commit并在最后push替换本机tmex, Think in English, Send English prompt. 目前其他agent还在相同项目工作, 请你等其工作完毕后再开始
任务：
1. 对本项目进行性能热点分析并深度调优(例tui应用, 假设类似claude code对话历史超长时滚动会较为卡顿), 循环进行分析, 直到你认为所有高价值点已被修复, 或总轮数超过3轮
2. 扫描并修复本项目的代码坏味道, 例如高圈复杂度, 巨大函数, 巨大文件等), 循环进行, 直到你认为所有高价值点已被修复, 或总轮数超过3轮(你需要等1的完毕后再进行这一项)
3. 顺便修复其中遇到的bug
4. 过程中要注意代码行数膨胀的问题, 最后收尾时为本项目加上合理的函数长度, 圈复杂度等门禁
注:
1. cursor（grok 4.6, high)担任后端编码
2. opus5(high)担任前端编码
3. codex（gpt-5.6-luna,  xhigh)探索代码
4. codex（gpt-5.6-sol,  high)担任code reviewer, codex存在过度防御的问题, 你应该自行判断问题是否修复
5. 你担任指挥官和planner, 激进并行, 合理控制每个agent的工作量, 避免单一agent上下文过大

## 后续对话

- 另一个也是claude code会话,你可以让他在完成后通知你开工
  （r5 会话 `tmex-enhanced-18` 于 main `19dd4992` 收尾并通知；本轮 worktree `../tmex-enhanced-wt-r6`，分支 `feat/round6-perf-smell`。）
