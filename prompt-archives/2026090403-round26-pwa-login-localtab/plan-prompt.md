# 第二十六轮 prompt 存档

## 初始 prompt（2026-09-04）

继续开发, 请你分批commit并在最后push替换本机tmex, Think in English, Send English prompt.
任务：
1. 现在打开tmexsh-hub登录用户名默认变成一串UUID, 应该没有任何默认值
2. 首次打开pwa应用默认聚焦蓝框左上角close sidebar按钮, 请你修复; 进入该pwa默认显示英语,而不是跟随语言设置,需要点击setting才会变成中文(该问题网页版也有)
    1. 该pwa应用针对jiefa-app/jiefa-dns-1/konata-mac/tmex节点显示failed to load device
3. 2的pwa应用都为tmexsh-hub域名
4. 多节点互联-本机tab现在非常混乱, 堆积了大量冗余字段, UI设计全部聚在一起缺乏逻辑, 请你全面重新设计, 删除无用字段和提示语
    1. 请你为中继节点增加更多性能监控,但要美观现代
5. 修复所有失败, 完成上次的遗留任务
注:
1. grok build(grok 4.6, high)担任后端编码
2. opus5(high)子代理担任编码
3. codex（gpt-5.6-luna,  xhigh)探索代码
4. codex（gpt-5.6-sol,  high)担任code reviewer, codex存在过度防御的问题, 你应该自行判断问题是否修复
5. 你担任指挥官和planner, 激进并行
6. 为避免压缩轮数太多影响会话质量, 请你在适当时候为分工的agent开新会话, 而不是无限继续用老会话

## 补充（同轮）

应该是tmexhub-sh,我误打成tmexsh-hub
