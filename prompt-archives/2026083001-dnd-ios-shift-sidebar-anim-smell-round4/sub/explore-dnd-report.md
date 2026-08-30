# 拖拽诊断报告

## 结论

根因是 `collision.ts` 的当前 HEAD 逻辑把 active 自身从 `closestCenter` 候选中排除了。拖回原位置时，`overIndex` 无法回到 `activeIndex`，因此 `verticalListSortingStrategy` 不会让已位移的兄弟全部归位。

当前工作区已有未提交的局部修复：`collision.ts:86-91` 已尝试重新加入 active，但只覆盖了指针分支；键盘分支仍未加入 active。未修改任何文件。

## 1. 拖拽中布局与状态流

- `DeviceFoldersView` 从 `useDeviceFolders()` 得到服务端布局，计算隐式根节点，并在松手后调用 `applyDrop`：`apps/fe/src/pages/devices/device-folders-view.tsx:54-60`、`:89-93`。
- `DeviceFolderTree` 没有独立的“拖拽中顺序数组”。状态只有：
  - `activeId`
  - `overId`
  - `activeDrop`、`placeholder` 两个派生值  
  见 `packages/panels/src/device-folders/device-folder-tree.tsx:350-386`。
- `onDragStart` 设置 `activeId`；`onDragOver` 只复制 `event.over.id` 到 `overId`，没有 `arrayMove` 或布局更新：`device-folder-tree.tsx:472-483`。
- `DndContext` 先运行 `deviceFolderCollisionDetection`，取第一个 collision 作为内部 `over`；dnd-kit 在 `overId` 改变时才触发 `onDragOver`：`node_modules/@dnd-kit/core/dist/core.esm.js:2984-2992`、`:3244-3286`。
- `activeDrop = resolveDrop(activeId, overId, layout, implicit)`：`device-folder-tree.tsx:371-374`。
- 跨容器节点拖拽时，`previewPlaceholder` 返回目标容器和插入下标；原节点仍留在源容器，目标容器只渲染一个非 droppable 占位条：`folder-tree-model.ts:223-259`。
- `SortableContext` 的 `items` 仍是原始 `container.nodeIds`，占位条只出现在实际渲染序列中：`device-folder-tree.tsx:215-239`。同容器排序完全交给 `useSortable` 的 transform。

服务端层面的“乐观更新”只发生在 drop 提交后，`useDeviceFolders` 的 mutation `onMutate` 才写 query cache：`apps/fe/src/pages/devices/use-device-folders.ts:79-103`。历史提交 `db74fb28` 曾有 `previewDrop/previewLayout`，当前 HEAD 已改成占位条方案。

## 2. 命中区域与排序策略

droppable 来源：

- 节点：`DeviceFolderNodeShell` 的 `useSortable({ id: node:<id>, data: { containerId } })`，外壳覆盖整个节点分组：`draggable-item.tsx:38-47`、`:68-73`。
- 分组：`FolderSection` 的 `useSortable({ id: folder:<id>, data: { containerId: root } })`：`folder-section.tsx:85-110`。
- 分组头：`drop:<containerId>`。
- 空分组内容区：`dropin:<containerId>`。
- 整棵树根区域：`drop:root`。  
  `useDropZone` 注册 droppable：`drop-zone.ts:16-21`。

`collisionGroupIds` 当前先以 `rest = ids.filter(id !== activeId)` 排除 active，再按拖动对象分成 zones/items/containers/root：`folder-tree-model.ts:285-315`。

指针分支的命中顺序：

1. 对分组头、空内容区执行 `pointerWithin`。
2. 对分组本体和根树执行 `pointerWithin`，确定指针所在容器。
3. 在该容器的 `items` 中执行 `closestCenter`。
4. 没有兄弟时退回容器本体或根区域。  
   `collision.ts:70-91`。

`closestCenter` 比较的是 `collisionRect` 中心与 droppable rect 中心：`node_modules/@dnd-kit/core/dist/core.esm.js:325-350`。拖拽使用 `DragOverlay`，`snapCenterToCursor` 只负责让小型预览卡片跟随鼠标，不改变 collision 规则：`snap-to-cursor.ts:28-51`。

同容器使用 `verticalListSortingStrategy`：

- active 的 `overIndex` 越大，后续兄弟上移；
- active 的 `overIndex` 越小，前方兄弟下移；
- active 回到自身的 `activeIndex` 时，所有兄弟 transform 应为零。  
  `node_modules/@dnd-kit/sortable/dist/sortable.esm.js:205-274`。

## 3. 为什么拖回原位置失败

HEAD 原逻辑是：

```ts
const siblings = pick(groups.items).filter(
  (container) => containerIdOf(container) === containerId
);
```

当前工作区的未提交 diff 已改为 `pick([...groups.items, activeId])`，位置见 `collision.ts:86-91`。

以 A 初始 index 0 为例：

1. A 拖到 C，`overIndex = 2`，B/C 获得向上 transform。
2. A 返回原始槽位时，active 的 droppable 虽然存在，但被 collision 候选过滤掉。
3. `closestCenter` 只能返回 B，导致 `overIndex = 1`，永远无法得到 `overIndex = 0`。
4. `verticalListSortingStrategy` 仍认为 A 正在 B 位置，B 继续占据 A 的原槽位，兄弟不会完全恢复。

其他怀疑项判断：

- `resolveDrop(activeId, activeId)` 返回 `null` 是正确的：`folder-tree-model.ts:159-165`。它只影响 drop 语义，不应阻止 sortable 使用 `overIndex === activeIndex` 来恢复 transform。
- 占位条不是同容器问题：`previewPlaceholder` 在源容器与目标容器相同时返回 `null`：`folder-tree-model.ts:234-240`。占位条也不是 droppable。
- `over` 在 gap 内不变化是正常的：当前 item 命中不是 `pointerWithin`，而是静态 rect 的 `closestCenter`；gap 属于最近中心的 item。
- rect cache 不是此次同容器回退的根因。dnd-kit 默认对 droppable 使用 transform-agnostic rect：`core.esm.js:646-649`，这是 sortable transform 所需的基准位置。
- `arrayMove` 没有在设备分组页的 `onDragOver` 中使用。设备页只在 drop 时通过 `applyDrop` 提交；`arrayMove` 只出现在通用设备树排序代码：`packages/panels/src/device-tree/device-tree-dnd.tsx:36-44`。
- 当前未提交修复只修正了有指针的分支；无指针的键盘分支仍使用 `pick([...groups.zones, ...groups.items])`：`collision.ts:46-67`，active 仍被排除。

## 4. 测试覆盖

- `collision.test.ts:120-155` 覆盖兄弟 gap、跨容器 gap、根层 gap，以及静态 drop 后顺序。
- `collision.test.ts:158-212` 覆盖分组头、空分组、根区域、越界和键盘碰撞。
- 当前未提交 diff 新增 `collision.test.ts:160-169`，验证拖到 n3 后返回自身 rect，并验证跨容器时不会把源 active 当成目标容器兄弟。这正是所需回归测试的核心。
- `folder-tree-model.test.ts:142-148` 已覆盖 `resolveDrop(active, active) === null`；`:357-399` 覆盖 placeholder 派生；`:402-433` 覆盖占位条插入位置。但这些测试不涉及 sortable transform。
- `device-tree-dnd.test.ts:12-37` 只测通用 `arrayMove` drop；`:67-82` 只测通用 `pointerFirstCollisionDetection`，不调用设备分组 collision。
- `device-folders-view.test.tsx:134-229` 是静态 SSR，测节点/分组映射、顺序、把手和离线节点，不执行真实拖拽。
- 当前工作区相关四个测试文件结果：59 pass、0 fail。

建议补充：

```ts
expect(overId('node:n1', 205)).toBe('node:n3');
expect(overId('node:n1', 65)).toBe('node:n1');
```

并增加无指针键盘场景，确保键盘回到自身时也能得到 active id。

## 5. 最小修复建议

修改 `packages/panels/src/device-folders/collision.ts` 的 `deviceFolderCollisionDetection`：

1. 保留 `collisionGroupIds` 对 active 的基础排除。
2. 在已经确定 `containerId` 后，将 `String(args.active.id)` 加入 `closestCenter` 的 item 候选。
3. 继续按 `containerIdOf(container) === containerId` 过滤。

这样 active 只会在自己的源容器内参与排序；跨容器时仍不会进入目标容器 siblings，现有 placeholder 行为不变。

同时对键盘分支使用同样的 active-inclusive candidates，否则指针与键盘行为不一致。

配置判断：

- 保持 `verticalListSortingStrategy`；这是当前纵向列表的正确策略。换成 `rectSortingStrategy` 不能解决 active 被过滤的问题。
- 保留 `MeasuringStrategy.Always`，它对折叠展开和跨容器占位条有帮助：`device-folder-tree.tsx:472-478`。
- 但 `Always` 不等于每次 pointer move 都强制刷新；dnd-kit 默认 measuring frequency 是 `optimized`。若以后改为真实重排 DOM/`SortableContext.items`，应显式调用 `measureDroppableContainers` 或配置合适的数值 frequency。
- `DragOverlay` 存在时，active 源节点不使用 drag-source displacement，兄弟 transform 由 sorting strategy 计算；因此关键条件就是让 `overIndex` 能回到 `activeIndex`。