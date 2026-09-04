# F7 结果 — readmit-node 审查修复（R3）前端侧

## 范围

只改 `apps/fe/**` 与三份源 locale JSON。生成物（`packages/shared/src/i18n/resources.ts`、`types.ts`）未重建，由 commander 统一跑 `build:i18n`。

## 改了什么

### 1. Blocker 2：补签提前到远端换发令牌之前

`apps/fe/src/node/relay-enroll.ts`

- `enrollRelay()` 拆成两段：外层只做「派生根钥 + 根公钥对拍 + `finally` 清零 seed」，新增 `enrollWithRootKey()` 承载正式流程，新增 `enrollRemote()` 封装 `proof-material → 签 proof → enroll`。
- 新顺序：**`readmitStaleMembers()`（本机 `GET /api/mesh/relay/readmit/prepare` → 逐条签 `readmit-node`）→ `proof-material` → `enroll` → `set-relays`**。补签失败（含 prepare 失败）直接返回，**一个远端请求都不发**，租户令牌不会被换发，旧链路照旧可用。
- 不再依赖 `enrolled.readmitRequired` 才启动补签：本地 prepare 回空表本身就是无操作，所以无条件先跑一遍。
- `readmitRequired` 降级为**事后复核**：`enroll` 返回值 > 0 时以新错误码 `READMIT_PENDING` 中止，**不提交 `set-relays`**，结论里带 `readmit: { signed, failed: pending }`。
- 根密码只问一次：补签与 `set-relays` 共用同一把派生出的根钥（`signer: { kind: 'root', rootKey }`），凭据对话框（接入表单）仍只弹一次。
- 删掉旧的 `readmitIfRequired()`，新增小函数 `readmitFailure()` 统一构造失败结论。

`apps/fe/src/node/readmit-members.ts` 新增导出常量 `READMIT_PENDING`。

`apps/fe/src/pages/settings/nodes/relay/use-relay-readmit.ts`：只更新了一句已过期的注释（原写「`set-relays` 之前」，改为「远端换发令牌之前」）。

### 2. Should-fix：根钥在手就重新编码 root-signed 授权

`apps/fe/src/node/readmit-members.ts`

- `buildReadmitPayload()` 拆成 `decodeEntry()` + `signAuthorization()`，并接收当前 `rootEpoch`（`signOne()` 里 `requireRootEpoch()` 只算一次，同时用于授权与外层记录）。
- 删除 `signerForAuthorization()`。新规则：
  - **当前签名者是根钥** → 一律走共享助手 `buildRootReadmitAuthorization({ authorizationBytes, rootEpoch, rootKey })`，重新编码一份 `signer:'root'` / `credential_id:null` / 当前 `root_epoch` 的授权（uid / enroll_pk / exp / domain 原样）。原授权由哪把钥匙签的不再影响——当初用通行密钥授权、后来那把密钥丢了的成员，也能靠当前根密码重新确认。
  - **当前签名者是通行密钥** → 仅当原授权是 `passkey` 签且 `credential_id` 与当前这把**完全一致**时才走断言；否则抛 `READMIT_ROOT_REQUIRED`（文案：「这些成员记录只能用当前密码重新确认。」，正好点明修法）。原先「credential 不匹配时回落去请求原 credential」的行为已删除。
- 证书字节与 `cert_sig` 仍原样带回，`applyReadmitNode` 的 `certificate_mismatch` 约束不受影响，不存在换绑 node id / 节点密钥的口子。
- 依赖的共享助手 `buildRootReadmitAuthorization` 已由 G8 落地（`packages/shared/src/auth/readmit-node-record.ts:15`，同步返回、`RootKey.sign`），签名与约定一致，无需 commander 再调和。

### 3. i18n

三份源 locale JSON 各加一个键 `nodes.readmit.errors.READMIT_PENDING`（只动这一个嵌套键）：

- zh_CN：中继仍报告有成员未重新确认，请稍后重试。
- en_US：The relay still reports members awaiting re-affirmation. Try again later.
- ja_JP：リレーは再確認待ちのメンバーが残っていると報告しています。しばらくしてから再試行してください。

接入失败时经 `enrollErrorText()` → `nodes.readmit.failed` 包一层显示；手动入口经 `readmitErrorText()` 同表命中。

## 测试

`apps/fe/src/node/relay-enroll.test.ts`

- 给 `describe('enrollRelay')` 里四个会走到 `enroll` 的 mock 补上 `readmitPrepare`（新增模块级 `noStaleMembers`）——接入流程现在无条件问一次 prepare。
- `describe('接入时补签成员')` 重写，`enrollApi` 加了 `trace` 数组记录远端调用顺序，新增/改写 6 个用例：
  - 补签在换发令牌之前：`trace` 必须是 `['readmit-prepare','proof-material','enroll']`，记录顺序 `readmit-node` → `set-relays`。
  - 没有陈旧成员：prepare 回空表，只落一条 `set-relays`。
  - 补签失败（`KEY_LOG_FORK`）：`trace` 只有 `['readmit-prepare']`，**`enroll` 没被调用**，结论带 `readmit: { signed: 0, failed: 1 }`。
  - prepare 失败（`RELAY_NOT_CONFIGURED`）：同样不碰远端，一条记录都不签。
  - `enroll` 事后仍报 `readmitRequired: 2`：结论为 `READMIT_PENDING` + `readmit: { signed: 1, failed: 2 }`，`set-relays` 未提交。
  - 卡在补签这一步时 `afterEnroll`（刷新密封包）不跑。

`apps/fe/src/node/readmit-members.test.ts`

- 首个用例补断言：重签后的授权被重新编码到当前 epoch（`root_epoch: 4`、`signer:'root'`、`credential_id:null`），uid / enroll_pk 保持不变。
- 新增「当初用通行密钥授权的成员，可以用当前根密码重新确认」：断言那把 passkey 完全没被调用（`seen` 为空），产出的授权是 root-signed 且能用当前根公钥验签。
- 新增「换了一把通行密钥：报 ROOT_REQUIRED，不签记录」。
- 原有「根签的授权不能用通行密钥重签」「授权字节畸形报 MALFORMED」等用例保持通过。

## 验证命令与结果

```
cd apps/fe && bun test src/node src/pages/settings/nodes
  → 1055 pass / 0 fail，3277 expect()，58 文件

cd apps/fe && bunx tsc --noEmit -p .
  → exit 0（0 错误，与基线一致）

bunx biome check <本次改动的 8 个文件>
  → Checked 8 files，无错误

bun scripts/complexity/gate.ts
  → complexity gate ok（1486 文件 / 13394 函数），未新增 near-limit 项
```

## 遗留 / 需要注意

- 仓库根 `bun run lint`（`biome check .` + gate）当前**红**，但唯一报错是 `apps/gateway/src/hub/hub-authorization.test.ts` 的 format 问题（并行的 G8 作用域，非本任务文件）。gate 部分单独跑是绿的。
- i18n 生成物 `packages/shared/src/i18n/resources.ts` / `types.ts` 未重建，locale 一致性测试在 commander 跑 `bun run build:i18n` 之前不会看到新键。
- `READMIT_PENDING` 只在「本机补签跑完、中继仍报有陈旧成员」这种两边视图不一致的场景出现；如果后续把 R3 建议的 token 两阶段提交做掉，这条事后复核可以退化成告警。
