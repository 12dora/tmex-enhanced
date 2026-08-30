# 第七轮 prompt 存档

## 2026-08-31 初始 prompt（用户）

继续开发, 请你分批commit并在最后push替换本机tmex, Think in English, Send English prompt.
任务：
1. 对本项目进行性能热点分析并深度调优, 循环进行分析, 直到你认为所有高价值点已被修复, 或总轮数超过3轮
2. 扫描并修复本项目的代码坏味道, 例如高圈复杂度, 巨大函数, 巨大文件等), 循环进行, 直到你认为所有高价值点已被修复, 或总轮数超过3轮(你需要等1的完毕后再进行这一项)
3. 顺便修复其中遇到的bug

注:
1. cursor（grok 4.6, high)担任后端编码
2. opus5(high)担任前端编码
3. codex（gpt-5.6-luna,  xhigh)探索代码
4. codex（gpt-5.6-sol,  high)担任code reviewer, codex存在过度防御的问题, 你应该自行判断问题是否修复
5. 你担任指挥官和planner, 激进并行, 合理控制每个agent的工作量, 避免单一agent上下文过大
