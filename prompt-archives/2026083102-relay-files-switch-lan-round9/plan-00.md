# 第九轮：中转徽标/连接详情、侧栏文件多节点、终端切换延迟、内网直连

日期：2026-08-31　worktree：`../tmex-enhanced-wt-r9`（分支 `feat/round9-relay-files-perf`，基于 main `c850e077`）

## 背景

- 上一轮（r8）已把发行源切到 fork 的 GitHub Releases，本机生产 tmex 1.1.3 以 node `konata-mac` 加入 Hub `https://ai.jiefakj.com:18443`；两台内网 Linux 节点 `jiefa-app`（10.110.88.3）、`jiefa-dns-1`（10.110.88.5）今天刚接入。
- 本轮四项需求来自用户实际使用反馈。分工：cursor grok-4.6(high) 后端、Opus 前端、codex luna(xhigh) 探索、codex sol(high) 审查、Claude 指挥。所有 agent 不 commit，指挥官分批 commit；最后 push 并用本地 tarball 替换本机生产。
- 探索报告：`sub/e1-e4.out.md`（E1 徽标/下载键、E2 侧栏文件、E3 切换延迟、E4 直连）、`sub/e5.out.md`（key-log/peer-cache 同步）。

## 探索结论（决策依据）

1. **徽标/详情**（E1）：`apps/fe/src/node/device-node-badges.tsx`。「经 Hub 中转」= `nodes.reach.relay`；详情面板固定渲染 5 行 ICE 字段（连接状态/ICE 状态/本端地址/对端地址/当前路径），非浏览器直连时 `diagnostics.ice` 为空 → 全部「未知」。网关 relay 情况下 `reach/transport` 正常为 `relay`，`rttMs` 首次 ping 后有值；缺的是对端地址/建链时间/直连失败原因。终端页右上角「下载」图标实为 `jump-to-latest`（滚到底部，`ArrowDownToLine`），无 testid；文件页下载按钮是 `FilePage.tsx` 的 `file-download-action`。
2. **侧栏文件**（E2）：`packages/panels/src/files/files-tab.tsx` 只挂当前路由 runtime（`/`、`/devices` 下即 self），只查该 runtime 的 `/api/files/roots`；`sidebarFilesVisibility` 复合键本身正确。远端 files API 经 `/n/<nodeId>/api/files/*` 转发已可用。可复用：`useMeshNodes` + `NodeRuntimeScope` 分节模式（`sidebar-node-section.tsx`）、`NodeBadge`、dnd `SortableVerticalList/useSortableRow/reorderIdsByDragEnd`（`device-tree-dnd.tsx`）、UI store `sidebarNodeOrder`、文件根已有 `sortOrder` 字段但无批量 reorder API。
3. **切换延迟**（E3）：属实，两个结构性来源：(a) 网关 `switch-barrier.ts` 发完 `TERM_HISTORY` 后**固定等 450ms**（`LIVE_RESUME_DELAY_MS`）才发 `LIVE_RESUME`；(b) 单 pane 视图以 `deviceId:paneId` 为 key，每次切换销毁并重建 Terminal（字体 await、Ghostty 实例、4 层 canvas、history 重放），split 视图则保持挂载。浏览器 transport 仍是 legacy（`atomicScreen=false`）。
4. **直连**（E4 + 实测）：代码无「必须中转」限制，dial 顺序 dc → ws-secure（`ws://<LAN IP>:39001/peer`，每个 endpoint 3s 超时）→ relay；`maybeUpgrade` 15s 扫描。**实测**：本机当前在 192.168.3.x（经 Surge utun4），`10.110.88.3/5:9883、:39001` 均超时不可达；历史 ICE 候选显示本机曾在 `10.110.10.x`（办公网）。生产日志 RTC 只对 hub 节点拨号（`datachannel open timeout`，只有 host 候选、无 srflx）。**本机 `node_certs` 只有 seq 2/3/4（hub/self/docker-node），`peer_cache` 最后更新 08-30 13:22、无 jiefa 节点** → 本机根本不认识两台新节点，无法直拨；用户当前可能以 Hub UI 为入口。

## 目标与任务

### 任务 1：终端右上角徽标与详情（O1 前端 + G3 后端字段）
- `nodes.reach.relay`：zh「中转」/ en「Relay」/ ja「中継」；`transportRelay` 同步为「Hub 中转」→「中转」。
- 详情面板按承载分支渲染，不再出现不适用行：
  - 公共：到达路径、承载、RTT（无则「测量中」而非未知）、建链时长（`linkSinceAt`）。
  - relay：中继地址（hub host）、直连失败原因（`directFailure.ws/dc`，来自 G3）。
  - ws-secure：对端地址（`peerAddress`）。
  - dc / 浏览器直连：原 ICE 五行。
- 删除终端工具栏 `jump-to-latest` 按钮（快捷键动作 `scrollToBottom` 保留）；文件页下载不动。

### 任务 2：侧栏文件多节点（O2 前端 + G1 后端）
- Files tab 改为按节点分节：self + 在线且已登录的远端节点，各自 `NodeRuntimeScope` 内查 roots；分节头显示节点名（`NodeBadge`），未登录远端节点显示登录入口（`useNodeLoginGate` 同终端侧栏）。
- 分节顺序复用 `sidebarNodeOrder`（与终端侧栏一致，可拖）；分节内文件根可拖排序，持久化到 `PUT /api/files/roots/order {rootIds}`（G1 新增，按 `sortOrder` 重写）。
- 保留 `selectVisibleFileRoots` 可见性规则与 500 行上限。

### 任务 3：终端切换延迟（G2 后端 + O3 前端 + M1 测量）
- G2：去掉固定 450ms——最后一个 history 分块写入后立即发 `LIVE_RESUME`（保留超时兜底与 token 门控语义）；说明 `wantHistory=false` 时的网关行为供 O3 使用。
- O3：单 pane 视图对同一设备最近使用的 pane 保留 Terminal 实例（LRU，默认 3），切回热实例不重建、不重放 history（`wantHistory:false`），仅 select + focus；字体已加载时不 await；避免重复 resize。
- M1：独立测量脚本（临时网关 + 预构建 dist，隔离 tmux socket），量化 切换开始→placeholder 消失→首个非空帧→首个实时输出 的 p50，改前改后各跑一次。

### 任务 4：内网直连（G3 后端 + E5 探索 → 视结论追加 G4）
- G3：ws-secure 拨号并发化（所有 endpoint 同时拨，首个成功者胜，其余取消），endpoint 按「与本机同网段 > 其他私网 > 公网」排序；每个 peer 记录最近一次直连尝试 `{at, ws?: string, dc?: string, endpointsTried}`；`GET /api/mesh/nodes` DTO 增加可选字段 `peerAddress`、`linkSinceAt`、`endpoints`、`directFailure`（借 REST 下发，不改 borsh NodeEvent）。
- E5：查明 node 侧 key-log/peer_cache 为何停在 seq 4 / list_version 30（hub 1.0.2 vs node 1.1.3？增量同步条件？），产出修复方案 → G4。
- 本机结论：当前物理位置不可达 10.110.88.0/24，直连只能在办公网（10.110.10.x）成立；届时路径为 ws-secure TCP 39001（macOS Surge TUN 吞 UDP，dc 不现实）。需用户在办公网复测。

## DTO 契约（G3 ↔ O1）

```ts
// GET /api/mesh/nodes 每个 node 追加（全部可选、向后兼容）
peerAddress?: string | null;     // ws-secure/dc: 对端 host；relay: hub host
linkSinceAt?: number | null;     // 当前链路建立时刻（epoch ms）
endpoints?: string[];            // 对端广播的 ws endpoint（原样）
directFailure?: {
  at: number;                    // 最近一次直连尝试时刻
  ws?: string | null;            // 例："timeout ws://10.110.88.3:39001/peer"
  dc?: string | null;            // 例："datachannel open timeout"
} | null;
```

## 文件归属（并行隔离）

| Agent | 范围 |
|---|---|
| G1 grok | `apps/gateway/src/api/file-root-routes.ts`、`apps/gateway/src/db/file-roots.ts`（+测试） |
| G2 grok | `apps/gateway/src/ws/borsh/switch-barrier.ts`（+测试）、必要时 `legacy-feed-broadcaster.ts`/`tmux-command-handlers.ts` |
| G3 grok | `apps/gateway/src/mesh/{peer-manager,node-list-projection,mesh-routes,address-class,mesh-runtime}.ts`（+测试） |
| O1 Opus | `apps/fe/src/node/{device-node-badges,mesh-nodes,direct-diagnostics}*`、`packages/api-client/src/auth/*` 类型、`packages/panels/src/device-console/{device-console-toolbar,use-device-console-actions}*`、locale `nodes.badge/nodes.reach/nav.jumpToLatest` |
| O2 Opus | `packages/panels/src/files/*`、`apps/fe/src/components/page-layouts/components/app-sidebar.tsx`、`packages/api-client/src/file-resources*`、locale `files.*` |
| O3 Opus | `packages/panels/src/device-console/terminal-stage*`、`packages/terminal-ui/src/components/**`、`packages/stores/src/tmux-selection-actions*`（不碰 O1 的 toolbar 文件） |
| M1 Opus | 仅新增 `prompt-archives/.../sub/measure/**` |

共享 `packages/shared/src/i18n/locales/*.json` 各改各的子对象，`bun run build:i18n` 由改动者立即执行。

## 验收

- 各包 `bun test` 不低于基线、`tsc` 错误数不高于基线（`sub/baseline.txt`）、改动文件 `biome check` 通过。
- 徽标：relay 显示「中转 · 38ms」，详情无「未知」；ws-secure 显示对端地址；toolbar 无 jump-to-latest。
- 文件：临时 hub+node 双实例中，侧栏 Files 出现两个节点分节、分节名正确、远端根可展开；拖动后刷新顺序保持。
- 切换：M1 改后 p50「切换→首个实时输出」较基线下降 ≥ 400ms；热切换无 placeholder。
- 直连：`/api/mesh/nodes` 含 `directFailure` 原因；并发拨号单测覆盖「一个 endpoint 超时其他成功」。
- codex sol 审查三批 diff，blocker 全修，非 blocker 按价值判定。

## 风险

- O3 保留实例增加内存（10000 行 scrollback × 3）与订阅流量；需 eviction 与设备切换时清理。
- G2 去掉 450ms 可能暴露 history 与实时输出的顺序竞态；靠 WS 有序 + token 门控保证，测试必须覆盖「history 分块未写完不能 resume」。
- G3 并发拨号会对多个 LAN 地址同时发起 TCP，需要正确取消落选连接，避免残留 socket。
- 本机 key-log 停滞若是协议/版本问题，需要同时升级远端 hub。
