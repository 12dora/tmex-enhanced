# 第三阶段 code smell 清理 — 原始 prompt 存档

日期：2026-08-30
分支：`chore/code-smell-round3`（worktree `/Users/konata/code/tmex-enhanced-wt-smell`，base `4a14ff26`）

## 用户 prompt（2026-08-30）

> 继续开发, 请你分批commit并在最后push替换本机tmex, Think in English, Send English prompt.
> 任务：
> 1. 全面排查并修复code smell, 包括高圈复杂度, 超大文件, 超长函数等
> 2. 循环扫描, 修复, 直到你认为只剩低价值的问题无需修复, 或总轮数大于3轮
> 注:
> 1. cursor（grok 4.6, high)担任后端编码
> 2. opus5(high)担任前端编码
> 3. codex（gpt-5.6-luna, xhigh)探索代码
> 4. codex（gpt-5.6-sol, high)担任code reviewer, codex存在过度防御的问题, 你应该自行判断问题是否修复
> 5. 你担任指挥官和planner, 激进并行, 合理控制每个agent的工作量, 避免单一agent上下文过大

## 背景

本阶段承接 `prompt-archives/2026082700-code-smell-cleanup`（第一、二阶段，已合入 main）：

- 第一阶段：大文件拆分、目录结构整理（`plan-00-result.md`）。
- 第二阶段：重复实现收敛、腐朽测试清理、死代码删除、圈复杂度下降（`plan-01-result.md`）。二阶段末 CC>15 的函数 55 个、CC>30 的 3 个、源码约 89.3k 行。

本阶段聚焦仍然存在的高圈复杂度函数、超大文件、超长函数，最多 3 轮「扫描 → 修复 → 审查」。

## 约束

- 所有编码在 worktree 内进行，agent 不做任何 git 操作，由指挥官分批 commit。
- 并行 agent 严格按文件范围隔离。
- 每批 commit 前跑包内 `bun test` + `bunx tsc --noEmit -p .`，错误数不高于基线。
- 不改版本号 / CHANGELOG / 发版脚本（fork 无发布权）。
- 完成后合入 main、push，并用本地 tarball 升级本机 tmex 安装。
