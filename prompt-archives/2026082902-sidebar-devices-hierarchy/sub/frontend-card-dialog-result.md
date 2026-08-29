# 任务 C/D/E 执行结果：设备卡片真实类型与连接/断开、去重标签、按类型编辑对话框

## 改动清单（均在 `packages/panels/src/device-management/`）

新建：

- `device-node-context.ts`：`DeviceNodeContext` / `DeviceDisplayKind` / `deviceDisplayKind()` / `deviceKindLabel()` / `isRemoteDeviceKind()`。
- `device-card-connect-toggle.tsx`：卡片主按钮（真实连接/断开开关）+ 纯函数 `deviceConnectAction(status)`。
- `device-card-host.tsx`：`DeviceCardHost`，单卡片 + 自己的编辑对话框 + 删除确认。
- `device-delete-dialog.tsx`：`DeviceDeleteDialog`，删除 mutation 与确认框（从面板下放）。
- `device-remote-info-fields.tsx`：远端节点设备的只读归属信息块 +「显示在侧栏」开关。
- 测试：`device-node-context.test.ts`、`device-card-connect-toggle.test.ts`、`device-form.test.ts`。

修改：

- `device-card.tsx`：`nodeContext` 必填、新增 `connection?` / `className?`，删除 `runtimeNodeId`（由 `nodeContext.runtimeNodeId` 取代）。
  - 底部 pill 改为 `deviceKindLabel()`（四种种类），**种类只在这里出现一次**；本地设备不再渲染第二行副标题，SSH 设备第二行仍是 `user@host:port`。
  - 图标：local→`Monitor`、ssh→`Globe`；远端节点在图标右下角叠一个 `Network` 角标（`data-testid=device-card-remote-${id}`，`aria-hidden`，不重复文案）。
  - 主按钮 `device-card-connect-${id}` 变成真实开关：`disconnected`/`error`→「连接」，`connecting`/`reconnecting`→「连接中...」且 disabled，`connected`→「断开」；带 `data-state={status}`、`data-action`，按钮内是与侧栏同源的状态小圆点（复用 `deviceStatusDotClass`，`transition-colors duration-(--tmex-motion-fast)` + `motion-reduce:transition-none`）。
  - 新增「打开」入口 `device-card-open-${id}`：`Link` 到 `hostAppPath(runtime.host, '/devices/:id')`；有 connection 时是 `ArrowUpRight` 图标按钮，无 connection 时退化为带文案的 outline 按钮。
  - 卡片根节点新增 `data-device-kind={kind}`。
  - 内部拆出 `DeviceCardIcon` / `DeviceCardMenu`，`test` 菜单项的 mutation 随菜单一起下沉。
- `device-management-panel.tsx`：新增可选 props `nodeContext` / `connection` / `excludeDeviceIds` / `renderCard` / `hideEmptyState`；网格改用 `DeviceCardHost`（编辑/删除状态与 mutation 从面板移走，面板只留新建对话框）；`renderCard` 的返回值统一包一层带 key 的 `Fragment`，宿主不必自己管 key。
- `device-dialog.tsx`：新增必填 `nodeContext`；按 `deviceDisplayKind(values.type, nodeContext)` 组区块——SSH 才渲染连接 + 认证区；远端节点编辑态在最前面插只读信息块（含侧栏开关）；远端目标下标题旁挂节点 chip、描述用 `devices.nodes.addDevice`；新增 `data-device-kind` 属性。
- `device-form.ts`：新增导出 `normalizeSshAuthMode()`，`createDefaultFormValues` 对 SSH 设备把 `auto`/缺失归一为 `agent`（gateway `ssh-auth.ts` 里两者等价），保证下拉总有匹配项。
- `index.ts`：新增导出 `DeviceCardHost`、`DeviceDeleteDialog`、`DeviceNodeContext` 一族。
- `device-card.test.tsx`：改用独立 i18next 实例 + `I18nextProvider`（不碰全局默认实例，避免与其它测试文件互相污染），覆盖四种种类文案、去重、连接开关五种状态、侧栏开关默认值与选择器。

未改动：`device-connection.ts`、`device-status-badge.tsx`、`apps/fe/**`、`packages/stores/**`、locale JSON。所需 i18n key 全部已存在，**无需补 key**（未创建 i18n request 文件）。

## 对外契约（另一位代理按此调用）

```ts
// packages/panels/src/device-management/device-node-context.ts
export interface DeviceNodeContext {
  runtimeNodeId: string; // entry 自身为 'self'，远端为 mesh node id
  name: string;          // 展示名，可为空串
  isSelf: boolean;
}
export type DeviceDisplayKind = 'local' | 'ssh' | 'nodeLocal' | 'nodeSsh';
export function deviceDisplayKind(deviceType: DeviceType, ctx: Pick<DeviceNodeContext, 'isSelf'>): DeviceDisplayKind;
export function isRemoteDeviceKind(kind: DeviceDisplayKind): boolean;
export function deviceKindLabel(t: TFunction, kind: DeviceDisplayKind, nodeName: string): string;

// device-card-host.tsx
export interface DeviceCardHostProps {
  device: Device;
  queryKey: readonly unknown[];
  nodeContext: DeviceNodeContext;
  connection?: DeviceConnectionAdapter;
  style?: CSSProperties;
  className?: string;
}
export function DeviceCardHost(props: DeviceCardHostProps): ReactElement;

// device-management-panel.tsx（全部新增项可选，缺省 = 今天的行为）
interface DeviceManagementPanelProps {
  devicesQueryKey?: readonly unknown[];
  listenOpenAddDeviceEvent?: boolean;
  nodeContext?: DeviceNodeContext;        // 缺省 { runtimeNodeId: runtime.nodeId, name: '', isSelf: true }
  connection?: DeviceConnectionAdapter;
  excludeDeviceIds?: ReadonlySet<string>;
  renderCard?: (card: ReactNode, device: Device, index: number) => ReactNode;
  hideEmptyState?: boolean;
  className?: string;
  ref?: Ref<DeviceManagementPanelHandle>;
}

// device-card.tsx
interface DeviceCardProps {
  device: Device; onEdit: () => void; onDelete: () => void;
  nodeContext: DeviceNodeContext;         // 必填，由 host 传
  connection?: DeviceConnectionAdapter;
  style?: CSSProperties; className?: string;
}

// device-dialog.tsx
interface DeviceDialogProps {
  mode: 'create' | 'edit'; device?: Device;
  nodeContext: DeviceNodeContext;         // 必填
  onClose: () => void; queryKey: readonly unknown[];
}

// device-form.ts
export function normalizeSshAuthMode(authMode: AuthMode | undefined | null): AuthMode;
```

新增 / 变更的 `data-testid`：`device-card-open-${id}`（新，打开设备页）、`device-card-remote-${id}`（新，远端角标）、`device-card-kind-${id}`（新，种类 pill）、`device-dialog-remote-info`、`device-dialog-node-chip`、`device-dialog-sidebar-${id}`；`device-card-connect-${id}` 保留但**语义变了**（从「跳转设备页的 Link」变成「连接/断开按钮」，且只在注入 `connection` 时渲染）。

## 测试

- `packages/panels`：`bun test src/` → **444 tests，442 pass / 2 fail**（基线 389 pass / 0 fail，新增 55 个测试）。
  - 2 个 fail 全部在 `src/settings/settings-events-init.test.tsx`（`SETTINGS_NAMESPACE_QUERY_KEYS` 缺 `device-folders` 命名空间），由并行代理新增的 gateway `device-folders` settings namespace 引起，**与本任务无关，且不在本任务文件范围内**，未改动。
  - `bun test src/device-management/` → **60 pass / 0 fail**（其中新增：card 12、node-context 6、connect-toggle 3、form 17 及原有）。
- `bunx tsc --noEmit -p .`（packages/panels）→ 0 错误；顺带 `apps/fe` 的 `tsc --noEmit` 也是 0 错误（面板新 props 全可选，旧宿主不受影响）。
- 改动文件已跑 `bunx biome check --write`（fix 4 个文件的格式）。

## 未尽事项 / 需指挥官处理

1. **e2e 需要跟着改**（不在本任务范围，属 `apps/fe/**`）：`apps/fe/tests/devices.spec.ts:53` 与 `:91` 用 `device-card-connect-${id}` 断言 `href="/devices/:id"`。现在跳转入口是 `device-card-open-${id}`，`device-card-connect-` 是连接/断开按钮（且宿主不注入 `connection` 时不渲染）。请把这两处选择器换成 `device-card-open-${id}`，href 断言保持不变。
2. `settings-events-init.test.tsx` 的 2 个 fail 需要负责 `device-folders` settings namespace 的代理补 `SETTINGS_NAMESPACE_QUERY_KEYS`（或补进 no-op 列表）。
3. `DeviceManagementPanel` 缺省 `nodeContext` 按 brief 写死 `isSelf: true`。若宿主把面板挂在远端 node 的 `NodeRuntimeScope` 里却不传 `nodeContext`，卡片会误显示成本机设备——`node-device-group.tsx` 记得把 `nodeContext` / `connection` 传进来。
