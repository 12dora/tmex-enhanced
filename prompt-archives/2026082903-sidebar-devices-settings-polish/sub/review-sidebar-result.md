发现 3 项：

1. **minor** — `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:117`  
   补丁引用了新 key `sidebar.node.dragHandle`，但补丁未包含三份 locale 源文件。单独应用后，拖拽手柄的无障碍名称会显示原始 key。  
   **修复：**在 `en_US.json`、`zh_CN.json`、`ja_JP.json` 中加入该 key，并运行 `bun run build:i18n`，将生成文件一并纳入变更。

2. **minor** — `apps/fe/src/components/page-layouts/components/nav-main.tsx:21`  
   补丁改变了导航激活规则，却没有包含 `nav-main.test.ts`；当前工作区虽有该测试文件，但它仍是未跟踪文件，不属于被审查补丁。因此 `/devices`、node 前缀和终端深链的回归保护实际缺失。  
   **修复：**把现有 `apps/fe/src/components/page-layouts/components/nav-main.test.ts` 纳入提交。

3. **minor** — `apps/fe/src/components/page-layouts/components/sidebar-device-list.test.tsx:313`  
   新测试仅检查服务端静态 HTML 中存在拖拽属性，未触发任何 sensor 或 `onDragEnd`。因此节点实际重排、写入 `sidebarNodeOrder`、刷新后恢复，以及内部设备 DnD 在嵌套 `DndContext` 中仍可用均未覆盖；会返回 `null` 的隐藏远端分节也未进入拖拽场景。  
   **修复：**补一个浏览器交互测试：拖动两个可见节点并断言 DOM 顺序和 localStorage，刷新后再次断言；场景中加入一个隐藏分节，并验证内部设备拖拽或点击仍正常。

`ml-4.5` 和 `py-0.5` 已用项目实际的 Tailwind CSS 4.1.18 编译验证，分别生成 `calc(var(--spacing) * 4.5)` 和 `calc(var(--spacing) * 0.5)`，不是无效类。