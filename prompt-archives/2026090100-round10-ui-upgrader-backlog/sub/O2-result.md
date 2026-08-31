# O2：设备卡片网格 DnD 避让过早（半径限制的碰撞判定）

## 背景

管理设备页的卡片网格用 `collisionDetection={closestCenter}`。`closestCenter` 只排序、不设距离上限，卡片被拖到网格外很远处时仍然一定会选出一个「最近」的兄弟，`rectSortingStrategy` 随即让整排卡片避让。需求是 iOS 桌面式手感：靠近了才让位。

## 设计

新增纯函数模块 `device-grid-collision.ts`，先按半径筛候选，再把剩下的交给 `closestCenter`。

### 半径取值

```ts
radius = max(96, hypot(collisionRect.width, collisionRect.height) / 2)
```

理由：

- 卡片一列最小 `24rem` = 384px，实测卡高约 160px，`gap-3` = 12px。半个对角线 ≈ 208px。
- 相邻卡片的中心间距为「卡片尺寸 + gap」：横向 396px、纵向 172px；半个间距分别是 198px / 86px，都小于 208px。也就是说**相邻卡片的正常交换点完全落在半径内，近距离行为与原来的 `closestCenter` 逐像素一致**，被砍掉的只有远处的误判。若只用固定 96px，横向邻居要拖到几乎完全覆盖才肯让位，反而比现状难用。
- 保留 96px 下限，兜住窄屏/小卡片（对角线一半小于 96px）的情况。

### 其他要点

- **被拖卡片自己永远留在候选里**：拖远时 over 命中的是它自己（兄弟归位），而不是 `over=null` 来回抖动。远处的候选集就是 `['c1']`，测试有断言。
- **键盘拖拽退回 `closestCenter`**：dnd-kit 对键盘 activator 事件 `getEventCoordinates` 返回 null（`core.cjs.development.js:2913/2974`），因此 `pointerCoordinates === null` 即键盘场景；此时碰撞矩形是一步步挪的，套半径会把候选清空导致按键完全没反馈，所以直接透传 `closestCenter(args)`。

## 改动文件

| 文件 | 说明 |
|---|---|
| `packages/panels/src/device-management/device-grid-collision.ts` | 新增。导出 `deviceGridCollisionDetection`、`deviceGridProximityRadius`、`DEVICE_GRID_MIN_PROXIMITY_RADIUS` |
| `packages/panels/src/device-management/device-grid-collision.test.ts` | 新增。11 个用例 |
| `packages/panels/src/device-management/device-grid.tsx` | 换掉 `closestCenter` 导入与 `DndContext` 的 `collisionDetection` |

未触碰 `packages/panels/src/device-folders/collision.ts`。

## 测试覆盖

用假矩形摆一个 2×2 网格（384×160、gap 12），对照组直接跑 dnd-kit 的 `closestCenter`：

- 半径：等于对角线一半；40×40 小卡片兜底为 96；半径大于横纵两个方向的半个间距。
- 拖远：右侧 +900px / 下方 +800px 时，`closestCenter` 分别误判成 c2 / c3，新判定返回自己；+1200/+1200 时候选集只有 `['c1']`。
- 拖近：压在 c3 / c2 上分别命中 c3 / c2；越过与 c3 的中点（±10px 两侧）行为与 `closestCenter` 完全一致；拖回原位 over 回到自己。
- 键盘（`pointerCoordinates=null`）：远处仍按 `closestCenter` 选 c2 / c3；近处结果与带指针时一致。

## 验证结果

| 项 | 结果 |
|---|---|
| `bun test`（packages/panels）改前 | 686 pass / 0 fail，59 文件 |
| `bun test`（packages/panels）改后 | 697 pass / 0 fail，60 文件 |
| `bun test src/device-management/` | 93 pass / 0 fail，8 文件 |
| `bunx tsc --noEmit -p .` | 无输出（0 error，与改前一致） |
| `bunx biome check <3 个改动文件>` | clean |

未跑 e2e、未起 dev server。
