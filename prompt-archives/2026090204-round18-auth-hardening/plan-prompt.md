# 第十八轮 prompt 存档

## 2026-09-02（用户）

继续开发, 请你分批commit并在最后push替换本机tmex, Think in English, Send English prompt.
任务：
1. 登录失败提示应该模糊化, 当前密码错误会提示密码错误
2. 设置passkey后应该启用该passkey二次验证, 即用户输入账号密码后需要passkey认证才能登录
3. 排查其他类似安全风险, 因为要暴露到公网, 但要避免过度防御
4. sh hub节点-多节点互联-本机明明提供https但不能正确侦测状态,依旧显示关闭

注:
1. cursor grok 4.6, high担任后端编码
2. opus5(high)担任前端编码
3. codex（gpt-5.6-luna,  xhigh)探索代码
4. codex（gpt-5.6-sol,  high)担任code reviewer, codex存在过度防御的问题, 你应该自行判断问题是否修复
5. 你担任指挥官和planner, 激进并行
6. 为避免压缩轮数太多影响会话质量, 请你在适当时候开新会话, 而不是无限继续用老会话

## 2026-09-02（用户，追加）

追加任务:有时claude code等tui在手机等窄屏设备上没有自适应宽度导致文字溢出屏幕外,请你修复
