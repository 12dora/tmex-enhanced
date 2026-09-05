# T4 结果：分享方前端（工具栏按钮 + 分享弹窗）

## 交付物

### 1. `packages/api-client/src/share.ts`（新增）+ `index.ts` 加一行导出

按 plan §2.2 实现四个端点函数，类型来自 `@tmex/shared/share`：

- `shareQueryKey(filter?)` / `shareListPath(filter?)`（纯函数，便于单测与缓存失效）
- `listShares(client, filter?, signal?)` → `GET /api/share[?deviceId&windowId]`，保留 `{ active, history }` 信封
- `createShare(client, input)` → `POST /api/share`，返回 `{ share, password }`
- `revokeShare(client, id)` → `POST /api/share/:id/revoke`，拆 `{ share }` 信封
- `getShareOrigins(client)` → `GET /api/share/origins`

节点前缀由 `ApiClient.baseUrl`（`/n/<nodeId>`）承担，与 `devices.ts` 一致；错误走 `requestJson` + `parseApiError`。
设置 / 日志 / 删除历史三族端点按分工留给 T6，本文件不含。

### 2. 工具栏「分享」按钮

- `packages/panels/src/device-console/device-console-toolbar.tsx`
  - `ToolbarButton` 扩展：`badge.count?: number`（有 count 就渲染数字角标，没有仍是原来的小圆点）、`active?: boolean`（高亮态：`variant="secondary"` + `text-primary` + `data-active`）
  - 新增 `shareButton()`，图标 lucide `Share2`，`testId="share-open-button"`，角标 `share-active-indicator`
  - 顺序：分屏 → 刷新 → 输入模式 → **分享** → watch → 终端设置
  - `TranslateFn` 放宽为 `(key, params?) => string`（在线人数要插值）
- `use-device-console-actions.ts`：model 新增 `windowId` / `shareUi` / `hasActiveShare` / `shareViewers`；`shareUi = !runtime.features.shareViewer`（T5 已落地该 flag，故直接读）
- `page-actions.tsx`：新增 `showShareDialog` 状态、`DeferredShareDialog` 挂载与空闲预热（与 watch 对话框同一套按需加载机制）

轮询：`useShareStatus` 用 react-query 打 `GET /api/share?deviceId&windowId`，`refetchInterval` 为函数——有进行中分享 10 s，否则 60 s（`refetchIntervalInBackground` 默认 false，隐藏页不轮询；切回页面照常 refetch on focus）。

### 3. 分享弹窗 `packages/panels/src/share/**`（新增目录）

| 文件 | 作用 |
|---|---|
| `share-dialog-model.ts` | 纯逻辑：草稿形态、时长换算/校验、地址缺省选取、剩余期限分档、轮询间隔 |
| `use-share-status.ts` | `(deviceId, windowId)` 的分享状态查询（工具栏与弹窗共用同一缓存键） |
| `use-share-dialog.ts` | 弹窗数据面：草稿、地址候选、创建/终止两个 mutation、创建态↔进行中态选择 |
| `share-dialog.tsx` | 弹窗外壳 + 终止二次确认（`@tmex/ui/confirm-dialog`） |
| `share-create-form.tsx` | 名称 / 有效期 / 密码 / 地址四个字段 |
| `share-active-view.tsx` | 链接、密码、在线人数、有效期、终止按钮 |
| `share-copy-field.tsx` | 只读输入框 + 复制按钮（`writeTextToClipboard`，Clipboard API 失败回退 execCommand；成败都 toast） |
| `deferred-share-dialog.tsx` | 按需加载 + 空闲预热 + 失败兜底条（复用 `TerminalSettingsFallback`） |
| `index.ts` | 出口 |

行为要点：

- 创建态：默认名 = 当前 window 名（取自 tmux store 快照，缺省回落 windowId）；有效期 1h / 24h / 7d / 永久 / 自定义（数值 + 小时/天，上限 365 天），缺省 24h；密码预填 `generateSharePassword()`，可编辑，带「重新生成」，最短 6 位校验；地址下拉由 `getShareOrigins` 填充，缺省选 `recommended`（不在候选里则回落第一条），无候选时展示提示并禁用创建按钮。
- 进行中态：链接只读 + 复制；密码仅在刚创建那一次给明文，已有分享显示 `••••••••` + 「密码仅在创建时显示一次。」且复制按钮禁用；在线人数、剩余期限（相对 + 绝对时间，绝对时间 `title` 用 `share.dialog.expires`）；「终止分享」走二次确认。
- 终止后到下一次列表返回之间按 id 挡掉旧记录，不会闪回「进行中」。

### 4. i18n `share.*`（三语各 41 个 key）

`packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json` 各插入一棵 `share` 子树（只动这一棵，其余字节未改）。zh_CN 为源语言、全角标点、无第二人称；术语跟随现有 UI（tmux window 称「窗口」）。已跑一次 `bun run --filter @tmex/shared build:i18n`（common.md 允许），生成物未手改。

`share.*` 落在 rest 包，与终端设置面板同路径（页面模块加载前 `ensureI18nRest`），无需改 `core-keys.ts`。

## 测试

| 命令 | 结果 |
|---|---|
| `cd packages/api-client && bun test` | 242 pass / 0 fail（其中 `share.test.ts` 13 pass） |
| `cd packages/api-client && bunx tsc --noEmit -p .` | 0 错 |
| `cd packages/panels && bun test` | 992 pass / 0 fail（新增 40：model 31 + 渲染 9 + deferred 5，其中 share 目录 4 个文件） |
| `cd packages/panels && bunx tsc --noEmit -p .` | 0 错 |
| `cd apps/fe && bun test src/i18n` | 28 pass / 0 fail（core 覆盖复核通过） |
| `cd packages/shared && bun test` | 750 pass / 0 fail（确认 build:i18n 未破坏既有断言） |
| `bunx biome check <本任务全部文件>` | clean |
| `bun scripts/complexity/gate.ts` | 本任务文件 0 违规 |

新增测试文件：

- `packages/api-client/src/share.test.ts`：URL / query 串转义 / body 形状 / 信封拆包 / node 前缀 baseUrl / 错误 fallback
- `packages/panels/src/share/share-dialog-model.test.ts`：时长换算（含非法值与 365 天上限）、四类校验、请求体拼装、地址缺省选取、活动分享挑选、剩余期限分档、轮询间隔
- `packages/panels/src/share/share-views.test.tsx`：静态渲染（复用 `watch-test-harness` 的 i18n + RuntimeProvider + QueryClient 夹具）——创建表单四字段 / 自定义时长展开 / 无地址禁用；进行中态链接、明文密码 vs 遮罩、剩余期限
- `packages/panels/src/share/share-i18n.test.ts`：41 个 key 三语齐全且无孤儿；插值占位符（`{{count}}` / `{{value}}` / `{{min}}`）三语保留
- `packages/panels/src/share/deferred-share-dialog.test.tsx`：兜底条视图模型与空闲预热调度

改动的既有测试：`device-console-actions.test.ts`（按钮顺序、handler 路由、新增 3 个分享按钮用例）、`toolbar-tooltips.test.tsx`（model 夹具补字段）。

## 与契约的偏差 / 说明

1. **client 参数位置**：任务书给的签名是 `listShares(client, filter?)` 等（client 在前），与本包既有约定（`client: ApiClient = defaultApiClient` 收尾）相反。按任务书的显式签名实现，`listShares` 的 client 无默认值。若评审要求统一到包内约定，改动面很小。
2. **`buildShareUrl` 未使用**：`POST /api/share` 已返回完整 `share.url`，前端直接展示，不再自己拼。
3. **`share.dialog.expires`** 只作为绝对到期时间的 `title` 提示，主行显示的是「剩余 N 天/小时/分钟」+ 绝对时间；永久分享显示 `share.dialog.permanent`。
4. **自定义时长上限 365 天**（`SHARE_CUSTOM_MAX_MS`）为本任务自定的前端约束，契约未规定；超过请选「永久」。
5. **`ToolbarButton.badge` 扩了 `count`、新增 `active`**：属于 device-console 自己的模型，未影响 watch 按钮既有形状（watch 仍是无 count 的圆点）。
6. `packages/panels/src/share/share-views.test.tsx` 复用了 `../watch/watch-test-harness`（同包内测试夹具），没有再复制一份 i18n/Runtime 初始化。

## 跨范围触碰（最小改动，已列明）

- `packages/api-client/src/index.ts`：加 `export * from './share';` 一行
- `packages/shared/src/i18n/locales/*.json`：只新增 `share` 子树
- 跑过一次 `bun run --filter @tmex/shared build:i18n`（生成物随之更新）

## 开放问题

- `cd apps/fe && bunx tsc --noEmit -p .` 目前有 3 条错误，全在 `src/pages/settings/share/{active-shares-table,history-table}.tsx`（T6 在写的表格给 `Td` 传了它不接受的 `title` 属性），与本任务无关。
- 复杂度门禁当前有 5 条违规，全在 `apps/gateway/src/mesh/stream-targets.ts` 与 `packages/app/src/runtime/assemble-routes.ts`（T3 范围）。
- 分享弹窗尚未在开发实例里截图核对换行/截断（文案规范要求）；需指挥官在实测阶段一并确认。
