# f8 结果：fe-nodes 评审 9 项 + fe-devices #3 + 无障碍附加两项

改动范围严格限制在 `apps/fe/src/**` 与三个 locale JSON（只动 `nodes.membership.*`），未跑 `build:i18n`，未执行任何 git 命令。

## 逐项

### 1. 退出期间预期内的自身 401（review-fe-nodes #1）

- 新增 `apps/fe/src/auth/auth-transition.ts`：模块级 `beginAuthTransition` / `endAuthTransition` / `isAuthTransitionActive`。
- 全局 401 拦截器在 `packages/api-client/src/auth/session-interceptor.ts`，`goToLogin()` 只走 fe 在 `apps/fe/src/main.tsx:259` 注入的 `navigate`——因此压制点放在注入处：`installSessionInterceptor({ navigate: (to) => { if (isAuthTransitionActive()) return; void router.navigate(to); } })`。fe 里没有别的 `onAuthRequired` 监听者会导航，压住 `navigate` 就够。
- 标记在 `leave` 之前置位（`leave-controller.ts`），**一直保持到整页硬跳转**（硬跳转换掉整个 JS 环境，模块状态自然归零）；只有退出被明确拒绝时 `endAuthTransition()`。
- 顺带停掉 mesh 轮询：`apps/fe/src/node/mesh-nodes.ts` 的 `refreshMeshNodes()` 开头加 `if (isAuthTransitionActive()) return;`，覆盖 `useMeshNodes` 的 30s 定时器与手动 `refresh`。WS 侧的 4401 本来就只重连一次就停，并且它的「全局未授权」也走同一个 `goToLogin`，已被压住。

### 2. 原子进入守卫（#2）

- `leave-controller.ts` 导出 `createInFlightGuard()`（`tryEnter` / `release`）。
- `use-leave-mesh.ts` 用 `useRef` 惰性持有一份，`run()` 第一行 `if (!guard.tryEnter()) return;` —— 抢不到就**连 state 都不动**（第二次点击若先换掉在途的 `AbortController`，会把第一条流程的重启等待就地掐死）。
- `release` 作为 dep 传进编排，**只在 `leave` 被明确拒绝时**调用；重启成功 / 等待超时都不放。`reset()` 也放开。

### 3. 重启基线（#3）

- 基线改在自吊销之后、`leaveApi.leave` 之前采样（`runLeaveWorkflow` 的固定顺序，有测试锁死）。
- 探针从 `@tmex/api-client/local/setup-api` 的 `readHealthStartedAt`（无超时）换成 `restart/wait-for-restart.ts` 的 `readStartedAt`——它经 `probeHealth` 自带 5s (`HEALTH_READ_TIMEOUT_MS`) 预算，且接 `AbortSignal`，卸载即断。

### 4. 记号时机与 TTL（#4）

- `intent.ts` 落盘格式改为 `{path, at}` JSON，新增 `SETUP_INTENT_TTL_MS = 10 * 60 * 1000`；`takeSetupIntent(storage, now)` 对过期（含时钟回拨、`at` 在未来）与老格式裸字符串一律当作没有，且照样清掉。
- 写入时机移到 `leave` 请求的**紧邻前一步**；`leave` 被拒时 `clearIntent()`。

### 5. `timeout` 是提交后的终态（#5）

- `leave-dialog.tsx` 新增 `stranded = phase === 'timeout'` 分支：破坏性按钮完全不渲染，`onOpenChange` 也不再让它被关掉（关掉只会留下一个鉴权已变的陈旧 mesh SPA）。
- 只给两个恢复出口：`membership-leave-recheck`（`AlertDialogAction variant="outline"`，只重跑重启等待，**绝不重发 `leave`**）与 `membership-leave-reload`（整页刷新）。
- `LeaveMesh` 新增 `recheck()` / `reload()`；`recheck` 复用 `awaitRestartAndNavigate` + 记在 `baselineRef` 里的同一个基线。`browser-location.ts` 新增 `reloadPage()`。

### 6. HTTPS 区块等角色就位（#6）

- `nodes-tab.tsx` mesh 分支：`local.status` 为 null 时不挂 `HttpsSection`，只给一个 `h-9` 的小占位（`data-testid="https-section-pending"`）；`loginRequired` 时连占位都不给（本机区块已经在提示登录）。角色到位后 `disabled={local.status.role === 'node'}`（`hub,node` 可用；standalone 分支本来就由 `mode !== 'mesh'` 判定，未动）。

### 7. `?tab=` 由 URL 推导（#7）

- `SettingsPage.tsx` 去掉 `activeTab` 的 `useState` + 同步 `useEffect`，改为 `const activeTab = settingsTabFromParam(searchParams.get('tab'))`；新导出纯函数 `settingsTabFromParam`（缺失 / 非法 → `general`）。`selectTab` 仍是 `setSearchParams(..., { replace: true })`。
- 挂载后导航到 `/settings` 或 `?tab=bogus` 现在会正确回落到「通用」。

### 8. 按角色分档的确认文案（#8）

- `leave-dialog.tsx` 新增 `CONSEQUENCES_KEY: Record<MeshRole, string>`，按 `request.from` 取文案。
- 三个 locale 里 `nodes.membership.consequences` 拆成两条（旧键已删，无残留引用）：
  - `consequencesNode`：讲「退出前会自动在 Hub 上吊销本机；若自动吊销没成功，Hub 上会留下一条离线记录，需要你到 Hub 侧手动吊销」。
  - `consequencesHub`：讲「本机就是 Hub……所有下级节点都会失去 Hub，必须重新加入其它 Hub 才能恢复」。

### 9. 可注入的编排 + 测试（#9）

- 新增 `membership/leave-controller.ts`：`runLeaveWorkflow(deps, request)`，依赖全部注入（`revoke` / `readStartedAt` / `leave` / `waitForRestart` / `navigate` / `writeIntent` / `clearIntent` / `begin|endAuthTransition` / `setPhase` / `onRevokeOutcome` / `onLeaveError` / `onBaseline` / `release`）；另导出 `awaitRestartAndNavigate`（给「再查一次」复用）、`createInFlightGuard`、`LeavePhase` / `LeaveRequest` 等类型。
- `use-leave-mesh.ts` 只剩接线：不再用 `useRestartNow`（改为自持 `AbortController` + 直接调 `waitForRestart`，`elapsedMs` 由 `onElapsed` 驱动），阶段不再靠 effect 从 restart state 映射。
- 新增 `membership/leave-controller.test.ts`（15 例，无 DOM）：成功路径的精确调用顺序、基线位置与传递、纯粹退出清记号、`hub,node` 不自吊销、凭据取消 / 吊销失败继续退出、吊销成功不打扰、`leave` 被拒（记号清掉 + 鉴权标记撤销 + 守卫放开 + 不去等重启）、超时终态（不放守卫、不撤标记、不跳转）、aborted、`awaitRestartAndNavigate` 两例、守卫两例（含重复 `run` 只发一次 `leave`）。
- `intent.test.ts` 补 TTL / 时钟回拨 / 老格式三组用例。

### 10. 离线分节保留选中设备（review-fe-devices #3）

- `sidebar-node-section.tsx` 新增导出的纯函数 `selectedDeviceIdForNode(pathname, runtimeNodeId)`：先用 `parseNodeIdFromPath` 确认路由属于这个 node，再 `matchPath(nodeAppPath(id, '/devices/:deviceId'), { end: false })` 取 deviceId（`decodeURIComponent` 容错，坏 `%` 序列原样返回）。
- 离线 inventory 过滤加上 `device.id === selectedDeviceId ||` 这条例外，与在线侧 `selectSidebarVisibleDevices` 一致。
- `sidebar-device-list.test.tsx`：`render()` 支持 `entry` 路由；新增「选中设备无条件保留」「别的 node 上的同名设备不算数」两例渲染测试 + `selectedDeviceIdForNode` 三例单测。

## 附加（motion 评审的两条无障碍）

### (a) 常驻播报节点

`apps/fe/src/pages/LoginPage.tsx`、`apps/fe/src/auth/credential-prompt.tsx`：原来是 `<div aria-live="polite" className="empty:hidden">` 包着条件渲染的报错块——`empty:hidden` 会把节点从可访问性树里摘掉，播报不可靠。改为拆成两半：常驻的 `<output className="sr-only" aria-live="polite">`（`sr-only` 是 absolute 定位，空着不占 flex gap）承载播报文本，可见报错块单独条件渲染。`data-testid`（`login-error` / `credential-prompt-error`）不变。

> biome 的 `lint/a11y/useSemanticElements` 要求 `role="status"` 用 `<output>` 表达，故三处统一用 `<output aria-live="polite">`（隐式 `role=status`）。

### (b) 复制反馈不再重复播报

新增 `apps/fe/src/pages/settings/nodes/copy-feedback.tsx`：`useCopyToClipboard(value)`（含卸载清 timer）+ `<CopyLabel copied />`。可见标签留在 live region 外，播报节点只在 `copied` 为 true 时有内容（否则空串），2 秒复位不会再播一次「复制」。
三处 `CopyableCode` / `CopyableValue` 改用它，去掉三份重复的 copied state：`https/parts.tsx`、`local-machine-card.tsx`、`management/enrollment-section.tsx`。`${testId}-copy` 等 testid 不变。

## i18n 新增键（zh_CN / en_US / ja_JP 同步）

- `nodes.membership.consequencesNode`（替换 `consequences`）
- `nodes.membership.consequencesHub`（替换 `consequences`）
- `nodes.membership.reload`
- `nodes.membership.checkAgain`

删除：`nodes.membership.consequences`。

**仍需有人跑一次 `bun run build:i18n`**（本次按要求未跑，`resources.ts` / `types.ts` 未动）。

## 验证

- `cd apps/fe && bun test src/` → **577 pass / 0 fail**（45 文件；基线 551，本批净增 26 例）
- `cd apps/fe && bunx tsc --noEmit -p .` → **0 error**
- 仓库根 `bunx biome check <改动文件>` → 只剩已知的 `apps/fe/src/main.tsx:82 useExhaustiveDependencies`（既有，未触碰）
- 未跑 Playwright e2e，未跑 `build:i18n`，未执行任何 git 命令

## 新增文件

- `apps/fe/src/auth/auth-transition.ts`
- `apps/fe/src/pages/settings/nodes/copy-feedback.tsx`
- `apps/fe/src/pages/settings/nodes/membership/leave-controller.ts`
- `apps/fe/src/pages/settings/nodes/membership/leave-controller.test.ts`

## 注意事项 / 遗留

- `auth-transition` 是模块级单例，语义就是「本次页面生命周期里正在做一次有意的鉴权切换」。退出成功后**故意不复位**——之后必然整页跳转。若将来出现「退出成功但不跳转」的路径，记得手动 `endAuthTransition()`。
- 超时后的「再查一次」用的是原来那次采到的基线（`baselineRef`）。若用户在这中间刷新了页面，基线丢失，剩下的出口就是「刷新页面」，符合预期。
- `restart/use-restart-now.ts` 不再被退出流程使用（仍服务于 `local-machine-card` 的「立即重启」与 HTTPS 区块），未改动。
