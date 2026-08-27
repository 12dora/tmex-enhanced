## [中] 并发设置刷新可能由旧响应覆盖新状态

文件：[packages/stores/src/site.ts:139](/Users/konata/code/tmex-enhanced-wt-tabs/packages/stores/src/site.ts:139)

新增的 `settings-update` 处理会为每个 `site` 事件并发调用 `refreshSettings()`，而响应返回时无条件写入 store。若先发请求后返回，就会把较新的设置覆盖回旧值；`loading`、主题和语言也会随之回退。

最小证据：

```ts
// Before：没有 settings-update → REST 刷新的分支

// After：每个事件都会启动独立请求
'settings-update': (event, ctx) => {
  ctx.getSite().getState().handleSettingsUpdate(event.namespace);
};

void get().refreshSettings();

// refreshSettings 无条件落盘
const settings = await fetchSiteSettings(core.apiClient);
set({ settings, loading: false });
```

反序完成两个请求可复现：

```json
{"afterNew":"new","final":"old","calls":2}
```

修复：为 `refreshSettings()` 增加请求 generation，仅允许最新 generation 更新 `settings`、`loading`、主题和语言；或使用单一 in-flight 请求加 pending 标记，完成后尾随重拉。补充两个 deferred 请求逆序完成的回归测试，断言最终保留最新设置。

总体结论：需修改——存在 1 个中严重度竞态，会使连续设置更新后的客户端状态回退。