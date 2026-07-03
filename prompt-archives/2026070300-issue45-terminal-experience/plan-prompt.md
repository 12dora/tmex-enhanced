# Issue #45 终端体验问题 — 原始 Prompt 存档

## 初始需求（2026-07-03）

> 开启新的worktree，研究一下issue #45

### Issue #45 全文

> 几个bug：
> 1. 分屏后，TUI接收到的鼠标事件的坐标和实际点击区域差了一行
> 2. 单窗口pane触发分屏之后，会触发清屏
> 3. claude code等TUI有几率在运行了一段时间后触发清屏，屏幕上只剩一点点内容在更新
> 4. 使用中文输入法输入文字，输入速度过快有几率对应文字部分出现空白，要继续输入才能刷新刚刚空白的显示区域（可能和3有关）

## 规划期间确认的决策

通过 `question` 工具确认的 3 个关键决策：

1. **推进方式**：生成完整工作计划（覆盖 4 个 bug，单计划可由 `/start-work` 执行）
2. **测试策略**：TDD（RED-GREEN-REFACTOR）—— bug 2/3/4-C 适用标准 TDD，bug 1 诊断优先（根因确定后再 TDD）
3. **不确定性处理**：诊断驱动 —— bug 1 用 Playwright 动态诊断确定根因；bug 4 先验证最高杠杆候选 C（`syncTextareaPositionToCursor` 消费 dirty），不足再补 A/B

## 关键澄清（来自用户对模型选择的反馈）

- 后续所有 subagent 必须使用 glm-5.2 模型；当 task() 内部 category 模型不可靠时，atlas 直接接管作为 fallback
