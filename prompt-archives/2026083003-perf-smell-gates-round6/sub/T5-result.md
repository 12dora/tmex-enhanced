# T5 结果 — 共享 control-channel reconnect policy + UTF-8 rolling tail

## 做了什么

对照 S2 finding 1 与 Z2 LOW（legacy history 字节帽切在 UTF-8 序列中间）。

两套 reconnect **顺序相同**（stable-window → 计数 → 达上限放弃 → delay → live 守卫 → has-session → session-gone / 重启 → snapshot → active-pane history）。差异只在 fatal 文案/通知，以及 local 独有的 EAGAIN/EMFILE。按任务要求抽 `reconnectControlChannel(policy, adapter)`，没有用 flag 去拼两套不同顺序的流程。

### 1. `reconnectControlChannel(policy, adapter)`

- 新模块 `apps/gateway/src/tmux-client/reconnect-control-channel.ts`。
- `adapter.host` 是连接实例（必须原对象，restartCount 要写回）；`onGaveUp` / `onAttempt` / `classifyProbe` 是适配器回调。
- Local `classifyProbe`：`TMUX_SPAWN_UNAVAILABLE_EXIT` → `'retry'`（内部仍 `handleSpawnUnavailable`），helper 回退计数并返回 `{ retryDelayMs: policy.restartDelayMs * 4 }`，由 `reconnectControlClient` 自己 `setTimeout` 再入。
- SSH `classifyProbe`：exit 0 → `'alive'`，否则 `'gone'`。从不返回 `'retry'`。
- Session-gone 日志、`updateDeviceRuntimeStatus`、`notifySessionClosed`、`shutdownInternal`、restart 失败日志、snapshot、active-pane history 在 helper 内，用 `host.logPrefix`。

### 2. UTF-8 rolling tail

`decodeRollingTail` 解码前丢掉 retained tail 开头的 continuation byte（`10xxxxxx`）。Local `readTextWithByteLimit` 与 SSH isolated stdout 共用该函数，两边一起修好。

截断欧元符号（3 字节 cap=2）以前解码成两个 U+FFFD，现在是空串。完整落在 cap 内的 `b€` 仍保留。

## 文件

新建：

- `apps/gateway/src/tmux-client/reconnect-control-channel.ts`
- `apps/gateway/src/tmux-client/reconnect-control-channel.test.ts`

修改：

- `apps/gateway/src/tmux-client/local-external-connection.ts`
- `apps/gateway/src/tmux-client/local-external-connection.test.ts`
- `apps/gateway/src/tmux-client/ssh-external-connection.ts`

## 行数 / CC

生产（不含测试）：local **717 → 687**（−30），ssh **768 → 734**（−34），新模块 **+91**。合计 **1485 → 1512（+27）**。

两份 reconnect 副本（64L/57L）变成 helper 函数 47L + 类型面 + 两个薄 wrapper（28L CC2 / 21L CC1）。净正来自 TypeScript host/adapter 类型，不是把逻辑搬来搬去。未把顺序协议改成表驱动。

| 函数 | 前 CC / 行 | 后 CC / 行 |
|---|---|---|
| local `reconnectControlClient` | 16 / 64L | **2 / 28L**（≤ 6） |
| ssh `reconnectControlClient` | 13 / 57L | 1 / 21L |
| `reconnectControlChannel` | — | 14 / 47L（≤ 15） |
| `decodeRollingTail` | 2 / 9L | 5 / 13L |

## 测量

scratchpad：`t5-decode-rolling-tail.bench.ts`。截断欧元 `[0x82,0xAC]`：

| | 文本 | U+FFFD |
|---|---|---:|
| 旧 `TextDecoder` 直接 decode | `��` | 2 |
| 新 `decodeRollingTail` | `""` | 0 |

256 KiB tail × 200 次：naive 14.57 ms，aligned 9.03 ms（skip 2 个 continuation 后 decode；不是热路径，数字只作对照）。Reconnect 不是热路径，以 CC/行数为准。

## 验证

- `cd apps/gateway && bun test src/tmux-client` → **635 pass / 0 fail**（64 files）
- helper 单测 7 pass；UTF-8 / 完整多字节 cap 测在 `local-external-connection.test.ts`
- T5 生产文件 `tsc` **0 错误**
- 整包 `bunx tsc --noEmit -p .` 当前 **28**（基线 21；多出的在 push/auth/mesh/telegram 等并行任务，T5 文件 0）
- `bunx biome check` 上述 5 个文件 → **clean**

RED：helper 模块不存在时 import 失败；截断欧元 cap=2 得到 `��`。

## 未做 / 风险

- `host: this as unknown as ControlReconnectHost`：core 上这些字段是 protected，不能把 `this` 直接赋给公开结构类型。运行时仍是同一实例。
- control stderr 仍按 **字符** `slice(-CONTROL_STDERR_TAIL_LIMIT)`（local `TextDecoder` 流、SSH `data.toString()`），不是 Z2 的字节帽问题，未改。
- helper 的 session-gone 会调真实 `updateDeviceRuntimeStatus`；单测里对该导出做了用例级 spy 并 `mockRestore`，避免污染 SSH 用例。
