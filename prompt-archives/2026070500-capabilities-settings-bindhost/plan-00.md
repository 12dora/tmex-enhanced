# 实现计划：capabilities 端点 / 设置变更广播 + tree-order REST / 可配置 bindHost

## 背景

三项 gateway 改造，互相独立，分三个 commit。worktree：`.worktrees/caps-settings-bind`，分支 `feat/caps-settings-bindhost`，base = main (4994805)。

关键现状（已核对）：

- `apps/gateway/src/index.ts:15` Bun.serve hostname 硬编码 `'0.0.0.0'`；config 集中在 `apps/gateway/src/config.ts`。
- 路由表：`apps/gateway/src/api/index.ts` handleApiRequest 手写 if/正则。
- WS HELLO：`apps/gateway/src/ws/index.ts` handleHello（542），serverVersion 硬编码 `'0.1.0'`（567），capabilities 数组内联（571）。
- 唯一现有设置广播：`broadcastSiteThemeUpdateS2C`（ws/index.ts:1023，lastThemeTimestamp 单调递增，遍历 connectedClients）；api 层经 `tmux/theme-broadcaster.ts` 注册桥解耦，runtime.ts:61-68 注册。
- tree-order 落库：`db/index.ts` getDeviceTreeOrder/setWindowOrder/setPaneOrder；window/pane 自定义名是 wsServer 内存 overlay（windowCustomNames/paneCustomNames，handleRenameWindow:938 / handleRenamePane:893），改后用 lastSnapshot 重广播。
- ws-borsh：kind.ts（0x0801 = SITE_THEME_UPDATE 为 0x08xx 段唯一成员）、schema.ts（zorsh b.struct）、codec.ts CURRENT_VERSION = 1；gateway 经 `import { wsBorsh } from '@tmex/shared'` 使用，schema 经 `export * as schema` 自动透出，Kind 常量需在 ws-borsh/index.ts 手动补 re-export。
- 测试约定：API 测试直接构造 Request 调 handler（theme.test.ts 范例）；WS 测试 fake ws + as any 直调（ws/index.test.ts 范例）；DB :memory: + test-preload 自动 loadEnv；gateway 包内 beforeAll runMigrations()。

## 步骤一（commit 1）：capabilities 端点

1. 新增 `apps/gateway/src/capabilities.ts`：
   - `export const API_VERSION = 1;`
   - `export const GATEWAY_CAPABILITIES = ['tmex-ws-borsh-v1', 'tmex-agent-v1', 'tmex-split-v1'] as const;`
2. 新增 `apps/gateway/src/api/capabilities.ts`：handleCapabilitiesApiRequest → GET `/api/capabilities` 返回 { serverImpl, serverVersion: getDisplayVersion(), apiVersion: API_VERSION, wsProtocolVersion: wsBorsh.CURRENT_VERSION, capabilities: [...GATEWAY_CAPABILITIES] }。
3. `api/index.ts` 挂路由。
4. `ws/index.ts` handleHello：serverVersion → getDisplayVersion()，capabilities → [...GATEWAY_CAPABILITIES]。
5. 单测 `api/capabilities.test.ts`：200、字段形状、capabilities 与常量一致、非 GET 不匹配。

## 步骤二（commit 2）：设置变更广播 + tree-order/name REST

shared 包：

1. `ws-borsh/kind.ts`：`KIND_SETTINGS_UPDATE = 0x0802`，补 VALID_KINDS、kindToString；`ws-borsh/index.ts` 补 re-export。
2. `ws-borsh/schema.ts`：`SettingsUpdateS2CSchema = b.struct({ namespace: b.string(), serverTimestamp: b.u64() })`。

gateway 包：

3. 新增 `apps/gateway/src/settings/broadcaster.ts`（仿 theme-broadcaster 注册桥）：
   - `SettingsNamespace` 联合类型（10 个 namespace）。
   - `registerSettingsBroadcaster(fn|null)` / `broadcastSettingsUpdate(ns)`。
   - tree overlay 桥：`TreeOverlayBridge { renameWindow; renamePane; reorderWindows; reorderPanes; getCustomNames }`，`registerTreeOverlayBridge(bridge|null)` / `getTreeOverlayBridge()`。
4. `ws/index.ts`：
   - 新公共方法 `broadcastSettingsUpdate(namespace)`：lastSettingsTimestamp 单调递增（同毫秒 +1），encode SettingsUpdateS2CSchema，遍历 connectedClients。
   - 把私有 handleRenameWindow/handleRenamePane/handleReorderWindows/handleReorderPanes 提炼为公共 renameWindow/renamePane/reorderWindows/reorderPanes（switch case 与 REST 桥共用），内部末尾追加 `broadcastSettingsUpdate('tree-order')`。
   - 新公共方法 `getCustomNames(deviceId)` 返回 { windows, panes } 普通对象。
   - handleSiteThemeUpdate（WS C2S）追加 `broadcastSettingsUpdate('theme')`。
5. `runtime.ts`：注册 settings broadcaster 与 tree overlay 桥；stop() 注销。
6. 写路径接线（成功路径才广播）：
   - `api/index.ts`：devices POST/PATCH/DELETE/order PUT → 'devices'；site PATCH → 'site'；terminal-shortcuts PATCH → 'terminal-shortcuts'；telegram bots POST/PATCH/DELETE、chat approve/delete → 'telegram'；weixin accounts POST/PATCH/DELETE、user approve/delete → 'weixin'；webhooks POST/DELETE → 'webhooks'。
   - `api/theme.ts` POST → 'theme'（原两条 theme 广播保留）。
   - `api/llm.ts` providers POST/PATCH/DELETE + settings PATCH → 'llm'。
   - `api/files.ts` roots POST/PATCH/DELETE → 'file-roots'。
7. 新增 `apps/gateway/src/api/tree-order.ts` + api/index.ts 挂路由（多段路径不会被 `/api/devices/[^/]+$` 通配吃掉，紧随 devices 路由之后）：
   - GET `/api/devices/:id/tree-order`：device 404 校验；返回 { deviceId, windows, panes, windowNames, paneNames }（DB + 桥 getCustomNames，桥缺失时名字为空对象）。
   - PUT `/api/devices/:id/tree-order`：body { windows?: string[], panes?: Record<string,string[]> }，校验形状；优先经桥 reorderWindows/reorderPanes（复用 WS 路径含快照重广播 + 'tree-order' 事件），桥缺失时直接 setWindowOrder/setPaneOrder 落库 + broadcastSettingsUpdate('tree-order')。
   - PATCH `/api/devices/:id/windows/:windowId/name`、`/api/devices/:id/panes/:paneId/name`：body { name: string }（空串=清除），id 段 decodeURIComponent（pane id 含 %）；经桥 renameWindow/renamePane，桥缺失返回 503。
8. 单测：
   - `ws/index.test.ts` 追加：broadcastSettingsUpdate 帧可解码（kind/namespace/serverTimestamp），连续两次 timestamp 严格递增；renameWindow/reorderWindows 触发 'tree-order' 广播。
   - 新增 `api/tree-order.test.ts`：GET/PUT/PATCH 正常与 404/400，fake 桥断言复用调用。
   - 新增联动断言（放 tree-order.test.ts 或独立 describe）：registerSettingsBroadcaster(spy) 后 PATCH /api/settings/site → spy 收到 'site'。

## 步骤三（commit 3）：可配置 bindHost

1. `config.ts`：`bindHost: getEnv('TMEX_BIND_HOST', '0.0.0.0')`。
2. `index.ts`：`hostname: config.bindHost`。
3. 单测 `config.test.ts`：默认值（无 env）与 env 覆盖。config 为模块级常量，用子进程（Bun.spawnSync bun -e）或动态 import + query busting 验证；实现时择可行者。
4. development.env 的 TMEX_BIND_HOST=127.0.0.1 即刻生效（loadEnv 在 bootstrap-env 已加载）。

## 验收

- 三个中性 commit；`bun test`（apps/gateway、packages/shared）全绿；biome check 改动文件无告警。
- 不动生成文件、不升级依赖、不碰 tmux/生产服务。

## 风险

- api/index.ts 路由通配顺序：新多段路由用精确正则，不与 `/api/devices/[^/]+$` 冲突（后者带 $）。
- u64 serverTimestamp 为 BigInt，测试断言注意 BigInt 比较。
- config.test.ts 若 query-busting 不生效则改用 Bun.spawnSync 子进程方案。
