# T6 结果：设置页「分享」标签 + 日志回放

## 交付

### 新增目录 `apps/fe/src/pages/settings/share/`

| 文件 | 作用 |
|---|---|
| `share-api.ts` | 设置页自带的 REST 客户端：`GET/PUT /api/share/settings`、`DELETE /api/share/:id`、`GET /api/share/:id/log?after&limit`；列表 / 终止 / 地址候选三族**复用 T4 的 `@tmex/api-client/share`** 并原样再导出（与该文件头注释的分工一致，不另抄一份端点串）。含查询键 `shareSettingsQueryKey`、`shareOriginsQueryKey`、`shareLogQueryKey(id)` 与路径构造 `shareResourcePath` / `shareLogPath`。 |
| `use-share-tab.ts` | 标签的数据与写操作：列表（`refetchInterval` 10 s，标签卸载/后台自动停）、设备名（复用 `['devices']` 缓存）、地址候选、分享设置；终止 / 删除 / 保存设置。 |
| `share-tab.tsx` | 三段式版式：进行中卡 → 历史卡 → 设置卡；两处二次确认；回放窗 `lazyChunk` 按需加载。 |
| `active-shares-table.tsx` | 进行中表：名称 / 终端 / 在线 / 创建 / 到期 / 地址 / 操作（复制链接、终止）。相对时间带绝对时间 tooltip，永久分享出「永久」。 |
| `history-table.tsx` | 历史表：名称 / 终端 / 结束（原因短标签 + 相对时间）/ 时长 / 日志大小 / 操作（回放、删除）。无日志时回放禁用。 |
| `share-confirms.tsx` | 终止与删除的二次确认（删除文案点明连日志一并删除）。 |
| `share-settings-card.tsx` / `share-settings-form.ts` | 设置表单：记录日志（开关）、保留天数（0 = 不清理）、单条上限（MB）、默认分享地址（自动 / 候选 / 自定义 URL）。草稿、校验、改动判定是纯函数。 |
| `share-format.ts` | 展示格式化：终端名、相对过去时间、剩余期限、结束原因、时长、日志大小、地址主机名。 |
| `table-parts.tsx` | 两张表共用的 `Th` / `Td` / 空状态行；滚动壳与钉列沿用 `../components/wide-table`。 |
| `replay-timeline.ts` | **纯**回放逻辑：建索引（按 pane 分流、记 checkpoint 下标、按输出字节排序）、`planReplaySeek`（往前接着播 / 往回从 checkpoint 重放 / `Infinity` 强制重建）、`collectReplayOps`（checkpoint→resize+write、连续输出合并、`in` 单独成标记）、倍速循环、进度时钟。 |
| `replay-decode.ts` | base64 → 字节、拼接、输入的可读渲染（`⏎ ⇥ ⌫ ⎋ ^X`，超长截断）。 |
| `use-replay-log.ts` | 日志分页加载：按 `after` 游标一页页取到 `nextAfter === null`，边取边交给上层；卸载 abort。 |
| `use-replay-terminal.ts` | 只读终端：`createTerminalController` + `FitAddon`，字体 / 配色取自 UI store，`disableStdin: true`，**不接 `onData`**。 |
| `use-replay-player.ts` | 播放机：rAF 推进（进度条 100 ms 一格，不逐帧重渲染）、跳转、倍速、pane 切换；把 ops 喂给终端，输入只进标记条。 |
| `replay-controls.tsx` | 播放 / 暂停、倍速（1x/2x/4x/8x）、进度条、`已播/总长`、多 pane 时的 pane 选择、输入标记条。 |
| `replay-viewer.tsx` | 回放对话框：错误 / 截断提示、终端挂载点、加载进度覆盖层、控制条。 |

### 范围外的最小改动（已尽量点状）

- `apps/fe/src/pages/SettingsPage.tsx`：`share` 进 `SettingsTab` 联合、`SETTINGS_TABS`、`TAB_CHUNK_LOADERS`、标签栏（`Share2` 图标，排在「多节点互联」右侧；有中继角色时顺序为 nodes → relay → share）、面板分派。
- `apps/fe/src/pages/settings/data-prefetch.ts`：悬停预取分享列表（`shareQueryKey()` + `listShares`，不给 staleTime，与其它实时状态一致），`PREFETCHABLE_TABS` 加 `share`。
- `apps/fe/src/pages/SettingsPage.test.tsx`、`apps/fe/src/pages/settings/relay/settings-tab-gating.test.tsx`、`apps/fe/src/pages/settings/data-prefetch.test.ts`：标签数 7 → 8、预热队列 6/7 → 7/8、顺序断言改成挨着「分享」；新增一条分享预取用例。
- `apps/fe/package.json` + `bun.lock`：新增 `ghostty-terminal: workspace:*`。fe 是隔离安装（`apps/fe/node_modules` 只有声明过的依赖），回放终端要直接建 `createTerminalController`，不声明就解析不到。`bun.lock` 顺带把陈旧的 `packages/app` 版本 1.1.22 → 1.1.33 同步了（安装自动写入，非手改）。
- 语言包 `settings.share.*`（72 个 key）+ `settings.tabGroup.share`，三语同步；只动了 `translation.settings` 子树，T4 的 `share.*` 与 T5 的 `shareAccess.*` 已复核仍在。未跑 `build:i18n`（由指挥官统一跑）。

## 测试与门禁

- `cd apps/fe && bun test src/pages/settings/share/` → **75 pass / 0 fail**（6 个文件：timeline 19、decode 9、api 10、format 18、settings-form 12、两张表的静态渲染 7）。
- `bun test src/pages/SettingsPage.test.tsx src/pages/settings/data-prefetch.test.ts src/pages/settings/relay/` → 全绿。
- `cd apps/fe && bun test src/` → 2544 pass / 1 fail；唯一失败是 `src/node/device-node-badges.test.tsx`（链路徽标 i18n，别的 agent 正在改），与本任务无关。
- `bunx tsc --noEmit -p apps/fe`：本任务文件 0 错。仓库当前还有别的 agent 在途的错误（`src/node/mesh-nodes.ts`、`settings/nodes/management/*`），不在本任务范围。
- `bunx biome check`（本任务文件，逐个文件传入）：0 问题。
- `bun scripts/complexity/gate.ts`：本任务文件 0 违规（`ShareTab` 曾 123 行超限，已把两个确认框拆到 `share-confirms.tsx`）。仓库其余违规均来自在途改动。

## 与契约的偏差 / 取舍

1. **端点客户端拆两处**：`share-api.ts` 不重复实现列表 / 终止 / 地址候选，改为再导出 T4 的实现（T4 文件头已写明这一分工）。设置页只有一个 import 面，但依赖 `@tmex/api-client/share` 的签名保持不变。
2. **`POST /api/share/:id/revoke` 的响应**按 T4 的封装取 `{ share }` 里的记录；本页拿到后统一 invalidate 列表，不做局部写缓存。
3. **回放的 `in` 条目**只在终端下方的标记条里展示（最近 12 条，控制字符转记号），绝不写回终端——与 §2.6 的语义一致。
4. **回放尺寸**由录像决定（checkpoint / resize 带的 cols·rows 逐条 `resize`）；录像没给尺寸时才退回 `FitAddon.fit()` 按容器算。
5. **分享标签常驻**（进 `SETTINGS_TABS`，参与空闲预热），不像中继那样按角色门禁——每台机器都能分享终端。回放窗（含 ghostty 终端）是这个标签内的二级 lazy chunk，预热不会把终端渲染器拖下来。
6. **日志分页**默认不带 `limit`，用服务端默认（2000 条 / 2 MiB）；50 MB 上限的录像最多 25 轮往返，边下边能看。

## 待确认 / 风险

- 后端未联调：`GET /api/share/settings`、`PUT`、`DELETE /api/share/:id`、`GET /api/share/:id/log` 的实际响应形状以 T1 实现为准；本页按 §2.2 写死。日志页假定 `entries` 按 `seq` 升序、跨页也升序（`buildReplayTimeline` 会自己取最早 / 最晚时间戳兜底，但 pane 内的事件顺序直接沿用到达顺序）。
- `ShareRecord.viewers` 只对 active 有意义，历史表不摆这一列。
- 回放的进度条上限随日志页到达而增长；正在播放时新页会自然接上，暂停时不主动前进。
- 未做浏览器实测（无后端接口）。指挥官联调时建议核对：多 pane 录像的默认 pane（按输出字节最多）、往回拖动后画面是否从 checkpoint 正确重建、以及长录像下 8x 快进的流畅度。
