# 第二十二轮 prompt 存档

## 2026-09-03 初始 prompt（用户原文）

继续开发, 请你分批commit并在最后push替换本机tmex, Think in English, Send English prompt.
任务：
1. 使用tmex时似乎没有那么流畅, 请你扫描并深度优化性能, 改善各个界面用户流畅度,(例如终端scroll, 网络性能开销等) , 是否存在可写成wasm加速的性能热点
2. 在claude code tui里,有时候消息输入框文字会变成奇怪的浅绿色, 请你排查
3. 优化tmex常驻状态下的性能消耗,包括服务器端和pwa端, 以节电(pwa), 和减少不必要的待机性能消耗
4. 全面优化项目代码坏味道, 例如高圈复杂度, 大文件, 大函数等
5. 当前代码库比较庞大, 分析并精简(如可能)
注:
1. cursor （grok 4.6, high）担任后端编码
2. codex（gpt-5.6-sol,  max)担任复杂性能调优任务后端编码, 是否要出动该agent由你判断
3. opus5(high)担任前端编码
4. opus5(high)探索代码
5. codex（gpt-5.6-sol,  high)担任code reviewer, codex存在过度防御的问题, 你应该自行判断问题是否修复
6. 你担任指挥官和planner, 激进并行
7. 为避免压缩轮数太多影响会话质量, 请你在适当时候为分工的agent开新会话, 而不是无限继续用老会话
