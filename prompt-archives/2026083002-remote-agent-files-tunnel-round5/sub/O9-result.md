# O9 执行结果 — 远程访问标签审查修复（前端）

## 一、逐条修复

### 1. 连通性检查不再从 202 推导结果（review-fe-2 #2 / review-be-2 #4）
- `tunnel-actions.ts`：`TunnelActionState.check` 换成 `checkJobId`。`run({action:'check'})` 成功后只记下 `res.job.id`，不产生任何结论。
- 新增两个纯函数（可脱离 DOM 测）：
  - `checkResultOf(job, checkJobId)`：只有轮询到的 job **就是这次受理的那一个**且已进入 `done` / `error` 时才给结论；`error` 取 `job.error.message`，为空退回错误码。
  - `checkRunning(job, checkJobId)`：同一 job 仍是 `running` 才算「检查中」。**故意不写成 `checkJobId !== null && result === null`**——那样在别的动作的 job 顶掉 check job 之后会永久停在「正在检查」。
- `useTunnelActions` 每次渲染从当前 `status.job` 推出 `check` / `checking` 两个字段，轮询一到就自动更新。
- `status-card.tsx`：`checking` 时显示中性提示 `remote-access-check-running`（「正在检查…」），此时既不显示可访问也不显示不可达；终态才切成 success / error 提示。

### 2. 信任反向代理开关绑「已保存值」（review-fe-2 #3、#5）
- `wizard.tsx` 的 `ProxyStep`：开关 `checked={status.configuredTrustProxy}`；另起一行 `remote-access-trust-proxy-effective` 展示生效值（`trustProxy` → `trustProxyState.on/off`）。
- 重启提示条件改为 `trustProxyRestartRequired(status)`（`tunnel-model.ts`）：`status.restartRequired || configuredTrustProxy !== trustProxy`，两条都认，后端漏报也能提示。
- 文案按现有 `nodes.https.external.trustProxy*` 的口径重写（三语）：`trustProxyHint`「仅当 tmex 只能经由该隧道访问时才开启」，新增 `trustProxyDetail` 说明会信任 `X-Forwarded-Proto` / `X-Forwarded-For`、能绕过隧道直连本机监听端口的人可以伪造、因此要限制该端口的外部访问。

### 3. 已配置命名隧道时第 3 步只读（review-fe-2 #4）
- `named-step.tsx`：`config.mode === 'named'` 直接渲染 `NamedTunnelSummary`（主机名 / 隧道名称 / 隧道 ID + `changeHint`「换隧道先移除」），创建表单只在 `config.mode === 'off'` 时存在。
- Hub 提示抽成 `HubHint`，创建表单与只读摘要都用它（本机即 Hub 时，创建完仍需要把 Hub 公开地址改成该主机名）。

### 4. 命名模式移除加二次确认（review-fe-2 #6）
- `status-card.tsx` 新增 `ConfirmRemoveDialog`（复用 `@tmex/ui/alert-dialog`，与 `https-section.tsx` 的 `confirmStop` 同一套写法）：`config.mode === 'named'` 时点「移除」先开对话框，文案明写「停止隧道、删除本机保存的凭证、并在 Cloudflare 上删除该隧道」＋「Cloudflare 上的隧道无法恢复，公网地址会立即失效」。quick 模式仍是一步直发。

### 5. `JOB_STEPS` 覆盖后端全部步骤（review-fe-2 #7）
- `tunnel-model.ts` 的 `JOB_STEPS` 扩成 `download / extract / verify / login / wait_cert / cancelled / create / create_tunnel / route_dns / start / check / ok`（`create_tunnel` 保留为兼容项，locale 里的同名键未删）。
- locale 三语补 `jobStep.check`、`jobStep.ok`（其余已存在）。

### 6. `tunnelName` 客户端校验 + `auth_required`
- `tunnel-model.ts` 新增 `isValidTunnelName`，正则与后端一致：`^[a-z0-9](?:[a-z0-9_-]{0,62})$`（挡住 `../../package`、`a/b`、`a\b`、`a.b`、大写、超长）。
- `named-step.tsx`：名称非空且不合法时 `FormField` 就地报错并禁用「创建并启动」；`tunnelNameHint` 补上字符集说明。**前端只做即时反馈，把关仍在后端（G6）。**
- `auth_required` 加进 `ERROR_CODES`，三语 `errors.auth_required` 用指定文案（zh「请先为本机启用登录，再开放公网访问。」/ en "Enable sign-in on this machine before exposing it publicly." / ja「公開する前に、このマシンでサインインを有効にしてください。」）。
- 向导在第 1 步与第 2 步之间常驻警示 `remote-access-auth-required`（文案 + 链到 `?tab=nodes`），触发条件 `authDisabled || isAuthRequiredError(status, actions.error)`：
  - `authDisabled` 由 `remote-access-tab.tsx` 预判——`useSharedAuthMode()` 的 `/api/auth/mode` 报 `mode === 'none'` 且已加载；
  - `isAuthRequiredError` 同时认动作错误与 `status.job.error`，后端真的回 `auth_required` 时也常驻。

## 二、文件清单

改动（全部在本任务 scope 内）：
- `apps/fe/src/pages/settings/remote-access/tunnel-model.ts`
- `apps/fe/src/pages/settings/remote-access/tunnel-actions.ts`
- `apps/fe/src/pages/settings/remote-access/status-card.tsx`
- `apps/fe/src/pages/settings/remote-access/wizard.tsx`
- `apps/fe/src/pages/settings/remote-access/named-step.tsx`
- `apps/fe/src/pages/settings/remote-access/remote-access-tab.tsx`
- `apps/fe/src/pages/settings/remote-access/tunnel-model.test.ts`
- `apps/fe/src/pages/settings/remote-access/tunnel-actions.test.ts`
- `apps/fe/src/pages/settings/remote-access/remote-access-tab.test.tsx`
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`（仅 `settings.remoteAccess` 子对象内新增 19 个键 + 改写 `steps.proxy.trustProxyHint`、`steps.named.tunnelNameHint`；未删除任何键）

`SettingsPage.tsx` 未改（不需要）。

i18n 写入用的是 `json.load` → 定点赋值 → `json.dumps(indent=2, ensure_ascii=False)`；已验证该往返对 HEAD 版本三个文件**逐字节相同**，因此没有对其它 agent（O6）的行做任何重排。

## 三、新增 / 调整的测试

- `tunnel-model.test.ts`（+4 组）：`isValidTunnelName`（含目录穿越串）、`jobStepKey` 遍历后端全部步骤、`trustProxyRestartRequired` 三态、`isAuthRequiredError`；`tunnelErrorKey('auth_required')`。
- `tunnel-actions.test.ts`：`check` 改成 running → done / running → error 两条迁移；「再次点击检查会先清掉上一次 job id」；`checkRunning` 组（含被别的 job 顶掉的场景）；`checkResultOf` 的对不上号 / 还在跑 / 无 job 全部返回 null（删掉了原来「无 job 即成功」的用例）。
- `remote-access-tab.test.tsx`：检查中只给中性提示、终态才给结果；信任开关绑 `configuredTrustProxy` 且生效值单独展示（用 `aria-checked` 断言）；已保存 ≠ 生效时即便 `restartRequired` 为 false 也提示重启；命名隧道已配置时第 3 步只读、无创建表单；命名模式移除按钮存在但对话框默认不在 DOM；`authDisabled` 时提示出现在第 2 步之前并带 `?tab=nodes`；后端回 `auth_required` 时同样常驻；正常时不打扰。
- 所有 `TunnelStatusResponse` fixture 补 `configuredTrustProxy`。

**未覆盖**：`tunnelName` 的行内报错与提交禁用需要输入交互，本目录是 `react-dom/server` 静态渲染（无 DOM 环境），只能靠 `isValidTunnelName` 的单元测试 + 直连的 `nameInvalid` 接线保证；同样地，移除确认对话框的「点击后打开」也只能断言默认不渲染。

## 四、验证数字

| 项 | 结果 |
|---|---|
| `apps/fe`：`bun test src/pages/settings/remote-access/` | **78 pass / 0 fail** |
| `apps/fe`：`bun test src/` | **782 pass / 0 fail**（基线 671，其余为并行 agent 新增） |
| `apps/fe`：`bunx tsc --noEmit -p .` | 本 scope **0 error**；全项目剩 5 条全部在 `packages/panels/src/agent/*` 与 `src/components/page-layouts/components/use-sidebar-agent-sessions.ts`（O8 的 agent store 改造进行中，不属本任务） |
| `packages/shared`：`bun test` | **365 pass / 0 fail**（基线 365，确认 locale 改动没破坏 shared） |
| `bunx biome check apps/fe/src/pages/settings/remote-access/` | clean（11 文件，0 error） |
| locale 三语 `settings.remoteAccess` 键 | 各 116 个叶子键，**完全同构**；代码里引用的键（含模板展开的 `errors.*` / `jobStep.*` / `state.*` / `mode.*` / `trustProxyState.*`）逐个核对无缺失 |

**未跑 `bun run build:i18n`**：生成文件由 commander 统一重建，且 O6 仍在改同一批 JSON，现在跑只会和下一次生成打架；`t()` 无类型增强，tsc 不依赖它。

## 五、与后端（G6）的约定 / 风险

1. `check` 必须保持异步 job 契约：202 里带上 job id，终态由 `GET /api/tunnel/status` 的 `job` 暴露（`done` 或 `error`）。若后端把 `check` 改回同步 200 且不带 job，前端将永远给不出结论（不会崩，只是不显示结果）。
2. 前端认的 job 步骤标识：`download / extract / verify / login / wait_cert / cancelled / create / route_dns / start / check / ok`。后端换标识就会退化成原样展示英文串。
3. `tunnelName` 的正则前后端必须一致；前端只是即时反馈，**目录穿越的把关必须在后端**（review-fe-2 blocker 属 G6）。
4. `configuredTrustProxy` 保存后应立刻在 `status` 里翻转（否则开关仍会弹回），`trustProxy` 保持进程实际值。
5. `auth_required` 需要在 `create` / `quick_start` 这类会把 gateway 暴露出去的动作上返回；前端另外用 `/api/auth/mode` 的 `mode === 'none'` 做了前置提醒，两者互不依赖。
