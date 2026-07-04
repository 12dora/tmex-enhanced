# plan-01 执行结果：mode 2031 主题通知注入

按 `plan-01.md` 完成实现，全部在 worktree `theme-spike`（分支 `worktree-theme-spike`）。

## 改动清单（实际落地）

- `apps/gateway/src/tmux-client/pane-stream-parser.ts`：新增 `csi` phase（旁路观察 + 原样回填，64B 上限，多参数解析，DCS passthrough 期间打标不上报，flush 后不完整 CSI 回填复位）；`onThemeSubscription` 回调。
- `apps/gateway/src/tmux-client/control-mode-subscription.ts`：回调转发。
- 新增 `apps/gateway/src/tmux-client/theme-subscriptions.ts`（+单测）：内存订阅 Set（note/clear/prune/restore/has/list/reset）。
- `local-external-connection.ts` / `ssh-external-connection.ts`（对称）：tracker 接线、`@tmex_2031` pane 选项持久化（fire-and-forget + rejection 兜底）、prompt-marker A 清位、prunePanes 同步、首次快照后 `list-panes -a -F '#{pane_id}|#{@tmex_2031}'` 恢复（`|` 分隔避 LANG=C tab 坑）、`signalThemeChange` 复活（订阅 + kill switch + connected 三重 guard → sendInput 注入 997）、`setWindowStyle` 改 async 可 await（错误内部上报后 resolve）。
- `device-session-runtime.ts`：接口/委托 `setWindowStyle` 返回 `Promise<void>`。
- `ws/index.ts`：`scheduleTmuxThemeApply`（latest-wins 合并）编排"await 全设备 window-style（allSettled）→ broadcastThemeChange"；`handleSetWindowStyle` 同样先 await 再补发；`handleSiteThemeUpdate` 改走编排，S2C 即时发。
- `runtime.ts`：HTTP 入口注册链改调 `scheduleTmuxThemeApply`。
- `config.ts`：`themeNotify2031Enabled`（`TMEX_THEME_NOTIFY_2031`，默认 true）。
- 测试：parser 7 新用例、tracker 单测、集成测试 2 条（订阅→注入→清位；`@tmex_2031` 恢复）、e2e `theme-notify-2031.spec.ts`（fake TUI 收 997 双向 + idle pane 零污染）。
- 文档：`docs/appearance/2026070501-tui-theme-notify-2031.md`。
- 附带：spike 脚本入库 `scripts/spike-theme/`（e2e 复用 dump-tui.py）。

## 验收结果

| 项 | 结果 |
|---|---|
| gateway 全量单测+集成（785 tests） | ✅ 全绿 |
| packages/shared 等 | ✅ 全绿 |
| e2e theme-notify-2031 | ✅ PASS（双页模式：单页离开设备页会释放连接，gateway 日志证实） |
| 既有 theme e2e 回归（broadcast/propagation） | ✅ 7 passed |
| ws-borsh-theme-resize（rapid toggle × resize drift） | ⚠️ 失败，**main 基线同挂**（drift 3 vs 阈值 2，时序敏感既有 flaky，与本次无关） |
| ghostty-terminal issue45-cross-bug × 2 | ⚠️ 基线既有失败（本次对该包零改动） |
| 真机 opencode（e2e 环境完整链路） | ✅ dark↔light 双向换肤 |
| kill switch `TMEX_THEME_NOTIFY_2031=0` | ✅ 订阅照常跟踪、零注入 |
| biome | ✅ 改动文件已过（余一处正则告警与其复制来源 theme-broadcast.spec 基线一致） |
| 生成文件 | ✅ 零改动 |
| 红线 | ✅ 全程未触碰 `tmex` session/默认 socket 生产 session/9883 服务；e2e 走 `tmex-e2e` socket |

## 实现中的关键发现（后来者注意）

1. **e2e 里设备连接由"观看者"维持**：页面离开设备页 gateway 即断开设备（"no more clients … disconnecting"），涉及广播注入的测试必须双页（viewer 常驻 + 操作页）。
2. tmux `%output` 在 pause 模式改发 `%extended-output`，解析两种形态（spike-assert 曾因此误判）。
3. TS 对闭包变量在相互递归函数中的窄化会误报（`phase` 比较），用显式类型注解的中间 const 绕开。
4. 集成测试在全仓并发下可能遇 EAGAIN 进程压力误挂，单独跑稳定（本机已知环境特性）。

## 未做/延后

按 plan"明确不做"执行：focus 注入、1004 跟踪、OSC 代答、盲 push、997-on-subscribe、污染检测器均未实现。codex 热切换等上游支持。
