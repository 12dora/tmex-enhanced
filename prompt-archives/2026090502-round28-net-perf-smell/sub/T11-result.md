# T11 结果：D6 滑动窗口限流器合并 + D2 拨号失败分类器合并

## 一、D6 滑动窗口限流器 → `apps/gateway/src/lib/sliding-window.ts`

新增 `SlidingWindowCounter`（100 行）：`hit(key, now?)` / `count(key, now?)` / `release(key)` / `reset(key)` / `clear()` / `sweep(now?)` / `size`，构造选项 `{ windowMs, now?, maxKeys?, evict? }`。

`evict` 两档，对应原来两种截然不同的驱逐策略：

- `'expired-only'`：超出 `maxKeys` 时只回收「窗口已过期」的桶，仍在窗口内或已触达上限的桶永不被挤掉（`HubEnrollLimiter`、`RelayEnrollLimiter` 用；两处各留了一行注释说明为什么不能挤活桶）。
- `'oldest'`：先回收过期桶，仍超限则按「最早一次命中的时间戳」逐个驱逐，同刻并列时按插入序（`LoginFailureLimiter`、`peer-server` 用）。

`release()` 是为 `HubEnrollLimiter.tryReserveSuccess` / `releaseSuccess` 的预留-回滚语义加的（弹出最后一次命中，桶空则删键）。

### 五处改写为薄封装

| 文件 | 类 | 行数 | 保留在封装层的东西 |
| --- | --- | --- | --- |
| `mesh/auth-login-limiter.ts` | `LoginFailureLimiter` | 80 → 53 | `uid:`/`ip:` 双桶、`recordCount % pruneEvery` 触发的周期性 sweep |
| `hub/hub-enroll-limiter.ts` | `HubEnrollLimiter` | 157 → 105 | 失败/成功两个窗口（60 s / 1 h）、`tryReserveSuccess`+`releaseSuccess`、**两桶共用一份 maxKeys 预算**的合并驱逐判定 |
| `relay/relay-enroll-limiter.ts` | `RelayEnrollLimiter` + `RelayEnrollCreateRate` | 110 → 84 | IP/租户双桶、位置参数签名 `(now, limit, windowMs, maxKeys)`、`reset`/`clear`/`sweep` |
| `mesh/peer-server.ts` | `SlidingWindowLimiter` | 205 → 183 | `lastSweep` 时间触发 + 超 `maxKeys` 触发的 sweep 条件 |

「何时 sweep」的策略（计数触发 / 时间触发 / 显式调用）各不相同，全部留在封装层，共享计数器只负责存储、剪枝和驱逐 —— 这样五处的可观察行为逐条保持不变，共享层也不用堆一堆互斥选项。

`hub/uplink-rate-limit.ts`（令牌桶）按要求未动。

### 行为等价性说明（两处刻意的收敛）

1. `LoginFailureLimiter` 原来的驱逐是 `failures.keys().next().value`（纯插入序）且驱逐前不剪枝；现在统一为「先剪掉过期桶，再按最早命中时间驱逐，并列按插入序」。现有测试（全部时间戳相同）结果完全一致；差异只出现在存在过期桶或时间戳不同时，新行为优先丢弃过期/最久未命中的桶，对限流语义是严格更优（不会把正在被打的活跃桶挤掉）。
2. `peer-server` 原来在 `sweep()` 内部按最小首帧时间戳驱逐，现在同一语义由计数器的 `'oldest'` 承担；`allow()` 被拒时不再触发驱逐（被拒说明该桶已满、size 也没增长），下一次放行时照常收敛。

`HubEnrollLimiter` 的两个计数器都以 `maxKeys = Infinity` 构造，合并预算判定（`failures.size + successes.size > maxKeys` → 两桶各 sweep 一次）留在封装层，与原 `evictExpiredOnly()` 逐字等价。

### 新增测试

`apps/gateway/src/lib/sliding-window.test.ts`（129 行，10 例）：窗口内外计数、`hit` 返回值、`release` 回滚与空桶清理、`reset`/`clear`、`sweep` 只清过期、两种 `evict` 策略（含并列按插入序、活桶不被挤掉、过期桶优先于活桶被回收）、显式 `now` 覆盖时钟。

## 二、D2 拨号失败分类器 → `packages/shared/src/net/classify-by-keywords.ts`

新增（21 行）：

```ts
classifyByKeywords<T>(reason, rules: ReadonlyArray<KeywordRule<T>>, fallback: (normalized) => T): T
truncateReason(reason, max = 64): string
```

`KeywordRule<T> = readonly [keywords: readonly string[], category: T]`，按表顺序取首个命中（顺序即优先级），`reason` 先转小写，未命中交给 `fallback`。泛型 `T` 让 direct 侧的 `string | null`（null 表示「不计入失败」）也能直接用同一个表。

已从 `packages/shared/src/net/index.ts` 导出（即 `@tmex/shared/net` 子路径，`packages/shared/package.json` 的 `exports` 里已有 `"./net"`；未改 `packages/shared/src/index.ts`）。

### 三处改写

| 函数 | CC 前 → 后 | 说明 |
| --- | --- | --- |
| `mesh/peer-ws-race.ts:classifyWsDialFailure` | 35 → 2（新拆出的 `classifyWsDialKind` 9、`wsDialHaystack` 6） | 见下 |
| `mesh/rtc/rtc-dial-breaker.ts:classifyRtcDialFailure` | 21 → 4 | 原来是正则表；改成关键词表。`^(?=.*unexpected remote)(?=.*signaling state)` 这条「与」条件是表里第一条，提为前置判定；`^closed$` 是最后一条，下放到 `fallback`（`normalized === 'closed' ? 'channel-closed' : truncateReason(reason)`），优先级不变。codex 新加的 `RTC_DIAL_BREAKER_SKIP_KINDS`（`signaling-state` / `signal-dropped`）及 `noteFailure` 里的 `breakerKind` 逻辑原样保留 |
| `ws-client/src/direct/direct-dial-breaker.ts:classifyDirectDialFailure` | 16 → 2 | 九条 `if` 直接变成九条规则，两条映射到 `null` |

### ws 分类器的优先级保真处理

`classifyWsDialFailure` 原来把「读 errno」「`instanceof PeerHandshakeError`」和关键词判定交错在同一条优先级链上，直接抽表会改变优先级。做法是把非字符串的信号折成标记词，拼到词表输入的末尾（用 `\n` 分隔），于是它们与原本同一档的关键词处在同一条规则上：

- 只对 `ECONNREFUSED` / `EHOSTUNREACH` / `ENETUNREACH` / `ECONNRESET` / `EPIPE` 五个已知 errno 追加 `errno:<小写>`（**只白名单这五个**：若把任意 errno 都拼进去，`ECONNABORTED` 会被 `aborted` 规则误吃、`ERR_..._TIMEOUT` 会被 `timeout` 误吃）；
- `lower.startsWith('ws-closed')` 追加 `mark:ws-closed`（原来是 `startsWith`，不能退化成 `includes`）；
- `err instanceof PeerHandshakeError && err.code === 'protocol'` 追加 `handshake`。

前两条规则（`aborted` 含 `lower === 'stopped'` 的精确匹配；`PeerHandshakeError` 的 `timeout` / `bad_signature` / `revoked`）本来就在链首，保留为前置判定。`classifyWsDialFailure` 现在只剩「已是 `WsDialError` 就原样返回，否则包一层」。

## 三、验收

- `cd apps/gateway && bun test src/mesh src/hub src/relay src/lib`：**1674 pass / 0 fail**（128 文件）
- `cd packages/ws-client && bun test`：**407 pass / 0 fail**
- `cd packages/shared && bun test src/net`：**26 pass / 0 fail**
- `bunx tsc --noEmit -p apps/gateway` / `-p packages/ws-client` / `-p packages/shared`：均无输出
- `bunx biome check <改动文件>`：clean（改动过程中由 `--write` 修过 import 排序）
- `bun scripts/complexity/gate.ts`：`complexity gate ok (1572 files, 13944 functions)`
- `bun prompt-archives/2026082702-code-smell-round3/sub/cc.ts <dir> 15 big`：`apps/gateway/src/mesh`、`apps/gateway/src/hub`、`apps/gateway/src/relay`、`apps/gateway/src/lib`、`packages/ws-client/src`、`packages/shared/src/net` 六个目录里，三个分类器与所有新增函数均无 CC>15 条目

### allowlist 变更（只删不放宽）

删除三条已不再需要的豁免，未新增、未放宽任何条目：

- `apps/gateway/src/mesh/peer-ws-race.ts:classifyWsDialFailure`（cc 35）
- `apps/gateway/src/mesh/rtc/rtc-dial-breaker.ts:classifyRtcDialFailure`（cc 21）
- `packages/ws-client/src/direct/direct-dial-breaker.ts:classifyDirectDialFailure`（cc 16）

编辑前已重读文件确认无并发改动，编辑后 `json.load` 校验 + 门禁复跑通过。

## 四、行数增减

存量文件（8 个）：1475 → 1351，**-124 行**。

| 文件 | 前 → 后 |
| --- | --- |
| `apps/gateway/src/mesh/auth-login-limiter.ts` | 80 → 53 |
| `apps/gateway/src/hub/hub-enroll-limiter.ts` | 157 → 105 |
| `apps/gateway/src/relay/relay-enroll-limiter.ts` | 110 → 84 |
| `apps/gateway/src/mesh/peer-server.ts` | 205 → 183 |
| `apps/gateway/src/mesh/peer-ws-race.ts` | 538 → 525 |
| `apps/gateway/src/mesh/rtc/rtc-dial-breaker.ts` | 282 → 288 |
| `packages/ws-client/src/direct/direct-dial-breaker.ts` | 96 → 105 |
| `packages/shared/src/net/index.ts` | 7 → 8 |

新增源码：`apps/gateway/src/lib/sliding-window.ts` 100 行 + `packages/shared/src/net/classify-by-keywords.ts` 21 行 = **+121 行**。

源码净变化 **-3 行**（行数基本持平；实际收益是 5 份滑动窗口实现收敛成 1 份、3 个分类器变成规则表、3 条复杂度豁免消失）。

新增测试：`sliding-window.test.ts` 129 行 + `classify-by-keywords.test.ts` 41 行 = **+170 行**。

`scripts/complexity/allowlist.json`：-12 行。

## 五、遗留

- `apps/gateway/src/lib/` 是本轮新建目录，目前只有滑动窗口一个模块；后续 gateway 侧的通用小工具可以往这里收。
- `rtc-dial-breaker.ts` / `direct-dial-breaker.ts` 仍用相对路径 `../../../packages/shared/src/net/...` 引 shared（沿用文件内 `dial-breaker` 既有写法，未改动）；`peer-ws-race.ts` 用的是 `@tmex/shared/net` 子路径。要不要统一成子路径可以另行决定，本轮没动。
