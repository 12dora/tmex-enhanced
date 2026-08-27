# Prompt 存档

## 2026-08-27 初始 prompt

继续开发, 请你分批commit并在最后push, 然后上线docker Think in English, Send English prompt.
任务：
1. Tmex之前修改了UI(例如原来Agent/Panes/Files是在tab切换的,而不是全部挤在左栏),但我还是喜欢以前的UI,请你改为旧版UI
    1. 你需要注意旧版UI有没有功能损失,还是仅仅换了style
    2. 旧的UI代码可能存在代码坏味道,例如高圈复杂度,巨大函数,巨大文件等问题,一并修复
2. 新开一个分支工作, 原来的版本用于给主线pr, 新版我自己用
3. 顺便修复过程中发现的bug
注:
1. grok（4.6, high)担任后端编码
2. opus5(high)担任前端编码
3. codex（gpt-5.6-luna,  xhigh)探索代码
4. codex（gpt-5.6-sol,  high)担任code reviewer, codex存在过度防御的问题, 你应该自行判断问题是否修复
5. 你担任指挥官和planner, 激进并行, 合理控制每个agent的工作量, 避免单一agent上下文过大

## 后续对话

- 除了这个tab,其他ui似乎也修改成了新版,请你看一下还改了什么
- 调查出结论后就告诉我,等待我的决策后继续
- 你应该把每个选项通俗的解释一下,然后再用提问工具问我,现在看不懂
- 决策（AskUserQuestion）：左栏除三个 Tab 外，找回连接/断开按钮和小圆点（设备管理页 Connect、终端「已断开，点击连接」占位一并恢复）；URL 高亮与设备树折叠记忆保留新版；零散样式全部保留新版。
