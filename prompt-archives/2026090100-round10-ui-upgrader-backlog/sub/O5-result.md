# O5 结果：设置-节点管理「升级」动作（前端）

## 1. UX 流程

节点表 Actions 列在「重命名 / 移除」之后新增「升级」按钮（`data-testid="node-upgrade-<nodeId>"`，另带 `data-upgrade-phase` 便于测试与调试）。

- **可用性**：只看目标是否可用，**不跟 `hubOnline` 绑定**——重命名 / 移除走 Hub 控制面，升级走入口 → 目标的 peer link。
  - 目标离线 → 禁用，`title` 为「节点离线，无法升级。」
  - 远端且未登录 → 禁用，`title` 为「须先登录该节点。」（该行原有的「登录此节点」按钮仍在 Login 列）
  - 本机（self）**可以**升级，确认框写明「服务会重启，当前访问随之中断，稍候即可恢复」，与版本页的重启提示同一套口径。
- **确认**：点击先弹 `confirm`，本机 / 远端两套文案，带目标版本号（latest 还没拿到时用「最新版本」占位）。
- **进行中**：按钮换成 spinner + 阶段文案并锁住（升级 busy 与 rename/revoke 的 busy 完全独立，互不影响）。
- **结果**：成功 / 失败 / 超时分别 toast，并在成功与超时后触发 `refreshAll()` 刷新列表；「已是最新」按良性提示（`toast.info`）处理，不算失败、按钮不进 `failed` 态。

## 2. 状态机（`use-node-upgrade.ts`）

阶段：`idle → pending → downloading → executing → restarting → done | failed`。

1. `POST /api/mesh/nodes/:id/upgrade`（空体）。**永不重试**——目标可能已开始升级却来不及回包，重发只会撞 `UPGRADE_IN_PROGRESS`。
2. POST 返回的 `UpgradeStatus.state` 直接作为初始阶段，并据此置 `sawActive`。
3. 每 2 秒 `GET /api/mesh/nodes/:id/upgrade`：
   - 请求失败 / 非 2xx → **不判失败**，按 `restarting`（还没见过 active 时按 `pending`）继续等，这是目标网关自杀重启的预期现象。
   - `state !== 'idle'` → 记 `sawActive`，展示 downloading / executing。
   - `state === 'idle' && error` → 判失败（状态不跨进程持久化，重启回来 error 一定为空，所以 idle 上还挂着 error 必是下载阶段失败）。
   - `state === 'idle' && sawActive` → 进 `restarting`，`refreshMeshNodes()` 后比对 `/api/mesh/nodes` 里该节点的 `version` 是否等于目标版本；对上才算 `done`。latest 未知时退化为「目标重新可达即完成」。
   - POST 后 30 秒仍没见过任何非 idle → 判「未确认」，不空等满预算。
4. 总预算 6 分钟；耗尽 → `failed` 阶段 + `toast.warning('升级结果未确认，请刷新节点列表核对版本。')`，绝不猜结论。
5. 组件卸载后 `aliveRef` 置 false，轮询立即退出且不再 setState。同一节点重复点击由 `runningRef` 去重。

错误码映射（后端契约）：`NODE_LOGIN_REQUIRED / NODE_UNREACHABLE / UPGRADE_NOT_ALLOWED / UPGRADE_IN_PROGRESS / UPGRADE_UNSUPPORTED / RELEASE_UNAVAILABLE` → 对应文案；`UPGRADE_ALREADY_LATEST` 单独走良性分支；未知码原样展示以便诊断。

latest 由 `GET /api/mesh/upgrade/latest` 在挂载时拉一次，失败静默（按钮仍可用，确认框用占位文案）。请求都走 `defaultApiClient`（入口节点自身），**不**经 `/n/:id` runtime client。

## 3. 改动文件

| 文件 | 改动 |
|---|---|
| `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts` | 新增：latest 查询 + 每节点状态机 + 轮询 + 纯函数 `isUpgradeBusy` / `upgradePhaseText` / `upgradeErrorText` |
| `apps/fe/src/pages/settings/nodes/management/types.ts` | 新增 `NodeUpgradeLatest` / `NodeUpgradePhase` / `NodeUpgradeEntry` / `NodeUpgradeController` / `IDLE_UPGRADE_ENTRY`；`NodeActionDeps` 加 `upgrade` |
| `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx` | Actions 列加 `UpgradeButton` 及禁用原因 / 标题派生 |
| `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx` | 挂 `useNodeUpgrade(refreshAll)` 并传给 `NodesTable` |
| `apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx` | 新增 5 个测试 + `buttonTag()` 辅助 |
| `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` | 各加 `nodes.upgrade` 子对象（20 键） |

`use-node-row-actions.ts` 最终**未改动**（升级状态刻意与 rename/revoke 分开）。

## 4. 验证数据

| 项 | before | after |
|---|---|---|
| `cd apps/fe && bun test src/` | 1084 pass / 0 fail（73 文件） | **1089 pass / 0 fail**（73 文件） |
| `bunx tsc --noEmit -p .`（apps/fe） | 无输出（clean） | **无输出（clean）** |
| `bunx biome check <改动文件>` | — | clean（12 文件，0 error） |
| `bun scripts/complexity/gate.ts` | — | ok（1111 文件 / 9275 函数） |

**tsc 无新增错误，也没有 i18n key 报错**：本仓库没有对 i18next 做模块增强（`TranslationKey` 只在 `packages/shared/src/index.ts` 再导出，未用于 `t()` 的键位），所以 `t()` 的键不是强类型，新增键在 `build:i18n` 之前不会产生编译错误。**但运行时**在 `bun run build:i18n` 之前，这些键会原样显示为 `nodes.upgrade.xxx`——请指挥官重新生成 i18n 产物（`bun run --filter @tmex/shared build:i18n`）后再实测界面。测试断言只认 testid / 键名，不依赖译文。

## 5. 新增 i18n 键（`translation.nodes.upgrade`，三语同步，共 20 个）

`action`、`hint`、`latestPending`、`confirmSelf`、`confirmRemote`、`started`、`stateDownloading`、`stateExecuting`、`stateRestarting`、`done`、`failed`、`alreadyLatest`、`offline`、`loginRequired`、`unreachable`、`inProgress`、`notAllowed`、`unsupported`、`releaseUnavailable`、`timeout`。

三个 locale 文件都只插入了这一个子对象（`nodes.revoke` 之后），未触碰其它部分；生成文件 `i18n/{types,resources}.ts` 未动，也没有跑 `build:i18n`。

## 6. 遗留 / 注意

- 新增测试里的 `buttonTag()` 辅助：**不要**再用 `data-testid="x"[^>]*disabled` 这类正则判断禁用——按钮 class 里就有 `disabled:pointer-events-none`，任何按钮都会假匹配（既有的 rename/revoke 禁用断言就有这个弱点，属既存问题，未在本任务内改动）。
- 未做真机实测（按任务要求不起 dev / 不跑 e2e）。文案换行与截断需要在开发实例里截图核对（文案规范流程要求）。
- 后端若把 `POST` 的错误 JSON 字段命名为 `error` 而非 `code`，前端也能读到（`readCode` 两者都认）。
