# O2 result — 前端：节点页展示 hub 集合（主/备），`HUB_NOT_WRITER` 文案

## 落地内容

1. **api-client**：`AuthApi.listHubs()` → `GET /api/mesh/hubs`；契约类型 `MeshHubsResponse` / `MeshAttachedHub` 落在 `packages/api-client/src/auth/types.ts`，`HubEndpointInfo` / `HubMode` 直接从 `@tmex/shared/uplink` **type-only** 转出（不复制一份镜像类型；type import 在打包时被擦除，浏览器 bundle 不会因此引入 codec —— 已用探针验证 `apps/fe` 与 `packages/api-client` 两侧 tsc 都能干净解析该子路径）。`MeshNode` 加 `hubMode?: HubMode`。缺字段的响应补空集合，非 2xx 抛错（旧入口没有这条路由）。
2. **store `apps/fe/src/node/mesh-hubs.ts`**（新）：与 `mesh-nodes.ts` 同一套模块级 store + `useSyncExternalStore`。对外 `{ hubs, attached, writerHubId, loading, error, loadedAt, writerPublicUrl, writesBlocked, refresh }`；30 秒兜底轮询（`MESH_HUBS_POLL_MS`）+ `/mesh/ws` 连上补拉 + **已知 hub 机**的 NODE_EVENT 补拉（2 秒节流），页面隐藏跳过、重新可见立刻补一次。轮询回路是宿主级单例（引用计数），只有节点管理页 `owner: true`。
   纯函数 `writerHub` / `writerHubUrl` / `attachedHubId` / `hubWritesBlocked`。**`hubWritesBlocked` 只在有确凿证据时为 true**（集合为空 → false），旧入口 / 首屏未加载不会平白出现禁用提示。
3. **节点页**（`management/`）：
   - 新增 `hub-strip.tsx`：`HubStrip` 一台 hub 一枚 chip（在线点 + 名称/短 id + 主/备 + writer 的「写入」标记 + 挂载那枚的链接图标与高亮边框，`title` 里带 publicUrl/优先级/纪元/在线态与「当前入口挂载于此 Hub」）。**hubs < 2 时整条不渲染**，单 hub 用户零变化。
   - 表内 hub 徽标改成 mode-aware（`HubTag`）：`active` → 「主 Hub」、`standby` → 「备 Hub」，旧后端不下发 `hubMode` 时仍是原来的「Hub」；`title` 复用同一份详情。`isSelf` 标记原样。
   - `writesBlocked` 时给一行说明 `data-testid="nodes-hub-standby"` 并禁用「添加」/ 重命名 / 吊销 / 生成加入码 / 待确认的「确认」，禁用提示统一为该说明；**升级按钮不受影响**。主 hub 掉线时「hub 不可达」与它说的是同一件事，此时只渲染更具体的这一条（`nodes-hub-offline` 让位）。
4. **错误映射**：`management/errors.ts` 的 `actionErrorText(t, err, { writerPublicUrl })` 把 `HUB_NOT_WRITER` 映射成「备用 Hub 不接受管理操作，请通过主 Hub {{url}} 操作。」；不知道 writer 地址时退回 `auth.errors.HUB_NOT_WRITER`（不带地址的同义句）。writer 地址来自 hub 集合 store（`HubApiError` 只保留 `code`，没有改 `hub-api.ts`）。接入点：`use-node-row-actions.ts`（rename 也改走 `actionErrorText`，之前是裸 message；revoke 的 keylog 失败码同样走它）、`use-create-enrollment.ts`（新增**可选** `writerPublicUrl`，`join-token.tsx` 不用改）、`enrollment-section.tsx`。`enrollment-engine.ts` 走的是 `t('auth.errors.'+code)`，新增的 `auth.errors.HUB_NOT_WRITER` 自动覆盖，**未改该文件**。
5. **本机卡片**：`/api/local/status` 目前**不下发 hubMode**（`LocalRouteDeps` 只有 `hubUrl` / `hubPublicUrl`，见 `packages/app/src/runtime/assemble.ts` 的 `routeDeps`），按约定没有改 gateway / `packages/app`。改为**从 `/api/mesh/hubs` 里按自身 nodeId 反查**：`role === 'hub,node'` 且集合里认得出本机时多一行「Hub 角色：主 Hub / 备 Hub」（`local-machine-hub-mode`），认不出就整行不渲染，不做猜测。standalone / 纯 node 不发这个请求。
6. **i18n**：新增 `translation.nodes.hubs.*`（title/active/standby/writer/attached/online/offline/detail/standbyNotice/notWriter/machineRole）与 `translation.auth.errors.HUB_NOT_WRITER`，三语齐全（zh_CN 源语言，按 `tmex-copy-guidelines.md`：不用第二人称、一行说完、全角标点、产品名 Hub 原样；ja 沿用既有的「ハブ」）。已跑仓库根 `bun run build:i18n`，`resources.ts` / `types.ts` 重新生成（**未**对生成文件跑 lint/format）。

## 顺带修的一个真 bug（超出「只读 hubMode」的那一处 mesh-nodes 改动）

`findHubNodeId(nodes, modeHubNodeId)` 原来无条件优先 `nodes.find(isHub)`。多 hub 下这会命中列表里**任意**一台 hub（很可能是 standby），于是 hub 管理面（`/n/<hub>/api/hub/*`）被打到 standby 上，所有写入必吃 `HUB_NOT_WRITER`。G2 之后 `/api/auth/mode.hubNodeId` 已经是 **writer**，因此改为：列表里认得出 `modeHubNodeId` 且它 `isHub` 时以它为准，否则退回原来的扫描 + mode 兜底。四条既有用例全部不变（`'stale'` 不在列表里，仍走扫描），新增一条多 hub 用例。

## 文件

新增：
- `apps/fe/src/node/mesh-hubs.ts`、`apps/fe/src/node/mesh-hubs.test.ts`
- `apps/fe/src/pages/settings/nodes/management/hub-strip.tsx`

修改：
- `apps/fe/src/node/mesh-nodes.ts`（`NodeRow.hubMode` 加性字段 + `mergeNodes` 带出；`findHubNodeId` 优先 writer）、`mesh-nodes.test.ts`
- `apps/fe/src/pages/settings/nodes/management/`：`nodes-management.tsx`、`nodes-table.tsx`、`enrollment-section.tsx`、`errors.ts`、`types.ts`、`use-create-enrollment.ts`、`use-node-row-actions.ts`、`nodes-management.test.tsx`
- `apps/fe/src/pages/settings/nodes/local-machine-card.tsx`、`local-machine-card.test.tsx`
- `packages/api-client/src/auth/`：`types.ts`、`auth-api.ts`、`auth-api.test.ts`
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`（只动 `nodes.hubs` 子对象 + 一个 `auth.errors.HUB_NOT_WRITER`）+ 生成的 `resources.ts` / `types.ts`

**未触碰** `apps/gateway/**`、`packages/app/**`、`packages/shared/src` 的非 i18n 部分、`upgrade-batch.ts` / `use-node-upgrade*.ts`、`apps/fe/src/node/hub-api.ts`、`enrollment-engine.ts`、`join-token.tsx`。

`NodeRow.hubMode` 特意做成**可选**（`hubMode?: HubMode | null`）：改成必填会让 `use-node-upgrade.test.ts`（O1 已完成、我不该动）的行工厂编译不过；语义上它本来就是「只有 hub、且新后端才有」的一段。

## 测试 / tsc / biome

| 项 | 结果 |
|---|---|
| `apps/fe && bun test src/` | **1205 pass / 0 fail**（77 文件；基线 1168+，本次净增 20 条：mesh-hubs 16、mesh-nodes 2、nodes-management 4+3、local-machine-card 2，其余增量来自其它 agent 已落地的用例） |
| `packages/api-client && bun test` | **140 pass / 0 fail**（新增 3 条 `listHubs`） |
| `packages/shared && bun test` | **409 pass / 0 fail**（改 locale 后复核） |
| `bunx tsc --noEmit -p apps/fe` | **0** |
| `bunx tsc --noEmit -p packages/api-client` | **5**（与基线同，均在 `client.test.ts` / `files-download.test.ts`，未新增） |
| `bunx tsc --noEmit -p packages/stores` | **1**（基线，未动） |
| `bunx biome check`（本次改动的 26 个文件 + locale JSON） | **干净** |

## 给指挥者 / 后续

- **需要后端确认的一点**：`/api/mesh/hubs` 的 `hubs[].online` 是可选字段。前端把「缺失」当作「未知，不判离线」，只有显式 `online === false` 才算 writer 掉线。若 G2/G3 在某些路径上恒不下发 `online`，「writer 离线 → 禁用写入」这一条就只能靠 `attached.mode === 'standby'` 触发（standby failover 场景仍然正确）。
- **`/api/local/status` 仍无 `hubMode`**。当前是从 `/api/mesh/hubs` 反查本机，够用。若将来 G5 愿意在 `LocalRouteDeps` 里补 `hubMode`（`gatewayConfig.hubMode` 现成），本机卡片可以少依赖一次 mesh 请求 —— 属于可选优化，不阻塞。
- 未做浏览器实测截图（改动落在 mesh 多 hub 形态，本机只有单 hub 生产环境，按规则不碰生产）。多 hub 的版式核对建议放到临时双实例的联调里，重点看 chip 条在窄屏下的换行与 hub 名过长时的截断。
- 我没有执行任何 git 操作。
