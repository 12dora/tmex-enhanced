# T7 结果：直连失败码（链路信息窗 i18n）+ uplink-pool 监听器泄漏

## Job A：稳定的直连失败码

### 契约（DTO）

`packages/api-client/src/auth/types.ts`

- 新增 `DIRECT_FAILURE_CODES`（运行时常量数组）与由它推出的 `DirectFailureCode` 联合类型，取值与 EX3 §A 码表一致（22 个）。
- `MeshNodeDirectFailure` 加 `wsCode` / `wsParams {url?, seconds?}` / `dcCode` / `dcParams {until?}`；`ws` / `dc` 原文保留（旧网关兜底）。
- 网关侧镜像：`apps/gateway/src/mesh/peer-manager-types.ts` 的 `DirectFailureCode` / `DirectFailureWsParams` / `DirectFailureDcParams` / `DirectFailureView`（网关不依赖 `@tmex/api-client`，只能复制一份；改码表要两边一起改）；`node-list-projection.ts` 的 `MeshNodeDirectFailure` DTO 形状同步。链路详情本来就是整个对象透传，网关到前端不需要逐字段搬运。

### WS 侧

- `peer-ws-race.ts`：`WsDialFailureKind` 增补 `tls` / `revoked` / `untrusted`；`classifyWsDialKind` 里 `PeerHandshakeError.code === 'revoked'` 单独成 `revoked`，证书类报文（`certificate` / `self-signed` / `unable to verify` / `err_cert` / `ssl` / `hostname mismatch`）成 `tls`，`not-trusted` 类成 `untrusted`，其余仍走原关键词表。`formatWsDialFailure` 对三种新分类给出前缀原文。
- `raceWsSecureEndpoints` 返回值改为 `WsSecureRaceResult`，多带 `lastKind`（最后一次失败的分类）与 `lastUrl`。
- 分类 → 码的表在新模块 `apps/gateway/src/mesh/direct-failure-codes.ts`（`wsFailureCode`）：`open-timeout` 并入 `timeout`，`protocol` → `handshake`，其余同名。
- 三处记录点（`peer-manager.ts`）：
  - 一个地址都没公布 → `noteNoEndpoints`（码 `no_endpoints`）。原来这里直接 `return null`，浮层上是个静默洞。
  - 全在退避中 → `noteWsBackoff`（码 `backoff`，`wsParams.seconds`）。
  - 竞速失败 → `noteWsRaceFailure`（码由 `lastKind` 映射，`wsParams.url`）。
  这三个记录函数放在 `peer-direct-attempt.ts`，`peer-manager` 侧各是一行调用。

### DC 侧

- `dcFailureReason` 连同 `dcFailureCode` / `DcFailureDetail` 一起从 `peer-dc-upgrade.ts` 移到 `direct-failure-codes.ts`（纯函数，不依赖协调器状态；也是为了让两个文件都回到复杂度预算内）。返回 `{ text, code, params? }`。
- 映射复用 `classifyRtcDialFailure`：`signal-dropped`→`signal_dropped`、`liveness-timeout`/`missed-pong`→`liveness_timeout`、`timeout`→`dc_open_timeout`、`ice`→`ice_failed`、`abort`→`aborted`、`protocol`→`handshake`、`channel-error`/`channel-closed`/`transport-lost`→`dc_closed`、`signaling-state`→`signaling_state`，其余 `other`；分类前先摘出「no (ice) candidates / candidates exhausted」→ `no_candidates`。
- `direct_capable=false` → `not_direct_capable`，`rtc` 不可用 → `rtc_unavailable`。
- **熔断冷却**：`dial()` 里把 `dcBreaker.shouldTry()` 的 `until` 记进 `dcCoolingUntil` 传给 `finishDirectAttempt`；`dcFailureReason` 见到 `coolingUntil !== undefined` 就返回 `breaker_cooling` + `dcParams.until`。此前冷却时 `tryDc` 直接返回 null、不设 `dcError`，浮层里 DataChannel 那一行整个消失。

### 前端

`apps/fe/src/node/device-node-badges.tsx`

- `directFailureRows`：有已知码 → `nodes.badge.failure.<code>` + `{{seconds}}` / `{{url}}` / `{{until}}`；无码或码不认识 → 原文 + 等宽（等宽只留给机器措辞）。`until` 在前端按本地时区格式化成 `HH:MM` 后再插值。
- ICE 行：`connectionState` / `iceConnectionState` 按 W3C 枚举翻 `nodes.badge.ice.<state>`，候选类型翻 `nodes.badge.candidate.<host|srflx|prflx|relay>`，浏览器方言原样展示。`selectedPair` 保持 `本端 → 对端` 形状，两端各自翻译（新增 `DiagnosticRowSpec.valueParts` + `resolveRowValue`），两端都取不到时退回原来的整串。RTT 单位仍是 `ms`。
- `direct-diagnostics.ts` 的 `normalizeDirectFailure` 校验码与参数（不认识的码丢弃，回落原文），组件侧再兜一层。

### 文案（en_US / zh_CN / ja_JP）

新增 `nodes.badge.failure.*`（22）、`nodes.badge.ice.*`（8）、`nodes.badge.candidate.*`（4），三语同步。ja 用名词短语（与 `測定中` / `不明` 等表格值一致，也免得在 288px 的浮层里被截断）。

## Job B：`anyAbort` 监听器泄漏

- `uplink-pool.ts` 删掉 `anyAbort`，三处（wrap 退避 sleep :724、`tryCandidate` 认证 deadline :770、failback 防抖 :1292）改用 `@tmex/shared/async` 的 `combineAbortSignals`（有原生 `AbortSignal.any` 就走它，否则在任一 abort 后摘掉所有监听器）。返回类型是 `AbortSignal | undefined`，两处需要非空的按仓内既有写法 `?? shortLivedSignal` 收口。
- `peer-ws-race.ts` 本地那份 `combineAbortSignals` 一并删掉，两个调用点改用共享实现。
- 回归测试 `uplink-pool.test.ts`「反复重连不会在长寿 stop signal 上攒 abort 监听器」：包住 `pool.stopSignal()` 的 `addEventListener` / `removeEventListener` 计净增监听器数，跑 12 轮失败重连后断言 ≤ 2。已验证：把 `tryCandidate` 那处换回旧 `anyAbort` 实现，该用例立刻失败。

## 文件

新增：
- `apps/gateway/src/mesh/direct-failure-codes.ts`
- `apps/gateway/src/mesh/direct-failure-code.test.ts`

改动：
- `packages/api-client/src/auth/types.ts`
- `apps/gateway/src/mesh/{peer-manager.ts,peer-manager-types.ts,node-list-projection.ts,peer-ws-race.ts,peer-dc-upgrade.ts,peer-direct-attempt.ts,uplink-pool.ts}`
- `apps/gateway/src/mesh/{peer-direct-attempt.test.ts,uplink-pool.test.ts}`
- `apps/fe/src/node/{device-node-badges.tsx,device-node-badges.test.tsx,direct-diagnostics.ts}`
- `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json`（只动 `nodes.badge` 子树）+ 一次 `build:i18n` 产物

**超出任务清单的文件**（都不在其他 agent 的范围内）：`peer-direct-attempt.ts`（`DirectAttemptRecord` 是失败码的落点，绕不开）、新建的 `direct-failure-codes.ts`（见下「复杂度门禁」）。

## 测试

- `apps/gateway`：`bun test src/mesh` 1330 pass / 0 fail（95 文件，129s）；`bunx tsc --noEmit -p .` → 只剩 `src/mesh/mesh-http.test.ts` 的 3 处报错（T3 正在改的文件，与本任务无关）。
- `packages/api-client`：`bun test` 242 pass / 0 fail；`tsc --noEmit` 0 error。
- `apps/fe`：`bun test src/node` 446 pass / 0 fail；`tsc --noEmit` 0 error。
- `packages/shared`：`bun test src/async src/i18n` 25 pass / 0 fail。
- `bunx biome check <本任务改过的文件>` clean；`bun scripts/complexity/gate.ts` → `complexity gate ok`。

新增用例：
- `direct-failure-code.test.ts`：ws 分类 → 码全表、`revoked`/`tls`/`untrusted` 的窄化、竞速带出 `lastKind`/`lastUrl`、13 条 dc 原文 → 码、`dcFailureReason` 的四种分支（不支持直连 / 无 WebRTC / 熔断冷却带与不带 `until` / 真实错误）。
- `peer-direct-attempt.test.ts`：码与参数随原文一起写入 / 一起清空。
- `device-node-badges.test.tsx`：按码翻译 + 参数、`until` 本地时间格式化、无码回落原文、未知码回落原文、ICE 枚举与候选类型的翻译与方言兜底、候选对退回原串。
- `uplink-pool.test.ts`：监听器不累积。

## 偏离与遗留

1. **两处 locale「订正」我认为不该改，未动**：
   - `nodes.hub` zh_CN = `"Hub"`：文案规范（`tmex-copy-guidelines.md`「用词」表）明确要求「直接写 Hub，不加括号英文」，且整个 zh 语料里是 `主 Hub` / `备 Hub` / `Hub 地址`，`grep` 不到 `主控` 之类的既有中文译法。改成中文反而与规范和其余 47 处不一致。ja 用 `ハブ` 也与 ja 自身的全部语料一致（`メインハブ` / `予備ハブ` / `ハブの公開アドレス`）。结论：这不是缺陷，是两个语料各自的既定用法。
   - `relay.admin.tenants.columns.id` ja_JP = `"ID"`：ja 语料里标识符一律写 `ID`（`ノード ID`、`本機の ID`），en 也是 `ID`；日语 UI 里 `ID` 就是标准写法。zh 的 `编号` 才是那个偏离（zh 别处也写 `节点 ID`），但改 zh 超出本任务范围且会牵动其它页面。结论：未改，请指挥方定夺。
2. **复杂度门禁**：直接把码表写进 `peer-manager.ts` / `peer-dc-upgrade.ts` 会顶破两个文件的行数预算（1939 / 622）与 `dialWsSecure` 的 CC 15。处理办法是抽出 `direct-failure-codes.ts`（码表 + 两个映射函数 + `dcFailureReason`）、把三个记录动作下沉到 `peer-direct-attempt.ts`、把「取可拨地址 / 记退避」抽成 `PeerManager.eligibleEndpoints`。没有调 allowlist。
3. **顺手发现、未修**：`raceWsSecureEndpoints({ urls: [] })` 会永远挂住（内部 `Promise` 在零个候选时没人 resolve）。现实中进不去（`dialWsSecure` 在 `endpoints.length === 0` 时先返回，`dedupeRankedPeerEndpoints` 也不会把非空变成空），所以没动竞速的语义，只是把我的测试用例换成了「父 signal 已 abort」。
4. `apps/gateway` 的 `tsc` 里 `src/mesh/mesh-http.test.ts` 有 3 处报错，属 T3 正在改的文件。
