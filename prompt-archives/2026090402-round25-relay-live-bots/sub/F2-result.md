# F2 结果 —— 「终端连接失败」提示点名节点展示名

## 结论

`websocket.nodeTooOld` 提示不再显示 `nodeId` 前 8 位，改为由宿主注入的解析器查 mesh 节点目录拿展示名（如 `jiefa-app`）；查不到才退回旧行为。线协议不变（仍只带 `nodeId`），`packages/ws-client` / `ws-borsh` / gateway 一行未动，i18n 也没有新增 key（`{{name}}` 占位符原本就有）。

## 改了什么

| 文件 | 变更 |
| --- | --- |
| `packages/stores/src/runtime.ts` | `AppRuntimeOptions` / `RuntimeCore` 新增可选 `resolveNodeName?: (nodeId: string) => string \| null`，`resolveRuntimeCore()` 原样透传。 |
| `packages/stores/src/tmux-event-router.ts` | `tooOldMessage()` 先用 `ctx.core.resolveNodeName?.(nodeId)`（`event.nodeId` 优先于 `ctx.core.nodeId`），拿到非空名字就走 `websocket.nodeTooOld` 带真实名称；拿不到（宿主没接 / 目录里没有 / 名字为空白）保持旧分支：`self` 或无编号 → `nodeTooOldUnnamed`，否则编号前 8 位。 |
| `apps/fe/src/node/node-names.ts`（新增） | 纯函数 `resolveMeshNodeName(nodeId)`：每次调用现查 `getMeshNodesState()`（不缓存快照），`SELF_NODE_ID` 映射到 `entryNodeId`，列表里没有这一行、名字为空白、entry 自身未知时返回 `null`。 |
| `apps/fe/src/node/node-runtimes.ts` | `createAppNodeRuntimes()` 加 `runtimeOptions: () => ({ resolveNodeName: resolveMeshNodeName })`，放在 `...overrides` 之前（测试仍可覆盖）。宿主全部 runtime（含 `self`）都经这个 manager 创建，所以一处接线即全覆盖。 |
| `packages/stores/src/tmux-event-router.test.ts` | harness 支持注入 `resolveNodeName`；新增 3 个用例：解析到名字→`jiefa-app` 且只查 ERROR 点名的那台、解析器返回 null→编号前缀、解析器认得 `self`→也点名。原有 4 个 `server-too-old` 用例（不接解析器）保持不变。 |
| `apps/fe/src/node/node-names.test.ts`（新增） | `resolveMeshNodeName` 的用例：按 id 查名、`self` 走 entry、未知 id / 空白名字 / entry 未知均为 `null`、列表未拉到时为 `null`。 |
| `apps/fe/src/node/node-runtimes.test.ts` | 新增用例：`createAppNodeRuntimes` 建 runtime 时把 `resolveNodeName` 注入 `AppRuntimeOptions`，且该函数是**现查 store**（先断言空列表返回 `null`，再 `setMeshNodesStateForTest` 后断言拿到名字 / `self` 走 entry / 未知 id 为 `null`）。 |

未改动：`packages/ws-client`、`packages/shared/src/ws-borsh`、gateway、i18n locale 文件、`packages/stores/src/node-connection-manager.ts`（它本来就有 `runtimeOptions` 钩子，够用）、`apps/fe/src/node/mesh-nodes.ts`（见下）。

### 一处偏离任务书：helper 没放进 `mesh-nodes.ts`

任务书要求把 `resolveMeshNodeName` 放在 `mesh-nodes.ts` 里 `getMeshNodesState` 旁边。实际做不到：`apps/fe/src/node/mesh-nodes.ts` 正好顶在复杂度门禁的存量上限上（`scripts/complexity/allowlist.json` 记 `fileLines: 780`，策略是「只降不升」，且任务书禁止改 allowlist），加任何函数都会让 `bun scripts/complexity/gate.ts` 报 `792 lines > 780`。为不动 allowlist、也不为了凑行数去删改与本任务无关的既有代码，把它放进同目录新文件 `node-names.ts`（只 `import { getMeshNodesState } from './mesh-nodes'`，仍是读同一份 live store 的纯函数），`mesh-nodes.ts` 保持零改动（`git status` 里干净）。如需归位，等 `mesh-nodes.ts` 拆分后一并挪。

### 语义上的一点扩展

旧逻辑里 `nodeId === SELF_NODE_ID` 一律走 `nodeTooOldUnnamed`（stores 没法给本机取名）。现在若解析器认得 `self`（fe 会解析成 entry 自身的展示名），也照样点名——多 node 宿主里「哪台机器版本过低」写清楚更有用。没接解析器的调用方（包内默认、既有测试）行为完全不变。

## 第 3 项审计（其他渲染 nodeId 的用户可见文案）

在 `packages/stores` / `packages/panels` 里搜 `nodeId.slice`、`slice(0, 8)`、`node ${`、以及带 `nodeId` 的 `notifications.*` / `t(...)`：

- `packages/stores/src/tmux-event-router.ts:55` —— 本任务修的这一处，是两个包里**唯一**把编号当名字渲染的提示。
- `packages/panels/src/device-tree/node-badge.tsx:33` —— `nodeBadgeAppearance()` 的 `label` 已优先用 `info.name`，只有 `title`（tooltip）里额外附 `· ${info.nodeId}`，是刻意展示的标识，不改。
- `packages/panels/src/device-management/device-remote-info-fields.tsx:40` —— 「节点 ID」信息行，本来就是要显示编号，不改。
- `apps/fe` 侧的 `use-hub-role-switch.ts` / `node-detail-dialog.tsx` / `hub-strip.tsx` 里的 `slice(0, 8)` 都已是「有名字用名字、没名字才退回编号」的形态，且属于 hub UI（任务书要求不碰），不改。

结论：除 `tmux-event-router.ts` 外没有第二处需要改。

## 验证

- `cd packages/stores && bun test` → 418 pass / 0 fail（41 个文件）；单跑 `bun test src/tmux-event-router.test.ts` → 35 pass / 0 fail。
- `cd packages/stores && bunx tsc --noEmit -p .` → 1 个错误，就是基线里那条 `src/host-services.test.ts(93,23) TS2339`，没有新增。
- `cd apps/fe && bun test src/node` → 333 pass / 0 fail（22 个文件，比原来多 1 个 = 新增的 `node-names.test.ts`）。
- `cd apps/fe && bunx tsc --noEmit -p .` → 0 错误。
- `cd packages/panels && bunx tsc --noEmit -p .` → 0 错误（`RuntimeCore` 加了可选字段，顺手确认下游没受影响）。
- `bunx biome check <本次改动的 9 个文件>` → No fixes applied（其中两个测试文件先跑过 `biome check --write` 格式化，只作用于我自己的文件）。
- `bun scripts/complexity/gate.ts` → `complexity gate ok (1447 files, 13133 functions)`，allowlist 未改。

## 遗留 / 不确定

- 只在浏览器宿主（`createAppNodeRuntimes`）接了解析器。别的 `createAppRuntime` 直接调用点（测试夹具）不传，行为回落到编号前缀，符合设计。
- `resolveMeshNodeName` 只认 `/api/mesh/nodes` 这份入口级列表；hub 侧才有、mesh 列表里没有的行（未 admit / 已 revoke）查不到名字，会退回编号前缀——这正是想要的兜底，且按任务书没碰 hub 加载逻辑。
- 没做真实浏览器实测（造一台版本低于 1.1.23 的 node 才能触发这条提示）；用例覆盖了解析器命中 / 未命中 / `self` 三条路径与注入接线。
