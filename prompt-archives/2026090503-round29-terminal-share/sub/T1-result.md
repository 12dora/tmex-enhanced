# T1（后端核心）结果 — 终端分享

## 一、交付内容

### 1. 共享类型 `packages/shared/src/share/`（导出为 `@tmex/shared/share`）

| 文件 | 内容 |
|---|---|
| `types.ts` | `ShareState`/`ShareEndReason`/`ShareScope`/`ShareRecord`/`ShareSettings`/`ShareOriginKind`/`ShareOriginCandidate`/`ShareLogEntry`，及 `SHARE_PASSWORD_MIN_LENGTH`、`SHARE_DURATION_PRESETS_MS`。额外补充：`ShareLogKind`、`ShareLogPage`、`SHARE_DEFAULT_SETTINGS`、`SHARE_ID_LENGTH`、`SHARE_WS_CLOSE_ENDED=4410`、`SHARE_WS_CLOSE_LOGIN_REQUIRED=4401`、`SHARE_LOG_PAGE_MAX_ENTRIES=2000`、`SHARE_LOG_PAGE_MAX_BYTES=2MiB`（T2/T5/T6 可直接用） |
| `password.ts` | `generateSharePassword(length=8)`：`crypto.getRandomValues` + 拒绝采样（无取模偏置），字母表 57 字符去掉 `0O1lI`；长度低于下限自动提到 6 |
| `origins.ts` | `isPublicShareOrigin`（拒 loopback / 10 / 172.16-31 / 192.168 / 169.254 / CGNAT 100.64-127 / 0.x / 组播 / IPv6 `::1` `::` ULA `fc00::/7` 链路本地 `fe80::/10` 站点本地 / IPv4-mapped（含 WHATWG 归一化后的 `::ffff:c0a8:1` 十六进制形式）/ `localhost` / `*.local` / `*.localhost` / `*.internal` / 裸主机名 / 非 http(s)）、`normalizeShareOrigin`、`rankShareOrigins`（custom>site>hub>relay>tunnel>ip，同 kind 稳定，去重） |
| `url.ts` | `sharePath`、`nodeSharePrefix`、`buildShareUrl` |

`packages/shared/package.json` 增加 `"./share": "./src/share/index.ts"`。整个目录零 `node:` 导入，浏览器安全（已用 `apps/fe` 内探针验证类型与运行时都能解析 `@tmex/shared/share`）。

### 2. 数据库

- `apps/gateway/src/db/schema/share.ts`：`shares` / `share_access_tokens` / `share_logs`（PK `(share_id, seq)`，`kind` CHECK）/ `share_settings`（`id=1` 单例）。`shares` 带 `state`、`end_reason` CHECK 与 `state`、`(device_id, window_id)` 索引；子表 `ON DELETE cascade`。
- 迁移 `apps/gateway/drizzle/0047_share.sql` + `drizzle/meta/_journal.json` 追加 idx 47 + `apps/gateway/src/db/managed-migrations.ts` 追加文件名。
- `apps/gateway/src/db/schema.ts` 加 barrel 一行。
- `apps/gateway/src/db/share.migration.test.ts`：字段/默认值、CHECK、级联删除、唯一索引、单例约束。

### 3. `apps/gateway/src/share/`

| 文件 | 职责 |
|---|---|
| `share-token.ts` | `SHARE_COOKIE_PREFIX='tmex_sh_'`、`shareCookieName(via)`、`isValidShareCookieVia`、`SHARE_AUTH_PREFIX='share:'`、`parseShareToken`、`generateShareId`（22 位 base64url）、`generateShareToken`、`hashShareToken`（SHA-256 hex）、`X_TMEX_SET_SHARE` / `X_TMEX_SET_SHARE_MAX_AGE` / `X_TMEX_CLEAR_SHARE`、`SHARE_ACCESS_TTL_MS=7d` |
| `share-store.ts` | drizzle CRUD、日志批量追加（单事务里推进 `log_seq`/`log_bytes`、越界置 `log_truncated`）、日志分页读、按 `at` 保留期清理、访问凭证增删续期与过期清扫、设置读写。口令哈希复用仓库既有 argon2id（`relay-password.ts` 的 `hashRelayPassword`/`verifyRelayPassword`，与根密钥同参数） |
| `share-rate-limit.ts` | `ShareLoginLimiter`：按 `shareId+ip` 15 min 窗口 10 次失败即锁定，`lockedFor()` 返回剩余毫秒 |
| `share-origins.ts` | 候选构造：`site`=`site_settings.site_url`、`hub`=`mesh_hubs` 每个 publicUrl（他人 hub 带 `/n/<本机 nodeId>`，本机即 hub 无前缀）、`tunnel`=`tunnelManager.status().process.publicUrl` 或已配置 hostname、`ip`=`config.baseUrl` 且 host 是 IP。`resolveSharePrefix(context, origin)` 给出该地址的节点前缀 |
| `share-recorder.ts` | 单分享录制器：`attachPaneConsumer` + `applySubscriptions` 订阅 window 内 pane，`captureCanonicalScreen` 写 `checkpoint`，checkpoint 之前的字节按 `baseSeq` 精确裁剪（复用 retention 的 `seqEnd<=cursor` 跳过 / `cursor-seqStart` 偏移语义），之后追加 `out`；`recordInput`/`recordResize`；按快照动态跟随 pane 进出 window；250 ms 批量落库；写入被拒（超上限）即自停并关闭租约 |
| `share-service.ts` + `share-service-support.ts` | 单例 `getShareService()`，见下 |
| `share-routes.ts` | 分享方 8 条路由 |
| `share-access-routes.ts` | 被分享人 3 条路由 + `readShareCookieToken` |
| `types.ts` | `ShareService` 接口、`ShareServiceDeps`、各 result/error 类型 |
| `index.ts` | barrel（最早提交，供 T2/T3 引用） |

`ShareService`：`create` / `list` / `get` / `revoke` / `remove` / `endShare` / `readLog` / `getSettings` / `updateSettings` / `listOrigins` / `verifyAccessToken` / `loginAccess` / `logoutAccess` / `onEnded` / `recordInput` / `recordResize` / `setViewerCounter` / `startSweeper` / `watchTick` / `retentionTick` / `stop`。

巡检：`startSweeper()` 开机先扫一遍（收掉已过期的、给其余排到期定时器并起录制器），之后每 5 s `watchTick()`（到期 → `expired`；设备记录消失 → `device_removed`；快照存在但 window 不在 → `window_closed`；快照为 null 不误判），每小时 `retentionTick()`（按 `logRetentionDays` 删日志行 + 清过期凭证）。`runtime.ts` 在 `liveStart()` 前 `startSweeper()`、`stop()` 里 `await getShareService().stop()`。

设备 runtime 走 `tmuxRuntimeRegistry.acquire/release`（agent / watch / push 同一条路径），未触碰 `ws/`。

### 4. 接口对齐

- 分享方：`GET/POST /api/share`、`POST /api/share/:id/revoke`、`DELETE /api/share/:id`、`GET /api/share/:id/log?after&limit`、`GET/PUT /api/share/settings`、`GET /api/share/origins`，挂进 `apps/gateway/src/api/index.ts` 的 `apiRoutes`（settings/origins 排在 `:id` 之前）。
- 被分享人：`GET /api/share-access/:id`、`POST /api/share-access/:id/login`、`POST /api/share-access/:id/logout`。login 成功只发 `x-tmex-set-share` + `x-tmex-set-share-max-age`（无 Set-Cookie，已有单测断言）；logout 发 `x-tmex-clear-share: 1`。读取当前凭证优先用 `tmex_sh_<via>`（via 取 `getMeshRequestContext`，本机为 `self`），否则回退扫描任意 `tmex_sh_*` 中 shareId 匹配的。限流 IP 用 `clientIpFromRequest`（与 auth-routes 同源）。

## 二、测试

| 命令 | 结果 |
|---|---|
| `cd apps/gateway && bun test src/share src/db` | 191 pass / 0 fail（33 文件） |
| `cd apps/gateway && bun test src/share src/db src/api` | 610 pass / 0 fail（65 文件） |
| `cd packages/shared && bun test src/share` | 20 pass / 0 fail |
| `cd apps/gateway && bunx tsc --noEmit -p .` | 我的范围（`src/share`、`src/db`、`src/api`、`src/runtime.ts`）0 错；仅剩 `src/ws/**` 的报错（T2 在改） |
| `cd packages/shared && bunx tsc --noEmit -p .` | 0 错 |
| `bunx biome check <我的 32 个文件>` | 0 违规 |
| `bun scripts/complexity/gate.ts` | 我的文件 0 违规（剩余 6 条属 `mesh/stream-targets.ts`、`app/runtime/assemble-routes.ts`、`fe/pages/settings/share/share-tab.tsx`，非本任务范围） |

新增测试文件：`packages/shared/src/share/{password,origins,url}.test.ts`；`apps/gateway/src/db/share.migration.test.ts`；`apps/gateway/src/share/{share-store,share-service,share-recorder,share-origins,share-routes,share-token,share-rate-limit}.test.ts`。

## 三、与契约的偏差 / 补充

1. **无 `relay` 候选**。`ShareOriginKind` 与 `rankShareOrigins` 保留 `relay` 优先级，但 `share-origins.ts` 不产出该 kind：本仓库的中继是盲字节转发（`relay-stream-router.ts` 只解 `{to}`，内层 `SecureChannelLink` 加密），浏览器无法经中继直达节点，没有可访问的公开 URL 概念。
2. **`GET /api/share/origins` 的 `nodePrefix`** = 推荐地址所需的前缀（不同候选前缀可能不同：hub 候选要 `/n/<nodeId>`，site/tunnel/ip 不要）。每个候选的前缀在服务端 `prefixes` 表里保存，`POST /api/share` 用它算 `ShareRecord.url = buildShareUrl(origin, prefix, id)`；`ShareRecord.origin` 保持不含路径。
3. **新增错误码**：`POST /api/share` 在地址非公网时返回 400 `SHARE_ORIGIN_INVALID`；`DELETE /api/share/:id` 对仍进行中的分享返回 409 `SHARE_ACTIVE`。契约里的四个码（`SHARE_NOT_FOUND` 404 / `SHARE_WINDOW_NOT_FOUND` 404 / `SHARE_PASSWORD_TOO_SHORT` 400 / `SHARE_ENDED` 409、被分享人侧 410）均按原样实现。
4. **口令哈希**用仓库既有 argon2id（`relay-password.ts`，64 MiB / 3 轮 / 自描述 JSON），未用 `Bun.password`：既有实现就是 argon2id 且与根密钥同参数，复用避免第二套 KDF。访问 token 存 SHA-256 十六进制 ✔。
5. **`ShareService` 多出 4 个方法**：`get`、`readLog`、`watchTick`、`retentionTick`（路由与测试需要），其余签名与任务书一致。`setViewerCounter` 接受 `fn | null`。
6. **迁移是手写的**（drizzle 风格）。用隔离配置跑过 `drizzle-kit generate --schema src/db/schema/share.ts` 拿到官方 SQL，再把 `shares` 提到子表之前落成 `0047_share.sql`；没有重跑仓库主 `db:generate`：`drizzle/meta` 的快照在 `0032` 就停了，0033–0046 全是手写，重跑会产生跨越 14 个迁移的错误 diff。
7. **范围外的改动（均为一行级）**：`apps/gateway/src/db/managed-migrations.ts`（打包运行时的迁移清单，不加新库跑不了迁移）、`apps/gateway/drizzle/meta/_journal.json`。其余越界文件都在任务书授权内：`apps/gateway/src/api/index.ts`（挂路由）、`apps/gateway/src/runtime.ts`（起停 sweeper）、`apps/gateway/src/db/schema.ts`（barrel）、`packages/shared/package.json`（exports）。

## 四、给其他 agent 的接口备忘

- **T2（ws）**：`import { getShareService } from '../share'` → `recordInput(scope, paneId, bytes)` / `recordResize(scope, paneId, cols, rows)` / `onEnded(({shareId, reason}) => …)`（终止 / 到期 / 窗口关闭 / 设备删除都会触发，用它 `closeShareSessions(shareId, 4410)`）/ `setViewerCounter((shareId) => count)`。关闭码常量在 `@tmex/shared/share`：`SHARE_WS_CLOSE_ENDED` 4410、`SHARE_WS_CLOSE_LOGIN_REQUIRED` 4401。
- **T3（mesh）**：`SHARE_COOKIE_PREFIX`、`shareCookieName(via)`、`isValidShareCookieVia(via)`、`SHARE_AUTH_PREFIX`、`parseShareToken`、`getShareService().verifyAccessToken(token, now?)`，以及三个头常量 `X_TMEX_SET_SHARE` / `X_TMEX_SET_SHARE_MAX_AGE` / `X_TMEX_CLEAR_SHARE`（均由 `apps/gateway/src/share` barrel 导出）。需要加白的公开路径：`/api/share-access/*`。`verifyAccessToken` 是同步的（SHA-256 查表），可直接在 upgrade 守卫里调用；它自带滑动续期与「分享已结束/过期」判定。
- **T4/T5/T6（前端）**：`@tmex/shared/share` 已可 import。`GET /api/share` 返回 `{active, history}`；`GET /api/share/origins` 返回 `{candidates, recommended, nodePrefix}`；日志 `data` 是 base64。

## 五、遗留 / 风险

- 录制器每 2 s 轮询设备快照来跟随 pane 进出 window；设备快照来自 runtime 的 `getCurrentSnapshot()`，没有事件驱动的 pane 变更钩子可用（`DeviceSessionRuntime` 只对外暴露 metadata patch 给 ws 层）。若后续 T2 愿意把 pane 变更事件透出，可换成事件驱动。
- `create` 依赖设备当前快照里能找到该 window（`getDeviceSnapshot` 来自 wsServer 的 lastSnapshot）。设备完全没有客户端连接时创建分享会返回 `SHARE_WINDOW_NOT_FOUND`——分享入口在终端页，实际不会命中。
- 日志保留按日志行的 `at` 时间戳裁（长命分享会先丢头部），不是按分享结束时间整条删。若产品期望后者，改 `ShareStore.purgeLogsBefore` 一处即可。
