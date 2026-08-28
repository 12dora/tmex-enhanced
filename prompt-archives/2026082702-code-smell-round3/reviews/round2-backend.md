### Medium — 输出门溢出的恢复信号会被实际客户端忽略

文件：[apps/gateway/src/ws/borsh/session-state.ts:443](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/ws/borsh/session-state.ts:443)

旧代码溢出时只丢最旧帧，仍保留其余缓冲：

```ts
ctx.buffer.shift();
ctx.buffer.push(data);
```

新代码清空全部缓冲，并发送 canonical `SourceGap`：

```ts
ctx.buffer = [];
ctx.overflowed = true;
this.emitResourceExhaustedGap(ws);
```

但输出门只用于 legacy 客户端（`legacy-feed-broadcaster.ts` 会跳过 `canonicalClients`），而 legacy 的 `transport-message-decoder.ts` 没有注册 `KIND_CANONICAL_EVENT`，未知 kind 会直接忽略。因此溢出后客户端不会 rebase，随后收到 `LIVE_RESUME`，终端会永久缺失整段输出。新增测试只验证服务端成功编码了 `SourceGap`，没有验证真实客户端能够处理它。

具体修复：让 legacy transport 解码该 gap 并触发 pane rebase，或在溢出时断开连接以强制完整重建。回归测试应贯通 `WebSocketGatewayTransport`，断言溢出确实触发 rebase，而不是只解码原始服务端帧。

### Medium — 最终重连失败后，保留的 pane 订阅无法在手动重连时恢复 observer

文件：[apps/gateway/src/ws/device-connection-registry.ts:373](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/ws/device-connection-registry.ts:373)

旧代码只清除选中 pane，保留 `subscribedPanes`：

```ts
delete client.data.borshState.selectedPanes[deviceId];
```

新代码在此之前释放 observer，但仍保留订阅：

```ts
this.host.releaseLegacyPaneObservers?.(client, deviceId);
delete client.data.borshState.selectedPanes[deviceId];
```

之后 `handleDeviceConnect()` 只执行：

```ts
ws.data.borshState.selectedPanes[deviceId] ??= null;
```

没有重新调用 observer sync。与此同时，设备一旦进入 tracked 集合，observer 计数为零时不会再回退扫描客户端。结果是客户端手动重连后，`subscribedPanes` 仍声明需要输出，但 `broadcastTerminalOutput()` 会在进入 batcher 前直接丢弃这些 pane 的输出。

具体修复：在 `handleDeviceConnect()` 将客户端加入 entry 后重新调用 `syncLegacyPaneObservers(ws, deviceId)`；补充“subscribe → finalizeReconnectFailure → connect → 输出仍投递”的回归测试。

### Low — TTL 清理会在调大通知节流时间时提前放行

文件：[apps/gateway/src/ws/borsh/session-state.ts:520](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/ws/borsh/session-state.ts:520)

旧代码始终用本次传入的节流值检查已有时间戳：

```ts
const throttleMs = throttleSeconds * 1000;
if (now - ctx.lastBellAt < throttleMs) return false;
```

新代码先按 entry 中保存的旧节流值删除记录：

```ts
this.pruneNotificationThrottles(state, now);
// ...
if (now - ctx.lastBellAt >= ctx.throttleSeconds * 1000) {
  state.notificationThrottles.delete(key);
}
```

例如某通知按 10 秒放行后，设置改为 60 秒；31 秒后 prune 会按旧的 10 秒删除记录，随后将其视为首次通知并放行。旧实现会继续抑制至 60 秒。

具体修复：检查当前 key 前不要 prune 它，或先把该 entry 的 `throttleSeconds` 更新为本次值再清理。增加“10 秒改为 60 秒，31 秒时仍拒绝”的测试。

总体结论：需要修改；存在两处会造成终端输出缺失的恢复/observer 回归，以及一处通知节流语义回归。