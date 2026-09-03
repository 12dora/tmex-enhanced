# L3 结果：删除三条仅测试引用的路由

## 1. 改动清单

### 删除的文件

- `apps/gateway/src/api/tmux-tree.ts`（75 行）
- `apps/gateway/src/api/tmux-tree.test.ts`（235 行）
- `apps/gateway/src/api/theme.ts`（52 行）
- `apps/gateway/src/api/theme.test.ts`（122 行）

### 新增的文件

- `apps/gateway/src/db/site-settings-theme.test.ts`（3 个用例）——承接 `theme.test.ts:106-122` 的
  DB 约束覆盖。原用例靠「同文件前一个用例刚把主题写成 dark」才碰巧成立，重写为顺序无关：
  - `PRAGMA table_info('site_settings')` 断言 `theme` 列 `DEFAULT 'dark'` 且 `NOT NULL`；
  - raw SQL 写 `'blue'` 必须抛错且行不被改写；
  - raw SQL 写 `light`/`dark` 均被接受。
  断言一律直接读 DB 行（`getSiteSettings()` 有 30 s 内存缓存，raw SQL 绕不开它）。
- `apps/fe/tests/helpers/site-theme.ts`——e2e 站点外观 helper（见 §3）。

### 修改的文件

| 文件 | 改动 |
| --- | --- |
| `apps/gateway/src/api/system-routes.ts` | 去掉 `tmuxTreeRoutes` 与 `handleTmuxTreeApiRequest` import；顺手删掉本来就没人用的 `import { t } from '../i18n'` |
| `apps/gateway/src/api/index.ts` | 路由聚合去掉 `tmuxTreeRoutes` |
| `apps/gateway/src/api/settings-routes.ts` | 去掉 `GET|POST /api/settings/theme` 挂载与 `handleThemeApiRequest` import |
| `apps/gateway/src/hub/hub-runtime.ts` | 删 `POST /api/hub/nodes/:id/revoke` 路由、`dispatchForwardedRevoke`、`handleRevoke`，以及只被 `handleRevoke` 用的 `decodeKeyLogRecord` / `decodeRevokeNodePayload` import。1367 → 1316 行 |
| `apps/gateway/src/hub/hub-runtime.test.ts` | 重写 revoke 用例（见 §2）；standby 写路由用例去掉 revoke 一段并改名「三条写路由」 |
| `apps/gateway/src/hub/writer-forward.test.ts` | 路由清单去掉 `/api/hub/nodes/n1/revoke`（转发器与路径无关，其余 4 条仍覆盖） |
| `apps/gateway/src/mesh/integration/mesh.integration.test.ts` | 两个 revoke 用例改走 `POST /api/auth/keylog?hub=sync` |
| `apps/fe/tests/*.spec.ts`（5 个） | HTTP 主题读写全部改走新 helper（见 §3） |
| `scripts/hub-e2e/driver/files.ts` | 删 `tmux-tree` 子命令与 usage 里的该词 |
| `docs/ws-protocol/2026070402-site-theme-update.md` | 背景段不再说「HTTP POST `/api/settings/theme` + 轮询」，改成「早期方案已下线，只剩这条 WS 通道」 |
| `docs/hub/2026082700-hub-node-architecture.md` | hub 管理 API 列表去掉 `revoke`，改述为「撤销走 `POST /api/auth/keylog?hub=sync`」 |
| `docs/hub/2026090104-multi-hub-standby.md` | `HUB_NOT_WRITER` 覆盖清单去掉 revoke 路由；自认证载荷一句改成「keylog（含 `revoke-node`）」 |

保留（按要求未动）：`apiError.deviceNotFound`、`broadcastThemeChange` / `broadcastSiteThemeUpdateS2C` /
`broadcastSettingsUpdate` / `getSiteSettings` / `updateSiteSettings`、`revokeNodeRecord`、
`revoke-node` key-log 类型、hub authorization、节点 revoked 状态、全部 revoke 相关 i18n key。

## 2. hub revoke 的测试改写

删掉的路由与 key-log 追加是同一件事的两个入口：产品侧真正在用的是
`POST /api/auth/keylog?hub=sync`（`packages/api-client/src/auth/auth-api.ts:324-356`），
它在 entry 节点上先把签名记录经 uplink `key.log.append` 发给 hub 等 ack，再本地 append；
hub 侧 `HubUplinkServer.handleKeyLogAppend` → `keyLogSource.append` → `applyAppendEffects`
（`applyHubAuthorizationRecord` 置 `nodes.status=revoked` + `evictRevokedNode` 踢连接 + 广播 node.list）。
删掉的 `handleRevoke` 只是这条效果链的另一个 HTTP 外壳。

- `hub-runtime.test.ts`「GET /api/hub/nodes 与 rename；revoke-node 记录经 uplink 落库并踢下线」：
  改为 seed 第二个 admitted node 当 entry，两条 uplink 都 attach 并认证，**由 entry 链路**发
  `key.log.append`，断言 `key.log.ack{ok:true,id}`、`nodes.status=revoked`、
  `certs.revokedLogSeq != null`、被撤销节点链路 `closed.reason === 'revoked'`。
  - **必须由第三方链路发**：若由被撤销节点自己发，`LinkMux` 会把 ack 帧排进重入队列，
    而 `applyAppendEffects` 在同一轮同步关掉该链路，ack 帧被丢弃（实测复现）。
    这与既有 `uplink-server.test.ts`「合法 revoke-node 经 key.log.append 断开被撤销节点并拒绝重连」
    的写法一致，也更贴近产品（管理员在 entry 上撤销另一台）。
  - 只删掉了「无 body 的 revoke 返回 400」这一条——那是被删路由自己的入参校验。
- `hub-runtime.test.ts`「standby 三条写路由返回 409 HUB_NOT_WRITER」：删掉 revoke 一段。
  它测的是被删路由的 writer 闸门；等价的存活路径（standby 收到 `key.log.append` 回
  `key.log.ack{ok:false,error:HUB_NOT_WRITER,writerHubId/...}` 且 head seq 不变）已由
  `apps/gateway/src/hub/uplink-server.test.ts:2410-2465` 覆盖，无覆盖净损失。
- `mesh.integration.test.ts` 两处：`a.mesh.hub.handleRequest(.../revoke)` →
  `callMesh(a.mesh, 'http://entry/api/auth/keylog?hub=sync', { cookie: b.cookie, ... })`，
  额外断言 `{ ok: true, hubAck: true }`，其余断言（`revokedLogSeq`、B 掉线、A peer 关闭、
  `/n/B` 返回 401/503、已撤销身份 re-redeem 返回 `node_revoked`）逐条保留。

## 3. FE e2e：`/api/settings/theme` 的替代

新 helper `apps/fe/tests/helpers/site-theme.ts`：

- `setSiteTheme(theme: ThemeMode)`：按 `TMEX_E2E_GATEWAY_PORT`（缺省 9665，与
  `playwright.config.ts` / `global-setup.ts` 同源）连 `ws://127.0.0.1:<port>/ws`，
  发 `KIND_HELLO_C2S` 协商后发 `KIND_SITE_THEME_UPDATE` C2S 帧，等服务端把 S2C 广播回来才 resolve。
  这正是主题菜单走的那条链路（`theme-menu.tsx` → `useSiteStore.selectThemePreset/updateTheme`
  → `buildSiteThemeUpdate` → 同一 kind），服务端处理器是 `ThemeSettingsBroadcaster.handleSiteThemeUpdate`。
- `readSiteTheme(request)`：`GET /api/settings/site` 取 `settings.theme`。

被删的 HTTP handler 与 WS handler 的副作用完全等价（都是
`updateSiteSettings` + `scheduleTmuxThemeApply` + `broadcastSiteThemeUpdateS2C` +
`broadcastSettingsUpdate('theme')`），所以行为无变化。**顺带修正：几个 spec 的注释说
「HTTP 路径不发 S2C 广播」，那是 `registerThemeBroadcaster` 加上 s2c 回调之前的旧事实，
已随改动一并订正。** 因此不存在「断言 HTTP 不广播」的负向用例可删——
`theme-broadcast.spec.ts:9` 只是一行过时注释，已改写。

**逐个替换点（指挥官跑 Playwright 时对照）：**

| spec | 行 | 原调用 | 现调用 |
| --- | --- | --- | --- |
| `apps/fe/tests/theme-broadcast.spec.ts` | 77 / 113 / 133 / 173 / 191 / 217 | `request.post('/api/settings/theme', {data:{theme:'dark'}})` | `await setSiteTheme('dark')` |
| 同上 | 101 | `request.get('/api/settings/theme').then(r=>r.json())` + `.theme` | `const finalTheme = await readSiteTheme(request)` |
| `apps/fe/tests/theme-notify-2031.spec.ts` | 72 / 119 | 同上（dark） | `await setSiteTheme('dark')` |
| `apps/fe/tests/theme-propagation.spec.ts` | 73 / 97 / 129 / 147 / 167 / 204 / 240 / 278 / 285 | 同上（dark） | `await setSiteTheme('dark')` |
| 同上 | 109 | `...{theme:'light'}` | `await setSiteTheme('light')` |
| 同上 | 263（循环内） | `...{theme}` | `await setSiteTheme(theme)` |
| `apps/fe/tests/theme-presets.spec.ts` | 55 / 85 / 95 / 119 | 同上（dark） | `await setSiteTheme('dark')` |
| `apps/fe/tests/ws-borsh-theme-resize.spec.ts` | 112（循环内） | `const res = request.post(...{theme}); expect(res.ok())` | `await setSiteTheme(theme)`（helper 失败即抛，`expect` 被吸收） |
| 同上 | 147 | 同上（dark） | `await setSiteTheme('dark')` |

其它调整：`theme-presets.spec.ts` 第二个用例的 fixture 从 `{ page, request }` 改成 `{ page }`
（`request` 已无使用点，留着会触发 biome 未用变量）。**除上述替换外，所有断言逐条保留。**

helper 已在仓内临时 gateway（9767 端口、隔离 tmux socket `tmex-l3`、`NODE_ENV=test`）上实跑验证：
`dark → light → dark → dark(幂等)` 四次均在 100 ms 内拿到 S2C 确认，`GET /api/settings/site`
读回值一致。临时实例已关停，未触碰生产（9883 仍在跑，已复核）。

## 4. 验证

| 项 | 结果 |
| --- | --- |
| `bun test src/api`（gateway） | 416 pass / 0 fail（31 文件） |
| `bun test src/db`（gateway） | 109 pass / 0 fail（22 文件），含新增的 3 个 theme 约束用例 |
| `bun test src/hub`（gateway） | 208 pass / 0 fail —— **需带临时垫片**，见下 |
| `bun test src/mesh`（gateway） | 1070 pass / 8 fail —— 8 条全是并发改动导致，见下 |
| `bun test src/mesh/integration/mesh.integration.test.ts` | 15 pass / 1 fail（失败项与 revoke 无关，见下） |
| `bunx tsc --noEmit -p apps/gateway` | 76 error，**全部**来自并发中的 `TmexRoles.relay` / `UserKeyState` 改动；我改的文件 0 error |
| `bunx biome check <15 个改动文件>` | 通过 |
| `bun run lint`（仓库根） | biome 报 10 处、复杂度门禁报 4 处 + 1 条 stale allowlist —— **全部**落在别的 agent 正在改的文件（`mesh/forwarder.ts`、`ws/index.ts`、`ws/canonical-feed-session.ts`、`ws-client/*` 等），我的文件无一上榜 |

### 关于 hub/mesh 的失败

跑到一半时 `packages/shared/src/auth/key-log.ts` 被 L1/L2 加了 `relays` / `metaKeyEpoch` /
`metaKeyEntries` 三个 `UserKeyState` 字段，但 `apps/gateway/src/auth/user-key-service.ts:241`
的 state 构造还没跟上，于是**任何** key-log append 都在 `cloneState` 里抛
`TypeError: state.metaKeyEntries.map is not a function`。这让 `src/hub` 里 15 条 key-log 相关用例
（含我重写的那条、也含既有的 redeem / rotate-root / uplink revoke 用例）一起红。

为确认不是我改坏的，我用一个**临时** preload 垫片（补上三个字段，`relays` 补 `null`）跑了一遍：
`src/hub` 208 pass / 0 fail，`src/hub/hub-runtime.test.ts + writer-forward.test.ts` 32 pass / 0 fail。
垫片文件已删除，仓库里没有残留。

`src/mesh` 的 8 条失败全部是 `[ws] client disconnected ... reason=canonical-state-v1.1 required`
（HELLO 协商拿到 `KIND_ERROR(5)` 而非 `KIND_HELLO_S2C(2)`），来自并发中的 canonical v1.1 能力门，
与本任务无关：`stream-targets.test.ts` ×3、`mesh.integration.test.ts` ×1
（`/n/B/ws HELLO then DEVICE_CONNECT`）、`direct-path.integration.test.ts` ×2、
`stream-failover.integration.test.ts` ×2。我重写的两条 revoke 用例均 pass。

## 5. 需要指挥官处理

1. **`scripts/hub-e2e` 的两个 run.sh 会因删掉 `tmux-tree` 子命令而断**（这两个文件不在我的
   scope，未改）。调用点：
   - `scripts/hub-e2e/run.sh:406`（结果写 `/out/tmux-tree-b.json`，422 行读它）
   - `scripts/hub-e2e/split/run.sh:820 / 948 / 1016 / 1226`（分别产出
     `tmux-tree-a.json` / `tmux-tree-hub.json` / `tmux-tree-b.json`，
     830 / 957 / 1025 行用 `j.devices?.[0]?.session?.windows?.[0]?.panes?.[0]?.id` 取 pane id；
     1269 / 1297 行再引用这些 json）

   建议改法：这些 json 只被用来**猜一个 pane id**，而 `scripts/hub-e2e/driver/terminal.ts`
   本来就会从 `STATE_SNAPSHOT` 自己解析 pane（`terminal.ts:162-171`，`--pane-id` 只是兜底种子），
   所以最省事的是删掉这些 `driver files.ts tmux-tree` 调用、`PANE_A/PANE_H/PANE_B` 传空串或
   任意占位值，让 `terminal.ts` 用快照里的 pane。另一条路是给 driver 加一个走 WS 快照的
   `pane-id` 子命令。

2. **`apps/gateway/src/tmux/theme-broadcaster.ts` 的两个转发函数已成死代码**
   （`broadcastThemeChange` / `broadcastSiteThemeUpdateS2C`——注册表指向 wsServer 的同名方法，
   唯一调用方是被删的 `api/theme.ts`；`registerThemeBroadcaster` 仍被 `runtime.ts:163,253` 调用）。
   该文件与 `runtime.ts` 不在我的 scope，未动。清掉的话是：删 `theme-broadcaster.ts`，
   并去掉 `runtime.ts` 里的 `registerThemeBroadcaster(...)` 两处调用。
   注意 `ws/theme-settings-broadcaster.ts` 和 `ws/index.ts` 上的同名**方法**仍在用，不能删。

3. **`scripts/complexity/allowlist.json` 里 `apps/gateway/src/hub/hub-runtime.ts` 的
   `fileLines: 1368` 可以收紧到 1316**（文件已缩到 1316 行）。allowlist 不在我的 scope、
   且与其他 agent 高度共享，未改；当前不会报错（门禁只判 `>`）。

4. **`apps/gateway/src/mesh/integration/mesh.integration.test.ts` 的改动已被别的提交裹进去了**：
   我改完之后仓库出现了 `03837ef5 test: TmexRoles 字面量补 relay: false（183 处，机械替换）`，
   该提交把我这个文件的 revoke 改写一并提交了。其余 L3 改动仍在工作区未提交。

5. **Playwright 由指挥官跑**：需要跑的 5 个 spec 是
   `theme-broadcast.spec.ts`、`theme-notify-2031.spec.ts`、`theme-propagation.spec.ts`、
   `theme-presets.spec.ts`、`ws-borsh-theme-resize.spec.ts`，替换点见 §3 表格。
   helper 依赖 `TMEX_E2E_GATEWAY_PORT`（`bun run test:e2e` 会注入），直连 gateway 而不走 vite 代理。

6. `bunx tsc --noEmit -p apps/gateway` 与 `bun run lint` 目前红，但红点全在 L1/L2 的在途文件上
   （`TmexRoles.relay`、`UserKeyState.metaKey*`、`mesh/forwarder.ts` 格式与行数等）。
   等它们收口后需要复跑一次全量门禁，届时 `src/hub` 的 15 条 key-log 用例应一并转绿
   （我已用垫片验证过）。
