# O1 结果 — 节点表「全部升级」与已最新 / 版本过旧时禁用

## 交付内容

### 1. 行内「升级」按钮的禁用判定（需求 1、2）

新增 `apps/fe/src/pages/settings/nodes/management/upgrade-batch.ts`，把可升级性判定收成纯函数：

- `MIN_REMOTE_UPGRADE_VERSION = '1.1.0'`（首个网关暴露 `/api/system/upgrade`、`/api/system/info` 的版本）。
- `isTooOldForRemoteUpgrade(version)`：版本可解析且 `< 1.1.0` 才为真；`null` / `1.1.0_dev` 这类无法解析的一律 `false`（后端才是权威）。
- `isAtLatest(version, latestVersion)`：`compareSemver >= 0`；latest 未知或版本无法解析返回 `false`。
- `upgradeBlockReason(row, latestVersion)`：`'offline' | 'loginRequired' | 'tooOld' | 'atLatest' | null`，判定次序为离线 → 未登录 → 过旧 → 已最新（离线 / 未登录的既有行为不变）。

`nodes-table.tsx` 的 `upgradeBlockedHint` 改为基于它取文案：`tooOld` 插入 `row.version`，其余直接映射 `nodes.upgrade.<reason>`。批量升级进行中（`upgrade.batch.running`）整列升级按钮一并禁用，避免同一节点被行内按钮和批量各点一次。

### 2. 「全部升级」工具栏按钮（需求 3）

- `nodes-management.tsx` 的 `CardAction` 中，在「添加」**左侧**新增 `data-testid="nodes-upgrade-all"`（`CircleArrowUp` 图标 + `nodes.upgrade.upgradeAll`）。latest 未知 / 批量进行中 / 无可升级节点时禁用，`title` 分别为 `releaseUnavailable`、`allNone`、`allHint`；运行中图标换 `Loader2`、文案换 `allProgress`（「升级中 2/5」）。
- 候选（`isBatchEligible`）：在线 + （本机或已登录）+ 版本可解析 + `>= 1.1.0` + 严格 `< latestVersion`。
- 顺序（`orderUpgradeGroups`）：**普通节点 → 远端 hub → 本机**。普通节点组并发 3（`BATCH_CONCURRENCY`），hub、self 各自成组，严格等前一组全部 settle 后才开始。本机同时是 hub 时只归到最后一组。
- `runUpgradeBatch` 返回 `{ succeeded, failed, failedNames, cancelled }`；`done` / `alreadyLatest` 计成功，`failed` / `timeout` 计失败（记名），`cancelled` 两边都不算。signal 已 abort 时 `cancelled: true` 且不再启动剩余节点。
- `runNodeUpgrade` 由 `Promise<void>` 改为返回 `Promise<UpgradeRunOutcome>`（`'done' | 'failed' | 'timeout' | 'alreadyLatest' | 'cancelled'`）。单节点路径的 toast / patch / 提前返回逻辑逐行未变，既有 8 条状态机测试全绿即证明。
- 批量期间注入 `SILENT_UPGRADE_TOASTS` 吞掉每节点 toast，行内 phase / error 的 `patch` 照常，因此表格仍逐行显示进度。
- 结束后 `reportBatchSummary` 只弹一条：全成功 `toast.success('nodes.upgrade.allDone')`，有失败 `toast.warning('nodes.upgrade.allDoneWithFailures')` 并附失败节点名（用 `nodes.upgrade.listSeparator` 连接）；`cancelled` 时不弹。

`types.ts` 的 `NodeUpgradeController` 扩展为：`startAll(rows)`、`batch: { running, total, completed }`、`eligibleCount(rows)`，并新增 `UpgradeRunOutcome`、`NodeUpgradeBatchState`、`IDLE_UPGRADE_BATCH`。

### 3. i18n（需求 2、5）

`packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json` 的 `translation.nodes.upgrade` 子对象（**只动这一处**）：

- 改写：`unsupported`（补「请在该机器上执行 npx tmex-cli upgrade」）、`notAllowed`（改为「该节点的安装方式无法自更新（无服务管理器或运行在容器中），须手动升级。」）。
- 新增：`atLatest`、`tooOld`（带 `{{version}}`）、`upgradeAll`、`allHint`、`allNone`、`allProgress`、`confirmAll`、`allDone`、`allDoneWithFailures`、`listSeparator`。
- en_US 的 `allHint` / `confirmAll` 按仓库既有惯例（`nodes.*.itemCount`）拆成 `_one` / `_other` 复数形式，zh/ja 用单一键。

已从仓库根跑 `bun run build:i18n`，`resources.ts` / `types.ts` 为脚本生成，未手改。

## 文件清单

改动：
- `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx`
- `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx`
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts`
- `apps/fe/src/pages/settings/nodes/management/types.ts`
- `apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx`
- `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json`（仅 `nodes.upgrade` 子对象）
- `packages/shared/src/i18n/{resources.ts,types.ts}`（`build:i18n` 生成）

新增：
- `apps/fe/src/pages/settings/nodes/management/upgrade-batch.ts`
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.test.ts`

## 验证

| 项 | 之前 | 之后 |
|---|---|---|
| `cd apps/fe && bun test src/` | 1140 pass / 0 fail（75 文件） | **1168 pass / 0 fail**（76 文件，3281 expect） |
| `bunx tsc --noEmit -p apps/fe` | 0 | **0** |
| `bunx tsc --noEmit -p packages/shared` | — | **0** |
| `bunx biome check <本次改动文件>` | — | **clean**（先 `--write` 修了格式，只作用于自己的文件） |

未跑 Playwright e2e（按 spec 要求）。

新增 28 条测试：
- `use-node-upgrade.test.ts`（22 条）：版本门槛、`isAtLatest`、`upgradeBlockReason` 四种原因、批量候选筛选、`orderUpgradeGroups`（含 self 同时是 hub）、`runUpgradeBatch` 的顺序断言（用可控 gate 逐个放行，断言 `start` 顺序为 `a,b → hub → self` 且 hub/self 只在前一组全部 settle 后才启动）、并发上限 3、成败统计、中途取消、`reportBatchSummary` 三种分支、`launchUpgradeBatch`（确认框文案与候选数、静音 toast、用户取消、latest 未知 / 无候选）。
- `nodes-management.test.tsx`（6 条）：工具栏按钮位置（refresh < upgrade-all < add）与 latest 未知时禁用；注入假 controller 渲染 `NodesTable` 断言「已是最新禁用 + `title=nodes.upgrade.atLatest`」「版本过旧禁用 + `title=nodes.upgrade.tooOld`」「latest 未知 / `_dev` 版本仍可点」「可升级节点可点」「批量进行中整列禁用」。

## 需要指挥者注意

1. **`MIN_REMOTE_UPGRADE_VERSION` 的定义位置**：常量实际定义在 `upgrade-batch.ts`，并由 `use-node-upgrade.ts` 原样 `export`（`export { MIN_REMOTE_UPGRADE_VERSION }`）。这样做是为了避免 `use-node-upgrade.ts ⇄ upgrade-batch.ts` 的运行时循环 import（前者要用后者的 `runUpgradeBatch`）。对外仍满足「从 `use-node-upgrade.ts` 取这个常量」。要调整门槛值只改 `upgrade-batch.ts` 一处。
2. **spec 里说测试是 happy-dom/RTL 风格，实际不是**：`apps/fe` 没装 `@testing-library/react` / happy-dom，既有组件测试一律用 `react-dom/server` 的 `renderToStaticMarkup`。`renderToStaticMarkup` **不跑 `useEffect`**，所以 `useNodeUpgrade` 里的 `latest` 在整页渲染中永远是 `null`，无法通过渲染 `NodesManagement` 验证「已是最新时禁用」。为此做了两件事：(a) 直接渲染 `NodesTable` 并注入假 `NodeUpgradeController`；(b) 把「latest 已知 → 筛候选 → 一次确认 → 静音 toast → 按序执行 → 汇总提示」整条链抽成导出的纯函数 `launchUpgradeBatch`，hook 只剩状态接线。如果后续引入 RTL，这两处可以改成真正的交互测试。
3. **`build:i18n` 会把并发同伴刚写进 locale JSON 的键一起打进生成文件**。我跑脚本的时刻是本任务收尾时；如果其他 agent 之后还改了 locale JSON，请在合并前**再跑一次** `bun run build:i18n`，以免 `resources.ts` / `types.ts` 落后。
4. **`notAllowed` / `unsupported` 的文案改动会影响其他调用方**（`upgradeErrorText` 走同一张表，`/settings` 的本机升级面板也可能用到 `nodes.upgrade.*`）。已确认这两个键只在 `use-node-upgrade.ts` 的 `ERROR_KEYS` 里使用。
5. **行内升级按钮在批量进行中会整列禁用**——spec 没明确要求，是我为了防止「批量排队中的节点被行内按钮再点一次」加的。`runningRef` 那把锁本来也拦得住（重复触发会被记成 `cancelled`，既不算成功也不算失败），但 UI 上直接锁住更清楚。若不想要，删 `nodes-table.tsx` 里 `disabled={... || upgrade.batch.running}` 一处即可。
6. **未向 `NodeRow` 索要新字段**，`mesh-nodes.ts`、`packages/api-client`、`apps/gateway` 一律未碰。

## 风险

- `MIN_REMOTE_UPGRADE_VERSION` 只是前端的乐观拦截：版本字符串无法解析（开发态 `X.Y.Z_dev`）时不拦，仍由后端返回 `UPGRADE_UNSUPPORTED` 兜底，文案已与 tooltip 对齐。
- 批量的顺序保证依赖 `NodeRow.isHub` / `isSelf` 正确：`isHub` 由 `mergeNodes` 依 `hubNodeId` 标注，hub 不可达时 `hubNodeId` 仍来自 `/api/auth/mode`，不受影响。
- 批量期间若组件卸载，`AbortController` 一 abort，`runUpgradeBatch` 立刻停止启动后续节点、`summary.cancelled` 为真、不弹汇总 toast，`setBatch` 也被 `alive()` 挡住——与既有单节点路径的取消语义一致。
