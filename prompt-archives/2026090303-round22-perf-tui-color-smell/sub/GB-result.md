# GB 结果：B4 IP 判定收编 + 层次倒挂修正

## 结论

四处独立的私网 / 回环 / 字面量解析已收进 `apps/gateway/src/mesh/address-class.ts`。`mesh/client-ip.ts` 不再从 `db/local-auth-settings.ts` 取 IP 谓词。各调用方的分类语义按原拷贝逐条保留，没有静默放宽或收紧。

## 改动文件

| 文件 | 动作 |
|---|---|
| `apps/gateway/src/mesh/address-class.ts` | 成为唯一实现：共享剥括号/zone、IPv4 dotted 正则、mapped dotted/hex 解包、`isIpv6Literal` / `looksLikeIpv6` / `isIpAddressLiteral` / `isLoopbackHostLiteral` / `isLoopbackClientIp` / `parseIpLiteral` |
| `apps/gateway/src/mesh/address-class.test.ts` | 尽表驱动单测（每调用方语义 + 字面量形态） |
| `apps/gateway/src/mesh/client-ip.ts` | 改 import `isLoopbackClientIp`、`parseIpLiteral`；删除私有 `IPV4_RE` / `isIpv6` / `parseIpLiteral` |
| `apps/gateway/src/mesh/client-ip.test.ts` | 补 zone / 前导零 / 误带端口 |
| `apps/gateway/src/mesh/domain-access-policy.ts` | 改 import 统一谓词；删除私有 `IPV4_RE` / `looksLikeIpv6` / `isLoopbackHostname` |
| `apps/gateway/src/mesh/domain-access-policy.test.ts` | 补 hex mapped / zone / 误带端口 |
| `apps/gateway/src/db/local-auth-settings.ts` | 删除私有回环解析；`export { isLoopbackClientIp } from '../mesh/address-class'`（兼容既有测试与未改文件） |
| `apps/gateway/src/db/local-auth-settings.test.ts` | 既有断言保留；补括号/zone/前导零/hex mapped/误带端口 |

未改 `mesh/client-source.ts`（不在本任务文件清单）。它仍从 `db/local-auth-settings` 再导出 `isLoopbackClientIp`，实现已不在 db 层。`mesh/mesh-http.ts`、`mesh/auth-routes.ts` 对 `local-auth-settings` 的 import 是 store/类型，与 IP 判定无关。

## 收编前四份行为对照（必须按调用方保留）

| 能力 | `address-class` `classifyRemoteAddress` | `local-auth` `isLoopbackClientIp` | `domain-access` `isLocalClientSource` / `isLoopbackHostLiteral` | `client-ip` `parseIpLiteral` |
|---|---|---|---|---|
| 缺失 `null`/`undefined`/`''` | wan | **true**（缺 IP 当本机） | `isLocalClientSource` false | undefined |
| `'local'`（精确小写） | wan | **true** | false | undefined |
| `'LOCAL'` | wan | **false**（特判大小写敏感） | false | undefined |
| `'localhost'` / 大小写 / `[localhost]` | lan | true | `isLocalName` true；字面量谓词 false | undefined（不是 IP） |
| `127/8` dotted | lan | true | `isLoopbackHostLiteral` true（须过 IPV4_DOTTED_RE） | 原样返回 |
| `127.000.000.001` 前导零 | **lan**（`parseIpv4` 允许） | **true** | `isLoopbackHostLiteral` **false** | **undefined** |
| `::1` / `[::1]` / `%lo0` | lan | true | true（仅精确 `::1`，剥装饰后） | 小写返回 |
| `0:0:0:0:0:0:0:1` 展开回环 | **lan** | **false** | **false** | 小写返回（合法 v6） |
| dotted mapped `::ffff:127.0.0.1` | lan | true | true | 小写返回 |
| hex mapped `::ffff:7f00:1` | **lan**（hex 解包） | **false**（只认 dotted mapped） | **false** | 小写返回（当 v6） |
| `::ffff:127.999.1.1` 非法 octet | wan | false | `isLoopbackHostLiteral` **true**（只看第一段 127）；`looksLikeIpv6` true；`parseIpLiteral` undefined | undefined |
| RFC1918 / 链路本地 / ULA | lan | false | `isLocalClientSource` true | 合法则返回 |
| CGNAT `100.64/10`（含 mapped） | **wan** | false | `isLocalClientSource` **true**（`isCgnatIpv4`） | 合法则返回 |
| site-local `fec0::/10` | wan | false | false | 合法则返回 |
| 括号、`%en0` zone | 剥掉再判 | 剥掉再判 | `normalizeHost` 先剥再判 | 剥掉再返回 |
| 误带端口 `127.0.0.1:8080` | wan | false | 裸谓词 false（`isLocalName` 会先拆端口） | undefined |
| 空/垃圾 / `peer:` | wan | `peer:` false | false | undefined |
| IPv6 压缩 `1:2:3:4:5:6:7:8::`（missing=0） | wan（`parseIpv6Words` 接受） | false | `isIpAddressLiteral` false | undefined（`isIpv6Literal` 要求省略 ≥1 组） |

`isIpv4DottedLiteral` 用 `25[0-5]|…|[1-9]?\d`，拒绝前导零；`parseIpv4` / `isLoopbackIpv4` 用 `/^\d{1,3}$/` + 0–255，允许前导零。两套并存，分别服务「转发头字面量校验」与「对端分类 / 本机回环」。

## 层次

- `mesh/client-ip.ts` → `mesh/address-class.ts`（不再 → `db/local-auth-settings`）
- `mesh/domain-access-policy.ts` → `mesh/address-class.ts`（原已有 `classifyRemoteAddress` / `isCgnatIpv4`）
- `db/local-auth-settings.ts` → `mesh/address-class.ts`（再导出 `isLoopbackClientIp`）
- `mesh/client-source.ts` 仍写 `from '../db/local-auth-settings'`，因文件占用限制未改；运行时拿到的是同一实现。`client-source.test.ts` 17 pass。

## 测量

| 项 | 改前 | 改后 |
|---|---|---|
| `bunx tsc --noEmit -p .`（`apps/gateway`） | 0 | 0 |
| `bun test src/mesh src/db` | 995 pass / 0 fail / 88 files | 拥有文件 263 pass / 0 fail。全量目录 1169 tests（+174，尽表）；并行 B13 缺 `drizzle/0039_sturdy_toro.sql` 导致 74 fail（PeerManager / auth-routes 迁移），**无一落在本任务四模块** |
| biome（8 个改动文件） | — | ok |
| complexity gate | 改前 ok | 本任务文件无违规。全仓当时报 `uplink-server.ts:handleKeyLogAppend` 122 行（并行任务，未改） |

`address-class.ts` 351→448 行（低于 900）。新增谓词 CC 均在默认阈值内。

## 未做

- 未改 `mesh/client-source.ts` 的 import 路径（不在 Files you own）。
- 未把 `isLoopbackClientIp` 的缺 IP fail-open 改成 fail-closed——那是第二十轮本机 bootstrap 契约，测试钉死 `null`/`''`/`local` → true。
- 全量 `src/mesh src/db` 被并行 B13 的缺失 migration 打断；本任务验收以四模块 + `client-source` 单测与 tsc/biome 为准。
