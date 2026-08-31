# EX1：Frontend geometry exploration 报告

范围：只读检查，未修改任何文件。以下几何均以桌面端 `md` 布局、`1rem = 16px` 为基准。

## 1. 左侧栏底部「接入设备 / 管理设备」按钮组

### 责任链

- 页面布局：[`app-sidebar.tsx:175`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:175)
- 底部容器：[`app-sidebar.tsx:242`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:242)
- 按钮组组件：[`nav-main.tsx:51`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/nav-main.tsx:51)
- Sidebar 基础容器：[`sidebar-layout.tsx:106`](/Users/konata/code/tmex-enhanced-wt-r10/packages/ui/src/components/sidebar/sidebar-layout.tsx:106)
- 右侧外框：[`sidebar-layout.tsx:248`](/Users/konata/code/tmex-enhanced-wt-r10/packages/ui/src/components/sidebar/sidebar-layout.tsx:248)
- 右侧内层终端面板：[`page-wrapper.tsx:75`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/page-wrapper.tsx:75)

当前结构：

```tsx
<Sidebar variant="inset">
  ...
  <SidebarFooter>
    <NavMain items={footerItems} />
    <div className="h-[var(--tmex-safe-area-bottom)]" />
  </SidebarFooter>
</Sidebar>
```

对应代码见 [`app-sidebar.tsx:242`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:242)。

### 当前尺寸

| 层级 | 当前值 | 来源 |
|---|---:|---|
| Sidebar 外层桌面 inset | `p-2` = 8px | [`sidebar-layout.tsx:109`](/Users/konata/code/tmex-enhanced-wt-r10/packages/ui/src/components/sidebar/sidebar-layout.tsx:109) |
| `SidebarFooter` 内边距 | `p-2` = 8px | [`sidebar-primitives.tsx:36`](/Users/konata/code/tmex-enhanced-wt-r10/packages/ui/src/components/sidebar/sidebar-primitives.tsx:36) |
| Footer 子元素间距 | `gap-2` = 8px | 同上 |
| `NavMain` 的 `SidebarGroup` 内边距 | `p-2` = 8px | [`sidebar-primitives.tsx:72`](/Users/konata/code/tmex-enhanced-wt-r10/packages/ui/src/components/sidebar/sidebar-primitives.tsx:72) |
| 两个按钮之间 | `gap-1` = 4px | [`nav-main.tsx:58`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/nav-main.tsx:58) |
| 按钮默认高度 | `h-8` = 32px | [`sidebar-menu.tsx:43`](/Users/konata/code/tmex-enhanced-wt-r10/packages/ui/src/components/sidebar/sidebar-menu.tsx:43) |
| 按钮基础 padding | `p-2` | [`sidebar-menu.tsx:34`](/Users/konata/code/tmex-enhanced-wt-r10/packages/ui/src/components/sidebar/sidebar-menu.tsx:34) |
| 按钮显式横向 padding | `px-1.5` | [`nav-main.tsx:75`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/nav-main.tsx:75) |
| 安全区占位 | `var(--tmex-safe-area-bottom)` | [`app-sidebar.tsx:244`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:244) |

### 外框对齐目标

右侧外层黑框是 `SidebarInset`：

```tsx
md:m-2 md:ml-0 ... flex ...
```

[`sidebar-layout.tsx:248`](/Users/konata/code/tmex-enhanced-wt-r10/packages/ui/src/components/sidebar/sidebar-layout.tsx:248)

同时桌面端高度为：

```tsx
md:h-[calc(100dvh-1rem)]
```

[`main.tsx:219`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/main.tsx:219)

因此：

- 外层黑框顶部：距离视口顶部 8px
- 外层黑框底部：距离视口底部 8px
- 对齐目标：`100dvh - 8px`

右侧内层终端面板的底部还受 `md:p-4` 影响，距离外框底部约 16px：

```tsx
<div className="... !pt-0 p-2 md:p-4">
```

[`page-wrapper.tsx:75`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/page-wrapper.tsx:75)

所以按钮组当前距离外层黑框底部约为：

```text
Footer pb 8px
+ Footer 与安全区占位 gap 8px
+ SidebarGroup pb 8px
= 24px
```

桌面安全区为 0；移动端还要额外加安全区高度。

### 根因

按钮组不是被某一个固定高度推高，而是被三层垂直空间共同抬高：

1. `SidebarFooter` 的 `p-2`
2. `SidebarFooter` 的 `gap-2`
3. `SidebarGroup` 的 `p-2`

### 最小修改建议

建议修改以下三处：

```tsx
// app-sidebar.tsx
<SidebarFooter className="gap-0 px-2 py-0">
```

位置：[`app-sidebar.tsx:242`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:242)

```tsx
// nav-main.tsx
<SidebarGroup className="px-2 py-0">
```

位置：[`nav-main.tsx:56`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/nav-main.tsx:56)

```tsx
<SidebarMenu className="flex-row gap-0.5 group-data-[collapsible=icon]:flex-col">
```

位置：[`nav-main.tsx:58`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/nav-main.tsx:58)

按钮建议压缩为：

```tsx
<SidebarMenuButton
  size="sm"
  className="justify-center gap-1 px-1.5 py-1 text-xs"
>
```

位置：[`nav-main.tsx:70`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/nav-main.tsx:70)

效果：

- 默认按钮高度：32px → 28px
- 按钮间距：4px → 2px
- Footer 和 Group 的垂直 padding 清零
- 按钮组桌面端下缘与 Sidebar 内层、右侧外框下缘对齐
- 保留横向 `px-2`，不会明显改变按钮左右位置
- 移动端仍保留安全区占位

## 2. 左侧栏顶部 Tab 切换器

### 责任链

- Sidebar Header 与 Tab：[`app-sidebar.tsx:177`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:177)
- Tab 容器：[`app-sidebar.tsx:179`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:179)
- Tab 列表 padding：[`app-sidebar.tsx:184`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:184)
- Tabs 基础布局：[`tabs.tsx:16`](/Users/konata/code/tmex-enhanced-wt-r10/packages/ui/src/components/tabs.tsx:16)
- Sidebar 标题行：[`sidebar-title.tsx:27`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/sidebar-title.tsx:27)

当前代码：

```tsx
<SidebarHeader className="gap-5 pt-3 pb-0">
  <SidebarTitle />
  <Tabs className="mb-2.5">
```

[`app-sidebar.tsx:177`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:177)

### 当前几何

相对于右侧外框顶部：

```text
Sidebar 外层 inset       8px
SidebarHeader pt-3       12px
SidebarTitle             32px
Header gap-5             20px
--------------------------------
TabsList 外框             64px
```

因此 TabsList 外框坐标为：

```text
视口顶部：8 + 64 = 72px
相对外框顶部：64px
```

右侧终端页面：

```text
SidebarInset 顶部        8px
PageWrapper header       64px
PageWrapper 顶部 padding 0px（!pt-0）
--------------------------------
终端内层面板顶部          72px
```

也就是说，TabsList 的外层 border 盒目前已经与右侧终端内层面板顶部对齐。

但 Tab 内部可见 active pill 还要经过：

```text
TabsList border 1px
+ p-1 4px
= 5px
```

当前 active pill 比终端面板顶部低约 5px。`TerminalStage` 的内容本身还有 `py-1 = 4px`：

```tsx
<div className="h-full px-3 py-1 ... rounded-xl">
```

[`terminal-stage.tsx:453`](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/device-console/terminal-stage.tsx:453)

### 根因

整体 TabsList 并没有下移；视觉上偏低的是列表内部 active pill，原因是 `border + p-1`。

### 最小修改建议

如果对齐基准是终端实际内容区域，推荐只上移 1px：

```tsx
<Tabs className="-mt-px mb-2.5">
```

位置：[`app-sidebar.tsx:180`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:180)

这会让 active pill 从约 `+5px` 变为约 `+4px`，与 `TerminalStage py-1` 的内容起点一致。

如果产品视觉明确要求整个 Tab 切换器上移 4px，则使用：

```tsx
<Tabs className="-mt-1 mb-2.5">
```

但此时 TabsList 外层 border 会比终端面板顶部高 4px。若验收比较的是外层 border，当前代码无需移动。

另有一个独立问题：Tabs 使用的是 `data-orientation="horizontal"`，但当前高度选择器写成了：

```tsx
group-data-horizontal/tabs:h-11
```

见 [`app-sidebar.tsx:184`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:184) 和 [`tabs.tsx:23`](/Users/konata/code/tmex-enhanced-wt-r10/packages/ui/src/components/tabs.tsx:23)。

该选择器不会匹配 `data-orientation`。如果确实需要 44px 高度，应改为：

```tsx
group-data-[orientation=horizontal]/tabs:h-11
```

这属于高度修正，不是顶部偏移修正。

## 3. 管理设备页设备卡片 DnD 避让过早

### 责任链

设备页层级为：

```text
DevicesPage
└─ DeviceFoldersView              // node/group 层 DnD
   └─ NodeDeviceGroup
      └─ DeviceManagementPanel
         └─ DeviceGrid             // 目标：设备卡片一层网格 DnD
```

相关文件：

- 页面入口：[`DevicesPage.tsx:89`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/DevicesPage.tsx:89)
- 卡片面板：[`device-management-panel.tsx:148`](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/device-management/device-management-panel.tsx:148)
- 目标 DnD：[`device-grid.tsx:98`](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/device-management/device-grid.tsx:98)
- 状态与 drop：[`use-device-management-state.ts:124`](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/device-management/use-device-management-state.ts:124)

当前实现使用 `@dnd-kit/core` 和 `@dnd-kit/sortable`：

```tsx
<DndContext
  sensors={sensors}
  collisionDetection={closestCenter}
  onDragEnd={state.onDragEnd}
>
  <SortableContext items={deviceIds} strategy={rectSortingStrategy}>
```

[`device-grid.tsx:120`](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/device-management/device-grid.tsx:120)

卡片自身：

```tsx
const sortable = useSortable({ id: device.id, disabled });
```

[`device-grid.tsx:54`](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/device-management/device-grid.tsx:54)

### 当前阈值

鼠标的 `distance: 8` 只是“何时开始拖拽”：

```tsx
useSensor(MouseSensor, { activationConstraint: { distance: 8 } })
```

[`device-grid.tsx:106`](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/device-management/device-grid.tsx:106)

它不是卡片避让阈值。

真正决定 `over` 的是 `closestCenter`。dnd-kit 的实现会计算拖拽矩形中心到每个 droppable 中心的距离，并返回最近者：

[`core.cjs.development.js:332`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/node_modules/@dnd-kit/core/dist/core.cjs.development.js:332)

[`core.cjs.development.js:348`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/node_modules/@dnd-kit/core/dist/core.cjs.development.js:348)

它没有最大距离判断，因此即使拖拽卡片离其他卡片很远，也一定会选出一个最近目标，触发 `rectSortingStrategy` 的兄弟卡片 transform。

### 根因

当前逻辑是：

```text
永远存在一个最近卡片
→ over 永远不为空
→ rectSortingStrategy 立即开始移动其他卡片
```

`gap-3` 只是网格间距，不承担碰撞阈值：

```tsx
className="grid ... gap-3"
```

[`device-grid.tsx:126`](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/device-management/device-grid.tsx:126)

round4 的 `device-folders/collision.ts` 是节点/分组层 DnD，不是这里的设备卡片网格；不应直接修改该文件解决本问题。

### 最小修改建议

在 `device-grid.tsx` 新增一个带半径限制的 collision detection，建议初始半径为 96px：

```tsx
const DEVICE_PROXIMITY_RADIUS = 96;

const deviceGridCollisionDetection: CollisionDetection = (args) => {
  const activeId = String(args.active.id);
  const activeCenter = {
    x: args.collisionRect.left + args.collisionRect.width / 2,
    y: args.collisionRect.top + args.collisionRect.height / 2,
  };

  const candidates = args.droppableContainers.filter((container) => {
    if (String(container.id) === activeId) return true;

    const rect = args.droppableRects.get(container.id);
    if (!rect) return false;

    const center = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };

    return (
      Math.hypot(center.x - activeCenter.x, center.y - activeCenter.y) <=
      DEVICE_PROXIMITY_RADIUS
    );
  });

  return closestCenter({
    ...args,
    droppableContainers: candidates,
  });
};
```

然后替换：

```tsx
collisionDetection={closestCenter}
```

为：

```tsx
collisionDetection={deviceGridCollisionDetection}
```

这样：

- 远距离时只有 active 自己参与，其他卡片不避让
- active 接近目标卡片中心 96px 内时才触发避让
- active 保留在候选中，拖回原位时可以恢复兄弟卡片
- 键盘拖拽仍可使用同一 collision 函数

建议新增单测覆盖：

```text
远离所有卡片 → over 为 active
接近目标中心 96px 内 → over 为目标
拖回原卡片 → over 恢复 active
```

更简单的替代方案是使用 `pointerWithin`，它只在指针进入目标矩形时命中；该算法源码见 [`core.cjs.development.js:479`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/node_modules/@dnd-kit/core/dist/core.cjs.development.js:479)。不过它会让避让发生得更晚，当前需求更适合带半径的 `closestCenter`。

## 4. SelectionToolbar 吞掉终端顶部点击

### 责任链

- 工具条组件：[`SelectionToolbar.tsx:12`](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/SelectionToolbar.tsx:12)
- 工具条定位：[`SelectionToolbar.tsx:31`](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/SelectionToolbar.tsx:31)
- 终端容器：[`Terminal.tsx:161`](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/Terminal.tsx:161)
- 工具条挂载：[`Terminal.tsx:194`](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/Terminal.tsx:194)
- 终端鼠标监听：[`terminal-pointer.ts:109`](/Users/konata/code/tmex-enhanced-wt-r10/packages/ghostty-terminal/src/terminal-pointer.ts:109)
- 开始选择：[`terminal-pointer-handlers.ts:96`](/Users/konata/code/tmex-enhanced-wt-r10/packages/ghostty-terminal/src/terminal-pointer-handlers.ts:96)

当前工具条：

```tsx
<div className="... absolute top-2 left-1/2 z-20 ...">
```

[`SelectionToolbar.tsx:31`](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/SelectionToolbar.tsx:31)

它位于终端容器内部：

```tsx
<div ref={containerRef} className="relative min-h-0 w-full flex-1">
```

[`Terminal.tsx:161`](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/Terminal.tsx:161)

### 根因

有选区时，工具条占据终端顶部中央区域，并且默认接收 pointer/mouse 事件。

Ghostty 只把选择开始监听绑定到 terminal screen：

```tsx
selectSurface.addEventListener('mousedown', listeners.mousedown);
```

[`terminal-pointer.ts:109`](/Users/konata/code/tmex-enhanced-wt-r10/packages/ghostty-terminal/src/terminal-pointer.ts:109)

选择开始发生在：

```tsx
context.beginPointerSelection(event);
```

[`terminal-pointer-handlers.ts:96`](/Users/konata/code/tmex-enhanced-wt-r10/packages/ghostty-terminal/src/terminal-pointer-handlers.ts:96)

点击工具条时，事件目标不是 terminal screen，因此无法开始新选择；点击工具条按钮还会执行复制、粘贴或关闭操作。

round9 的实测也确认了该区域约覆盖终端顶部 3 行：

[`O3-result.md:611`](/Users/konata/code/tmex-enhanced-wt-r10/prompt-archives/2026083102-relay-files-switch-lan-round9/sub/O3-result.md:611)

### 推荐方案

在 `Terminal.tsx` 的 `containerRef` 容器上增加 `onPointerDown`：

```tsx
<div
  ref={containerRef}
  className="relative min-h-0 w-full flex-1"
  onPointerDown={(event) => {
    const target = event.target;

    if (
      target instanceof Element &&
      target.closest('[data-testid="terminal-selection-toolbar"]')
    ) {
      return;
    }

    if (hasSelection) {
      dismissSelection();
    }
  }}
>
```

修改点：[`Terminal.tsx:161`](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/Terminal.tsx:161)

理由：

- `pointerdown` 先于 Ghostty 的 `mousedown`
- 点击终端画布时先清除旧选区，再由 Ghostty 开始新选择
- 点击工具条时跳过 dismiss，保留复制/粘贴/关闭行为
- 不需要修改 Ghostty 的底层 pointer API

已有的 `preventFocusSteal`：

[`SelectionToolbar.tsx:25`](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/SelectionToolbar.tsx:25)

只处理焦点，不会解决覆盖区域问题。

把工具条移出文本区也可行，但需要调整 `Terminal` 的布局、定位和高度，改动面更大。

## 5. `node-login-<id>` testid 重复

### testid 源头

公共按钮统一生成：

```tsx
data-testid={`node-login-${nodeId}`}
```

[`NodeLoginButton.tsx:72`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/auth/NodeLoginButton.tsx:72)

### 所有当前 JSX 渲染点

| 场景 | 文件与位置 | 外层容器 |
|---|---|---|
| 管理设备页 | [`node-device-group.tsx:158`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/devices/node-device-group.tsx:158) | `devices-node-login-<id>`，定义于 [`node-device-group.tsx:154`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/devices/node-device-group.tsx:154) |
| Sidebar Files 分节 | [`app-sidebar.tsx:54`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:54) | 通过 `FilesNodeSection` 的 `files-node-login-<id>` 渲染，定义于 [`files-node-section.tsx:140`](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/files/files-node-section.tsx:140) |
| Sidebar Panes 节点分节 | [`sidebar-node-section.tsx:246`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:246) | `sidebar-node-login-<id>`，定义于 [`sidebar-node-section.tsx:213`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:213) |
| 路由 NodeGate 页面 | [`node-runtime-boundary.tsx:101`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/node/node-runtime-boundary.tsx:101) | `node-gate-blocked-<id>` |
| 设置 → 节点管理表格 | [`nodes-table.tsx:102`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:102) | `nodes-row-<id>` |

本次观察到的具体冲突是：

```text
devices-node-login-<id>
└─ node-login-<id>

files-node-login-<id>
└─ node-login-<id>
```

`FilesNodeSection` 的调用链为：

- [`app-sidebar.tsx:54`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:54)
- [`app-sidebar.tsx:70`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:70)
- [`files-node-section.tsx:144`](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/files/files-node-section.tsx:144)

### Helper 与使用点

当前 helper：

```tsx
await expect(page.getByTestId(`devices-node-login-${nodeId}`)).toBeVisible();
await page.getByTestId(`node-login-${nodeId}`).click();
```

[`mesh.ts:240`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/tests/helpers/mesh.ts:240)

[`mesh.ts:241`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/tests/helpers/mesh.ts:241)

helper 使用于：

- [`mesh-login.spec.ts:50`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/tests/mesh-login.spec.ts:50)
- [`mesh-login.spec.ts:89`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/tests/mesh-login.spec.ts:89)

### 根因

`page.getByTestId('node-login-<id>')` 是全局查询。Files tab 打开且同一远端 node 未登录时，页面同时存在两个相同 testid，触发 Playwright strict mode。

### 最小修改建议

只修改 helper，按设备页外层容器收窄：

```tsx
const deviceLogin = page.getByTestId(`devices-node-login-${nodeId}`);

await expect(deviceLogin).toBeVisible({ timeout: 30_000 });
await deviceLogin.getByTestId(`node-login-${nodeId}`).click();
```

修改点：[`mesh.ts:240`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/tests/helpers/mesh.ts:240)

这样无需改变公共 `NodeLoginButton`，也不会影响设置页、Panes 或 NodeGate 的现有测试锚点。

替代方案是给 `NodeLoginButton` 增加可选 `testId` 或 prefix，将设备页和 Files 页分别命名为：

```text
devices-node-login-button-<id>
files-node-login-button-<id>
```

但这需要修改公共组件及多个调用点，改动更大。

## 共享文件与并行开发建议

| 文件 | 涉及项目 | 并行风险 |
|---|---|---|
| `apps/fe/src/components/page-layouts/components/app-sidebar.tsx` | 1、2、5 | 三项都可能修改同一文件；应指定单一 owner，或拆成不重叠提交 |
| `packages/ui/src/components/sidebar/sidebar-layout.tsx` | 1、2 只读参考 | 若只改 AppSidebar，不需要修改；若修改基础 inset，会影响全局 |
| `apps/fe/src/main.tsx` | 1、2 只读参考 | 外框高度和底部 inset的公共来源，不建议与 UI 微调并行修改 |
| `apps/fe/src/page-wrapper.tsx` | 1、2 只读参考 | 终端内层 panel 的上下 inset来源 |
| `packages/panels/src/device-management/device-grid.tsx` | 3 | 可独立分配给 DnD owner |
| `packages/panels/src/device-folders/collision.ts` | round4/group DnD | 不属于项目 3，不应与卡片 DnD混改 |
| `packages/terminal-ui/src/components/Terminal.tsx` | 4 | 可独立分配给 SelectionToolbar owner |
| `packages/terminal-ui/src/components/SelectionToolbar.tsx` | 4 只读参考 | 推荐方案无需修改 |
| `apps/fe/tests/helpers/mesh.ts` | 5 | 可独立修改；推荐只改这里 |
| `apps/fe/src/auth/NodeLoginButton.tsx` | 5 只读参考 | 采用 testid rename 方案时才会成为共享修改点 |