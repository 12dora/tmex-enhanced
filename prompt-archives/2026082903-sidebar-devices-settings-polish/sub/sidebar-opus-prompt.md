# Task: left sidebar polish (frontend)

## Common rules (read carefully)
- Worktree: `/Users/konata/code/tmex-enhanced-wt-merge` (branch `chore/merge-hub-tabs`). Work ONLY there. Runtime is Bun (`~/.bun/bin/bun`), not Node.
- Other agents are editing the SAME worktree in parallel. Touch ONLY files inside your declared scope. NEVER run any git command that changes state (no add/commit/stash/checkout/reset). `git diff`/`git status` are fine. The commander commits.
- Never touch the production tmex service (port 9883, `~/Library/Application Support/tmex/`) and never touch the tmux session named `tmex` or the default tmux socket. If you need a live instance, start a temporary one inside the worktree on ports ≥ 19000 with explicit env overrides (`GATEWAY_PORT`, `TMEX_BIND_HOST=127.0.0.1`, `DATABASE_URL`, `TMEX_FE_DIST_DIR`, `TMEX_MASTER_KEY=$(openssl rand -base64 32)`), and kill only that process.
- Code: standard-English identifiers, no unnecessary comments, no TODOs, no "simple version first" — finish the whole scope. Tests are Bun test (`bun test` in the package dir; in `apps/fe` use `bun test src/` — bare `bun test` picks up Playwright specs). Do not run Playwright e2e.
- i18n: edit ONLY the locale source JSONs (`packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`, all three) under the sub-objects listed in your scope, then run `bun run build:i18n` at the repo root to regenerate `resources.ts`/`types.ts`. Never hand-edit or lint the generated files. Chinese is the primary language; provide sensible en/ja.
- Never run lint/format on generated files (`packages/shared/src/i18n/resources.ts|types.ts`, `resources/fe-dist/*`, `dist/*`). For your own changed source files run `bunx biome check --write <files>`.
- Verification before you report done: in each package you touched, `bun test` passes (baselines: apps/fe `bun test src/` 602 pass / tsc 0 errors; packages/panels 458 pass / 0; packages/shared 358 / 0; packages/stores 277 / 1 pre-existing tsc error; apps/gateway — run `bun test` + `bunx tsc --noEmit -p .` yourself first to get its baseline before editing) and `bunx tsc --noEmit -p .` error count does not exceed baseline. Report exact numbers.
- Final report (return as your final message AND write it to the result file named in your task): what changed (file list), design decisions, test/tsc numbers, anything left out and why. Write it in Simplified Chinese.

## Scope (files you may edit)
- `apps/fe/src/components/page-layouts/components/**` (sidebar-device-list.tsx, sidebar-node-section.tsx, sidebar-device-list-runtime.tsx, nav-main.tsx, nav-link.tsx, app-sidebar.tsx, their tests)
- `packages/panels/src/device-tree/**` (device-window-list.tsx, window-row-header.tsx, window-pane-list.tsx, node-badge.tsx, device-row-header.tsx, device-tree-dnd.tsx, tests)
- `packages/stores/src/ui.ts` + `ui.test.ts` (add persisted `sidebarNodeOrder`)
- locale JSON sub-objects `sidebar.*`, `nav.*`, `window.*`, `device.dragHandle` only
- `apps/fe/tests/sidebar-device-disclosure.spec.ts` (only to update the padding-left assertion)
Do NOT touch `apps/fe/src/pages/**`, `packages/panels/src/device-folders/**`, `packages/panels/src/device-management/**`, settings pages, or gateway.

## Exploration map (already verified by a read-only explorer; trust it but re-read the files)
以下为只读勘察结果，未修改文件。

## 结构与渲染流

- 顶层侧边栏：[app-sidebar.tsx:18-90](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:18)。
  - `nav.manageDevices` 指向 `/devices`。
  - `SidebarFooter` 渲染底部导航。
- 节点列表：[sidebar-device-list.tsx:10-54](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:10)。
  - `useMeshNodes()` 获取节点。
  - `toSidebarEntries()` 将节点转换为 sidebar entry，并保持输入数组顺序。
  - 每个 entry 渲染 `SidebarNodeSection`。
- 节点运行时内容：[sidebar-node-section.tsx:147-217](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:147)。
- 设备、窗口树：[sidebar-device-list-runtime.tsx:30-73](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx:30)。

## 1. 节点组的垂直间距

主要控制点是：

```tsx
<div className="flex flex-col gap-2" data-testid="sidebar-node-list">
```

位于 [sidebar-device-list.tsx:40-43](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:40)。

- `gap-2` 控制相邻节点组之间的间距。
- 默认是 8px，即 `calc(var(--spacing) * 2)`。
- 项目支持 spacing scale，因此最终值受主题中的 `--spacing` 影响：[themes.css:751-763](/Users/konata/code/tmex-enhanced-wt-merge/packages/theme/src/themes.css:751)。

其他相关间距：

- 节点内部 header 与内容之间：`space-y-1`，4px。
  - 登录/离线节点：[sidebar-node-section.tsx:97-175](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:97)。
  - 运行时节点：[sidebar-device-list-runtime.tsx:53-73](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx:53)。
- `SidebarGroup` 默认有 `p-2`，即 8px 周边 padding：[sidebar-primitives.tsx:67-75](/Users/konata/code/tmex-enhanced-wt-merge/packages/ui/src/components/sidebar/sidebar-primitives.tsx:67)。

## 2. 子窗口与 “new window” 行的水平缩进

实际统一控制点是：

```tsx
<div className="tmex-reveal space-y-1.5 py-1.5 pr-1.5 pl-10 ...">
```

位于 [device-window-list.tsx:20-51](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-tree/device-window-list.tsx:20)。

- `pl-10` 控制整个窗口列表，包括：
  - 子窗口行；
  - `new window` 操作行。
- 默认值为 40px，即 `calc(var(--spacing) * 10)`。
- 现有 E2E 在 [sidebar-device-disclosure.spec.ts:96-101](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/tests/sidebar-device-disclosure.spec.ts:96) 验证计算后的 `padding-left >= 40`。

操作行自身：

```tsx
className="w-full flex items-center gap-2 px-2 py-1.5 border border-dashed ..."
```

- `px-2` 是行内图标/文字的 8px 水平 padding，不改变相对于节点的整体 40px 缩进。
- 子窗口 header 同样使用 `px-2`：[window-row-header.tsx:42-69](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-tree/window-row-header.tsx:42)。

更深层的 pane 缩进不是节点/窗口缩进：

- 多 pane：`ml-4 pl-2`：[window-pane-list.tsx:54-74](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-tree/window-pane-list.tsx:54)。
- agent footer：`ml-[36px] pl-2`，同文件约 29 行。

## 3. 节点 header、拖拽、顺序与持久化

### 节点 header

节点 header 由 `SectionHeader` 渲染：

[sidebar-node-section.tsx:85-95](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:85)

```tsx
<div className="flex items-center gap-2 px-1 pt-1">
  <NodeBadge ... />
</div>
```

`NodeBadge` 位于 [node-badge.tsx:22-48](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-tree/node-badge.tsx:22)：

```tsx
inline-flex max-w-[7rem] shrink-0 items-center gap-1
rounded border border-border/60 px-1 py-px
text-[10px] leading-none
```

结论：

- 节点名确实包在 badge/chip 中。
- 不是完整的 pill：使用 `rounded`，不是 `rounded-full`。
- 字号为 `text-[10px]`。
- 最大宽度 `max-w-[7rem]`，名称超出后 `truncate`。
- 显示值为 `node.name.trim()`，为空时回退到 `nodeId`。
- 离线状态只会降低颜色/透明度，不改变 badge 结构。
- 节点名不是 i18n 文案，而是 API 返回值。

不要混淆设备 header：[device-row-header.tsx:28-63](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-tree/device-row-header.tsx:28) 中的设备名是 `text-xs font-medium`，不是节点 badge。

### 是否已有节点级拖拽排序

没有。

现有 dnd-kit 只用于：

- 设备、窗口、pane 的树内排序：[device-tree-dnd.tsx:21-95](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-tree/device-tree-dnd.tsx:21)。
- Devices 管理页中的 device folders/layout：[device-folder-tree.tsx:325-421](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-folders/device-folder-tree.tsx:325)。

左侧节点列表本身只是 `entries.map(...)`，没有 `DndContext`、`SortableContext` 或节点拖拽 handle。

### 节点顺序来源

当前流程：

1. `AuthApi.listNodes()` 请求 `/api/mesh/nodes`：[auth-api.ts:55-75](/Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/auth/auth-api.ts:55)。
2. `useMeshNodes()` 将 API 返回的 `payload.nodes` 直接写入外部状态：[mesh-nodes.ts:248-341](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/mesh-nodes.ts:248)。
3. `toSidebarEntries()` 保持该数组顺序：[sidebar-device-list.tsx:10-28](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:10)。
4. Gateway 的 `collectNodes()` 组装返回数组：[mesh-routes.ts:211-290](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-routes.ts:211)。

Gateway 当前大致是 self 节点优先，然后按证书/注册表遍历顺序生成；`listCerts()` 没有显式 `ORDER BY`：[user-store.ts:296-298](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/auth/user-store.ts:296)。

注意：

- `sortNodes()` 存在于 `apps/fe/src/node/mesh-nodes.ts:66-75`，但 sidebar 当前没有调用它。
- Devices 管理页的 `toNodeDeviceGroups()` 会排序，但那不是 sidebar 排序：[node-device-group.tsx:50-74](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/devices/node-device-group.tsx:50)。

### 是否已有持久化排序

没有发现节点顺序字段或持久化逻辑：

- `MeshNode` 没有 `sortOrder`：[types.ts:139-159](/Users/konata/code/tmex-enhanced-wt-merge/packages/api-client/src/auth/types.ts:139)。
- Gateway `nodes`/`nodeCerts` 表没有 sidebar 排序字段：[schema.ts:576-610](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/db/schema.ts:576)。
- `sidebarDeviceVisibility` 只持久化设备可见性，key 为 `${runtimeNodeId}:${deviceId}`：[sidebar-device-visibility.ts:1-20](/Users/konata/code/tmex-enhanced-wt-merge/packages/stores/src/sidebar-device-visibility.ts:1)。
- UI store 持久化到 `tmex-ui`，但没有 node order：[ui.ts:77-239](/Users/konata/code/tmex-enhanced-wt-merge/packages/stores/src/ui.ts:77)。

`device_folders` 的 layout 是设备文件夹/设备项布局，不是 sidebar 节点排序；它通过 `/api/device-folders/layout` 持久化：[use-device-folders.ts:1-6](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/devices/use-device-folders.ts:1)。

最小改动方案是将 sidebar 节点顺序作为本机 UI 偏好：

- 在 `UIState` 增加 `sidebarNodeOrder: string[]` 和 setter。
- 写入现有 `tmex-ui` localStorage 持久化。
- 使用稳定的 node ID，不使用可变的显示名称。
- 渲染前按保存 ID 排序：
  - 先显示仍存在的已保存节点；
  - 新节点追加到末尾；
  - 删除已不存在的 ID。
- 在 sidebar 节点层新增独立的 `DndContext`/`SortableContext`，拖拽结束后更新 UI store。
- 不需要修改 Gateway 或数据库；若未来要求跨设备同步，再单独设计服务端偏好接口。

## 4. “manage devices” 激活状态

实际目标路由是 `/devices`：

[app-sidebar.tsx:18-24](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:18)

`/settings` 中对应的是 `devicesAndFiles` tab，不是 `devices`：[SettingsPage.tsx:40-74](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/SettingsPage.tsx:40)。

激活逻辑：

[nav-main.tsx:17-49](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/nav-main.tsx:17)

```ts
pathname === url || pathname.startsWith(`${url}/`)
```

因此：

| 当前 pathname | 激活结果 |
|---|---|
| `/devices` | 激活 |
| `/devices/device-1` | 激活 |
| `/devices/device-1/windows/...` | 激活，可能是用户认为的误高亮 |
| `/settings?tab=devicesAndFiles` | 不激活 |
| `/settings?tab=devices` | 不激活 |
| `/settings` | 不激活 |

补充问题：

- `useLocation()` 只读取 `pathname`，search params 不参与匹配。
- 没有发现 active 状态被 localStorage 或 UI store 持久化。
- `NavLink` 会为显式节点路由添加 `/n/:nodeId` 前缀：[nav-link.tsx:10-27](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/nav-link.tsx:10)。
- 因此 `/n/<nodeId>/devices` 可能出现反向问题：实际链接存在，但 `NavMain` 用未加前缀的 `/devices` 比较，导致不激活。
- 路由定义位于 [main.tsx:207-257](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/main.tsx:207)。

视觉激活样式来自：

[sidebar-menu.tsx:33-83](/Users/konata/code/tmex-enhanced-wt-merge/packages/ui/src/components/sidebar/sidebar-menu.tsx:33)

```txt
data-active:bg-sidebar-accent
data-active:text-sidebar-accent-foreground
data-active:font-medium
```

现有代码中没有发现 `NavMain` 的 route-matching 单元测试。

## 测试与 i18n

现有相关测试：

- [sidebar-device-list.test.tsx:78-109](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-device-list.test.tsx:78)：`toSidebarEntries()`，适合增加保存顺序、新节点追加、过期 ID 删除测试。
- [sidebar-device-list.test.tsx:126-269](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-device-list.test.tsx:126)：节点离线、登录、选中状态。
- [mesh-nodes.test.ts:133-143](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/mesh-nodes.test.ts:133)：已有默认排序测试，但当前 sidebar 未使用该排序。
- [ui.test.ts:20-216](/Users/konata/code/tmex-enhanced-wt-merge/packages/stores/src/ui.test.ts:20)：应增加 `sidebarNodeOrder` 的默认值、持久化和异常数据归一化测试。
- [sidebar-device-disclosure.spec.ts:96-101](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/tests/sidebar-device-disclosure.spec.ts:96)：验证 `pl-10` 的水平缩进。
- [sidebar-click-no-pty-injection.spec.ts:29-97](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/tests/sidebar-click-no-pty-injection.spec.ts:29)：覆盖 new-window 点击行为。
- [node-badge.test.ts](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-tree/node-badge.test.ts)：覆盖 badge 文案和空名称回退。
- `NavMain` 当前没有匹配逻辑测试，建议新增 `/devices`、`/devices/id`、`/n/id/devices`、`/settings?tab=devicesAndFiles` 场景。

相关源 locale JSON 均位于：

```txt
packages/shared/src/i18n/locales/en_US.json
packages/shared/src/i18n/locales/zh_CN.json
packages/shared/src/i18n/locales/ja_JP.json
```

相关 keys：

- `translation.nav.manageDevices`
- `translation.sidebar.manageDevices`
- `translation.sidebar.newWindow`
- `translation.sidebar.noWindows`
- `translation.sidebar.noDevices`
- `translation.sidebar.node.offline`
- `translation.sidebar.node.noKnownDevices`
- `translation.sidebar.node.noDevices`
- `translation.window.new`
- `translation.window.noWindows`
- `translation.window.dragHandle`
- `translation.auth.node.loginToThisNode`
- `translation.auth.node.loggingIn`
- `translation.auth.node.signInRequired`
- `translation.device.dragHandle`
- `translation.common.loading`
- `translation.common.expand`
- `translation.common.collapse`
- `translation.common.retry`

不要直接修改生成文件 `packages/shared/src/i18n/resources.ts` 或 `types.ts`；它们由 i18n 构建脚本生成。

## Recommended change points

- 节点组间距：`apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:40` 的 `gap-2`。
- 节点内部间距：`sidebar-node-section.tsx:108,171` 和 `sidebar-device-list-runtime.tsx:68` 的 `space-y-1`。
- 子窗口及 new-window 缩进：`packages/panels/src/device-tree/device-window-list.tsx:31` 的 `pl-10`。
- 节点 badge 样式：`packages/panels/src/device-tree/node-badge.tsx:32-48`。
- 节点顺序计算：`apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:10-43`。
- 节点顺序持久化：`packages/stores/src/ui.ts:77-239`，复用现有 `tmex-ui` UI store。
- 节点级拖拽：参考 `packages/panels/src/device-tree/device-tree-dnd.tsx:21-95`，在 sidebar 节点列表增加独立排序上下文。
- manage devices 激活匹配：`apps/fe/src/components/page-layouts/components/nav-main.tsx:17-49`；如需支持节点前缀，同时调整 `nav-link.tsx:10-27` 或统一生成 host-aware pathname。
- 路由确认：`apps/fe/src/main.tsx:207-257`。
- 测试更新：`sidebar-device-list.test.tsx`、`packages/stores/src/ui.test.ts`、`sidebar-device-disclosure.spec.ts`，并新增 `NavMain` route-matching 测试。

## Requirements
1. **Node group vertical spacing is too large** (e.g. between nodes "konata-mac", "tmex", "docker-node"). Reduce `gap-2` in sidebar-device-list.tsx and the inner `space-y-1`/`pt-1` so that groups read as compact but still separated (target ≈ 2–4px between groups, and no double padding from SidebarGroup `p-2` + inner paddings). Check both the runtime-node branch and the offline/login branches so spacing is identical.
2. **Child window rows and the "new window" row under a node are indented too much** (`pl-10` = 40px in device-window-list.tsx). Reduce to roughly the width of the device row's icon+gap (≈ `pl-5`/`pl-6`, pick what aligns visually with the device name text — measure the device-row-header layout: drag-handle gutter + icon + gap) so that width is used efficiently while the hierarchy remains readable. The "new window" dashed row must move together with the window rows (it is inside the same container, keep it so). Update the e2e assertion in sidebar-device-disclosure.spec.ts to the new minimum. Also review pane-list `ml-4 pl-2` and agent footer `ml-[36px]` so nested levels stay consistent with the new indent.
3. **Node header**: remove the bordered badge/chip around the node name in the sidebar header (NodeBadge is used in the sidebar SectionHeader; if NodeBadge is used elsewhere keep that usage working — add a variant/prop or render a plain header element in the sidebar). Make the node name a plain, slightly larger label (≈ `text-xs`/`text-[13px] font-semibold`, muted color, truncating), keep the offline/online visual cue (e.g. a small status dot or muted opacity). Then implement **drag-to-reorder of node groups** in the sidebar: a `DndContext` + vertical `SortableContext` over the node entries (reuse the sensor config from `packages/panels/src/device-tree/device-tree-dnd.tsx`: mouse distance 8, touch delay 250, keyboard). The node header is the drag handle (whole header row draggable, or a grip icon that appears on hover — choose the whole header for touch friendliness but ensure the existing click targets inside the header — login/retry/expand buttons — still work; use the activation distance to avoid conflicts). Persist the order as `sidebarNodeOrder: string[]` of node IDs in the existing persisted UI store (`packages/stores/src/ui.ts`, storage key `tmex-ui`), with a setter and normalization of bad data. Ordering rule in `toSidebarEntries`/list: saved IDs first in saved order (skipping IDs that no longer exist), then unknown/new nodes appended in API order. Must not interfere with the existing device/window DnD inside each node (nested DndContexts are fine with dnd-kit as long as ids don't collide — prefix node sortable ids e.g. `sidebar-node:<id>`; verify the inner DnD still works by reading device-tree-dnd.tsx). Add unit tests for the ordering helper and the store field.
4. **"Manage devices" nav highlight bug**: `nav-main.tsx` uses `pathname === url || pathname.startsWith(url + '/')`, so the terminal page `/devices/:deviceId/...` also highlights "manage devices". Fix: match exactly `/devices` (and the node-prefixed form `/n/:nodeId/devices`) — build the comparison from the same host-aware pathname that NavLink generates, or strip the `/n/:nodeId` prefix before comparing. Keep prefix semantics only where a nav item is a true section root (none of the current items need it; the settings item should also not highlight on unrelated routes). Add a unit test covering `/devices`, `/devices/abc`, `/devices/abc/windows/w/panes/p`, `/n/node1/devices`, `/settings?tab=devicesAndFiles`.

Take screenshots only if a dev server is already reachable; otherwise rely on tests. Write the final report to `prompt-archives/2026082903-sidebar-devices-settings-polish/sub/sidebar-opus-result.md`.
