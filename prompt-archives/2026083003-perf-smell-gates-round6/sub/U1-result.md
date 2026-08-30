# U1 执行结果：panels / stores / fe 小型 code smell（S2 findings 2–5）

## 做了什么

### 1. 分组树：容器模型只建一次 + 隐式判定改 Set（S2 finding 2）

- `folder-tree-model.ts`：`resolveDrop` / `previewPlaceholder` 各加一个尾参
  `containers: Map<string, DeviceFolderContainer> = listContainers(layout, implicit)`。默认值保持既有调用方
  （测试、`collision.test.ts`）零改动；`resolveDrop` 内部那次 `listContainers` 删掉，落点判定分支**一行未动**（CC 仍 19）。
- `device-folder-tree.tsx`：`activeDrop`、`placeholder`、`handleDragEnd` 三处都把已 memo 的 `containers` 传进去，
  并把 `containers` 加进各自的依赖数组（它本身只随 `layout` / `implicitRootNodeIds` 变，语义等价）。
  一次拖拽帧从「3 次容器模型构建」降到 1 次。
- `NodeItem` 的 `layout.placements.some(...)`（O(nodes × placements)）换成 context 里 memo 好的
  `placedNodeIds: ReadonlySet<string>`；`TreeContextValue.layout` 随之被 `placedNodeIds` 取代
  （`layout` 在 context 里只有这一个消费者）。

`resolveDrop` 的默认参数会在省略 `containers` 时**先于分组分支求值**，即拖分组时也会建一次模型；
组件路径永远显式传参，只有测试会走默认值，不影响运行时。

### 2. 设备重排乐观更新去重（S2 finding 3）

新增 `packages/panels/src/device-tree/device-reorder.ts` 的 `reorderDevicesOptimistically`，
侧栏 (`sidebar-device-list.tsx`) 与设备管理 (`use-device-management-state.ts`) 两个 `onMutate` 共用。
严格保持原语义：

- `sortOrder` 取该 id 在 `deviceIds` 里的**下标**（未知 id 会在序号上留空档，和改之前一致）；
- 未知 id 丢弃、不在请求列表里的设备保持原相对顺序追加在后；
- 原来的 `previous.devices.filter((d) => !deviceIds.includes(d.id))`（O(n×m)）换成 `Set`。

两处的 rollback / `onError` / `onSuccess` / `onSettled` 行为完全未动。

### 3. `createTmuxStore` 的 `reorderById`（S2 finding 4）

`packages/stores/src/tmux.ts` 抽出模块级泛型 `reorderById<T extends { id: string }>`，
`reorderWindows` 与 `reorderPanes` 共用；未知 id 丢弃、剩余项保持原顺序的语义不变，
`reorderPanes` 里的 window map 顺手收成一行三元。

### 4. 删除死导出 `loginRoute`（S2 finding 5）

`apps/fe/src/pages/LoginPage.tsx` 末尾 4 行导出 + 注释删除；全仓 `rg loginRoute` 无其他引用，
运行时路由走 `apps/fe/src/main.tsx` 的 `loginModule`。

## 文件清单

改：
- `/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/device-folders/folder-tree-model.ts`
- `/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/device-folders/device-folder-tree.tsx`
- `/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/device-folders/folder-tree-model.test.ts`
- `/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/device-management/use-device-management-state.ts`
- `/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/device-tree/sidebar-device-list.tsx`
- `/Users/konata/code/tmex-enhanced-wt-r6/packages/stores/src/tmux.ts`
- `/Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/pages/LoginPage.tsx`

新增：
- `/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/device-tree/device-reorder.ts`（16 行）
- `/Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/device-tree/device-reorder.test.ts`（61 行，5 个用例）

## 行数变化（`git diff --numstat`，不含测试）

| 文件 | +/− |
|---|---|
| `LoginPage.tsx` | 0 / −6 |
| `device-folder-tree.tsx` | +19 / −11 |
| `folder-tree-model.ts` | +5 / −4 |
| `use-device-management-state.ts` | +3 / −6 |
| `sidebar-device-list.tsx` | +4 / −9 |
| `tmux.ts` | +13 / −13 |
| 新增 `device-reorder.ts` | +16 |

实现代码净 **+11 行**（测试另计 +109）。诚实说明：净负没做到。原因是两项改动天然带 boilerplate——
共享 helper 是新文件（签名 + 文档注释 + 两处 import 共约 +19 行，换掉两处共 18 行重复实现），
`placedNodeIds` 的 memo 是 4 行、`resolveDrop` 多参后被 biome 折成多行。
没有为了把数字做成负数去搬运代码（那正是本轮明令禁止的）。

## 复杂度门禁（`bun scripts/complexity/gate.ts`）

改前 → 改后（只列我碰到的函数）：

| 函数 | CC | 行数 |
|---|---|---|
| `folder-tree-model.ts:resolveDrop` | 19 → 19（未动落点逻辑） | 57 → 58 |
| `device-folder-tree.tsx:DeviceFolderTree` | — | 233 → 240 |
| `use-device-management-state.ts:useDeviceManagementState` | — | 126 → **122** |
| `sidebar-device-list.tsx:SideBarDeviceList` | — | 267 → **261** |
| `stores/src/tmux.ts:createTmuxStore` | — | 363 → **355** |
| `LoginPage.tsx` 文件 | — | 297 → 291 |

全仓统计：`files 1048 → 1049, functions 8678 → 8679, CC>15: 46 → 46, >120 lines: 76 → 76`
（其余数字受同 worktree 其他 agent 影响，非本任务引入）。

**遗留**：`useDeviceManagementState` 122 行，仍比 120 的阈值多 2 行——S2 预测「本项改动可消除该违规」没兑现。
要真正消掉只能再拆一刀（例如把首屏 stagger 入场那 30 行抽成 `useStaggeredEntrance`，这确实是一个独立关注点），
但那超出本任务的 item 边界；建议要么由本轮的 allowlist 项统一收口，要么单开一条。
`DeviceFolderTree` 240 行、`SideBarDeviceList` 261 行本来就在 S2 的 allowlist 建议清单里。

## 测量（`/private/tmp/.../scratchpad/u1-bench.ts`，Bun，100 分组 / 1000 placement / 1000 隐式节点 / 2000 设备）

| 场景 | 改前 | 改后 | 倍数 |
|---|---|---|---|
| 一帧拖拽（memo 构建 + `resolveDrop` + `previewPlaceholder`）×300 | 158.96 ms | 52.11 ms | 3.05× |
| 一屏节点的 implicit 判定（`.some` vs memo Set）×200 | 1093.52 ms | 8.88 ms | 123× |
| 设备重排乐观更新（`includes` vs `Set`）×1000 | 2646.99 ms | 165.07 ms | 16.0× |

bench 里对 2000 设备 / 1000 id 做了新旧实现的 `JSON.stringify` 全等断言，确认结果逐字段一致。
`reorderById` 未单独测：算法与原内联实现逐行等价（S2 已测约 14.3 µs/次），没有可观测的性能差。

## 验证

- `packages/panels`：`bun test` **625 pass / 0 fail**（含新增 8 个用例）；`bunx tsc --noEmit -p .` **0 error**。
- `packages/stores`：`bun test` **334 pass / 0 fail**；`tsc` **1 error**（`src/host-services.test.ts(93,23)`，本轮既有基线）。
- `apps/fe`：`bun test src/` **880 pass / 0 fail**；`tsc` **0 error**。
- `bunx biome check <改动文件>`：9 个文件全部通过（`sidebar-device-list.tsx` 的 import 顺序用 `--write` 修过）。

测试数比基线（panels 580 / stores 321 / fe 866）高，是同 worktree 其他 agent 并行新增的用例，全部 0 fail。

## 风险

- 传入的 `containers` 必须与 `layout` / `implicitRootNodeIds` 同源：组件里三处调用都用同一个 memo，依赖数组已带上
  `containers`；新增的 `folder-tree-model.test.ts` 里有一条用例特意传入「少了隐式节点的模型」，断言
  `resolveDrop` 确实按传入模型定位节点（防止将来把参数退化成摆设）。
- `placedNodeIds` 依赖 `layout.placements` 的引用；宿主每次都重建 layout 对象时行为与改前相同（都会重算）。
