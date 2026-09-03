# GE / B9 结果：TOTP rewrap + base32 收编

## 做了什么

把两端逐字重复的 RFC 4648 base32 收到 `packages/shared/src/auth/encoding.ts`（`encodeBase32` / `decodeBase32`，无 padding，算法与原 FE/CLI 副本一致）。FE `totp-uri.ts` 与 CLI `totp-uri.ts` 改为 import 共享实现，并保留原导出名（FE：`base32Encode`/`base32Decode`；CLI：`encodeBase32`）。

把「旧 seed 解密 → 新 seed / epoch+1 再加密」的纯核心抽到 `packages/shared/src/auth/rewrap-totp.ts`（只走 WebCrypto + 现有 `deriveTotpKey` / `encryptTotpSecret` / `decryptTotpSecret`）。两侧调用方只留取数/空值分支：

- FE `rewrapTotpSecret`：仍只认 404+`TOTP_NOT_ENABLED` 为 null，其余错误抛 `Error(code)`。
- CLI `rewrapTotpForKeep`：`totpRecordSeq == null || !totp` 仍返回 null。

未改 wire/存储格式、salt、Argon2 迭代、AAD 结构、HKDF 参数。测试锁定了 `TOTP_SALT_PREFIX`、`A256GCM`、nonce=12/tag=16、AAD borsh 字节、HKDF 向量，并用生产 `decryptTotpSecret` 做 round-trip / 错旧钥拒绝。

## 文件

| 路径 | 动作 |
|---|---|
| `packages/shared/src/auth/encoding.ts` | 加入 encode/decodeBase32 |
| `packages/shared/src/auth/encoding.test.ts` | RFC 4648 向量 + padding/大小写/非法字符 |
| `packages/shared/src/auth/rewrap-totp.ts` | **新建**纯核心 |
| `packages/shared/src/auth/rewrap-totp.test.ts` | **新建**参数锁定 + round-trip + 错钥 |
| `packages/shared/src/auth/index.ts` | barrel 再导出（见下） |
| `packages/shared/src/auth/index.test.ts` | barrel 导出断言 |
| `apps/fe/src/auth/totp-uri.ts` | 改为 import shared |
| `apps/fe/src/auth/account-security-actions.ts` | 取数后调 shared rewrap |
| `packages/app/src/lib/totp-uri.ts` | 改为 import shared |
| `packages/app/src/lib/totp-uri.test.ts` | **新建** RFC 4648 + otpauth URI |
| `packages/app/src/lib/hub-user-passwd.ts` | 空值判断后调 shared rewrap |

**清单外文件**：`packages/shared/src/auth/index.ts`（及对应 `index.test.ts`）。FE 生产代码一律从 `@tmex/shared/auth` 取编码原语，package.json 没有 `./auth/encoding` 子路径；不改 barrel 则 FE 无法 import `encodeBase32`/`rewrapTotpSecret`。只追加了 4 个符号的再导出，未改其它导出。

## 测量

| 包 | 测试 before → after | tsc before → after |
|---|---|---|
| `packages/shared` `src/auth` | 114 → **119**（+5） | 0 → 0 |
| `packages/app` `src/lib` | 329 → **333**（+4） | 1 → 1（原有 `TS2688` node types） |
| `apps/fe` `src/auth` | 156 → **156** | 0 → 0 |

`bunx biome check` 上述改动文件：通过。

`bun scripts/complexity/gate.ts`：当前 **失败**，违规在并行任务 F9 的 `packages/panels/src/settings/integration-account-form-modal.tsx:219 IntegrationAccountFormModal: 127 lines > 120`。B9 自身文件均远低于门禁（`encoding.ts` 527 行、`rewrap-totp.ts` 43 行）。未改 allowlist、未改该 F9 文件。

## 未能做的

complexity gate 全仓绿灯被 F9 挡住；B9 无法在不越权改 F9 文件的前提下把 gate 拉绿。
