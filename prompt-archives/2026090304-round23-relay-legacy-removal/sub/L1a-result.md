# L1a 结果：canonical v1.1（ResizePane 几何语义 + 能力/版本门槛 + metadata 承载设备树顺序）

只改 `packages/shared`（外加 ws-protocol 规范文档）。gateway / ws-client / stores / terminal-ui 一行未动。

## 一、改动文件

新增：

- `packages/shared/src/ws-borsh/canonical-geometry.ts`（41 行）
- `packages/shared/src/ws-borsh/canonical-version.ts`（20 行）
- `packages/shared/src/ws-borsh/canonical-tree-order.ts`（102 行）
- `packages/shared/src/ws-borsh/canonical-resize-v11.test.ts`（10 用例）
- `packages/shared/src/ws-borsh/canonical-version.test.ts`（5 用例）
- `packages/shared/src/ws-borsh/canonical-tree-order.test.ts`（13 用例）

修改：

- `packages/shared/src/ws-borsh/canonical-state.ts`（+19 行）
- `packages/shared/src/ws-borsh/index.ts`（barrel，只加导出）
- `packages/shared/src/capabilities.ts`
- `packages/shared/src/index.ts`（只加一行 `GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1` 导出）
- `packages/shared/src/index.test.ts`（主入口运行时导出面快照，必须同步加这一项）
- `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`（新增「canonical v1.1」小节，v1 原文未动）

## 二、导出的 API（下游按此实现，名称/顺序/类型均已固定）

### 1. ResizePaneV11

```ts
// packages/shared/src/ws-borsh/canonical-state.ts
export const CanonicalResizePaneV11Schema = b.struct({
  requestId: b.bytes(16),
  pane: CanonicalPaneTargetSchema,
  rows: b.u16(),
  cols: b.u16(),
  geometryReason: b.u8(),
  sizeEpoch: b.u64(),
});
export type CanonicalResizePane = b.infer<typeof CanonicalResizePaneSchema>;      // v1，新加的类型别名
export type CanonicalResizePaneV11 = b.infer<typeof CanonicalResizePaneV11Schema>;
```

- 枚举变体名：**`ResizePaneV11`**，追加在 `CanonicalCommandSchema` 尾部，**discriminator = 5**
  （0 SetPaneSubscriptions / 1 TerminalInput / 2 ResizePane / 3 RequestScreen / 4 RequestHistory / 5 ResizePaneV11）。
- v1 的 `CanonicalResizePaneSchema` 与其 discriminator=2 **完全未动**。
- `protocolVersion` 仍为 `1`，未新增 canonical wire version（与 EX2 建议不同，理由见第四节）。
- 字节布局（envelope 内，偏移从 payload 起算）：
  `u16 protocolVersion(=1)` → `u8 变体 tag(=5)` → `bytes16 requestId` →
  `u32 deviceId 长度 + UTF-8` → `bytes16 serverEpoch` → `u32 paneId 长度 + UTF-8` →
  `u16 rows(LE)` → `u16 cols(LE)` → `u8 geometryReason` → `u64 sizeEpoch(LE)`。
- **`sizeEpoch` 的 JS 类型是 `bigint`**（zorsh `b.u64()`，与 `terminalSeq` / `generation` 一致）。
  构造时写 `7n`，不要写 `7`。

### 2. 几何 reason 常量与命令语义校验

```ts
// packages/shared/src/ws-borsh/canonical-geometry.ts，经 wsBorsh barrel 导出
export const CANONICAL_GEOMETRY_REASON_CHANGE = 0;
export const CANONICAL_GEOMETRY_REASON_RESEND = 1;
export const CanonicalGeometryReason = { Change: 0, Resend: 1 } as const;  // 同名 const + type
export type CanonicalGeometryReason = 0 | 1;
export function isCanonicalGeometryReason(value: number): value is CanonicalGeometryReason;
export function assertCanonicalCommandSemantics(command: CanonicalCommand): void;
```

`assertCanonicalCommandSemantics` 已接进 `encodeCanonicalCommandPayload` **和**
`decodeCanonicalCommandPayload`（与事件侧 `assertCanonicalEventSemantics` 对称），
违例抛 `WsBorshError(ERROR_INVALID_FRAME, retryable=false)`：

- `geometryReason` 不是 0/1 → 拒绝；
- `sizeEpoch <= 0n` → 拒绝（**0 是保留值**，让网关能把「没记录过 epoch」和「epoch=0」区分开）。

v1 命令（含 v1 `ResizePane`）不受影响，语义校验对它们是 no-op。

### 3. 能力与版本门槛

```ts
// packages/shared/src/capabilities.ts，经 @tmex/shared 主入口导出
export const GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1 = 'canonical-state-v1.1';
export const GATEWAY_CAPABILITIES = [
  GATEWAY_CAPABILITY_CANONICAL_STATE_V1,
  GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1,
] as const;

// packages/shared/src/ws-borsh/canonical-version.ts，经 wsBorsh barrel 导出
export const CANONICAL_V11_MIN_PEER_VERSION = '1.1.22';
export function peerSupportsCanonicalV11(version: string | null): boolean;
```

`peerSupportsCanonicalV11` 行为（fail-closed，已全部覆盖测试）：

| 输入 | 结果 |
|---|---|
| `'1.1.22'` / `'1.1.23'` / `'1.2.0'` / `'2.0.0'` | true |
| `'1.1.21'` / `'0.9.9'` | false |
| `'1.1.22_dev'` / `'1.1.23_dev'` / `' 1.1.22_dev '` | true（去掉 `_dev` 后按数字比较） |
| `'1.1.21_dev'` | false |
| `null` / `''` / `'abc'` / `'1.1'` / `'v1.1.22'` / `'1.1.22_beta'` | false |
| `'1.1.22-rc.1'` | false（预发布低于同号正式版）；`'1.1.23-rc.1'` → true |

注：`compareSemver` 本身把 `1.1.22_dev` 判为不可解析（返回 null），`_dev` 是本函数自己剥的。

### 4. metadata 承载设备树顺序

```ts
// packages/shared/src/ws-borsh/canonical-state.ts
export const SOURCE_FIELD_TREE_ORDER = 15;   // 值类型 U32，0 基序号

// packages/shared/src/ws-borsh/canonical-tree-order.ts，经 wsBorsh barrel 导出
export interface CanonicalTreeOrder { windows: Map<string, number>; panes: Map<string, number> }
export function createCanonicalTreeOrder(records?: readonly SourceMetadataRecord[]): CanonicalTreeOrder;
export function applyCanonicalTreeOrderPatch(
  order: CanonicalTreeOrder,
  upserts: readonly SourceMetadataRecord[],
  removals: readonly SourceEntityKey[]
): boolean;                                   // 返回是否发生变化
export function sortSnapshotByCanonicalTreeOrder(
  snapshot: StateSnapshotPayload,
  order: CanonicalTreeOrder
): StateSnapshotPayload;                       // 未变时返回同一引用
```

排序规则与被替换的 legacy overlay（`apps/gateway/src/ws/overlay-utils.ts` 的 `orderBySaved`）
逐例等价，测试里内置了该参考实现跑 200 组随机用例对拍：

- 带序号的实体按序号升序排在前；
- 不带序号的实体保持原有顺序（即 tmux index 顺序）追加在后；
- 指向已不存在实体的序号自动失效；
- 顺序表为空 → 原样返回（引用不变）；未被重排的 window 对象保持引用不变。

## 三、消费方使用指引

### gateway（L1b）

1. **播报能力**：`HELLO_S2C.capabilities` 已经是 `[...GATEWAY_CAPABILITIES]`，加了新常量后自动带上
   `canonical-state-v1.1`，无需改代码。仓库当前版本就是 1.1.22，不需要再按自身版本条件播报。
2. **记录客户端版本**：`apps/gateway/src/ws/index.ts:519` 的 `handleHello` 目前**丢弃了**
   `hello.clientVersion`。必须把它存进 `ws.borshState`，并用
   `wsBorsh.peerSupportsCanonicalV11(clientVersion)` 决定该会话是否按 v1.1 处理；
   不满足门槛的客户端不得收到只有 v1.1 才能正确消费的语义。
3. **处理 ResizePaneV11**：`decodeCanonicalCommandPayload` 已保证 `geometryReason ∈ {0,1}`、
   `sizeEpoch >= 1n`，handler 不必再校验合法性，只需：
   - 维护 `(GatewaySession, paneId) → lastSizeEpoch`（`bigint`）；`sizeEpoch < lastSizeEpoch` 直接丢弃，
     `>=` 则更新并处理（同 epoch 的 resend 要放行，否则补发失效）；
   - `geometryReason === CANONICAL_GEOMETRY_REASON_RESEND` 时才允许走
     `recordViewportClaim(..., { distrustLive: true })`；`CHANGE` 走现有去重路径
     （`applyWinnerGeometry` 按 live 几何去重）。
   - `apps/gateway/src/ws/index.ts:370` 的 canonical `resizePane` 回调签名需要加 `reason` 和 `sizeEpoch`
     两个参数（现在只有 deviceId/paneId/cols/rows/runtime），一路透到
     `apps/gateway/src/ws/tmux-geometry-handlers.ts` 的 `recordViewportClaim`。
4. **发 tree order**：在 `apps/gateway/src/tmux-client/metadata/hierarchy-builder.ts` 的
   `buildWindow` / `buildPane` 里，按该设备保存的 `DeviceTreeOrderRecord`
   （`order.windows.indexOf(window.id)`、`order.panes[window.id].indexOf(pane.id)`）
   写 `record.fields.set(wsBorsh.SOURCE_FIELD_TREE_ORDER, u32Value(index))`，`index < 0` 时不写该字段。
   顺序变更（`TMUX_REORDER_WINDOWS` / `TMUX_REORDER_PANES`）要触发对应记录的 field 更新，
   退出自定义顺序的实体写 `Unset`（不是不写——不写表示「未变」）。
   自定义名不需要新增任何东西：`SOURCE_FIELD_CUSTOM_NAME = 14` 已经在 v1 就随
   `MetadataProjection.setCustomName` 走 canonical 通路（已核对：window/pane 自定义名两条路径都只存内存，
   canonical 侧信息不比 overlay 少）。做完这一步就可以删掉
   `onDeviceAttached` 里给 canonical 会话补发的 `KIND_STATE_SNAPSHOT` overlay
   （`apps/gateway/src/ws/index.ts:350-362`）以及 `device-connection-registry.ts:249`。

### ws-client（L1c）

1. **发送侧**：`canonical-state-client.ts` 的 `sendResize` 改为发 `ResizePaneV11`：
   - 维护 `(deviceId, paneId) → sizeEpoch: bigint`，初值 `1n`；
   - `terminal-resize` → `geometryReason: CANONICAL_GEOMETRY_REASON_CHANGE` 且先 `epoch += 1n`；
   - `terminal-sync-size` → `geometryReason: CANONICAL_GEOMETRY_REASON_RESEND`，复用当前 epoch
     （pane 还没有 epoch 时用 `1n`，不要用 `0n`——会被编码侧拒绝）；
   - 之后就可以从 `websocket-transport.ts` 删掉 `isLegacySizeCommand` 白名单和
     `LEGACY_STATE_KINDS`，两类尺寸命令统一走 canonical。
2. **门槛判定**：在 `handleHelloNegotiated` 里，只有
   `hello.capabilities.includes(GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1) &&
   wsBorsh.peerSupportsCanonicalV11(hello.serverVersion)` 才可以按 v1.1 发送/依赖 tree order。
   `server-features.ts` 现有的「无法解析按新版处理」策略**不要**套用到 canonical v1.1。
3. **接收侧顺序**：`DeviceMetadataState` 里挂一个 `CanonicalTreeOrder`：
   - snapshot 路径（`assembleDeviceMetadata`）：`createCanonicalTreeOrder(deviceRecords)`；
   - patch 路径（`ingestMetadataPatch`）：`applyCanonicalTreeOrderPatch(order, upserts, removals)`；
   - 两处组装出 `StateSnapshotPayload` 后，把原来的 `this.overlays.apply(snapshot)` 换成
     `wsBorsh.sortSnapshotByCanonicalTreeOrder(snapshot, order)`。
   - 然后可以整体删除 `canonical-metadata-overlay.ts`、`handleLegacyOverlaySnapshot`
     以及 `MetadataLiveCaches.applyOverlay`。
   - 注意 `stores` 的 `metadata-patch` 分支自己又跑了一次 `applyLegacyStateSnapshotDiff`
     （`packages/stores/src/tmux-event-router.ts:177-186`），那条路径拿到的 snapshot 也要经同一次排序，
     否则 patch 之后顺序会掉回 tmux index 顺序——建议由 ws-client 统一在 `emitPatch` 前排好并直接下发排序后的 snapshot。

## 四、与任务书的两点偏差（已验证，请确认）

1. **没有把 `1.1` 编进 `protocolVersion`，也没有新增 canonical wire version 2。**
   EX2 建议 canonical wire version 升到 2；实际做法是「命令枚举尾部追加变体 + metadata 用新字段号」，
   `protocolVersion` 保持 1。理由：升 wire version 会让 v1 对端整条 canonical 流解码失败，
   而追加变体只在网关**主动**发 v1.1 命令时才可能被老对端看到（命令是 C2S，网关按会话门槛控制），
   metadata 新字段号则对 v1 完全透明。这样 mesh 里混版本的 hub/node 不会因为协议版本号不匹配整体断流。

2. **tree order 用新字段号（`fields` vec 内），没有给 `SourceMetadataRecordSchema` 追加结构体字段。**
   任务书写的是「在 struct 末尾追加字段」。实际做法是新增 `SOURCE_FIELD_TREE_ORDER = 15`，
   走既有的 `fields: b.vec(SourceMetadataFieldSchema)` 扩展点（`SOURCE_FIELD_CUSTOM_NAME = 14`
   当初也是这么加的）。理由：
   - 结构体追加字段会改变**每一条** metadata 记录的字节布局，v1 客户端一律解码失败；
     网关就必须按会话维护两套 metadata 编码，`canonical/transaction-sender.ts` 与
     `encoded-size.ts` 的复用/估算都要跟着分叉。
   - 字段号方式对 v1 是无声忽略：`sourceMetadataPatchToLegacyDiff` 会把 `[15, n]` 原样带出，
     `PANE_FIELD_SETTERS` / `WINDOW_FIELD_SETTERS` 查不到 15 就跳过。
     这一点有专门测试（`canonical-tree-order.test.ts` 的「TREE_ORDER 字段对 v1 消费方向前兼容」），
     断言应用后的 window/pane 对象键集合没有多出任何东西。
   - 结论：canonical 记录确实为 tree order 提供了「canonical home」，只是落在 fields 里而不是 struct 里。

3. **没有给命令加 fast-peek。** `peekCanonicalPaneDataHeader` 存在的唯一理由是 PaneData 热路径要零拷贝拿到
   游标；resize 命令频率极低且网关拿到的是 tagged union，加一个 `peekCanonicalResizePaneV11` 会是死代码。
   如需要请指挥官明确要求。

## 五、验证

- `cd packages/shared && bun test`：**565 pass / 0 fail**，55 个文件（基线 534，本任务 +28，其余 +3 来自 B1 并发新增的 relay 用例）。
- `bunx tsc --noEmit -p packages/shared`：**0 error**。
- `bunx tsc --noEmit -p packages/ws-client`：**0 error**（确认新导出没有打断下游类型）。
- `bunx biome check <本任务全部改动文件>`：干净。
- 仓库根 `bun run lint`：biome 报 3 个 format 错误，全部在 **B1 的文件**
  （`packages/api-client/src/relay/admin-api.ts`、`packages/shared/src/relay/enroll-proof.ts`、
  `packages/shared/src/relay/join-token.ts`）；复杂度门禁 1 条违规也在 B1 的
  `packages/shared/src/relay/codec.ts:385 parseByType CC 34 > 15`。本任务文件零违规，
  最大文件 `canonical-state.ts` 448 行。
- `bunx tsc --noEmit -p apps/gateway` 有报错，全部来自 B1 的 `TmexRoles` 新增 `relay` 字段，与本任务无关。

## 六、需要指挥官处理

- `packages/shared/src/index.test.ts`（主入口导出面快照）不在本任务显式 scope 内，但新增
  `GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1` 导出必然要求同步这张表，已做最小插入（一行）。
- 上面第四节的两点设计偏差如果不接受，改回「struct 追加字段 / wire version 2」需要同时改网关的
  per-session metadata 编码策略，属于 L1b 的工作量，请尽早决定。
