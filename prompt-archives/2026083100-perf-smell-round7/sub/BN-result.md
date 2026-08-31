# BN 结果：远程访问向导「直接连接」路径 + 凭证提示改一次性 toast

## 基线与最终验证

| 项目 | 基线 | 最终 |
| --- | --- | --- |
| `apps/fe` `bun test src/` | 948 pass / 0 fail / 67 files | **975 pass / 0 fail / 68 files** |
| 其中 `remote-access/` | 155 | 182（5 files） |
| `bunx tsc --noEmit`（apps/fe） | 0 | **0** |
| `bunx biome check <改动文件>` | — | **0 error** |
| `bun scripts/complexity/gate.ts` | — | 4 violation，**全部不在本任务改动的文件里**（见下） |
| `packages/shared` + `packages/api-client` `bun test` | — | 524 pass / 0 fail |

净增 27 个测试（direct-model 13 + tunnel-model 6 + remote-access-tab 9，含 Part B 一条）。

### 复杂度门禁的 4 条 violation（非本任务引入，未修）
```
apps/fe/src/pages/settings/nodes/management/enrollment-section.tsx:29 EnrollmentSection: 185 lines > 169
apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:36  NodesManagement:   158 lines > 151
apps/gateway/src/mesh/auth-routes.ts: 924 lines > 900
packages/app/src/runtime/assemble.ts:373 assembleTmex: CC 18 > 17
```
前两个文件 `git status` 显示未被任何人改动（分支上的既有超标）；后两个属于 gateway/app 侧另一位 agent 的改动范围。本任务改动的文件一条都没上榜——**`tunnel-model.ts:wizardStepState` 的 allowlist 锁定值 CC 27 没有被突破**（做法见「设计决策 3」），allowlist 未被编辑。

## 改动文件

新增：
- `apps/fe/src/pages/settings/remote-access/direct-model.ts` — 纯推导
- `apps/fe/src/pages/settings/remote-access/direct-model.test.ts`
- `apps/fe/src/pages/settings/remote-access/direct-step.tsx` — UI
- `apps/fe/src/pages/settings/remote-access/local-auth-api.ts` — 两个 POST 的客户端

修改：
- `apps/fe/src/pages/settings/remote-access/{tunnel-model.ts,wizard.tsx,remote-access-tab.tsx,access-step.tsx}`
- `apps/fe/src/pages/settings/remote-access/{tunnel-model.test.ts,remote-access-tab.test.tsx}`
- `packages/api-client/src/auth/types.ts`（**纯加性**）
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`（未跑 `build:i18n`，未碰生成的 `resources.ts`/`types.ts`）

## Part A：第三条路径「直接连接」

### 设计决策

**1. `direct` 是纯前端的展示路径，不进服务端枚举。**
`TunnelMode`（`off|quick|named`）一个字节都没动。新增 `WizardMode = TunnelMode | 'direct'` 只在向导内部流转：
`chosenMode`、`effectiveMode()`、`ModeChooser`/`ModeCard` 的 props 一并放宽到 `WizardMode`。
`effectiveMode()` 的既有优先级不变——`status.config.mode !== 'off'` 时服务端仍然赢，本地的 `direct` 选择自动让位（有测试锁住：已建 quick 隧道时 `effectiveMode(s,'direct') === 'quick'`，步骤序列回到 `install/mode/quick/proxy`）。选中 direct 不触发任何 `actions.run()`。

**2. 直连路径只有两步：`mode → direct`。**
`DIRECT_STEPS = ['mode', 'direct']`。刻意去掉了 `install` 与 `proxy`：这条路径不下载 cloudflared、不建隧道，摆一个「安装 cloudflared」的下载按钮是纯噪音。

由此带出一个必须一并处理的问题：`ModeChooser` 原本 `disabled={actions.busy || !status.binary.installed}`，没装二进制时三张卡全灰 → **直接连接这条路径会永远不可达**（而它恰恰是最不需要 cloudflared 的一条）。改成 `disabled={actions.busy}`，`locked`（服务端已建隧道）照旧。理由写进了代码注释：选方式只是本地选择，装不装由后面的安装步把关。这同时消除了「在 direct 里选不回 quick/named」的死角。既有断言全部仍然成立（未受保护时 quick 可选 = false；已建隧道时三张卡均 disabled）。

**3. `wizardStepState` 保持 CC 27 不越线。**
新增一个 `case 'direct'` 会让这个 allowlist 锁定的 switch 超标，因此把 `case 'mode'` 原有的两个判定（`if (!ready)` + 三元）整体外提成 `modeStepState(mode, ready)`，新 case 用 `directStepState()`。一进一出，CC 净变化为 0，门禁未报警。

- `modeStepState`：`direct` 无条件 `done`（与二进制无关）；其余保持原语义。
- `directStepState`：`directProtected(localAuth)` 为真才 `done`，否则 `current`。

**4. `unknown` 是独立一档，绝不退化成「没有保护」。**
`WizardContext` 加可选字段 `localAuth?: LocalAuthStatus | null`。四档判定在 `direct-model.ts`：

| localAuth | 档位 | UI |
| --- | --- | --- |
| 缺失 / null（旧后端、未加载） | `unknown` | warning：无法确认，别急着暴露 |
| `!supported`（hub/node） | `node` | success：已由节点登录保护 |
| `supported && effective` | `local` | success：本机登录已启用 |
| `supported && !effective` | `unprotected` | error + 启用流程 |

把 `unknown` 并进 `unprotected` 会把已受保护的实例误报成裸奔、并诱导用户在 hub 上做无意义的操作，所以单列一档、且不渲染启用表单。有专门测试锁住。

**5. 启用流程按后端契约分两阶段，顺序不可换。**
`directEnableStage()`：`credentialsPresent ? 'enable' : 'bootstrap'`。
- `bootstrap`：用户名 `^[A-Za-z0-9._-]{1,64}$` / 口令 ≥8 / 确认一致（`bootstrapDraftError` 与后端 `local-auth-settings.ts` 同一套规则，只做即时反馈），先 `POST /api/auth/local/bootstrap`，**再** `POST /api/auth/local {enabled:true}`——无凭证时直接置 true 会被 409 `CREDENTIALS_REQUIRED` 挡下。
- `enable`：只发第二个请求。

**启用前的二次确认是硬门槛**：警示条 + 必须勾选的 checkbox，未勾选时提交按钮 `disabled`。文案明说「当前所有已打开的会话都要重新登录一次」。

错误码映射（`localAuthErrorKey`）：`not_standalone`(404) / `LOCAL_ONLY`(403) / `CREDENTIALS_REQUIRED`·`CREDENTIALS_EXIST`·`LOCAL_AUTH_ENABLED`(409) / `invalid_username`·`weak_password`·`MALFORMED`(400)，未知码统一落 `unknown`，不把裸 code 甩给用户。403 `LOCAL_ONLY` 的中文写成「出于安全考虑，这项设置只能在这台机器上操作，不能通过远程访问修改」——正是远程调用时用户最需要看到的那句。

**6. 刷新 auth mode 的做法（一处取舍，请知悉）。**
`useSharedAuthMode` 背后的 `/api/auth/mode` 是**进程级缓存**（`modePromise` 一旦 resolve 就不再重拉），而向 `mesh-nodes.ts` 加一个 `refreshAuthMode()` 导出超出了本任务的所有权边界。两个接口的 200 响应都带回最新的 `localAuth`，因此改为：tab 里存一份 `localAuthOverride`，动作成功即就地覆盖（`localAuthOverride ?? mode?.localAuth ?? null`）。UI 会立刻从 `unprotected` 翻到 `local`。
**代价**：不会触发全局重新拉取 `/api/auth/mode`，页面其他部分要等下次刷新。考虑到后端整站门禁仍在收口（见下）、启用后用户本来就要重新登录，这个取舍可接受；若后续需要真正的全局刷新，建议在 `mesh-nodes.ts` 暴露一个 `refreshAuthMode()` 再接上。

**7. TLS 与入口地址提示。**
三档保护态下都常驻一条 info：HTTPS 提示 + 指向 `?tab=nodes` 的链接文案「前往节点设置配置 HTTPS」。入口地址给 `window.location.origin`（SSR/无 DOM 时降级为 `—`）+ 一句说明：对外暴露时把公网入口指向本机 `{{port}}`（取自 `status.config.originPort`）或自己的反向代理——真正的对外地址 tmex 看不到，只能给参考值。

**8. 契约警示（按要求写进 UI）。**
每一档保护态下方常驻一行 `remote-access-direct-caveat`：
> 说明：本机登录当前保证的是「访问 tmex 需要登录」这一条；更严格的整站拦截仍在完善中，请不要据此放宽其他防护措施。

全部文案（含 `unprotected` 档的描述）只承诺「启用后访问 tmex 需要登录」，没有一处暗示整站已被拦截。

### 文案样例

方式卡（zh）：**直接连接** / 自行通过固定 IP、端口映射或反向代理暴露 tmex 时选择此方式。
步骤（zh）：**访问保护** / 直连暴露不经过 Cloudflare，这一步只确认这台机器是否要求登录。
`unprotected`（zh）：**当前没有任何访问保护** / 公网直连意味着任何人拿到地址就能打开并使用这台机器上的 tmex，包括其中的终端与文件。启用本机登录后，访问 tmex 需要登录。
`unknown`（zh）：**无法确认访问保护状态** / 当前网关没有下发本机登录状态，通常是版本过旧。升级 tmex 后再确认；在确认之前不要把这台机器暴露到公网。

en/ja 为母语化重写而非直译，例如
en `unprotected`：*Exposed directly, anyone who finds the address can open and use the tmex running here — terminals and files included.*
ja `unprotected`：*このまま公開すると、アドレスを知った人は誰でもこのマシンの tmex を——ターミナルもファイルも——そのまま使えます。*
三个 locale 的 `settings.remoteAccess.direct` 各 45 个 key，键集完全一致（已用脚本核对；zh/en 仅存在既有的 `devices.folders.itemCount` 复数形式差异，与本任务无关）。

## Part B：凭证提示改一次性 toast

- 删掉 `access-step.tsx` 里 `SavedCredentials` 中常驻的 `SetupNotice tone="success"`；外层 `data-testid="remote-access-access-credentials-saved"` 容器、SectionTitle、账户 ID / 团队域两行、清除按钮的布局全部保留。
- 新增 `useCredentialsSavedToast(access.hasCredentials)`，挂在 `AccessStep` 顶层（不能放 `CredentialsForm`——它在成功后会被卸载）。用 `useRef` 记录上一次的值，**只认 `false → true` 这一次跃迁**：首次挂载时已有凭证不弹，避免一进页面就跳一条陈年成功提示。
- toast 走 `sonner` 的 `toast.success`，与本页所属设置页的既有做法一致（`nodes/https/https-section.tsx`、`nodes/setup/*-form.tsx` 都是这么用的），文案沿用 `settings.remoteAccess.access.credentials.saved`，并把三语文案改短成一句适合 toast 的话（zh「Cloudflare 凭证已保存。」，原文里那句「现在可以创建或同步 Access 应用」在下方规则编辑器已有引导，放 toast 里过长）。
- 测试：新增一条断言渲染结果里**不再出现** `settings.remoteAccess.access.credentials.saved` 文案键，容器 testid 仍在。

**一处未覆盖**：toast 本身的触发是 `useEffect` 行为，本页测试全部走 `renderToStaticMarkup`（无 DOM、不跑 effect），因此只测到「常驻条已移除」，没有测到「toast 真的弹了一次」。要补的话需要引入 DOM 测试环境，超出本轮改动范围。

## api-client 的加性改动（`packages/api-client/src/auth/types.ts`）

只加不改：
- `AuthModeResponse.localAuth?: LocalAuthStatus`（可选，旧后端缺失即按 `unknown` 处理）
- `LocalAuthMutationResponse`、`LocalAuthErrorCode`、`LocalAuthApiError`

两个 POST 的实现放在 `apps/fe/src/pages/settings/remote-access/local-auth-api.ts` 而非 `auth-api.ts`：任务书授权范围是「api-client auth **types**（仅加性）」，且 `auth-api.ts` 与 gateway 侧同批改动更容易撞车。若后续要收敛到 `AuthApi` 类里，这两个函数可以整体平移，签名无需改动。
