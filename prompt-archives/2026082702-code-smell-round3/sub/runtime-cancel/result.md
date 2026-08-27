# runtime-cancel

## 背景

`DeviceSessionRuntime.disconnect()` 只置位并调用底层 `connection.disconnect()`，不会作废正在进行的 `connect()`。local/SSH 连接在若干 `await` 之后无条件：

- 调用 `onSourceReady`
- 置 `connected = true`
- 写 `updateDeviceRuntimeStatus`（tmuxAvailable=true）
- 请求 snapshot

因此 disconnect 发生在 blocked connect 期间时，await 结束后设备会“复活”。

## 修复

引入 **connection generation**：

1. `ExternalTmuxConnectionCore`：`beginConnectGeneration` / `invalidateConnectGeneration` / `awaitConnectStep` / `abandonStaleConnect` / `finalizeConnect`。
2. 每个 `await` 之后以及发布 source-ready / connected / status / snapshot 之前检查 generation。
3. stale 时释放已获取资源（`stopControlClient` + `disposeTransport`），吞掉内部 `ConnectAbandonedError`，**不发布状态**。
4. local/SSH `disconnect()` 先 bump generation；`attachControlTransport` 在 `manualDisconnect` 时拒绝再开 control 通道。
5. `DeviceSessionRuntime` 同样用 generation：手动 disconnect 后，in-flight `connect()` 的成功或失败都视为取消，不再二次 terminate / 不再把取消当连接失败抛出。意外 `onClose` 仍按原错误路径处理。

未改 `connect()` 公共签名（没有 AbortSignal 参数）。

## 改动文件

- `apps/gateway/src/tmux-client/external-tmux-core.ts`
- `apps/gateway/src/tmux-client/local-external-connection.ts`
- `apps/gateway/src/tmux-client/ssh-external-connection.ts`
- `apps/gateway/src/tmux-client/device-session-runtime.ts`
- 对应 `*.test.ts` / `external-tmux-core.host.test.ts`

## 回归测试（先红后绿）

修复前：

- local：epoch/parking 阻塞期间 disconnect，放行后 `connected === true`（复活）。
- SSH：epoch 阻塞期间 disconnect，pending command 被 teardown 拒绝，`connect()` 抛 `SSH command channel closed`。

修复后：

- local：blocked epoch → disconnect → 放行：`connected=false`，无 source-ready，无 snapshot，未 spawn control。
- local：blocked parking（source-ready 已发出）→ disconnect → 放行：不再置 connected、不再 snapshot、不再 spawn。
- SSH：blocked epoch → disconnect → 放行：`connect()` resolve 且不发布；SSH client / command channel 已 end；无 control channel。
- runtime：in-flight connect 期间 disconnect 后保持 terminated，无 snapshot；并发 connect 去重（L160–179）仍通过。

## 验证

- 相关：`bun test src/tmux-client/device-session-runtime.test.ts src/tmux-client/local-external-connection.test.ts src/tmux-client/local-external-connection.eagain.test.ts src/tmux-client/ssh-external-connection.test.ts src/tmux-client/external-tmux-core.host.test.ts src/tmux-client/external-tmux-core.test.ts` → **93 pass / 0 fail**
- 整包：`cd apps/gateway && bun test` → **1537 pass / 0 fail**（baseline 1473；本任务新增 6 条，其余增量来自并行 agent）
- `bunx tsc --noEmit -p .` → **27 errors**，与 baseline 一致，无新增
- `bunx biome check --write <scope files>` → clean

## 未做 / 范围外

- 未改 `apps/gateway/src/tmux-client/external/*`（`startControlClient` 内部 await 不能逐个插 generation check）。依赖 `awaitConnectStep(startControlClient)` 返回后检查，以及 `attachControlTransport` 在 `manualDisconnect` 时拒绝 attach。
- 未给 `DeviceSessionRuntimeConnection.connect()` 加 AbortSignal。
- 成功 connect 之后、snapshot 进行中再 disconnect，属于已连接后的正常断开，不在本 bug 范围内。
