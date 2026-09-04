# T4b 结果 — 中继运行指标 UI（Sparkline / StatTile / 指标 store / 紧凑磁贴 / 完整面板）

## 交付概览

1. **packages/ui 新原语**：`Sparkline`（内联 SVG，支持多线叠画、面积填充、tone、`ariaLabel`，几何计算全是可测纯函数）与 `StatTile`（`Card size="sm"` 版式，muted 大写标签 + `tabular-nums` 大数 + 单位 + 副行 + 折线槽位 + tone/loading/stale/hint）。两者经 `@tmex/ui/*` 通配导出直接可用（`@tmex/ui/sparkline`、`@tmex/ui/stat-tile`），无需改 `package.json`。
2. **指标 store**：`relay-metrics-store.ts`，与 `relay-status-store.ts` 同骨架（模块级 store + `useSyncExternalStore` + `startPollingLoop`），5 秒一拍，页面隐藏跳拍、卸载即停、单飞、鉴权切换期间不发请求。404/401 落 `unavailable`（整块隐藏），其余失败只记 `lastError` 且**保留上一份采样**（面板改摆「已过期」）。
3. **紧凑磁贴**：`RelayServiceMetrics` 实装（保留原签名，另加可选 `api`）：主排 4 格（在线节点 / 活跃流 / 吞吐带叠画折线 / 延迟）+ 瘦排 3 格（内存 / CPU / 运行时长）+ 「打开中继控制台 →」链接；首拉出骨架，失败出一行 muted 提示 + 重试。
4. **完整面板**：`RelayMetricsPanel` = 状态条（状态点 / 版本 / 运行时长 / 租户数）+ 12 格磁贴排 + 趋势卡（吞吐进出叠画、活跃流、事件循环延迟三张大图，各带峰谷标注与窗口长度）+ 接入节点表（在线优先，名称/短节点号、状态、延迟、活跃流、↑↓ 速率、重连、连接于）。已接入 `relay-tab.tsx`，取代 `RelayHealthCard` + `RelayTotalsCard`（两者已从 `relay-cards.tsx` 删除）；口令卡与默认配额卡改为 `lg:grid-cols-2` 并排，租户卡原样保留。
5. **格式化**：在 `relay-format.ts` 上追加 `formatBytesPerSec` / `formatFramesPerSec` / `formatDuration` / `formatMs` / `formatPercent` / `median`，全部带测试。
6. **i18n**：新增 `relay.metrics.*`（header / tiles / trends / members 四个子树），zh_CN、en_US、ja_JP 三语同步，已跑 `bun run build:i18n`。

## 文件清单

新增：
- `packages/ui/src/components/sparkline.tsx`、`sparkline.test.tsx`
- `packages/ui/src/components/stat-tile.tsx`、`stat-tile.test.tsx`
- `apps/fe/src/pages/settings/relay/relay-metrics-store.ts`、`relay-metrics-store.test.ts`
- `apps/fe/src/pages/settings/relay/relay-metrics-model.ts`（序列派生、成员统计与排序、告警档，纯函数）
- `apps/fe/src/pages/settings/relay/relay-metrics-tiles.tsx`（磁贴 + 紧凑排/完整排/骨架）
- `apps/fe/src/pages/settings/relay/relay-metrics-trends.tsx`
- `apps/fe/src/pages/settings/relay/relay-metrics-members.tsx`
- `apps/fe/src/pages/settings/relay/relay-metrics-panel.tsx`
- `apps/fe/src/pages/settings/relay/relay-metrics-fixture.ts`（仅测试引用）
- `apps/fe/src/pages/settings/relay/relay-metrics-ui.test.tsx`
- `apps/fe/src/pages/settings/nodes/relay/relay-service-metrics.test.tsx`

修改：
- `apps/fe/src/pages/settings/nodes/relay/relay-service-metrics.tsx`（桩 → 实装）
- `apps/fe/src/pages/settings/relay/relay-tab.tsx`、`relay-cards.tsx`、`relay-format.ts`、`relay-format.test.ts`、`relay-tab.test.tsx`
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`（只加 `relay.metrics` 子树）+ `bun run build:i18n` 的生成物

## 数据契约

后端的 `RelayAdminApi.metrics()` 在本轮收尾时已落地（`packages/api-client/src/relay/admin-api.ts:173`，签名 `metrics(opts?: { members?: boolean })`），store 已直接改用它——`defaultRelayMetricsApi = defaultRelayAdminApi`，测试用 `createRelayMetricsApi(client)` 注入假 client。本地 `RelayMetricsApi` 接口只声明 `metrics()` 一支，避免测试凑齐整套写操作。调用不传 `opts`，因此响应始终带 `members`。

## 设计要点

- **色彩**：`--chart-1..5` 在本仓只在 `[data-theme-chart-preset=*]` 下定义，而**没有任何地方设置该属性**，所以裸用 `var(--chart-1)` 会拿到空值。折线 tone 采用 `var(--chart-1,var(--primary))` 的回退写法，其余 tone 走确定存在的语义/调色板类（emerald / sky / amber / destructive / muted），明暗两套都成立；将来接上 chart preset 会自动生效。
- **纵轴**：一律零基线（速率、延迟都是非负量），空序列/全零改画一条虚线基线并打 `data-empty`，`sparklineScale` 收敛了所有除零分支；NaN 按 0 计以保持下标与时间轴对齐。
- **叠画**：多条线共用一套刻度（吞吐进出可直接比高度）。
- **告警档**：事件循环延迟 100/250 ms、RTT 150/400 ms、CPU 70/90% 三档，只染数值不染整块；未知值按正常算，不制造无谓的黄块。
- **稳定性**：所有数值 `tabular-nums`；stale 只降透明度不清空；相对时间以 `loadedAt` 为基准，中间不逐秒重渲染。

## 验证

| 项 | 基线 | 现在 |
|---|---|---|
| `packages/ui` `bun test` | 370 pass / 0 fail | **404 pass / 0 fail**（新增 34：sparkline 24、stat-tile 10） |
| `packages/ui` `bunx tsc --noEmit` | 0 | 0 |
| `apps/fe` 本任务目录 `bun test` | relay 目录 64 pass | **114 pass / 0 fail**（新增：metrics-store 9、metrics-ui 28、service-metrics 6、format +7、relay-tab +1） |
| `apps/fe` `bunx tsc --noEmit` | 0（本任务文件） | 本任务文件 0 错误 |
| biome | — | 触碰的文件全清（`bunx biome check` 无输出） |
| 复杂度门禁 | — | 本任务未新增任何违规条目 |

## 需要注意 / 遗留

- **并行 agent 的在途状态**：跑 `cd apps/fe && bun test src/` 当下会看到 `nodes/`（uplink、local-machine-card、nodes-tab、relay-ui）与 `settings-tab-gating.test.tsx` 的失败，原因是 T4a 正在改的模块暂时缺导出（`./relay-strip`、`./setup/standalone-relay-setup`、`SELECTABLE_ROLES`、`resetNodeSessionRecovery`）。这些**不在本任务范围**，且与本任务改动无关：本任务目录单独跑全绿。同理 `bunx tsc --noEmit -p apps/fe` 当下的 26 行错误全部落在 `nodes/uplink/**`，本任务文件 0 错误。
- **复杂度门禁当前失败**，5–6 条违规全部在 `apps/gateway/src/mesh/forwarder.ts`、`packages/shared/src/link/mux.ts`、`packages/panels/.../use-device-management-state.ts`、`packages/ui/.../sidebar-provider.tsx`（其他 agent 的在途改动），本任务新增文件一条都没上榜。
- **`RelayServiceMetrics` 的 `publicUrl` / `hasPassword`**：按要求保留在 props 类型里，但紧凑指标区本身不需要它们（地址与口令状态由本机卡片其余部分呈现），因此未使用。若 T4a 希望在指标区里也提示「口令未设置」，加一行即可。
- **未做浏览器截图核对**：按公共规则未起临时实例、未跑 Playwright。文案换行/截断建议在本轮合并后于开发实例里再核一次（尤其 zh_CN 的「事件循环」「运行时长」磁贴与趋势卡的峰谷标注在窄屏下的表现）。
- `relay.admin.totals.*` 与 `relay.admin.health.state/ok/down/unknown/version/uptime` 中的部分 key 随两张卡删除而不再被引用（`uptimeText` 仍用 `uptimeDays/Hours/Minutes`）。未清理，以免与并行 agent 的 locale 编辑打架。

---

# R4 代码审查修正（第二轮）

四条意见全部落地，验证口径与上文一致。

## 1. `RelayTab` 注入的 api 没有传给指标面板

`RelayTab({ api })` 原本只喂给状态与写操作，`RelayMetricsPanel` 仍走 `defaultRelayAdminApi`——多实例宿主与测试都会绕过注入的 transport。

- `relay-tab.tsx`：`RelayTabBody` 新增 `api: RelayAdminApi` 形参，`<RelayMetricsPanel api={api} />`。
- 测试（`relay-tab.test.tsx` 新增 `RelayTab 的 api 注入`）：
  - `refreshRelayMetrics(injectedApi)` 只打注入的 transport，且期间把 `globalThis.fetch` 换成必抛的桩，断言**一次都没逃逸到默认 client**；
  - `new RelayAdminApi(client).metrics()` 只命中 `/api/relay/metrics`；
  - 接线本身用源码断言钉住（`<RelayMetricsPanel api={api} />`）。**这一条是妥协**：仓库没有 DOM 测试环境，`renderToStaticMarkup` 不跑 effect，面板实际发出的请求在测试里观察不到。先试过 `mock.module` 做透传记录壳，会让 `bun test` 挂死（模块注册表重入），已回退；源码断言与 `core-coverage.test.tsx` 解析源码的做法同源，不脆弱但也确实只是结构守卫。

## 2. 401/404 之后仍在每 5 秒空转 + 隐藏页仍打首拍

- `relay-metrics-store.ts`：`unavailable: boolean` 换成显式的 `availability: 'unknown' | 'available' | 'unavailable' | 'unauthorized'`，导出 `isRelayMetricsHalted()`。终态下 `refreshRelayMetrics` 直接返回；`useRelayMetrics` 的轮询 effect 把 `halted` 放进依赖，一旦落终态，清理函数就归还并停掉那条回路。
- 重探：导出 `probeRelayMetrics()`，在 hook 的挂载 effect 里调用（另外「重试」按钮也会先重探）。挂载即信号——紧凑区只在本机是 relay 角色时渲染，中继标签本身受 `relay-status-store` 门禁，登录成功后两处都会重新挂载，因此不必另接事件源。
- `create-polling-store.ts`：新增 `PollingLoopSpec.deferFirstRefreshWhenHidden`（**缺省 false**，且只在 `intervalMs > 0` 时生效，纯事件驱动的回路不受影响），只有指标 store 打开它。其余 store（mesh-nodes / mesh-hubs / relay-admin）行为逐字节不变，`apps/fe/src/node/` 下 410 个用例全绿。
- 测试：终态后不再发请求 + 重探后恢复；`isRelayMetricsHalted` / `probeRelayMetrics` 语义；隐藏时首拍与兜底拍都不打；回到前台补一拍并恢复节奏；归还后定时器不再触发。轮询用例改走 `withPolling(...)` 帮手，归还写在 `finally` 里——回路是模块级单例，一次泄漏的引用计数会让后面每个用例都拿不到新回路（上一版就踩到了）。

## 3. 窄屏磁贴读数被截断

- 紧凑主排：`grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`（原 `grid-cols-2 lg:grid-cols-4`）。
- 紧凑瘦排：`grid-cols-2 sm:grid-cols-3`（原固定三列）。
- 完整排：`grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6`（原 `grid-cols-2 …`）。
- 骨架排同步成 `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`，免得数据到位时高度跳变。
- 测试：`磁贴排 > 响应式栅格` 与 `RelayServiceMetrics > 窄屏栅格` 静态断言这几组类名（无浏览器环境，只能断言类集合）。

## 4. 累计中转流量丢了

旧 `RelayTotalsCard` 摆的是累计量，新的十二格全是瞬时速率，`totals.bytesIn/bytesOut` 一个都没读。

- 新增 `TrafficTile`，沿用旧卡的**单侧口径**（中继每转发一帧同时计进收发两侧，两个计数逐字节相等，只出一个数 → `trafficText(totals.bytesOut)`，即 `relay-format.ts` 里那个 `formatBytes` 包装）。完整排现在是十三格。
- 紧凑区没有单独格子，累计量改挂在吞吐格副行：`ThroughputTile` 新增 `showTotal`，副行从「↑ 出 · ↓ 入」换成「累计 {{total}}」。
- 新 i18n key（三语）：`relay.metrics.tiles.traffic` / `trafficSub` / `trafficHint` / `throughputTotal`。

## 本轮验证

| 项 | 结果 |
|---|---|
| `cd apps/fe && bun test src/` | **2272 pass / 0 fail**（130 文件；上一轮报告里 `nodes/**` 的失败是并行 agent 的在途状态，现已随其收尾消失） |
| `cd apps/fe && bunx tsc --noEmit -p .` | **0**（全仓，不只本任务文件） |
| `cd packages/ui && bun test` | **412 pass / 0 fail**；tsc 0 |
| `cd packages/shared && bun test src/i18n` | 7 pass / 0 fail |
| biome（本轮触碰的 34 个文件） | 全清 |
| `bun scripts/complexity/gate.ts` | **complexity gate ok**（1516 文件 / 13569 函数，零违规） |

## 一处需要记一笔的意外

改 i18n 时脚本的行匹配把 `relay.admin.totals.traffic`（`"traffic": "中转流量"`，与新加的 `relay.metrics.tiles.traffic` 同名同缩进）从 zh_CN 误删了一次，已在同一轮内还原并加断言复核；`git diff` 现在对三个 locale 都只有 4 行纯新增，`relay.admin.totals.traffic` 完好。其余 locale 未受影响。
