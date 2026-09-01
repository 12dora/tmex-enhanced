# 只读代码探索报告

本次只读取源码、测试与 `package.json`，未修改文件、未启动服务、未运行测试。

## Bug A 根因

### 文案来源

前端只会把 `UPGRADE_NOT_ALLOWED` 映射为该文案：

- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:47-55`
- 英文文案：`packages/shared/src/i18n/locales/en_US.json:2030`

`UPGRADE_UNSUPPORTED` 是另一条文案，表示目标版本过旧：

- `en_US.json:2031`
- 中文文案：`zh_CN.json:2030-2031`

### 实际判断条件

gateway 的权威能力字段在：

`apps/gateway/src/system/info-public.ts:27-44`

```ts
canSelfUpdate =
  canSelfUpdateManaged(
    install.installedViaCli && install.deployment !== 'none',
    config.isProd
  ) &&
  getManagementMode() === 'none';
```

`canSelfUpdateManaged` 的外部托管判断在：

`apps/gateway/src/system/managed.ts:96-103`

因此正常路径下，等价条件是：

```text
production
且通过 tmex-cli 安装
且 deployment 不是 none
且不是外部托管
且 managementMode === none
```

安装信息来源：

`apps/gateway/src/system/install-info.ts:45-97`

- 缺少或无法解析 `install-meta.json`：`installedViaCli=false`、`deployment=none`
- `meta.platform` 不是 `darwin` / `linux`：`deployment=none`
- `TMEX_INSTALL_DIR` / `TMEX_FE_DIST_DIR` 指向错误目录，也会间接导致找不到 metadata

远程升级时，gateway 先转发目标节点的 `/api/system/info`：

`apps/gateway/src/system/upgrade-service.ts:193-220`

其中：

```ts
if (info.canSelfUpdate === false) {
  return UPGRADE_NOT_ALLOWED;
}
```

本机升级也会在真正启动 controller 前检查：

`upgrade-service.ts:166-175`

### 不是哪个条件

当前代码中，产生该文案时：

- 不是 `packages/app` 的服务管理器探测结果。
- 不是 upgrader 已经执行到下载、替换阶段后的失败。
- 不是当前版本低于某个 gateway 后端最低版本。
- `detectServiceManager()` 位于 `packages/app/src/lib/platform.ts:12-24`，主要用于 CLI 初始化和服务控制，不参与 gateway 的 `canSelfUpdate` 判断。
- 远程目标返回 HTTP 404 时，gateway 映射为 `UPGRADE_UNSUPPORTED`，不是 `UPGRADE_NOT_ALLOWED`：`upgrade-service.ts:146-163`。

### Docker / 无服务管理器是否可以工作

可以，但有前提。

CLI 支持 `--no-service` 安装：

- `packages/app/src/commands/init.ts:295-300`
- metadata 会写入 `serviceMode: 'none'`：`init.ts:356-366`

升级器在 `serviceMode=none` 时使用直接进程控制：

- `packages/app/src/lib/upgrade-apply.ts:138-157`
- 停止并重新启动 `bash run.sh`：`packages/app/src/lib/upgrade-process.ts:259-326`
- gateway 先启动 detached upgrader 子进程：`apps/gateway/src/system/upgrade.ts:213-264`

所以，具备以下条件的 Docker 部署理论上可以原地升级：

- 由 `tmex-cli init --no-service` 创建；
- 有有效的 `install-meta.json`；
- 有可验证的 `tmex.pid`；
- 安装目录可写；
- `run.sh` 能够在旧进程退出后重新启动 gateway；
- 容器不会因为主进程退出而立即终止整个容器。

当前实现不会调用 Docker restart，也不会 exec-replace PID 1；它只是停止旧进程，再 detached 启动 `run.sh`。如果 gateway 是容器 PID 1，容器生命周期是否允许这种方式成功，源码无法保证，属于未验证行为。

一个值得注意的不一致是：gateway 的 `deployment` 只按 `meta.platform` 映射。Linux 即使 `serviceMode='none'`，仍会被映射为 `systemd`：

`apps/gateway/src/system/install-info.ts:55-58,90-97`

因此：

- CLI 管理的 Linux `--no-service` 安装可能被 gateway 判定为可自更新；
- 手动 Docker 部署若没有 metadata，则会被 gateway 直接判定为不可自更新。

## Bug B 根因

### 当前代码的完整路径

1. UI 使用 mesh 节点的实际 `row.id`：

   - `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:151-167`
   - `use-node-upgrade.ts:471-503`

2. `runtimeNodeId` 不参与升级请求。它只把入口节点映射为 `self`：

   - `apps/fe/src/node/mesh-nodes.ts:38-41`
   - 升级仍使用 `row.id`。

3. gateway 只把以下两种 ID 视为本机：

   `apps/gateway/src/system/upgrade-service.ts:21-23`

   ```text
   nodeId === localNodeId
   或 nodeId === "self"
   ```

4. mesh route 注入的 `localNodeId` 是当前 gateway 的真实 identity ID：

   `apps/gateway/src/mesh/mesh-routes.ts:193-216`

5. 如果 `tmex` 是另一个真实 node ID，就进入远程分支：

   `upgrade-service.ts:193-229`

   顺序是：

   ```text
   GET 目标 /api/system/info
   读取目标 baseVersion 与 canSelfUpdate
   如果目标已是最新，返回 UPGRADE_ALREADY_LATEST
   否则 POST 目标 /api/system/upgrade
   ```

6. 转发器使用目标 ID 查找 peer link 和目标节点 session：

   `apps/gateway/src/mesh/forwarder.ts:254-318`

7. 目标节点收到请求后，在目标进程内 dispatch：

   - `apps/gateway/src/mesh/stream-targets.ts:233-241`
   - `apps/gateway/src/mesh/mesh-runtime.ts:930-948`
   - 目标自己的 `/api/system/info` 和 `/api/system/upgrade`：`apps/gateway/src/api/system.ts:25-31,44-51`

### 结论

当前 checkout 中没有证据表明“远程 hub 自动被解析成了本机”。

如果请求 URL 是：

```text
/api/mesh/nodes/<远程真实 nodeId>/upgrade
```

那么 `upgrade-service.ts:193-220` 的 `UPGRADE_ALREADY_LATEST` 只可能来自：

```text
目标节点 /api/system/info 返回 baseVersion >= latestVersion
```

本机版本只会在 `upgrade-service.ts:178-181` 的本机分支中参与判断，而该分支要求 node ID 等于本机实际 ID 或 `self`。

### 最符合现象的源码解释：UI 版本过旧且未刷新

UI 表格版本来自缓存/列表，而升级前的“是否已最新”来自目标节点实时 `/api/system/info`，两者不是同一数据源。

前端合并版本时，mesh 版本优先于 hub API 版本：

`apps/fe/src/node/mesh-nodes.ts:159-177`

```ts
version: node.version ?? hub?.version ?? null
```

mesh 版本可能来自 `peer_cache.inventory_json`：

`apps/gateway/src/mesh/node-list-projection.ts:48-69,151-210`

此外，hub 构造 `node.list` 时，如果没有自己的 live registry 信息，会使用数据库中已有版本：

`apps/gateway/src/hub/uplink-server.ts:1098-1112`

因此可能出现：

```text
表格缓存版本：1.1.5
目标实时 /api/system/info：1.1.10
```

此时后端正确返回：

```json
{
  "code": "UPGRADE_ALREADY_LATEST",
  "nodeId": "<远程 node id>",
  "version": "1.1.10"
}
```

而前端对 `alreadyLatest` 只弹提示，不触发刷新：

`apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:310-314`

所以表格仍可能继续显示 1.1.5，造成“返回本地 1.1.10、但什么都没做”的错觉。

这可以解释现象，但现场实际目标是否已经是 1.1.10、请求中携带的 node ID 是否为远程 ID，单凭仓库无法确认，标记为未验证。应以实际请求 URL、gateway 日志以及转发的 `/api/system/info` 响应为准。

另外，字面量 `"hub"` 是 `peer_cache` 的 metadata sentinel，不是正常 mesh 节点 ID：

- `apps/gateway/src/auth/user-store.ts:149,397-430`
- `apps/gateway/src/mesh/mesh-runtime.ts:811-837`

生产节点列表使用真实 node ID：

- `apps/gateway/src/hub/hub-runtime.ts:244-269`
- `packages/api-client/src/auth/types.ts:191-220`

## API shapes

契约定义位于 `packages/shared/src/contracts/system.ts:51-94`，路由位于 `apps/gateway/src/mesh/mesh-routes.ts:101-125,176-226`，业务服务位于 `apps/gateway/src/system/upgrade-service.ts`。

### `GET /api/mesh/upgrade/latest`

请求：

```http
GET /api/mesh/upgrade/latest
Cookie: <本地 session>
```

成功 `200`：

```json
{
  "latestVersion": "1.1.10",
  "changelog": "…",
  "publishedAt": "2026-08-30T00:00:00.000Z"
}
```

类型：`MeshUpgradeLatest`

失败：

```json
{"code":"UNAUTHORIZED"}
```

`401`：缺少本地 session。

```json
{"code":"RELEASE_UNAVAILABLE"}
```

`502`：GitHub release、tarball 或版本格式不可用。

### `POST /api/mesh/nodes/:id/upgrade`

前端当前发送空 JSON：

```http
POST /api/mesh/nodes/:id/upgrade
Content-Type: application/json

{}
```

mesh endpoint 不使用请求体，而是自行解析最新版本。前端代码见 `use-node-upgrade.ts:141-152`。

成功 `200`：

```json
{
  "state": "downloading",
  "targetVersion": "1.1.10",
  "error": null,
  "startedAt": "2026-08-30T00:00:00.000Z"
}
```

`state` 枚举只有：

```text
idle | downloading | executing
```

错误：

| 状态 | code | 含义 |
|---|---|---|
| 401 | `UNAUTHORIZED` | 本地 session 缺失 |
| 401 | `NODE_LOGIN_REQUIRED` | 远程目标 session 缺失 |
| 404 | `NOT_FOUND` | node 未 enrolled 或已撤销 |
| 404 | `UPGRADE_UNSUPPORTED` | 转发到目标后得到 404，通常表示目标 endpoint 不存在 |
| 403 | `UPGRADE_NOT_ALLOWED` | 目标或本机不允许程序内升级 |
| 409 | `UPGRADE_IN_PROGRESS` | 目标已有升级进行中 |
| 409 | `UPGRADE_ALREADY_LATEST` | 目标实时版本已达到最新版本 |
| 502 | `RELEASE_UNAVAILABLE` | 无法解析最新 release |
| 503 | `NODE_UNREACHABLE` | peer link 或转发不可达 |

`MeshUpgradeError` 形状：

```json
{
  "code": "UPGRADE_ALREADY_LATEST",
  "nodeId": "<node id>",
  "version": "1.1.10"
}
```

其中 `nodeId`、`version` 是可选字段。

### `GET /api/mesh/nodes/:id/upgrade`

请求：

```http
GET /api/mesh/nodes/:id/upgrade
```

成功 `200`：

```json
{
  "state": "idle",
  "targetVersion": null,
  "error": null,
  "startedAt": null
}
```

类型：`UpgradeStatus`

远程请求会转发为：

```http
GET /api/system/upgrade
```

见：

- `apps/gateway/src/system/upgrade-service.ts:93-115`
- `apps/gateway/src/api/system.ts:44-47,67-70`

GET 不会主动产生 `UPGRADE_ALREADY_LATEST`；该错误只在 POST 的启动前检查中产生。

## version propagation

版本传播链路如下：

```text
目标 gateway getDisplayVersion()
        ↓
node.status / node.list
        ↓
peer_cache.inventory_json 或 hub nodes.version
        ↓
GET /api/mesh/nodes
        ↓
前端 mesh store / NODE_EVENT
        ↓
NodesManagement 表格
```

关键位置：

- 目标自身状态：`apps/gateway/src/mesh/mesh-runtime.ts:762-780`
- direct peer 写入 `peer_cache`：`apps/gateway/src/mesh/peer-manager.ts:1743-1773`
- hub 接收 `node.status` 并更新节点版本：`apps/gateway/src/hub/uplink-server.ts:617-669`
- hub 构造 `node.list`：`uplink-server.ts:1065-1130`
- node 接收并持久化 `node.list`：`apps/gateway/src/mesh/uplink-client.ts:566-608`
- node.list 事件更新：`apps/gateway/src/mesh/mesh-runtime.ts:786-839`
- `/api/mesh/nodes` 从 peer cache 投影：`apps/gateway/src/mesh/node-list-projection.ts:151-210`
- 浏览器请求列表：`apps/fe/src/node/mesh-nodes.ts:304-324`
- 前端版本合并：`mesh-nodes.ts:159-177`

刷新节奏：

- mesh REST 兜底轮询：5 分钟：`mesh-nodes.ts:394-405`
- 前台恢复后，超过 30 秒会判定为 stale：`mesh-nodes.ts:401-402`
- mesh event 触发补拉，节流 2 秒：`mesh-nodes.ts:404-405`
- hub 管理 API 轮询：30 秒：`mesh-nodes.ts:407-408,721-725`
- 进入节点管理页会主动刷新：`nodes-management.tsx:45-53`

升级完成后的刷新：

- 只有确认目标版本等于目标版本后才算 `done`：`use-node-upgrade.ts:232-255`
- `done` 或 timeout 会调用 `onChanged()`：`use-node-upgrade.ts:334-338`
- `onChanged()` 会刷新 mesh 列表和 hub 列表：`nodes-management.tsx:81-87`
- `alreadyLatest` 当前不会触发刷新：`use-node-upgrade.ts:310-314`

因此存在 stale-version 问题，尤其是：

1. 表格版本来自缓存；
2. 后端启动前检查使用目标实时 `/api/system/info`；
3. `alreadyLatest` 分支不会刷新表格。

## concurrency notes

### 单节点并发

目标 gateway 内有一个进程级全局 `UpgradeController`：

`apps/gateway/src/system/upgrade.ts:96-125,559`

同一进程已有升级时，`start()` 返回 false，并映射为 `UPGRADE_IN_PROGRESS`。

该锁只覆盖单个 gateway 进程，不是 mesh 全局锁。

### 前端手动点击

前端 `runningRef` 是按 node ID 保存的集合：

`apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:432-434,486-492`

因此：

- 同一个节点不能重复启动；
- 不同节点可以并行升级；
- 没有跨浏览器标签页或跨客户端的全局锁。

### 当前已有的 Upgrade All 调度

代码中已经存在批量升级调度：

`apps/fe/src/pages/settings/nodes/management/upgrade-batch.ts`

策略：

1. 普通节点最多并发 3 个：`upgrade-batch.ts:11-15,95-113`
2. 远端 hub 组等待普通节点全部完成：`upgrade-batch.ts:55-65,115-128`
3. 本机 self 最后执行
4. 本机同时是 hub 时只进入最后一组

对应测试：

`apps/fe/src/pages/settings/nodes/management/use-node-upgrade.test.ts:189-245`

这只是前端调度约束，不能防止另一浏览器或手动 API 请求并发升级。

### hub relaying 与 hub 自身升级

没有 gateway 侧的 mesh-wide guard，禁止 hub 在转发其它升级时升级自己。

如果 hub 正在重启：

- 已有转发 stream 可能中断；
- GET 是幂等请求，最多进行 failover 重试 4 次：`apps/gateway/src/mesh/mesh-deps.ts:21-24`、`forwarder.ts:254-285`
- POST 不重试：`forwarder.ts:266-285`
- 目标可能已经开始升级但响应丢失，前端会按“结果未确认/重启中”继续轮询：`use-node-upgrade.ts:9-10,154-169,257-283`

升级子进程是 detached 的，目标 gateway 重启后 controller 状态会重新从内存 `idle` 开始；升级状态没有跨进程持久化。前端最终依赖目标重新上线后的版本确认。

## tests

### gateway

主要覆盖：

- `apps/gateway/src/mesh/mesh-routes.test.ts`
  - latest API：`1002-1063`
  - 远程 `/api/system/info` → `/api/system/upgrade`：`1065-1118`
  - 目标已是最新且不发送 POST：`1260-1288`
  - POST 不重试：`1290-1315`
  - 远程 GET status：`1373-1409`
  - 本机升级 status：`1411-1427`
  - 本机 `canSelfUpdate=false`：`1449-1479`
- `apps/gateway/src/system/upgrade-service.test.ts`
- `apps/gateway/src/system/upgrade.test.ts`
- `apps/gateway/src/api/system.test.ts`
- `apps/gateway/src/api/system-managed.test.ts`
- `apps/gateway/src/mesh/forwarder.test.ts`
- `apps/gateway/src/mesh/stream-targets.test.ts`
- `apps/gateway/src/mesh/node-list-projection.test.ts`
- `apps/gateway/src/mesh/uplink-client.test.ts`
- `apps/gateway/src/hub/uplink-server.test.ts`

gateway baseline：

```bash
cd apps/gateway
bun test
```

来源：`apps/gateway/package.json:11`

### 前端

- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.test.ts`
- `apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx`
- `apps/fe/src/node/mesh-nodes.test.ts`
- `apps/fe/tests/mesh-login.spec.ts`
- `apps/fe/tests/mesh-passkey.spec.ts`

前端 `test` 实际运行 E2E：

```bash
cd apps/fe
bun run test
```

等价于：

```bash
bun run test:e2e
```

来源：`apps/fe/package.json:10-12`

### CLI upgrader

- `packages/app/src/commands/upgrade.test.ts`
- `packages/app/src/lib/platform.test.ts`
- `packages/app/src/lib/service.test.ts`
- `packages/app/src/lib/upgrade-apply.test.ts`
- `packages/app/src/lib/upgrade-process.test.ts`
- `packages/app/src/lib/upgrade-legacy.test.ts`
- `packages/app/src/lib/upgrade-lock.test.ts`
- `packages/app/src/lib/upgrade-health.test.ts`
- `packages/app/src/lib/upgrade-state.test.ts`
- `packages/app/src/lib/upgrade-switch.test.ts`
- `packages/app/src/lib/upgrade-verify.test.ts`

baseline：

```bash
cd packages/app
bun test src
```

来源：`packages/app/package.json:26`

### 其它包

```bash
cd packages/api-client && bun test
cd packages/shared && bun test
```

来源：

- `packages/api-client/package.json:11-13`
- `packages/shared/package.json:17-20`

根目录测试脚本：

```bash
bun run test
```

实际执行：

```bash
bun run --filter '*' test
```

来源：根目录 `package.json:20`。

本次未执行上述测试。

## recommended minimal fixes

- Bug A：将 `canSelfUpdate` 的判断改为明确识别 `install-meta.json` 中的 `serviceMode`，区分“CLI no-service 安装”和“手动 Docker 部署”。重点文件：
  - `apps/gateway/src/system/install-info.ts`
  - `apps/gateway/src/system/info-public.ts`
  - `packages/shared/src/contracts/system.ts`

- 为 `UPGRADE_NOT_ALLOWED` 增加可诊断原因，区分 metadata 缺失、外部托管、无 PID、无服务管理器和容器生命周期不兼容。重点文件：
  - `apps/gateway/src/system/upgrade-service.ts`
  - `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts`
  - i18n locale 文件

- 为 Docker no-service 模式补充明确测试矩阵，至少覆盖 `serviceMode=none`、缺少 pid、错误 pid、可写安装目录和容器主进程退出场景。重点文件：
  - `apps/gateway/src/system/upgrade.test.ts`
  - `packages/app/src/lib/upgrade-process.test.ts`
  - `packages/app/src/lib/platform.test.ts`

- Bug B：先增加升级启动日志，记录 `requestedNodeId`、`localNodeId`、分支类型、目标 `/api/system/info` 的 `baseVersion` 与 `canSelfUpdate`。当前源码无法证明存在 node ID 错映射，因此不建议直接修改路由判断。

- 修复 `alreadyLatest` 后不刷新列表的问题：`use-node-upgrade.ts:310-314` 应触发一次 `onChanged()`，避免继续显示旧版本。

- 修复 hub 自身版本传播：确保 hub 生成 `node.list` 时使用当前 gateway 的 live version，而不是仅使用数据库已有版本。重点文件：
  - `apps/gateway/src/hub/uplink-server.ts`
  - `apps/gateway/src/mesh/uplink-client.ts`

- 为“入口不是 hub、目标是远程 hub”的真实双 gateway 场景增加端到端测试，验证实际 node ID、目标 `/api/system/info` 和最终 POST 都指向远程 hub。重点文件：
  - `apps/gateway/src/mesh/integration/mesh.integration.test.ts`
  - `apps/gateway/src/mesh/mesh-routes.test.ts`
  - `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.test.ts`