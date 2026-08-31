# O7 结果：节点升级状态机 RV3 三项修订

## 改动文件

- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts`（重写状态机）
- `apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx`（新增 8 个用例）
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`（`nodes.upgrade` 内新增 2 个键）

未动 `nodes-table.tsx` / `types.ts`：阶段枚举与展示逻辑无需变化（未确认路径复用 `restarting`）。

## 1. Blocker：POST 回包丢失不再判失败

新增 `UpgradeStartOutcome`，POST 结果分成 `started / unconfirmed / alreadyLatest / failed / cancelled`：

- fetch 抛异常（非取消）、200 但响应体读不出、后端 `NODE_UNREACHABLE` → `unconfirmed`；
- `unconfirmed` 不再报错、不放开按钮：阶段置 `restarting`，弹一条 `nodes.upgrade.startUnconfirmed` 警告 toast，然后进轮询；
- 轮询以 `unconfirmedStart=true` 运行：`sawActive=false` 时也允许**用节点列表里的版本变化**确认成功（`versionConfirmed(strict=true)`，`targetVersion` 为空时绝不猜成功）；目标始终可达且版本没变则在 30s 宽限期后落到「结果未确认」（不是失败）；
- `UPGRADE_ALREADY_LATEST`、403/`UPGRADE_NOT_ALLOWED`、`UPGRADE_UNSUPPORTED`、`NODE_LOGIN_REQUIRED`、`RELEASE_UNAVAILABLE` 等确定性 POST 错误行为不变。

## 2. Should-fix：卸载真正取消

- 组件持 `AbortController`（`useEffect` 建、卸载 `abort()`），signal 贯穿 POST / GET / 等待；
- `waitFor(ms, signal)` 可取消，abort 时同步 `clearTimeout` 并立即返回；
- 新增独立的 `cancelled` 结果（POST、轮询、等待三处都能产生），`runNodeUpgrade` 遇到 `cancelled` 或 `signal.aborted` 一律静默返回：**卸载后无 toast、不调 `onChanged()`、不再发下一轮请求**；
- `patch` 也以 signal 状态守门，卸载后不再 setState。

## 3. Should-fix：轮询错误分级

新增导出的 `classifyPollFailure(status, code)`：

- 网络异常与 5xx（502/503/504…）→ `retry`，仍按「重启中」等；
- `NOT_FOUND` / `UNAUTHORIZED` / `FORBIDDEN` / `NODE_LOGIN_REQUIRED` / `UPGRADE_NOT_ALLOWED` / `UPGRADE_UNSUPPORTED` 及其余 4xx → `definitive`，一轮内收尾，不再空等六分钟预算；
- 额外保险：定性失败前先比一次版本——目标「升完重启才把会话弄丢」（401）且版本已对上时判成功，避免把成功的升级报成失败；节点已被吊销（列表里查无此节点）则照常失败，提示 `nodes.upgrade.nodeGone`。

## 结构变化（为可测性）

无 DOM 测试环境，故把状态机与真实 IO 之间切了一道接缝：

- `UpgradeIo`（`start / poll / nodeVersion / wait / now`）+ `defaultUpgradeIo`（真实 fetch + `refreshMeshNodes`）；
- 导出 `runNodeUpgrade(params)`（注入 `io / signal / t / toasts / patch / onChanged`）与 `watchUpgrade(ctx)`；
- `useNodeUpgrade(onChanged, io = defaultUpgradeIo)` 只负责接线，调用点不变。

## 新增测试（8 个，全部在 `nodes-management.test.tsx`）

`节点升级状态机`：POST `unconfirmed` → 轮询 → 版本变化确认成功（无失败 toast，阶段 pending→restarting×3→done）；`unconfirmed` 且版本未变 → 16 轮（32s > 30s 宽限）后只报「未确认」；轮询 404 → 一轮内失败且文案为 `nodes.upgrade.nodeGone`、不调 `onChanged`；轮询 401 但版本已对上 → 判成功；GET 在途卸载 → 无 toast/`onChanged`、不再刷列表；等待期卸载 → 下一轮 GET 都不发；POST 确定性错误照旧立刻失败。
`classifyPollFailure`：可重试 vs 确定性各一组。

## 新增 i18n 键（需 commander 跑 `build:i18n`）

- `translation.nodes.upgrade.startUnconfirmed`：zh「无法确认「{{name}}」是否已开始升级，正在核对结果。」/ en / ja 同步
- `translation.nodes.upgrade.nodeGone`：zh「该节点已从网络中移除。」/ en / ja 同步

三语均已改源 locale，未碰生成文件。

## 验证

- `cd apps/fe && bun test src/`：改动前 1089 pass / 0 fail，改动后 **1098 pass / 0 fail**（+9 用例，无新增失败）。
- `bunx tsc --noEmit -p .`（apps/fe）：无输出，通过。
- `bunx biome check <改动文件>`：clean。
- 额外：`bun scripts/complexity/gate.ts` 通过（过程中 `watchUpgrade` 曾 CC 16 超阈，已拆出 `settleIdle` 修回）。
