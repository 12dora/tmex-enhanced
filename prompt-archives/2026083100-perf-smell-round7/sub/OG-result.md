# OG：AgentTab 订阅整张 tmux snapshots map（perf）

## 一、结论先行

探索结论**成立**，且比原描述更严重一点：`snapshots` 不只喂给路由 pane 解析，还喂给**绑定 chip 解析**，两者的目标设备可以不同。已按「先定设备、再窄订阅」修复，行为不变。

## 二、claim 核验（读码确认）

1. `use-agent-tab-state.ts:217`（改前）`useTmuxStore((state) => state.snapshots)` —— 订阅整张 map，**属实**。
2. 整张 map 每次都换引用：`packages/stores/src/tmux-event-router.ts:106-119` 的 snapshot 与 patch 两条路径都是 `{ ...prev.snapshots, [deviceId]: ... }`；`tmux.ts:286-292 / 362-370` 同理。任何一台设备来更新 → map 换引用 → zustand 默认 `Object.is` 判不等 → AgentTab 重渲染 + `deriveAgentTabView`（`agent-tab-view.ts:104`）重新推导，**属实**。
3. **补充发现（原 claim 未覆盖）**：`deriveBinding`（改前 `agent-tab-view.ts:38-43`）解析的来源是 `activeSession ?? draft` 的 `deviceId`，**不是** `routeDeviceId`。存在 pane mismatch 态（会话仍绑旧 pane、路由已切到别的设备），此时只订阅 `snapshots[routeDeviceId]` 会让绑定 chip 拿不到快照、由 `valid` 退化成 `unknown`。因此本次订阅了**两份**快照而非一份。
4. **node 前缀问题：不存在**。`useTmuxStore` 是每 runtime 一个 store（`packages/stores/src/react.tsx:72`），`/n/:nodeId` 前缀由 `hostAppPath` 拼进 route pattern、匹配时被吃掉，`params.deviceId` 就是该 node store 里的裸 device id（`agent-pane-route.test.ts` 已固化）。路由 id 与 snapshot key 同一命名空间，无需映射。

## 三、改动

仅动 `packages/panels/src/agent/**`。

### `agent-binding.ts`
- `findPane` / `findPaneTitle` / `resolveBinding` 的入参由整张 `SnapshotMap` 改成**单份** `StateSnapshotPayload | undefined`；`findPaneTitle` 随之不再需要 `deviceId`。
- 新增纯函数 `deviceSnapshot(snapshots, deviceId)`：作 store selector 用，只取目标设备那一份。
- 新增纯函数 `bindingSource(activeSession, draft)`：把「有会话取会话、否则取草稿」这条规则收敛成单一出处，hook（算订阅哪台设备）与 `deriveBinding`（算绑定）共用，杜绝两处漂移。

### `use-agent-tab-state.ts`
- `useRoutePane` 拆成 `useRouteMatch`（只出 `routeDeviceId` / `routePaneId`，不碰 store）+ `useDeviceSnapshot(deviceId)`（`useTmuxStore((s) => deviceSnapshot(s.snapshots, deviceId))`）。
- `useAgentTabState` 里先取路由参数与 session 切片，再按 id 订阅两份快照：`routeSnapshot`（算 `routePaneTitle`）与 `bindingSnapshot`（算绑定 chip）。两个 selector 调用都是无条件的，hook 顺序稳定。
- `AgentTabState` 的 `snapshots: SnapshotMap` 字段换成 `bindingSnapshot: StateSnapshotPayload | undefined`——整张 map 不再进入派生态的输入面，从类型上堵死回退。

### `agent-tab-view.ts`
- `deriveBinding` 改用 `bindingSource(...)` + `state.bindingSnapshot`。逻辑等价（改前把 `activeSession` 整个对象当 source 传，`resolveBinding` 只读其 `deviceId`/`paneId`）。

### 效果
无关设备推快照时，两个 selector 的返回引用均不变，zustand 的 `Object.is` 直接短路，AgentTab 不重渲染、绑定与 model 不重推导。相关设备更新则照常穿透。

## 四、测试

新增 `packages/panels/src/agent/agent-binding.test.ts`（12 条），按 zustand 默认 `Object.is` 判等语义直接判定（bun test 无 DOM，与仓库既有 `composer-isolation.test.ts` / `chat-thread.test.tsx` 同一套路）：
- **无关设备更新不重推导**：整张 map 换引用（`expect(after).not.toBe(before)`），但 `deviceSnapshot(after,'d1') === deviceSnapshot(before,'d1')` 为**同一引用** → 订阅者不重渲染。
- 目标设备自身更新则换引用（反向对照，证明订阅没被削没）。
- **路由切设备**：切到 d2 后取到 d2 的快照与标题，且看不见 d1 的 pane。
- **快照缺失/未到达**：设备不在 map、deviceId 为 null → `undefined`；`findPaneTitle` 返回 null；`resolveBinding` 返回 `unknown`（不误判成 `invalid`），与改前一致。
- `bindingSource` 的会话优先 / 草稿兜底 / 皆无返回 null。
- **绑定用会话设备而非路由设备**：路由在 d2、会话绑 d1/%1 时绑定仍 `valid`。

`agent-tab-view.test.ts` 补 1 条视图级用例：路由指向 d2 时 `binding.state === 'valid'` 且 `isOrphan === false`（防止把「订阅窄化」误做成按路由设备取快照后会话被判成孤立）。

同步适配（签名变更导致，非行为变更）：`agent-tab-view.test.ts`、`composer-isolation.test.ts`（`snapshots: {}` → `bindingSnapshot: undefined`）、`use-agent-tab-model.test.ts`（整张 map → 单份快照）。为避免与新文件重复覆盖，`use-agent-tab-model.test.ts` 保留为 `resolveBinding` 的基础契约测试，新文件只留新语义用例。

### 计数
- 改前基线：`packages/panels` **635 pass / 0 fail**（54 files）。任务书写的 629 是更早的快照——本 worktree 有并行 agent 已经加过测试，我以实测 635 为基线。
- 改后：**647 pass / 0 fail**（55 files，5017 expect）。净增 12 条，无回归。

## 五、验证记录

- `cd packages/panels && bun test` → 647 pass / 0 fail
- `cd packages/panels && bunx tsc --noEmit -p .` → 0 error（exit 0）
- `bunx biome check <7 个改动文件>` → Checked 7 files, no fixes applied
- `bun scripts/complexity/gate.ts` → `complexity gate ok (1059 files, 8783 functions)`，改动文件无 CC/行数告警

## 六、边界与遗留

- 绑定设备与路由设备相同时会对同一 key 建两个订阅——zustand 的订阅是回调数组，代价可忽略，换来的是两条派生链解耦，不做特判。
- `SnapshotMap` 类型仍留在 `agent-binding.ts`（`deviceSnapshot` 的入参需要）。`@tmex/stores` 内部虽有同名类型，但未从包 index 导出，故不改为复用。
- 未触碰 `packages/stores/**`、`device-console/**`、`device-management/**`、`apps/fe/**`；无 git 操作、无 e2e。
