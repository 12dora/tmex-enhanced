# O11 执行结果 — 远程访问标签：Cloudflare Access、暴露确认与系统隧道接管（前端）

任务在执行过程中收到指挥方两次产品调整（契约 `87f90b16`「Access 改为可选 + `exposureProtected` + `acknowledgeExposure`」与 `130a7bb8`「external 探测 / `adopt_external` / `sync_access`」），下面按最终形态描述。

## 一、做了什么

### 1. 向导重做成动态步骤序列（`tunnel-model.ts` / `wizard.tsx` / `step-shell.tsx`）

原来是固定 4 步、第 3 步内部分叉。现在步骤序列由方式推导：

| 方式 | 步骤 |
|---|---|
| 命名隧道 | 安装 → 方式 → 登录 → 主机名 → 访问控制 → 创建并启动 → 反向代理信任 |
| 临时隧道 | 安装 → 方式 → 启动 → 反向代理信任 |
| 未选方式 | 安装 → 方式 →（占位）→ 反向代理信任 |

- `wizardSteps(ctx)` 给序列，`wizardStepState(step, ctx)` 逐步判定状态——**不按下标推**：访问控制是可选步，永远不会成为「当前」，也不会因为排在创建之前就被算成已完成（配置了才打勾）。
- 步骤编号由序列下标生成，`WizardStepCard` 新增 `tag` 入参，访问控制步带 `推荐`（`!loginEnforced`）/ `可选`（`loginEnforced`）徽标。
- 主机名没有对应的后端动作（契约里只有 `create` 带 hostname），所以「确认主机名」是**向导内部的一步**：草稿（hostname / tunnelName / confirmed）提到 `RemoteAccessTab` 持有并作为 `draft` 入参传下去（与 `chosenMode` 同一套做法，静态渲染的用例才驱动得了）。改主机名会自动推翻上一次确认。
- `named-step.tsx` 拆成 `LoginStep` / `HostnameStep` / `CreateStep` 三个导出。

### 2. 访问控制步（新增 `access-step.tsx` + `access-model.ts`）

- **(a) 凭证**：未保存时 API token（`type="password"`，提示需要 `Access: Apps and Policies — Edit`）+ Account ID → `set_access_credentials`；已保存时只展示「已保存」+ 账户 ID + 团队域 + 「清除」（`clear_access_credentials`）。
- **(b) 允许访问的用户**：规则列表编辑器（邮箱 / 邮箱域两态切换 + 值输入 + 删除，至少留一条，逐条即时校验并就地报错）→「应用到 Cloudflare」= `configure_access`（异步 job，`jobStep.create_app / policy / verify` 进度）；旁边是「从 Cloudflare 同步」= `sync_access`。凭证已保存但本地没有应用记录时，先给一条「建议先同步」的提示，避免重复建应用。
  - 服务端规则一变（应用 / 同步完成）就用 `key` 重挂编辑器，丢掉过期草稿。
- **(c) 应用状态**：应用 ID / AUD / 覆盖主机名 / 规则列表 /「网关校验 Access 令牌」开关（`set_access_enforce`，关闭时给明确警告）/「移除 Access 应用」（AlertDialog）/ `access.lastError`。
- `access-model.ts` 是纯推导：`isValidRuleValue` / `ruleDraftError` / `accessRulesValid` / `toAccessRules`（去空白 + 转小写）/ `ruleDraftsFrom` / `accessTargetHostname` / `canApplyAccess` / `canSyncAccess` / `shouldOfferAccessSync` / `accessStepTag`。
- **应用按钮的门槛与后端一致**：`configure_access` 不带主机名参数，后端用的是 `config.hostname`（`manager.ts` 里没有 hostname 就抛 `not_configured`），所以前端在 `config.hostname === null` 时禁用「应用」并给出原因；同步则宽松一档（后端会退回 `external.hostnames[0]`）。

### 3. 暴露警示与显式确认（新增 `exposure.tsx`，`tunnel-model.ts` 出纯函数）

按第一次产品调整：**Access 不再是闸门**，standalone 也不禁用临时隧道与创建 / 启动按钮。

- `exposureProtected === false` 时给 destructive 提示 + 「我了解风险，仍要开放公网访问」勾选框：方式步上方一条完整版（带「启用登录（多节点互联）」链接到 `?tab=nodes`），临时隧道启动按钮、创建按钮、状态卡启动按钮、随 tmex 启动开关旁各一条精简版。确认状态在标签层共享，勾一次全部生效。
- `withExposureAck(req, acknowledged)`（纯函数）只给 `create` / `quick_start` / `start` / `set_auto_start(true)` 加上 `acknowledgeExposure: true`；没勾就不带，由后端 409。关闭自启动是收敛动作，不需要确认。
- 后端回 `exposure_ack_required` 时，状态卡展示这条警示（带勾选框）而不是通用错误。
- 旧的 `auth_required` 提示保留（只由后端真的回该错误码触发，不再用 `/api/auth/mode` 预判），映射兼容。

### 4. 系统隧道接管（新增 `external-card.tsx`）

- `external.detected && config.mode === 'off'` 时在向导顶部给接管卡：来源（launchd / systemd / 进程 / 配置文件）、隧道名称 / ID、配置文件路径、运行状态、指向本机 tmex 的主机名（多个时用 `Select`，无则给提示并禁用接管）、「使用此隧道」（`adopt_external`）与「改为由 tmex 创建新隧道」（本地忽略）。
- `config.externallyManaged` 时：状态卡打「由系统服务托管」徽标 + 说明，隐藏启动 / 停止 / 移除，只留连通性检查 +「取消接管」；向导里安装步与登录步显示为跳过并算完成，创建步给「已接管系统中已有的隧道」，反向代理步不再给「随 tmex 启动」开关。
- 运行态：`tunnelPill` 对接管的隧道按 `external.running` 判定（与后端 `process.state` 的推导一致）。

### 5. 状态卡（`status-card.tsx`）

- 状态胶囊旁新增 **Access 胶囊**：`未配置 / 已配置但未强制 / 已保护`（`accessPill`）。
- 新增托管徽标、取消接管按钮、暴露警示位；其余（公网地址、复制、打开、检查结果、日志、命名隧道移除二次确认）保持不变。

### 6. 错误与进度文案

- `ERROR_CODES` 补 `access_api_failed`、`exposure_ack_required`；`access_api_failed` 走带 `{{message}}` 的插值（`describeTunnelError` 新增一张「需要 message」的表）。
- `JOB_STEPS` 补 `create_app` / `policy` / `delete_app` / `sync`（后者两个是照着 `manager.ts` 实际发出的标识补的，否则会原样显示英文串）。

### 7. i18n

`packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` 三份同结构，只在 `settings.remoteAccess` 子对象内**新增** 87 个叶子键（`accessState.*`、`externallyManaged*`、`actions.release`、`steps.{install.skipped,login.*,hostname.*,access.*,create.*}`、`jobStep.{create_app,policy,delete_app,sync}`、`errors.{access_api_failed,exposure_ack_required}`、`exposure.*`、`access.*`、`external.*`），**没有删除任何键**。写入用 `json.load → 定点赋值 → json.dumps(indent=2, ensure_ascii=False)`，事先验证过该往返对三个文件逐字节相同，不会重排别的 agent 的行。

三语叶子数各 203，完全同构；代码里引用的键（含模板展开的 `errors.* / jobStep.* / state.* / accessState.* / mode.* / access.rules.kind.* / external.sourceValue.*` 等）逐个核对无缺失。**未跑 `bun run build:i18n`**（生成文件由 commander 统一重建；`t()` 无类型增强，tsc 不依赖它）。

## 二、文件清单

新增：
- `apps/fe/src/pages/settings/remote-access/access-model.ts`
- `apps/fe/src/pages/settings/remote-access/access-model.test.ts`
- `apps/fe/src/pages/settings/remote-access/access-step.tsx`
- `apps/fe/src/pages/settings/remote-access/exposure.tsx`
- `apps/fe/src/pages/settings/remote-access/external-card.tsx`

改动：
- `apps/fe/src/pages/settings/remote-access/tunnel-model.ts`
- `apps/fe/src/pages/settings/remote-access/wizard.tsx`
- `apps/fe/src/pages/settings/remote-access/named-step.tsx`
- `apps/fe/src/pages/settings/remote-access/status-card.tsx`
- `apps/fe/src/pages/settings/remote-access/step-shell.tsx`
- `apps/fe/src/pages/settings/remote-access/remote-access-tab.tsx`
- `apps/fe/src/pages/settings/remote-access/{tunnel-model,tunnel-actions,remote-access-tab}.test.*`
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`（仅 `settings.remoteAccess` 内新增）

`tunnel-actions.ts` / `use-tunnel-status.ts` / `SettingsPage.tsx` 未改（不需要）。

## 三、测试

- `tunnel-model.test.ts`（40）：徽标矩阵（含接管态按探测运行态）、`wizardSteps` 三种序列、`wizardStepState` 逐步推进（登录 → 主机名 → 创建；访问控制永不抢当前步；接管时安装 / 登录直接完成）、`accessPill` 三态、`isExposingAction` / `withExposureAck` / `isExposureAckError`、主机名与隧道名校验、job 步骤全覆盖、错误映射（含 `access_api_failed` 带 message、`exposure_ack_required`）、轮询节奏、`logTail`。
- `access-model.test.ts`（12，新增）：邮箱 / 邮箱域校验（含 `you@example`、`example`、带 `@` 的域名等反例）、空值与非法值分开报、至少一条且全合法才可提交、提交前去空白转小写、服务端规则回填、目标主机名优先级、`canApplyAccess` 三要素、`canSyncAccess` 比应用宽松、`accessStepTag`。
- `tunnel-actions.test.ts`（19）：仅 fixture 补 `access` / `external` / `loginEnforced` / `exposureProtected` / `config.externallyManaged`，逻辑未动。
- `remote-access-tab.test.tsx`（62）：路由与加载分支、状态徽标与按钮矩阵、Access 胶囊三态、系统隧道接管（探测卡内容与位置、多主机名下拉、无主机名禁用、已配置不打扰、接管后按钮集合与跳过步）、暴露警示（位置在方式步之前、不禁用任何按钮、精简版出现在启动 / 创建旁、受保护时全不出现、`exposure_ack_required` 换成确认框）、错误码映射、步骤顺序与编号、Access 区块（未保存 / 已保存凭证、默认空规则禁用应用、回填规则可应用可删除、非法值就地报错、无主机名时禁用并说明、`create_app` / `policy` 进度、应用状态四项 + 强制开关 + 关闭警告、`lastError`）、命名隧道（登录 / 授权地址 / 超时 / 主机名校验挡住下一步 / 确认后才出现创建按钮 / 创建进度与失败 / 已配置只读 / Hub 提示）、日志。

### 数字

| 项 | 结果 | 基线 |
|---|---|---|
| `apps/fe`：`bun test src/pages/settings/remote-access/` | **133 pass / 0 fail** | — |
| `apps/fe`：`bun test src/` | **841 pass / 0 fail** | 671（其余为并行 agent 新增） |
| `apps/fe`：`bunx tsc --noEmit -p .` | **0 error** | 0 |
| `packages/shared`：`bun test` | **365 pass / 0 fail** | 365 |
| `bunx biome check apps/fe/src/pages/settings/remote-access/` | clean（16 文件） | — |
| `bunx biome check` 三个 locale JSON | clean | — |
| 三语 `settings.remoteAccess` 叶子键 | 各 **203**，完全同构 | — |

（未跑 e2e，按要求。未动 `apps/gateway`。）

## 四、给 G8 的对接点 / 风险

1. **`remove` 在接管态被后端 409 挡回来**。`manager.ts` 的 `case 'remove'` 调了 `requireNotExternallyManaged()`，但指挥方要求的「取消接管」正是 `remove`（契约里也没有别的动作能清掉 `externallyManaged`）。前端已经按要求做了这个按钮，**需要 G8 把 `remove` 从 `requireNotExternallyManaged()` 里豁免**：接管态下它应该只清本地配置（`mode='off'`、`externallyManaged=false`），不去动 Cloudflare 上的隧道，也不停系统服务。当前后端形态下点它会得到 `errors.invalid_request` 提示，不会崩，但功能是断的。
2. **`access_required` 已从契约删除，但 `manager.ts` 里还在抛**（`jobConfigureAccess` / `jobSyncAccess` 的「凭证未保存」分支）。前端的 `tunnelErrorKey` 认不出这个码，会退化成带服务端 message 的 `unknown` 兜底（文案仍可读）。建议 G8 换成 `not_configured` 或 `invalid_request`。
3. **`configure_access` 必须能拿到 `config.hostname`**。前端据此在没有主机名时禁用「应用到 Cloudflare」并解释原因；如果后端以后改成从别处取主机名，要同步告知，否则前端会白挡。
4. **前端认的 access job 步骤**：`create_app` / `policy` / `verify` / `delete_app` / `sync`。换标识就会退化成原样展示英文串。
5. **`adopt_external` 是同步动作**（返回 200 + status），前端按同步处理（按钮上转圈 + 直接写回快照）。若改成异步 job，接管卡不会显示进度条，但状态仍会在下一次轮询更新。
6. `set_auto_start(true)` 在接管态被后端拒绝——前端已经在接管态直接隐藏了这个开关。

## 五、取舍与遗留

1. **`steps.named.title` / `steps.named.description` 两个键现在没人用**（原来是「第 3 步 = 命名隧道」那张卡的标题，重做成 登录 / 主机名 / 访问控制 / 创建 四步后不再需要）。按 common-rules「targeted edits, never delete keys」没有删，留给 commander 决定是否清理。除这两个外，`settings.remoteAccess` 下没有其它未使用键（已脚本核对）。
2. **确认勾选用原生 `<input type="checkbox">`**：`@tmex/ui` 没有 Checkbox 组件，而风险确认用 Switch 语义上像「设置项」而不像「同意」。用 `<label htmlFor>` 关联，biome a11y 通过。
3. **规则类型切换用两个 `aria-pressed` 按钮而不是 `Select`**：列表里每行一个下拉在静态渲染的用例里很难断言，且两个选项用分段控件更省一次点击。主机名多选仍按要求用 `Select`。
4. **静态渲染的边界**：本目录没有 DOM 环境（`react-dom/server`），所以「点确认后进入下一步」「勾上后请求带 `acknowledgeExposure`」「点删除按钮后弹框」这类交互只能拆成两半验证——纯函数（`withExposureAck`、`accessRulesValid`、`wizardStepState`）单测 + 各种入参下的渲染断言（草稿 `confirmed: true` 时的产物、勾选框存在、对话框默认不在 DOM）。
5. **接管卡的「改为由 tmex 创建新隧道」只在本地忽略**（`useState`），刷新后若系统隧道仍在会再次出现——这是有意的：探测到的东西不该被前端永久藏掉。
