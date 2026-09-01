# O1b — Frontend review fixes 结果

RV1 的 5 条前端结论（#4/#5/#6/#7 + api-client 类型）全部落地，附带测试与三语文案。

## 1. 入口自身可以参与批量升级（RV1 #4）

- `nodes-management.tsx` 新增纯函数 `bulkUpgradeTargets(selected, selfRow, latestVersion)`：勾选非空且本机确实可升级时，把本机行**追加在选中行之后**；本机行仍然**不可勾选**（`selectableRows` 未动，移除 / 卸载依旧碰不到它）。空选择不追加，菜单继续停在「须先勾选节点」。
- `BulkActionsMenu` 新增 `selfRow` 入参，`onUpgrade` 改为 `upgrade.startAll(targets.rows)`；标签在含本机时切到 `nodes.selection.upgradeWithSelf`（「升级（{{count}}，含本机）」），否则仍是 `nodes.selection.upgrade`。
- `bulkMenuStates` 新增入参 `selfIncluded`：可点时 title 给一句 `nodes.selection.upgradeSelfNotice`（本机排在最后升级、页面会短暂断开）。
- 这样 `orderUpgradeGroups` 的「普通节点 → 远端 hub → 本机」持久化次序与入口重启后的续跑路径重新可从 UI 触发。

**一处对 prompt 的偏离（请复核）**：判定本机是否可加入用的是 `isBatchEligible(selfRow, latest)` 而不是 `upgradeBlockReason(selfRow, latest) === null`。理由：`launchUpgradeBatch` 内部本来就用 `eligibleUpgradeRows`（= `isBatchEligible`）筛一遍，两者只在「本机版本无法解析（如 `1.1.12_dev`）」时分叉——那种情况用宽判据会让标签写着「含本机」而批量转头把它筛掉，标签就成了假话。行为上两种判据完全一致，只有标签诚实度的差别。已在代码里留注释说明。

## 2. 卸载必须有可写 hub（RV1 #5）

- `bulkMenuStates.uninstall`：`!writable` 时禁用并给 `nodes.hubOffline` / `nodes.hubs.standbyNotice`（与「移除节点」同一条 `blockedHint`）。
- `UninstallDeps` 新增 `writable`；hook 里用 ref 跟住最新值（整批跑起来后 hub 随时可能掉线，不能用点确认那一刻的快照）。
- `UninstallBatchParams` 新增必填 `canWrite()`，`runUninstallBatch` **每台开跑前**重新确认；不可写就地 `break`，把没轮到的台数记进新字段 `UninstallBatchSummary.aborted`。已受理的节点保留 `uninstalling` 记录（不做任何回滚），用户回头仍可吊销。
- `uninstallSummaryText`：`aborted > 0` 时走新键 `nodes.uninstall.summaryAborted`（error 档），说清「已卸几台 / 剩几台停下」。单台失败原来就有即时 toast，不受影响。
- 表内没有单行卸载入口（只有批量菜单），所以菜单这一道闸即覆盖全部入口。

## 3. 另一个标签页占着 live plan（RV1 #6，前端部分）

- `upgrade-batch-storage.ts` 导出三个纯函数：`batchPlanKey(entryNodeId)`、`batchOwnedByOtherTab(entryNodeId, tabId, now)`（存在计划且 `!canAdoptBatchPlan` → true）、`isBatchPlanStorageEvent(entryNodeId, key)`（`key === null` 即整片清空也算）。
- `useNodeUpgrade.startAll`：进 `launchUpgradeBatch` 之前先判 `batchOwnedByOtherTab`，命中则只弹一条 info `nodes.upgrade.allOtherTab`（「另一个标签页正在批量升级。」）并返回。
- 新增 `storage` 事件监听：命中本入口的计划键时把 `planRef` 置回 `undefined` 并重跑 `tryResumeBatch`——早先读到 `null` / 外来 owner 的标签页，在持有者收尾或换手后能接管。
- **未做**（超出本任务范围，属后端）：带租约的服务端互斥。localStorage 仍不是真锁；持有者标签页被直接关掉（不触发 storage 事件）时，本页仍要等下一次事件才可能接管。

## 4. `connector.reachable === false` 不再等于「无连接」（RV1 #7）

- `tunnel-model.ts` `connectorState`：`reachable === false` → `unknown`（原来是 `noConnections`）。只有 `reachable === true && readyConnections === 0` 才是 `noConnections`；`tunnelDegraded` 仍另认后端 `process.state === 'degraded'`。
- `host-status.ts` `tunnelDegraded`：改成 `connector?.reachable !== true` 一律不判降级。
- 文案：`settings.remoteAccess.connector.unknown` 由「无法探测（未找到 metrics 端点）」改为「无法探测（metrics 端点不可达）」（en/ja 同步），因为这一档现在同时覆盖「没找到端点」和「找到了但探不通」。

## 5. api-client 的 `authorization`

- `packages/api-client/src/auth/types.ts`：新增 `HubAuthorizationKind = 'signed' | 'env' | 'self'` 与交集类型 `MeshHubEndpoint = HubEndpointInfo & { authorization?: HubAuthorizationKind }`；`MeshHubsResponse.hubs` 改用它。`@tmex/shared/uplink` 的 `HubEndpointInfo` 未动。
- `auth-api.ts` `listHubs()` 对 `hubs` 本来就是整段透传，字段自然带出（新增断言覆盖：有 `authorization` 的原样出、旧后端不下发时为 `undefined`）；未加多余的归一化代码。
- `apps/fe/src/node/mesh-hubs.ts`：`MeshHubsState.hubs` / `writerHub()` 改用 `MeshHubEndpoint`。
- `hub-strip.tsx`：新增 `hubAuthorizationText`，`hubChipTitle` 在地址那一行之后插入「授权：已签名 / 环境变量 / 本机」，失败诊断两行仍排在最后；旧后端不下发时不多这一行。新键 `nodes.hubs.authorization.{label,signed,env,self}`。

## 改动文件

前端：
- `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx` / `.test.tsx`
- `apps/fe/src/pages/settings/nodes/management/use-node-uninstall.ts`
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts` / `.test.ts`
- `apps/fe/src/pages/settings/nodes/management/upgrade-batch-storage.ts` / `.test.ts`
- `apps/fe/src/pages/settings/nodes/management/hub-strip.tsx` / `.test.tsx`
- `apps/fe/src/node/mesh-hubs.ts`
- `apps/fe/src/pages/settings/remote-access/tunnel-model.ts` / `.test.ts`
- `apps/fe/src/components/side-panels/connect-devices/host-status.ts` / `.test.ts`

api-client：
- `packages/api-client/src/auth/types.ts`
- `packages/api-client/src/auth/auth-api.test.ts`

文案（三语同步 + `bun run --filter @tmex/shared build:i18n` 重新生成）：
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`
- 生成物 `packages/shared/src/i18n/{resources.ts,types.ts}`（未对其做 lint/format）

新增文案键：`nodes.selection.upgradeWithSelf`、`nodes.selection.upgradeSelfNotice`、`nodes.upgrade.allOtherTab`、`nodes.uninstall.summaryAborted`、`nodes.hubs.authorization.{label,signed,env,self}`；改写 `settings.remoteAccess.connector.unknown`。

## 验证

| 项 | 基线 | 现在 |
|---|---|---|
| `cd apps/fe && bun test src/` | 1331 pass / 0 fail | **1346 pass / 0 fail**（+15 用例） |
| `cd apps/fe && bunx tsc --noEmit -p .` | 0 | **0** |
| `cd packages/api-client && bun test` | 140 | **140 pass / 0 fail** |
| `cd packages/api-client && bunx tsc --noEmit -p .` | 5（既有） | **5**（同样 5 条，均在 `client.test.ts` / `files-download.test.ts`，与本次改动无关） |
| `bunx biome check <改动文件>` | — | 全部通过（`hub-strip.tsx` 与 `use-node-upgrade.test.ts` 用过一次 `--write` 格式化） |
| `cd packages/shared && bun test src/i18n` | — | 2 pass / 0 fail |

未跑 git 任何命令；只改了任务范围内的文件（`git status` 里 `apps/gateway/**` 的变更属并行的后端 agent）。
