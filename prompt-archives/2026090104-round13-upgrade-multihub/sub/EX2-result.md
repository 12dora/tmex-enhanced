# EX2 — Nodes 管理 UI 探索报告

结论：当前已有完整的单节点升级状态机，但没有“升级全部”按钮，也没有基于版本自动禁用最新版本节点的逻辑。现有实现允许同一个 hook 并行驱动多个节点，但每个节点独立维护状态。

全程只读，未修改文件。

## 1. 文件地图

### 页面与表格

- 设置页通过 `?tab=nodes` 渲染 `NodesTab`：[SettingsPage.tsx:208](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/SettingsPage.tsx:208)
- `NodesTab` 在 mesh 模式下渲染 `NodesManagement`：[nodes-tab.tsx:18](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/nodes-tab.tsx:18)、[nodes-tab.tsx:89](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/nodes-tab.tsx:89)
- 管理页主体：[nodes-management.tsx:34](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:34)
- 表格组件：[nodes-table.tsx:16](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:16)
- 单行组件及操作区：[nodes-table.tsx:59](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:59)

### Add 按钮与 toolbar

当前 toolbar 是 `CardAction`，顺序为：

1. 刷新按钮；
2. Add 按钮。

位置：[nodes-management.tsx:109](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:109)

Add 按钮：

- `data-testid="nodes-add"`
- `onClick` 切换加入码区域
- Hub 不在线时禁用

位置：[nodes-management.tsx:129](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:129)

### Upgrade 按钮与状态机

- 行内 Upgrade 按钮：[nodes-table.tsx:147](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:147)
- 状态机/hook：[use-node-upgrade.ts:386](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:386)
- 对外控制器类型：[types.ts:49](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/types.ts:49)

当前行按钮只会因为以下条件禁用：

- 状态机正在运行；
- 节点离线；
- 远端节点未登录。

位置：[nodes-table.tsx:160](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:160)、[nodes-table.tsx:172](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:172)

当前没有检查 `row.version` 是否已经等于或高于最新版本。

### Toast / Notification

Nodes 升级直接使用 Sonner：

```ts
import { toast } from 'sonner';
```

位置：[use-node-upgrade.ts:17](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:17)

使用的 API 是：

- `toast.success(message)`
- `toast.info(message)`
- `toast.warning(message)`
- `toast.error(message)`

状态机抽象出的最小接口也明确包含这四种级别：[use-node-upgrade.ts:275](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:275)

全局 `<Toaster>` 在 `main.tsx` 挂载，位置、主题、持续时间等由此配置：[main.tsx:101](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/main.tsx:101)

应用还提供了语义化 `NotificationSink`：

- 类型：[sinks.ts:16](/Users/konata/code/tmex-enhanced-wt-r13/packages/notifications/src/sinks.ts:16)
- Sonner 适配器：[sonner-notification-sink.ts:17](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/lib/sonner-notification-sink.ts:17)

但 Nodes 升级目前没有使用 `NotificationSink`，而是直接使用 Sonner。

### Confirm Dialog

Nodes 升级当前使用浏览器原生确认框：

```ts
globalThis.confirm(...)
```

位置：[use-node-upgrade.ts:440](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:440)

Nodes 的重命名/移除也使用原生 `confirm` / `prompt`：[use-node-row-actions.ts:53](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-row-actions.ts:53)

应用确实有自定义确认组件：

- 导入路径：`@tmex/ui/alert-dialog`
- 内部基于 `@base-ui/react/alert-dialog`
- 组件包括 `AlertDialog`、`AlertDialogContent`、`AlertDialogAction`、`AlertDialogCancel` 等

实现：[alert-dialog.tsx:3](/Users/konata/code/tmex-enhanced-wt-r13/packages/ui/src/components/alert-dialog.tsx:3)

但当前 Nodes Upgrade 未使用它。

## 2. 数据流

```text
/settings?tab=nodes
  → SettingsPage
  → NodesTab
  → useMeshNodes()
  → useHubNode()
  → mergeNodes()
  → NodesTable
  → useNodeUpgrade()
```

### 节点列表

节点列表不是 `packages/stores` 中的 Zustand store，而是 `apps/fe/src/node/mesh-nodes.ts` 的模块级外部 store，配合 `useSyncExternalStore` 使用。[mesh-nodes.ts:204](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/node/mesh-nodes.ts:204)

入口 API：

- `AuthApi.listNodes()`
- 请求：`GET /api/mesh/nodes`

位置：[auth-api.ts:67](/Users/konata/code/tmex-enhanced-wt-r13/packages/api-client/src/auth/auth-api.ts:67)

常驻 owner 是 `MeshNodesResident`，挂在应用外壳中，负责轮询和 NODE_EVENT 更新：[mesh-nodes-resident.tsx:15](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/node/mesh-nodes-resident.tsx:15)、[main.tsx:139](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/main.tsx:139)

### Hub 列表

Hub 管理列表来自：

```text
GET /n/<hubNodeId>/api/hub/nodes
```

由 `HubApi.listNodes()` 请求：[hub-api.ts:63](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/node/hub-api.ts:63)

`NodesManagement` 将入口级 mesh 列表与 Hub 列表合并：[nodes-management.tsx:49](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:49)

`NodeRow.version` 的来源优先级是：

```ts
node.version ?? hub?.version ?? null
```

位置：[mesh-nodes.ts:160](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/node/mesh-nodes.ts:160)

### 最新版本

最新版本由升级 hook 请求：

```text
GET /api/mesh/upgrade/latest
```

实现：[use-node-upgrade.ts:93](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:93)

返回类型：

```ts
{
  latestVersion: string;
  changelog: string | null;
  publishedAt: string | null;
}
```

类型定义：[types.ts:21](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/types.ts:21)

该接口只返回具体最新版本，不返回当前入口节点的 `hasUpdate`。后端实际从 GitHub Releases 查询发行版本：[update-check.ts:89](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/update-check.ts:89)

### `isSelf`、`isHub` 与角色

`AuthModeResponse`：

- `nodeId`：当前入口节点 ID；
- `hubNodeId`：Hub 所在节点 ID。

位置：[auth/types.ts:25](/Users/konata/code/tmex-enhanced-wt-r13/packages/api-client/src/auth/types.ts:25)

`MeshNode`：

- `isHub?: boolean`
- `loggedIn`
- `online`
- `version`

位置：[auth/types.ts:191](/Users/konata/code/tmex-enhanced-wt-r13/packages/api-client/src/auth/types.ts:191)

合并为 `NodeRow` 时：

- `isSelf`：`node.id === entryNodeId`
- `isHub`：节点自身的 `isHub === true`，或匹配 `mode.hubNodeId`

位置：[mesh-nodes.ts:154](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/node/mesh-nodes.ts:154)

本机角色是另一套类型，仅用于本机状态卡：

```ts
type LocalRole = 'standalone' | 'node' | 'hub,node'
```

位置：[local/types.ts:3](/Users/konata/code/tmex-enhanced-wt-r13/packages/api-client/src/local/types.ts:3)

### 当前版本比较

当前前端没有在渲染 Upgrade 按钮时比较 `row.version` 与 `latest.latestVersion`。

升级成功后的版本确认是字符串严格相等：

```ts
version === ctx.targetVersion
```

位置：[use-node-upgrade.ts:221](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:221)

后端在真正启动升级前会做“当前版本大于等于最新版本”判断：

```ts
compareVersions(currentVersion, latestVersion) >= 0
```

位置：[upgrade-service.ts:35](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/upgrade-service.ts:35)

`compareSemver` 确实存在并从 `@tmex/shared` 导出：[semver.ts:50](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/src/semver.ts:50)、[shared/index.ts:26](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/src/index.ts:26)

但当前 `apps/fe` Nodes 实现没有使用它。该工具对无法解析的版本返回 `null`：[semver.ts:51](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/src/semver.ts:51)

## 3. 现有升级状态机

### 状态

```ts
'idle'
'pending'
'downloading'
'executing'
'restarting'
'done'
'failed'
```

定义：[types.ts:28](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/types.ts:28)

`NodeUpgradeEntry` 包含：

- `phase`
- `targetVersion`
- `error`

位置：[types.ts:41](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/types.ts:41)

### 公共 API

```ts
interface NodeUpgradeController {
  latest: NodeUpgradeLatest | null;
  entryOf(nodeId: string): NodeUpgradeEntry;
  start(row: NodeRow): void;
}
```

位置：[types.ts:49](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/types.ts:49)

hook 由 `NodesManagement` 创建一次，再传给所有表格行：[nodes-management.tsx:80](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:80)

### 流程

1. POST `/api/mesh/nodes/:id/upgrade`
2. 已启动则观察 `downloading` / `executing`
3. 节点重启阶段允许暂时不可达
4. 节点恢复后重新拉取 `/api/mesh/nodes`
5. 读取目标节点版本确认结果

核心流程：[use-node-upgrade.ts:340](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:340)

POST 请求本身不重试。网络异常或 `NODE_UNREACHABLE` 会进入 `unconfirmed`，因为目标可能已经开始升级：[use-node-upgrade.ts:130](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:130)

### 时间与轮询

- 轮询间隔：2 秒
- 总预算：6 分钟
- 未进入活动状态的宽限时间：30 秒

位置：[use-node-upgrade.ts:28](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:28)

5xx 会继续重试；明确的 4xx/业务错误会收尾：[use-node-upgrade.ts:61](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:61)

### Toast 级别

- `alreadyLatest`：info
- POST 丢响应：warning
- 启动成功：success
- 完成：success
- 确定性失败：error
- 超时/未确认：warning

实现：[use-node-upgrade.ts:294](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:294)

### 并发能力

hook 内部维护：

```ts
Record<string, NodeUpgradeEntry>
Set<string> runningRef
```

位置：[use-node-upgrade.ts:391](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:391)

因此：

- 同一个节点不能重复启动；
- 不同节点可以由同一个 hook 并行升级；
- 所有节点共享同一个 hook 生命周期级 `AbortController`；
- 组件卸载会取消全部在途升级。

位置：[use-node-upgrade.ts:396](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:396)、[use-node-upgrade.ts:440](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:440)

### Hub 重启风险

后端远端升级通过 peer link 转发：

- GET 状态转发到目标节点的 `/api/system/upgrade`
- POST 升级转发到目标节点的 `/api/system/upgrade`

位置：[upgrade-service.ts:193](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/upgrade-service.ts:193)

Hub 管理 API 本身也通过 `/n/<hub>/api/hub/*` 经入口转发到 Hub：[hub-api.ts:1](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/node/hub-api.ts:1)

节点链路支持 `relay`，且 relay 的 peer 地址就是 Hub 地址：[peer-manager.ts:433](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/peer-manager.ts:433)

本机升级会停止当前 gateway 并部署后重启：[upgrade.ts:50](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/upgrade.ts:50)

因此“升级 Hub 会中断依赖 Hub 的 relay/管理请求”符合当前架构。未找到专门验证“Hub 升级期间所有其它请求失败”的前端 E2E；该运行时组合行为尚未在本次执行中实测。

## 4. i18n 与测试

### i18n 位置

节点管理文案位于每个 locale 的：

```text
translation.nodes
```

例如中文对象起始于：[zh_CN.json:1707](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/src/i18n/locales/zh_CN.json:1707)

设置页标签名位于：

```text
translation.settings.tabGroup.nodes
```

位置：[zh_CN.json:351](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/src/i18n/locales/zh_CN.json:351)

### 已有 `nodes.upgrade` keys

三个 locale 的 key 集合一致：

```text
action
hint
latestPending
confirmSelf
confirmRemote
started
startUnconfirmed
stateDownloading
stateExecuting
stateRestarting
done
failed
alreadyLatest
offline
loginRequired
unreachable
nodeGone
inProgress
notAllowed
unsupported
releaseUnavailable
timeout
```

中文定义：[zh_CN.json:2011](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/src/i18n/locales/zh_CN.json:2011)

### 重建命令

根目录标准命令：

```bash
bun run build:i18n
```

根脚本：[package.json:8](/Users/konata/code/tmex-enhanced-wt-r13/package.json:8)

其底层执行：

```bash
bun run --filter @tmex/shared build:i18n
```

脚本定义：[packages/shared/package.json:17](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/package.json:17)

只编辑 locale JSON；`resources.ts` 与 `types.ts` 由脚本生成，不应手工修改。

### 本次基线

执行：

```bash
cd apps/fe && bun test src/
```

结果：

```text
1140 pass
0 fail
3196 expect() calls
75 files
```

执行：

```bash
bunx tsc --noEmit -p apps/fe
```

结果：退出码 0，无诊断输出。

Nodes 相关静态渲染和状态机测试位于：[nodes-management.test.tsx:88](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx:88)

## 5. E2E / Playwright

### 现有 spec

没有发现覆盖 Nodes 管理表格、Upgrade 或 Add 按钮的 Playwright spec。

已有 mesh E2E：

- [apps/fe/tests/mesh-login.spec.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/tests/mesh-login.spec.ts)
- [apps/fe/tests/mesh-passkey.spec.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/tests/mesh-passkey.spec.ts)

它们覆盖 mesh 登录、远端节点登录、侧栏、远端终端和 passkey，不覆盖 Nodes 管理页。

### mesh project 配置

配置文件：[playwright.config.ts:29](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/playwright.config.ts:29)

mesh 模式下注册：

- `mesh-setup`
- `mesh-teardown`
- `mesh`

其中 `mesh` project 匹配：

```text
mesh-*.spec.ts
```

并依赖 `mesh-setup`：[playwright.config.ts:101](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/playwright.config.ts:101)

mesh-only 时不启动 standalone gateway/vite：[playwright.config.ts:121](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/playwright.config.ts:121)

运行器根据 `--project` / `--grep` 自动设置 mesh 环境：[run-e2e.ts:76](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/scripts/run-e2e.ts:76)

## 6. 实现建议

### “Upgrade all”

建议复用现有 `runNodeUpgrade()`，不要新增后端批量接口。

建议流程：

1. 点击时保存当前 `rows` 快照；
2. 只选择在线、远端已登录或本机节点；
3. 若最新版本已加载，使用 `compareSemver(row.version, latestVersion) < 0` 筛选；
4. 使用明确优先级排序：

```text
非 Hub、非 self
远端 Hub
self
```

若 self 同时是 Hub，则它只在最后处理一次。

5. 按排序结果串行执行，避免 Hub/self 重启破坏其它节点的 relay；
6. 批量执行时抑制单节点 toast；
7. 每个节点最终按 `done` / 失败或超时计数；
8. 全部结束后只显示一次：

```text
成功 X，失败 Y
```

当前 `runNodeUpgrade()` 返回 `void`，因此需要先让核心流程返回可聚合的结果，或增加 batch observer。直接循环调用现有 `start()` 会产生多个原生确认框和多组单节点 toast，不适合作为批量入口。

### 最新版本禁用

建议新增一个纯函数，例如：

```ts
isNodeAtLatest(version, latestVersion): boolean
```

仅在：

```ts
compareSemver(version, latestVersion) >= 0
```

时禁用按钮。

如果版本为空或无法解析，应保留按钮可用，让后端继续作为最终权威；`compareSemver()` 对无法解析的输入返回 `null`。

### 最小改动范围

建议触及：

- `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx`
  - 在 Refresh 与 Add 之间加入 Upgrade all；
- `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx`
  - 增加 latest 判断并禁用行按钮；
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts`
  - 批量排序、串行执行、聚合结果、批量 toast；
- `apps/fe/src/pages/settings/nodes/management/types.ts`
  - 扩展 `NodeUpgradeController`；
- `packages/shared/src/i18n/locales/en_US.json`
- `packages/shared/src/i18n/locales/zh_CN.json`
- `packages/shared/src/i18n/locales/ja_JP.json`
  - 增加 Upgrade all、批量确认和汇总文案；
- `apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx`
  - 增加最新版本禁用、排序、成功/失败汇总测试；
- 可选新增 `apps/fe/tests/mesh-nodes.spec.ts`
  - 覆盖真实 Nodes 页面交互。

不需要修改 `packages/api-client` 或后端升级路由；现有单节点 API 已支持本机、远端、版本预检查和状态查询。