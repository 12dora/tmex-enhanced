# 代码审查报告

结论：发现 4 个 P1、2 个 P2，建议修复后再合并。

## Findings

1. **P1 — 登录门闸没有阻止运行时级请求，可能让直连永久停在失败态**  
   `apps/fe/src/node/node-runtime-boundary.tsx:41-55`  
   `apps/fe/src/main.tsx:157-160`  
   `apps/fe/src/node/node-runtimes.ts:217-233`  
   `apps/fe/src/components/global-device-provider.tsx:290-294`

   进入尚未登录的远端节点时，`useNodeRuntime()` 已经创建运行时，`createNodeConnection()` 随即启动 `DirectCarrierController`；`GlobalDeviceProvider` 也位于 `NodeRouteGate` 外，会立即查询 `/api/devices`。这些操作都早于静默登录 effect。

   典型场景：登录 entry 后首次打开 `/n/B/devices/x`，直连控制器先请求远端 `/api/mesh/connection`、RTC 配置和 authorize，设备 Provider 同时请求 `/api/devices`，全部可能返回 401。直连 authorize 将 4xx 视为不可重试失败，静默登录之后页面虽然可通过 primary 工作，直连仍可能保持 `failed`，直到手动重试或销毁运行时。

   门闸需要覆盖运行时中会主动联网的初始化；至少应推迟直连控制器和设备查询。`RouteConnectionIndicator`、持久化为 Agent/Files 的侧栏同样会提前取得路由 runtime，不能只调整 `GlobalDeviceProvider` 的位置。

2. **P1 — 常驻侧栏固定到 self runtime 后，远端节点的全局导航错误地跳回本机**  
   `apps/fe/src/main.tsx:142-144`  
   `apps/fe/src/components/page-layouts/components/nav-link.tsx:12-15`  
   `apps/fe/src/components/page-layouts/components/sidebar-title.tsx:44-66`  
   `apps/fe/src/components/page-layouts/components/nav-main.tsx:60-65`

   `AppSidebar` 现在始终位于 `NodeRuntimeScope(SELF_NODE_ID)` 下，但 `NavLink` 仍通过当前 runtime 的 `hostAppPath()` 给绝对路径添加节点前缀。

   因而在 `/n/B/devices/x`：

   - “管理设备”生成 `/devices`，而不是 `/n/B/devices`；
   - “设置”生成 `/settings`，而不是 `/n/B/settings`；
   - 品牌首页链接也回到 `/`。

   用户点击这些入口会卸载当前远端页面并切换到 self，而不只是改变当前节点中的页面。Agent/Files 已显式使用 `routeNodeId`，全局导航也需要独立使用路由节点构造路径，不能继续依赖侧栏所在 runtime。

3. **P1 — 异步语言包尚未加载时，取消预览或卸载无法回退语言**  
   `apps/fe/src/pages/settings/site-settings-form.ts:121-145`  
   `apps/fe/src/pages/settings/use-site-settings-form.ts:41-47,112`

   控制器使用已经完成切换的 `i18n.language` 判断是否需要调用 `changeLanguage()`，但没有记录正在请求的语言。

   复现场景：

   1. 当前和已保存语言均为 `en_US`；
   2. 首次选择 `zh_CN`，动态 chunk 开始异步加载，此时 `i18n.language` 仍是 `en_US`；
   3. 用户立即切回英语或离开设置页；
   4. `release()` 发现目标 `en_US` 等于当前 `i18n.language`，因此不调用 `changeLanguage('en_US')`；
   5. 迟到的中文加载完成后仍会切到 `zh_CN`，且设置页已经卸载，无法再次回退。

   当前单测里的假 `changeLanguage` 会同步更新语言，因此覆盖不到该竞态。控制器应追踪最后请求的语言，回退时即使“已完成语言”相同，也要覆盖仍在途的预览请求。

4. **P1 — 两条现有 Playwright 流程会确定性失败**  
   `apps/fe/tests/settings.spec.ts:172-177`  
   `apps/fe/tests/mobile-settings.spec.ts:139-144`  
   `apps/fe/src/pages/settings/general-settings-tab.tsx:51-82`

   实现删除了 `settings-refresh-notice`，但桌面和移动 E2E 仍在保存语言后等待该元素可见。定位器不会出现，两条测试都会超时；测试注释也仍描述“刷新后生效”。

   应将断言更新为选择语言后立即验证翻译或 `<html lang>`，并在未保存离开、保存后离开两种情况下验证回退语义。

5. **P2 — 后台 refetch 仍会无条件覆盖全部未保存草稿**  
   `apps/fe/src/pages/settings/use-site-settings-form.ts:52-74`  
   `packages/panels/src/settings/settings-events-init.tsx:26,47-53`

   `refetchOnWindowFocus: false` 只处理窗口聚焦。网络恢复仍可按 React Query 默认行为重拉；其他客户端保存 site 设置时，`SETTINGS_UPDATE` 也会显式失效 `['site-settings']`。

   任一次新响应都会执行完整 `setDraft(next)`。用户正在编辑的站点名、URL、通知阈值和语言会被静默覆盖，语言预览也被 `hydrate()` 强制切回服务端值。需要 dirty-field/版本保护，或只在首次加载、保存成功后注水。

6. **P2 — 显式关闭面板仍会不断制造重复历史记录**  
   `apps/fe/src/components/side-panels/use-side-panel.ts:26-35`

   打开使用 push，关闭使用 replace：

   ```text
   /devices
   → push /devices?panel=nodes
   → replace /devices
   ```

   最终历史实际是 `[/devices, /devices]`。重复开关十次后，用户需要按十次返回键却看不到 URL 或页面变化，与“不会把历史撑满”的注释相反。应通过 location state 识别由应用打开的面板并在关闭时回退，或重新统一 open/close 的 push/replace 策略。

## 已核实无问题

- 单棵 `RootLayout` 路由树确实能保持 `SidebarProvider` 和设备侧栏跨节点挂载。
- 页面区的 `RuntimeProvider` key 会随 runtime 变化，嵌套的 `QueryClientProvider`、查询 observer、终端实例会一起重挂；未发现跨节点继续绑定旧 QueryClient 的问题。
- Agent/Files 标签已按 `routeNodeId` 单独切换 runtime，旧节点订阅会随 keyed 子树清理。
- `?panel=` 的纯函数会保留其他查询参数，并保持当前 pathname；`/account/security` 使用 replace 重定向到可渲染面板的路由树。
- Side panel 具备可访问标题、翻译后的关闭按钮、退场保留内容和独立滚动区域；移动端侧栏链接也会主动关闭原抽屉。
- OTP 当前调用场景下，普通连续输入、整串粘贴/自动填充、覆盖输入、Backspace/Delete、方向键和六位校验逻辑成立；每格具有可访问名称。未发现足以阻塞合并的 IME 或 controlled-value 缺陷。
- dnd-kit 的 pointer-first 检测保留了键盘/空隙场景的 `closestCenter` 回退，节点 sortable ID 也与内部设备 ID 隔离。
- 远端设置页通过 `controlsBrowserPrefs=false` 不会切换宿主语言。
- 品牌主标题固定为 `tmex`，副标题读取 entry 节点名，结构与可访问名称正常。

## 验证结果

- 变更相关单测：`132 pass，0 fail`。
- 前端 TypeScript：`tsc --noEmit -p apps/fe/tsconfig.json` 通过。
- `git diff --check 07fd162a..ed303a30` 通过。
- 未运行完整 Playwright；上述两个 E2E 失败由已删除的唯一 selector 与仍存在的等待断言直接确定。