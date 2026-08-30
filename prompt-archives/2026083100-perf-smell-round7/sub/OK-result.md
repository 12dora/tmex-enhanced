# OK 任务结果：设置页状态 hook 去重 + 两处死代码清理

## 一、结论先行

三条 claim **全部核实为真**，均按建议实施，无一条需要驳回。

- 测试：`apps/fe` `bun test src/` 由基线 **905 pass / 0 fail** → **917 pass / 0 fail**（新增 12 个用例，65 个文件）
- 类型：`bunx tsc --noEmit -p apps/fe/tsconfig.json` **0 error**
- 格式/lint：`bunx biome check <10 个改动文件>` 全部通过（Checked 10 files, no fixes applied）
- 复杂度门禁：`bun scripts/complexity/gate.ts` → `complexity gate ok (1062 files, 8820 functions)`，未改 allowlist

## 二、claim 核实

### 1. [MED] 三个设置页状态 hook 重复同一套受保护查询生命周期 —— 属实

`use-local-status.ts` / `https/use-tls-status.ts` / `remote-access/use-tunnel-status.ts` 三者逐字重复：
401 判定后的 `retry: (failureCount, error) => !isUnauthorized(error) && failureCount < 2`、
基于 `invalidateQueries` 的 `refresh`、以及 `status/loading/loginRequired/error` 的整段三元投影
（含 `!error || loginRequired ? null : error instanceof Error ? error.message : String(error)`）。
TLS 与 tunnel 另有 `enabled` / `refetchInterval` / `setStatus`，Local 三者皆无。

### 2. [LOW] 无人使用的响应式 session key 层 —— 属实

全仓（apps + packages，排除 node_modules）grep：`useSessionKey` 仅出现在自身定义处，零消费者；
`subscribeSessionKey` / `getSessionKeySnapshot` 仅被该 hook 引用；`stateListeners` / `notifyState`
只服务于这条订阅链（`apps/gateway/src/mesh/uplink-client.ts` 里的同名 `stateListeners` 是无关的另一份，未动）。
`session-key-store.test.ts` 未触及任何被删符号。

### 3. [LOW] `setSharedMeshEvents` 是无人调用的单例替换 setter —— 属实

`apps/fe/src/node/mesh-events.ts:471` 定义处是全仓唯一出现点，测试确实直接 `new MeshEventSource()`。

## 三、改动清单

### 新增：`apps/fe/src/pages/settings/use-protected-status-query.ts`

抽出共享 hook `useProtectedStatusQuery<TStatus>`，只参数化差异部分：
`queryKey` / `queryFn` / `isUnauthorized` / 可选 `enabled` / 可选 `refetchInterval(data)`。

因为**仓库没有 DOM 测试环境**（无 testing-library，带 effect 的 hook 无法 render 测试），决策部分
全部拆成可直接单测的纯函数，hook 本身只负责接线：

- `protectedStatusRetry(isUnauthorized)` —— 重试判定
- `projectProtectedStatus({data, error, isPending, enabled, isUnauthorized})` —— 四字段投影
- `refreshStatusQuery(cache, queryKey)` / `writeStatusQuery(cache, queryKey, next)` —— 缓存动作，
  参数收窄为 `StatusQueryCache` 接口（只含 `invalidateQueries` / `setQueryData`）

### 改写为薄壳：三个领域 hook

公开类型与运行时行为逐字保持：

- `use-local-status.ts`：显式解构返回 `{status, loading, loginRequired, error, refresh}`，
  **不透出** `setStatus`，运行时对象形状与改动前完全一致；不传 `enabled`（共享 hook 内 `?? true`）。
- `https/use-tls-status.ts`：`enabled` 透传，`refetchInterval: acmePollInterval`（pending → 3000ms，否则 false）。
- `remote-access/use-tunnel-status.ts`：`enabled` 透传，`refetchInterval: tunnelPollInterval`（原样复用，未改）。

三处的 `refetchInterval` 语义未变：原先是 `(q) => f(q.state.data)`，现在由共享 hook 统一做同样的
`q.state.data` 取值后交给传入的函数。

### 删除：死代码

- `apps/fe/src/auth/use-session-key.ts`：删 `useSessionKey` 及随之无用的 `useSyncExternalStore` /
  `SessionKeyInfo` 类型 import；`useAuthMode` 原样保留（文件名与 `auth/index.ts` 的 `export *` 未动，
  因为该文件仍导出 `useAuthMode`，导出面无需调整）。
- `apps/fe/src/auth/session-key-store.ts`：删 `stateListeners` / `notifyState` / `subscribeSessionKey` /
  `getSessionKeySnapshot` 及 `clearSessionKey` / `adoptSessionSecrets` 里的两处 `notifyState()` 调用；
  `getSessionKey` / `hasSessionKey` / `clearSessionKey` / `adoptSessionSecrets` 等全部保留。顺手把顶部
  注释里已失真的「这里只有常驻的状态与订阅」改为「这里只有常驻的状态」。
- `apps/fe/src/node/mesh-events.ts`：删 `setSharedMeshEvents`，`sharedMeshEvents()` 保留。

## 四、执行中发现的两个坑（与全局 `mock.module` 冲突，非代码 bug）

初版测试有 4 fail + 1 error，定位后均为 bun test 单进程内 **模块 mock 的跨文件泄漏**，已绕开：

1. `apps/fe/src/pages/FilePage.test.tsx` 用 `mock.module('@tanstack/react-query', ...)` 全局替换了整个
   react-query，导致同进程里 `new QueryClient()` 拿不到 `setQueryData`。
   → 缓存动作的参数从 `QueryClient` 收窄为 `StatusQueryCache` 接口，测试改用记录调用的替身。
   这同时让纯函数不再依赖真 client，符合「决策部分可直接单测」的要求。
2. `https/https-section.test.tsx` 用 `mock.module('./use-tls-status', ...)` 只提供了 `useTlsStatus` 与
   `ACME_POLL_INTERVAL_MS`，因此从该模块新导出的 `acmePollInterval` 在测试进程里会「消失」。
   → 把 `acmePollInterval` 与 `ACME_POLL_INTERVAL_MS` 迁到**未被 mock 的**纯逻辑模块
   `https/tls-form.ts`（与 tunnel 侧 `tunnelPollInterval` 放在 `tunnel-model.ts` 的做法对称），
   `use-tls-status.ts` 以 `export { ACME_POLL_INTERVAL_MS } from './tls-form'` 保持导出面不变。
   新测试文件相应命名为 `https/acme-poll.test.ts`。

## 五、新增用例（12 个）

`use-protected-status-query.test.ts`（9 个）：401 不重试 / 其它错误最多两次；enabled 时 pending 即 loading、
关掉查询不转圈、拿到数据原样透出、401 只报 loginRequired 不报错、普通错误取 message、非 Error 取字符串化；
refresh 只让自己的键失效、setStatus 只写缓存不触发失效。

`acme-poll.test.ts`（3 个）：pending → 3000ms；ok/error/idle/acme 为 null → false；status 为 null/undefined → false。
