# agent-push-cc 执行结果

## 背景

降低 gateway 里 5 个高 CC 函数（`collectAgentEnvironment` / `parseIpv6ToBytes` / `executeRunCommand` / `maybeEmitEvent` / `handleTmuxEvent`）。公开签名不变；行为用表征测试钉住后再拆 helper。未改 `agent/supervisor.ts`、`agent/run.ts`、`agent/approval-response-reconciler.ts`。

## 改了什么

表驱动 + 纯函数抽取。目标函数只做编排。

| 原函数 | 抽后 CC / 行数 | helper |
| --- | --- | --- |
| `collectAgentEnvironment` | 1 / 19（原 ≈20 / 25） | `environment-fields.ts`：每字段 resolver |
| `parseIpv6ToBytes` | 2 / 6（原 ≈17 / 50） | `ipv6-parse.ts`：剥装饰、嵌入 IPv4、tokenize、assemble |
| `executeRunCommand` | 3 / 50（原 ≈16 / 92） | `run-command-{args,buffer,spawn,text}.ts` |
| `maybeEmitEvent` | 6 / 32（原 ≈17 / 59） | `connection-bridge.ts`：error→event 表、节流、payload |
| `handleTmuxEvent` | 5 / 31（原 ≈16 / 56） | `tmux-push-events.ts`：bell/notification 分发表 |

`executeRunCommand` 仍按字节截断（`OUTPUT_MAX_BYTES = 256KiB`）；prompt 仍在关分页之后、发命令之前从屏上学。IPv6 解析顺序仍是：剥 `[]` / zone → 嵌入点分 IPv4 → `::` 压缩 → 16 字节。

测试 fixture 补了并行任务新增的 `SiteSettings.disabledNotificationChannels: []`（`connection-alerts` / `supervisor` 原测试 + 新 helper 测试）。

## Bug 修复

无行为 bug。纯重构。

## 测试

表征（现实现先绿）：

- `environment.test.ts`：null / ssh 缺字段 / local 全量 / LANG→LC_ALL / 环境变量缺失
- `ip-address.test.ts`：已知地址 round-trip、更多畸形字面量（原 SSRF 用例保留）

抽出模块（先因文件不存在失败，实现后转绿）：

- `environment-fields.test.ts`：timezone / OS / encoding / locale / 字段表完整性
- `ipv6-parse.test.ts`：装饰剥离、嵌入 IPv4、tokenize+assemble 与 `parseIpv6ToBytes` 对齐
- `run-command-args.test.ts`：缺省、posix/cli/auto×shell、prompt 优先/学习/空屏
- `run-command-buffer.test.ts`：字节累积、上限、UTF-8 截断、reset
- `run-command-spawn.test.ts`：payload、nonce 匹配、disable paging、tap
- `connection-bridge.test.ts`：每种 errorType / source / `sessionClosedEmitted`
- `tmux-push-events.test.ts`：bell、notification source 表、空 payload、其它 event kind

## 文件清单

修改：

- `apps/gateway/src/agent/prompts/environment.ts`
- `apps/gateway/src/agent/tools/ip-address.ts`
- `apps/gateway/src/agent/tools/ip-address.test.ts`
- `apps/gateway/src/agent/tools/run-command.ts`
- `apps/gateway/src/push/connection-alerts.ts`
- `apps/gateway/src/push/connection-alerts.test.ts`
- `apps/gateway/src/push/supervisor.ts`
- `apps/gateway/src/push/supervisor.test.ts`

新建：

- `apps/gateway/src/agent/prompts/environment-fields.ts` + `environment-fields.test.ts` + `environment.test.ts`
- `apps/gateway/src/agent/tools/ipv6-parse.ts` + `ipv6-parse.test.ts`
- `apps/gateway/src/agent/tools/run-command-args.ts` + `run-command-args.test.ts`
- `apps/gateway/src/agent/tools/run-command-buffer.ts` + `run-command-buffer.test.ts`
- `apps/gateway/src/agent/tools/run-command-spawn.ts` + `run-command-spawn.test.ts`
- `apps/gateway/src/agent/tools/run-command-text.ts`
- `apps/gateway/src/push/connection-bridge.ts` + `connection-bridge.test.ts`
- `apps/gateway/src/push/tmux-push-events.ts` + `tmux-push-events.test.ts`

未改（按 scope）：`agent/supervisor.ts`、`agent/run.ts`、`agent/approval-response-reconciler.ts`

## 验证

- `bunx biome check --write` 上述 25 个文件：通过。
- 相关测试 192 pass / 0 fail（含 `web.test.ts` SSRF）。
- `cd apps/gateway && bun test`：1826 pass / 0 fail（基线 1615；增量来自本任务 + 并行任务新用例）。
- `bunx tsc --noEmit -p .`：43 个 error。**本任务新增 helper / 重构源文件 0 条。** 基线 27。`supervisor.test.ts` 里 5 条 `listener` 为 `never`（原测试 `as any` runtime，本任务未改该写法）。其余为并行任务文件（`managed-endpoint`、`ssh-*`、`issue45` 等）。

## 未做 / 为何

- **`waitForCommandCompletion`（CC 12 / ~79 行）未拆**：任务只点名 `executeRunCommand` L143–234。
- **`shouldSendTelegram` 仍自带一份节流清扫**：与 bridge 清扫同形，但不在 `maybeEmitEvent` 范围内。
- **`notify` / `toBadgeKey` / `connectEntry` 未动**：超出指定函数。
- **未改 `osc99` 为合法 notification source**：原实现未知 source 一律回退 `osc9`，保持该行为。
