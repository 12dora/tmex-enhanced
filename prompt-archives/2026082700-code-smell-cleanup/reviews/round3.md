### 1. `[medium][confident]` 本地连接的快照异常不再上报，变成未处理 Promise rejection

[apps/gateway/src/tmux-client/external-tmux-core.ts:137](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/external-tmux-core.ts:137)

共享实现直接丢弃 `requestSnapshotInternal()` 返回的 Promise：

```ts
void this.requestSnapshotInternal();
```

基线中的 local 实现会捕获异常：瞬时 spawn 错误交给 `handleSpawnUnavailable`，其他错误交给 `callbacks.onError`（`981dd6a` 的 `local-external-connection.ts:319`）。当前实现采用了原 SSH 方法体，丢失了 local 分支。

当 `performSnapshot()` 中的非瞬时 `deps.run`、协调器回调或 metadata reconcile 抛错时，由结构变更、target-missing 恢复等路径触发的 `requestSnapshot()` 会产生未处理 rejection，且连接管理层收不到 `onError`。

验证：连接一个注入式 local runtime，让下一次 `list-windows` 抛普通 `Error`，再调用 `requestSnapshot()`；基线应调用一次 `onError`，当前版本则不会调用并产生未处理 rejection。

### 2. `[low][confident]` 新增必填字段破坏 `BorshClientOptions` 的源码兼容性

[packages/ws-client/src/client.ts:64](/Users/konata/code/tmex-enhanced-wt-smell/packages/ws-client/src/client.ts:64)

`pongTimeoutMs` 被加入公开导出的 `BorshClientOptions`，但声明为必填。构造函数仍接受 `Partial<BorshClientOptions>` 且已有默认值，因此运行时不要求调用方提供它；然而既有代码只要显式声明完整的 `BorshClientOptions`，升级后便无法编译。

验证：

```ts
const options: BorshClientOptions = {
  clientImpl: 'x',
  clientVersion: '1',
  maxFrameBytes: 1,
  reconnectDelayMs: 1,
  maxReconnectAttempts: 1,
  heartbeatIntervalMs: 1,
};
```

TypeScript 当前报错：`Property 'pongTimeoutMs' is missing ... but required in type 'BorshClientOptions'`。基线类型可以通过。