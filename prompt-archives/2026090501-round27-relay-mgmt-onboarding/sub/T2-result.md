# T2 结果 — 设置 → 多节点互联 → 本机卡「连接」段重构

分支 / worktree：`/Users/konata/code/tmex-r27`（`feat/round27-relay-mgmt-onboarding`）。全部改动落在任务给定的文件范围内，未跑任何 git 状态变更命令，未启动开发服务器。

## 基线（改动前实测）

- `cd apps/fe && bun test src/pages/settings/nodes src/node` → **1123 pass / 0 fail**（62 文件）。
- `cd apps/fe && bunx tsc --noEmit -p .` → **0 error**。

## 终态

- `bun test src/pages/settings/nodes src/node` → **1144 pass / 0 fail**（62 文件，3533 断言）。
- `bunx tsc --noEmit -p .` → 本任务范围 **0 error**（仅剩并发 agent 的 `src/components/side-panels/connect-devices/**` 报错，非本任务）。
- `bun test src`（apps/fe 全量单测）→ 2367 pass / 5 fail，**5 条全部在 `connect-devices/`**（`ComputerGuide`、`JoinSteps 的加入码`），与本任务无关。
- `bunx biome check`（本任务全部文件 + `nodes/relay/`、`nodes/uplink/` 目录）→ 无问题。
- `bun scripts/complexity/gate.ts` → 2 条违规均在 `apps/gateway/src/mesh/`（后端 agent 的文件），本任务文件全部通过。
- `bun run build:i18n` 已在仓库根跑过；`resources.ts` / `types.ts` / `locales/generated/*` 的变化是脚本重建的预期产物。

## 改了什么

### 新增

- `apps/fe/src/pages/settings/nodes/relay/relay-quota.ts` — 三档配额（节点 / 并发流 / 带宽）的纯函数 `relayQuotaRows()`：处理「旧中继无 `usage`」「带宽无上限」「`currentNodes` 两处都可能给」「带宽用量字段名还在演进」四种情形，用量经 `formatRate` 格式化，进度封顶 100%。
- `apps/fe/src/pages/settings/nodes/relay/use-relay-switch.ts` — 切换中继的控制器 `useRelaySwitch()`（`target` / `busy` / `request` / `dismiss` / `confirm`）＋ 纯错误映射 `relaySwitchErrorText()`。成功走 `toast.success`，失败走 `toast.error` + `relay.tenant.errors.*` 查表，兜底 `RELAY_SWITCH_FAILED`。
- `apps/fe/src/pages/settings/nodes/relay/relay-switch-dialog.tsx` — `RelaySwitchDialog` + 单独导出的文案路由 `relaySwitchDialogCopy(url)`（对话框走 portal 且实现按需到货，静态渲染看不到，沿用 `leaveDialogTitleKey` 那套「导出纯路由再断言」的做法）。

### 改动

- `apps/fe/src/node/mesh-relay.ts` — 新增 `switchMeshRelay(url, api)`：`POST /switch` 回来的状态就地写进 store（不等 30 s 轮询那一拍），失败原样抛出；`UseMeshRelayResult` 增 `switchRelay(url)`。
- `apps/fe/src/pages/settings/nodes/relay/relay-rows.tsx` — 整块重写：
  - 去掉外层 ring 方框，一行 = 地址 pill（`font-mono`，只包住主机文本）+ 唯一一枚状态徽标（在线 `default` 变体显示 `延迟 N ms`，`rttMs` 未知显示 `在线`；离线 `outline` 变体显示 `离线`）。
  - 删掉「当前挂载于此中继」整句与独立的延迟格。
  - `≥ 2` 条时行可选：当前挂载那条 pill 加 `ring-primary` + `Check` 图标 + `aria-current="true"`；其余是原生 `<button type="button">`（键盘可达），点击回调交给 `onSelect`。恰好 1 条时无按钮语义、无 `aria-current`。
  - 新增纯函数 `relayLinkErrorKey(relay)`：仅在**离线且有错**时返回 `relay.tenant.linkErrors.<code>`；未知码或只有原始 `lastError` 一律落到 `unknown`，原始错误串永不上屏。`relayFailing()` 改为 `kicked || (!online && 有错)`。
- `apps/fe/src/pages/settings/nodes/uplink/relay-uplink-panel.tsx` — 接入 `useRelaySwitch` + `RelaySwitchDialog`，`RelayRows` 传 `onSelect`；菜单动作去掉 `rotate` 分支。
- `apps/fe/src/pages/settings/nodes/uplink/relay-targets.ts` — `RelayMenuAction.kind` 收成 `'reauth' | 'remove'`（`url` 随之变必填），菜单不再产出「轮换元数据密钥」。
- `apps/fe/src/pages/settings/nodes/relay/use-relay-actions.ts` — `RelayConfirmIntent` 去掉 `'rotate'`，`runConfirmAction` / `DONE_KEYS` 同步收敛，`appendMetaKey` 导入删除（后端 API 未动）。
- `apps/fe/src/pages/settings/nodes/relay/relay-dialogs.tsx` — 确认框去掉 rotate 分支，确认按钮固定 `destructive`。
- `apps/fe/src/pages/settings/nodes/connection-details.tsx` — 行序改为 `租户编号 → 本机编号 → 可访问节点 → 节点 → 并发流 → 带宽 → Hub 明细`；删掉「元数据密钥代数」「密钥日志」两行；配额改由 `relayQuotaRows()` 驱动，每档 `used / max` + `max > 0` 时带 `Progress`（testid `nodes-relay-quota` / `-streams` / `-bandwidth`，进度条 `<testid>-bar`）。

### i18n（`zh_CN` / `en_US` / `ja_JP` 三份同步，仅动本任务归属的子对象）

- 新增 `relay.tenant.linkErrors.*`（11 个错误码）、`relay.tenant.switch.{title,description,confirm,done}`、`relay.tenant.strip.error`。
- 新增 `relay.tenant.errors.{RELAY_UNKNOWN,RELAY_KICKED,RELAY_ALREADY_ATTACHED,RELAY_SWITCH_FAILED}`。
- 删除 `relay.tenant.strip.{attached,lastError}`、`relay.tenant.actions.rotate`、`relay.tenant.metaKey.{rotateTitle,rotateDescription,rotateConfirm,rotateFailed}`（`rotateFailed` 本就无调用方）、`nodes.machine.details.{metaEpoch,quota,streams,keyLog,keyLogCaughtUp,keyLogBlocked}`。
- 新增 `nodes.machine.details.{quotaNodes,quotaStreams,quotaBandwidth,quotaUnlimited}`。
- 文案：`nodes.machine.details.nodesViaRelay` → 可访问节点 / Reachable Nodes / 到達可能ノード；`nodeId` → 本机编号 / This machine's ID / 本機の ID；`relay.tenant.actions.menu` → 更多 / More / その他；`relay.tenant.metaKey.pending` → 「成员密钥更新尚未送达（{{count}} 条）。」＋ 重试；`metaKey.needsRotate` 改为指向提示条重试（旧文案指的菜单项已不存在）。
- 全族「口令 → 接入密码」：`strip.kicked`、`reauth.{notice,action}`、`actions.{reauth,reauthOne}`、`dialog.{reauthTitle,password,passwordHint,reauthNotice}`、`errors.{RELAY_PASSWORD_INVALID,RELAY_PASSWORD_REQUIRED,RELAY_TENANT_KICKED,RELAY_TOKEN_INVALID}`、`nodes.machine.relayServiceEnrollHint`；「元数据密钥 → 成员密钥」贯穿 `metaKey.*` 与两条 `RELAY_META_KEY_*`。
- 三份 locale 的 key 集合已校验一致（差异只有原有的 `_one` / `_other` 复数形态）。

### 测试

- `relay/relay-ui.test.tsx`：改掉断言原始 `ECONNRESET` 的用例；新增「11 个错误码逐条查表」「未知码/裸 `lastError` 归 unknown」「在线或无错不出错误行」；`RelayRows` 渲染用例改成新版式（地址 pill + 单枚徽标、无 `strip.attached`、无外框），新增「单条不可选」「多条时 `aria-current` + 切换按钮」「未传 `onSelect` 则都不可选」；新增「切换对话框文案路由」「切换失败文案」；新增「三档配额」5 个用例（有用量 / 网关合计带宽 / 无用量 / 无上限 / 超额封顶）；菜单用例去掉 `rotate`。
- `connection-details.test.tsx`：新增 `RELAY_WITH_USAGE` 夹具；改写中继模式用例；新增「本机编号紧跟租户编号」顺序断言、「元数据代数与密钥日志一格不剩」、「三档进度条」、「旧中继只剩上限」、「无配额三格不出现」。
- `uplink/relay-uplink-panel.test.tsx`：补 `switchRelay` / `lastErrorCode` 夹具字段；新增「单条不可选、多条给切换入口」；菜单渲染断言去掉 `rotate`。
- `local-machine-card.test.tsx`：中继模式用例补新版行结构断言（host / status testid、无 `strip.attached`、单条无切换按钮）；新增「两条中继给出切换入口 + `aria-current`」。
- `src/node/mesh-relay.test.ts`：新增 `switchMeshRelay` 两个用例（成功就地写 store / 失败原样抛出且链路不动）。

## 新增 / 变更的 data-testid

- 新增：`nodes-relay-host-<host>`、`nodes-relay-status-<host>`、`nodes-relay-switch-<host>`、`nodes-relay-switch-dialog`、`nodes-relay-switch-cancel`、`nodes-relay-switch-ok`、`nodes-relay-streams-bar`、`nodes-relay-bandwidth-bar`、`nodes-relay-bandwidth`。
- 删除：`nodes-relay-online-<host>`、`nodes-relay-rtt-<host>`、`nodes-relay-attached-<host>`、`nodes-relay-meta`、`nodes-relay-key-log`、`nodes-relay-rotate`。
- 保持不变：`nodes-relay-row-<host>`（含 `data-relay-attached/online/failing`）、`nodes-relay-kicked-<host>`、`nodes-relay-error-<host>`、`nodes-relay-empty`、`nodes-relay-rows`、`nodes-relay-quota`、`nodes-relay-quota-bar`、`nodes-relay-streams`、`nodes-relay-peers`、`nodes-relay-tenant-id`、`local-machine-node-id`。已确认 `apps/fe/e2e` 未引用任何被删的 testid。

## 未尽 / 需要注意

1. **`usage.bandwidthBytesPerSec` 仍是「可选的额外字段」**。`packages/api-client` 归后端 agent，`RelayQuotaUsage` 目前没有这个字段，`relay-quota.ts` 里用一次窄化断言读它；后端补上类型后可以把那处断言删掉（`bandwidthUsed()` 一行）。缺该字段时按 `max(bytesInPerSec, bytesOutPerSec)` 回退，已有用例覆盖两条路径。
2. **切换的错误码依赖后端**。`RELAY_UNKNOWN` / `RELAY_KICKED` / `RELAY_ALREADY_ATTACHED` 三个 code 的文案已就位，实际由后端 `POST /api/mesh/relay/switch` 下发；对不上时统一落到 `RELAY_SWITCH_FAILED`，不会露出裸 code 以外的东西。
3. **切换成功后除了就地写 store 还会再触发一次 `relay.refresh()`**（`useRelaySwitch({ onChanged: refresh })`），拿一份服务端确认的快照；`refreshMeshRelay` 自带 in-flight 去重，不会叠请求。
4. **「轮换元数据密钥」的手动入口已彻底移除**，补发路径只剩自动的 `metaPending` 提示条 + 重试（`use-relay-pending`）；`packages/api-client` 的 `metaKeyPrepare({op:'rotate'})` 与 `auth/account-security-actions.ts` 的改密轮换路径原样保留，未触碰。
5. `apps/fe` 全量单测里 `connect-devices/` 的 5 条失败与 `apps/gateway/src/mesh/` 的 2 条复杂度违规均来自并发 agent，本任务未介入。
