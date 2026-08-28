# settings-update 跨端缓存失效接线

## 背景

网关在任意设置写入后广播 `KIND_SETTINGS_UPDATE`（`apps/gateway/src/settings/broadcaster.ts` 的 `SettingsNamespace`），客户端已在 `packages/ws-client/src/transport-message-decoder.ts` 解码为 `{ type: 'settings-update', namespace }`。此前只有 `packages/stores/src/site.ts` 消费 `'site'`，其余命名空间对应的 react-query 缓存（llm / webhooks / telegram / weixin / devices / file-roots / terminal-shortcuts）跨端不失效。

## 改动

### 新增 `packages/panels/src/settings/settings-events-init.tsx`

- `SETTINGS_NAMESPACE_QUERY_KEYS`：`ReadonlyMap<string, readonly SettingsQueryKey[]>`，纯数据表。用 `Map` 而非对象字面量，天然规避 `__proto__` / `constructor` 之类原型键查表污染。
- `queryKeysForNamespace(ns)`：未登记的命名空间返回共享的空数组常量。
- `subscribeSettingsInvalidation(transport, queryClient)`：只依赖 `Pick<GatewayTransport, 'onEvent'>`，过滤 `settings-update` 后逐键 `invalidateQueries`，返回退订函数。
- `SettingsEventsInit`：`useQueryClient()` + `useRuntime()`，`useEffect` 直接把 `subscribeSettingsInvalidation` 的退订函数作为 cleanup 返回（不需要 `WatchEventsInit` 那种 `WeakSet` 防重，退订即幂等，StrictMode 双跑也安全）。渲染 `null`。

### 映射表（10 个网关命名空间全覆盖）

| namespace | queryKeys |
| --- | --- |
| `site` | `['site-settings']`（fe `use-site-settings-form`；store 侧另有 `handleSettingsUpdate` 刷新） |
| `terminal-shortcuts` | `terminalShortcutsQueryKey` = `['terminal-shortcuts']` |
| `theme` | 无（另有专用 `KIND_SITE_THEME_UPDATE` 帧） |
| `llm` | `['llm-providers']`、`['llm-settings']` |
| `file-roots` | `['files']`（前缀覆盖 `files/roots`、`files/list`、`files/content`、`files/stat`、`SETTINGS_FILE_ROOTS_QUERY_KEY`）、`['terminal-file-links', 'roots']` |
| `webhooks` | `['webhooks']` |
| `telegram` | `['telegram-bots']`、`['telegram-bot-chats']` |
| `weixin` | `['weixin-accounts']` |
| `devices` | `devicesQueryKey` = `['devices']` |
| `tree-order` | 无（网关广播后紧接着重发 tmux 快照，由 tmux store 覆盖） |

已有常量优先复用（`@tmex/api-client` 的 `devicesQueryKey` / `terminalShortcutsQueryKey`），不重复写字面量。

### 出口与挂载

- `packages/panels/src/settings/index.ts`：导出 `SettingsEventsInit`、`SETTINGS_NAMESPACE_QUERY_KEYS`、`queryKeysForNamespace`、`subscribeSettingsInvalidation`、`type SettingsQueryKey`（`@tmex/panels/settings` 子路径已在 package.json exports 中，无需改）。
- `apps/fe/src/main.tsx`：`RootLayout` 中 `<WatchEventsInit />` 旁挂 `<SettingsEventsInit />`，净 +2 行。

## 测试 `settings-events-init.test.tsx`（9 例）

1. **漂移检测**：运行时读取 `apps/gateway/src/settings/broadcaster.ts`，正则解出 `SettingsNamespace` 联合成员，断言与表的键集合完全一致——网关新增命名空间而前端漏配会直接红。
2. 断言 no-op 集合恰为 `{theme, tree-order}`（同样以网关解析结果为输入）。
3. 已知命名空间的键值断言；未知 / `__proto__` / `constructor` → `[]`。
4. `subscribeSettingsInvalidation` 行为：用实现完整 `GatewayTransport` 接口的 `FakeTransport`（无 `any`/`as never`）驱动——按序失效全部映射键、忽略未知命名空间与非 settings 事件、真实 `QueryClient` 缓存条目被标记 `isInvalidated`、退订后不再失效且 handler 集合清空。
5. `SettingsEventsInit` 静态渲染（`createAppRuntime({ transport: fake })` + `RuntimeProvider`）：输出为空、自身不注册任何 query。

注：`react-dom/server` 静态渲染不执行 `useEffect`（`watch-test-harness.tsx` 同样局限），所以订阅路径由第 4 组 `FakeTransport` 测试覆盖，渲染测试只作组件形状的冒烟校验。因此没有复用 watch 的 harness（它另带 i18n 初始化，本组件不需要）。

## 验证

- `packages/panels`：`bun test` → 340 pass / 0 fail；`bunx tsc --noEmit -p .` 无输出。
- `apps/fe`：`bun test src/` → 108 pass / 0 fail；`bunx tsc --noEmit -p .` 无输出。
- `bunx biome check --write` 我的三个 panels 文件干净。`apps/fe/src/main.tsx` 报的
  `lint/correctness/useExhaustiveDependencies`（`StatusBarSync` 的 `theme` 依赖）在 HEAD 版本
  即已存在（同一规则，行号仅因我插入的 2 行位移），非本次引入，未改动。

## 未做 / 风险

- 未触碰 `stores` / `ws-client` / `gateway`。
- 服务端未来新增命名空间时，表若漏配会被测试 1 直接拦下；测试依赖 `apps/gateway/src/settings/broadcaster.ts` 路径，该文件迁移需同步改测试里的相对路径。
- `file-roots` 用 `['files']` 前缀失效会连带刷新文件列表/内容查询，属预期（root 变更后这些结果本就可能失效）。
