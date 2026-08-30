# OD：设置页取数抖动 + 设备卡片文件根扫描（第七轮性能）

## 一、线索核对

三条线索**全部属实**，逐条复核如下。

### 1. 设置页在每个标签下都挂站点设置表单，并与侧栏抢同一个请求 —— 属实

- `apps/fe/src/pages/SettingsPage.tsx:94` 无条件调用 `useSiteSettingsForm()`，但只有 `general`（`:191`）与 `notifications`（`:197`）两个标签消费 `form`，其余五个标签（devicesAndFiles / nodes / ai / terminal / remoteAccess）用不到。
- `apps/fe/src/pages/settings/use-site-settings-form.ts:52-63` 里那次 `useQuery(['site-settings'])` 是无条件发起的 `GET /api/settings/site`。
- `apps/fe/src/components/page-layouts/components/sidebar-title.tsx:24-29` 在挂载时调 `useSiteStore.fetchSettings()`；改前 `packages/stores/src/site.ts` 的 `fetchSettings` 只有「已有缓存就返回」这一层保护，**没有在途去重**，所以首屏直接落在 `/settings` 时（侧栏与设置页同时挂载）确实会并发打出两次同端点 GET。

### 2. 保存站点设置后同一端点被重拉两次 —— 属实

`use-site-settings-form.ts:90-96` 的 `onSuccess` 用 `Promise.all` 同时跑 `invalidateQueries(['site-settings'])`（触发查询自身的 GET）与 `refreshSettings()`（store 经 `packages/api-client/src/site.ts:6-14` 再打一次 GET），两次请求打的是同一个 `/api/settings/site`。

### 3. 每张设备卡片各自订阅文件根 —— 属实

`device-grid.tsx:121-128` 一台设备一张卡片；改前 `device-card.tsx:270-276` 每张卡片各挂一次 `useQuery(['files','roots'])` 并各跑一次 `.some()`，即 O(设备数 × 根数) 的重复扫描 + 每张卡片一个 query observer。请求本身被 react-query 按 key 合并，重复的是订阅与派生扫描。

## 二、改动

### A. 站点设置取数收敛到 site store（问题 1、2）

`packages/stores/src/site.ts` 新增 `ensureFreshSettings`，三个入口语义分层：

| 入口 | 吃缓存 | 搭在途请求的车 | 用途 |
| --- | --- | --- | --- |
| `fetchSettings` | 是 | 是 | 侧栏引导 |
| `ensureFreshSettings` | 否 | 是 | 设置表单挂载 |
| `refreshSettings` | 否 | 否 | 保存成功 / S2C 失效后 |

`refreshSettings` 坚持另起一次请求是**正确性要求**，不是遗漏：它跑在 PATCH 成功或失效信号之后，若搭上变更之前发出的在途请求就会拿回旧数据。

- 单飞实现：一个 `inflight` promise，`.finally` 里按引用比对清空（后来的新请求不会被旧请求的收尾误清）。
- 原有的「请求代次」语义（旧响应不得覆盖新数据、本地改主题作废在途响应）**原样保留**，只是和单飞一起搬进了新模块。

`apps/fe/src/pages/settings/use-site-settings-form.ts`：

- 新增 `SiteSettingsFormOptions.enabled`，透传给 `useQuery` 的 `enabled`；`SettingsPage.tsx` 用 `TABS_USING_SITE_SETTINGS`（general / notifications）计算。
- 查询的 `queryFn` 改为 `() => ensureFreshSettings()`：数据仍然新鲜（不吃缓存），但与侧栏引导请求并发时共享同一次 GET；顺带让 store 与表单共用一份权威数据。
- `onSuccess` 改成「`refreshSettings()` 一次 + `setQueryData` 回填」，删掉 `invalidateQueries`。

**未保存草稿的语义**：改前草稿与语言预览控制器活在页级 `useSiteSettingsForm` 里，切到任何标签都不丢。因此这里**没有**把 hook 改成条件挂载（那会真的丢草稿，也违反 hooks 规则），而是保持 hook 常挂、只把网络请求按标签开关——草稿、语言实时预览、卸载回退全部与改前一致。

**顺带的 smell 收拾**：`createSiteStore` 加了单飞后 217 行 > 复杂度门禁 allowlist 记录的 201 行。把取数策略整体拆到新文件 `packages/stores/src/site-settings-loader.ts`（`createSiteSettingsLoader`：代次 + 单飞 + 提交），`createSiteStore` 反而降到约 145 行，门禁通过。

### B. 文件根查询上提到网格（问题 3）

- `device-grid.tsx` 新增 `useDeviceIdsWithRoots(offline)`：整个列表订阅一次 `['files','roots']`，`useMemo` 归并成 `Set<deviceId>`；条件与改前逐卡片一致（`runtime.features.filesUi && !offline`，`throwOnError: false`，同一个 query key 以便 `file-roots` 事件失效后开关立刻可用）。
- `hasRoots: boolean` 逐设备下发：`DeviceGrid` → `SortableDeviceCard` → `DeviceCardHost` → `DeviceCard`。`CardProps` 显式 `Omit<'hasRoots'>`，因为它逐设备不同，不能进那份「整列表共用、用于卡片 memo bail out」的 props。传下去的是布尔量，卡片的 `memo` 依然拦得住无关重渲染。
- `DeviceCard` / `DeviceCardHost` 的 `hasRoots?: boolean` 默认 `false`（两者都是 `packages/panels` 的对外导出，不能改成必填）。离线卡片沿用缓存里的目录、`filesUi` 关闭时不渲染文件开关，这两条行为都没变。

## 三、决策与取舍

1. **没有把表单查询改成读 store 缓存**。那样能省掉更多请求，但 `settings-events-init.tsx` 会在 S2C `site` 事件时 invalidate `['site-settings']`，而 store 的 `handleSettingsUpdate` 同时在重拉——若查询读缓存，两者竞速时草稿可能被回填成旧值。`ensureFreshSettings`（不吃缓存、只搭在途车）在所有路径下都拿不到过期数据。
2. **没有动 `scripts/complexity/allowlist.json`**。`createSiteStore` 实际已从 201 降到约 145 行，把记录值收紧是好卫生，但该文件是全仓共享、本轮多个 agent 并行改动，收紧留给收尾统一做。
3. **没有动 `sidebar-title.tsx`**：去重放在 store 里之后它无需改动。
4. **没有动 `packages/api-client/src/site.ts`**：`fetchSiteSettings` 原样可用。

## 四、效果

| 场景 | 改前 GET `/api/settings/site` | 改后 |
| --- | --- | --- |
| 首屏直接落在 `/settings`（通用标签） | 2（侧栏 + 表单并发） | 1（表单搭侧栏在途请求的车） |
| 打开设置页的非表单标签（如 AI / 终端 / 节点） | 1（表单无条件拉） | 0 |
| 保存站点设置 | 2（invalidate + store 重拉） | 1 |
| 多处并发调 `fetchSettings` | N | 1 |

设备页：文件根的 query observer 从「每台设备一个」降到整列表一个，`.some()` 的 O(设备 × 根) 扫描换成一次 `Set` 构建 + 每卡片 O(1) 查表。

## 五、验证

全部在 `/Users/konata/code/tmex-enhanced-wt-r7` 执行（worktree 内多 agent 并行，测试总数高于基线是别的 agent 同期新增用例所致；**失败数均为 0**）。

| 包 | 命令 | 结果 | 基线 |
| --- | --- | --- | --- |
| apps/fe | `bun test src/` | 895 pass / 0 fail | 883 / 0 |
| packages/stores | `bun test` | 357 pass / 0 fail | 334 / 0（本次 +5 新用例） |
| packages/panels | `bun test` | 647 pass / 0 fail | 629 / 0（本次 +3 新用例） |
| packages/api-client | `bun test` | 132 pass / 0 fail | 132 / 0 |

- `tsc --noEmit`：stores 1 个（`host-services.test.ts`，改前既有）、api-client 5 个（改前既有）、fe/panels 的报错全部落在 `packages/panels/src/agent/**`、`packages/ghostty-terminal/**`、`apps/fe/src/.../use-sidebar-agent-sessions.ts`——都是同 worktree 其它 agent 在途的改动，逐条 grep 确认**没有一条落在本任务改的文件上**。
- `bunx biome check <10 个改动文件>`：Checked 10 files，无问题。
- `bun scripts/complexity/gate.ts`：`complexity gate ok (1059 files, 8778 functions)`。（仓库根 `bun run lint` 的 `biome check .` 会在生成文件与其它 agent 的在途改动上报 263 处，属既有噪声，故按改动文件逐个跑 biome。）

新增用例：

- `packages/stores/src/site-refresh.test.ts`：并发 `fetchSettings` 只发一次请求；`ensureFreshSettings` 搭在途车；`ensureFreshSettings` 不吃缓存；`refreshSettings` 不搭车（保存后必须拿到变更后数据）；在途请求结束后不再被复用。
- `packages/panels/src/device-management/device-management-panel.test.tsx`：网格下发的文件根仍逐设备区分（只有配过目录的设备开关可用 / 一个都没配时全禁用 / 离线时沿用缓存里的目录）。
- `device-card.test.tsx` 的 `renderCard` 改为直接下发 `hasRoots`（原来往 query 缓存塞 roots），断言全部保留。

## 六、改动文件

- `apps/fe/src/pages/SettingsPage.tsx`
- `apps/fe/src/pages/settings/use-site-settings-form.ts`
- `packages/stores/src/site.ts`
- `packages/stores/src/site-settings-loader.ts`（新增）
- `packages/stores/src/site-refresh.test.ts`
- `packages/panels/src/device-management/device-grid.tsx`
- `packages/panels/src/device-management/device-card.tsx`
- `packages/panels/src/device-management/device-card-host.tsx`
- `packages/panels/src/device-management/device-card.test.tsx`
- `packages/panels/src/device-management/device-management-panel.test.tsx`
