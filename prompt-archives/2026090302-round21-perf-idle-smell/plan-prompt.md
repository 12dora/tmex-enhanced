# 第二十一轮 prompt 存档

## 初始 prompt（2026-09-03）

> 继续开发, 请你分批commit并在最后push替换本机tmex, Think in English, Send English prompt.
> 任务：
> 1. 使用tmex时似乎没有那么流畅, 请你扫描并深度优化性能, 改善各个界面(特别是终端scroll)用户流畅度
> 2. 分析tmex常驻状态下的性能消耗,包括服务器端和pwa端, 并进行可能的优化以节电(pwa), 和减少不必要的待机性能消耗
> 3. 全面优化项目代码坏味道, 例如高圈复杂度, 大文件, 大函数等
> 4. 当前代码库比较庞大, 分析并精简(如可能)
>
> 注:
> 1. cursor （grok 4.6, high）担任后端编码
> 2. codex（gpt-5.6-sol, max)担任复杂性能调优任务后端编码, 是否要出动该agent由你判断
> 3. opus5(high)担任前端编码
> 4. opus5(high)探索代码
> 5. codex（gpt-5.6-sol, high)担任code reviewer, codex存在过度防御的问题, 你应该自行判断问题是否修复
> 6. 你担任指挥官和planner, 激进并行
> 7. 为避免压缩轮数太多影响会话质量, 请你在适当时候为分工的agent开新会话, 而不是无限继续用老会话

## TASK C prompt（2026-09-03）

> split `apps/gateway/src/mesh/auth-routes.ts` (key-log sub-domain + handleLogin)
>
> Seam 1 — extract key-log / hub-sync into `AuthKeyLogRoutes` in `auth-key-log-routes.ts`
> Seam 2 — extract `createLoginFailureSink` + `verifySecondFactors` from `handleLogin` (keep TOTP_REQUIRED / PASSKEY_REQUIRED login-obfuscation order)

