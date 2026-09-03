# 第二十轮 prompt 存档

## 初始 prompt（2026-09-03）

继续开发, 请你分批commit并在最后push替换本机tmex, Think in English, Send English prompt.
任务：
1. 当打开passkey两步认证后, 例如在本机通过http://127.0.0.1:9883/访问tmex, 会出现无法连接hub(https://tmexhub-sh.jiefakj.com)的问题, 因为该内网地址没有添加passkey
2. 多节点互联内存在加入地址(ai.jiefakj.com)该地址指向备hub,加入地址是什么意思, 而主hub地址不是该地址, 为什么加入地址不是主hub的地址
注:
1. cursor （grok 4.6, high）担任后端编码
2. opus5(high)担任前端编码
3. codex（gpt-5.6-luna,  xhigh)探索代码
4. codex（gpt-5.6-sol,  high)担任code reviewer, codex存在过度防御的问题, 你应该自行判断问题是否修复
5. 你担任指挥官和planner, 激进并行
6. 为避免压缩轮数太多影响会话质量, 请你在适当时候为分工的agent开新会话, 而不是无限继续用老会话

## 追加 prompt 1（2026-09-03）

如果加入地址不再需要显示,可以删去
