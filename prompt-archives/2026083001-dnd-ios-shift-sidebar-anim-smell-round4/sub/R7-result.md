# R7 结果：packages/app TLS/ACME service 瘦身

## 文件变更

| 文件 | 摘要 |
|------|------|
| `packages/app/src/tls/acme-service.ts` | `issue` 按 ACME 阶段拆成 `openAccount` / `createChallenge` / `removeChallenge` / `cleanupChallenges`；压缩 TXT 轮询与 backoff；去掉无外部引用的 `export`；删除从未使用的 `AcmeIssueInput.fetch` |
| `packages/app/src/tls/tls-service.ts` | 抽出 `stopTls` / `reissueSelfSigned` / `runIfJob` / `applyListenerOrFail`；合并 `tls_failed` 包装与 listener 失败路径；`AcmeRunReason` 去 export |
| `packages/app/src/tls/*.test.ts` | 未改（既有测试即契约） |

## `git diff --stat`

```
 packages/app/src/tls/acme-service.ts | 408 +++++++++++++++++------------------
 packages/app/src/tls/tls-service.ts  | 262 ++++++++++------------
 2 files changed, 306 insertions(+), 364 deletions(-)
```

numstat：acme-service +196/−212（−16），tls-service +110/−152（−42）。合计 **净 −58**。目标 −40 已达到。

## 行数（`wc -l`）

| 文件 / 函数 | 改前 | 改后 | Δ |
|-------------|------|------|---|
| `acme-service.ts` | 500 | 484 | **−16** |
| `tls-service.ts` | 682 | 640 | **−42** |
| **合计** | **1182** | **1124** | **−58** |
| `issue` | ~161 / CC22 | **52 行** / CC≈5 | 低于 80 / 15 |
| `applyModeLocked` | ~94 / CC16 | **70 行** | 未再拆 per-mode（会更长） |
| `doRunAcme` | ~104 / CC15 | **92 行** | 守卫/bind 失败抽到 `runIfJob` + `applyListenerOrFail` |

## 做了什么

1. **`issue` 按阶段拆分**（`client.auto` 仍负责 order/poll/finalize；回调与收尾拆出）：
   - `openAccount`：目录 URL、account reuse、`createAccount`
   - `createChallenge`：http-01 写入 / dns-01 TXT + `waitForTxt`
   - `removeChallenge`：http-01 clear / dns-01 `deleteRecord`
   - `cleanupChallenges`：outer `finally` 里清剩余 DNS + HTTP token
   - 日志与测试断言的错误串全部保留（`acme issuance is missing…`、`cloudflare token required for dns-01`、`unsupported acme challenge`、`dns-01 cleanup failed`、`acme dns-01 cleanup failed for`、`acme dns-01 nameserver lookup failed…`、`acme dns-01 challengeRemoveFn failed for`、`acme auto returned an empty certificate`、`acme issuance aborted`）。
   - 轮询/backoff 常量未改：`ACME_RENEW_LEAD_MS`、`RENEWAL_*`、`DNS_PROPAGATION_*`、`RESOLVE_ATTEMPT_TIMEOUT_MS`。
2. **`tls-service` 去重**：
   - none/external 共用 `stopTls`（upsert + `scheduler.stop` + `listener.apply(null)`）。
   - apply/renew 的 selfsigned 共用 `reissueSelfSigned`（issue → apply → `throwIfBindFailed`；`TlsApiError` 原样抛，其它包 `tls_failed`）。
   - **external 的 env 失败仍一律新建 `tls_failed`**（不走 `asTlsFailed` 的 rethrow，避免改变 code）。
   - ACME 四段 mutex+`jobStillValid` 收成 `runIfJob`；两处 bind 失败收成 `applyListenerOrFail`。
3. **死导出**（`rg` 全仓无文件外 importer）：`AcmeClientFactory`、`DOH_ENDPOINT`、`defaultResolveTxt`、`RenewalSchedulerOptions`、`AcmeRunReason`。仍导出：`issue`、`waitForTxt`、`acmeDirectoryUrl`、`RenewalScheduler`、常量、`AcmeClientLike`（测试用）、`AcmeIssueInput` / `AcmeIssuedMaterial`。
4. **死字段**：`issue()` 里的 `void input.fetch` 与 `AcmeIssueInput.fetch` 从未接入 DoH/`client.auto`，已删；`TlsServiceOptions.fetch` 仍只给 `CloudflareDnsClient`。

## 测试 / tsc / biome

**开始前：**

- `cd packages/app && bun test src/tls`：33 pass / 0 fail
- `cd packages/app && bun test`：409 pass / 1 fail（既有 `cpu-features stub plugin`）
- `bunx tsc --noEmit -p .`：1 个 `error TS2688`（`Cannot find type definition file for 'node'`）

**结束后：**

- `bunx biome check packages/app/src/tls/acme-service.ts packages/app/src/tls/tls-service.ts`：clean
- `bun test src/tls`：**33 pass / 0 fail**
- `cd packages/app && bun test`：**409 pass / 1 fail**（仍是 `cpu-features stub plugin`）
- tsc：仍 1 个 `error TS2688`（未增加）

## 修过的 bug

无。未改 wire format、错误码/文案、ACME 清理顺序（`challengeRemoveFn` 先于 outer `finally`）、`nextRenewAt` 计算、account-directory 切换时清空 URL。

## 刻意跳过

- **`applyModeLocked` 拆成 per-mode 函数**：指令写明 only if shorter；四个分支体差异大，拆出去净增签名行。只抽了 none/external 与 selfsigned 的共享序列。
- **`doRunAcme` 的 cert upsert 再抽 `persistIssued`**：只是搬迁 14 行对象字面量，净行数不降。
- **未改测试文件**：契约已在 `acme-service.test.ts` / `tls-service.test.ts`（http-01/dns-01、cleanup warning、directory 切换、stale discard、bind 失败不重签、backoff `nextRenewAt`）。
- **`defaultResolveTxt` 的 DoH → 权威 NS → 系统解析器链**：有依据的兼容 fallback，保留吞错与注释。
- **未动** 版本号、CHANGELOG、前几轮保留热点（本文件不含那些符号）。
