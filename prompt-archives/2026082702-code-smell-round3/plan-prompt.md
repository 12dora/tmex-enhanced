# Prompt Archive

## 2026-08-27（第三阶段）

### User

继续开发, 请你分批commit并在最后push, Think in English, Send English prompt.
任务：
1. 扫描并修复本项目高圈复杂度, 巨大文件, 巨大函数, 函数等code smell
2. 在上述过程中如果发现你认为有价值的bug, 顺手修复
3. 最后重新整理文档,删除所有无用的开发,审计过程文档, 已腐朽的文档
4. 在tmex-enhanced-wt-tabs分支工作
注:
1. grok（4.6, high)担任后端编码
2. opus5(high)担任前端编码
3. codex（gpt-5.6-luna,  xhigh)探索代码
4. codex（gpt-5.6-sol,  high)担任code reviewer, codex存在过度防御的问题, 你应该自行判断问题是否修复
5. 你担任指挥官和planner, 激进并行, 合理控制每个agent的工作量, 避免单一agent上下文过大

### Execution notes

- 工作在 worktree `../tmex-enhanced-wt-tabs`（分支 `feat/sidebar-tabs-ui`，已包含前两阶段 `chore/code-smell-cleanup` 的全部提交，见 `../2026082700-code-smell-cleanup/plan-0{0,1}-result.md`）。
- 探索：`codex exec -m gpt-5.6-luna -c model_reasoning_effort=xhigh -s read-only`；后端编码：`grok -m grok-4.6 --effort high`；前端编码：Claude Opus 5 subagent；审查：`codex exec -m gpt-5.6-sol -c model_reasoning_effort=high`。
- 禁止触碰生产 tmex 服务 / `tmex` tmux session；测试只用 test env。
- 文档整理：`docs/` 与 `prompt-archives/` 中的过程性文档（审计、审查轮次、研究报告）与已腐朽（引用不存在的文件/流程）的文档删除；保留仍能指导开发的设计/运维文档。

### User（追加）

追加任务: 1.查找潜在性能问题并深度调优, 如果有计算密集热点是否考虑使用rust替代计算热点代码

### Execution notes（追加）

- 新增 codex(luna, xhigh) 性能探索：`research-perf.md`，覆盖 gateway 热路径（tmux 输出流解析 / Borsh 编解码 / WS 扇出 / DB 查询）与前端（ghostty 渲染 / render-state diff / store 更新）。对计算密集热点评估 Rust（napi-rs / wasm）替代的收益与成本，由指挥官决定是否落地。
