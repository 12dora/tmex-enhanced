# EX2 前端流量/配额数字渲染审计（Opus 探索报告摘要）

## 结论

`1KB/s/不限` 是两个独立缺陷叠加：

1. **小数失控**：本机卡片配额行走 `formatRate`（`packages/api-client/src/format.ts:17` → `formatBytes`，`n < 1024` 分支 `${n} B` 原值直出），中继指标磁贴走 `apps/fe/src/pages/settings/relay/relay-format.ts:108` `formatBytesPerSec`（先 `Math.round(v*100)/100`）。数据源 `apps/gateway/src/relay/relay-metrics.ts:190` `perSec()` 是浮点。
2. **双斜杠**：`nodes.machine.details.quotaValue = "{{used}} / {{total}}"`（zh_CN.json:2037 等三语），无上限时 `total`=「不限」，与 `/s` 撞车。

## 格式化函数清单

| 位置 | 函数 | 小数 |
|---|---|---|
| `packages/api-client/src/format.ts:3` | `formatBytes` | B 档无上限；KB+ 0/1/2 位 |
| `packages/api-client/src/format.ts:17` | `formatRate` | 同上 + `/s` |
| `apps/fe/.../relay/relay-format.ts:108` | `formatBytesPerSec` | 2 位（补丁） |
| `apps/fe/.../relay/relay-format.ts:51/56/60/91` | `bandwidthText` / `bytesToKb` / `kbToBytes` / `trafficText` | 整数 KB 或同 formatBytes |
| `packages/app/src/commands/relay-shared.ts:196/207` | CLI `formatBytes`/`formatQuota` | KiB 单位表、1 位，无守卫；`packages/app` 无 workspace 依赖，不动 |
| `apps/fe/.../relay/relay-format.ts:114–153` | `formatFramesPerSec`/`formatDuration`/`formatMs`/`formatPercent`/`median` | 已收敛 |

全仓 `Intl.NumberFormat` 零命中；`packages/stores` 无格式化；`packages/shared` 只有 `format-date.ts`。

## used/limit 渲染点

- 本机卡片：`apps/fe/src/pages/settings/nodes/relay/relay-quota.ts:38–70`（`:68` `formatRate(bandwidth)` 缺收敛，`:70` `limitKey: quotaUnlimited`）；渲染 `apps/fe/src/pages/settings/nodes/connection-details.tsx:98–112` `QuotaValue`。
- 租户表 `relay/tenant-table.tsx:156` `nodesValue "{{online}} / {{total}}"`；内存磁贴 `relay-metrics-tiles.tsx:243` `memoryHeapSub`（en 用 `of`，zh/ja 用 `/`，不一致）；租户配额摘要 `relay-format.ts:78` 用 `relay.admin.quota.unlimitedValue` 单独占位（好范例）。
- 硬编码 `${formatBytes(n)} / ${formatBytes(total)}` 5 处：`packages/api-client/src/upload-transfer.ts:24`、`download-transfer.ts:57/75`、`packages/panels/src/files/bulk-transfer.ts:150/277`。

## 归宿

`packages/shared/src/format-bytes.ts`（与 `format-date.ts` 并列，从 `index.ts` 导出）；`packages/api-client/src/format.ts` 改薄壳 re-export；不放 `packages/ui`（会成环）。

## 显示约定

推荐 `1.2 KB/s（不限）`——文案规范第 31 条「限定条件放括号」，仓库先例 `files.transfer.tooLarge`。三语：zh `"{{used}}（不限）"` / en `"{{used}} (Unlimited)"` / ja `"{{used}}（無制限）"`。无用量分支仍只出「不限」。

## 现有测试

`relay-format.test.ts:132–149`（formatBytesPerSec）、`relay-ui.test.tsx:191–262`（relayQuotaRows）、`connection-details.test.tsx:101–152`、`relay-admin.test.ts:98`（CLI）；`packages/api-client/src/format.ts` 无单测（漏洞根源）。Playwright 无配额文案断言。

## 改动清单

A 新建 shared `format-bytes.ts`（B 档 2 位收敛）+ 导出 + 测试；B api-client 薄壳；C 删 `formatBytesPerSec` 改调用点（tiles/members/trends）；D 新 key `quotaUnlimitedValue` + `QuotaValue` 三分支；E 5 处硬编码改 `formatBytesPair`；F en `memoryHeapSub` 对齐；G 补测试。
