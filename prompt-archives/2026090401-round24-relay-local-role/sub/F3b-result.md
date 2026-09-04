# F3b 结果 — 网页侧密封包（sealed pack）刷新

## 结论

浏览器每次现场派生出根钥之后都会重封中继密封包并经 `POST /api/mesh/relay/pack` 转发：接入
（含迁移 / 追加 / 重新输入口令）、改密（`rotate-root-keep` 当场刷、`rotate-root` 记欠账）、
以及**所有经 `prompt.withSigner` 的根签动作**（离开 / 摘中继 / 换元数据密钥 / 吊销 / passkey /
TOTP）。通行密钥签的记录一律跳过（KEK 由根种子派生，断言给不出种子），hub 模式全程空转。

已按指挥官的补充要求实现**一台中继一块密封包**：`packs: [{ url, sealed_pack }]`。

## 改动文件

### 新增
- `apps/fe/src/node/relay-pack.ts` + `relay-pack.test.ts`
  - `refreshRelayPack({ rootSeed, api?, relayApi?, urls?, kdfParams?, rootEpoch? }) → Promise<boolean>`：
    `join-material` → `keylog/head` →（缺 kdf 参数时）`/api/auth/mode` → 逐台 `sealRelayPack` →
    `relayApi.uploadPack`。`logKey` / `token` / `sealed` 缓冲全部 `finally` 清零；根公钥由种子现算
    （`rootKeyFromSeed` 复制出的那份 seed 也清零）。**不抛异常**，失败只 `console.warn` 返回 `false`。
  - `refreshRelayPackForSigner(signer, { api?, relayApi? }) → 'skipped' | 'refreshed' | 'failed'`：
    根钥 + 中继模式两道门，同一把根钥用 `WeakSet` 去重（手动重试与 `withSigner` 钩子会先后拿到
    同一个 signer）。成功即销欠账；失败**不新记**欠账（网络抖动不该在页面上挂常驻告警）。
- `apps/fe/src/pages/settings/nodes/relay/use-relay-pending.ts`
  - 从 `use-relay-actions.ts` 拆出的 `useRelayPending`（`metaPending` / `retryMetaKey` /
    `packPending` / `retryPack`）。**拆分是复杂度门禁要求的**：不拆 `useRelayActions` 会到 167 行 > 120。

### 修改
- `packages/api-client/src/relay/tenant-api.ts`：新增 `RelayPackEntry` / `RelayPackUpload` /
  `RelayPackUploadResult` 与 `uploadPack()`（`POST /api/mesh/relay/pack`，新版 `packs[]` 体）。
- `apps/fe/src/node/relay-enroll.ts`：`RelayEnrollInput.afterEnroll?: (rootKey) => …`，在
  `set-relays` 落账之后、根钥 `finally` 清零之前调用。**刻意不在此 import `relay-pack`**：
  `relay-meta-key-pending → relay-enroll` 已存在，反向引入会成环。
- `apps/fe/src/node/relay-meta-key-pending.ts`：新增密封包欠账（`relayPackDebt` /
  `subscribeRelayPackDebt` / `rememberRelayPackDebt` / `forgetRelayPackDebt` /
  `clearRelayPackDebtForTest`，sessionStorage 键 `tmex.relay.packDebt`）。**只存一个布尔标记**，
  根种子一概不落存储，与元数据密钥欠账同一套 UX。
- `apps/fe/src/auth/credential-prompt.tsx`（= 本任务识别出的「签名者 / 凭据入口」）：
  `runWithChoice()` 在 `fn` 返回后调用 `refreshRelayPackForSigner(signer)`。这是 `withSigner`
  唯一的根钥出口，因此覆盖全部经它提交的根签记录。
- `apps/fe/src/auth/account-security-actions.ts`：`refreshPackAfterRotate()`——
  `rotate-root-keep` 用**新**种子 / 新 kdf 参数 / `nextRootEpoch` 当场重封，失败记欠账；
  `rotate-root`（全量重置 / reset-root）一落账全部会话即失效，直接记欠账、一个请求都不发。
- `apps/fe/src/pages/settings/nodes/relay/use-relay-actions.ts`：`submitEnroll` 传 `afterEnroll`；
  接入成功但密封包没刷上时记欠账 + 一条非阻断 warning toast（`relay.tenant.pack.staleWarning`）；
  `RelayActionsController` 现在 `extends RelayPendingController`。
- `apps/fe/src/pages/settings/nodes/relay/relay-dialogs.tsx`：新增 `RelayPackPendingNotice`
  （欠账告警行 + 重试按钮，`data-testid="nodes-relay-pack-pending"` / `-retry"`）。
- i18n `relay.tenant.pack.{pending,retry,done,retryFailed,needsPassword,staleWarning}`，
  zh_CN / en_US / ja_JP 三语同步，已跑 `bun run build:i18n`。

## 取舍与依据

- **toast 只在接入那一路出现**：任务要求「只在密封包从未上传过时提示」，但节点侧 `/status`
  与 `/pack` 都不下发 `packUploaded` / `packHeadSeq`，无从判断。接入 / 迁移 / 追加 / 重新输入
  口令之后那台中继上必然没有可用的密封包，等价于「从未上传」，故只在这一路提示；其余路径按
  任务要求「只记日志」（根轮换那一路另记欠账，因为中继侧 sidecar 会把旧包清空，那是确定性失效）。
- **passkey 路径跳过**：已在 `relay-pack.ts` 与 `credential-prompt.tsx` 注释里写明理由——KEK 需要
  根种子，断言给不出；密封包停在上一次的日志头，加入方仍能验过并追上后缀（与 `r3.` 同档保证）。
- **`prompt.request()` 那一路（admit / rename-node）没有钩子**：签名者被存进 5 分钟复用窗口，
  记录是在别处、稍后才追加的，钩子挂在 `request()` 上会在 append 之前就跑。如需覆盖，得在
  `enrollment-engine` / `use-node-rename-channel` 落账之后显式调 `refreshRelayPackForSigner`
  （那两个文件属 F3a，未动）。

## 测试

| 文件 | 新增用例 |
|---|---|
| `apps/fe/src/node/relay-pack.test.ts`（新） | 逐台密封（tenant/token/AAD 各绑各的、换台就开不出来）、AAD 绑 root_epoch、显式 kdf/epoch/中继子集优先、失败不抛；signer 钩子：中继模式刷+销账、passkey 跳过、hub 跳过、同一根钥只刷一次、失败不记账（9 例） |
| `apps/fe/src/node/relay-meta-key-pending.test.ts` | 欠账记/销与订阅通知、只落布尔标记（2 例） |
| `apps/fe/src/node/relay-enroll.test.ts` | `afterEnroll` 在记录落账后、根种子仍活时跑；接入失败不跑（2 例） |
| `apps/fe/src/auth/account-security-actions.test.ts` | 常规改密重封（对拍 rotate payload 里的新 kdf/新根公钥，用新种子 `openRelayPack` 开出令牌）、重封失败记欠账、全量重置只记欠账不发请求、hub 模式不发包（4 例，`mockRelayApi` 扩了 `join-material` / `pack`） |
| `packages/api-client/src/relay/tenant-api.test.ts` | `uploadPack` 路径与体、502 `RELAY_PACK_FORWARD_FAILED` 透传（2 例） |
| `apps/fe/src/pages/settings/nodes/relay/relay-ui.test.tsx` | `RelayPackPendingNotice` 空/有欠账两态（1 例，独立 `describe`，未动 F3a 的部分） |

`useRelayActions` / `useRelayPending` 本身没有直接用例：fe 仓库里没有 `renderHook` /
testing-library 基建（全仓 0 处引用），Hook 里只有 3 行胶水，机制由 `afterEnroll` 的合约用例覆盖。

## 验证

| 项 | 结果 |
|---|---|
| `bunx tsc --noEmit -p apps/fe` | 1 error（见下「需要指挥官处理」第 1 条，非我文件） |
| `bunx tsc --noEmit -p packages/api-client` | 5（= 基线，均在既有 `client.test.ts` / `files-download.test.ts`） |
| `bunx tsc --noEmit -p packages/shared` | 0 |
| `bun test src/`（apps/fe） | 2029 pass / 0 fail（基线 1976，+18 本任务 +其它 agent） |
| `bun test`（packages/api-client） | 208 pass / 0 fail（基线 206） |
| `bun test`（packages/shared） | 646 pass / 0 fail |
| `bunx biome check`（本任务全部文件 + 三份 locale） | 通过 |
| `bun run scripts/complexity/gate.ts` | 本任务 0 violation（唯一剩余 violation 是 `setup/join-relay-form.tsx:35 JoinRelayForm 184 行`，F3a 的文件） |

## 需要指挥官处理

### 1.（必须）`apps/fe/src/pages/settings/nodes/uplink/local-uplink-tabs.test.tsx` 的控制器桩

`RelayActionsController` 多了 `packPending` / `retryPack`，该文件第 64 行的 `IDLE_ACTIONS`
少这两项，`tsc -p apps/fe` 报 1 个 TS2739。`uplink/**` 是 F3a 的独占目录，按规则未动。
补丁（`retryMetaKey` 之后加两行，与 `relay-uplink-panel.test.tsx` 已经补好的那份一致）：

```ts
  retryMetaKey: () => Promise.resolve(),
  packPending: false,
  retryPack: () => Promise.resolve(),
```

`relay-uplink-panel.test.tsx` 在我改动期间已被另一 agent 补齐，无需再动。

### 2.（必须）把欠账告警挂进中继面板

`RelayPackPendingNotice` 已写好但没有挂载点（`uplink/**` 属 F3a）。在
`apps/fe/src/pages/settings/nodes/uplink/relay-uplink-panel.tsx` 里 `actions.metaPending` 那段
告警之后加一行即可：

```tsx
<RelayPackPendingNotice actions={actions} />
```

并从 `../relay/relay-dialogs` import。不挂载的话，根轮换之后的欠账用户看不见（欠账本身已落
sessionStorage 并会在下一次根签动作成功时自动销账，只是没有「立刻重试」的入口）。

### 3. 与 G6 的接口对齐

- 已按补充要求发新体 `{ packs: [{ url, sealed_pack }], kdf_params, root_epoch, head_seq }`，
  不再发 `sealed_pack` / `urls`。请确认 G6 的 `POST /api/mesh/relay/pack` 已落这个形状。
- `refreshRelayPack` 逐台密封的前提是 **`GET /api/mesh/relay/join-material` 返回全部中继**
  （每条带自己的 `tenantId` / `token`）。当前 `relay-routes.ts` 的 `joinMaterial()` 只返回
  **当前 attach 的那一台**（那是 `r3.` 加入码的正确语义）。多中继场景下密封包只会刷到 attach
  的那台，别的中继上仍是旧包。若要覆盖全部中继，需要 G6 让 `join-material`（或新开一个
  `/pack-material`）下发全部中继的租户凭据——前端已经按数组处理，无需再改。
- `packages/app/src/lib/relay-pack-upload.ts`（CLI）与 `docs/relay/2026090304-relay-role.md`
  §5b 的请求体示例仍是旧的单包形状，需要随 G6 一起更新（不在本任务 scope）。

### 4. 已知覆盖缺口

`prompt.request()` 复用窗口那一路（admit 新节点、rename-node）不会刷新密封包，理由见上文
「取舍与依据」。补的话在各自落账处调 `refreshRelayPackForSigner(signer)` 即可（那两处属 F3a）。
不补也不致命：密封包只会停在旧日志头，加入方仍验得过并会追上后缀。
