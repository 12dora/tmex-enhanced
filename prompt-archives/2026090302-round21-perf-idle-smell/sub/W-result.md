# TASK W 结果：客户端待机浪费与热路径分配

## 做了什么

### W2 — WebRTC `getStats()` 轮询加可见性门控，RTT 抖动不再刷订阅

- 新文件 `packages/ws-client/src/direct/direct-diagnostics.ts`：本地实现与 `apps/fe/src/node/hub-polling.ts` 同形的 `browserVisibility()`（无 `document` 时按可见、`subscribe` 为 no-op），以及诊断快照相等性（RTT 按 5 ms 量化）。
- `DirectCarrierController.startStatsPolling`：
  - 页面隐藏时取消下一拍定时器，不调 `pc.getStats()`；
  - 重新可见时立刻补一拍并重新武装 2 s 节拍；
  - 可通过 `options.visibility` 注入（单测）。
- `publish()` 不再因浮点 RTT 微抖换快照：`quantizedRtt` 落在同一 5 ms 桶内不通知 `useSyncExternalStore` 订阅者。连接态、候选对类型、选中路径、熔断字段变化仍立即发布。

### W3 — 模块级 `TextDecoder`

`packages/stores/src/agent-event-router.ts` 把 `new TextDecoder()` 提到模块常量 `utf8Decoder`，每个 `AGENT_EVENT` 复用。`decode()` 未开 `stream:true`，与 `packages/shared/src/ws-borsh/codec.ts` 同一写法，语义不变。

### W6 — PONG 延迟未变则不写 tmux store

`tmux-event-router` 的 `latency` handler 按 UI 展示粒度 `Math.round` 后比较 `wsLatencyMs` / `wsLatencyRawMs`，两值都未变则跳过 `setState`。心跳路径本身已经 `Math.round`，生产值不变；亚毫秒抖动被挡住。真变化（例如 18 → 19）仍立即写入。

并行 CAN 任务往 `GatewayTransportEvent` 加了 `'state-feed-mode'`。本文件的 handler 表是穷尽映射，补了一条空实现以保持编译；未改 store 形状（CAN 计划明确不改 UI/store 形状）。

## 失败检测未削弱（已核实）

`getStats` 轮询**只**填充 `route` / `rtt` / ICE 诊断快照并 `publish()`。重连与熔断仍走原事件路径，定时器与 stats 回路独立：

| 机制 | 位置 | 与 stats 轮询的关系 |
|---|---|---|
| ICE `disconnected` 5 s 宽限 | `handleIceConnectionState` + `iceGraceHandle` | 独立 `schedule`；隐藏时仍到期 |
| `connectionState` failed/closed | `watchPeer` | PC 回调，立即 `failAttempt` |
| 通道 close / 协议违规 | `channel.onclose` / carrier `onClose` | 与轮询无关 |
| 连接超时 | `beginAttempt.timeoutHandle` | 激活时撤销，不经 stats |
| 熔断冷却 / 退避重试 | `DirectDialBreaker` + `scheduleRetry` | 只看失败事件 |
| 网络 `online` / `connection.change` | `installNetworkListeners` | 独立去抖重拨 |

单测「页面隐藏不推迟 ICE disconnected 宽限」：隐藏后 `setIceConnectionState('disconnected')`，推进 5 s 仍 `failed`。

## 节省量化

| 项 | 场景 | 改前 | 改后 |
|---|---|---|---|
| W2 `getStats` | 直连 active + 标签隐藏 | **30 次/min**（2 s 无条件，PWA 后台也跑） | **0**（定时器拆掉，可见时 catch-up） |
| W2 诊断重渲染 | 直连 active + RTT 微抖（前台或后台） | **~30 次/min**（浮点 RTT 几乎每拍都变，唤醒 `useSyncExternalStore`） | **0**（同 5 ms 桶不 notify）；路径/ICE/熔断变化仍立即刷 |
| W2 唤醒 | 后台 PWA 直连 idle | 30 timer 唤醒/min + 一次 stats 遍历 | **0** |
| W3 | agent 流式 50–100 delta/s | 50–100 次 `TextDecoder` 构造/s | **0 次构造**（常驻实例） |
| W6 store 写 | 心跳 PONG，延迟显示值未变 | 可见 **12 次/min**（5 s）/ 隐藏 **2 次/min**（30 s），每次唤醒全部 tmux selector | **0**；ms 值真变仍立刻 `set` |

W2 是本轮客户端待机最大单项：后台不再为没人看的诊断跑 `getStats` + React 渲染。前台直连仍每 2 s 采一次 stats（用于候选对/路径变化），只是 RTT 抖动不再派生渲染。

## 测试

新增：

- 隐藏停止 `getStats`、可见立即补一拍并恢复 2 s 节拍
- 仅 RTT 抖动不 notify；`connectionState` 变化立即 notify
- ICE disconnected 宽限在隐藏时仍按 5 s 触发
- `browserVisibility` 无 DOM 降级 / 有 `document` 时跟随 `visibilitychange`
- RTT 5 ms 桶相等、路径/ICE 变化不相等
- latency 显示毫秒未变跳过 `set`，变化则写

## 验收

- `packages/ws-client && bun test`：**325 pass / 1 fail**（326 tests）。基线 319 pass。本任务新增 7 条（controller 3 + diagnostics 4）均通过。唯一失败在 **`protocol-dispatcher.test.ts`（非本任务文件，CAN 并行改 HELLO）**：`maxFrameBytes` 断言未跟上，复跑仍失败，未改。
- `packages/ws-client && bun test src/direct/`：**136 pass / 0 fail**。
- `packages/stores && bun test`：**431 pass / 0 fail**（基线 420；多出的来自并行任务 + 本任务 1 条 latency 测试）。
- `bunx tsc --noEmit -p .`
  - ws-client：2 个错误，全在 **`canonical-state-client.ts`（非本任务）**，基线 0。本任务文件 0 错误。
  - stores：**1** 个错误（基线 1），在 `host-services.test.ts`（非本任务）。本任务文件 0 错误。
- `bunx biome check` 本任务改动文件：通过。
