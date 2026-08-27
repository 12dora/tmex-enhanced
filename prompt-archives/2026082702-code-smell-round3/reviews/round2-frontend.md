### [medium] LLM 设置广播早于模型缓存刷新，其他客户端可能永久缓存空模型列表

**文件：** `packages/panels/src/settings/settings-events-init.tsx:25`（触发点：`:46-47`）

新增全局订阅会在收到 `llm` 广播后立即刷新活跃查询：

```diff
 <WatchEventsInit />
+<SettingsEventsInit />
```

```ts
['llm', [['llm-providers'], ['llm-settings']]],
void queryClient.invalidateQueries({ queryKey });
```

但网关在模型缓存写入前就广播：

```ts
broadcastSettingsUpdate('llm');
const { provider, modelsError } = await refreshModelsCache(created);
```

更新凭证时也同样先广播、后 `await refreshModelsCache(provider)`。其他客户端可能在刷新完成前拉取 provider，得到 `modelsCache: null` 对应的空模型列表；刷新完成后没有第二次广播，因此该客户端会持续显示过期数据。

**修复：** 创建 provider 时将广播移到 `refreshModelsCache` 之后；更新 provider 时在可选刷新流程结束后统一广播一次。补充一个延迟模型拉取的多客户端测试，验证广播发生时列表接口已返回最终模型集合。

总体结论：需要修改，存在 1 项中等严重度的跨客户端缓存一致性回归。