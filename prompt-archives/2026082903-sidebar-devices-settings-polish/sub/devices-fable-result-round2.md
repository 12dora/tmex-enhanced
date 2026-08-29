# 设备管理页重做 —— Code review round 1 修复结果

worktree `/Users/konata/code/tmex-enhanced-wt-merge`，未执行任何改变 git 状态的命令。

## MUST FIX

1. **迁移 0025 顺序冲突**（`apps/gateway/drizzle/0025_flat_device_groups.sql`）
   - 先删设备 placement；再用递归 CTE 按旧树前序（根层 sort_order → 子级 sort_order，同序按 created_at、id 兜底；父级不存在的孤儿视为根；深度上限 64，游离/成环节点排在最后）计算 `row_number()`，一条 `WITH … UPDATE` 把 `parent_id` 置空并重编号为 0..n-1；节点 placement 按 `folder_id` 分区重编号（sort_order, created_at, item_key）。
   - 新增 `apps/gateway/src/db/flat-device-groups.migration.test.ts`：内存库按 statement-breakpoint 逐条执行 0000..0024（与 migrator 一致），塞入重叠 sort_order 的嵌套分组 + 设备 placement，单独跑 0025，断言 parent_id 全空、顺序唯一且稳定（含孤儿/同序）、节点 placement 保留并按容器重编号、设备 placement 删除、重复执行幂等。
2. **分组拖到分组头失败 / 键盘落点**（`folder-tree-model.ts`、`device-folder-tree.tsx`）
   - `resolveDrop`：分组落在别的分组头 `drop:folder:*` 上等同落在分组元素上（插到其位置）；`dropin:`（内容区）与自己头上仍无效。
   - 新增 `collisionCandidateIds(activeId, ids)`：拖分组只看 `folder:*`、`drop:folder:*`、`drop:root`；拖节点只看 `node:*` 与全部放置区。`collisionDetection` 先按此过滤再走 pointerWithin / closestCenter，键盘排序的 `over` 同样经此过滤。
   - 测试：分组-over-分组头解析、候选过滤、候选中每个 id 对分组拖动要么合法要么被明确拒绝（不会落到节点上）。
3. **离线残留 connecting/reconnecting 导致无法手动连接**（`device-card-connect-toggle.tsx`）
   - `displayedConnectionStatus(status, offline, attemptedWhileOffline)`：离线且用户未在掉线后发起过尝试 → 一律 `disconnected`（按钮可点）；发起过 → connecting/error/reconnecting 照常，`connected` 仍视为断开。组件内用 `attemptedWhileOffline` 状态记录，节点恢复在线时复位。测试更新（离线残留 `connecting` 也渲染成可点的「连接」）。
4. **8s 超时只摘 pending、按钮永久禁用**（`device-connection-status.ts`、`global-device-provider.tsx`）
   - `pendingSettlementPlan` 返回 `{ delay, action: 'settle' | 'timeout' }`；纯函数 `runPendingSettlement(pending, snapshot, now, { settle, timeoutConnect, schedule })` 负责排定/取消；provider 在 connect 超时时调用 `hydrateDeviceErrors([{ lastErrorType: 'timeout', lastError: t('device.connectTimeout') }])` 记一个可重试的错误 → 状态变 `error`、按钮回到「连接」，状态徽标显示 timeout；网关之后真连上会由 `device-connected` 事件清掉。
   - 新增 i18n `device.connectTimeout`（zh/en/ja）。测试用注入的假调度器覆盖「8s 没回音 → 记超时 + 摘 pending → 状态 error/可重连」、cleanup 取消定时器、disconnect 超时不记错。
5. **reset 与其它布局变更并发**（`use-device-folders.ts`、`page-commands.ts`、`DevicesPage.tsx`）
   - 单一 `layoutBusy = !ready || replace/create/rename/delete/reset 任一 isPending`；所有变更入口（含 submitLayout、reset）在 busy 时拒绝；`pending`（拖拽禁用）也改为 layoutBusy。reset `onSettled` 无论成败 invalidate + refetch。
   - `DevicesPageCommands` 增加 `layoutBusy`，顶栏「恢复默认布局」按钮据此 `disabled`；测试覆盖禁用态。
6. **快照清理与上限**（`device-snapshot-store.ts`）
   - 索引键 `tmex:device-snapshot-index`（nodeId → updatedAt），`MAX_SNAPSHOTS = 32`，超限按 updatedAt 淘汰最旧；`setItem` 抛错（配额）时淘汰最旧一条重试一次，仍失败则不写索引；`pruneDeviceSnapshots(keepNodeIds)` 删除不在列表里的节点快照；`clearDeviceSnapshot` 同步索引。
   - `DevicesBody` 在 mesh 节点列表落定（`loadedAt !== null`；standalone 立即）后按当前 groups 的 runtimeNodeId 调用 prune。测试覆盖 prune、LRU 封顶、配额重试、重试失败。

## SHOULD FIX

7. `DeviceCardHost` 在 `offline` 变真时关闭编辑/删除对话框；面板关闭新建对话框；`DeviceDialog` 新增 `offline` 透传到 `useDeviceDialogSubmit`，提交时再检查一次（离线直接 toast 拒绝）。
8. `handleDragEnd` 在 `offline || reorderPending` 时直接返回。
9. 新增 `packages/api-client/src/device-folders.test.ts`（StubApiClient）：reset 成功返回布局、服务端 error 字段 / fallback 两种失败。

## 验证

| 包 | bun test | tsc |
|---|---|---|
| packages/shared | 358 pass / 0 fail | 0 |
| packages/panels | 466 pass / 0 fail | 0 |
| packages/api-client | 132 pass / 0 fail | 5（既有，未改动文件） |
| packages/stores | 282 pass / 0 fail | 1（既有） |
| apps/gateway | 2482 pass / 0 fail | 21（=基线） |
| apps/fe（`bun test src/`） | 628 pass / 0 fail | 0 |

改动源文件已 `bunx biome check --write`；`resources.ts` / `types.ts` 由 `bun run build:i18n` 重新生成。

## 本轮改动文件

- gateway：`drizzle/0025_flat_device_groups.sql`，新增 `src/db/flat-device-groups.migration.test.ts`
- panels：`device-folders/{folder-tree-model,device-folder-tree,index}.ts(x)`（+model test）、`device-management/{device-card-connect-toggle,device-card-host,device-dialog,use-device-dialog-submit,device-management-panel}.tsx`（+toggle/card tests）
- fe：`components/{device-connection-status,global-device-provider}.ts(x)`（+status test）、`pages/devices/{use-device-folders,page-commands,device-folders-view,device-snapshot-store}.ts(x)`（+tests）、`pages/DevicesPage.tsx`（+test）
- api-client：新增 `src/device-folders.test.ts`
- shared：三份 locale JSON 加 `device.connectTimeout`

## 未做
DeviceManagementPanel 行为级测试与 NodeRuntimeScope 挂载生命周期测试（按指示跳过）。
