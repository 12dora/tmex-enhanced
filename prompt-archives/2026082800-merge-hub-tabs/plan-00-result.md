# plan-00 执行结果（2026-08-28）

worktree `../tmex-enhanced-wt-merge`，分支 `chore/merge-hub-tabs`，base `feat/hub-node`（`b0b0683`）。

| commit | 内容 |
|---|---|
| `d60bd42` | Merge `feat/sidebar-tabs-ui`（26 个冲突文件解完） |
| `a96f488` | 三路 code review 后的修复 |

## 分工与产物

| 角色 | 模型 | 产物 |
|---|---|---|
| 探索 | codex gpt-5.6-luna xhigh | `sub/explore-conflicts.md`（441 行语义丢失风险清单） |
| 后端 | grok 4.6 high | `sub/backend-result.md`、`sub/backend-fix-result.md`、`sub/backend-fix2-result.md` |
| 前端 | Opus 5 high | `sub/frontend-result.md`、`sub/frontend-fix-result.md` |
| 审查 | codex gpt-5.6-sol high ×3 | `sub/review-{backend,frontend,global}.md` |
| 指挥官 | Claude | drizzle 重编号、docs、i18n 重建、逐条判定、验证与上线 |

## 冲突解决要点

### 侧边栏（用户最关心的可见改动）

tabs 的三选一 tab 作为外层容器，mesh 的 node 聚合分节作为 `panes` tab 的内容：

```
AppSidebar → Tabs(Panes / Agent / Files)
  └ panes → SideBarDeviceList
       ├ 非 mesh → SideBarDeviceListForRuntime
       └ mesh → 每 node 一个 SidebarNodeSection
            （离线灰显 inventory / 在线未登录只给登录按钮 / 在线已登录才挂 NodeRuntimeScope）
               └ SideBarDeviceListForRuntime(nodeBadge, expansionKeyFor, emptyLabel)
                    └ panels DeviceTree → DeviceRow(memo + 切片订阅) → Header(NodeBadge + 连接开关)
```

`SideBarDeviceListForRuntime` 是两侧能力的汇合点：tabs 的连接控制与 `features.agentUi` 开关，hub 的 per-runtime agent 适配器。agent 会话跳转由 `expandSidebarSection('agent')` 改为当前 node runtime 的 `setSidebarTab('agent')`。

### WS 身份模型

统一到 `GatewaySession` / `Carrier`。tabs 的 connect generation、legacy pane observer 生命周期、输出门限与 overflow `SourceGap`、notification throttle prune 全部改为按 session/carrier 键控；`legacy-event-delivery` 一族随之改用 `GatewaySession`，过渡期的 5 处 `as never` 已删除（`ClientState` 已不存在，`as never` 会让真实类型不匹配静默通过）。

### 文件传输

保留 tabs 的路由拆分与严格输入校验，hub 的 bulk 钩子留在 `files.ts`。补回拆分时丢失的两处 `rememberTransferUid`（upload/init、download/prepare），以及 5 处终结路径的 uid 清理（改回走 `cleanupUpload` / `cleanupDownload`）。

### 数据库迁移（最容易埋雷处）

两侧各自生成了 `0018`。本机生产库已先后应用过 tabs 的 agent 索引（`when` 1787808955472）与 hub 的 `hub_auth`（`when` 1787844349224），drizzle 的 sqlite migrator 按 `when > 库内最大 created_at` 判定，因此保持：

- `0018_agent_query_indexes.sql` 编号与 `when` 不变
- `0018_hub_auth.sql` → `0019_hub_auth.sql`，`when` 不变
- `meta/0018_snapshot.json` 取 tabs 版；`meta/0019_snapshot.json` = hub 版 + tabs 的两个 agent 索引，`prevId` 指向 tabs 版
- `_journal.json` 两条并存，`managed-migrations.ts` 同序

校验：`drizzle-kit check` 报 “Everything's fine”，`drizzle-kit generate` 报 “No schema changes”。

### 文档与生成文件

`deployment.md` 保留 hub 重写版（tabs 以 stale 为由删除，但 hub 已重写为 npm 包 + launchd 流程，与 tabs 移除 Docker 方向一致）；`docs/README.md` 补回 bootstrap 与 hub 两个小节；i18n `resources.ts` / `types.ts` 由合并后的 locales 重建（三语各 1045 个 key，集合一致）。

## code review 判定

四条发现，两修两不修。

### 已修

1. **blocker（前端）** 切 node 路由把上一个 node 的连接意图写进下一个 node 的存储键。`NodeRuntimeBoundary` 没有 `key`，`/n/A/*` → `/n/B/*` 不 remount，而 `usePersistedDeviceIds` 的 `useState` initializer 只跑一次、effect 却依赖 `storageKey`。
2. **major（前端）** mesh 下当前 node 有两份 `GlobalDeviceProvider`（路由层 + 侧栏 `NodeRuntimeScope`），各持独立的显式断开集合，侧栏断开会被路由层立即重连。

两者同一根因，一并修：把连接意图提升为按 `storagePrefix` 的模块级 `DeviceIntentStore`，provider 经 `useSyncExternalStore` 订阅、现读意图，写入永远落在本实例的键上。self 仍是空前缀、沿用旧键，老用户状态不迁移。

3. **major（后端）** `transferUids` 永不清理——tabs 拆出的 5 处终结路径绕开了 `cleanupUpload` / `cleanupDownload`，导致 Map 无界增长且 transfer id 复用时读到旧 uid。

新增回归测试 22 条（fe 18 / gateway 4），均先确认 RED 再转绿；前端另将 provider 临时换回合并版本，验证两个用例确实失败。

### 未修（判定为无实际影响，记录在案）

1. **agent 索引迁移的 `when` 早于 `hub_auth`**，先装过 hub 分支的库会永久跳过它。技术上成立，但这类库只有本机一台，且本机在装 tabs 版时就已建好这两个索引。要修就得把 `when` 提到 `hub_auth` 之后，那样本机升级会重跑 `CREATE INDEX`（SQL 无 `IF NOT EXISTS`）而失败。全新安装与从 `main` 升级的库按 journal 顺序正常建索引，不受影响。
2. **`transfer-session` 的 TTL `sweepStale` 不清 uid 映射**。hub 分支同样如此，非本次合并引入；触发条件是客户端既不 commit/content 也不 DELETE 的遗弃会话。封死需要在 `remove*Session` 挂钩 `forgetTransferUid`（跨层改动），留待后续任务。
3. **`default-runtime` 的默认通知 sink 变成 noop**。`@tmex/stores/default-runtime` 全仓无生产代码导入，hub 有意移除全局默认 sink（多 node 下不该有单一全局接收方），真实宿主路径都显式注入 `sonnerNotificationSink`。

## 验证

| 包 | pass | fail | tsc | hub 基线 | tabs 基线 |
|---|---|---|---|---|---|
| apps/gateway | 2234 | 0 | 21 | 1823 / 23 | 1870 / 25 |
| apps/fe | 324 | 0 | 0 | 208 / 0 | 109 / 0 |
| packages/panels | 368 | 0 | 0 | 217 / 0 | 347 / 0 |
| packages/stores | 238 | 0 | 1 | 125 / 1 | 214 / 1 |
| packages/shared | 325 | 0 | 0 | 283 / 0 | — |
| packages/ws-client | 260 | 0 | 0 | 235 / 0 | — |
| packages/terminal-ui | 307 | 0 | 0 | 205 / 0 | — |
| packages/app | 213 | 0 | 1 | 175 / 1 | — |
| packages/ghostty-terminal | 189 | 0 | 0 | — | — |
| api-client / theme / ui / notifications | 96 / 6 / 16 / 15 | 0 | 5 / 10 / 0 / 0 | 持平 | 持平 |

所有包 pass 数不低于两分支各自基线，tsc 错误数不高于基线（gateway 反而从 23 降到 21）。

### 迁移演练

用生产库副本（19 条迁移：agent 索引已应用、`hub_auth` 未应用，恰好模拟 tabs-first 的库）跑合并后的 runtime：启动后补上第 20 条 `hub_auth`，agent 索引未重复创建，hub 四张表齐备，`/healthz` 正常。本机真实生产库已有全部 20 条，升级时两条都会跳过。

### standalone e2e

首次全量跑出 19 failed，比基线的 7 个多 12 个。诊断过程：

| 步骤 | 结果 |
|---|---|
| merge 全量 | 19 failed |
| tabs 分支定向跑同组 9 个 spec | 27/27 全过 |
| merge 定向跑同组（同端口、同负载，只变分支这一个量） | 11 failed —— 确认是回归，排除负载因素 |
| 定位 | hub 的 B2-11 / F3-5 给 gateway WS URL 加了 per-socket `?cid=` nonce，而 14 处监听用 `ws.url().endsWith('/ws')` 过滤，全部失配，helper 一帧不记、计数恒为 0 |
| 修复 | 抽出 `tests/helpers/ws-borsh.ts` 的 `isGatewayWsUrl()`（按 `new URL(url).pathname` 判断），14 处统一改用（commit `a0ef6f3`） |
| 修复后 merge 定向 | 5 failed，全部是既有基线失败 |
| 最终全量 | **95 passed / 8 failed / 1 skipped，8 个全部落在既有基线清单内，零回归** |

这个洞是 `feat/hub-node` 自带的，不是合并解冲突解错：hub 的 e2e（94/7/1）是在加 cid 之前跑的，之后没再跑过。生产行为（URL 带 cid）是有意设计，改的是测试侧匹配方式。

教训已记入长期记忆：**改了 WS URL 构造必须跑 e2e**；判断"回归还是环境"要在对照分支上用同样的定向命令跑同一组 spec，只变分支这一个量。

## 上线

1. `bun run build` → `packages/app` 下 `npm pack` 出 `tmex-cli-1.0.2.tgz`（189 个文件）
2. 烟测：解包后用临时目录 + 空库 + 端口 19984 起 runtime，`/healthz` ok、首页 200、前端 bundle 为 `index-DwjuJLYT.js`、**空库从 0 建到 20 条迁移**（全新安装路径正确）
3. 迁移演练：用生产库副本（19 条：agent 索引已应用、`hub_auth` 未应用，恰好模拟 tabs-first 的库）跑合并后 runtime，启动后补上第 20 条，agent 索引未重复创建
4. 升级前再备份一次生产库三件套到 scratchpad
5. `npx ./tmex-cli-1.0.2.tgz upgrade --apply-current-package --yes --lang zh-CN`

上线后验证：

- `/healthz` → `status: ok`，tmux 探测健康
- 前端 bundle = `index-DwjuJLYT.js`（合并版）
- 迁移条数仍为 **20**（两条都判为已应用，未重复执行）
- agent 两个索引在、hub 八张表在
- Playwright 打开 `127.0.0.1:9883`：`[role="tablist"]` 数 1，tabs 为 `["Panes","Agent","Files"]` —— 3-tab 侧边栏确认回归
- 服务日志 `[tmex] Service started on http://127.0.0.1:9883` → `[ws] client connected`

## 分支收尾

按用户要求「只留 main 和当前分支」：

- `chore/merge-hub-tabs` 推送到 origin
- 删除 `feat/hub-node`、`feat/sidebar-tabs-ui`、`chore/code-smell-cleanup` 的本地与远端分支（三者内容均已通过 `git merge-base --is-ancestor` 确认包含在合并分支中）
- 移除 worktree `wt-hub`、`wt-tabs`、`wt-smell`，只留主仓与 `wt-merge`
