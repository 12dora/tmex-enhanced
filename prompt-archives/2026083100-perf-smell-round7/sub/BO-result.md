# BO：设置页标签切换变慢的优化

## 一、慢在哪

`SettingsPage` 把七个标签各自拆成独立 chunk（`lazyChunk`），首次切到某个标签是**两段串行 RTT**：

```
点标签 → 下载 tab chunk（网络往返 + 解析）→ 面板挂载 → 面板自己的 GET（第二段往返）
```

隧道场景下 RTT 是真实的，两段叠加就是肉眼可见的「转圈半天」。第一段是主要成本：它是纯网络+解析，
且**每个标签第一次点都要付一次**。

审计七个标签的挂载期取数后确认：**第二段里几乎没有可消的 waterfall**——各标签的查询都是兄弟关系、
同一个 commit 里并行发出（详见第四节）。所以真正该打的是第一段。

## 二、改了什么

### 1. chunk 预热（主要收益）

新增 `apps/fe/src/pages/settings/chunk-preload.ts`：

- `scheduleIdle(run, host)`：`requestIdleCallback`（`timeout: 3000` 兜底）优先，没有则退回
  `setTimeout(1200)`。`host` 可注入，因此可在无 DOM 环境测。
- `startIdleChunkPreload(loaders, schedule, started)`：**每个空闲片只发起一个 chunk**，落地
  （成功或失败）后才排下一个。刻意不并发七发——那会和当前标签自己的 chunk / 数据请求抢连接，
  隧道下反而更慢。返回取消函数，页面卸载后不再排新的。
- `preloadChunk(load, started)`：悬停/触摸时的即时预热。
- 两条路径共用同一份模块级「已发起」集合，同一个 chunk 只发一次；**预热失败一律静默**，
  既不计入 `lazyChunk` 的 `FAILURES`、也不触发整页刷新——重试卡片只在用户真的导航过去时才出现，
  语义完全不变。

`SettingsPage.tsx` 配合改动：

- 七个 `import()` loader 提为具名常量，`lazyChunk` 与预热**复用同一个函数引用**；
  文件里留了注释警告不得改成静态 import。
- `chunkPreloadOrder(activeTab)`（已导出、已测）：排除当前标签，其余按定义顺序排队。
  挂载时用 `useState` 初始化器冻结一次，切标签不重排。
- 每个 `TabsTrigger` 加 `onPointerEnter` / `onTouchStart` → `warmTab()`。

### 2. 悬停数据预取（次要收益，范围刻意收窄）

新增 `apps/fe/src/pages/settings/data-prefetch.ts`：悬停时顺带 `prefetchQuery` 该标签的数据，
从悬停到点下的几百毫秒够一发 GET 打个来回，面板挂载时直接出内容而不是先转圈。

只覆盖 **ai** 和 **terminal** 两个标签（共 3 条查询）：

| 标签 | queryKey | fetcher |
|---|---|---|
| ai | `['llm-providers']` | `fetchLlmProviders` |
| ai | `['llm-settings']` | `fetchAgentLlmSettings` |
| terminal | `['terminal-shortcuts']` | `fetchTerminalShortcuts` |

三条的 queryKey 常量与 fetcher **都直接复用 `@tmex/api-client` 的导出**（不另抄端点字符串——
抄错了会往同一个 key 里写进形状不同的数据，比慢更糟），而 api-client 本来就在入口 bundle 里，
所以零额外体积。

预取落到 `nodeQueryClient(useRouteNodeId())`，与 `NodeRuntimeBoundary` 里 provider 用的是同一个
实例（每个 node 一份 QueryClient）。`useOptionalRuntime()` 取 apiClient，无 Provider 时跳过，
不影响静态渲染测试。每次进页面每标签只预取一次（`useRef<Set>`），鼠标扫过标签栏不会重复发请求。

### 3. 顺带：复杂度门禁

加完 effect 后 `SettingsPage` 130 行 > 124 上限。把组件内那段 `tabItems` 数组提为模块级
`SETTINGS_TAB_BAR` 常量（`value` / `labelKey` / `icon`，`data-testid` 改为按 `value` 拼），
门禁恢复通过。

## 三、Bundle 纪律（已验证）

`vite build` 前后对比，七个标签 chunk 全部仍然独立、体积不变：

| chunk | 改前 | 改后 |
|---|---|---|
| `SettingsPage` | 9.41 kB / gzip 3.70 | **9.87 kB / gzip 3.89** |
| `general-settings-tab` | 9.85 | 9.85 |
| `terminal-settings-panel` | 18.89 | 18.89 |
| `ai-settings-tab` | 20.20 | 20.19 |
| `notification-settings-tab` | 32.57 | 32.57 |
| `devices-and-files-tab` / `nodes-tab` / `remote-access-tab` | 独立 | 独立（0.86 / 84.31 / 51.06） |

入口侧只多了 +0.19 kB gzip（两个预热模块），**没有任何标签代码被搬回入口**。

## 四、审计了但**刻意不改**的

### 各标签挂载期取数（结论：没有值得动的 waterfall）

- **general**：`['site-settings']` 已在页级发起（早于 tab chunk 落地，本来就不是 waterfall）；
  `['system-info']` 单发。无串行。
- **devicesAndFiles**：`['files','settings','roots']` 与 `['devices']` 同一 commit 并行；
  且 `['devices']` 通常已被 app 级 `GlobalDeviceProvider` 用同一个 key 预热。
- **notifications**：`['telegram-bots']` / `['weixin-accounts']` / `['webhooks']` 三个兄弟并行。
- **ai**：`['llm-providers']` 与 `['llm-settings']` 并行；`SearchTab` 与 `LlmDefaultsCard` 共用
  `['llm-settings']`，react-query 自动去重成一次请求。
- **terminal**：只有 `['terminal-shortcuts']` 一发。
- **remoteAccess**：按要求未改动；tunnel status 与 auth mode 同时起步，无串行。

### NodesTab 的「三跳 waterfall」——查证后属于**理论问题**

静态看确实是 `/api/auth/mode` → `/api/mesh/nodes` → `/n/<hub>/api/hub/nodes`，且 `if (!loaded)`
硬门闸挡住整个标签。但 `MeshNodesResident` 挂在外壳根上（`apps/fe/src/main.tsx:144`），
`useSharedAuthMode` 还被侧边栏两处使用，`ensureAuthMode` 是模块级 memo 的单例 promise
——用户走到设置页时这几发**早就落地了**。为一个实测不存在的串行去重构 `mesh-nodes.ts`
（共享的命令式 store + 轮询 + 认证过渡守卫）风险远大于收益，**不动**。

### `['tls-status']` 的串行——是**故意的**，不能消

mesh 分支下 `<HttpsSection>` 要等 `local.status` 确认角色后才渲染，因此 `/api/tls` 串在
`/api/local/status` 后面。代码里写明了原因：纯 node 角色「连状态都不该去问」，抢跑会让
纯 node 在角色返回前拿到一份可操作的 HTTPS 表单。无条件预取 `/api/tls` 会破坏这个约束，
**不动**。同理不预取 `/api/local/status`：mesh 未登录时它稳定返回 401，投机性发一发会
反复惊动认证拦截器（`mesh-nodes.ts` 里已有 `isAuthTransitionActive()` 守卫正是防这个）。

### 为什么不在页面挂载时就预取全部数据

全局 QueryClient 只设了 `staleTime: 5000`（`apps/fe/src/node/node-runtimes.ts:264`）。进页面就把
七个标签的数据全拉一遍，等用户真点进去多半已经过期、照样重发；代价却是十来个投机请求跟
当前标签自己的 chunk / 请求抢带宽。悬停是高意图信号且窗口短，正好落在 staleTime 内——
所以**空闲队列只预热 chunk（模块缓存永不过期），数据预取只在悬停时做**。

### 未纳入预取的其余标签

`system-info` / `telegram-bots` / `weixin-accounts` / `webhooks` / `files-roots` / `tunnel-status`
的 queryFn 与 queryKey 都定义在各自的 lazy chunk 内部。为了预取把它们静态 import 进
`SettingsPage`，等于把那部分代码搬回入口 chunk，正好抵消按标签分块的收益（违反 bundle 纪律），
因此不做。

### 已知但未处理

`TerminalSettingsPanel` 静态引入 `@tmex/terminal-ui` 的 `TerminalPreview`，进而拉进
`ghostty-terminal` 引擎与字体加载，挂载时会实例化一个真终端做预览。这是 CPU / chunk 体积问题
而非延迟问题，`prefetchQuery` 帮不上；chunk 预热已经把它的下载成本提前了。真要再优化需要
把预览本身二次 lazy 化，超出本次范围。

## 五、测试

新增两个测试文件，均为纯函数/可注入依赖，不需要 DOM：

- `apps/fe/src/pages/settings/chunk-preload.test.ts` — **10 个**：
  空闲优先 + 带 timeout、取消回调、无 `requestIdleCallback` 时退回定时器并 `clearTimeout`；
  `preloadChunk` 去重、失败静默；`startIdleChunkPreload` 逐个排队、失败不打断队列、
  跳过已悬停预热过的、排空后不再申请空闲片、取消后不再发起且取消在途回调。
- `apps/fe/src/pages/settings/data-prefetch.test.ts` — **9 个**：
  ai / terminal 的 spec 内容、其余标签为空、`PREFETCHABLE_TABS` 与实际 spec 一致；
  逐条交给 `prefetchQuery`、同标签重复触发只发一次、无 spec 标签不占去重名额、
  多标签互不影响、`prefetchQuery` 失败不外抛。
- `apps/fe/src/pages/SettingsPage.test.tsx` 扩展 **2 个**：`chunkPreloadOrder` 排除当前标签且
  各出现一次、不同标签排出的顺序不同。

## 六、验收

| 项 | 结果 |
|---|---|
| `apps/fe` `bun test src/` | **947 pass / 0 fail**（基线 926，新增 21） |
| `bunx tsc --noEmit` (apps/fe) | 0 错误 |
| `bunx biome check <改动文件>` | 6 files，无问题 |
| `bun scripts/complexity/gate.ts` | ok（1068 files, 8860 functions） |
| `vite build` | 成功，七个标签 chunk 均独立 |

## 七、改动文件

- 新增 `apps/fe/src/pages/settings/chunk-preload.ts`
- 新增 `apps/fe/src/pages/settings/chunk-preload.test.ts`
- 新增 `apps/fe/src/pages/settings/data-prefetch.ts`
- 新增 `apps/fe/src/pages/settings/data-prefetch.test.ts`
- 修改 `apps/fe/src/pages/SettingsPage.tsx`
- 修改 `apps/fe/src/pages/SettingsPage.test.tsx`

未触碰 `apps/fe/src/pages/settings/remote-access/**`、`packages/gateway`、i18n locale 文件，
未触碰 `use-site-settings-form.ts` / site-settings loader。未执行任何 git 操作与 e2e。
