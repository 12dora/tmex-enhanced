# O1 结果 — 节点管理：多选、批量「更多」菜单、远程卸载 UI、Hub 候选诊断

## 1. 做了什么

### 1.1 UI kit：`Checkbox`

- 新增 `packages/ui/src/components/checkbox.tsx`，基于 `@base-ui/react/checkbox`（已装版本 1.2.0，`Checkbox.Root` / `Checkbox.Indicator` 两段），Tailwind 类与 `switch.tsx` 对齐（`data-checked` / `data-indeterminate` / `data-disabled` 驱动，`duration-(--tmex-motion-fast)`，`after:-inset-2` 扩大点击区）。
- Root 渲染的是带 `role="checkbox"` 的 `<span>` + 隐藏 input（`nativeButton = false`），**不是 `<button>`**：测试里判定禁用要看 `aria-disabled="true"`，不能看 `data-disabled`（类名里就有 `data-disabled:opacity-50`）。
- 新增 `packages/ui/src/components/checkbox.test.tsx`（5 个静态渲染用例）。
- 通过 `@tmex/ui/checkbox` 导入（package.json 的 `./*` 通配导出已覆盖）。

### 1.2 行多选

- `nodes-table.tsx` 第一列改成勾选框；入口自身（`row.isSelf`）与正在卸载的行渲染禁用勾选框。
- 表头第一格是**一个**图标按钮（`nodes-select-all`，`aria-label` + `title`）：未全选 → 全选（`SquareCheckBig`），已全选 → 清空（`SquareMinus`），并带 `data-all-selected` 供断言。
- 状态在 `nodes-management.tsx` 里（`Set<string>`），行消失或转入卸载态时自动剪枝。纯逻辑拆成 `selectableRows` / `toggleSelection` / `toggleAllSelection` / `pruneSelection` 导出以便单测（本仓库 fe 无 DOM 测试环境，交互只能靠纯函数覆盖）。
- 空表 `colSpan` 9 → 10，表格 `min-w` 52rem → 54rem。

### 1.3 批量「更多」

- 卡头 `refresh` 与「添加」之间是 `nodes-bulk-menu`（`Ellipsis` 图标，`@tmex/ui/dropdown-menu`），三项作用于**选中的行**：
  - `nodes-bulk-upgrade`：`upgrade.startAll(selectedRows)`，标签带可升级台数（`nodes.selection.upgrade` = 「升级（{{count}}）」）。
  - `nodes-bulk-revoke`：走签名吊销，`useBulkRevoke`（新，在 `use-node-row-actions.ts`）一次确认列出全部名字 + 一次 reason 提示 + **整批一次凭据**，随后串行吊销（key log 是一条链，并行必然互相顶成 `seq_gap`）。
  - `nodes-bulk-uninstall`：打开卸载确认框。
- 禁用与原因由纯函数 `bulkMenuStates` 决定（空选择 / hub 拒写 / 批量或卸载或移除在跑 / latest 未知 / 无可升级项）。
- 菜单内容组件 `BulkActionsMenuList` **不带 hook**（文案由父级用 `t` 算好传入），因为 Base UI 菜单走 portal，SSR 什么都不输出，单测只能直接对元素树断言（与 `AddDeviceMenuList` 同一套做法）。
- **删除 `UpgradeAllButton`** 及其导出与全部相关测试。

### 1.4 远程卸载

- 新增 `use-node-uninstall.ts`：
  - `createUninstallIo(fetchImpl)` / `defaultUninstallIo`：`POST /api/mesh/nodes/:id/uninstall`（2xx = 已受理，一律不重试）、`DELETE /api/mesh/nodes/:id/operation`。fetch 可注入，单测不碰网络。
  - `uninstallSkipReason` / `planUninstall`：把选中行分拣为「能卸」与「跳过 + 原因」（self / offline / loginRequired / tooOld(<1.1.13) / uninstalling）。`compareSemver` 直接从 `@tmex/shared` 取，**不**经 `upgrade-batch.ts`，避免与 O2 耦合。
  - `runUninstallBatch`：逐台串行 POST → 受理即打乐观标记 → 再跑签名吊销；POST 失败跳过该台吊销；单台失败当场 toast 一次，整批结束一条汇总（`uninstallSummaryText` 拆出来便于单测）。
  - `useNodeUninstall`：整批只取一次签名者（`prompt.withSigner` 包住整段，**不**进 5 分钟复用窗口），暴露 `plan/running/scheduledIds/clearingIds/request/confirm/dismiss/clear`。
- 新增 `uninstall-dialog.tsx`：`@tmex/ui/alert-dialog` 确认框，列出将卸载的名字与跳过原因，正文 `UninstallDialogBody` 单独导出供静态渲染断言。
- 行渲染：`row.operation?.kind === 'uninstall'` 时状态列改显「卸载中」（`requested`/`uninstalling`）或「卸载失败」（`failed`，错误进 `title`，旁边一个 ✕ 调 `DELETE .../operation`）；该行的重命名 / 升级 / 勾选禁用，**移除按钮保持可点**（受理后证书还挂着，刷新后要能补上吊销）。
- `mesh-nodes.ts`：`NodeRow` 增加 `operation`，`mergeNodes` 恒填（缺省 `null`）。

### 1.5 Hub 候选诊断

- `mesh-hubs.ts`：`MeshHubsState` 增加 `candidates`（新导出类型 `MeshHubCandidate`），`refreshMeshHubs` 保留它，`useMeshHubs` 随 snapshot 透出。
- `hub-strip.tsx`：`HubStrip` 接 `candidates`（可选，缺省 `[]`）；`normalizeHubUrl`（去末尾斜杠）→ `indexCandidates` → `candidateFailure`；命中且 `lastError` 非空的 chip 加 `TriangleAlert` 警告图标与 `data-hub-failing="true"`，`title` 追加「最近尝试：…」「最近错误：…」两行（错误截断到 160 字符 `CANDIDATE_ERROR_MAX`）。旧后端无 `candidates` → 渲染与之前完全一致。

### 1.6 文案

- `nodes.self`：「当前节点」→「当前」/「Current」/「現在」。
- 新增 `nodes.selection.*`、`nodes.uninstall.*`（含 `skip.*`、`errors.*`）、`nodes.hubs.lastAttempt/lastError`、`nodes.revoke.bulkConfirm/bulkDone/bulkFailed`；三语同步，en_US 的带 `count` 键按仓库惯例给 `_one`/`_other`。已跑 `bun run --filter @tmex/shared build:i18n`（`resources.ts` / `types.ts` 为生成产物，未手改、未 lint）。
- **未改任何 `nodes.upgrade.*`**（O2 所有）。

## 2. 文件清单

新增：
- `packages/ui/src/components/checkbox.tsx`、`checkbox.test.tsx`
- `apps/fe/src/pages/settings/nodes/management/use-node-uninstall.ts`
- `apps/fe/src/pages/settings/nodes/management/uninstall-dialog.tsx`
- `apps/fe/src/pages/settings/nodes/management/hub-strip.test.tsx`

修改：
- `apps/fe/src/node/mesh-nodes.ts`、`mesh-nodes.test.ts`、`mesh-hubs.ts`、`mesh-hubs.test.ts`
- `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx`、`nodes-table.tsx`、`hub-strip.tsx`、`use-node-row-actions.ts`、`types.ts`（仅在文件**末尾**追加 `NodeSelection` / `UninstallSkipReason` / `UninstallPlan` / `NodeUninstallController`）、`nodes-management.test.tsx`
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`（+ 生成的 `resources.ts` / `types.ts`）

## 3. 验证

- `cd apps/fe && bun test src/` → **1330 pass / 0 fail**（79 文件；基线 1275，其中我加了 ~40 个用例，其余为 O2 并行新增）。
- `cd apps/fe && bunx tsc --noEmit -p .` → **0 errors**。
- `cd packages/ui && bun test` → **54 pass / 0 fail**；`bunx tsc --noEmit -p .` → 0 errors。
- `cd packages/shared && bun test src/i18n` → 2 pass / 0 fail。
- `bunx biome check <改动文件>` → clean（生成文件未参与）。
- 未跑 git 命令，未碰生产 tmex / `tmex` tmux session。

## 4. 需要留意的点

1. **`NodeRow.operation` 声明成可选** `operation?: MeshNodeOperation | null`（`mergeNodes` 恒填 `null`），而不是任务里写的必填。原因：`use-node-upgrade.test.ts`（O2 所有，不在我的可改范围）与本文件的 `row()` 夹具都是「字面量 + `...overrides: Partial<NodeRow>`」，必填会让那份夹具直接 tsc 报错。若后续想收紧成必填，只需给那两个夹具各补一行 `operation: null`。
2. **后端 API 尚未落地**（G1 并行中）。FE 按契约写死路径：`POST /api/mesh/nodes/:id/uninstall`（2xx 即受理）、`DELETE /api/mesh/nodes/:id/operation`、`GET /api/mesh/nodes` 行内 `operation`。错误码表覆盖 `NODE_LOGIN_REQUIRED / NODE_UNREACHABLE / UNINSTALL_NOT_ALLOWED / UNINSTALL_UNSUPPORTED / UNINSTALL_SELF_BLOCKED / UPGRADE_IN_PROGRESS / NOT_FOUND`，未知码原样显示。`GET /api/mesh/nodes/:id/operation` 目前 FE 不需要（行状态随节点列表刷新回来），故未接。
3. **凭据复用**：`useCredentialPrompt.request({reuse:true})` 的 5 分钟窗口没有用；批量路径统一用 `prompt.withSigner` 包住整段循环——一次提示、跑完即清零，不污染复用窗口。
4. **卸载与吊销的顺序不能反**：先 POST 再吊销。反过来做的话证书一撤入口就发不出卸载指令，目标机器上会留下一个连不上任何人的常驻服务。代码注释已写明。
5. 菜单/对话框内容走 portal，SSR 输出为空：新增的断言都走「导出无 hook 的内容组件 + 元素树 / 静态渲染」这条路，不要指望 `render(<NodesManagement/>)` 能看到菜单项。
