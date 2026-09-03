# OD 结果：F9 weixin / telegram 表单弹窗合一（仅前端 panels 层）

## 1. 做了什么

新增 `packages/panels/src/settings/integration-account-form-modal.tsx`：schema 驱动的通用集成账号表单弹窗，并把
`weixin-account-form-modal.tsx` / `telegram-bot-form-modal.tsx` 改写成"只剩配置对象 + 一层包装组件"。

通用件的契约：

- `IntegrationField<TEntity>` 判别联合，四种 kind：`text` / `secret` / `select` / `toggle`。每个字段带
  `key`、`inputId`、`testId`、`labelKey`、`initialValue(entity)`、可选 `validate(value, { isEdit })`；
  文本类字段的 `placeholderKey` 支持 `string | ((ctx) => string)`（telegram token 的新增/编辑两套 placeholder 靠它）。
- `IntegrationFormConfig<TEntity>`：`testIdPrefix`、`queryKey`、`addTitleKey`/`editTitleKey`、`fields`、
  `buildPayload(values, { isEdit, entity })`、`create{ path, errorFallbackKey, successToastKey, readResponse? }`、
  `update{ path(entity), errorFallbackKey, successToastKey }`。
- 导出的纯函数：`integrationInitialValues`、`integrationCanSubmit`、`nonEmptyText`；
  导出的可测渲染件：`IntegrationFormFields`（弹窗外壳走 portal，静态渲染取不到，所以字段区单独成件）。
- 异步提交：单个 `useMutation`，按 `entity` 是否存在选 POST/PATCH、错误兜底文案、成功 toast key、是否解析响应体；
  错误展示沿用原有的 `toast.error(err.message ?? t('common.error'))`（不新增任何界面文案）。
- 新增成功后的副作用用 `onCreated({ response, values })` 回调外抛，微信侧据此打开 `WeixinAccountLoginModal`。

`weixin-accounts-tab.tsx` / `telegram-bots-tab.tsx` **未改动**：两个 modal 的 props（`account` / `bot`）保持原样，
tab 无需跟着改；两个 tab 之间剩余的重复（列表 query + 新增/编辑状态）要收敛需要再开一个 `use-integration-list-tab.ts`
之类的新文件，超出本任务"只允许新增通用 modal + 其测试"的文件授权，故未做。

## 2. 行为等价性核对（逐条）

| 关注点 | weixin | telegram |
|---|---|---|
| 字段 / label / placeholder i18n key | `weixin.accountName`、`weixin.accountNamePlaceholder`、`weixin.enableAccount` | `telegram.botName`、`telegram.botNamePlaceholder`、`telegram.botToken`、`telegram.botTokenPlaceholder`(新增)/`telegram.tokenPlaceholder`(编辑)、`telegram.allowAuthRequests` |
| 默认值 | `name = account?.name ?? ''`、`enabled = account?.enabled ?? true` | `name = bot?.name ?? ''`、`token = ''`、`allowAuthRequests = bot?.allowAuthRequests ?? true` |
| 校验 | `name.trim().length > 0` | `name.trim().length > 0 && (isEdit || token.trim().length > 0)` |
| 新增载荷 | `{ name, enabled, allowAuthRequests: true }` | `{ name, token, enabled: true, allowAuthRequests }` |
| 编辑载荷 | `{ name, enabled }` | `{ name, allowAuthRequests }`，token 非空时追加 `token` |
| 端点 | POST `/api/settings/weixin/accounts`、PATCH `…/{id}` | POST `/api/settings/telegram/bots`、PATCH `…/{id}` |
| 成功 toast | `weixin.accountCreated` / `weixin.accountUpdated` | `common.success` / `common.success` |
| 失败兜底 | `weixin.createFailed` / `weixin.updateFailed` | `telegram.createFailed` / `telegram.updateFailed` |
| queryKey 失效 | `['weixin-accounts']` | `['telegram-bots']` |
| 响应体解析 | 新增解析（取 `accountId` 开登录弹窗） | 新增不解析（保持原样，不多调一次 `res.json()`） |
| data-testid | `weixin-account-add-modal` / `weixin-account-edit-modal-{id}` / `weixin-account-name-input` / `weixin-account-enabled` / `weixin-account-form-submit` | `telegram-bot-add-modal` / `telegram-bot-edit-modal-{id}` / `telegram-bot-name-input` / `telegram-bot-token-input` / `telegram-bot-allow-auth` / `telegram-bot-form-submit` |
| DOM 结构 | `space-y-1.5` + label + Input、toggle 行 `flex min-h-10 …`、DialogFooter 两个按钮，全部逐字保留 | 同左 |

i18n key **零增删**；界面文案零变更。`apps/fe/tests/settings.spec.ts:148-150` 依赖的三个 telegram testid 均保留。

两处刻意的等价化简，均无行为差异：

1. 原 update mutation 里的 `if (!account) throw new Error(t('weixin.updateFailed'))` 是死分支
   （`isEdit = Boolean(account)`，编辑态必有实体），合并 create/update 为单 mutation 后自然消失。
2. 原实现 `useState('')` 后靠 effect 在 open 时回填；现在 `useState` 初值直接由 `integrationInitialValues(entity)` 给，
   effect 仍在 `open` 变 true 时重置。差别只在"挂载即 open=true"的首帧（原来先空一帧再填），不构成回归。

## 3. 行数

| 文件 | 前 | 后 | Δ |
|---|---:|---:|---:|
| `weixin-account-form-modal.tsx` | 195 | 101 | **−94** |
| `telegram-bot-form-modal.tsx` | 187 | 94 | **−93** |
| `weixin-accounts-tab.tsx` | 88 | 88 | 0 |
| `telegram-bots-tab.tsx` | 75 | 75 | 0 |
| `integration-account-form-modal.tsx`（新） | — | 360 | **+360** |
| 生产代码小计 | 545 | 718 | **+173** |
| `integration-account-form-modal.test.tsx`（新） | — | 246 | +246 |

**生产行数是净增的，必须说清楚**：通用件 360 行里，类型契约 94 行、`select` 支持约 45 行
（任务书明确要求 text/secret/select/toggle 四种 kind，两个现存集成只用到其中三种）、字段渲染 53 行、
提交 hook 39 行、弹窗外壳 84 行。收益不在本次的总行数，而在边际成本：
再接入第三个集成从"再抄一份 ~190 行弹窗"变成"写一个 ~95 行的配置对象"，
且校验规则 / 载荷形状 / 端点 / toast key 全部变成可单测的声明式数据（本次新增的 12 条断言里有 7 条就是打在这上面的）。
若指挥官认为净增不可接受，唯一可砍的是 `select` 分支（约 −45 行），但那与任务书的字段种类要求冲突，我没有自作主张砍。

## 4. 测试 / 类型 / lint / 门禁

- 基线（改动前）：`packages/panels` 内 `bun test src/settings` = **74 pass / 0 fail**；`bunx tsc --noEmit -p .` = **0 error**。
- 改动后：`bun test src/settings` = **86 pass / 0 fail**（+12 条新断言文件）；`bun test`（全包）= **798 pass / 0 fail**。
- `bunx tsc --noEmit -p .`（packages/panels）= **0 error**，未超基线。
- `bunx biome check` 六个相关文件 = **clean**。
- `bun scripts/complexity/gate.ts` 在我最后一次改动落盘后跑出 **`complexity gate ok (1258 files, 11682 functions)`**；
  期间通用件的 `IntegrationAccountFormModal` 曾一度 131 行超 120 线，已抽出 `useIntegrationSubmit` 降到 84 行，
  **未新增任何 allowlist 条目**。

新增测试 `integration-account-form-modal.test.tsx` 覆盖：schema 渲染四类字段（id/testid/label/placeholder）、
secret 渲染为 `type="password"` 且文本字段不是、`isEdit` 切换 placeholder、编辑态回填实体值且密钥字段恒为空
（并断言实体上的密钥不出现在 HTML 里）、校验未过时 `integrationCanSubmit` 为 false（含纯空格）、
两个真实配置的新增/编辑载荷形状与端点/queryKey/校验规则。

## 5. 并行干扰说明（非本任务问题）

跑最终验证时，同一 worktree 内另一个 agent 正在改 `packages/api-client`（新增 `json-mutation.ts`，
改写 `watch.ts`/`file-resources.ts` 等，见 `git status`）。其中间态导致：

- `packages/panels` 的 `bunx tsc` 输出里出现 `../api-client/src/watch.ts` 的 TS7006/TS2322/TS2345（`tsc` 退出码仍为 0 的那次是我改动落盘时刻的快照）；
- `src/settings/directory-picker-modal.test.tsx` 的 3 条断言短暂转红，栈顶在 `packages/api-client/src/json-mutation.ts:49`；
- `bun scripts/complexity/gate.ts` 最后一次跑报 `apps/gateway/src/hub/uplink-server.ts: 2269 lines > 2261`。

三项均不涉及我拥有的文件；我自己的 12 条测试在该时刻仍全绿。以上以我改动落盘瞬间的那次全绿快照为准。

---

## 追加：删除 select 分支（按指挥官指示）

本轮目标是精简，未被 weixin / telegram 任何一方使用的泛化能力属于死代码，已全部移除：

- 删 `IntegrationSelectField` 接口、`IntegrationSelectInput` 组件、`renderField` 里的 `field.kind === 'select'` 三元分支，
  以及 `@tmex/ui/select` 的整行 import。`IntegrationField` 现在只剩 `IntegrationTextField`（`kind: 'text' | 'secret'`）
  与 `IntegrationToggleField` 两支。
- 顺带删掉同样没人读的 `buildPayload` 上下文字段 `entity`：签名由
  `(values, ctx: IntegrationFormContext & { entity?: TEntity })` 收敛为 `(values, ctx: IntegrationFormContext)`，
  调用点相应改为 `config.buildPayload(values, { isEdit: Boolean(entity) })`。
  `update.path(entity)` 仍然要用实体（拼 URL），保留不动。
- 测试里删掉 demo schema 的 `channel` select 字段、`DemoEntity.channel` 以及对应断言，
  用例名由"四类字段"改为"三类字段"。

保留的分支全部有真实使用方：`secret`（telegram token）、`placeholderKey` 函数形态（telegram token 的新增/编辑双文案）、
`validate`（两侧的必填规则）、`create.readResponse`（微信要读 `accountId`，telegram 不读）、`onCreated`（微信登录弹窗）。

### 新行数

| 文件 | 原始 | 删 select 前 | 删 select 后 | 相对原始 |
|---|---:|---:|---:|---:|
| `weixin-account-form-modal.tsx` | 195 | 101 | 101 | −94 |
| `telegram-bot-form-modal.tsx` | 187 | 94 | 94 | −93 |
| `weixin-accounts-tab.tsx` | 88 | 88 | 88 | 0 |
| `telegram-bots-tab.tsx` | 75 | 75 | 75 | 0 |
| `integration-account-form-modal.tsx`（新） | — | 360 | **308** | +308 |
| **生产代码小计** | **545** | 718 | **666** | **+121** |
| `integration-account-form-modal.test.tsx`（新） | — | 246 | 230 | +230 |

生产净增从 +173 收到 **+121**（通用件 −52 行，测试 −16 行）。

### 复验

- `cd packages/panels && bun test src/settings` → **86 pass / 0 fail / 168 expect**（基线 74 pass，未减少）。
- `bunx tsc --noEmit -p .`（packages/panels）→ 我拥有的 `src/settings/**` **零报错**；
  输出里仅剩 9 条来自并行 agent 正在改的 `../ghostty-terminal/src/canvas-renderer.ts`（`GhosttyRenderCellStyle` / `colorToCss` 未定义等中间态），与本任务无关。
- `bunx biome check` 六个相关文件 → **clean**。
- `bun scripts/complexity/gate.ts` → 唯一违规是并行 agent 的 `apps/gateway/src/hub/uplink-server.ts:1536 handleKeyLogAppend: 122 lines > 120`，
  `packages/panels/src/settings/**` 无任何违规，仍未新增 allowlist 条目。
