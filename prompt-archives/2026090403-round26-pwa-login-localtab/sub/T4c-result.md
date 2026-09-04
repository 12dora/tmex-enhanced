# T4c 结果：中继角色（relay / relay,node）的本机卡两处纠正

## 背景

现网新建的 `relay,node`（本机跑着中继、但还没以租户身份接入自己的中继）上，后端
`GET /api/mesh/relay/status` 返回 `mode: "hub"`（`relays: []`、`tenantId: null`），
`GET /api/mesh/hubs` 还给一条 `http://127.0.0.1` 的占位候选。本机卡照 hub 形态摆版，于是：

1. 卡头徽标说「未连接 Hub」（红字）；
2. 「连接」段给出 hub 时代的「改为接入中继」+「接入后本机改走中继，不再连接 Hub」，
   而真正该给的「接入本机中继」CTA 因为闸门是 `relay.mode === 'none'`，在 `mode: "hub"` 下
   **一处都没出现**。

## 改动

### 1. 状态徽标按角色分档（`machine-status.ts`）

- `MachineStatusInput` 新增 `relayRole: boolean`（本机角色是 `relay` / `relay,node`）。
- 判定顺序改成 `standalone → 角色未知 → (relayRole || relayMode) → hub`：
  中继角色一律走中继那一档，**任何情况下都不会说出 Hub 的话**（hub 快照说挂上了、首次探测在飞
  都不借用 `hubConnected` / `connecting`）。
- 中继那一档抽成 `relayBadge()`：`kicked → relayKicked(warn)`、`attached → relayConnected[·N ms]`、
  其余 `relayDisconnected`；**tone 按角色分**——中继角色是 `muted`（刚建好还没接入是预期状态，
  纯中继甚至永远不会接入），普通节点走中继却没挂上仍是 `warn`（那是故障）。
  令牌失效保持 `warn`：那不是「刚建好」，是要人动手。
- 「已连接」现在要求**挂上且在线**：调用点传 `attachedRelay?.online === true`，
  延迟也按 `relayRole || relayMode` 决定取中继链路还是 hub 候选的 rtt。

### 2. 「连接」段的三种形态（`uplink/uplink-section.tsx`）

`UplinkSection` 的 mesh 分支抽成 `MeshUplink`，三种形态互斥、各自 early return：

| 形态 | 内容 |
| --- | --- |
| `relay.mode === 'relay'` | `RelayUplinkPanel`（链路行 / 提醒堆 / 三级操作），**完全未改** |
| 中继角色且 `mode !== 'relay'` | 只有 `SelfRelayEntry`：一句灰字 `nodes.machine.relayServiceEnrollHint`（「本机尚未接入自己的中继。接入时须再次输入刚设置的接入口令。」）+ CTA「接入本机中继」 |
| 其余 mesh 角色 | `HubUplinkPanel` + 原来的 `RelayEntry`（含「改为接入中继」），未改 |

- `SelfRelayEntry` 从 `relay-service-section.tsx` 搬到这里（**全卡只此一处**，`RelayServiceSection`
  的 `showSelfEnroll` / `highlightSelfEnroll` / `onEnrollSelf` 三个入参一并删除，props 只剩 `service`）。
  搬到「连接」段的理由：它回答的是「本机接到哪儿」，而「中继服务」段说的是本机对外提供的服务。
- CTA 仍走原来的 `RelayEnrollDialog`（`relayActions.openEnroll('enroll', url)`），
  地址预填 `status.relay?.publicUrl`；按钮上多一个 `data-relay-url` 便于断言预填值。
- `relay.unsupported`（旧节点没有这族路由）时整块不出现，与 `RelayEntry` 同一处理。
- 刚设置完中继兼节点的高亮（`selfRelayFollowUp`）随之从 `RelayServiceSection` 移到
  `UplinkSection`，`NodesTab → LocalMachineCard → LocalMachineBody` 的传递链未变。

### 3. 连接详情

`ConnectionDetailsContent` 的 hub 明细本来就由 `hubs.hubs.length > 0` 把关，占位候选进的是
`candidates` 而不是 `hubs`，所以这个状态下**不会**渲染优先级 / 纪元行——补了一条按现网形状
（`mode:'hub'` + 一条 `http://127.0.0.1` 候选 + 空集合）的用例把它钉住，此时详情里只剩本机节点编号。

### 4. 复杂度

抽出的 `machineBadge()`（`local-machine-card.tsx` 模块级纯函数）把徽标入参的拼装从组件里移走，
`LocalMachineCard` 的 CC 回到门禁内（加完角色判定后一度 17 > 15）。未动 allowlist。

## 文件

改：
- `apps/fe/src/pages/settings/nodes/machine-status.ts`（+ `.test.ts`）
- `apps/fe/src/pages/settings/nodes/local-machine-card.tsx`（+ `.test.tsx`）
- `apps/fe/src/pages/settings/nodes/local-machine-body.tsx`
- `apps/fe/src/pages/settings/nodes/relay-service-section.tsx`
- `apps/fe/src/pages/settings/nodes/uplink/uplink-section.tsx`（+ `uplink/relay-uplink-panel.test.tsx`）
- `apps/fe/src/pages/settings/nodes/connection-details.test.tsx`

**i18n 未增删任何键**：需要的 `nodes.machine.relayServiceEnrollHint` / `relayServiceEnroll` 已经存在
（三语齐全），因此没有跑 `build:i18n`，locale 文件未被本任务改动。

## 测试

新增用例（共 +16）：

- `machine-status.test.ts`：中继角色 × mode(none/hub/relay) × 挂上/在线/踢出的 7 条
  （hub 快照说挂上了也只说中继、hub 在飞不借「连接中」、未接入是灰字、挂上带延迟、
  令牌失效仍是红字、普通节点未挂上仍是红字、角色未知压过一切）。
- `local-machine-card.test.tsx`：现网那副状态下 CTA 恰好一处且预填本机中继地址、
  hub 入口/迁移提示/更换 Hub/「未连接」行一个不剩；徽标是 `relayDisconnected` 且是 outline 档；
  纯 `relay` 同样不摆 Hub 的话；接上之后换回链路面板且 CTA 归零；挂着的那条中继离线不算已连接。
- `relay-uplink-panel.test.tsx`：`SelfRelayEntry` 的四条（文案/预填地址/高亮/旧节点不出现）
  与「链路面板里没有这个 CTA」。
- `connection-details.test.tsx`：现网形状下不出 hub 优先级 / 纪元。

复核（全部在 `/Users/konata/code/tmex-r26`）：

- `apps/fe` `bun test src/`：**2294 pass / 0 fail**（`src/pages/settings/nodes/` 712 pass / 0 fail）
- `apps/fe` `bunx tsc --noEmit -p .`：**0 错误**
- `bunx biome check apps/fe/src/pages/settings/nodes`：干净
- `bun scripts/complexity/gate.ts`：**complexity gate ok**（1516 files / 13579 functions，0 违规 0 stale）

## 取舍与遗留

1. 「未接入中继」对中继角色一律给 `muted`——按任务要求的字面执行。副作用：一台**已经接入过**
   自己中继、随后链路掉了的 `relay,node`，卡头也只给灰字（故障细节仍在链路行的红字与提醒堆里）。
   若认为掉线该红，把 `relayBadge` 里的 tone 条件改成 `relayRole && !input.relayMode` 即可。
2. CTA 沿用 `size="xs" variant="outline"`，与卡内其余按钮同一套语言；如果要它更像主按钮，
   改 `variant="default"` 一处即可（高亮态的底色是 `bg-primary/10`，实心主按钮也压得住）。
3. 未起临时实例、未跑 Playwright e2e（按 common rules）。这几段版式建议在合并后的开发实例上
   按 390px 截一次图核对换行。
