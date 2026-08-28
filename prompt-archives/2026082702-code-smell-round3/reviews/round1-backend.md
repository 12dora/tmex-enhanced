## Findings

### Medium — 手动断开仍可能在初始快照完成后广播“复活”的快照

文件：[external-tmux-core.ts:340](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/external-tmux-core.ts:340)

新的 generation 检查覆盖了此前的连接步骤，但最后一次异步快照没有纳入检查：

```ts
// before
this.connected = true;
...
await this.requestSnapshotInternal();

// after
if (this.abandonStaleConnect(generation)) {
  throw new ConnectAbandonedError();
}
this.connected = true;
...
await this.requestSnapshotInternal();
```

`SnapshotProjector.performSnapshot()` 只在发起三个 tmux 命令前检查 `host.connected`，随后 `await Promise.all(...)`，完成后不再检查便调用 `emitSnapshot()`。因此在这些命令进行中调用 `disconnect()`，命令仍可能成功返回并在 runtime 已终止后写回 `lastSnapshot`、广播快照。新增测试只覆盖了 epoch/control attach 阶段，没有覆盖初始 snapshot 阶段。

具体修复：在 snapshot 命令完成后、解析及 `emitSnapshot()` 前再次检查连接/generation；同时用 `awaitConnectStep(generation, () => this.requestSnapshotInternal())` 包裹最后一步。增加一个在 snapshot 命令阻塞期间断开的回归测试，断言不更新快照、不广播。

### Low — 新增的 pane observer 计数没有接入生产状态变更路径，热路径仍全量扫描客户端

文件：[legacy-feed-broadcaster.ts:386](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/ws/legacy-feed-broadcaster.ts:386)

变更前每次输出直接扫描客户端；变更后计划使用计数，但未跟实际选中、订阅和断开操作连接：

```ts
// before
for (const client of entry.clients) {
  if (clientWantsPaneOutput(client, deviceId, paneId)) {
    legacyObserved = true;
    break;
  }
}

// after
if (this.legacyPaneObserverCount(deviceId, paneId) > 0) return true;
if (this.trackedObserverDevices.has(deviceId)) return false;
return this.scanLegacyPaneObservers(entry, deviceId, paneId);
```

仓库中的生产代码没有调用 `syncLegacyPaneObservers()` 或 `releaseLegacyPaneObservers()`；仅新增测试手动调用它们。因此 `trackedObserverDevices` 在生产环境始终为空，每个 terminal output 仍执行原有 O(client count) 扫描，并额外增加两次 Map/Set 查询，性能优化没有生效。

具体修复：在 select/focus/subscribe 处理器修改 `selectedPanes`、`subscribedPanes` 后调用同步方法，并在 socket/device 断开且删除状态前释放计数。测试应通过真实命令处理器和 `handleClose()` 驱动状态，而不是直接调用 feed 方法。

### Low — “精确整数”解析仍接受空白、十六进制和科学计数法 offset

文件：[file-http.ts:33](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/api/file-http.ts:33)

变更试图修复 `parseInt` 接受尾随垃圾的问题：

```ts
// before
const offset = Number.parseInt(raw ?? '', 10);

// after
const n = Number(raw);
if (!Number.isSafeInteger(n) || n < 0) return null;
```

但 `Number(' ') === 0`、`Number('0x10') === 16`、`Number('1e2') === 100`，仍不是测试所声明的“exact non-negative integer”。其中纯空白在旧实现会返回 400，现在会作为 offset 0 继续处理。

具体修复：转换前先要求十进制数字语法，例如 `if (raw === null || !/^\d+$/.test(raw)) return null`，随后再执行 `Number.isSafeInteger`；补充空白、十六进制、指数形式测试。

**总体结论：需要修改；存在一个会在断开后广播陈旧快照的竞态，另有两处性能/输入解析问题。**