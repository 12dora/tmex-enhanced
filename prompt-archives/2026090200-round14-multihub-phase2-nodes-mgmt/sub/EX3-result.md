# EX3 探索报告

结论：本地已有 `tmex uninstall`，但没有远程卸载 API；批量升级和大部分行状态目前是内存态，刷新后只能通过升级状态接口部分恢复；`/api/mesh/hubs` 已返回候选诊断，但前端 hook 丢弃了 `candidates`。

## 1. 远程清理卸载节点

### Current（files/lines）

#### CLI 与安装布局

已有 CLI 命令：

- `packages/app/src/index.ts:32-72`：`uninstall` 分支调用 `runUninstall`。
- `packages/app/src/lib/args.ts:7-28,102-107,241-243`：支持 `uninstall`、`--install-dir`、`--yes`、`--purge`、`--service-name`。
- `packages/app/src/cli/help.ts:3-24,34-55`：帮助文档已列出 `tmex uninstall` 和 `tmex hub leave`。

卸载行为：

- `packages/app/src/commands/uninstall.ts:20-42`：解析安装目录、服务名、`--purge`，默认询问是否删除服务、程序、环境和数据库。
- `packages/app/src/commands/uninstall.ts:52-69`：卸载服务，删除 runtime、resources、CLI、versions、current、staging、backups、journal、lock、run.sh、install-meta.json，并删除 shim。
- `packages/app/src/commands/uninstall.ts:71-83`：删除 `app.env` 和数据库；`--purge` 时删除整个 install directory。

默认安装目录：

- `packages/app/src/constants.ts:7-17`：
  - macOS：`~/Library/Application Support/tmex`
  - Linux：`~/.local/share/tmex`
  - 数据库：`<installDir>/data/tmex.db`
  - 默认端口：9883。

版本布局：

- `packages/app/src/lib/install-layout.ts:15-35`：定义 `versions/<version>`、`current`、`staging`、`backups`、`upgrade-state.json` 等路径。
- `packages/app/src/lib/install-layout.ts:37-62`：稳定路径包括 `app.env`、`run.sh`、`install-meta.json`、`versions`、`current`、`upgrade-state.json`。
- 当前没有名为 `journal/` 的目录；升级日志状态文件是 `upgrade-state.json`，运行日志是 `upgrade.log`，systemd 日志进入 journal。

初始化/安装：

- `packages/app/src/commands/init.ts:295-368`：检测服务管理器、部署版本、切换 `current`、部署 CLI/shim、写入环境、启动服务、写入 install metadata。
- `packages/app/src/commands/init.ts:327-338`：部署版本化 runtime、FE、drizzle、native 文件并切换 current。
- `packages/app/src/commands/init.ts:340-366`：写 `app.env`、`run.sh`、服务和 `install-meta.json`。
- `packages/app/src/lib/install.ts:83-95`：`app.env` 包含 `NODE_ENV=production`、端口、数据库、密钥、绑定地址等。
- `packages/app/src/lib/install.ts:132-174`：`run.sh` 加载 `app.env`，设置 runtime 环境，并执行 Bun 服务。
- `packages/app/src/lib/cli-shim.ts:183-232`：创建 `~/.local/bin/tmex` 和 `~/.bun/bin/tmex` shim。
- `packages/app/src/lib/cli-shim.ts:235-262`：只删除带 tmex 管理标记的 shim。

#### 服务管理抽象

- `packages/app/src/lib/platform.ts:3-24`：支持 `systemd-user`、`launchd`、`none`。
- `packages/app/src/lib/service.ts:29-43`：
  - Linux：`~/.config/systemd/user/<service>.service`
  - macOS：`~/Library/LaunchAgents/com.tmex.<name>.plist`
- `packages/app/src/lib/service.ts:45-72`：systemd unit 使用 `run.sh`，输出进入 journal，服务自动重启。
- `packages/app/src/lib/service.ts:83-115`：launchd plist 使用 `run.sh`，日志写入安装目录。
- `packages/app/src/lib/service.ts:118-189`：安装 systemd/launchd 服务。
- `packages/app/src/lib/service.ts:207-299`：停止、启动、disable、bootout 和删除服务。

当前不支持 Linux system-level unit，只支持 systemd user unit。

#### 崩溃安全升级器

- `packages/app/src/lib/upgrade-process.ts:11-15`：升级器抽象为 `stop/start/isRunning`。
- `packages/app/src/lib/upgrade-process.ts:257-327`：无服务管理器时通过 PID 文件直接停止/启动进程。
- `packages/app/src/lib/upgrade-lock.ts:15-28,94-127`：升级锁和 stale holder 处理。
- `packages/app/src/lib/upgrade-state.ts:5-29`：持久化阶段包括 `lock`、`staging`、`preflight`、`stopping`、`backup`、`switching`、`started`、`committed`、`aborted`、`rolled_back`。
- `packages/app/src/lib/upgrade-state.ts:31-55`：根据 journal 阶段决定恢复、重启旧版本或回滚。
- `packages/app/src/lib/upgrade-apply.ts:101-158`：有 service manager 时使用服务控制；`serviceMode=none` 时使用直接 PID 控制。
- `packages/app/src/lib/upgrade-apply.ts:735-844`：执行加锁、预检、停止、备份、切换 current、启动、健康检查、提交和回滚。
- `packages/app/src/lib/upgrade-apply.ts:846-895`：恢复 journal、读取 metadata/current，并在锁内执行事务。

#### 当前系统 API

- `apps/gateway/src/api/system.ts:28-72`：
  - `GET /api/system/info`
  - `GET /api/system/addresses`
  - `GET/POST/DELETE /api/system/upgrade`
  - `PUT/DELETE /api/system/upgrade/package`
- `apps/gateway/src/api/system.ts:32-34`：`upgradeCapabilities` 当前为 `['staged-package', 'upgrade-cancel']`。
- `apps/gateway/src/api/system.ts:96-146`：升级启动和 `UPGRADE_NOT_ALLOWED` 错误。
- `apps/gateway/src/api/system.ts:148-175`：取消升级、删除 staged package。
- `apps/gateway/src/api/system.ts:178-210`：上传 staged package。
- 没有 `/api/system/uninstall`。

`GET /api/system/info` 的安装能力判断：

- `apps/gateway/src/system/info-public.ts:26-44`：`canSelfUpdate` 要求 CLI 安装、受支持的部署方式、非手动管理模式。
- `apps/gateway/src/system/install-info.ts:45-98`：没有 `install-meta.json` 的生产节点会被识别为 `deployment: 'none'`、`installedViaCli: false`、`serviceName: null`。

#### 远程升级转发

- `apps/gateway/src/mesh/mesh-routes.ts:226-293`：`POST/GET/DELETE /api/mesh/nodes/:id/upgrade`，进入升级服务或转发到目标节点。
- `apps/gateway/src/mesh/forwarder.ts:107-160`：`/n/<nodeId>/api/...` 路由，目标为自身时改写为本地请求。
- `apps/gateway/src/system/upgrade-service.ts:71-205`：本地升级、远程升级、状态和取消的统一服务层。
- `apps/gateway/src/system/upgrade.ts:729-806`：升级子进程 detached spawn，父 HTTP 服务可先返回。

#### leave 与 revoke

没有 `/api/mesh/leave`。

当前 leave API：

- `packages/app/src/runtime/local-routes.ts:29-60`：`POST /api/local/leave`。
- `packages/api-client/src/local/local-api.ts:68-76`：客户端调用该 API。
- `packages/app/src/runtime/membership-reset.ts:104-130`：切换为 standalone、quiesce、清空 mesh membership、写回环境变量，并返回 `restarting: true`。
- `packages/app/src/commands/hub.ts:819-855`：CLI 的 `tmex hub leave` 会停止服务、执行 leave，再按需重启。

当前 leave 本身不会通知 hub，也不会 revoke 自己的证书。

Hub revoke：

- `apps/gateway/src/hub/hub-runtime.ts:290-339`：`POST /api/hub/nodes/:id/revoke`。
- `apps/gateway/src/hub/hub-runtime.ts:443-476`：校验签名的 `revoke-node` keylog，撤销证书并应用副作用。
- `apps/gateway/src/auth/user-key-persistence.ts:166-196`：标记证书 revoked、撤销 session、清理 peer。
- `apps/gateway/src/db/schema.ts:580-618`：`node_certs` 保留撤销记录，`nodes.status` 目前只有 `enrolled|revoked`。
- `apps/gateway/src/mesh/mesh-routes.ts:325-343`：mesh 节点列表过滤 revoked cert。
- `apps/fe/src/node/mesh-nodes.ts:44-50`：收到 revoked 事件后从前端节点列表删除。

当前 revoke 不会真正删除 `nodes` 行，只保留 revoked tombstone。

前端“remove node”：

- `apps/fe/src/pages/settings/nodes/management/use-node-row-actions.ts:39-106`：不是直接调用 `/api/hub/nodes/:id/revoke`，而是写签名 keylog 并通过 hub 同步。

### Proposed

建议新增两个层次：

```text
entry POST /api/mesh/nodes/:id/uninstall
        ↓
target POST /api/system/uninstall
        ↓ 立即返回 202
detached uninstaller
        ↓
停止/卸载服务 → 删除安装目录、shim、环境、数据
```

推荐流程：

1. Entry 在 hub operation store 中先写入 `uninstalling`。
2. 确认目标仍在线并具备 CLI 安装能力；否则返回 `UNINSTALL_NOT_ALLOWED`。
3. 目标在清除 membership 前完成自 revoke，或发送签名的 leave/revoke intent。
4. 目标调用现有 `/api/local/leave` 完成离开 mesh；注意当前 leave API 不会自动通知 hub。
5. 目标返回：

   ```json
   {
     "ok": true,
     "state": "uninstalling",
     "operationId": "..."
   }
   ```

6. detached helper 执行停止服务、卸载 launchd/systemd、删除安装内容。
7. HTTP 响应必须在父进程退出前发送；helper 不能依赖将被删除的 install directory，需先复制/启动到临时位置或系统临时目录。
8. hub 在收到 revoke ack 后移除 peer，并在成功或超时后删除 `nodes` 行；证书 tombstone 可继续保留。

模式建议：

- `full`：删除服务、shim、runtime、resources、versions、current、`app.env`、`data/tmex.db`、日志及整个安装目录。
- `keep-data`：删除服务、程序、shim、`app.env` 和 metadata，保留 `data/tmex.db`；需要明确数据库所在位置，避免被 `--purge` 一并删除。

Docker/manual deploy：

- `GET /api/system/info` 已能通过 `installedViaCli=false`、`deployment=none` 识别。
- 应返回：

  ```json
  {
    "code": "UNINSTALL_NOT_ALLOWED",
    "reason": "manual-or-container-deployment"
  }
  ```

- 不应尝试删除容器外部资源。

进度持久化建议使用独立 operation 记录，而不是复用 `nodes.status`：

```text
node_operations:
  operation_id
  node_id
  type: uninstall
  state: uninstalling|revoking|removed|failed|expired
  mode
  started_at
  last_error
  expires_at
```

前端刷新后读取 hub operation 状态；目标离线不应直接等同于失败。

### Files to touch

- `apps/gateway/src/api/system.ts`
- `apps/gateway/src/api/system-routes.ts`
- `apps/gateway/src/mesh/mesh-routes.ts`
- `apps/gateway/src/system/upgrade-service.ts`
- `apps/gateway/src/system/install-info.ts`
- `apps/gateway/src/hub/hub-runtime.ts`
- `apps/gateway/src/hub/node-persistence.ts`
- `apps/gateway/src/auth/user-key-persistence.ts`
- `apps/gateway/src/db/schema.ts`
- 新增 operation store、migration、detached uninstall helper
- `packages/app/src/commands/uninstall.ts`
- `packages/app/src/runtime/local-routes.ts`
- `packages/app/src/runtime/membership-reset.ts`
- `packages/api-client/src/local/local-api.ts`
- `packages/shared/src/contracts/system.ts`
- `apps/fe/src/pages/settings/nodes/management/*`
- `apps/fe/src/pages/settings/nodes/membership/*`

### Risks

- 当前 leave 不会自动通知 hub，必须补充签名 revoke/leave 协议。
- helper 若位于待删除目录，可能在删除自身前失效。
- hub-only 节点可能没有可用 writer hub。
- `nodes.status` 是认证状态，直接增加 `uninstalling` 会破坏现有状态语义。
- revoke 后当前系统保留行；物理删除必须考虑审计和证书 tombstone。
- “目标离线”同时可能表示正在卸载、网络异常或进程崩溃。

---

## 2. 批量升级编排持久化

### Current（files/lines）

批量顺序和并发：

- `apps/fe/src/pages/settings/nodes/management/upgrade-batch.ts:1-18`：
  - 普通节点并发数为 3；
  - 普通节点完成后升级远程 hub；
  - 最后升级本地节点。
- `apps/fe/src/pages/settings/nodes/management/upgrade-batch.ts:51-66`：实际排序为普通节点 → hub 节点 → self。
- `apps/fe/src/pages/settings/nodes/management/upgrade-batch.ts:86-143`：每组内部限并发，组间串行；单节点异常隔离。

前端行状态：

- `apps/fe/src/pages/settings/nodes/management/types.ts:43-67`：
  - `idle`
  - `pending`
  - `downloading`
  - `executing`
  - `restarting`
  - `done`
  - `failed`
- `apps/fe/src/pages/settings/nodes/management/types.ts:69-97`：batch state、outcome、controller API。

单节点恢复：

- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:46-55`：2 秒轮询，6 分钟预算，恢复并发 3。
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:160-212`：
  - `POST /api/mesh/nodes/:id/upgrade` 启动；
  - `GET /api/mesh/nodes/:id/upgrade` 读取状态；
  - `DELETE /api/mesh/nodes/:id/upgrade` 取消。
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:282-339`：轮询中断时进入 `restarting`；目标版本匹配是成功真值。
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:470-495`：刷新后只恢复已有活动升级，不重复 POST。
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:576-644`：通过 GET 状态恢复每行。
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:762-792`：每节点独立 `AbortController`。
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:930-939`：unmount 时 abort。
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:1089-1121`：mount 时恢复活动行。

摘要和取消：

- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:505-529`：全部完成后发 summary toast；全批次取消时不发普通成功 toast。
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:614-701`：取消逻辑。
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:708-760`：`UpgradeCancelGate` 处理 POST 尚未完成时的取消竞态。
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:1154-1183`：批量开始；finally 后清理 batch state。
- `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:228-277`：Upgrade All 按钮只显示进度和禁用状态，没有全局取消按钮。

当前批量计划没有持久化。刷新后只知道“某些节点已经有升级请求”，不知道原有顺序、已完成阶段或哪些节点尚未启动。

### Proposed

推荐第一阶段采用 entry 前端 `localStorage`，因为现有升级编排完全由 hook 驱动，改动较小，而且不依赖 entry 在升级期间持续运行。

建议 key：

```text
tmex.nodes.upgrade-batch.<entryNodeId>
```

建议结构：

```json
{
  "schema": 1,
  "batchId": "...",
  "entryNodeId": "...",
  "targetVersion": "...",
  "order": ["node-a", "hub-b", "self"],
  "groupIndex": 0,
  "done": [
    { "nodeId": "node-a", "outcome": "success" }
  ],
  "startedAt": "...",
  "lastProgressAt": "...",
  "cancelled": false,
  "summaryEmitted": false
}
```

恢复逻辑：

1. 启动 batch 前先写入计划。
2. 每个节点完成、失败、取消后立即更新 `done`。
3. 页面 mount 时校验 TTL、entry node、目标版本和节点顺序。
4. 对已启动但未完成的节点复用现有 `GET /api/mesh/nodes/:id/upgrade` 恢复逻辑。
5. 只恢复当前 group 中未完成的节点；当前 group 全部结束后再进入下一组。
6. 本地节点始终作为最后阶段；本地重启后从 localStorage 加载计划，再通过版本和升级状态确认完成。
7. 全部节点完成后只在 `summaryEmitted=false` 时重新发 summary toast，然后删除或标记计划完成。
8. 增加全局取消按钮，取消时将计划标记为 `cancelled`，再调用现有逐节点 DELETE。

服务端 batch record 更稳健，但复杂度明显更高：

- 需要 entry 数据库中的 batch 表、后台 scheduler、进程重启恢复。
- 需要处理 entry 自身最后升级时的 handoff。
- 需要服务端保存远程 job 状态、授权、取消和超时。
- 需要新增 `POST/GET/DELETE /api/mesh/upgrade-batch`。

因此建议：

- 当前需求：`localStorage`。
- 要求浏览器关闭后仍持续执行、支持多浏览器接管：服务端 batch record。

### Files to touch

- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts`
- `apps/fe/src/pages/settings/nodes/management/upgrade-batch.ts`
- `apps/fe/src/pages/settings/nodes/management/types.ts`
- `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx`
- 新增 `apps/fe/src/pages/settings/nodes/management/upgrade-batch-storage.ts`
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.test.ts`
- `apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx`
- 相关 i18n locale 文件

### Risks

- localStorage 会受浏览器、用户配置文件和清理策略影响。
- 多标签页可能重复恢复；需要 batchId、租约或 tab ownership。
- summary toast 需要持久化 `summaryEmitted`，否则刷新会重复提示。
- 目标版本变化后旧计划必须失效。
- entry 自身最后升级时，页面和 API 会同时中断，必须依赖版本核验而不是 HTTP 成功。

---

## 3. 刷新后必须保留的行状态

### Current（files/lines）

前端不是 zustand；节点管理主要是模块级 external store + React hook：

- `apps/fe/src/node/mesh-nodes.ts:1-6,214-245`：模块单例、监听器、`useSyncExternalStore`。
- `apps/fe/src/node/mesh-nodes.ts:314-334`：REST refresh。
- `apps/fe/src/node/mesh-hubs.ts:1-7,22-43,112-136,281-318`：hub 同样使用模块级 store。
- `apps/fe/src/pages/settings/use-protected-status-query.ts:1-12,91-127`：本地受保护状态使用 React Query。
- `apps/fe/src/pages/settings/nodes/use-local-status.ts:27-34`：调用该 React Query hook。

行模型：

- `apps/fe/src/node/mesh-nodes.ts:109-137`：`NodeRow` 包含在线性、连接、版本、直连、登录、角色、lastSeen、证书等。
- `apps/fe/src/node/mesh-nodes.ts:153-187`：mesh 节点列表是成员集合主来源，hub 数据补充状态。
- `apps/gateway/src/mesh/mesh-routes.ts:325-355`：mesh 节点投影。
- `apps/gateway/src/hub/hub-runtime.ts:376-402`：hub 管理节点投影。

状态来源：

| 状态 | 当前前端状态 | 服务端来源 | 刷新后行为 |
|---|---|---|---|
| 下载中 | `NodeUpgradeEntry.phase='downloading'` | 本地 `UpgradeController` 内存状态；远程 `remote-upgrade-job` | 活动请求可通过 GET 恢复，但服务重启后状态不持久 |
| 安装中 | 前端使用 `executing`，没有 `installing` 字面状态 | `/api/system/upgrade` 只暴露 `executing`；磁盘 journal 有更细阶段 | 依赖 GET、版本和可达性判断 |
| 取消中 | `cancelling` + `UpgradeCancelGate` | DELETE mesh upgrade、远程 job 或目标 controller | 刷新后丢失取消标志 |
| 卸载中 | 当前不存在 | 无 API、无 controller 状态、无 DB 字段 | 无法恢复或区分离线/卸载 |
| 角色切换中 | `useRoleSwitch`、`useLeaveMesh` 中的 React state | `/api/local/leave` 返回 `restarting`，无 operation record | sessionStorage 只保留导航 intent，不保留实时阶段 |
| 重命名/删除中 | `use-node-row-actions.ts` 中 React `busy` | Hub rename/keylog revoke | 刷新后只重新拉取最终数据 |

升级具体状态：

- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:899-922`：state 和 refs 都存在 hook 内存中。
- `apps/gateway/src/system/upgrade.ts:147-175`：controller 状态也是进程内存。
- `apps/gateway/src/system/remote-upgrade-job.ts:55-95`：远程 job 使用模块级 Map，非持久化。

角色切换：

- `apps/fe/src/pages/settings/nodes/local-machine-card.tsx:65-93`：角色切换 request 是 React state。
- `apps/fe/src/pages/settings/nodes/membership/use-leave-mesh.ts:90-125,161-215`：leave phase 是 React state。
- `apps/fe/src/pages/settings/nodes/membership/intent.ts:1-15,57-95`：sessionStorage 只保存路径和时间戳，TTL 10 分钟。
- `apps/fe/src/pages/settings/nodes/membership/role-transition.ts:1-41`：分类 standalone→mesh、mesh→standalone、mesh→mesh。
- `packages/app/src/runtime/membership-reset.ts:104-130`：服务端执行环境和 membership 清理，但没有持久化 operation。

### Proposed

将“认证状态”和“操作状态”分离：

- `nodes.status` 保持 `enrolled|revoked`。
- 新增 `node_operations` 表或独立 operation store。
- 每项包含 `operationId`、`nodeId`、`type`、`phase`、`startedAt`、`lastError`、`expiresAt`。
- 前端行状态由：
  1. operation API 的持久状态；
  2. 当前节点版本/在线状态；
  3. 升级 GET 状态；
  4. 本地 status query；
  
  合并生成。

至少需要新增：

```text
upgrade: downloading | executing | restarting | done | failed | cancelled
uninstall: uninstalling | revoking | removed | failed | expired
role-switch: preparing | leaving | restarting | verifying | done | failed
```

其中：

- 升级的短期活动状态仍可由现有 GET 接口提供，但 batch 计划需要额外持久化。
- 卸载必须由 hub operation 记录作为刷新后的主要来源。
- 角色切换需要 operationId，并由 `/api/local/status` + operation record 恢复。
- sessionStorage intent 仅用于跨重启导航，不应承担状态机职责。

### Files to touch

- `apps/gateway/src/db/schema.ts`
- 新增 operation migration/store/API
- `apps/gateway/src/api/system.ts`
- `apps/gateway/src/mesh/mesh-routes.ts`
- `apps/gateway/src/hub/hub-runtime.ts`
- `apps/gateway/src/hub/node-persistence.ts`
- `packages/shared/src/contracts/system.ts`
- `packages/shared/src/contracts/mesh.ts`
- `apps/fe/src/node/mesh-nodes.ts`
- `apps/fe/src/pages/settings/nodes/management/types.ts`
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts`
- `apps/fe/src/pages/settings/nodes/membership/use-leave-mesh.ts`
- `apps/fe/src/pages/settings/nodes/membership/intent.ts`
- `apps/fe/src/pages/settings/nodes/membership/role-transition.ts`
- `packages/app/src/runtime/local-routes.ts`
- `packages/app/src/runtime/membership-reset.ts`

### Risks

- 删除 `nodes` 行后，卸载 operation 不能继续依附该行，需独立表。
- 直接扩展 `nodes.status` 会混淆认证状态和业务操作状态。
- 服务端 controller/job 当前都是内存态，重启后仍需以版本、journal 或 operation record 校验。
- 角色切换涉及环境变量、证书、session 和进程重启，容易产生半完成状态。
- 长时间未清理的 operation marker 会阻塞后续操作，需要 TTL 和人工恢复路径。

---

## 4. `/api/mesh/hubs` 的 `candidates[].lastError`

### Current（files/lines）

网关候选结构：

- `apps/gateway/src/mesh/uplink-pool.ts:43-52`：

  ```text
  hubNodeId
  publicUrl
  mode
  priority
  writerEpoch
  caFingerprint
  lastError?
  lastAttemptAt?
  ```

- `apps/gateway/src/mesh/uplink-pool.ts:411-418`：诊断信息保存在内存 `diagByUrl`。
- `apps/gateway/src/mesh/uplink-pool.ts:462-473`：将诊断信息合并到 candidates。
- `apps/gateway/src/mesh/uplink-pool.ts:1052-1070`：记录尝试时间和失败信息。
- `apps/gateway/src/mesh/mesh-runtime.ts:977-983`：候选来源为已存 hub endpoint 和 seed URL。
- `apps/gateway/src/mesh/mesh-routes.ts:79-92`：序列化候选，包含 `publicUrl`、`lastError`、`lastAttemptAt`。
- `apps/gateway/src/mesh/mesh-routes.ts:202-223`：`GET /api/mesh/hubs` 返回：

  ```json
  {
    "hubs": [],
    "attached": {},
    "writerHubId": "...",
    "candidates": []
  }
  ```

共享 API 类型：

- `packages/api-client/src/auth/types.ts:244-256`：候选类型包含 `publicUrl`、`lastError`、`lastAttemptAt`。
- `packages/api-client/src/auth/auth-api.ts:78-95`：API client 正确返回 candidates。

前端实际缺口：

- `apps/fe/src/node/mesh-hubs.ts:22-31`：`MeshHubsState` 没有 `candidates`。
- `apps/fe/src/node/mesh-hubs.ts:112-136`：refresh 只保存 `hubs`、`attached`、`writerHubId`，丢弃 `payload.candidates`。
- `apps/fe/src/node/mesh-hubs.ts:281-318`：hook 返回值也没有 candidates。
- `apps/fe/src/pages/settings/nodes/management/hub-strip.tsx:1-28`：只展示 hub URL、priority、epoch、连接状态。
- `apps/fe/src/pages/settings/nodes/management/hub-strip.tsx:35-59`：props 没有 candidates。
- `apps/fe/src/pages/settings/nodes/management/hub-strip.tsx:61-95`：chip title 没有 lastError/lastAttemptAt。
- `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:164-169`：只传 hubs、attachedHubId、writerHubId。

### Proposed

先修复数据传递：

1. `MeshHubsState` 增加 `candidates`。
2. `refreshMeshHubs` 保存 `payload.candidates`。
3. `useMeshHubs` 返回 candidates。
4. `nodes-management.tsx` 传给 `HubStrip`。
5. 按规范化后的 `publicUrl` 匹配 hub。

展示建议：

- hub chip 保留简短状态。
- 对存在 `lastError` 的 chip 使用 tooltip，显示：
  - 最近尝试时间；
  - 最近错误；
  - “这是最近一次尝试，不代表当前一定失败”。
- 错误较长时使用 `Collapsible` 或详情 popover；移动端优先展开详情而不是超长 tooltip。
- 对错误做长度限制和敏感信息清理，避免展示 token、完整本地路径或内部凭证。

可用 UI：

- `packages/ui/src/components/tooltip.tsx:1-6,9-16,17-52`：
  `Tooltip`、`TooltipTrigger`、`TooltipContent`、`TooltipProvider`
- `packages/ui/src/components/collapsible.tsx:28`：
  `Collapsible`、`CollapsibleTrigger`、`CollapsibleContent`

注意：网关诊断目前是内存态，重启 gateway 后会消失。

### Files to touch

- `apps/fe/src/node/mesh-hubs.ts`
- `apps/fe/src/pages/settings/nodes/management/hub-strip.tsx`
- `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx`
- `apps/fe/src/node/mesh-hubs.test.ts`
- 新增或扩展 `hub-strip.test.tsx`
- 相关 i18n locale 文件
- 如需持久诊断，再改 `apps/gateway/src/mesh/uplink-pool.ts`

### Risks

- 现有错误消息可能包含内部 URL、路径或敏感信息。
- URL 匹配需要处理尾部 `/`、协议和默认端口。
- 旧 gateway 返回没有 candidates 时，前端必须兼容空数组。
- tooltip 在窄屏上可能溢出。
- 当前 lastError 不是历史记录，UI 文案必须使用“最近一次尝试”。

---

## 5. Nodes table、页面结构、UI kit、i18n 与测试

### Current（files/lines）

#### `nodes-table.tsx`

- `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:20-53`：表格包含 9 列：
  1. name
  2. status
  3. reach
  4. version
  5. lastSeen
  6. direct
  7. login
  8. fingerprint
  9. actions
- `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:63-73`：每行使用 `useNodeRowActions`。
- `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:75-149`：行内容和操作。
- `:121-132`：rename。
- `:133-144`：remove，实际是 revoke；self 禁用。
- `:145-149`：upgrade/cancel。
- 没有独立的“停止节点”按钮；“停止”指取消当前升级。

升级按钮：

- `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:160-186`：受 busy、block、batch、restoring 状态控制。
- `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:195-219`：取消按钮只在升级忙碌时显示；`pending/downloading` 可取消，`executing/restarting` 禁止取消。
- `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:226-244`：不可升级原因。
- `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:269-279`：HubTag。

#### `nodes-management.tsx`

- `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:42-95`：加载并合并 mesh nodes、hub node、hub list，接入升级 hook。
- `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:129-169`：页面头部，包含 refresh、Upgrade All、Add，下面是 HubStrip。
- `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:171-220`：hub notice、enrollment、nodes table。
- `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:228-277`：Upgrade All 按钮。
- Upgrade All 与 Add 按钮位于同一页面头部区域。

#### `packages/ui` 可用导出

`packages/ui/package.json:7-10` 使用根入口和 wildcard subpath；根入口：

- `packages/ui/src/index.ts:1-2`：只有 `cn`、`useIsMobile`。

因此组件应从 subpath 导入。相关精确导出：

| Import | Exports |
|---|---|
| `@tmex/ui/button` | `Button`, `buttonVariants`，`packages/ui/src/components/button.tsx:43-58` |
| `@tmex/ui/input` | `Input`，`packages/ui/src/components/input.tsx:6-20` |
| `@tmex/ui/badge` | `Badge`, `badgeVariants`，`packages/ui/src/components/badge.tsx:49` |
| `@tmex/ui/card` | `Card`, `CardHeader`, `CardFooter`, `CardTitle`, `CardAction`, `CardDescription`, `CardContent`，`packages/ui/src/components/card.tsx:92` |
| `@tmex/ui/select` | `Select`, `SelectContent`, `SelectGroup`, `SelectItem`, `SelectLabel`, `SelectScrollDownButton`, `SelectScrollUpButton`, `SelectSeparator`, `SelectTrigger`, `SelectValue`，`packages/ui/src/components/select.tsx:177-187` |
| `@tmex/ui/switch` | `Switch`，`packages/ui/src/components/switch.tsx:30` |
| `@tmex/ui/dialog` | `Dialog`, `DialogClose`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogOverlay`, `DialogPortal`, `DialogTitle`, `DialogTrigger`，`packages/ui/src/components/dialog.tsx:127-138` |
| `@tmex/ui/alert-dialog` | `AlertDialog`, `AlertDialogAction`, `AlertDialogCancel`, `AlertDialogContent`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogHeader`, `AlertDialogMedia`, `AlertDialogOverlay`, `AlertDialogPortal`, `AlertDialogTitle`, `AlertDialogTrigger`，`packages/ui/src/components/alert-dialog.tsx:149-162` |
| `@tmex/ui/dropdown-menu` | `DropdownMenu`, `DropdownMenuPortal`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuGroup`, `DropdownMenuLabel`, `DropdownMenuItem`, `DropdownMenuCheckboxItem`, `DropdownMenuRadioGroup`, `DropdownMenuRadioItem`, `DropdownMenuSeparator`, `DropdownMenuShortcut`, `DropdownMenuSub`, `DropdownMenuSubTrigger`, `DropdownMenuSubContent`，`packages/ui/src/components/dropdown-menu.tsx:246-263` |
| `@tmex/ui/tooltip` | `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider`，`packages/ui/src/components/tooltip.tsx:52` |
| `@tmex/ui/collapsible` | `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent`，`packages/ui/src/components/collapsible.tsx:28` |

没有独立 `@tmex/ui/checkbox`：

- `packages/ui/src/components/checkbox.tsx` 不存在。
- 只有 `DropdownMenuCheckboxItem`，不能替代通用 Checkbox。

#### i18n

locale 文件：

- `packages/shared/src/i18n/locales/zh_CN.json:1708-1803`：`nodes.management`、`nodes.machine`、`nodes.membership`。
- `packages/shared/src/i18n/locales/zh_CN.json:1965-2023`：columns、status、reach、actions、enrollment、rename、revoke。
- `packages/shared/src/i18n/locales/zh_CN.json:2025-2067`：upgrade 状态、错误、Upgrade All、cancel、restoring。
- `en_US.json` 和 `ja_JP.json` 保持同样层级，英文对应范围为：
  - `packages/shared/src/i18n/locales/en_US.json:1708-1803`
  - `packages/shared/src/i18n/locales/en_US.json:1965-2023`
  - `packages/shared/src/i18n/locales/en_US.json:2025-2069`

节点页面 key 按 `nodes.*` 分组：

```text
nodes.management
nodes.machine
nodes.membership
nodes.hubs
nodes.columns
nodes.status
nodes.reach
nodes.actions
nodes.enrollment
nodes.rename
nodes.revoke
nodes.upgrade
```

构建：

- `packages/shared/scripts/build-i18n.ts:1-10`：脚本用途。
- `packages/shared/scripts/build-i18n.ts:19-20`：读取 locale，生成资源和类型。
- `packages/shared/scripts/build-i18n.ts:35-71`：写入 `resources.ts` 和 `types.ts`。
- `packages/shared/scripts/build-i18n.ts:105-144`：从首个 locale 的 `translation` 树提取 key。
- `packages/shared/package.json:5-19`：提供 `build:i18n`。
- 根 `package.json:8-14`：根级 `bun run build:i18n`。

生成文件不要手改：

- `packages/shared/src/i18n/resources.ts`
- `packages/shared/src/i18n/types.ts`

#### 当前测试

相关测试文件：

- `apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx`
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.test.ts`
- `apps/fe/src/pages/settings/nodes/nodes-tab.test.tsx`
- `apps/fe/src/pages/settings/nodes/local-machine-card.test.tsx`
- `apps/fe/src/node/mesh-nodes.test.ts`
- `apps/fe/src/node/mesh-hubs.test.ts`
- `apps/fe/src/node/hub-load-coordinator.test.ts`
- `apps/fe/src/pages/settings/nodes/membership/intent.test.ts`
- `apps/fe/src/pages/settings/nodes/membership/leave-controller.test.ts`
- `apps/fe/src/pages/settings/nodes/membership/role-transition.test.ts`
- `apps/fe/src/pages/settings/nodes/membership/self-revoke.test.ts`
- `apps/fe/src/pages/settings/nodes/membership/use-leave-mesh.test.ts`

实际执行：

```text
cd apps/fe && bun test src/
```

结果：

```text
1244 pass
0 fail
3527 expect() calls
Ran 1244 tests across 77 files. [1.55s]
```

### Proposed

- 新增卸载、角色切换、候选诊断的 i18n key 时，继续放在 `nodes.*` 下。
- 如果节点操作增多，可把 action menu 从当前行内按钮扩展为 `DropdownMenu`，但现有 `remove/rename/upgrade/cancel` 结构已经满足当前功能。
- 候选诊断使用 `Tooltip`，长错误再使用 `Collapsible`。
- 若新增确认流程，使用 `AlertDialog`；普通信息展示无需新增 dialog。
- 新增 standalone Checkbox 时需要补充 `packages/ui/src/components/checkbox.tsx` 及对应导出；当前 UI kit 没有现成 Checkbox。

### Files to touch

- `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx`
- `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx`
- `apps/fe/src/pages/settings/nodes/management/hub-strip.tsx`
- `apps/fe/src/node/mesh-hubs.ts`
- `packages/shared/src/i18n/locales/zh_CN.json`
- `packages/shared/src/i18n/locales/en_US.json`
- `packages/shared/src/i18n/locales/ja_JP.json`
- 运行 `bun run build:i18n`
- 对应管理页、hub hook 和升级 hook 测试

### Risks

- 不应直接编辑生成的 i18n 文件。
- UI kit 根入口不导出组件，必须使用 `@tmex/ui/<component>`。
- 不存在独立 Checkbox，新增筛选/批量选择功能时需要补组件。
- 当前“remove”名称容易让用户误以为物理删除，实际是 revoke；若实现真正删除，应区分文案和权限。
- 当前测试全部通过，但没有覆盖远程卸载、卸载进度恢复、批量计划持久化和候选错误展示。