# 第二阶段执行结果：重复代码 / 腐朽测试 / 可删减点 / 圈复杂度

分支 `chore/code-smell-cleanup`，在第一阶段（`1cb69c0`，见 `plan-00-result.md`）之上继续，本阶段 23 个 commit。

## 流程

探索（codex gpt-5.6-luna xhigh，报告 `research4-*.md`：后端重复、前端重复、测试审计两轮、死代码）→ 编码（grok-4.6 后端 / Claude Opus 5 前端与 lib）→ 审查（codex gpt-5.6-sol，`reviews/round12–15.md`）→ 修复。同一 worktree 按文件范围隔离并行，指挥官分批 commit。

## 结果

| 指标 | 第一阶段末 | 本阶段末 |
|---|---:|---:|
| 源码行数（不含测试/生成） | 约 91.6k | 89.3k |
| 测试行数（单测 + e2e） | 63.5k | 60.1k |
| CC > 15 的函数（main 基线 95） | 70 | 55 |
| CC > 30 的函数（main 基线 22） | 8 | 3 |
| gateway `tsc` 错误（main 基线 37） | 34 | 27 |

净 −2.3k 行（+8.3k / −10.6k）。剩余 CC > 30 的 3 个是协议分派 switch（`emitOsc`、`encodeMouseEvent`、`classifySshError`），结构扁平，未拆。

### 删除 / 合并

- 测试：`ai-sdk.spike`、`telegram/service.startup`（占位）、`issue45-mouse-coordinate-diagnostic` + 专用 config（诊断非回归）、`split-content-persistence`（仅 fixme）、theme-propagation OSC11 fixme 块、outcome-resolver 笛卡尔 oracle、ws closeAll 竞态重复用例；local/SSH transport 单体里 14 个已由 collaborator 覆盖的用例迁到 `external/*` 测试；ws-client/shared/notifications/ui/theme/stores 中与 collaborator/table-driven 重复及仅断言 import 的用例。
- 共享测试基建：ghostty `test-support/fake-dom.ts`（三个 issue45 文件各删一份 Fake DOM，−790）、e2e `helpers/device.ts`、gateway `agent/test-support/mock-chat-server.ts` / `watch/test-fixtures.ts` / `ws/test-helpers.ts`、stores `test-utils.ts`。
- 死代码：`ssh-probe.ts`、`codec-borsh` 未用的 C2S/S2C 包装、ws-client S2C decode 包装与默认实例 reset、`fetchDevice`、`startService`/`startSystemd` 与其 i18n key、`system/index.ts` 与 terminal-ui components barrel、`ui/alert.tsx`、`smoke-managed-linux.sh`、8 个仅测试使用的便利导出。
- 重复实现收敛：`parseApiError`（12 份副本）、API response 类型改用 `@tmex/shared` 契约、typed `fetchLlmProviders`/`createLlmProvider`/`updateLlmProvider`、`formatDateTime`、`posix-path`、`browser-clipboard`、终端尺寸计算、gateway `json()`/`readJsonObjectBody()`、`bytes.ts`、telegram/weixin `notification-format.ts`、`withDeviceRsync`、`encodePayloadFrames`、`tmux-version` 与 `formatHttpEndpoint` 进 shared。
- 复杂度：API 路由改 `dispatchRoutes` 路由表；`config-field.ts` 声明式字段表统一 watch rule / agent session / llm provider 解析；`ssh-auth-resolvers.ts`；`waitForCommandCompletion`；Borsh kind handler 按域拆表；doctor 拆 `doctor-checks.ts`；`useAgentTabModel`、`DeviceConsole`、`VersionTab`、`ToolCallCard` 拆 hooks/sections/表；`keyEventToTerminalSequence` 改 resolver 表。

### 顺手修复的 bug（均有回归测试）

- gateway：pane_lost 时已 idle 的 stale run 仍会从队列复活（`lostDeviceIds`）；SSRF 判断 IPv4-mapped IPv6 hex 形式与 `fec0::/10` 放行；重连重试耗尽后注册表残留死条目；上传 init 接受小数 size；run_command 截断按字符而非字节判断；默认 agent sync provider 缺 `queuedMessages`；共享 builder 对空 message 多输出一行。
- app：IPv6 bind host 拼 URL 无方括号；静态资源非法 percent-encoding 抛未捕获 `URIError`。
- 前端：`parseApiError` 副本无法解析对象错误信封（`[object Object]`）；Markdown 图片 URL 缺 `rootId` 恒 400；WatchDialog 日期忽略站点语言；tool-card 以 `Record` 查表时 `constructor`/`toString` 命中原型；stores 测试 handler 泄漏、`DEFAULT_SETTINGS.theme` 断言为空。

### 放弃的项

- Telegram/Weixin 子表查询参数化：净 +165 行且需 `as never`，已回退。
- Telegram/Weixin 列表/行/表单壳抽取：Opus 评估后净收益≈0，未做。
- `ws-client/shared-transport.ts`：为嵌入宿主预留，保留。
- SSH/local 重连流程合并、`resolveSshConnectConfig` 之外的高风险连接生命周期改动未做。

## 验证

- 单测：所有包 `bun test` 0 fail（gateway 1472、panels 196、terminal-ui 205、shared 141、stores 101、app 90 …）。
- tsc：fe/panels/shared/ghostty/terminal-ui/ui/ws-client/notifications 0；gateway 27（基线 37）；api-client 5 / stores 1 / app 1 / theme 10 均为既有。
- `bun run build:fe` 成功。
- e2e（105 → 104 用例）：93 pass / 8 fail / 1 skip，8 个失败与 main 基线逐条一致（原 9 个中的诊断 spec 已删除），无回归。
