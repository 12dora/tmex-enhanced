# T3 结果：字节 / 带宽格式化

## 背景

本机卡片「连接详情」里带宽一档摆出 `237.51937984496124 B/s / 不限`，两个毛病叠在一起：

1. `formatBytes` 在 1 KB 以下直接把原值塞进模板（只有 KB 以上的分支收小数位），而中继指标磁贴那边靠一个私有的 `formatBytesPerSec` 补收两位——同一个数在两处摆成两副样子。
2. `nodes.machine.details.quotaValue = "{{used}} / {{total}}"`，`total` 是「不限」时和 `/s` 后缀撞成两道斜杠。

## 改动

### A. 新增 `packages/shared/src/format-bytes.ts`

`formatBytes` / `formatRate` / `formatBytesPair` 三个纯函数，实现从 `packages/api-client/src/format.ts` 搬来。唯一的行为变化：**先收两位小数再分档**

```ts
const rounded = Math.round(n * 100) / 100;
if (rounded < 1024) return `${rounded} B`;
```

先收再分档（而不是只在 `< 1024` 分支里收）是为了保住 `1023.999 → "1.00 KB"`：收完两位已经够 1 KB，就该进上一档。原 `formatBytesPerSec` 正是这个次序，现有测试也这么断言。

- `237.51937984496124 → "237.52 B"`、`512.3456 → "512.35 B"`、`0.004 → "0 B"`、`0.006 → "0.01 B"`、整数不变；
- 非有限值与负数一律 `"0 B"`（速率是差分算的，跨采样重启会变负）；
- `formatBytesPair(used, total)` = `` `${formatBytes(used)} / ${formatBytes(total)}` ``。

在 `packages/shared/src/index.ts` 紧挨 `format-date` 处导出；`packages/shared/src/index.test.ts` 的运行时导出快照补 `formatBytes` / `formatBytesPair` / `formatRate` 三项。

新增 `packages/shared/src/format-bytes.test.ts`：13 个断言块 / 6 个 test，含从 `relay-format.test.ts` 迁来的全部 `formatBytesPerSec` 用例。

### B. `packages/api-client/src/format.ts` 收成转发

改成 `export { formatBytes, formatBytesPair, formatRate } from '@tmex/shared';`。`packages/api-client/package.json` 已有 `"@tmex/shared": "workspace:*"`，无需新增依赖；该包本来就有多处从 `@tmex/shared` 主入口做运行时 import，不引入新的 bundle 面。

### C. 删掉 `formatBytesPerSec`

`apps/fe/src/pages/settings/relay/relay-format.ts` 里那份补丁函数整段删除（`formatRate` 也随之从该文件的 import 里去掉），三个调用方改用 `formatRate`：

- `relay-metrics-tiles.tsx`（5 处调用，import 并到已有的 `@tmex/api-client/format` 那行）
- `relay-metrics-members.tsx`（2 处）
- `relay-metrics-trends.tsx`（1 处，作为 `TrendChart` 的 `format` 传参）

`relay-format.test.ts` 里的 `formatBytesPerSec` describe 整块删除（已迁到 shared）。

### D. 新 i18n key + 「不限」文案

三个 locale 各加一个 key（locales 目录下只有 `zh_CN` / `en_US` / `ja_JP` 三种）：

| key | zh_CN | en_US | ja_JP |
|---|---|---|---|
| `nodes.machine.details.quotaUnlimitedValue` | `{{used}}（不限）` | `{{used}} (Unlimited)` | `{{used}}（無制限）` |

`apps/fe/src/pages/settings/nodes/connection-details.tsx` 里把 `QuotaValue` 的三元拆成独立的 `quotaValueText(t, row)`：无用量 → 只出上限词（不变）；无上限但有用量 → `quotaUnlimitedValue`；其余 → `quotaValue`。进度条逻辑原样保留。

### E. `formatBytesPair` 替掉硬编码

5 处 `` `${formatBytes(n)} / ${formatBytes(total)}` `` 全部换成 `formatBytesPair`：`packages/api-client/src/upload-transfer.ts`（1）、`download-transfer.ts`（2）、`packages/panels/src/files/bulk-transfer.ts`（2）。

### F. en_US `relay.metrics.tiles.memoryHeapSub`

`heap {{heap}} of {{total}}` → `heap {{heap}} / {{total}}`，与 zh / ja 的分隔符对齐。

### G. 全前端扫「可能带三位以上小数的可见数字」

扫了 `apps/fe`、`packages/ui`、`packages/panels`、`packages/stores`、`packages/api-client`（`packages/app` 按要求不碰）：`toFixed(3+)`、`toFixed(` 全量、`* 100`、`/ 1024`、`/ 1000`、`rttMs` / `latencyMs` / `perSec` 的直接插值。

**结论：除 `formatBytes` 本身外没有别的漏网点。** 逐条核过：

- `relay-format.ts` 剩下的 `formatFramesPerSec` / `formatMs` / `formatPercent` 都是 `toFixed(0|1)`；
- `relay-quota.ts:35` 的 `percent` 是浮点，但只喂给 `<Progress value>`，不上屏；
- `relay-rows.tsx:165` 的 `t('relay.tenant.strip.rtt', { ms: relay.rttMs })` 看着是裸插值，但网关侧 `relay-uplink-heartbeat.ts:48` 用 `scheduler.now()`（`ctl.ts:51` 即 `Date.now()`）作差，`peer-manager.ts:1543` 也 `Math.round` 过，一路都是整数，不动；
- `device-node-badges.tsx:73` 已经 `Math.round`；
- `packages/ui/src/components/sparkline.tsx:91` 已收两位；
- `code-viewer.tsx:45` 的 `toFixed(1)` 是 CSS 长度，不是可见文本；
- `*.bench.*` 里的 `toFixed(3)` 是控制台基准输出，不上屏。

### H. 补测

- `relay-ui.test.tsx`：新增「带宽用量是浮点时最多两位小数」——`bytesInPerSec: 237.51937984496124` → `usedText === '237.52 B/s'`。
- `connection-details.test.tsx`：新增 fixture `RELAY_UNLIMITED_BANDWIDTH`（`bandwidthBytesPerSec: null` + 有 `usage`）与用例「带宽不限又有用量：走「不限」那条合并文案，不套 used / total」，断言出现 `quotaUnlimitedValue`、带宽那格之后不出现 `quotaValue`、且不摆进度条。

## 文件清单

新增：
- `/Users/konata/code/tmex-r28/packages/shared/src/format-bytes.ts`
- `/Users/konata/code/tmex-r28/packages/shared/src/format-bytes.test.ts`

修改：
- `/Users/konata/code/tmex-r28/packages/shared/src/index.ts`
- `/Users/konata/code/tmex-r28/packages/shared/src/index.test.ts`
- `/Users/konata/code/tmex-r28/packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`
- `/Users/konata/code/tmex-r28/packages/api-client/src/format.ts`
- `/Users/konata/code/tmex-r28/packages/api-client/src/upload-transfer.ts`
- `/Users/konata/code/tmex-r28/packages/api-client/src/download-transfer.ts`
- `/Users/konata/code/tmex-r28/packages/panels/src/files/bulk-transfer.ts`
- `/Users/konata/code/tmex-r28/apps/fe/src/pages/settings/relay/relay-format.ts`
- `/Users/konata/code/tmex-r28/apps/fe/src/pages/settings/relay/relay-format.test.ts`
- `/Users/konata/code/tmex-r28/apps/fe/src/pages/settings/relay/relay-metrics-tiles.tsx`
- `/Users/konata/code/tmex-r28/apps/fe/src/pages/settings/relay/relay-metrics-members.tsx`
- `/Users/konata/code/tmex-r28/apps/fe/src/pages/settings/relay/relay-metrics-trends.tsx`
- `/Users/konata/code/tmex-r28/apps/fe/src/pages/settings/nodes/connection-details.tsx`
- `/Users/konata/code/tmex-r28/apps/fe/src/pages/settings/nodes/connection-details.test.tsx`
- `/Users/konata/code/tmex-r28/apps/fe/src/pages/settings/nodes/relay/relay-ui.test.tsx`

生成物（`bun run build:i18n` 重建，未手改）：`packages/shared/src/i18n/{resources.ts,types.ts}`、`packages/shared/src/i18n/locales/generated/*.rest.json`。

> 注：`bun run build:i18n` 会把同一 worktree 里 T1 / T2 的 locale 改动一并带进生成物，这是预期行为。

## 验收

| 项 | 结果 |
|---|---|
| `packages/shared` `bun test` | 697 pass / 0 fail（68 文件） |
| `packages/api-client` `bun test` | 222 pass / 0 fail（20 文件） |
| `packages/panels` `bun test` | 937 pass / 0 fail（87 文件） |
| `packages/ui` `bun test` | 414 pass / 0 fail（15 文件） |
| `apps/fe` `bun test src/` | 2410 pass / 0 fail（135 文件） |
| `bunx tsc --noEmit -p` × 5（shared / api-client / panels / ui / fe） | 全部无输出 |
| `bunx biome check`（19 个改动文件） | Checked 19 files. No fixes applied. |

未跑 `apps/gateway`：本次改动不触及网关侧代码。
