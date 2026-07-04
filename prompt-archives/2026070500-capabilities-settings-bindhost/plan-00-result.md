# 执行结果：capabilities 端点 / 设置变更广播 + tree-order REST / 可配置 bindHost

分支 `feat/caps-settings-bindhost`（base = main 4994805），三个独立 commit：

1. `feat(api): capabilities endpoint with api/ws protocol versions`
2. `feat(settings): settings change broadcast + tree-order/name REST`
3. `feat(gateway): configurable bind host`（本 commit，含此结果档案）

## 改造一：capabilities 端点

- 新增 `apps/gateway/src/capabilities.ts`：`API_VERSION = 1` 与 `GATEWAY_CAPABILITIES`，REST 端点与 WS HELLO S2C 共用，消除漂移。
- 新增 `apps/gateway/src/api/capabilities.ts`（GET /api/capabilities）并在 `api/index.ts` 挂路由。
- `ws/index.ts` handleHello：serverVersion 由硬编码 '0.1.0' 改为 `getDisplayVersion()`，capabilities 改用共享常量。
- 单测 `api/capabilities.test.ts`（4 用例）。

## 改造二：设置变更广播 + tree-order/name REST

- shared：`KIND_SETTINGS_UPDATE = 0x0802`（kind.ts/index.ts），`SettingsUpdateS2CSchema { namespace: string, serverTimestamp: u64 }`（schema.ts）。
- 新增 `apps/gateway/src/settings/broadcaster.ts`：settings 广播注册桥（`SettingsNamespace` 10 个命名空间）+ `TreeOverlayBridge` 注册桥，`runtime.ts` 启动注册、stop 注销。
- `ws/index.ts`：新公共方法 `broadcastSettingsUpdate(namespace)`（serverTimestamp 严格递增，同毫秒 +1）；`handleRenameWindow/Pane`、`handleReorderWindows/Panes` 提炼为公共 `renameWindow/renamePane/reorderWindows/reorderPanes`（WS switch 与 REST 桥共用，内部触发 'tree-order' 广播）；新增 `getCustomNames(deviceId)`；WS C2S 主题变更追加 'theme' 广播。
- 全部设置写路径接线：devices CRUD/order、site、terminal-shortcuts、theme（REST 保留原两条 theme 专用广播）、llm settings/providers、file-roots、webhooks、telegram（bot CRUD + chat approve/delete）、weixin（account CRUD + user approve/delete）。
- 新增 REST（`api/tree-order.ts`）：GET/PUT `/api/devices/:id/tree-order`、PATCH `/api/devices/:id/windows/:windowId/name`、PATCH `/api/devices/:id/panes/:paneId/name`；路径段 decodeURIComponent（pane id 含 %）；写路径全部经桥复用 wsServer 逻辑，桥未注册（服务未就绪）返回 503。
- 单测：`ws/settings-broadcast.test.ts`（广播帧解码、时间戳递增、tree overlay 联动、getCustomNames）、`api/tree-order.test.ts`（GET/PUT/PATCH 正常/404/400/503 + 「PATCH /api/settings/site → 广播 'site'」联动断言）。
- 既有测试适配：`ws/index.test.ts` 方法改名调用点；`ws/site-theme-update.test.ts` 改为按 kind 过滤取最后一帧 SITE_THEME_UPDATE（theme 更新现伴随 SETTINGS_UPDATE 帧）。

## 改造三：可配置 bindHost

- `config.ts` 新增 `bindHost: getEnv('TMEX_BIND_HOST', '0.0.0.0')`；`index.ts` Bun.serve `hostname: config.bindHost`，启动日志带绑定地址。
- 单测 `config.test.ts`：动态 import query-busting 验证默认值与 env 覆盖（3 用例）。
- 实测：`NODE_ENV=test DATABASE_URL=:memory: GATEWAY_PORT=29663 TMEX_BIND_HOST=127.0.0.1` 起临时实例，lsof 确认监听 `127.0.0.1:29663`，`/api/capabilities` 返回 `{"serverImpl":"tmex-gateway","serverVersion":"0.16.5_dev","apiVersion":1,"wsProtocolVersion":1,...}`。development.env 已有的 `TMEX_BIND_HOST=127.0.0.1` 即刻生效。

## 验证

- `bun test`：apps/gateway 813 pass / 0 fail（77 文件）；packages/shared 88 pass / 0 fail。
- `biome check` 全部改动文件无告警（顺手修复 api/index.ts 一处既有格式问题）。
- `tsc --noEmit` 错误数与 main 基线一致（49 行，均为既有错误，改动文件零新增）。

## 计划偏差

- PUT tree-order 桥未注册时不做直接落库 fallback，统一与 rename 一致返回 503（运行时桥恒注册，503 仅防御性；避免两套写路径）。
