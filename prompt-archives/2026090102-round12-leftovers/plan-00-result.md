# Round 12 执行结果

分支 `feat/round12-leftovers`（worktree `../tmex-enhanced-wt-r12`，基于 main `6da45fe6`），版本 **1.1.8**。

## 调查结论（EX1–EX4，codex luna）

| 遗留项 | 结论 |
| --- | --- |
| 保活 pane 停止订阅 | 隐藏保活实例确实仍在订阅集（挂载 pane 的并集），但不参与视口仲裁；legacy 路径只能「冷 select + 全量历史」回灌。**做**（加 60 s 宽限期保留秒切） |
| 网关按 pane 订阅 control-mode | tmux ≥ 3.2 `refresh-client -A pane:off` 可行，但推送通知（bell/OSC）与 agent headless ghostty（OSC 133）依赖全 pane 原始输出，安全实现需需求协调器 650–1000 行。**不做** |
| mesh DTO 瘦身 | 5 节点约 2.5 KB/次、0.3 MB/h；WS 已推送多数字段。**改为拉长兜底轮询 + 事件驱动**，不动 DTO |
| agent 会话延迟加载 | 列表不含消息（0.5 KB/会话），终端侧栏要用它渲染会话行，延迟加载破坏 UI；summary 视图 180–300 行只在会话上百时有感。**暂不做**，待与保留/清理策略一起设计 |

## 分派与产出

| 任务 | 角色 | 结果 | 提交 |
| --- | --- | --- | --- |
| H1 | Opus | 页面隐藏时心跳 5 s/10 s → 30 s/60 s，`HeartbeatController.setCadence` 运行时改节奏（不补发 PING、在途 PONG 沿用原截止），非浏览器宿主恒快节奏 | 4bdcf045 |
| M1 | Opus | mesh 兜底轮询 30 s → 5 min；WS 连上/重连、陌生 node 事件（每拍放行一次）、回前台（30 s 过期阈值）即时补拉，2 s 节流；hub 管理面保持 30 s；设置-节点页挂载补拉 | acadd8c6 |
| K1 | Opus | `KeepAlivePool.coldPanes` + scheduler：隐藏满 `KEEP_ALIVE_COLD_DELAY_MS`（60 s）置冷，`Terminal subscribe` 只撤 `mountPane` 贡献（sink/实例保留）；置冷 pane 再显示不算 warm，走既有冷 select 重放历史 | 73511bae |
| G1 | grok | gateway 既有 21 条 tsc 错误清零（gramio offset 改 `onResponse('getUpdates')` 跟踪；`process.off` 走 EventEmitter 视图；`Omit` 补 `historyText` 等），行为中立 | d789496b |
| RV1 / RV2 | codex sol | 前端 1 blocker + 1 should-fix（均针对 M1，见下）；后端零发现 | — |
| 审查修复 | Opus（M1） | `ensureFreshMeshNodes`：在途时登记一次尾随请求而非并入旧请求；订阅 api-client `onAuthRequired`，节点级 401 就地 `markLoggedOut` 并补拉（同 node 重复 401 不回源） | f980f57a |
| KI-3 | 指挥官 | opencode 三例真因：e2e pane cwd 继承客户端 cwd、跨 worktree 后被删除，`opencode .` 报错退出；helper 建 pane 显式 `-c apps/fe`，spec 禁自动更新 + `--pure`，等待放宽 40 s | 55f0dd2c、18a7ccc4 |

## 验证

- 单测：ws-client 286 → 295；fe 1130 → 1140；panels 724 → 745；stores 415 → 419；terminal-ui 358；gateway 3134 / **tsc 0**（原 21）。`biome check .` 干净；复杂度门禁 ok。
- e2e 全量：105 pass / 5 fail / 1 skip。5 失败中 opencode 三例由 harness 修复后通过（2 遍）；`ws-borsh-resize:268`、`mobile-keyboard-avoidance:188` 单跑 2/2 通过，属全量高负载抖动，已登记到 KI-3「另注」。
- 场景实测（`sub/live-round12.spec.ts`，跑在 e2e harness 上）：
  - 保活：切走后 10 s 内隐藏 pane 仍收 41 帧输出（宽限期内）；68 s 后 10 s 内 **0 帧**；切回收到 1 帧 `TERM_HISTORY` 并恢复实时（5 s 20 帧），可见 34 行 TICK 无重复。
  - 心跳：可见 20 s → 4 次 PING；隐藏 35 s → 1 次；恢复可见立即 PING，20 s → 3 次。
  - mesh 事件驱动刷新：单节点 standalone 实例下 mesh 轮询不激活，只有单测覆盖（14 例），未做多节点实测。

## 上线

- 见本文件末尾追加。
