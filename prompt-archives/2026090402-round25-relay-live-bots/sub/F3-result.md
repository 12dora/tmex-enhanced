# F3 结果：Hub 待批准节点一键批准 + enrollment fan-out 只用接受方

## 一、改了什么

### 1. `HubNodeRow` 类型与解析

- `apps/fe/src/node/hub-api.ts`
  - 新增 `HubAdmissionStatus`（`pending | admitted | revoked`）与 `HubNodeRow` 的
    `admission_status` / `enrollment_id` / `authorization` / `authorization_sig`（`certificate` /
    `cert_sig` 已有）。
  - 新增 `hubAdmissionStatus(row)`：缺失或未知值一律折成 `admitted`（旧 Hub 行为完全不变）。
  - 新增 `normalizeHubNodeRows(rows)`，`listNodes()` 出口统一走它：补齐 `admission_status`，
    并把空串 / 非字符串的 admit 材料抹成 `undefined`（畸形材料留到签名那一步才炸没有意义）。
  - 新增 `EnrollmentRelayResult`，`HubEnrollmentCreated.relays?: string[] | EnrollmentRelayResult[]`
    ——中继 enrollment 的 fan-out 结果（hub 模式不下发）。

### 2. `mergeNodes()` 支持「待批准」行

- 新增 `apps/fe/src/node/merge-nodes.ts`：`mesh-nodes.ts` 原本已是 779 行、门禁存量上限 780，
  按任务书要求把 `mergeNodes` 及其纯函数（`publicKeyFingerprint` / `toRuntimeNodeId` /
  `sortNodes` / `NodeRow` / `reachOf` / `transportOf` / `rttOf`）整段迁到新文件。
  `mesh-nodes.ts` 只留一段 re-export，行数 779 → 665，`useHubNode` / 轮询逻辑一行未动。
- `NodeRow` 新增三项（都可选，测试夹具不必补）：`admissionStatus`、`pending`、`admitMaterial`。
- `mergeNodes()` 现在在已接纳成员之后追加 hub 独有的 `admission_status === 'pending'` 行：
  `online:false`、`pending:true`、无版本 / 无 inventory / 未登录、`runtimeNodeId` 就是它自己
  （绝不退化成 `self`）、名字取 hub 行（去空白后为空则用 id 前 8 位）。mesh 里已有的同一台
  永不重复列出；hub 列表为 `null`（不可达）或旧 Hub 不下发字段时一行都不追加。

### 3. 节点表：「待批准」徽标 + 「批准加入」

- 新增 `apps/fe/src/pages/settings/nodes/management/pending-node-row.tsx`：待批准行的独立组件
  （`NodeRowView` 在门禁 allowlist 上是 cc 19 / 123 行，一行都加不得，故整行另起组件）。
  - 状态列显示 `nodes.status.pending`（`data-admission="pending"`）；
  - 动作列只有「批准加入」可用，「更多」「移除」渲染为禁用并给出原因；升级按钮不渲染
    （待批准节点没有 peer link）；勾选框禁用；
  - `selectableRows()` 排除 `pending` 行，批量升级 / 移除 / 卸载都碰不到它。
- 新增 `apps/fe/src/pages/settings/nodes/management/row-cells.tsx`：`Th` / `Td` / `Tag` /
  `rowBlockedHint` 从 `nodes-table.tsx` 抽出来共用，避免两个行组件互相 import 形成循环。
  `nodes-table.tsx` 468 行（原 497）。
- `nodes-table.tsx` 只改了 `rows.map()` 的分发（`row.pending ? <PendingNodeRow/> : <NodeRowView/>`）
  与 import；`NodeRowView` 本体一行未动。

### 4. `admitPendingNode(row)`

- 新增 `apps/fe/src/node/admit-pending-node.ts`：
  `prompt.request({ purpose:'admit', reuse:true })` → `withKeyLogLock` → `buildAdmitNodeRecord()`
  → `submitAdmitRecord()`（内部即 `?hub=sync`）。
  - 手上还留着未确认字节时**只重发那一份**、不再要凭据、不重签（重签会按已推进的 head 造出
    新 seq，Hub 缺中间那条就永久 `seq_gap`）；
  - 构造签名那一小段用 `leaseSigner()` 上租约，网络提交期间不占根钥；
  - 返回 `AdmitDisposition | no-material | cancelled | failed`。
- `apps/fe/src/pages/settings/nodes/management/use-node-row-actions.ts` 新增 `useAdmitNode(row, deps)`
  与 `reportAdmitResult()`：成功复用 `nodes.enrollment.admitted`，Hub 未确认复用
  `nodes.enrollment.hubNotConfirmed`（warning，不是失败），`stale` 复用
  `nodes.enrollment.staleRecord`，其余走新增的 `nodes.admit.failed` / `nodes.admit.unavailable`；
  成功后调 `onChanged()`（即页面的 `refreshAll`，同时重拉 hub 行与 mesh 节点）。

**与任务书的一处偏差**：helper 没有放进 `enrollment.ts` / `enrollment-engine.ts`。这两个文件的
门禁存量分别是 776 / 881 行（当前 775 / 871），塞不下；而在 `enrollment-engine.ts` 里加
re-export 会与 `admit-pending-node.ts` 依赖的 `withKeyLogLock` 形成循环 import。因此单独成文件，
消费方直接 `import { admitPendingNode } from '@/node/admit-pending-node'`。

### 5. `relay-join.ts`：只把接受了的中继写进 r3

- `createEnrollmentOnRelay()` 建完 enrollment 后按响应 `relays` 分三档：
  - **新形态**（对象数组）：只取 `accepted:true` 的；条目自带 `token` 就用它，没带就按 url 回查
    join-material；一台都没接受（或接受了但全都取不到令牌）时抛错，`code` 为
    `RELAY_ENROLLMENT_NO_RELAY`，message 里带上逐台原因。
  - **旧形态**（`string[]`）：全部当作已接受；令牌按地址回查，地址表超出手头这一份时才多问一次
    `join-material?scope=all`（少一次无谓请求）。
  - **缺失**（当前节点从不下发）：行为与从前完全一致，只带当前 attach 的那一台。
- `errors.ts` 把 `RELAY_ENROLLMENT_NO_RELAY` 映射到 `nodes.enrollment.relayNoneAccepted`
  （这个码不在 `auth.errors` 表里，不映射就会把原始英文 message 甩给用户）。

### 6. 文案（三语，均按 `tmex-copy-guidelines.md`）

新增 key（`packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`）：

| key | zh_CN | en_US | ja_JP |
|---|---|---|---|
| `nodes.status.pending` | 待批准 | Pending | 承認待ち |
| `nodes.actions.admit` | 批准加入 | Admit | 参加を承認 |
| `nodes.admit.blocked` | 须先批准加入，才能管理这台节点。 | Admit this node before managing it. | 先に参加を承認してください。 |
| `nodes.admit.unavailable` | Hub 未下发批准所需材料，请刷新后重试。 | Hub did not send the material needed to admit this node. Refresh and try again. | 承認に必要な情報が Hub から届いていません。更新してからもう一度お試しください。 |
| `nodes.admit.failed` | 批准失败：{{error}} | Admit failed: {{error}} | 承認に失敗しました：{{error}} |
| `nodes.enrollment.relayNoneAccepted` | 中继未接受加入码，请检查中继连接后重试。 | No relay accepted the join code. Check the relay connection and try again. | 中継が参加コードを受け付けませんでした。中継の接続を確認してからもう一度お試しください。 |

生成物（`resources.ts`、`locales/generated/*.json`）**没有重建**（按共同规则由指挥方统一跑）。

## 二、文件清单

新增：

- `apps/fe/src/node/merge-nodes.ts`、`merge-nodes.test.ts`
- `apps/fe/src/node/admit-pending-node.ts`、`admit-pending-node.test.ts`
- `apps/fe/src/pages/settings/nodes/management/pending-node-row.tsx`、`pending-node-row.test.tsx`
- `apps/fe/src/pages/settings/nodes/management/row-cells.tsx`

修改：

- `apps/fe/src/node/hub-api.ts`、`hub-api.test.ts`
- `apps/fe/src/node/mesh-nodes.ts`（只删掉迁走的纯函数段 + 一段 re-export）
- `apps/fe/src/node/relay-join.ts`、`relay-join.test.ts`
- `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx`
- `apps/fe/src/pages/settings/nodes/management/use-node-row-actions.ts`
- `apps/fe/src/pages/settings/nodes/management/bulk-actions-menu.tsx`
- `apps/fe/src/pages/settings/nodes/management/errors.ts`
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`

未触碰：`hub-uplink-panel.tsx`、`local-uplink-tabs.tsx`、`node-names.ts`、`node-runtimes.ts`、
任何后端文件、任何生成文件。

## 三、验证

| 项 | 命令 | 结果 |
|---|---|---|
| 本任务范围测试 | `cd apps/fe && bun test src/node src/pages/settings/nodes` | 1015 pass / 0 fail（新增 26 个用例：merge-nodes 8、admit-pending-node 7、pending-node-row 6、hub-api 4、relay-join 6，其中 relay-join 已有 2 个保留） |
| fe 全量单测 | `cd apps/fe && bun test src` | 2096 pass / **1 fail**，见下 |
| 类型 | `cd apps/fe && bunx tsc --noEmit -p .` | 0 error（基线 0） |
| Lint | `bunx biome check <本任务 16 个文件>` | 0 error |
| 复杂度门禁 | `bun scripts/complexity/gate.ts` | 本任务文件全过，未改 allowlist（`toAdmittedRow` 一度 CC 17，已拆成 `isEntryNode` / `isHubNode` / `hubColumns` 降到 9） |

## 四、遗留与注意事项

1. **必须跑一次 i18n 生成**：`bun run --filter @tmex/shared build:i18n`。在此之前
   `packages/shared/src/i18n/locale-consistency.test.ts` 的两条「生成物同步」用例与
   `apps/fe/src/i18n/core-coverage.test.tsx` 的一条会失败——差异**只**包含本任务新增的 6 个 key
   （已逐条核对 diff）。三语 key 集合一致性用例本身是通过的。
2. `bun scripts/complexity/gate.ts` 在仓库整体上仍失败 3 条，全部来自并行进行的其他任务
   （`apps/gateway/src/auth/user-store.ts`、`packages/app/src/runtime/setup-service.ts:joinHub`、
   `packages/app/src/commands/hub.ts`），与本任务无关。
3. `admitPendingNode` 的落点见上文「与任务书的一处偏差」。
4. 后端契约尚未落地，本任务全部按契约用 fake 测试。后端上线后需要真机复测的点：
   - `GET /n/<hub>/api/hub/nodes` 的 pending 行是否真的带全 `enrollment_id` /
     `authorization` / `authorization_sig` / `certificate` / `cert_sig`（缺一项按钮就会灰掉并提示
     `nodes.admit.unavailable`）；
   - `POST /api/mesh/relay/enrollments` 的 `relays` 是否按契约给 `tenantId` 与 accepted 条目的
     `token`（不给 `token` 时前端会按 url 回查 join-material，回查不到该条就被丢弃）。
5. 中继模式下没有 hub 节点列表，待批准行天然不会出现，未做任何特判。
