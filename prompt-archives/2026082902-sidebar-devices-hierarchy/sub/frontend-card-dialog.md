# 任务 C/D/E：设备卡片真实类型与连接/断开、去重标签、按类型编辑对话框（packages/panels/device-management）

worktree：`/Users/konata/code/tmex-enhanced-wt-merge`（分支 `chore/merge-hub-tabs`）。**其他代理正并行修改同一 worktree 的其它文件**（`apps/fe/**`、`packages/panels/src/device-folders/**`、`packages/stores/**`、`apps/gateway/**`、`packages/api-client/**`、locale JSON 与 i18n 生成物）。你只能改「文件范围」里的文件；**禁止任何 git 命令**。运行时 Bun（`export PATH="$HOME/.bun/bin:$PATH"`）。先读 `AGENTS.md`。macOS 无 `timeout`；`bun test` 输出带 ANSI 色（`sed 's/\x1b\[[0-9;]*m//g'`）；panels 包用 `bun test src/`。注释只在逻辑不直观处写，简体中文，标识符英文。**严禁偷懒**：不留 TODO、不写「简化版」。

## 文件范围（只准改/建）
`packages/panels/src/device-management/**`（全部文件，含测试）、`packages/panels/src/device-status-badge.tsx`（若需要）、`packages/panels/src/device-connection.ts`（只读，不改）。**不要改** `apps/fe/**`、`packages/stores/**`、locale JSON、`packages/shared/**`。需要新 i18n key 时：先用下面已存在的；确实缺的写到 `prompt-archives/2026082902-sidebar-devices-hierarchy/sub/frontend-card-dialog-i18n-request.md`（key + zh/en/ja 文案），代码里照常用 `t('key')`，由指挥官补。

## 已有 i18n key（已在三语 locale 里，`t()` 直接用）
`device.connect`「连接」、`device.disconnect`「断开」、`device.connecting`「连接中...」、`device.open`「打开」、`device.kind.local`「本地设备」、`device.kind.ssh`「SSH 设备」、`device.kind.nodeLocal`「节点 {{node}} 上的本机设备」、`device.kind.nodeSsh`「节点 {{node}} 上的 SSH 设备」、`device.remoteInfo.title`「所属节点」、`device.remoteInfo.node`、`device.remoteInfo.nodeId`、`device.remoteInfo.deviceId`、`device.remoteInfo.hint`、`device.sidebar.show`、`device.sidebar.hint`、`device.typeLocal`、`device.typeSSH`、`device.typeSSHBadge`、`device.sectionBasic/sectionConnection/sectionAuth`、`common.*`。

## 背景（先读这些代码）
- `packages/panels/src/device-management/{device-card.tsx,device-card.test.tsx,device-management-panel.tsx,device-dialog.tsx,device-form.ts,device-basic-fields.tsx,device-ssh-connection-fields.tsx,device-auth-fields.tsx,use-device-dialog-submit.ts,index.ts}`
- `packages/panels/src/device-connection.ts`（`DeviceConnectionAdapter`：`status/isConnected/isIntentionallyDisconnected/connect/disconnect`）
- `packages/panels/src/device-status-badge.tsx`
- `apps/fe/src/components/global-device-provider.tsx`（只读：adapter 如何构造；`connect()` 会清除持久化的「断开意图」，`disconnect()` 会记录它——所以卡片上点「连接」就自然清掉了 disconnect intent）
- `apps/fe/src/pages/devices/node-device-group.tsx`（只读：宿主如何挂 `DeviceManagementPanel`；另一位代理会把下面定义的 `nodeContext` / `connection` 传进来）
- `packages/panels/src/device-tree/device-connection-control.tsx`（状态点样式参考）
- `packages/theme/src/motion.css`、`packages/ui/src/motion.tsx`（`--tmex-motion-*` token、`Reveal`）

`Device.type` 只有 `local | ssh`；「属于远端 mesh 节点」是渲染上下文（node runtime），不在数据里。

## 对外契约（另一位代理会按这个调用，名字必须一致）
新建 `packages/panels/src/device-management/device-node-context.ts`：
```ts
export interface DeviceNodeContext {
  /** 运行时 / 路由 id：entry 自身为 'self'，远端为 mesh node id */
  runtimeNodeId: string;
  /** 展示名（self 也给真实主机名，可为空串） */
  name: string;
  isSelf: boolean;
}
export type DeviceDisplayKind = 'local' | 'ssh' | 'nodeLocal' | 'nodeSsh';
export function deviceDisplayKind(deviceType: 'local' | 'ssh', ctx: Pick<DeviceNodeContext, 'isSelf'>): DeviceDisplayKind;
export function deviceKindLabel(t: TFunction, kind: DeviceDisplayKind, nodeName: string): string; // 用上面的 device.kind.* key
```
`DeviceManagementPanelProps` 新增（全部可选，缺省行为 = 今天的行为）：
```ts
nodeContext?: DeviceNodeContext;          // 缺省 { runtimeNodeId: runtime.nodeId ?? 'self', name: '', isSelf: true }
connection?: DeviceConnectionAdapter;     // 有它卡片才显示真实连接/断开；没有时退化为只有「打开」
excludeDeviceIds?: ReadonlySet<string>;   // 这些设备不在本面板网格里渲染（它们被放进了文件夹）
renderCard?: (card: ReactNode, device: Device, index: number) => ReactNode; // 宿主包一层（拖拽把手等）
hideEmptyState?: boolean;                 // 列表为空/全被排除时不渲染空态卡片（只渲染 null + 对话框）
```
新增并从 `index.ts` 导出 `DeviceCardHost`：单张卡片 + 自己的编辑对话框 + 删除确认（把面板里的 editing/delete 状态下放到每张卡片；面板网格改用它）：
```ts
export interface DeviceCardHostProps {
  device: Device; queryKey: readonly unknown[]; nodeContext: DeviceNodeContext;
  connection?: DeviceConnectionAdapter; style?: CSSProperties; className?: string;
}
```
`DeviceCardProps` 新增 `nodeContext: DeviceNodeContext`（必填，由 host 传）与 `connection?: DeviceConnectionAdapter`；保留 `runtimeNodeId` 兼容或直接由 `nodeContext.runtimeNodeId` 取代（更新测试）。

## C. 真实类型 + 真实连接/断开
- 底部 pill 显示 `deviceKindLabel(...)`；图标：local→Monitor、ssh→Globe，远端节点再叠一个小 Network/Server 角标或直接换成 `Server` 图标（自行选一种一致的做法）。
- 主按钮改成**真实开关**：`status = connection.status(device.id)`；`disconnected`/`error` → 显示「连接」，点击 `connection.connect(id)`；`connecting`/`reconnecting` → 显示「连接中...」并 disabled；`connected` → 显示「断开」，点击 `connection.disconnect(id)`。`data-testid` 保持 `device-card-connect-${id}`，并加 `data-state={status}`。按钮里放一个与侧栏一致的状态小圆点（颜色随 status，`transition-colors duration-(--tmex-motion-fast)`，`motion-reduce:transition-none`）。
- 另加「打开」：`Link` 到 `hostAppPath(runtime.host, '/devices/:id')`，`data-testid=device-card-open-${id}`，图标按钮（`ArrowUpRight` 或 `ExternalLink`）+ tooltip/title。
- `connection` 缺省（旧宿主）时：不显示连接开关，只显示「打开」（即今天的行为但文案改成「打开」）。

## D. 去重
标题下方的副标题只保留对 SSH 有信息量的 `user@host:port`；local 设备副标题去掉（第二行不渲染），类型只在底部 pill 出现一次。更新 `device-card.test.tsx`（无 DOM，`renderToStaticMarkup`）：断言 local 卡片 HTML 里「本地设备」文案只出现一次；远端节点 ctx 下出现 `device.kind.nodeLocal` 文案。

## E. 按类型的编辑对话框
- `DeviceDialog` 新增 prop `nodeContext: DeviceNodeContext`（面板/host 传入）。`kind = deviceDisplayKind(values.type, nodeContext)`。
- 区块规则：
  - `ssh` / `nodeSsh`：基本信息（名称、类型[编辑态禁用]、会话、工作目录）+ 连接 + 认证（已有）。
  - `local`：名称、类型[编辑态禁用]、会话、工作目录。
  - 远端节点（`nodeLocal`/`nodeSsh`）编辑态：额外一个只读信息块（`device.remoteInfo.*`：节点名、节点 id、设备 id，等宽字体，带 `device.remoteInfo.hint`），并把「显示在侧栏」开关放进对话框（读写 `useUIStore` 的 `sidebarDeviceVisibility`，key 用 `sidebarDeviceVisibilityKey(runtimeNodeId, deviceId)`，与卡片上那个开关同源）。
  - 类型永远不可在创建后修改（已是禁用，确认 `buildUpdatePayload` 不发 type）。
  - 新建对话框在远端节点目标下打开时：默认 type=local（即该节点的本机设备），标题/描述里体现目标节点名（用现有 `devices.nodes.addDevice`「在 {{name}} 上添加设备」作为描述或在标题旁加节点 chip）。
- `authMode: 'auto'` 修复：`createDefaultFormValues` 对 SSH 设备把 `'auto'` 归一为 `'agent'`（gateway `ssh-auth.ts` 里 auto 与 agent 行为一致），保证下拉总有匹配项；`device-form.test.ts`（若无则新建）覆盖：ssh+auto→agent、local 始终 auto、update payload 不含 type、create payload 按类型裁剪字段。

## 验收
- `cd packages/panels && bun test src/`：基线 389 pass / 0 fail；新增测试全过、无新失败。`bunx tsc --noEmit -p .` 无错误（基线 0）。改动文件跑 `bunx biome check --write`。
- 报告写到 `prompt-archives/2026082902-sidebar-devices-hierarchy/sub/frontend-card-dialog-result.md`（简体中文，简洁）：改动清单、导出的新契约、测试数、未尽事项。
