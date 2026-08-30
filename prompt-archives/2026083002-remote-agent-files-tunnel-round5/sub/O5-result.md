# O5 结果 — 远端节点 agent 前端收尾

## 做了什么

### 1. `usePaneAgentState` 读宿主 store 并按 node 过滤（O1 遗留 1）

- `packages/stores/src/use-pane-agent-state.ts`：`selectPaneAgentState(state, deviceId, paneId, nodeId)`
  新增第 4 个必填参数 `nodeId: string | null`，命中前先过 `isSessionOnNode(session, nodeId)`。
  会话表是全 mesh 一份（都由 entry 网关持有），不同 node 上的 device:pane 会重名，不过滤就会拿
  别的 node 的会话点亮本 node 的徽标。
  顺带删掉一段死代码：原实现读 `state.inProgress[session.id]` 后两条分支都 `return 'generating'`。
- `packages/stores/src/react.tsx`：hook 改为
  `resolveAgentStore(runtime.stores.agent)` + `normalizeAgentNodeId(runtime.nodeId)`，
  于是 `/n/:id` 路由下分屏 pane 的「Agent 已绑定 / 输出中」徽标恢复点亮（此前读的是远端 node 自己
  那份空 store，永远是 none）。standalone / 未注册解析器时回落到路由 runtime 自己的 store，
  单 node 行为不变。

### 2. 两份离线判定合并（O1 遗留 4 / O2a 第 4 节）

- 新增 `apps/fe/src/node/node-offline.ts`，导出唯一的纯函数
  `isNodeOffline(nodes, entryNodeId, nodeId)`：`self` 查 entry 自身那条；名单里没有该 node
  （standalone、mesh 列表还没回来）按在线算。放在 `@/node/` 下正是为了避开
  `app-sidebar → sidebar-device-list → sidebar-agent-sessions → use-sidebar-agent-sessions` 这条环。
- 删除 `app-sidebar.tsx` 的 `isRouteNodeOffline` 与 `use-sidebar-agent-sessions.ts` 的 `isNodeOffline`，
  两处 hook（`useRouteNodeOffline` / `useNodeOffline`，都是 `useMeshNodes({ enabled: false })`）
  改调新模块，语义与调用方式不变。
- 实现取的是 O2a 那版（先把 `self` 映射成 entryId 再按 `node.id` 找行），它是两者的超集：
  O1 那版用 `toRuntimeNodeId(node.id, entryNodeId) === runtimeNodeId` 比较，遇到路由写成
  `/n/<entryId>/…`（裸 entry id 而非 `self`）时会找不到行、把离线的 entry 判成在线；新实现两种写法都对。
  两边现有断言全部保留并通过。

### 3. 测试

- 新增 `packages/stores/src/use-pane-agent-state.test.ts`（6 例）：状态映射（idle/waiting_confirmation →
  bound、running → generating、stopped/error → none）、跨 node 同名 device:pane 不串台、`self` 与 `null`
  等价、device/pane 不匹配。
- 新增 `apps/fe/src/node/pane-agent-state.test.tsx`（4 例，`react-dom/server` 静态渲染）：注册宿主解析器后，
  远端 runtime 下的 pane 读的是宿主 store（路由 runtime 自己的 store 为空仍能点亮）、别的 node 的会话
  不点亮本 node、running → generating、未注册解析器时回落。放在 fe 而非 stores：`packages/stores` 没有
  react-dom 依赖，加依赖要动 lockfile，并行改同一 worktree 时不合适。
- 新增 `apps/fe/src/node/node-offline.test.ts`（5 例）：合并 O2a 的 4 例与 O1 的 3 例，补一条「entry 离线
  不影响远端 node 判定」。
- 删除 `apps/fe/src/components/page-layouts/components/app-sidebar.test.ts`（整个文件只测 `isRouteNodeOffline`），
  并从 `use-sidebar-agent-sessions.test.ts` 移除 `isNodeOffline` 的 describe 与随之无用的 `MeshNode` /
  `meshNode` / `ENTRY` 夹具。

## 改动文件

新增：
- `apps/fe/src/node/node-offline.ts`
- `apps/fe/src/node/node-offline.test.ts`
- `apps/fe/src/node/pane-agent-state.test.tsx`
- `packages/stores/src/use-pane-agent-state.test.ts`

修改：
- `packages/stores/src/react.tsx`
- `packages/stores/src/use-pane-agent-state.ts`
- `apps/fe/src/components/page-layouts/components/app-sidebar.tsx`
- `apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts`
- `apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.test.ts`

删除：
- `apps/fe/src/components/page-layouts/components/app-sidebar.test.ts`

## 验证

| 包 | 测试 | tsc | 基线 |
|---|---|---|---|
| packages/stores | 299 pass / 0 fail | 1 error（`host-services.test.ts`，既有） | 282 / 1 |
| apps/fe (`bun test src/`) | 764 pass / 0 fail | 0 error | 671 / 0 |
| packages/panels | 562 pass / 0 fail | 0 error | 507 / 0 |
| packages/terminal-ui | 315 pass / 0 fail | 0 error | — |

- O1 报告里 `src/node/mesh-events.test.ts` 的 2 个 fail 已被相应 agent 修掉，本轮 fe 全绿。
- `bunx biome check` 覆盖全部 9 个改动/新增文件：`Checked 9 files. No fixes applied.`
- 未跑 apps/gateway（后端 agent 仍在改），未跑 e2e。

## 遗留 / 风险

1. `selectPaneAgentState` 的 `nodeId` 做成必填参数（不是可选），调用点只有 `usePaneAgentState` 一处；
   若将来有包外调用需要「不过滤」的旧语义，得显式传 `null`。这是有意为之——可选参数会让漏传
   静默退回串台的老行为。
2. `packages/stores` 里没有渲染 hook 的能力（无 react-dom），所以 hook 层的接线测试落在 apps/fe。
   若以后 stores 加了 react-dom devDependency，可以把 `pane-agent-state.test.tsx` 挪回去。
3. 徽标只在 `resolveAgentStore` 已被宿主注册时才跨 node 生效；注册发生在 `apps/fe/src/node/self-agent-store.ts`
   的模块副作用里（O1 落地），入口没显式 import 它的话就退回单 node 语义。本轮未改动该注册路径。
