# Round 29 计划：终端分享、PWA 节点加载慢、链路信息窗 i18n、遗留清理

分支 `feat/round29-terminal-share`，worktree `/Users/konata/code/tmex-r29`，基线 main `227481eb`（1.1.33）。
架构事实见 `sub/EX1-architecture-report.md`（EX1 探索报告），下文所有文件位置以其为准。

## 一、背景与已拍板的产品决策（2026-09-05 与用户逐项确认）

1. **链接地址**：不探测延迟，按预设优先级自动选：自建域名（site_url / hub publicUrl）> 中继域名 > Cloudflare 隧道域名 > 公网 IP；内网 IP、localhost、`.local` 排除。设置里可固定「默认分享地址」或填自定义域名；弹窗可临时改选。
2. **分享范围**：整个 tab（tmux window，含分屏，动态包含之后新开的 pane）。
3. **被分享人权限**：键盘输入、鼠标上报、滚动回看；**参与尺寸仲裁**（与普通客户端一致）；不同步剪贴板；不能改分屏结构；看不到任何节点名/设备名/其他 tab。
4. **登录态**：输对密码后保持到到期或终止；允许多人同时在线。
5. **日志**：录屏式（输出 + 输入，带时间戳），时间轴回放；默认开启，保留 30 天，单条上限 50 MB。
6. **期限**：1h / 24h / 7d / 永久 + 自定义，默认 24h。
7. **对方视角**：显示可自定义的分享名称（默认 tab 名），右上角剩余期限 + 断开按钮；分享方工具栏图标高亮并显示在线人数。
8. **安全**：密码最短 6 位，默认 8 位随机；密码存哈希；按分享 + 来源 IP 限速（15 min 内 10 次失败锁 15 min）；分享凭证独立 cookie，不能访问任何常规 `/api/*`；服务端按 window 过滤元数据与广播。

## 二、接口契约（各 agent 以此为准，禁止私改）

### 2.1 共享类型 `packages/shared/src/share/`（T1 建，导出为 `@tmex/shared/share`）

```ts
export type ShareState = 'active' | 'ended';
export type ShareEndReason = 'revoked' | 'expired' | 'window_closed' | 'device_removed';
export interface ShareScope { shareId: string; deviceId: string; windowId: string }
export interface ShareRecord {
  id: string;                 // 22 位 base64url 随机
  name: string;
  deviceId: string;
  windowId: string;
  windowName: string;         // 创建时快照，历史里展示用
  state: ShareState;
  endReason: ShareEndReason | null;
  createdAt: number;          // epoch ms
  expiresAt: number | null;   // null = 永久
  endedAt: number | null;
  origin: string;             // 创建时选定的分享地址（origin，不含路径）
  url: string;                // 完整链接
  viewers: number;            // 当前在线连接数（仅 active 有意义）
  logBytes: number;           // 已记录日志字节数
  logTruncated: boolean;      // 超过上限停止记录
  recordLog: boolean;         // 该分享是否记录日志（创建时按设置快照）
}
export interface ShareSettings {
  recordLogs: boolean;          // 默认 true
  logRetentionDays: number;     // 默认 30，0 = 与分享记录同寿命（不自动清理）
  logMaxBytes: number;          // 默认 50 * 1024 * 1024
  defaultOrigin: string | null; // null = 按预设优先级自动
}
export type ShareOriginKind = 'custom' | 'site' | 'hub' | 'relay' | 'tunnel' | 'ip';
export interface ShareOriginCandidate { url: string; kind: ShareOriginKind; label: string }
export interface ShareLogEntry { seq: number; at: number; kind: 'out' | 'in' | 'resize' | 'checkpoint'; paneId: string; data: string /* base64 */; cols?: number; rows?: number }
export const SHARE_PASSWORD_MIN_LENGTH = 6;
export const SHARE_DURATION_PRESETS_MS = { hour: 3_600_000, day: 86_400_000, week: 604_800_000 } as const;
export function generateSharePassword(length = 8): string  // 去除易混淆字符 0O1lI 的大小写字母 + 数字
export function rankShareOrigins(candidates: ShareOriginCandidate[]): ShareOriginCandidate[]  // 按 kind 优先级排序，过滤内网
export function isPublicShareOrigin(url: string): boolean
export function sharePath(shareId: string): string  // `/s/${shareId}`
export function buildShareUrl(origin: string, nodePrefix: string | null, shareId: string): string // origin + (nodePrefix ?? '') + /s/id
```

### 2.2 分享方 HTTP（需常规会话；挂在终端所在节点，经 Hub 时走 `/n/<nodeId>/api/...`）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/share` | `?deviceId=&windowId=`（可选过滤） | `{ active: ShareRecord[], history: ShareRecord[] }` |
| POST | `/api/share` | `{ deviceId, windowId, name, password, expiresInMs: number \| null, origin }` | `{ share: ShareRecord, password }` |
| POST | `/api/share/:id/revoke` | — | `{ share: ShareRecord }` |
| DELETE | `/api/share/:id` | 仅 ended；连日志一起删 | `{ ok: true }` |
| GET | `/api/share/:id/log` | `?after=<seq>&limit=<n>`（默认 limit 2000 条或累计 2 MiB） | `{ entries: ShareLogEntry[], nextAfter: number \| null, total: number, truncated: boolean }` |
| GET | `/api/share/settings` | — | `ShareSettings` |
| PUT | `/api/share/settings` | `Partial<ShareSettings>` | `ShareSettings` |
| GET | `/api/share/origins` | — | `{ candidates: ShareOriginCandidate[], recommended: string \| null, nodePrefix: string \| null }` |

错误码沿用 `apps/gateway/src/api/http.ts` 的 `json({ error, code }, status)` 约定：`SHARE_NOT_FOUND` 404、`SHARE_WINDOW_NOT_FOUND` 404、`SHARE_PASSWORD_TOO_SHORT` 400、`SHARE_ENDED` 409。

### 2.3 被分享人 HTTP（公开路径，无需常规会话；T3 加入 `auth-public-paths`）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/share-access/:id` | — | `{ id, name, state, expiresAt, authenticated: boolean, deviceId?, windowId? }`（后两项仅 authenticated 时返回） |
| POST | `/api/share-access/:id/login` | `{ password }` | 200 `{ ok: true, expiresAt }`；401 `SHARE_PASSWORD_INVALID`；429 `SHARE_LOGIN_LOCKED { retryAfterMs }`；410 `SHARE_ENDED` |
| POST | `/api/share-access/:id/logout` | — | `{ ok: true }` |

**凭证传递**：节点端 login 成功时**不直接写 Set-Cookie**，而是响应头 `x-tmex-set-share: <token>` + `x-tmex-set-share-max-age: <秒>`（永久分享给 7 天并滑动续期）；本机路径由 `session-middleware` 同款逻辑转成 `Set-Cookie: tmex_sh_<via>=<token>; Path=/; HttpOnly; SameSite=Lax[; Secure]`（via = `self` 或 节点 id），Hub 路径由 forwarder 的 `applyAuthPolicy` 同样转换。logout 用 `x-tmex-clear-share: 1`。
token 格式：`<shareId>.<32 字节 base64url 随机>`；服务端只存 token 的 SHA-256。

### 2.4 WebSocket

- 浏览器连 `/ws`（或 `/n/<N>/ws`）时若无常规会话但携带 `tmex_sh_<via>` cookie：`guardGatewayWebSocket`（本机）/ `handleRemoteWs`（Hub）→ 节点侧 `shareService.verifyAccessToken(token)` 得 `{ scope, accessId, expiresAt }` → 以 `MESH_SHARE_WS_KIND` 升级，`data = { kind, scope, accessId, via, cid? }`。
- 经 Hub 的流：OPEN payload 的 `auth` 字段取值 `share:<token>`，节点端 `verifyAuth` 识别前缀。
- 节点侧 `WebSocketServer.open(ws, { shareScope })`：`GatewaySession.shareScope?: ShareScope`；`WebSocketServer.closeShareSessions(shareId, code = 4410, reason = 'SHARE_ENDED')`；`WebSocketServer.countShareSessions(shareId)`。
- 常规会话的 `SessionRegistry` 不登记分享连接；分享连接在 `WebSocketServer` 内按 shareId 索引。
- 关闭码：4410 `SHARE_ENDED`（终止/到期/窗口关闭），4401 `SHARE_LOGIN_REQUIRED`（cookie 无效）。

### 2.5 分享连接的协议白名单（T2）

允许：HELLO/PING/PONG/ERROR/CHUNK；`DEVICE_CONNECT`/`DEVICE_DISCONNECT` 仅 scope.deviceId；`CANONICAL_COMMAND` 全部变体但 target 必须是 scope window 内的 pane；`TERM_INPUT`/`TERM_PASTE` 仅 scope 内 pane；`TERM_VIEWPORT`/`RESIZE_PANE` 仅 scope window；其余全部拒绝（回 `KIND_ERROR` code `SHARE_FORBIDDEN`，不断开）。
出站过滤：`DEVICE_CONNECTED` 快照与 `SourceMetadataSnapshot/Patch` 只含 scope window 及其 pane；`DEVICE_EVENT`/`TMUX_EVENT`/`CLIPBOARD_WRITE` 只放行 scope 内 pane 的事件；`SITE_THEME_UPDATE`/`SETTINGS_UPDATE`/`NOTIFY_EVENT`/`NODE_EVENT`/`WATCH_EVENT`/`AGENT_EVENT` 一律不发给分享连接；不注册 agent hub。
pane 归属由设备当前快照动态判定（pane 被移出 window 即失效，subscription 被撤销）。

### 2.6 日志存储（T1）

表 `share_logs(share_id, seq, at, kind, pane_id, cols, rows, data BLOB)`，主键 (share_id, seq)。分享创建即开始记录（若 recordLogs）：先对 window 内每个 pane 写 `checkpoint`（`captureCanonicalScreen`），之后经 `attachPaneConsumer` 记 `out`，输入经 ws 层钩子记 `in`（T2 在 `handleTerminalInput`/TERM_INPUT 处调用 `shareService.recordInput(scope, paneId, bytes)`），尺寸变化记 `resize`。累计超过 `logMaxBytes` 停止并标 `logTruncated`。清理：`logRetentionDays` 到期删日志行（记录保留）；删除历史时一并删。

### 2.7 前端路由与页面

- 被分享页：`/s/:shareId` 与 `/n/:nodeId/s/:shareId`，挂在 RootLayout 之外（无侧栏、无设置、无文件面板）。状态：`loading` → `password`（表单）→ `terminal`（DeviceConsole，share 模式）→ `ended`（提示「分享已结束」）。
- 分享弹窗：终端工具栏「分享」按钮（`packages/panels` toolbar），弹窗字段见第一节；创建成功后显示链接 + 密码 + 复制按钮；已有分享时按钮高亮并显示在线人数，点击展示现有链接与「终止」。
- 设置 → 分享 tab：进行中表格、历史表格（删除）、日志回放（模拟终端 + 时间轴）、设置区（记录日志、保留天数、上限、默认地址）。
- i18n：分享方与设置在 rest（`share.*`、`settings.share.*`）；被分享页在 core（`shareAccess.*`，加入 `I18N_CORE_KEY_PREFIXES`）。文案简洁专业。

## 三、任务分工（并行；各自只碰自己范围）

| 编号 | 角色 | 范围 |
|---|---|---|
| T1 | 后端核心（Opus） | `packages/shared/src/share/**` + package.json 导出；`apps/gateway/src/db/schema/share.ts` + 迁移；`apps/gateway/src/share/**`（service、store、routes、recorder、origins、sweeper）；`apps/gateway/src/api/index.ts` 加路由；`apps/gateway/src/runtime.ts` 装配 |
| T2 | 后端 ws 隔离（Opus） | `apps/gateway/src/ws/**`：shareScope、白名单、出站过滤、closeShareSessions、recordInput 钩子 |
| T3 | 后端 mesh/装配（Opus） | `apps/gateway/src/mesh/**`（cookie/guard/forwarder/stream-targets/public paths/session-middleware）、`packages/app/src/runtime/assemble-routes.ts`、`apps/gateway/src/tunnel/access-paths.ts` |
| T4 | 前端分享弹窗（Opus） | `packages/panels/src/device-console/**`（按钮）、`packages/panels/src/share/**`（弹窗）、`packages/api-client/src/share.ts`、locale `share.*` |
| T5 | 前端被分享页（Opus） | `apps/fe/src/share/**`、`apps/fe/src/pages/SharePage.tsx`、`main.tsx`/`page-modules.ts` 路由、`core-keys.ts`、locale `shareAccess.*`、`packages/panels`/`packages/stores` 的 share 模式开关（只加 option，不改现有行为） |
| T6 | 前端设置分享 tab + 回放（Opus） | `apps/fe/src/pages/settings/share/**`、`SettingsPage.tsx`、`data-prefetch.ts`、locale `settings.share.*` + tab 名 |
| EX2 | 探索（Opus） | 任务 6：PWA 进入时节点显示慢 |
| EX3 | 探索（Opus） | 任务 7：链路信息窗 i18n 缺失清单；任务 8：遗留项可行性定位 |
| T7–T9 | 后续 | 按 EX2/EX3 结论派发 |
| R | codex gpt-6-astra high | backend / mesh / frontend 三片审查 |

## 四、验收

- 单测：各包 `bun test` 0 fail；`bunx tsc --noEmit` 0 错；`biome check` 与复杂度门禁 0 违规。
- 实测（指挥官）：临时实例（独立 tmux socket + 端口覆盖）创建分享 → 无痕窗口打开链接 → 输密码 → 只见该窗口 → 输入生效 → 终止后 1 s 内断开 → 日志可回放；mesh e2e 项目跑一遍 hub 转发路径。
- 发版 1.1.34，本地 tarball 升级本机。
