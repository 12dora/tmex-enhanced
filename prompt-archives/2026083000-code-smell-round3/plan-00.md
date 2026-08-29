# 第三阶段 code smell 清理 —— 执行计划

分支：`chore/code-smell-round3`（worktree `/Users/konata/code/tmex-enhanced-wt-smell`，base `4a14ff26`）
日期：2026-08-30

## 背景

承接 `prompt-archives/2026082700-code-smell-cleanup` 的一、二阶段（已合入 main）：一阶段拆大文件与目录整理，二阶段收敛重复实现、清理腐朽测试与死代码。本阶段目标是**高圈复杂度、超大文件、超长函数**，最多三轮「扫描 → 修复 → 审查」。

## 度量口径

自建 TS-AST 分析脚本（scratchpad `cc.ts`）：按 `if / for / while / case / catch / ?: / && / || / ??` 计 McCabe，嵌套函数单独计数；文件行数区分源码与测试（`*.test.ts`、`e2e/`、`test-support/` 等归测试）。

基线（`4a14ff26`）：CC ≥ 15 的函数 69 个，CC ≥ 30 的 3 个；源码 634 文件 / 89.5k 行，测试 326 文件 / 61.9k 行；最大源码文件 `ghostty-wasm.ts` 1496 行。

包级测试与 tsc 基线见 `sub/` 内各 agent 报告开头（gateway 1472 pass / tsc 27，panels 196 / 0，terminal-ui 205 / 0，ghostty 138 / 0，shared 141 / 0，stores 101 / 1，ws-client 75 / 0，app 90 / 1）。

## 角色分工

- 指挥官（Claude Opus 5）：度量、拆任务、分批 commit、跑实测与 e2e、判断 review 结论。
- 探索（codex `gpt-5.6-luna` xhigh，只读）：按 gateway / 前端 / libs 三路并行出**可执行的重构清单**，含风险、既有测试覆盖、预期收益，并显式列出「不值得做」的项。
- 后端编码（cursor-agent `cursor-grok-4.6-high`）：gateway、shared 协议、CLI。
- 前端编码（Claude Opus 5 子代理）：panels / fe / stores / terminal-ui / ghostty-terminal。
- 审查（codex `gpt-5.6-sol` high，只读）：每轮按范围并行审查 diff，只报能落到具体代码路径的行为漂移。codex 偏防御，是否修由指挥官判断。

同一 worktree 并行，按文件范围严格隔离；agent 不做任何 git 操作。

## 三轮安排

**Round 1 —— 探索 + 主体重构**（11 个 agent 并行）
按 codex 三份 research 报告执行：gateway 12 项、前端 8 项、libs 11 项中价值/风险比高的部分。产出 16 个 commit。

**Round 2 —— 剩余复杂度热点 + 超大文件**（9 个 agent 并行）
Round 1 后 CC ≥ 15 仍有 46 个，按度量清单直接派活（API 校验、db 写入、retention、agent tools、push/weixin、stores/shared/terminal-ui），另拆 `ghostty-wasm.ts`。要求每个 agent **先判断是否值得改**，扁平 dispatch 一律跳过并说明理由。

**Round 3 —— 超大文件收尾 + 审查修复**（5 个 agent）
`ssh-external-connection.ts` / `external/session-commands.ts` / `ws/index.ts` / `terminal.ts` 的纯搬移式拆分（原路径继续 re-export，不改任何调用方），加上最后三个未处理的复杂度点（`parseIpv6ToBytes`、`executeDependencyInstall`、`detectPackageManager`，均先补测试再动代码）。

## 验收标准

1. 各包 `bun test` 通过数不低于基线且 0 fail；`bunx tsc --noEmit` 错误数不高于基线。
2. 改动文件 `bunx biome check` 不新增问题（仓库整体存在既有问题，只比增量）。
3. e2e 与 main 逐条比对，不引入新失败。
4. 行为保持：审查发现的行为漂移必须修复或有明确理由保留。
5. 不改版本号 / CHANGELOG / 发版脚本。

## 风险

- 并行编辑同一包时测试互相干扰：约定「范围外失败即他人在途改动」，最终由指挥官统一全量验证。
- 纯搬移式拆分可能悄悄改变 `this` 绑定、闭包捕获、清理顺序：审查阶段按这几条机械核对。
- 协议 / WASM / SSRF 相关代码改动风险高：要求先补表驱动测试再重构。
