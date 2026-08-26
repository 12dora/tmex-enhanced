# Plan 00 执行结果：code smell 清理（三轮）

分支 `chore/code-smell-cleanup`（基于 main `bb9d84f` / v1.0.2），57 个 commit，411 个文件，+50.8k / −26.0k 行。

## 流程

三轮"探索 → 编码 → 审查 → 修复"循环，按角色分派：codex gpt-5.6-luna(xhigh) 只读探索、grok-4.6(high) 后端编码、Claude Opus 5 前端 / TS lib 编码、codex gpt-5.6-sol(high) 审查（共 11 轮，报告见 `reviews/`）。所有 agent 在同一 worktree 并行，按文件范围隔离，指挥官分批 commit。探索报告见 `research*.md`。

## 拆分结果（行数 before → after）

| 文件 | before | after |
|---|---:|---:|
| `apps/gateway/src/ws/index.ts` | 2155 | 726 |
| `apps/gateway/src/tmux-client/ssh-external-connection.ts` | 2020 | 769 |
| `apps/gateway/src/tmux-client/local-external-connection.ts` | 1915 | 613 |
| `packages/ghostty-terminal/src/terminal.ts` | 2269 | 765 |
| `packages/panels/src/device-console/device-console.tsx` | 1471 | 581 |
| `packages/panels/src/device-tree/sidebar-device-list.tsx` | 1383 | 252 |
| `apps/gateway/src/db/index.ts` | 1250 | 77 |
| `packages/shared/src/index.ts` | 1230 | 112 |
| `apps/gateway/src/ws/canonical-feed-session.ts` | 1201 | 563 |
| `packages/stores/src/agent.ts` | 1113 | 135 |
| `apps/gateway/src/api/index.ts` | 1041 | 48 |
| `apps/gateway/src/tmux-client/pane-retention.ts` | 1030 | 228 |
| `packages/terminal-ui/src/components/Terminal.tsx` | 1026 | 272 |
| `apps/gateway/src/agent/run.ts` | 1013 | 452 |
| `apps/gateway/src/watch/service.ts` | 908 | 424 |
| `packages/stores/src/tmux.ts` | 888 | 376 |
| `packages/ui/src/components/sidebar.tsx` | 860 | 30 |
| `packages/terminal-ui/src/components/SplitTerminalArea.tsx` | 748 | 251 |
| `packages/ws-client/src/transport.ts` | 644 | 26 |
| `packages/panels/src/agent/agent-tab.tsx` | 635 | 81 |
| `packages/panels/src/watch/watch-rule-form.tsx` | 564 | 186 |
| `apps/fe/src/pages/SettingsPage.tsx` | 557 | 179 |
| `apps/gateway/src/tmux-client/pane-stream-parser.ts` | 557 | 92 |
| `packages/terminal-ui/src/components/useMobileTouch.ts` | 532 | 42 |

SSH/本地 tmux 连接 72% 重复代码合并为 `ExternalTmuxConnectionCore`（559 行）+ `external/` 协作者；`this as never` 类型逃逸在 ws / tmux-client 边界清零。

## 顺手修复的 bug（均有回归测试）

后端（gateway）：
- ws：关闭期间在途连接创建写回注册表泄漏；畸形 Borsh payload 导致未处理 rejection；handler 异常曾被误报为 decode 失败；背压帧被误重发（重复 gap / `backpressure_gap` 断连）。
- agent：`send_input` 用 `onByte` 而非 `onBytes`（行模式增量缓冲永远为空）；重试未清 pending delta；`AgentSupervisor.stop()` 超时后清空 activeRuns 导致重复 run；同进程 stop→start 后队列无消费者；显式 stop 被 stale-run 自动恢复覆盖；fatal streak 销毁其他 run 共享的 emulator；run 结束无条件 destroy 共享 emulator。
- tmux-client：`%session-renamed` name-only 通知被丢弃 / `$N` 开头名字误判；本地快照失败不再上报 `onError`（拆分回归）；runtime connect 失败不释放底层连接 / 不清理资源；projection dispose 后仍写缓存；测试硬编码 `/Users/krhougs`。
- 其他：`health-check.sh` 在 `set -e` 下首个计数即退出、WS 检查假通过；`dev-supervisor.sh` 无 ssh-agent 时每秒重启 gateway；`run.sh` 生成未做 shell 转义。

前端 / lib：
- 设置页保存时静默覆盖 SSH 重连配置；会话排序比较器不满足反对称；草稿快速双击创建两个会话；首次历史加载覆盖在途消息；删除会话后在途历史回写复活；断连未取消重选定时器；设备列表每帧重建数组引发 effect 风暴；分屏每次渲染重挂终端 ref；侧栏拖拽中折叠导致动画永久禁用；发送反馈定时器未清理。
- ghostty：3 处 WASM 句柄泄漏（render-state / formatViewport / setTerminalTheme）；光标样式被忽略、`blinking=false` 仍闪烁；resize 非原子且未失效行缓存；bindings 加载失败永久缓存 rejected promise；触摸交给原生滚动条时长按未解除。
- ws-client：旧 socket 事件污染新连接；socket 工厂同步抛错卡在 CONNECTING；select 状态机旧定时器误伤新事务；pane reset 丢失 origin 导致误上报尺寸；`pongTimeoutMs` 误成必填。
- shared / api-client / notifications：chunk 重组未校验 kind/seq、重复分片不丢流；下载 prepare 阶段异常不删远端 session；bell 定时器互相踩踏。

## 验证

- 单测：2400+ pass / 0 fail（基线 1583），所有包 `bun test` 全绿；`bun run build:fe` 成功。
- tsc：gateway 34（基线 37），fe 0，其余包不高于基线；shared / ghostty / api-client / notifications / ws-client / ui 的 tsconfig 补齐 `bun-types`。
- e2e（Playwright，105 用例）：分支 96 pass / 9 fail，9 个失败与 main 基线逐条一致（见 `e2e-baseline-failures` 记忆），无回归；ghostty 拆分曾引入 3 个探针回归（`cellDimensions()` / `lastCursor`），已修复。

## 未做 / 后续

- 第 3 轮探索认为剩余大文件（ghostty-wasm 1.4k、canvas-renderer、render-state、state-machine）内聚度尚可，未继续拆。
- `mobile-settings.spec.ts` 等 9 个 e2e 既有失败、`packages/stores/src/host-services.test.ts` 与两个 issue45 测试文件的既有 tsc 错误未处理（不在本任务范围）。
- `WebSocketServer` 仍保留部分转发方法（测试契约依赖），`useDevicePaneSelection` 的 follow effect 每次快照重跑属既有行为。
