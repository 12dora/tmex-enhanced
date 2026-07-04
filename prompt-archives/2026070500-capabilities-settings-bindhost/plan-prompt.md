# 任务 prompt（2026-07-05）

在 tmex 仓库实现三项相互独立的 gateway 改造，分三个独立 commit，全部通过 `bun test`（gateway 与 shared 两包），`biome check` 对改动文件无告警。

## 改造一：capabilities 端点

新增 GET `/api/capabilities`（无鉴权，与其他端点一致），返回 JSON：

```json
{
  "serverImpl": "tmex-gateway",
  "serverVersion": "<getDisplayVersion() 真实版本>",
  "apiVersion": 1,
  "wsProtocolVersion": <wsBorsh.CURRENT_VERSION>,
  "capabilities": ["tmex-ws-borsh-v1", "tmex-agent-v1", "tmex-split-v1"]
}
```

- apiVersion 新建常量；WS HELLO 的 capabilities 数组与此端点共用同一常量来源（消除两处漂移）。
- 顺手修正 HELLO S2C 的 serverVersion 硬编码 '0.1.0' → getDisplayVersion()。
- 带 handler 单测。

## 改造二：设置面完整性 + 变更事件

目标：所有设置有 REST 读写；任何设置变更向全部 WS 客户端推送变更事件（缓存失效信号）。

1. 通用设置变更广播：新增 ws-borsh Kind（KIND_SETTINGS_UPDATE = 0x0802）+ zorsh schema：payload { namespace: string, serverTimestamp }（namespace 取 'site' | 'terminal-shortcuts' | 'theme' | 'llm' | 'file-roots' | 'webhooks' | 'telegram' | 'weixin' | 'devices' | 'tree-order'）。WebSocketServer 新增公共方法 broadcastSettingsUpdate(namespace)，遍历 connectedClients 发送（参考 broadcastSiteThemeUpdateS2C，含递增 serverTimestamp）。用与 theme-broadcaster 一致的注册桥接模式解耦 api 层与 wsServer，在 runtime.ts 注册。
2. 在全部设置写路径调用广播：site PATCH、terminal-shortcuts PATCH、theme POST（保留原 theme 专用广播，另发通用事件）、llm settings PATCH 与 providers CRUD、file-roots CRUD、webhooks CRUD、telegram CRUD、weixin CRUD、devices CRUD。
3. REST 缺口补齐（window/pane 自定义名与排序目前只能经 WS）：
   - GET `/api/devices/:id/tree-order`（读排序 overlay + 自定义名）
   - PUT `/api/devices/:id/tree-order`（写排序）
   - PATCH `/api/devices/:id/windows/:windowId/name`、PATCH `/api/devices/:id/panes/:paneId/name`
   复用 WS handler 已有的落库/内存 overlay 逻辑（提炼共享方法，勿复制粘贴），写路径同样触发 settings 广播（namespace 'tree-order'）。
4. 单测：广播方法（fake ws）、新 REST handler、至少一条「PATCH 设置 → 广播被调用」的联动断言。

## 改造三：仅 localhost 绑定模式

- `config.ts` 新增 `bindHost: getEnv('TMEX_BIND_HOST', '0.0.0.0')`；`index.ts` 的 Bun.serve hostname 改用 config.bindHost。
- development.env 已有 TMEX_BIND_HOST=127.0.0.1，确认从此生效。
- config 层单测（bindHost 默认值与 env 覆盖）。

## 约束

- 不改与任务无关的文件；不升级依赖；生成文件不 lint/format。
- 测试沿用仓库约定：API 测试直接构造 Request 调 handler，WS 测试用 fake ws 直调，DB 用 :memory:。
