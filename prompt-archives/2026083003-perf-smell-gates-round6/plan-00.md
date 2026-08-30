# 第六轮计划：性能热点调优 → code smell 第五轮 → 复杂度门禁

## 背景

- 基线 main `19dd4992`（r5 收尾），worktree `../tmex-enhanced-wt-r6`，分支 `feat/round6-perf-smell`。
- 前四轮 code smell 清理的保留清单见记忆 `code-smell-retained-hotspots` 与 `prompt-archives/2026083001-*/plan-00-result.md`「未做/后续」；本轮不重复讨论。
- 分工：cursor-agent(grok-4.6 high) 后端、Opus 前端、codex luna(xhigh) 探索、codex sol(high) 审查；指挥官分批 commit，最后 build → tarball → 本机 `upgrade --apply-current-package`。
- 用户关切：类似 Claude Code 长对话滚动卡顿；控制行数膨胀；收尾加函数长度/圈复杂度门禁。

## 基线

- 测试：`sub/test-baseline.txt`（全绿；tsc 既有错误 gateway 21 / stores 1 / api-client 5 / app 1）。
- 复杂度：`sub/cc-baseline.txt`（CC>15 函数 48、>80 行 159；脚本 `sub/cc.ts`）。biome `noExcessiveCognitiveComplexity` 阈值 15/20/25 下产品源码违规 143/58/32。

## 阶段 1：性能（≤3 轮）

第 1 轮探索 `sub/X1..X4-report.md`（agent 对话 / 终端渲染 / gateway / 全局 re-render+bundle），派发：

| 任务 | 执行者 | 内容 |
|---|---|---|
| G1 | grok | forwarder pendingStreams 泄漏；PaneData 只读头不解码 data；frame-sizer 缓存有界 |
| G2 | grok | agent 每轮按预算窗口化加载历史，标题生成复用 |
| G3 | grok | hub node.list 一次编码多发 + 未变不发；getPeer O(1)；idle/parked/retiring 轮询改 deadline 定时器 |
| P1a | Opus | 历史块按 messages 引用缓存 + live overlay；行组件 memo；默认只渲染最后 200 块（展开更早）；rAF 自动滚动 |
| P1b | Opus | 流式 markdown 增量切块 + 按块 memo；composer 隔离；persist 仅字段变化时写 |
| P2a | Opus | LF 规范化单趟；历史分页批量回放；coalescer 时间窗 |
| P2b | Opus | ghostty 行 dirty 短路；选区拖拽不走全量渲染 |
| P2c | Opus | TERM_OUTPUT 零拷贝解码 |
| P3a | Opus | CodeViewer highlightAuto 守卫；Markdown/设置页 lazy 分块；入口不含 qrcode |
| P3b | Opus | 设备连接状态按设备选择器；device-card memo；device-tree-navigation / folder-tree 上下文收窄 |
| P3c | Opus | 侧栏 agent 会话按 pane 选择；files tab 行 memo + 单目录显示上限 |

未派（价值/风险判定）：canvas 文本 run 批绘（视觉风险，视第 2 轮）、DataChannel 分片双拷贝（LOW）、scrollback 内存预算（LOW）、目录虚拟化（改用显示上限）。

第 2/3 轮：合入后重新探索（复测剩余热点 + 新引入问题），只挑高价值。

## 阶段 2：code smell（≤3 轮）

以 `cc-baseline.txt` 为准，优先 r5 新增热点（`parseAction` 40、`TunnelStatusCard` 34、`enrichCandidate` 25、`wizardStepState` 27、`handleAction` 23、tunnel `status` 18）与 >2000 行的 `peer-manager.ts`；不碰保留清单。

## 阶段 3：门禁

`scripts/complexity-gate.ts`（McCabe CC ≤ 阈值、函数行数 ≤ 阈值、文件行数 ≤ 阈值，显式 allowlist 记录保留项）接入 `bun run lint`；评估同时开启 biome `noExcessiveCognitiveComplexity`。

## 验收

- 各包测试不少于基线、tsc 错误不高于基线、biome 通过；净行数不显著增长。
- 每批经 codex sol 审查，指挥官判定是否修。
- `bun run build` 成功、tarball 烟测、本机升级 healthz ok。
