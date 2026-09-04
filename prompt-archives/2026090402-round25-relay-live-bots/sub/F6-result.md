# F6 结果 — 前端：迁移中继时与状态卡片上重新确认成员（`readmit-node`）

## 做了什么

按 F6 契约把「用当前根重新确认旧根签的成员」接进浏览器侧：接入 / 迁移中继时自动补签（在
`set-relays` **之前**），中继状态卡片上另给一个手动入口。

### 新增文件

- `apps/fe/src/node/readmit-members.ts` — 核心helper `readmitStaleMembers(deps)`：
  - `GET /api/mesh/relay/readmit/prepare` → 空列表即无操作（幂等，可反复调用）；
  - 凭据只问一次（`prompt.request({ purpose: 'admit', reuse: true })`），已有签名者（接入流程刚
    用根密码派生的根钥）直接复用，不再打扰用户；凭据交互在写锁**外**；
  - 逐条 `取 head → 签 readmit-node → POST /api/auth/keylog?hub=sync`，全程在注入的 key log
    写锁里，头逐条重取（seq 串行）；首条失败即停；
  - **授权签名者由授权字节自己决定**：`Authorization.signer === 'root'` 只能用根钥签
    （给的是通行密钥 → `READMIT_ROOT_REQUIRED`，一条都不签）；`=== 'passkey'` 时用授权里写着的
    那个 credential 对 `sha256(authorization_bytes)` 做断言（与 `buildAdmitNodeRecord()` 的
    passkey 分支同一条 `enrollmentSignerFrom` 管线）；
  - 返回 `{ signed, failed, code }`：`failed` 是「仍旧是旧根签」的条数，`code` 为 `null` 表示全部落账。
- `apps/fe/src/node/readmit-members.test.ts` — 11 个用例（见下）。
- `apps/fe/src/pages/settings/nodes/relay/use-relay-readmit.ts` — 状态卡片按钮用的 hook
  `useRelayReadmit()` 与失败文案查表 `readmitErrorText()`（`nodes.readmit.errors.*` →
  `relay.tenant.errors.*` → `auth.errors.*` → 原样 code）。单独成文件是为了不把
  `useRelayActions` 顶过 120 行的函数门禁。

### 改动文件

- `apps/fe/src/node/relay-enroll.ts` — `enrollRelay()` 在 `enroll` 之后、`set-relays` 之前插入
  `readmitIfRequired()`：`readmitRequired > 0` 才打 prepare；任何一条失败就直接返回
  `{ ok:false, code, readmit:{ signed, failed } }`，**不提交 `set-relays`**。`RelayFlowResult`
  的失败分支新增可选 `readmit` 字段。接入 / 迁移 / 追加 / 重新输入口令四种来意共用这一条路径
  （全仓只有 `use-relay-actions.submitEnroll` 一个调用点，已核实）。
- `apps/fe/src/pages/settings/nodes/relay/use-relay-actions.ts` — 接入对话框的行内错误改走
  `enrollErrorText()`：卡在补签那一步时显示「重新确认成员失败：<原因>」，否则维持原文案。
- `apps/fe/src/pages/settings/nodes/relay/use-relay-pending.ts` — `RelayPendingController`
  （`RelayActionsController` 继承它）新增 `readmitMembers()`，由 `useRelayReadmit` 提供；成功
  toast 后 `onChanged()` 重拉中继状态。
- `apps/fe/src/pages/settings/nodes/uplink/relay-uplink-panel.tsx` — 中继模式的告警区新增一条：
  `readmitPending > 0` 时给出 `nodes-relay-readmit` 警示行 + `nodes-relay-readmit-action`
  「重新确认成员」按钮（`actions.busy` 时禁用）。
- `apps/fe/src/node/mesh-relay.ts` — `MeshRelayState` 的空态补 `readmitPending: 0`。
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` — 新增 `nodes.readmit.*` 8 个 key
  （notice / action / done / none / failed + errors 三条），三语同步。**未跑 `build:i18n`**，
  生成物由指挥方统一重建。
- 测试桩同步：`relay-ui.test.tsx`、`local-uplink-tabs.test.tsx`、`relay-uplink-panel.test.tsx`、
  `mesh-relay.test.ts`。

### 越界说明（重要）

契约里的两个字段与一条路由必须经 `packages/api-client` 才能到达前端，而该包不在任何并行 agent
的范围内（G7 只动 `packages/shared` / `apps/gateway` / `packages/app`），因此我改了
**`packages/api-client/src/relay/tenant-api.ts`** 一个文件：

- `RelayTenantStatus` 新增 `readmitPending: number`（`normalizeRelayStatus` 里 `?? 0`，旧节点为 0）；
- `RelayEnrollResponse` 新增可选 `readmitRequired?: number`；
- 新增 `RelayReadmitEntry` / `RelayReadmitPrepare` 类型与 `readmitPrepare()` 方法。

不改这里的话 `normalizeRelayStatus()` 会把 `readmitPending` 直接丢掉，状态卡片拿不到计数。
该文件与 G7 的范围无交集，实测无冲突。

## 怎么验证的

（在 `/Users/konata/code/tmex-r25`，G7 已落地 shared 侧 `readmit-node` 之后跑的最终一轮）

- `cd apps/fe && bunx tsc --noEmit -p .` → **0 error**。
- `cd apps/fe && bun test src/node src/pages/settings/nodes` → **1050 pass / 0 fail**
  （58 个文件，3253 断言）。其中新增：
  - `readmit-members.test.ts` 11 个：逐条签 `readmit-node`（授权签名用当前根钥验签通过、证书字节
    原样、两条 seq 连着走）、空列表不问凭据不签记录、缺签名者时问一次
    `{purpose:'admit',reuse:true}`、用户取消一条不签、全程在写锁里、根签授权拒绝通行密钥、
    通行密钥授权断言的 challenge 是 `sha256(授权字节)` 且 credential 对得上、授权字节畸形报
    `READMIT_MALFORMED`、首条被拒即停、上级未确认按 `hubError` 报、prepare 失败错误码透传。
  - `relay-enroll.test.ts` 3 个：`readmitRequired>0` 时记录顺序是 `readmit-node → set-relays`；
    `=0` 时不打 prepare；补签失败时**不提交 `set-relays`** 且结论带 `readmit:{signed,failed}`。
  - `relay-uplink-panel.test.tsx` 3 个：告警行与按钮出现 / 不出现 / busy 时禁用。
  - `relay-ui.test.tsx` 1 个：`readmitErrorText` 的三级查表回退。
- `bun scripts/complexity/gate.ts` → **complexity gate ok**（未加任何 allowlist 条目；
  `useRelayActions` 因此把 readmit 动作拆进了独立文件）。
- `bunx biome check <本次改动的 14 个文件>` → 无问题（只对自己范围内的文件用过 `--write`）。
- `cd packages/api-client && bunx tsc --noEmit -p .` → 5 error，与基线一致，且没有一条出自
  `relay/tenant-api.ts`。
- 语言包三语 key 集合一致性（复数后缀归一后比较）用脚本单独核过：`identical: True`。

## 遗留 / 不确定

1. **`resources.ts` 未重建**：`packages/shared/src/i18n/locale-consistency.test.ts` 里
   「resources.ts 与 locales/*.json 同步」那条现在必然失败，须由指挥方跑
   `bun run --filter @tmex/shared build:i18n`。按共同规则我没有碰生成文件。
2. **未做浏览器实测截图**：本轮是多 agent 并行改同一 worktree，起临时实例会与他人冲突；
   告警行的换行 / 截断建议在合并后的开发实例里再核一次（文案规范要求）。
3. **告警只在中继模式下出现**：`readmitPending` 在 hub 模式也可能大于 0，但那时补签由迁移流程
   自动完成，卡片上不再单独提示（避免迁移前的噪声）。若希望 hub 模式也提示，把
   `RelayNotices` 里那一段提到 `RelayUplinkPanel` 顶层即可。
4. **通行密钥签的授权**：补签时会对**授权里写着的那把** credential 逐条发起断言仪式（每条一次
   WebAuthn 交互）。根签的授权（生产上就是这一类）只需一次密码。若后端 `applyReadmitNode` 对
   passkey 分支另有约定（例如允许沿用旧 `authorization_sig`），前端这一段要跟着调。
5. `RelayReadmitEntry` 的 `name` / `admitSeq` / `admitRootEpoch` 前端目前只做类型承接、未展示；
   将来若要在卡片上列出「哪几台」可直接用。
