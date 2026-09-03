# 第二十一轮计划：终端流畅度 / 待机功耗 / code smell / 代码库精简

## 背景

第二十轮（1.1.20）结束后，用户提出四项诉求：

1. 使用 tmex 不够流畅，尤其是**终端滚动**；
2. 常驻状态下服务端与 PWA 端的性能消耗偏高，希望减少待机开销、为 PWA 节电；
3. 全面清理 code smell（高圈复杂度、大文件、大函数）；
4. 代码库已较庞大，分析并精简。

分工按用户指定：Claude 指挥 + planner，cursor(grok-4.6 high) 后端编码，codex(gpt-5.6-sol max) 承担复杂性能任务，
Opus5(high) 前端编码与探索，codex(sol high) 做 code review。激进并行，同一 worktree 内按文件集严格隔离。

worktree `/Users/konata/code/tmex-r21`，分支 `feat/round21-perf-idle-slim`，base 为 main `e4ae3dd2`（1.1.20）。

## 现场实测基线（指挥官在生产节点只读采集）

- 网关空闲 **5.65% 单核**（30 s 采样），RSS 310 MB。
- `~/Library/Application Support/tmex/tmex.log` **81 MB / 96k 行，无任何轮转**；近 50k 行中 `[ws-metrics]` ≈64k、`[mesh][rtc]` ≈20k。
- FE 首屏 **366,749 B gzip**（entry chunk，raw 1.19 MB）+ CSS 23 KB；dist 共 29 MB（字体 21 MB）。
- 测试基线：gateway 3750（3 fail + 2 errors 为既有 flake）/ fe 1737 / panels 747 / app 687(+1 已知) / shared 442 /
  stores 420 / ws-client 319 / terminal-ui 358 / ghostty 228 / api-client 155。
- 复杂度门禁 `bun scripts/complexity/gate.ts` **失败，24 条违规**（allowlist 自第 13–20 轮起已漂移）。

## 四份探索报告（sub/）

- `EX1-terminal-scroll-perf.md`：滚动帧实测 4–8 ms 且**在 wheel/touchmove 事件处理器里同步执行**；canvas 逐 cell fillText；
  滚动被当成全屏变化而实为整行平移。附录另有 I/O 与 FE 侧 20 余项。
- `EX2-idle-standby-cost.md`：服务端定时器全量清单（S1–S21）与 PWA 侧清单（P1–P12），并把现场四条观测逐条归因到代码。
- `EX3-code-smell-backlog.md`：24 条违规逐条裁决（16 重构 / 8 重锁）+ 更广普查 + 重复度普查 + 任务 A–H 零重叠文件矩阵。
- `EX4-slimming.md`：死代码、依赖冗余、首屏包体积缝位、跨进程重复；并发现 canonical WS feed 建好但无客户端触发。

## 决策（用户拍板）

- **canonical 状态流本轮做完**：服务端已完整、浏览器已有解码器，缺客户端命令编码器。动机是 failover 重放风暴与按需推送
  两个已测得的痛点。要求 capability 门控 + legacy 完整保留 + 可观测的 kill switch。
- **内置字体不动**：16 MB 只影响安装/升级包体积，不影响页面加载；离线可用与即时切换是真实体验。

## 执行批次

| 批次 | 任务 | 承担 | 关键文件 |
|---|---|---|---|
| 1 | G 设置页三处超限函数 | Opus | fe settings 三文件 |
| 1 | C auth-routes 拆分 | grok | mesh/auth-routes.ts |
| 1 | E 装配根 + TLS/ACME | grok | app runtime/tls |
| 1 | H 跨包 HTTP body 去重 | grok | shared/http、gateway api、app runtime |
| 2 | P1 canvas run 批绘 + 位移感知行复用 + lineCache LRU | codex sol max | canvas-renderer / render-state / coordinator |
| 2 | P2 滚动 rAF + 布局读缓存 | Opus | terminal.ts / terminal-dom.ts / scroll-gesture |
| 2 | P3 PWA 节电（光标闪烁、键盘 follow 循环、轮询门控） | Opus | cursor-layer / use-keyboard-avoidance / mesh-nodes |
| 2 | B1 日志分级 + 轮转 + 连接日志上下文 | grok | mesh-log / rtc-log / ws/index / service.ts |
| 2 | B2 待机成本（指标空转、清扫副作用、缓存、lag 采样、心跳、会话续期） | grok | gateway-metrics-log / policy-scheduler / peer-manager 等 |
| 3 | CAN canonical 客户端迁移 | codex sol max | ws-client transport / stores 订阅 |
| 3 | P4 输入延迟与列表重渲染（草稿持久化去抖、侧栏拖宽、useLocation） | Opus | stores/ui、ui/sidebar、panels files/device-tree |
| 4（排队） | A peer-manager 拆分、B mesh-runtime、D 熔断器统一、F ws-client/ws 门面 | 待文件释放 | — |
| 4（排队） | 死代码删除、依赖瘦身、首屏懒加载 | 待文件释放 | — |
| 末 | allowlist `--tighten` 统一收紧、codex 审查、e2e、发版替换本机 | 指挥官 | — |

## 验收标准

- 各包测试不低于基线；`bunx tsc --noEmit` 错误数不高于基线；`biome check` 通过。
- 复杂度门禁从 24 条违规回到 **0**（重构 + 有理由的重锁）。
- 滚动帧的 bench 指标：`dirtyRows/frame` 从 40 降到≈滚动格数、`full` 帧从 200/200 降到 0/200。
- 生产节点空闲 CPU 与日志增长量在升级后复测下降。
- mesh e2e 12/12；fe e2e 不劣于既有基线。

## 风险

- 终端渲染与 canonical 迁移都动主数据路径，必须靠像素级/往返级测试兜底，并保留 legacy 回退。
- 待机优化不得削弱 mesh 存活判定、failover 与重连语义（O13/O14 一类改超时的提案本轮不做）。
- 多 agent 并行同一 worktree：文件集严格隔离，allowlist 由指挥官统一收紧，agent 不做 git 写操作。
