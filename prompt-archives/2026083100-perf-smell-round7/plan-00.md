# 第七轮计划：性能热点深度调优（≤3 轮）+ code smell 清理（≤3 轮）+ 顺手修 bug

## 背景

第六轮（`prompt-archives/2026083003-perf-smell-gates-round6/`，main `8897894c`）已完成三轮性能 + 一轮 smell + 复杂度门禁（`bun run lint` 含 `scripts/complexity/gate.ts`，allowlist 118 条）。本轮在 worktree `../tmex-enhanced-wt-r7`（分支 `feat/round7-perf-smell`，base = main `8897894c`）继续挖掘剩余高价值点。

已知不再重复的项（第六轮已做或已判 LOW）：见 `2026083003-.../plan-00-result.md`「未做/后续」与记忆 `code-smell-retained-hotspots`。探索 prompt 中已注入排除清单。

## 分工（与前几轮一致）

- codex gpt-5.6-luna(xhigh, read-only)：探索（E*/性能、S*/smell、V*/复核）
- cursor-agent grok-4.6(high)：后端（gateway/shared/mesh）编码
- Opus(high, Agent 工具)：前端（fe/terminal-ui/stores）编码
- codex gpt-5.6-sol(high)：code review（过度防御项由指挥官裁决）
- 指挥官：拆任务、并行调度、亲自跑验证/基准、分批 commit、最终 push + 本机 tarball 上线

## 流程

1. **性能阶段（≤3 轮）**：每轮 = 并行探索（E1 gateway / E2 fe 终端+agent / E3 fe 全局 / E4 shared+mesh+bug）→ 指挥官筛 HIGH/MED → 按文件集不重叠拆任务派 grok/Opus 并行修 → codex sol 分区 review → 指挥官裁决+修复 → 包内测试+tsc+门禁过 → commit。无 HIGH 项即提前收束。
2. **smell 阶段（≤3 轮）**：性能阶段完毕后进行；探索找 CC/大函数/大文件新热点（避开保留清单），修复后收紧 allowlist 对应条目。
3. **收尾**：全包测试、复杂度门禁、e2e 抽查 → 存档全部 prompt/report/result → push → 本地 tarball 构建 + 烟测 + `upgrade --apply-current-package` 替换本机 tmex。

## 验收标准

- 各包 `bun test` 通过数不低于基线（gateway 2800/0 fail 等，基线文件 `sub/baseline-tests.txt`）；tsc 错误数不高于基线（gateway 21 / stores 1 / api-client 5 / app 1）
- `bun run lint`（含复杂度门禁）通过；改动文件复杂度下降时收紧 allowlist
- 每个性能修复有可量化依据（bench 或明确的调用频率×成本推理）；回归风险高的改动配基准对照
- 本机生产 healthz ok、页面可用

## 风险与注意

- 并行 agent 文件集必须互不重叠；共享 barrel/package.json 由指挥官改
- 不改发版相关文件（版本号/CHANGELOG/构建脚本）；tarball 构建按 `fork-release-local-install` 流程手动补 `--external cpu-features`
- 严禁触碰生产 tmex（9883 端口、`~/Library/Application Support/tmex/`）与名为 `tmex` 的 tmux session；测试用独立 socket
- e2e 在 main 上有 9 个既有失败（见记忆 `e2e-baseline-failures`），只对比增量
