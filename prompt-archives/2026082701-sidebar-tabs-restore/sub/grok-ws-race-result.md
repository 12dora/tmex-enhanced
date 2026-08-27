# grok-ws-race-result

日期：2026-08-27  
范围：仅 `apps/gateway/src/ws/**`。未改前端、未执行会改 git 状态的命令。未触碰本机生产 tmex（9883 / `~/Library/Application Support/tmex`）以及名为 `tmex` 的 tmux session。

## 原来有什么问题

`handleDeviceConnect` 在 `await getOrCreate()` 期间不记录该 websocket 对 `deviceId` 的连接意图。同 socket 上的 `disconnect-device` 只对已落入 `connections` 的 entry 做 `clients.delete` + `device-disconnected`；pending 创建完成后仍会：

1. `entry.clients.add(ws)`
2. 发送 `device-connected`

前端因此在用户主动断开后又翻回已连接。

## 机制

每个 `(socket, deviceId)` 维护 connect generation（`WeakMap<ws, Map<deviceId, number>>`）：

- `handleDeviceConnect` 先 bump generation，记下本次 `connectGen`，再 `await getOrCreate()`。
- `handleDeviceDisconnect` bump 同一 key，使进行中的 connect 失效。
- `await` 返回后：generation 仍等于 `connectGen` 才挂客户端并发送 `device-connected`。
- 已失效：不挂客户端、不发 `device-connected`；若 entry 已创建则走现有 `scheduleConnectionEntryRelease`（无 client 时 idle grace 后 `releaseConnectionEntry`，有其他 client / canonical client 则不释放）。
- socket close：`handleClose` 调用 `abandonSocket`，删掉该 socket 的 generation map。pending connect 回来后 generation 对不上，同样走 release 路径，避免把已关闭的 ws 加进 `clients` 造成泄漏。

`getOrCreate` 仍按 device 共享，不断全局取消，以免误伤同一设备上其他 socket。

## 改了哪些文件

- `apps/gateway/src/ws/device-connection-registry.ts` — generation + 失效后不 attach / 走 idle release
- `apps/gateway/src/ws/device-connection-registry.test.ts` — deferred connect → disconnect 回归
- `apps/gateway/src/ws/index.ts` — `handleClose` 调用 `abandonSocket`

## 验证

### TDD

回归测试在修生产代码前失败：`kinds` 为 `[KIND_DEVICE_DISCONNECTED, KIND_DEVICE_CONNECTED]`（260 后跟 258）。修好后只剩 disconnected。

### `cd apps/gateway && bun test src/ws`

```
240 pass
0 fail
832 expect() calls
Ran 240 tests across 26 files.
```

### `bunx tsc --noEmit -p apps/gateway`

基线即 **27** 个 `error TS`（均在既有文件：push/telegram/tmux-client/issue45 测试等）。本次改动的三个文件 **0 条新增**。

### `bunx biome check`（上述三个文件）

通过。
