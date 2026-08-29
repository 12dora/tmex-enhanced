# Task: Devices management page rework (frontend + shared + gateway)

## Common rules (read carefully)
- Worktree: `/Users/konata/code/tmex-enhanced-wt-merge` (branch `chore/merge-hub-tabs`). Work ONLY there. Runtime is Bun (`~/.bun/bin/bun`), not Node.
- Other agents are editing the SAME worktree in parallel. Touch ONLY files inside your declared scope. NEVER run any git command that changes state (no add/commit/stash/checkout/reset). `git diff`/`git status` are fine. The commander commits.
- Never touch the production tmex service (port 9883, `~/Library/Application Support/tmex/`) and never touch the tmux session named `tmex` or the default tmux socket. If you need a live instance, start a temporary one inside the worktree on ports ≥ 19000 with explicit env overrides (`GATEWAY_PORT`, `TMEX_BIND_HOST=127.0.0.1`, `DATABASE_URL`, `TMEX_FE_DIST_DIR`, `TMEX_MASTER_KEY=$(openssl rand -base64 32)`), and kill only that process.
- Code: standard-English identifiers, no unnecessary comments, no TODOs, no "simple version first" — finish the whole scope. Tests are Bun test (`bun test` in the package dir; in `apps/fe` use `bun test src/` — bare `bun test` picks up Playwright specs). Do not run Playwright e2e.
- i18n: edit ONLY the locale source JSONs (`packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`, all three) under the sub-objects listed in your scope, then run `bun run build:i18n` at the repo root to regenerate `resources.ts`/`types.ts`. Never hand-edit or lint the generated files. Chinese is the primary language; provide sensible en/ja.
- Never run lint/format on generated files (`packages/shared/src/i18n/resources.ts|types.ts`, `resources/fe-dist/*`, `dist/*`). For your own changed source files run `bunx biome check --write <files>`.
- Verification before you report done: in each package you touched, `bun test` passes (baselines: apps/fe `bun test src/` 602 pass / tsc 0 errors; packages/panels 458 pass / 0; packages/shared 358 / 0; packages/stores 277 / 1 pre-existing tsc error; apps/gateway — run `bun test` + `bunx tsc --noEmit -p .` yourself first to get its baseline before editing) and `bunx tsc --noEmit -p .` error count does not exceed baseline. Report exact numbers.
- Final report (return as your final message AND write it to the result file named in your task): what changed (file list), design decisions, test/tsc numbers, anything left out and why. Write it in Simplified Chinese.

## Your role
You are the lead engineer for the whole "manage devices" page task. You may implement everything yourself. You may spawn subagents (Agent tool) for independent sub-pieces if that keeps things faster, but you own the integration and verification. Think in English; write code identifiers in English; the final report in Simplified Chinese.

## Scope (files you may edit)
- `apps/fe/src/pages/DevicesPage.tsx`, `apps/fe/src/pages/devices/**`
- `apps/fe/src/node/**` (mesh-nodes.ts, node-runtime-scope.tsx) only if needed for offline snapshots
- `apps/fe/src/components/global-device-provider*.ts(x)`, `device-connection-status.ts`, `device-intent-store.ts` (connect-button flicker)
- `packages/panels/src/device-folders/**`, `packages/panels/src/device-management/**`, `packages/panels/src/device-status-badge.tsx`
- `packages/shared/src/device-folders.ts` (+test), `packages/shared/src/contracts/device-folders.ts`
- `packages/api-client/src/device-folders.ts`, `packages/api-client/src/devices.ts`
- `packages/stores/src/tmux*.ts` only if strictly required for the flicker fix
- gateway: `apps/gateway/src/api/device-folder-routes.ts` (+test), `apps/gateway/src/db/device-folders.ts` (+test), a new migration under the gateway migrations dir if needed
- locale JSON sub-objects: `devices.*`, `device.*`, `apiError.folder*` only
Do NOT touch `apps/fe/src/components/page-layouts/**`, `packages/panels/src/device-tree/**`, `packages/stores/src/ui.ts`, settings pages, or locale keys `sidebar.*`/`nav.*`/`settings.*` — another agent owns those.

## Exploration map (verified by a read-only explorer; trust it but re-read the files)
只读结论：未修改文件。当前“离线保留”只保留节点及其简化 inventory，不保留可直接渲染的完整远端设备卡片数据。

### 1. 远端节点掉线后的设备卡片

数据链路：

```text
useMeshNodes()
  → GET /api/mesh/nodes
  → toNodeDeviceGroups()
  → DeviceFoldersView
  → NodeDeviceGroup
  → NodeRuntimeScope
  → DeviceManagementPanel
  → GET /n/<nodeId>/api/devices
```

关键位置：

- `apps/fe/src/pages/DevicesPage.tsx:36-57`：通过 `useMeshNodes` 生成节点分组。
- `apps/fe/src/node/mesh-nodes.ts:35-57`：收到 offline 事件时仅更新已有节点的 `online=false`，并保留 `inventory`；不会删除节点。
- `apps/fe/src/node/mesh-nodes.ts:50-74`：将节点转换成 `NodeDeviceGroupEntry`。
- `apps/gateway/src/mesh/mesh-routes.ts:211-290`：从未撤销的 peer/certificate 构造节点列表；断线节点仍会出现在 `/api/mesh/nodes`。
- `apps/fe/src/pages/devices/node-device-group.tsx:42-47`：状态为 `offline`、`signedOut` 或 `ready`。
- `apps/fe/src/pages/devices/node-device-group.tsx:140-171`：offline 分支只渲染 `inventory.devices` 的“已知设备”文本列表，不渲染 `DeviceCard`。
- `apps/fe/src/pages/devices/placed-device.tsx:1-6,109-125`：布局中单独放置的远端设备，在节点不可用时显示灰色 missing placeholder；不会自动从布局删除。
- `packages/api-client/src/devices.ts:11-28`：`fetchDevices()` 请求 `/api/devices`；远端 runtime 会解析为 `/n/<nodeId>/api/devices`。
- `apps/fe/src/node/node-runtime-scope.tsx:1-25`：每个节点有独立的 `QueryClient`、API client 和 `GlobalDeviceProvider`。

结果：

- 普通远端节点掉线：节点仍在列表，真实设备卡片被替换成 offline inventory 文本。
- 节点被撤销/从 mesh 节点列表消失：`DeviceFoldersView` 不渲染该节点，但已有 placement 不会被删除。
- 已单独放置的设备：显示灰色占位，不会自动清除 placement。
- `apps/fe/src/pages/devices/device-name-cache.ts:1-22` 只是进程内 `Map`，用于拖拽 Overlay 的设备名称；不是设备列表缓存。
- `apps/fe/src/components/device-connection-persistence.ts:7-58` 只持久化连接意图，不保存设备资料。
- 服务端有持久化的 `peer_cache.inventory_json`，以及 `nodes.inventory_json`：`apps/gateway/src/db/schema.ts:593-660`。但这只是节点 inventory，不是完整的远端 `/api/devices` 设备列表，也没有远端设备独立表。

若要离线继续显示完整卡片，需要持久化完整远端设备 DTO，或扩充 inventory；然后在 `OfflineBody`/`PlacedDevice` 中从该快照渲染 `DeviceCard`，并显式传入 `offline` 状态、禁用连接操作。

### 2. 连接/断开按钮闪烁

关键位置：

- `packages/panels/src/device-management/device-card-connect-toggle.tsx:10-70`：根据连接状态映射按钮文案和动作。
- `apps/fe/src/components/global-device-provider.tsx:158-217`：连接状态适配器与连接/断开动作。
- `apps/fe/src/components/device-intent-store.ts:28-104`：持久化用户连接意图。
- `packages/stores/src/tmux.ts:136-195`：连接/断开时立即修改 store。
- `packages/stores/src/tmux-event-router.ts:33-69`：接收真实 `device-connected` / `device-disconnected` 事件。
- `apps/fe/src/components/device-connection-status.ts:34-45`：状态优先级为 intentional disconnect → reconnecting → error → connected → connecting。

状态转移：

```text
connect:
disconnected
  → connectedDevices 立即加入
  → connecting
  → device-connected 事件
  → connected

disconnect:
connected
  → disconnected intent 立即写入
  → disconnected
  → tmux subscription 清理 / 发送 disconnect
```

可能造成闪烁的因素：

- connect 是乐观更新，按钮会同步从“连接”变成“连接中”，随后又迅速变成“断开”。
- disconnect 没有独立的 `disconnecting` 状态，会立即显示“连接”，没有请求中的中间态。
- retry 时先清理错误，再重新进入 `connecting`，会产生 `error → connecting → connected/error` 的快速变化。
- toggle 本身没有 `Loader2` 或 `animate-spin`；pending 状态只是禁用按钮并显示连接中文案。
- `DeviceStatusBadge` 在 reconnecting 时使用 `RefreshCcw animate-spin`：`packages/panels/src/device-status-badge.tsx:26-68`。
- 通用按钮有 `transition-[...]`、`active:scale-[0.98]`：`packages/ui/src/components/button.tsx:7`。
- 卡片有 `transition-[box-shadow,border-color]`；状态点有 `transition-colors`：`packages/panels/src/device-management/device-card.tsx:169-241`。
- 设备网格使用 `tmex-stagger` 入场动画：`packages/panels/src/device-management/device-management-panel.tsx:185-209`；动画定义在 `packages/theme/src/motion.css:49-66`。
- 普通点击不会因连接状态改变而触发 key remount：卡片 key 是 `device.id`，文件夹条目 key 是稳定的 `itemKey`。但节点从 `ready` 切换到 `offline` 时，`NodeDeviceGroup` 会切换分支，可能卸载整个 remote runtime subtree。

现有测试：

- `packages/panels/src/device-management/device-card-connect-toggle.test.ts:1-21`
- `packages/panels/src/device-management/device-card.test.tsx:154-208`
- `apps/fe/src/components/global-device-provider.test.ts:117-168`
- `apps/fe/src/components/global-device-provider-shared-intent.test.tsx:128-207`
- `packages/stores/src/tmux-reselect-retry.test.ts:152-198`
- `packages/stores/src/tmux-event-router.test.ts:211-240`
- `packages/stores/src/tmux-device-events.test.ts:335-365`

### 3. 文件夹模型与 DnD

类型定义：

- `packages/shared/src/contracts/device-folders.ts:6-51`
  - `DeviceFolder`: `id/name/parentId/sortOrder`。
  - `DeviceFolderPlacement`: `itemKey/kind/nodeId/deviceId/folderId/sortOrder`。
  - `folderId=null` 表示根层。
- `packages/shared/src/device-folders.ts:27-39`
  - 实际 key 是 `node:<nodeId>`。
  - 设备是 `device:<nodeId>:<deviceId>`。
  - 不是带斜杠的 `node/.../device/...` 格式。
  - `self` 是本机 runtime 的 `nodeId`。
- `apps/gateway/src/db/schema.ts:373-401`
  - `device_folders`：`parent_id` 自引用，但没有 FK。
  - `device_folder_placements`：`item_key` 主键，保存 node/device、folder、order。
  - DB 只检查 `kind in ('node','device')`，没有检查 node/device 所属关系。

当前语义：

- 节点、设备、文件夹都可以独立放到根层或任意嵌套文件夹。
- `sortOrder` 在每个父文件夹内分别对 folders 和 placements 编号。
- `packages/shared/src/device-folders.ts:83-97` 的 `isFolderForestValid` 只校验 parent 存在、无环、无重复 ID，不限制层级为一层。
- `packages/shared/src/device-folders.ts:180-227`
  - `moveFolderInLayout` 允许任意合法父文件夹。
  - `moveItemInLayout` 允许 node/device 放入任意文件夹。

DnD：

- `packages/panels/src/device-folders/folder-tree-model.ts:17-75`：生成 root、folder、drop zone、container。
- `packages/panels/src/device-folders/folder-tree-model.ts:167-230`：解析落点；条目可放到文件夹，文件夹可重排或移动到其他容器。
- `packages/panels/src/device-folders/folder-tree-model.ts:256-277`：应用 drop，并计算已独立放置设备。
- `packages/panels/src/device-folders/device-folder-tree.tsx:148-163`：
  - 先用 `pointerWithin` 命中 drop zone。
  - 否则用 `closestCenter`。
- `packages/panels/src/device-folders/device-folder-tree.tsx:385-421`：
  - 指针悬停约 600ms 自动展开文件夹。
  - 拖拽结束调用 `resolveDrop` / `onDrop`。
- `packages/panels/src/device-tree/device-tree-dnd.tsx:21-31`：
  - Mouse 距离 8px。
  - Touch 延迟 250ms。
  - Keyboard 使用 `sortableKeyboardCoordinates`。
- `packages/panels/src/device-folders/folder-section.tsx:230-245`：折叠时通过 grid transition 延迟卸载内容。
- `packages/panels/src/device-folders/device-folder-tree.tsx:424-455`：当前支持新建子文件夹、移动到 root 等操作。

若改成“一层 groups + 节点绑定设备”：

- 文件夹必须全部 `parentId=null`。
- 文件夹 placement 只允许 `kind=node`。
- 节点下的设备不再作为独立 folder placement；由节点 runtime 的 `/api/devices` 列表渲染。
- 节点只能在 root 与 group 之间移动。
- 设备只能通过现有节点内排序接口排序：`apps/gateway/src/api/device-routes.ts:139-148` 的 `PUT /api/devices/order`。
- 若保留 device placement，则 shared validator 必须验证：
  - device placement 的 `nodeId` 与实际设备所属节点一致；
  - device 与 node 位于同一个 group；
  - device 不能跨 node 或独立移动。

校验入口：

- 前端/共享：`packages/shared/src/device-folders.ts:83-97,180-227`。
- Gateway：`apps/gateway/src/api/device-folder-routes.ts:124-152,165-201`。
  - 当前只校验 placement 结构、folder ID、重复 key、文件夹环。
  - 不校验一层限制，也不校验 device/node 归属。
- DB helper：`apps/gateway/src/db/device-folders.ts:165-217`。
- 应补充 DB 层约束或 helper 防御性校验，避免绕过 HTTP API 写入非法布局。

相关测试：

- `packages/shared/src/device-folders.test.ts:48-171`
- `packages/panels/src/device-folders/folder-tree-model.test.ts:115-277`
- `packages/panels/src/device-folders/device-folder-tree.test.tsx:60-211`
- `apps/fe/src/pages/devices/device-folders-view.test.tsx:121-214`
- `apps/gateway/src/api/device-folder-routes.test.ts:49-255`
- `apps/gateway/src/db/device-folders.test.ts:18-139`

### 4. DEVICES 页面宽度与留白

主要容器：

- `apps/fe/src/pages/devices/device-folders-view.tsx:140-174`

  ```text
  mx-auto flex w-full max-w-6xl flex-col gap-3 p-3 pb-[...]
  sm:gap-4 sm:p-5
  ```

- `packages/panels/src/device-management/device-management-panel.tsx:165-220`

  ```text
  mx-auto flex w-full max-w-6xl flex-col gap-3 p-3 pb-[...]
  sm:p-5
  ```

- `apps/fe/src/pages/devices/node-device-group.tsx:194-220`
  - 嵌套 panel 传入 `max-w-none gap-2 p-0 sm:p-0`，意图是消除第二层 max-width/padding。
- `packages/panels/src/device-management/device-management-panel.tsx:185-209`
  - ready 状态使用 `tmex-stagger grid gap-3 md:grid-cols-2 xl:grid-cols-3`。

造成“正常/全屏”差异的状态：

- `apps/fe/src/pages/DevicesPage.tsx:59-70`
  - auth 尚未加载时使用 `h-full ... p-8` 的全区域 loading wrapper，没有 `max-w-6xl`。
  - 加载完成后进入 `DeviceFoldersView`，被 `max-w-6xl` 限制。
- `DeviceManagementPanel:173-209`
  - loading/error/empty/grid 是不同内容分支。
- `NodeDeviceGroup:232-275`
  - ready 渲染完整卡片 grid。
  - offline/signedOut 渲染窄的状态块或 inventory 列表。
- 因此没有一个直接切换 `max-w` 的业务条件；视觉变化主要来自 loading wrapper、外层 `max-w-6xl`、ready/offline 分支，以及内外两层 panel wrapper。

横向 padding/缩进来源：

- 外层页面：`DeviceFoldersView` 的 `p-3 sm:p-5`。
- 内层 panel：`DeviceManagementPanel` 的 `p-3 sm:p-5`。
- offline/signedOut 状态块：`NodeDeviceGroup:140-184` 的 `px-3`。
- 文件夹内容缩进：`folder-section.tsx:230-245` 的 `ml-3 ... pl-3`。
- 拖拽条目：`draggable-item.tsx:39-89` 的 `pl-5`。
- 宽屏：`max-w-6xl` 会在 viewport 两侧留下设计性空白。
- 窄屏：外层 padding、内层 padding、文件夹缩进叠加，卡片可用宽度明显减少。

### 5. i18n 与 local/remote runtime

中文 locale：`packages/shared/src/i18n/locales/zh_CN.json`

英文 locale：`packages/shared/src/i18n/locales/en_US.json`

主要 key：

- “本地设备”
  - `translation.device.typeLocal`：约 `:70`
  - `translation.device.localDevice`：约 `:113`
  - `translation.device.kind.local`：约 `:128`
- “节点 xxx 上的本机设备”
  - `translation.device.kind.nodeLocal`：约 `:130`
  - value：`节点 {{node}} 上的本机设备`
- “文件夹 / Folder”
  - 没有单独的通用 Folder key，主要在：
    - `translation.devices.folders.newFolder`
    - `translation.devices.folders.newSubfolder`
    - `translation.devices.folders.rename`
    - `translation.devices.folders.delete`
    - `translation.devices.folders.folderMenu`
  - 中文约 `zh_CN.json:1598-1622`，英文约 `en_US.json:1598-1622`。
- 文件夹错误：
  - `translation.apiError.folderNotFound`
  - `translation.apiError.folderNameRequired`
  - `translation.apiError.folderNameTooLong`
  - `translation.apiError.folderCycle`
  - `translation.apiError.folderLayoutInvalid`
  - 约 `:646-650`。

local/remote 判定：

- `apps/fe/src/pages/devices/node-device-group.tsx:55-68` 设置 `isSelf` 和 `runtimeNodeId`。
- `apps/fe/src/pages/devices/node-device-group.tsx:186-188` 构造 `DeviceNodeContext`。
- `packages/panels/src/device-management/device-node-context.ts:1-43`
  - self 的 local/ssh 使用 `device.kind.local` / `device.kind.ssh`。
  - remote 的 local/ssh 使用 `device.kind.nodeLocal` / `device.kind.nodeSsh`。
- `packages/panels/src/device-management/device-card.tsx:158-167` 读取 context 并生成设备类型文案。
- `apps/fe/src/node/node-runtime-scope.tsx:18-25` 决定实际 API/query runtime。

修改 locale JSON 后，应运行 i18n 生成脚本；不要直接编辑生成文件 `packages/shared/src/i18n/resources.ts`、`types.ts`。

### 6. Reset layout API

没有发现独立的 reset、delete-all 或 clear-layout API。

现有接口：

- `packages/api-client/src/device-folders.ts:12-83`
  - `GET /api/device-folders`
  - `POST /api/device-folders`
  - `PATCH /api/device-folders/:id`
  - `DELETE /api/device-folders/:id`
  - `PUT /api/device-folders/layout`
- `apps/gateway/src/api/device-folder-routes.ts:204-221` 注册这些路由。
- `apps/fe/src/pages/devices/use-device-folders.ts:29-40` 的 `EMPTY_LAYOUT` 只是客户端 fallback，不会写回服务端。

恢复“所有节点/设备回到根层，但保留文件夹”：

```http
PUT /api/device-folders/layout
{
  "folders": [
    { "id": "...", "parentId": null, "sortOrder": 0 }
  ],
  "placements": []
}
```

注意：

- Gateway 要求请求中的 folder ID 集合必须与当前数据库完全一致：`device-folder-routes.ts:178-181`。
- 因此不能用 `{ "folders": [], "placements": [] }` 删除所有文件夹；有文件夹时会返回 `folderLayoutInvalid`。
- 删除所有文件夹需逐个调用 `DELETE /api/device-folders/:id`；删除逻辑会把子文件夹和 placements 提升到父级：`apps/gateway/src/db/device-folders.ts:133-163`。

### Recommended change points

- 离线完整设备卡片：`apps/fe/src/pages/devices/node-device-group.tsx`、`placed-device.tsx`、`device-name-cache.ts`，并在 gateway/node inventory 或新增远端设备快照存储处持久化完整 DTO。
- 连接按钮防闪烁：`apps/fe/src/components/global-device-provider.tsx`、`device-connection-status.ts`、`packages/stores/src/tmux.ts`；增加显式 connect/disconnect request state 或 request id。
- 一层 groups 约束：`packages/shared/src/device-folders.ts`、`packages/panels/src/device-folders/folder-tree-model.ts`、`device-folder-tree.tsx`、`folder-section.tsx`。
- Gateway/DB 防非法布局：`apps/gateway/src/api/device-folder-routes.ts`、`apps/gateway/src/db/device-folders.ts`、`apps/gateway/src/db/schema.ts`。
- 节点绑定设备及节点内排序：`apps/fe/src/pages/devices/device-folders-view.tsx`、`node-device-group.tsx`、`packages/panels/src/device-management/device-management-panel.tsx`，复用 `PUT /api/devices/order`。
- 宽度统一：优先统一 `device-folders-view.tsx:143` 与 `device-management-panel.tsx:168` 的 `max-w-6xl/p-3/sm:p-5`，并检查 `NodeDevicePanel` 的 `max-w-none p-0` 覆盖效果。
- Reset layout：在 `apps/fe/src/pages/devices/use-device-folders.ts` 增加 reset mutation/UI；服务端可复用 `PUT /api/device-folders/layout`，无需新增接口。

## Requirements (all mandatory)
1. **Offline nodes keep their device cards.** Today, when a remote runtime node goes offline, NodeDeviceGroup switches to an OfflineBody that renders only a text list from `inventory` and the DeviceCards disappear. Required: the same device cards stay rendered with an explicit "offline" status; their connect/disconnect toggle shows the "disconnected" state (button label = connect); clicking connect triggers a manual connection attempt (which will surface an error/reconnecting state if the node is still down). Implementation guidance: keep a per-node snapshot of the last successfully fetched device list (persist to localStorage keyed by node id so a reload while offline still shows cards; fall back to the server-side node `inventory` devices when no snapshot exists — check what fields `inventory` carries and map them into a minimal device DTO). Render the snapshot through the normal DeviceCard component with an `offline` flag (badge text, muted styling, disabled edit actions that need the remote API). Avoid unmounting the whole remote runtime subtree on ready→offline flips if that's what causes card loss; if the runtime scope must be kept mounted for connect attempts, keep it mounted and just overlay the offline state.
2. **Connect button flashes on click.** Reproduce by reading the state transitions (connect: disconnected → connecting → connected; disconnect has no intermediate state). Fix the visible flicker: introduce a stable pending state for both directions (e.g. `connecting`/`disconnecting` derived from an in-flight request flag in the provider/store) so the toggle label and status badge do not bounce through an intermediate value; make sure no key change/remount happens on the card when the connection state changes, and avoid re-triggering the `tmex-stagger` enter animation on state updates (the grid should only stagger on first mount). Add/adjust unit tests for the toggle/status mapping.
3. **Restructure folders → single-level "groups" with node-bound devices.**
   - Data model: folders must all have `parentId = null`; placements may only be `kind = 'node'`. Devices are never placed independently — a node's devices always render under their node (from that node's `/api/devices`), and can only be **reordered within the node** (reuse the existing per-runtime `PUT /api/devices/order`). Dragging a device out of its node or into another node/group is impossible (not just rejected — the DnD must not offer such drop targets).
   - Enforce in shared validation (`isFolderForestValid`/layout validators: depth 1, node-only placements), in the gateway route + DB helper (reject nested folders and device placements with `folderLayoutInvalid`), and add a migration that flattens existing data (promote nested folders to root, delete device placements). Remove the "new subfolder" action and the nested-folder code paths in folder-tree-model / device-folder-tree / folder-section.
   - Rename wording "文件夹" → "分组" (en "Group", ja "グループ") in all `devices.folders.*` keys and any `apiError.folder*` messages that are user-visible (key names may stay).
   - Add a **"reset layout" icon button** at the top-right of the page toolbar (next to the existing new-group button), opening a confirmation dialog (use the existing dialog primitives from `@tmex/ui`); on confirm, restore the default layout: all groups deleted, all nodes back to root in default order. Prefer adding an atomic gateway endpoint `POST /api/device-folders/reset` (route + db helper in one transaction + broadcast the same event the layout PUT broadcasts) and an api-client method, instead of chaining N DELETE calls.
   - Each group must have a clearly visible **dashed border** delimiting its drop area; empty groups show a dashed placeholder inviting drop. Below the group list, render a dashed **"move to top level" drop zone** (visible while dragging a node that is inside a group; drop = move to root). Delete-group stays in the group menu.
   - Devices within a node should render as the existing responsive card grid; the node header (name, online status, drag handle) is the draggable unit.
4. **Width instability.** The page sometimes renders at "normal" width and sometimes full width. Root causes identified: the auth-loading wrapper in DevicesPage has no `max-w-6xl`; DeviceFoldersView and DeviceManagementPanel both apply `mx-auto max-w-6xl p-3 sm:p-5` (double wrapper) and NodeDevicePanel overrides with `max-w-none p-0`. Fix: a single page-level container owns width/padding (use it for loading, empty, error and ready states alike), and inner panels are `w-full` with no own max-width/padding. Then **use the space well**: at ≥ xl use a wider max width (e.g. `max-w-7xl`) or none, reduce outer horizontal padding to ≈ `px-4 sm:px-6`, shrink the folder-content indent (`ml-3 pl-3` + item `pl-5`) so cards do not lose ~40px per nesting level, and make the card grid responsive: 1 column < 640px, 2 at md, 3 at xl, 4 at 2xl. Verify visually at 375px, 768px, 1280px and 1920px if a dev server is available (see below); otherwise reason from classes.
5. **Wording**: the kind label for a remote node's local device (`device.kind.nodeLocal`, currently "节点 {{node}} 上的本机设备") becomes "远程本地设备" (en "Remote local device", ja "リモートローカルデバイス") — the node name is already shown in the group header so it's not needed in the label; for the self node keep "本地设备" (`device.kind.local`). Check `device.kind.nodeSsh` for consistency (make it "远程 SSH 设备" / "Remote SSH device").

## Dev server for visual verification (optional but recommended)
A dev server may be started ONLY from this worktree with non-production ports: copy nothing from production. Use `bun run dev` from the worktree root only if ports 19663/19883 are free (`lsof -i :19883`); if they are busy another agent/user is using them — do not kill it, just reuse it read-only or skip screenshots. Do not run Playwright e2e specs (HMR pollution); a small ad-hoc Playwright screenshot script is fine.

Write the final report to `prompt-archives/2026082903-sidebar-devices-settings-polish/sub/devices-fable-result.md`.
