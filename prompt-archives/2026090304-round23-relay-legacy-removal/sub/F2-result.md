# F2 结果：运营者侧「中继」设置标签 + api-client admin + i18n

分支 `feat/round23-relay-legacy-removal`（worktree `/Users/konata/code/tmex-r23`）。后端尚不存在，全部按 plan-00 §1.7 的固定契约实现，单测用假 fetch。

## 一、改动文件

### 新增：`packages/api-client/src/relay/`
- `admin-api.ts`（179 行）：`RelayAdminApi` 类 + 契约类型 + `RelayApiError`。
  - `status()` `GET /api/relay/status`；`health()` `GET /api/relay/health`；
    `setPassword({password, mode})` `POST /api/relay/password`；
    `updateDefaultQuota(quota)` `PATCH /api/relay/config`（体为 `{ defaultQuota }`）；
    `updateTenant(id, patch)` `PATCH /api/relay/tenants/:id`；
    `kickTenant(id)` `POST /api/relay/tenants/:id/kick`；`deleteTenant(id)` `DELETE /api/relay/tenants/:id`。
  - 写接口一律**丢弃响应体**返回 `void`，成功后由前端重拉 status 取权威值——后端返回什么形状都不会打架。
  - 租户编号进路径前 `encodeURIComponent`。
  - 错误体按仓库统一契约 `{ error: { code, message } }` 解（`readCodedError`），导出 `isRelayNotEnabled`（404）与 `isRelayUnauthorized`（401）两个判定。
- `admin-api.test.ts`（13 例）：路径 / method / body 逐条断言，含 404、401、非 JSON 错误体、路径编码。

`packages/api-client/src/index.ts` 增一行 `export * from './relay/admin-api';`（F1 的 `tenant-api` 未由我导出）。

### 新增：`apps/fe/src/pages/settings/relay/`
| 文件 | 行数 | 说明 |
|---|---|---|
| `relay-status-store.ts` | 196 | 宿主级单例 store + 30 s 轮询（同 `mesh-hubs.ts` 骨架），并兼标签门禁 |
| `relay-format.ts` | 93 | 短编号 / 相对时间 / 已运行时长 / 带宽 / 配额摘要 / 流量，纯函数 |
| `relay-forms.ts` | 142 | 配额、租户、口令三个草稿模型与校验（错误存 i18n key） |
| `use-relay-action.ts` | 37 | 单次写操作的 busy / error |
| `use-relay-controller.ts` | 149 | 标签页的全部可变状态与写路径（含 toast） |
| `relay-tab.tsx` | 224 | 标签本体：四种收尾 + 头部 / 正文 / 对话框三段 |
| `relay-cards.tsx` | 137 | 健康、总量、口令三张头部卡 |
| `default-quota-card.tsx` | 70 | 默认配额表单 |
| `quota-fields.tsx` | 90 | 配额三件套字段组（默认与租户覆盖共用） |
| `password-dialog.tsx` | 213 | 改口令对话框（清除开关 + 踢 / 留单选） |
| `tenant-editor-dialog.tsx` | 159 | 单租户备注 + 配额（含「跟随默认」） |
| `tenant-confirms.tsx` | 161 | 踢出确认（复用 `DangerConfirmDialog`）+ 删除确认（需逐字敲编号） |
| `tenant-table.tsx` | 242 | 租户表，含备注就地编辑 |
| 测试 5 个文件 | — | `relay-format.test.ts`(15) `relay-forms.test.ts`(15) `relay-status-store.test.ts`(13) `relay-tab.test.tsx`(10) `settings-tab-gating.test.tsx`(6)，共 **59** 例 |

复用而未改动：`packages/ui` 的 Card/Badge/Button/Input/Switch/Dialog/AlertDialog/Skeleton/Reveal，
`settings/components/form-primitives.tsx` 的 `Notice`/`FormField`/`InfoRow`，
`settings/components/danger-confirm-dialog.tsx`，`settings/nodes/copy-feedback.tsx` 的 `CopyButton`，
`node/create-polling-store.ts` 的 store / 轮询骨架。`packages/ui`、`packages/panels` 一行未改。

### 修改：`apps/fe/src/pages/SettingsPage.tsx`
- `SettingsTab` 加 `'relay'`；新增 `OPTIONAL_SETTINGS_TABS = ['relay']`，`isSettingsTab` 认它（`?tab=relay` 是合法深链），但 **不进 `SETTINGS_TABS`**——`chunkPreloadOrder` 因此从不预热中继这块 chunk（绝大多数机器不是中继）。
- 新增 `RELAY_TAB_ITEM`（图标 `RadioTower`，`labelKey: 'relay.admin.tabLabel'`），标签条按 `showRelay` 追加到最末位。
- 面板区加 `{activeTab === 'relay' && <RelayTab />}`，懒加载 `loadRelayTab`。
- `SettingsPage` 里调 `useRelayAvailability()` 做门禁。

## 二、门禁（gating）方式

FE 拿不到角色信息：`/api/auth/mode` 与 `/api/local/status` 的 `LocalRole` 都还没有 `relay`（`packages/api-client/src/local/types.ts` 不在我的范围，未动）。因此按任务书用**探针**：

1. 进设置页时 `useRelayAvailability()` 打一次 `GET /api/relay/status`（与 `/api/relay/health` 并发）。
2. 结果落到 store 的 `availability`：
   - 200 → `available`，标签出现；
   - **404 → `unavailable`**（`relay` 角色缺席时整族路由不存在），标签不出现，且本次会话不再探；
   - 401 → `unauthorized`，标签不出现，但**下次挂载会重探**（用户可能刚登录完）；
   - 其它错误 → 保持 `unknown`，标签不出现。
3. 目标机器固定是**浏览器直连的那台**（`defaultApiClient`，无 `/n/<id>` 前缀），与 `status-queries.ts` 里三块本机状态同一约定。
4. `?tab=relay` 深链在标签隐藏时照样能进：标签页本身会渲染「未启用」说明，而不是空白或静默跳回「通用」。

后端就绪后若在 `/api/auth/mode` 或 `/api/local/status` 里下发角色，可把探针换成读角色；`relay-status-store.ts` 的 `availability` 是唯一改动点。

## 三、各状态的表现

| 状态 | testId | 内容 |
|---|---|---|
| 探测中 / 首拉未回 | `settings-relay-tab-skeleton` | 三卡 + 表单 + 表格的骨架（按真实版式高度） |
| 角色缺席（404） | `settings-relay-tab-unavailable` | info Notice：「本机未启用中继角色。」+ 一行说明 |
| 未登录（401） | `settings-relay-tab-login` | warning Notice：「请先登录，再管理中继。」 |
| 一次都没拉到 | `settings-relay-tab-error` | error Notice（带原因）+「重试」按钮 |
| 正常 | `settings-relay-tab` | 见下 |
| 拉到过又失败 | 正文照旧 + `relay-refresh-error` | 一次网络抖动不抹掉已摆出的租户表 |

正常态的构成：
- 标题行 + 刷新按钮（`relay-refresh`，加载中转圈）。
- 头部三卡（`sm:2 列 / lg:3 列`）：
  - 健康 `relay-health-card`：状态徽标（正常 / 异常，health 拿不到为「未知」）、版本、已运行（天 / 时 / 分三档）；
  - 总量 `relay-totals-card`：租户、在线节点、并发流、发送 / 接收字节；
  - 口令 `relay-password-card`：已设置 / 未设置徽标、口令代次、最低令牌代次、「修改口令」按钮；未设置口令时多一条 warning：「未设置口令，任何人都能接入本中继。」
- 默认配额卡 `relay-default-quota-card`：节点数上限 / 并发流上限 / 带宽上限（KB/s）+「不限速」开关，保存按钮；服务端值变化时草稿自动重置（提交中不动）。
- 租户卡 `relay-tenants-card`：右上角总数；表 `relay-tenants-table`，`min-w-[62rem]` 放在 `overflow-x-auto` 里（移动端横向滚动，与 `nodes-table` 同一做法）。
  - 列：编号（前 12 位等宽 + 复制全量）、备注（就地编辑：点一下变输入框，回车 / 失焦提交，Esc 放弃）、接入时间、最近活跃（相对时间）、节点「在线 / 总数」、并发流、流量「↑发送｜↓接收」、生效配额（继承默认时带「默认」徽标）、令牌代次（被踢过带「已踢出」徽标）、动作。
  - 动作：编辑（对话框）、踢出（确认框）、删除（危险确认，需逐字敲出租户编号才解锁按钮）。正在写入的那一行动作禁用。
  - 空表出「还没有租户接入。」
- 改口令对话框 `relay-password-dialog`：「清除口令」开关（打开后隐藏口令输入框）、新口令（至少 8 字符，前端拦截）、「保留现有租户」/「作废旧令牌」二选一单选，**默认保留**；错误就地显示，成功 toast + 重拉。
- 租户编辑对话框 `relay-tenant-editor-dialog`：备注 + 「跟随默认」开关（打开时配额字段禁用，提交 `quota: null`）+ 配额三件套。
- 相对时间以 `loadedAt` 为基准（每 30 s 一拍推进），不逐秒重渲染。

## 四、i18n

新增 **101** 个 key，全在 `relay.admin.*` 下，三语（zh_CN 源 → en_US / ja_JP）同步；未碰其它命名空间，未占用 `relay.tenant.*`（F1 的地盘）。已跑 `bun run build:i18n`，`resources.ts` / `types.ts` / `locales/generated/*` 重新生成且与源同步（`packages/shared` 的 i18n 用例 7/7 通过）。

分组：`tabLabel` `title` `description` `unavailable` `unavailableHint` `loginRequired` `loadFailed`；
`health.*`（title/state/ok/down/unknown/version/uptime/uptimeDays/uptimeHours/uptimeMinutes）；
`totals.*`（title/tenants/nodesOnline/streams/inbound/outbound）；
`password.*`（title/state/set/unset/unsetWarning/epoch/minTokenEpoch/change/dialogTitle/dialogDescription/newPassword/newPasswordHint/clear/clearHint/modeLabel/modeKeep/modeKeepHint/modeKick/modeKickHint/tooShort/saved/failed）；
`quota.*`（title/description/maxNodes/maxStreams/bandwidth/unlimited/unlimitedValue/inherit/inheritBadge/summary/bandwidthValue/invalidNodes/invalidStreams/invalidBandwidth/saved/failed）；
`tenants.*`（title/total/empty/columns.{id,label,created,lastSeen,nodes,streams,traffic,quota,tokenEpoch,actions}/nodesValue/trafficValue/noLabel/kicked/edit/editTitle/label/labelPlaceholder/saved/failed/kick/kickTitle/kickText/kickDone/kickFailed/remove/removeTitle/removeText/removeConfirmLabel/removeMismatch/removeDone/removeFailed）；
`time.*`（never/justNow/minutes/hours/days）。

取消 / 保存 / 重试 / 刷新 / 复制沿用既有 `common.*` 与 `nodes.actions.*`，没有另起一份。

插值变量刻意避开 `count`（会触发 i18next 复数分支，需要 `_one`/`_other`），统一用 `n` / `nodes` / `streams` / `bandwidth` / `online` / `total` / `in` / `out` / `d` / `h` / `m` / `kb` / `message`。

**文案口径提醒**：`/Users/konata/code/tmex-copy-guidelines.md` 里「中继（Hub）」指的是旧的 hub 角色。本轮的 `relay` 是另一个东西，我在 `relay.admin.*` 里一律只写「中继」，未写「中继（Hub）」。若最终决定改叫别的（如「公共中继」），只需改 `relay.admin.*` 的这几处标题与说明。

## 五、验证

| 项 | 结果 |
|---|---|
| `cd apps/fe && bun test src/` | **1842 pass / 0 fail**（基线 1783，delta **+59**，全部是我的新用例） |
| `cd packages/api-client && bun test` | **198 pass / 0 fail**（基线 175，我 +13，F1 的 tenant-api +10） |
| `cd packages/shared && bun test src/i18n` | 7 pass / 0 fail |
| `bunx tsc --noEmit -p apps/fe` | 我的文件 0 错误（详见下方「非我方遗留」） |
| `bunx tsc --noEmit -p packages/api-client` | 我的文件 0 错误 |
| `bunx biome check <我的文件>` | 25 files，无问题 |
| `bun scripts/complexity/gate.ts` | 我的文件全部达标（最大 `tenant-table.tsx` 242 行，函数最长 < 120 行）；未往 allowlist 加任何条目 |
| `bun run build:i18n` | 生成物干净、可重复（连跑两次无新增 diff） |

`bun run lint`（biome + 复杂度门禁）当前**整仓不绿**，但失败项全部不是我的：
- biome：`packages/api-client/src/relay/tenant-api.ts` / `tenant-api.test.ts`（F1）、`apps/gateway/src/tmux-client/metadata*`（L1b）格式未过；
- 复杂度：`apps/gateway/src/mesh/forwarder.ts`、`apps/gateway/src/ws/canonical-feed-session.ts`、`packages/ws-client/src/canonical-state-client.ts`、`packages/ws-client/src/client.ts` 超限，以及 allowlist 里 `packages/ws-client/src/state-machine.ts` 已被删成死条目（L1b/L1c）；
- `tsc -p apps/fe` 的 8 条错误全在 `node-runtimes.ts` / `packages/terminal-ui` / `packages/ws-client`（L1c 迁移中）。

`tsc -p packages/api-client` 另有 3 处**改动前就存在**的错误（`client.test.ts`、`files-download.test.ts` 的 Bun 类型宽松处），与本任务无关。

验证过程中 L1b/L1c 的 ws-client / stores 迁移一度让 fe 全量用例无法导入（`state-machine`、`dispatchPaneHistory`），已等其收敛后重跑，上表数字是收敛后的。

## 六、需要指挥官处理

1. **后端契约需与我一致**（后端未落地，以下是我按 §1.7 补全的细节，若后端另有安排请回改 `admin-api.ts`）：
   - `GET /api/relay/status` 的 `totals` 字段定为 `{ tenants, nodesOnline, streams, bytesIn, bytesOut }`（§1.7 只写了「totals」）。
   - `RelayQuota.bandwidthBytesPerSec` 为 `null` 表示不限速；`RelayTenantSummary.quota` 为 `null` 表示跟随默认；`label` 为 `null` 表示无备注（`PATCH` 传 `null` 即清空）。
   - `RelayConfigSummary` 为 `{ hasPassword, passwordEpoch, minTokenEpoch, defaultQuota }`。
   - `createdAt` / `lastSeenAt` 为**毫秒时间戳**，`lastSeenAt` 可为 `null`。
   - `POST /api/relay/password` 即使 `password: null`（清除）也照发 `mode`。
   - 五个写接口的响应体前端不读，返回 `{ok:true}` 或 204 均可；**非 2xx 必须是 `{ error: { code, message } }`**。
   - `relay` 角色缺席时 `/api/relay/*` 必须回 **404**（不能是 403 / 401），门禁靠它。管理接口未登录 / 会话失效必须回 **401**。
2. **`LocalRole` 未加 `relay,node`**：`packages/api-client/src/local/types.ts` 的 `LocalRole` 仍是 `'standalone' | 'node' | 'hub,node'`，不在我的范围没动。B2/B3 落地后若 `/api/local/status` 会返回 `relay,node`，需要有人补这个联合类型（本任务不依赖它，门禁走探针）。
3. **`packages/api-client/src/index.ts` 是共享文件**：我只加了 `export * from './relay/admin-api';` 一行；F1 若也要从根 barrel 导出 tenant-api，合并时注意这一行。
4. **未跑 e2e**（按规则由指挥官跑）。设置页新增标签会影响标签条相关的 e2e：默认（非中继机）下标签数不变，探针只多一次 404 的 `GET /api/relay/status`。若 e2e 里有「未知路由一律 404 并断言无额外请求」之类的断言，需要留意这一条探针请求。
5. **未做截图核对**（文案规范要求新增面板在开发实例里截图确认换行 / 截断）。后端 `/api/relay/*` 尚不存在，起临时实例也拿不到数据；建议 B2 落地后由指挥官或后续任务补一次目测。
