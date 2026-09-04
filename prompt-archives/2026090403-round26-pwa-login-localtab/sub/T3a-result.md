# T3a 结果 — 陈旧 per-node 会话触发重登 / 设备加载错误显示真实原因

## 做了什么

### 1. api-client：类型化错误（`ApiError`）

`packages/api-client/src/client.ts`

- 新增 `ApiError extends Error`，携带 `status`、`code`、`error`、`nodeId`、`reason`。
  没有沿用 `FileApiError`（绑死 `FileErrorCode`）或 `RelayApiError`（只有 code/message/status，
  无 nodeId/reason），也没有再造第二套解析：把原先 `parseApiError` 里的信封解析抽成
  `readErrorEnvelope` / `envelopeMessage` 两个私有函数，`parseApiError` 与新的 `toApiError`
  共用同一份，`parseApiError` 的对外行为逐字不变（既有 14 处调用方零改动）。
- `toApiError(res, fallback)`：message 依次取 `error` / `error.message` / `message` / `code` /
  `fallback`——`jsonError()` 只下发 `{code}`，退回 fallback 会把「节点打不通」显示成无关文案。
- 新增 `NODE_UNREACHABLE` 常量与 `isApiErrorCode` / `isNodeLoginRequiredError` /
  `isNodeUnreachableError`。`NODE_LOGIN_REQUIRED` 从既有的 `./auth/types` 引入，不重复定义
  （`auth/types` 只有 type-only import，不引入循环，也不给主 bundle 增加实质体积）。
- `packages/api-client/src/devices.ts`：`fetchDevices()` 改抛 `toApiError(...)`（原来是
  `new Error(await parseApiError(...))`）。

### 2. fe：401 `NODE_LOGIN_REQUIRED` 的会话自愈

`apps/fe/src/node/node-session-recovery.ts`（新增）

- `handleNodeApiError(nodeId, error, deps)`：只对 `NODE_LOGIN_REQUIRED` 动作，其余（含 entry
  自身 `self`）一律 `ignored`。命中时补一次 `ensureNodeLogin(nodeId)`（懒加载，与
  `mesh-nodes.ts` 里 hub 那条路径同样的写法），成功即 `onRecovered()` 让调用方回源。
- 防循环用两层记账：`inFlight` 按 nodeId 合并并发调用；`attempted` 保证**一轮失效只重登一次**，
  只有 `resetNodeSessionRecovery(nodeId)`（请求重新成功时调用）才解除。
- 重登失败时：网络类（`NETWORK_ERROR` / `NODE_LIST_FAILED`）**不动** `loggedIn`；其余（凭证类，
  如 `NO_SESSION_KEY` / `PASSKEY_REQUIRED`）才 `markLoggedOut(nodeId)`，让既有门闸
  （`useNodeLoginGate` → `NodeGateScreen` / `SignedOutBody`）退回「登录此节点」。
  这里刻意**不**在收到 401 的那一刻就翻 `loggedIn`——`mesh-nodes.ts` 轮询回路里那条注释所说的
  「转发路径会产生会话仍有效的 401，就地登出会抽掉整棵子树表现为卡片闪断」依然成立；只有
  「401 且静默重登也没成功」才足以判会话作废。

`apps/fe/src/node/mesh-nodes.ts`

- 新增 `markLoggedOut(nodeId)`（复用既有私有的 `setLoggedIn`），注释里写明只允许
  `node-session-recovery` 在重登失败后调用。

`apps/fe/src/components/global-device-provider.tsx`

- 接线点选在这里而不是 panels 的 `useQuery`：react-query v5 的 `useQuery` 没有 `onError`，而
  provider 与设备面板共用同一条 `['devices']` 查询缓存，provider 又天然拿得到
  `runtime.nodeId` 与本 node 的 `QueryClient`。新增私有 hook `useNodeSessionRecovery`：
  错误到达 → `handleNodeApiError`（`onRecovered` 里 `invalidateQueries(['devices'])`）；
  拿到数据 → `resetNodeSessionRecovery`。
- 顺手把 `devicesQueryOptions` 里手写的 `['devices'] as const` 换成 api-client 导出的
  `devicesQueryKey`（同一个值，避免两处各写一份）。

### 3. panels：设备加载失败按性质分档 + 重试

- `packages/panels/src/device-management/device-load-error.ts`（新增）：纯函数
  `describeDeviceLoadError(error)` → `{kind: 'loginRequired'|'unreachable'|'generic', reason}`，
  以及 `deviceLoadErrorMessageKey(kind)`。
- `use-device-management-state.ts`：从 `useQuery` 多取 `error` / `refetch`，返回值新增
  `error`（非错误态为 null）与 `retry`。
- `device-management-panel.tsx`：错误分支换成 `LoadErrorCard`（`data-testid="devices-load-error"`、
  `data-error-kind`、重试按钮 `data-testid="devices-load-retry"`）；`NoticeCard` 只剩加载态，
  `failed` 参数随之删掉。

### 4. i18n（`device.*`，三语同步 + `bun run build:i18n`）

| key | zh_CN |
| --- | --- |
| `device.loadFailedLoginRequired` | 加载设备列表失败：该节点需重新登录 |
| `device.loadFailedUnreachable` | 加载设备列表失败：节点不可达 |
| `device.loadFailedUnreachableReason` | 加载设备列表失败：节点不可达（{{reason}}） |

en/ja 对应条目同步写入。`common.retry` 已存在，直接复用。

## 文件清单

新增：
- `packages/api-client/src/client.error-code.test.ts`
- `packages/panels/src/device-management/device-load-error.ts`
- `packages/panels/src/device-management/device-load-error.test.ts`
- `packages/panels/src/device-management/device-management-panel-error.test.tsx`
- `apps/fe/src/node/node-session-recovery.ts`
- `apps/fe/src/node/node-session-recovery.test.ts`

修改：
- `packages/api-client/src/client.ts`、`packages/api-client/src/devices.ts`
- `packages/panels/src/device-management/use-device-management-state.ts`
- `packages/panels/src/device-management/device-management-panel.tsx`
- `apps/fe/src/components/global-device-provider.tsx`
- `apps/fe/src/node/mesh-nodes.ts`
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` +
  `bun run build:i18n` 的生成物（`resources.ts` / `types.ts` / `locales/generated/*.core.json`）

未编辑既有的 `packages/api-client/src/client.test.ts`、`files-download.test.ts`，也未碰
`LoginPage*`、`apps/fe/src/i18n/*`、`main.tsx`、`standalone-landing*`、`packages/stores/src/site*`、
`apps/gateway/**`。

## 验证

| 包 | 基线 | 现在 |
| --- | --- | --- |
| `packages/api-client` `bun test` | 209 pass / 0 fail | **218 pass / 0 fail**（+9 新增） |
| `packages/panels` `bun test` | 907 pass / 15 fail | **930 pass / 0 fail**（含本轮 +8；那 15 个 mock.module 污染已被另一 agent 修掉） |
| `apps/fe` `bun test src/` | 2148 pass / 0 fail | **2179 pass / 0 fail**（含本轮 +8，其余为并行 agent 新增） |

`bunx tsc --noEmit -p .`：`packages/api-client`、`packages/panels`、`apps/fe`、`packages/shared`
均 0 错误。`bunx biome check` 对全部 12 个改动文件干净。

## 注意事项 / 遗留

1. **测试用例里的 `retryOnMount: false`**：react-query v5 的乐观结果在 `data === undefined` 时
   会把「挂载即重试」的错误态算成 pending（`fetchState` 清掉 error），静态渲染因此看不到失败
   分支。`device-management-panel-error.test.tsx` 的 QueryClient 关掉 `retryOnMount` 才能断言；
   浏览器里 effect 正常跑、observer 有监听者，错误态照常呈现。
2. **fe 侧的自愈用例是模块级而非组件级**：仓库无 DOM 环境，`useNodeSessionRecovery` 依赖 effect，
   静态渲染跑不到。所以「列表 loggedIn:true + 设备请求 401 → 只重登一次 → 回源」这条场景是对
   `handleNodeApiError` 直接断言的（含并发合并、记账解除、凭证类失败标未登录、网络类不标）。
3. **面板里没有单独的「登录」按钮**：重登失败且属于凭证类时会 `markLoggedOut`，设备页与路由页
   分别由既有的 `SignedOutBody` / `NodeGateScreen` 给出 `NodeLoginButton`，比在 panels 里再塞
   一个需要路由能力的按钮更贴合现有结构。面板只保留「原因 + 重试」。
4. **依赖 T3b**：`device.loadFailedUnreachableReason` 只有在后端 503 体带上 `reason` 时才会出现，
   否则退到 `device.loadFailedUnreachable`。T3b 的 `Set-Cookie` 过期陈旧 cookie 与本改动是互补的
   ——即便后端不清 cookie，前端这一轮重登也能自愈；后端清了 cookie 则 `/api/mesh/nodes` 下一轮
   本来就会报 `loggedIn:false`，两条路径不冲突。
5. 未做界面截图核对（按 common rules 不起临时实例 / 不跑 Playwright）。新增文案为单行短句，
   与既有 `device.loadFailed` 同一位置渲染，不改布局。

---

## R2 评审修复（三处，均已改）

### R2-1 记账解除的判据从「有没有数据」改成 `dataUpdatedAt` 前进

原来 `useNodeSessionRecovery(nodeId, error, devicesData !== undefined)` 只表示「曾经加载过」。
react-query 在后台刷新失败时会一直留着上一次的数据，所以「缓存 → 401 → 重登成功 → 回源仍失败」
这条路径上，reset 的 effect 再也不会重跑，`attempted` 永久留着，该 node 之后每一次会话失效都被
`skipped` 卡死，只有整个 runtime 被回收才恢复。

改法：
- `node-session-recovery.ts` 用 `noteNodeQuerySuccess(nodeId, dataUpdatedAt)` 取代
  `resetNodeSessionRecovery(nodeId)`，模块内记一个 `lastSuccessAt` 水位，只有
  `dataUpdatedAt > 0` **且与上次不同**才解除记账（幂等，重复上报同一个时刻不动记账）。
- `global-device-provider.tsx` 从 `useQuery` 多取 `dataUpdatedAt`，effect 依赖改成
  `[dataUpdatedAt, nodeId]`。

把判据放进模块（而不是只靠 effect 的依赖数组边沿触发）也让这条语义可以脱离 DOM 单测。

新增用例：
- 「缓存态 → 401 → 重登 → 回源仍失败：不再重登，也不空转」——回源失败（`dataUpdatedAt` 不变）后
  连续两次 401 都是 `skipped`、登录只发生 1 次；随后 `dataUpdatedAt` 前进到 2000，下一次 401
  重新 `recovered`，登录累计 2 次。
- 「留着旧数据（`dataUpdatedAt` 不变）不算成功，重复上报也不解除记账」。

### R2-2 临时失败不再把记账永久留下

原来只要重登失败就把 `attempted` 留着，于是断网 / 抛异常之后面板上的「重试」只会重发请求、
再撞 401、再被 skip，用户永远退不出这个状态。

改法：`settleLogin()` 里，只有「需要用户介入」的失败才保留记账（用户不动手，重发也没意义）；
其余失败——含 `NETWORK_ERROR` / `NODE_LIST_FAILED` / `RATE_LIMITED` / 认不出的码——以及 `catch`
分支里实现自己抛的异常，一律当场 `attempted.delete(nodeId)`。react-query 不会在失败后自动重发，
下一次请求来自用户点「重试」或窗口重新聚焦，所以解除记账不会变成自动重试风暴。

新增用例：四类临时码各自「第一次 failed → 第二次仍 failed 且登录发生了 2 次」；抛异常路径同理。

### R2-3 `markLoggedOut` 改成显式白名单

原来是「除两个传输码之外全部登出」，`RATE_LIMITED` 这类**临时**的服务端结论也会把整棵 node 子树
抽掉、并在限流窗口里立刻再发一次登录，把限流撞得更死。

改法：新增导出的谓词 `needsUserSignIn(code)` = `INTERACTION_REQUIRED` 白名单 ∪
`isCredentialFailure(code)`（后者直接复用 `apps/fe/src/auth/login-errors.ts` 里登录页那份定义，
不再抄一遍）。白名单取自登录路径真实会返回的码
（`session-login.ts` 的 `transportFailureCode` / `secondFactorFailureCode` 与 `login-errors.ts` 的表）：
`NO_SESSION_KEY`、`TOTP_REQUIRED`、`TOTP_CODE_REQUIRED`、`TOTP_INVALID`、`PASSKEY_REQUIRED`、
`PASSKEY_VERIFY_FAILED`、`PASSKEY_ABORTED`、`PASSKEY_CREDENTIAL_UNKNOWN`、`NO_PASSKEY_FOR_ORIGIN`、
`NODE_PK_MISMATCH`。`RATE_LIMITED`、`CHALLENGE_*`、`UNKNOWN_NODE` 与任何未知码都算临时，不登出。

新增用例：六个需介入的码（含 `INVALID_CREDENTIALS`、`PASSKEY_INVALID` 走 `isCredentialFailure`）
断言 `loggedIn` 翻 false 且记账保留；四个临时码断言 `loggedIn` 不动且可再登；外加
`needsUserSignIn` 本身的边界用例。

### 复杂度门禁

`bun scripts/complexity/gate.ts` 报出 `useDeviceManagementState: 130 lines > 122`（本轮新增的
`error` / `retry` 撑破的）。按要求拆函数而不是改 allowlist：把首屏逐项入场那一段抽成同文件内的
`useStaggeredEntrance(loaded)`，主 hook 回到 ~102 行，该条违规消失。

门禁剩下的 5 条（`apps/gateway/src/mesh/forwarder.ts` ×3、`packages/ui/.../sidebar-provider.tsx`、
`packages/shared/src/link/mux.ts`）都不在本任务改动范围内，属并行 agent 的在途工作。

### 复验

| 检查 | 结果 |
| --- | --- |
| `packages/panels` `bun test` | 930 pass / 0 fail |
| `packages/panels` `bunx tsc --noEmit -p .` | 0 |
| `apps/fe` `bun test src/node src/components src/auth` | 943 pass / 0 fail（`node-session-recovery.test.ts` 19 个用例，原 8 个） |
| `apps/fe` `bunx tsc --noEmit -p .` | 本任务范围内 0；剩余报错全部落在 `src/pages/settings/nodes/{nodes-tab,local-machine-card}.test.tsx` |
| `bunx biome check`（12 个改动文件） | 干净 |
| `bun scripts/complexity/gate.ts` | 本任务相关的违规已清零 |

**注意**：`cd apps/fe && bun test src/` 全量此刻是 2166 pass / 11 fail，11 条失败全部在
`src/pages/settings/nodes/**`（`NodesTab`、`routeSetupIntent`、合并后的 Hub 列表、relay 次级菜单），
与 tsc 的两个报错文件同源，属并行 agent 正在改的设置页，非本轮引入——本轮改动前该目录是绿的。
按任务约束未触碰 `apps/fe/src/pages/settings/**`、`packages/ui`、`packages/stores`。
