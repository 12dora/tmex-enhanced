# GL 结果：R9 / R10 / R13 / R7

## 结论

- **R9**：连续 N 次（默认 10，`TMEX_RTC_DIAL_DISABLE_AFTER`）DC 全失败后进入 `disabled`；只由环境变化 / 手动重试离开。主链路 `ws-secure` / relay 判定未改。已有手动入口 `PeerManager.forceDcProbe` 会 re-arm。
- **R10**：`RtcPeerManager` 构造不再 `dlopen`。`ready()` / `connectToPeer` / accept 才 load。`canLoadNative() === false`（disabled）时永不 load。`available` 在尚未证明 native 缺失时乐观为 true，这样即使拿掉 start 时的 `await rtc.ready()`，`dcCapable` 仍能发起第一次拨号。
- **R13**：`[tmux-metrics]` 改为 `TMEX_LOG_LEVEL=debug` 门控（`logAt('debug')`），不再看 `isManagedExternally()`。`managed.ts` 未改（该函数仍给自更新用）。
- **R7**：pane replay 头删改为 head 游标 + `copyWithin` 紧缩（阈值 `REPLAY_COMPACT_HEAD=32`）。顺序与字节与 `shift()` 一致。

## 改动文件

**新建**
- `apps/gateway/src/mesh/peer-dc-upgrade.test.ts`
- `apps/gateway/src/tmux-client/tmux-metrics-line.ts`
- `apps/gateway/src/tmux-client/local-external-connection.metrics.test.ts`

**修改**
- `apps/gateway/src/mesh/rtc/rtc-dial-breaker.ts` / `.test.ts` / `index.ts`
- `apps/gateway/src/mesh/rtc/rtc-peer-manager.ts` / `.test.ts`
- `apps/gateway/src/mesh/peer-dc-upgrade.ts`
- `apps/gateway/src/tmux-client/local-external-connection.ts`
- `apps/gateway/src/tmux-client/retention/policy-scheduler.ts` / `.test.ts` / `types.ts`

**未改**
- `apps/gateway/src/system/managed.ts`：门控已迁走，`isManagedExternally` 仍用于 `canSelfUpdate`。

## 待接线（skip 文件，一行调用）

`dcUpgrade` 在 `PeerManager` 上是 `protected`。以下是精确插入点。

### R9 唤醒源

1. **本机网卡指纹** — `peer-manager.ts` `syncLocalFingerprint` ~985，`resetAll()` 后：
   `this.dcUpgrade.onLocalFingerprintChanged();`
2. **peer 端点变化** — `syncPeerEndpointSet` ~996，`resetNode(nodeId)` 后：
   `this.dcUpgrade.onPeerEndpointChanged(nodeId);`
3. **peer 重连** — `installLive` ~1241，`this.live.set(...)` 后：
   `this.dcUpgrade.onPeerReconnected(peerNodeId);`
   （未 disabled 时 no-op；含首次建链。）
4. **hub 切换 / failover** — 需先在 `PeerManager` 加公开方法（`forceDcProbe` 旁）：
   `onHubSwitched(): void { this.dcUpgrade.onHubSwitched(); }`
   然后 `mesh-runtime.ts` ~1163 `d.peerHolder.manager = peerManager;` 后：
   `uplink.onAttached(() => peerManager.onHubSwitched());`
5. **手动重试**：已有 `PeerManager.forceDcProbe` → `dcBreaker.forceProbe` 会退出 disabled。无需再接线。协调器也暴露 `retryDcUpgrade(nodeId)`。

冷却中但未 disabled 的行为不变（端点变化仍不重置熔断）。只清 disabled。

### R10 剩余急切 load

`mesh-runtime.ts:1491` `await rtc.ready();` 仍会在 start 时 load native（usrsctp 线程仍会起来）。要让空闲进程真正不 `dlopen`，删掉这一行。`available` 已改为「未证明缺失则 true」，不必再改 `peer-manager.ts:741 dcCapable`。

## 测试 / tsc / biome

```
cd apps/gateway && bun test src/mesh/rtc src/mesh/peer-dc-upgrade \
  src/tmux-client/retention src/system \
  src/tmux-client/local-external-connection.metrics.test.ts
→ 361 pass / 0 fail / 31 files
```

验收命令里的 `src/retention` 不存在，retention 在 `src/tmux-client/retention`。

`src/tmux-client/local-external-connection.test.ts` / `.eagain` / `.integration` 当前 **无法加载**：并行 agent 从 `pane-stream/parser-state.ts` 拿走了 `utf8Decoder`，`osc-handlers.ts` 仍在 import。不是本任务改动。R13 单测走 `local-external-connection.metrics.test.ts`（不经过 pane-stream）。

tsc：本任务文件 **0 error**。包级基线对话开始时是 2（`data-channel-carrier.test.ts` `fragmentFrame`）；现在包级约 12，全部在 `pane-stream/*`（并行 R5/R6），非本任务。

biome：已 `bunx biome check` 本任务文件，通过。

## 行为要点

- `disabled` 挂在 `RtcDialBreaker` 上，不改 shared `DialBreaker`。snapshot/decision 多一个 `disabled: boolean`。
- `forceProbe` / `noteHealthy` / `noteChannelEstablished` / `reset` 会清 disabled。
- 进入 disabled 后 `armDcUpgradeRetry` / `scheduleDcBreakerProbe` 直接 return，不再 0ms 空转。
- R7 在 `trimPaneReplay` / `evictOldestReplayChunks` 内用游标，离开方法前 `copyWithin` 紧缩，`replay-store.ts` 仍看到 `replay[0]` 为活头，无需改它。
