# Round 12 计划：round11 遗留项收尾（保活退订 / mesh 轮询 / 后台心跳 / tsc 清零 / KI-3）

## 背景

- 基线：main `6da45fe6`（v1.1.7）。worktree `../tmex-enhanced-wt-r12`，分支 `feat/round12-leftovers`。
- 来源：`prompt-archives/2026090101-round11-pwa-files-auth/plan-00-result.md` 列出的「未做（EX1 需设计项）」：保活 pane 停止订阅、网关按 pane 订阅 control-mode 输出、mesh DTO 瘦身、agent 会话列表延迟加载；另附带 round11 未处理的后台心跳、gateway 既有 21 条 tsc 错误、KI-3 opencode 三例 e2e。
- 多 agent 分工同 round11：codex luna 只读探索（EX1–EX4，报告在 `sub/EX*-result.md`）；Opus 写前端（K1/M1/H1）；grok 写后端（G1）；codex sol 审查（RV*）；指挥官分批 commit、亲自做场景实测与 KI-3 harness 修复。

## 探索结论（摘要，详见 `sub/EX*-result.md`）

- **EX1 保活 pane**：隐藏保活实例（最多 2 个）仍在订阅集（`pane-subscriptions.ts` 取所有已挂载 pane 的并集），网关按 selected ∪ subscribed 投递，所以隐藏 pane 确实收实时输出；但 `useViewportClaims` 只对可见 pane 实例化、网关忽略 `visible:false` 声明，**不参与视口仲裁**。legacy 路径没有 screen-only 快照与序列号，只能走「冷 select + `TERM_HISTORY` 全量重放」回灌（现有可接受闪烁模型）。后台心跳固定 5 s / 10 s 超时，网关无 socket 空闲超时。
- **EX2 网关按 pane 订阅**：tmux ≥ 3.2 `refresh-client -A pane:off` 可行（项目仅保证 ≥ 3.0，需门闸；关掉后 tmux 不回放漏掉的字节，需 capture 重建 + parser 重置），但**推送通知（bell/OSC）与 agent headless ghostty（OSC 133）都是全 pane 原始输出的活消费者**，安全实现需「需求协调器」约 650–1000 行。**不做**。
- **EX3 mesh DTO**：5 节点约 2.5 KB/次、约 0.3 MB/h，瘦身需 250–450 行；mesh WS 已推送 status/reach/inventory/version/transport/rtt，REST 只剩成员变更、`loggedIn`、诊断字段兜底。**改为拉长兜底轮询到 5 min + 事件驱动刷新**（WS 重连 / 可见且过期 / 准入撤销 / 设置与诊断打开），不动 DTO。
- **EX4 agent 会话**：列表不含消息（约 0.5 KB/会话），终端侧栏要靠它渲染 pane 下的会话行（标题/状态点/菜单），延迟加载会砍掉现有 UI；summary 视图 180–300 行只有会话数上百才有感。**暂不做**，以后与保留/清理策略一起设计。

## 任务清单与分派

| 编号 | 角色 | 内容 | 范围（文件集） |
| --- | --- | --- | --- |
| K1 | Opus | 保活 pane「暖实例、冷订阅」：隐藏超过宽限期（60 s）后从订阅集摘除（sink 保留）；重新显示时若已退订则走冷 select（`wantHistory:true`，保持 `selectPaneWithSize` 顺序）；宽限期内重新显示仍走暖路径 | `packages/terminal-ui/src/components/{Terminal.tsx,types.ts,hooks/usePaneSinkRegistration.ts}`、`packages/panels/src/device-console/{terminal-stage.tsx,terminal-keep-alive.ts,use-pane-route-reconciliation.ts}`、`packages/stores/src/pane-subscriptions.ts`（必要时） |
| M1 | Opus | mesh 兜底轮询 30 s → 5 min；事件驱动立即刷新：mesh WS 重连、`visibilitychange → visible` 且过期、准入/撤销事件、设置-节点页与诊断弹层打开 | `apps/fe/src/node/{mesh-nodes.ts,mesh-nodes-resident.tsx,mesh-events.ts}` + 测试；设置/诊断处只加刷新调用 |
| H1 | Opus | 页面隐藏时心跳间隔 5 s → 30 s（PONG 超时同比放大），恢复可见时立即 PING 并回到 5 s | `packages/ws-client/src/{heartbeat-controller.ts,client.ts}` + 测试 |
| G1 | grok | gateway 既有 21 条 tsc 错误清零（不改运行时行为，不加 `any`/`@ts-ignore`） | 见 `sub/G1-prompt.md` 列表（11 个文件，全在 `apps/gateway/src`） |
| KI-3 | 指挥官 | `terminal-mouse-recovery.spec.ts` 的 opencode 三例：禁用 opencode 更新检查、放宽 alt-screen 等待；通过后从 `docs/known-issues.md` 移除 | `apps/fe/tests/terminal-mouse-recovery.spec.ts`、`docs/known-issues.md` |
| RV1–RV2 | codex sol | 前端（K1/M1/H1）与后端（G1）两路审查 | — |

## 验收

- 各包单测不低于基线；tsc 错误数不高于基线（gateway 目标 0）；biome 对改动文件干净；复杂度门禁 ok。
- e2e 全量与 KI-3 基线逐条比对；`viewport-policy`、`files-sidebar-drag` 等 round11 新增用例仍过。
- 指挥官临时实例实测：切换三个 pane 后等 60 s 再切回，确认历史回灌、无重复 scrollback；页面隐藏后 PING 间隔变化；mesh 列表在 WS 重连后刷新。
- 分批 commit → 发版 1.1.8 → `tmex upgrade` 替换本机。

## 注意事项

- 生产 tmex（9883、`~/Library/Application Support/tmex/`）与 tmux session `tmex` 严禁触碰；测试用独立 socket。
- 同一 worktree 并行编辑，任务文件集互不重叠；agent 不 commit。
- 前端代码改动期间不跑 e2e。
