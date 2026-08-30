# 计划：设备页 iOS 式退避 / 侧栏节点切换动画 / code smell 第四轮

## 背景

- 分支 `chore/round4-dnd-sidebar-smell`（worktree `../tmex-enhanced-wt-r4`，基于 main `ea63e01e`）。
- 前三轮 code smell 清理已结束（保留清单见 `prompt-archives/2026082702-code-smell-round3/plan-00-result.md`），但 hub/mesh 合并进来的代码（`apps/gateway/src/mesh|hub|auth`、`packages/app/src/commands|runtime`、`apps/fe/src/auth|pages/settings/nodes`、`packages/ws-client/src/direct`）从未清理，CC>15 函数 72 个、CC>30 10 个、最大文件 2204 行（`sub/cc-baseline.txt`）。
- 探索报告：`sub/explore-dnd-report.md`、`sub/explore-sidebar-report.md`、`sub/explore-smell-report.md`；测试基线 `sub/test-baseline.txt`（gateway tsc 21 个既有错误、packages/app 1 个既有 fail、stores tsc 1）。
- 分工：cursor-agent grok-4.6 high 后端、Opus 前端、codex luna 探索、codex sol 审查；指挥官分批 commit。

## 任务 1：设备页拖拽双向退避（已完成，commit `59178d70`）

根因：`collision.ts` 的候选把被拖元素自身排除，指针回到原位时 `closestCenter` 只能选邻居，`overIndex` 永远回不到 `activeIndex`，sortable 不归位。修复：同容器兄弟候选（指针分支 + 键盘分支）加入 active 自身；`resolveDrop(active, active)` 本就返回 null，drop 语义不变。回归测试在 `collision.test.ts`。

## 任务 2：侧栏节点切换动画（Opus，进行中）

不引入动画库，用仓库既有 CSS token / `Reveal` / Base UI `Collapsible`：
- `DeviceRow` 的窗口子树改受控 `Collapsible`（展开与收起都有高度+透明度过渡），去掉叠加的 `tmex-reveal`；
- 设备/窗口/pane 的选中态颜色、指示条、展开箭头加 100–150ms 过渡；
- 节点分节 `return null` 的出现/消失加轻量 presence 壳；
- `app-sidebar.tsx` 的 agent/files tab `Reveal` key 带上路由节点 id（panes tab 保持稳定 key）。
范围：`packages/panels/src/device-tree/**`、`apps/fe/src/components/page-layouts/components/**`（其它 smell agent 不得进入）。

## 任务 3：code smell 第四轮（≤3 轮扫描-修复）

原则：**净行数必须下降**；只在能删更多代码时才引入新抽象；不加注释；不动前三轮保留清单；不动发版文件；每个 agent 文件集互不重叠。

### 第 1 轮（并行）

后端（cursor grok）：
- G1 `uplink-protocol` 双份解码器合并：抽 `packages/shared/src/uplink/codec.ts`，mesh/hub 各留薄适配；顺带去掉两文件的无 importer 导出。
- G2 跨端重复：DataChannel fragmenter（gateway `mesh/rtc/fragmenter.ts` ↔ `ws-client/direct/fragmenter.ts`）抽 `packages/shared/src/link/fragment-core.ts`；queued pump（`link-stream-carrier.ts` ↔ `shared/link/websocket-link.ts`）抽 `queued-transport.ts`。
- G3 `stream-targets.ts`（`acceptHttpStream`/`acceptWsStream` 拆分 + 修 `cancel/end` 未 await 的 bug）、`hub/uplink-server.ts` `copyDirection` 未 await、stream pump 去重、`mesh-routes.ts collectNodes` ↔ `uplink-server.ts buildNodeList` 抽 `node-list-projection.ts`。
- G4 `tls-config-store.ts upsert` 字段表化；`auth-routes.ts handleLogin/handle` 拆分 + 路由表；`hub-runtime.ts` enrollment/redeem 拆分；抽 `api/route-input.ts` 统一 required string / base64 / JSON body 校验。
- G5 `forwarder.ts`（failover/handleRemoteHttp/adaptResponse 拆分，修 `flushQueue` 双调用与 abort listener 未清理）；`packages/app`：`enroll.ts`（修不可达 TOTP 分支、`sleep` 泄漏 abort listener）、`init.ts buildInitConfig`、`hub.ts performHubJoin`、`setup-routes/local-routes` 复用 `mapError`。

前端（Opus）：
- O1 `apps/fe/src/auth/session-key-store.ts loginToNode` + `use-node-login.ts useNodeLoginGate`。
- O2 `apps/fe/src/pages/settings/nodes/local-machine-card.tsx`（`LocalMachineCard`/`DirectSection`）+ `management/nodes-table.tsx NodeRowView`，去掉无 importer 导出。
- O3 `packages/panels/src/device-management/device-management-panel.tsx`。

### 第 2 轮（第 1 轮合入后视预算决定）

`uplink-client.ts runCatchUpFromList/classifyUplinkConnectError`、`peer-manager.ts dial/track/handlePeerCtl`（含 fire-and-forget bug）、`user-key-service.ts applyMany/replayJoinChain/persistApplied`、`mesh-runtime.ts createMeshRuntime`、`assemble.ts dispatch`、`direct-carrier-controller.ts`。

### 第 3 轮

重新跑 `cc.ts` 与行数统计，只处理剩余高价值项；否则收尾。

## 验收

- 各包 `bun test` 不低于基线，`tsc --noEmit` 错误数不高于基线，`biome check` 改动文件无问题。
- 总代码行数（`cc.ts` 口径的 ts/tsx，去测试/生成）低于 171434。
- CC>30 函数数量明显下降；新增的 shared 模块有单测。
- codex sol 分组审查（backend / frontend / shared），指挥官判定是否修。
- 全量构建 → `npm pack` → 临时实例烟测 → `npx ./tmex-cli-<ver>.tgz upgrade --apply-current-package` 替换本机。

## 注意事项

- 严禁触碰生产 tmex（9883、`~/Library/Application Support/tmex/`）与名为 `tmex` 的 tmux session。
- 前端改动期间不跑 e2e；`apps/fe` 单测用 `bun test src/`。
- 生成文件（i18n resources/types、fe-dist）不 lint。
