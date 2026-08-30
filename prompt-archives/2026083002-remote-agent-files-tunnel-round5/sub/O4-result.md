# O4 执行结果 — 设置页「远程访问」标签（Cloudflare Tunnel 向导，前端）

## 一、做了什么

### 1. 标签注册（`apps/fe/src/pages/SettingsPage.tsx`）
- `SettingsTab` / `SETTINGS_TABS` 增加 `remoteAccess`，`?tab=remoteAccess` 深链可用，非法值仍回退 `general`。
- 可见顺序：`通用 → 终端 → 远程访问 → 设备与文件 → 多节点互联 → 通知 → AI`（按要求紧挨终端右侧），图标 `Globe`。
- 渲染分支增加 `{activeTab === 'remoteAccess' && <RemoteAccessTab />}`。

### 2. 新目录 `apps/fe/src/pages/settings/remote-access/`
| 文件 | 职责 |
|---|---|
| `tunnel-model.ts` | 纯推导：状态徽标 `tunnelPill`、向导步进 `currentWizardStep`/`effectiveMode`/`stepState`、RFC 1123 小写主机名校验 `isValidHostname`、`jobStepKey`、`tunnelErrorKey`/`toTunnelError`/`describeTunnelError`、轮询节奏 `tunnelPollInterval`（2s / 10s）、`logTail`（末尾 200 行） |
| `use-tunnel-status.ts` | `useQuery(fetchTunnelStatus)`；`refetchInterval` 在 `job.state==='running'` 或 `process.state==='starting'` 时 2s，其余 10s；401 单独摘成 `loginRequired`；`setStatus` 把动作响应体直接写缓存 |
| `tunnel-actions.ts` | `TunnelActionController`：一把串行锁（挂起中丢弃后续动作；后台 job 在跑时只放行 `cancel_login`），错误转成 `{code,message}` 并触发重拉，`check` 结果从响应 job 提取 |
| `step-shell.tsx` | `WizardStepCard`（编号圆点 / 当前步高亮 / 完成打勾，`data-step-state`）、`ProgressRow`、`JobProgress`（`job.step` → i18n，未知步骤原样展示）、`DetailRow` |
| `status-card.tsx` | 状态卡：状态胶囊（未配置/已停止/启动中/运行中/错误）、公网地址（等宽 + 复制 + 新标签页打开）、方式标签、重启次数（>0 才显示）、启动/停止/移除/检查连通性、检查结果就地展示、`<details>` 日志（等宽框、末尾 200 行、行数变化即贴底） |
| `wizard.tsx` | 四步向导：① 安装 cloudflared（已装展示版本/来源/路径；未装给安装按钮 + `job.step` 进度；不支持平台只给提示）② 方式二选一（已建隧道后锁定）③ 临时隧道（`quick_start`，启动后展示 trycloudflare 地址）/ 命名隧道 ④ 反向代理信任 + 随 tmex 启动开关 + `restartRequired` 时的立即重启（复用 `useRestartGateway`） |
| `named-step.tsx` | 登录 Cloudflare（`login` → `auth.loginUrl` 按钮 + 复制 + 取消 `cancel_login`；`login_timeout` 等 job 错误映射）→ 主机名（校验）+ 可选隧道名称 → `create`（`job.step` 进度、`dns_route_failed` 等错误映射）；本机即 Hub 时给「Hub 公开地址设为此主机名」提示并链到 `?tab=nodes` |
| `remote-access-tab.tsx` | 路由 node ≠ self 时只渲染提示；否则组合状态卡 + 向导；`isSelfHub` 由 `/api/auth/mode` 的 `hubNodeId === nodeId` 判定（走 `useSharedAuthMode`，不额外发请求） |

复用了既有件：`SetupNotice` / `FormField` / `SwitchRow`（`nodes/setup/form-parts.tsx`）、`CopyButton`（`nodes/copy-feedback.tsx`）、`useRestartGateway`（`nodes/restart/use-restart-now.ts`）；忙锁与 pending 轮询沿用 TLS 区块的做法。

### 3. i18n
`packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` 三份同结构新增：
- `settings.tabGroup.remoteAccess`
- `settings.remoteAccess`（111 个叶子键：状态、方式、动作、检查、日志、四个步骤、`jobStep.*`、`errors.<TunnelErrorCode>` 全覆盖 + `unknown` 兜底带 `{{message}}`）

已脚本校验：三语键完全一致；代码里用到的所有键（含模板字符串展开）都存在；没有新增未被使用的键。**未跑 `bun run build:i18n`**（生成文件由 commander 统一重建；`t()` 无类型增强，不影响 tsc）。

## 二、测试
- `tunnel-model.test.ts`（19）：徽标矩阵（含「进程报错优先于未配置」）、步进与 `effectiveMode`、主机名合法/非法用例、`jobStepKey`、错误码映射与兜底、轮询节奏、`logTail`。
- `tunnel-actions.test.ts`（9）：挂起期间丢弃并发、job 在跑时挡下普通动作但放行 `cancel_login`、成功写回快照、check 可达/不可达、失败保留错误码并重拉、新动作清旧错误。
- `remote-access-tab.test.tsx`（32）：远端路由只给提示、加载/未登录/失败分支、状态徽标与按钮矩阵、忙锁禁用、检查结果、错误码映射、向导四步步进（含不支持平台、安装进度与失败）、临时隧道已启动、命名隧道登录/授权地址/取消/超时/表单/创建进度/创建失败、Hub 提示的有无、日志渲染与 200 行截断。
- `SettingsPage.test.tsx`：`TAB_IDS` 增加 `remoteAccess`，新增「紧挨终端右侧」顺序断言，面板互斥断言补上远程访问。

### 数字
- `cd apps/fe && bun test src/`：**760 pass / 2 fail**。2 个失败是 `src/node/mesh-events.test.ts`（`rttMs`/`transport` 由 `undefined` 变 `null`），属并行进行中的 mesh reach/rttMs 契约改动，不在本任务范围；只跑本任务 4 个文件时 **67 pass / 0 fail**。
- `cd apps/fe && bunx tsc --noEmit -p .`：**0 errors**（基线 0）。
- `cd packages/shared && bun test`：**365 pass / 0 fail**（基线 365）——确认 locale JSON 改动没有破坏 shared。
- `bunx biome check <本任务文件>`：clean（13 个文件，无 error）。

## 三、约定与取舍
1. **`RemoteAccessTab` 在 SettingsPage.test 里没有被替身化**。原打算用 `mock.module('./settings/remote-access/remote-access-tab', ...)` 做 `?tab=remoteAccess` 深链渲染断言，但 bun 的 `mock.module` 是进程级、跨测试文件泄漏的：它会让 `remote-access-tab.test.tsx` 拿到那个空壳（实测 23 个用例失败）。因此 SettingsPage.test 只断言标签存在 / 顺序 / 面板互斥，面板本身的渲染全部在 `remote-access-tab.test.tsx` 覆盖。
2. **第 3 步的路径由本地 `useState` 驱动**，静态渲染点不了方式卡，所以命名隧道的子步骤用例直接渲染 `TunnelWizard` 并传 `chosenMode`；`RemoteAccessTab` 只负责把 `useState` 接上这个入参，Hub 提示的接线则通过「`config.mode` 已是 named」的整页渲染验证。
3. **`isHub` 走 `useSharedAuthMode()` 而不是 `useLocalStatus()`**：前者是 `useSyncExternalStore` 的宿主级单例（不额外发请求、静态渲染可注入），后者是 React Query，会把 `useLocalStatus` 拖进本标签的查询层；判定条件是 `/api/auth/mode` 契约里的 `hubNodeId === nodeId`。
4. **公网地址 / 授权地址的「打开」用原生 `<a class={buttonVariants(...)}>`** 而不是 `<Button render={<a/>}>`：后者会触发 `lint/a11y/useAnchorContent`（biome 看不到 render 目标的子节点），仓库里没有为此加 ignore 的先例。
5. **日志用 `<details>` 而不是受控折叠**：内容常驻 DOM，展开不重挂，静态渲染的用例也能直接断言行内容；自动贴底挂在行数变化上。
6. `check` 是同步动作，结果从 `TunnelActionResponse.job` 提取（`job.error` → 不可达 + message，否则可访问）；`busy`（409）与其它错误码统一走 `settings.remoteAccess.errors.<code>`，未知码退化成带服务端 message 的 `unknown`。
7. 契约形状一律没动（`packages/shared/src/contracts/tunnel.ts`、`packages/api-client/src/local/tunnel-api.ts` 只读引用）。

## 四、风险 / 待确认（给 G4）
- **`quick_start` 的进度 job kind 假设为 `'start'`**（契约的 `TunnelJobKind` 里没有 `quick_start`）。若后端用别的 kind，临时隧道那一步的进度条不会出现（不影响其它显示，因为启动成功后会走 `process.publicUrl` 分支）。
- **`job.step` 的取值约定为** `download` / `extract` / `verify`（install）与 `create_tunnel` / `route_dns` / `start`（create）。未知标识会原样展示服务端字符串，不会崩，但没有本地化。
- **`check` 无 job 时按「可访问」处理**。若后端对 `check` 只返回 `job: null` 且用 HTTP 错误表达不可达，前端会走 `actions.error` 分支（错误提示），行为仍正确；但若要在 200 响应里表达不可达，必须带上 `job.error`。
- 移除（`remove`）没有二次确认对话框。TLS 区块对「停掉正在服务的监听」做了二次确认，隧道移除的自锁风险要低一些（本机端口不受影响），但如果产品上希望防误触，可以后续补一个 `AlertDialog`。
