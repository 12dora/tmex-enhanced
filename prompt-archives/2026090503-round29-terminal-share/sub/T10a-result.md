# T10a 结果：KI-7 上半 —— ctl 编解码合并 + `UplinkServer` 拆分

## 一、两条线的 ctl switch 合并

### 新增 `packages/shared/src/uplink/codec-decode.ts`（390 行）

hub 线（`decodeHubInner`，CC 42）与 mesh 线（`decodeMeshUplinkCtl`，CC 32）此前各自穷举同一份
17 种 `UplinkCtlType`，差别只在读取器族（`hubRead` / `ctlRead`）、线上表示（b64url 字符串 + `number|string`
seq / `Uint8Array` + `bigint`）与两处门禁。现在合并为一份参数化实现：

```ts
decodeUplinkCtl(input, profile, { allowKeyLogRes, pendingKeyLogId })
```

`CtlDecodeProfile<Bytes, Seq, NodeList, Enroll>` 收敛全部差异：`readers` / `fail` / `hardMaxBytes` /
`onJsonError` / `notObject` / `unknownType` / `bytes` / `text` / `nodeIdText` / `optText` / `reqText` /
`seq` / `inventory` / `endpoints` / `keyLogSigLen` / `keepAlreadyAdmitted` / `nodeList` /
`enrollRedeemed` / `frame`。

- 信封（尺寸门槛、JSON 解析、`assertCtlBounds`、`key.log.res` 门禁与 `pendingKeyLogId` 豁免、
  `TYPE_SET` 校验）只有一份：`checkCtlSize` / `assertCtlPayloadBounds` / `prepareCtl`。
- 17 种类型中 16 种的解码体已完全共享；只有 `node.list`（hash 归一化、turn/stun 校验、hub 信息校验
  两条线差异过大）走 profile 钩子。`enroll.redeemed` 共享解码、由 profile 负责落地形状
  （hub 用 `node_id`/`entry_sid`/`already_admitted`，mesh 用 `nodeId`/`entrySid` 且丢弃 `already_admitted`）。
- 穷举 switch 保留，但按类型分区拆成两支以落回 CC 门禁内：`decodeCoreCtl`（13 种，CC 14，
  形参类型 `CoreCtlType = Exclude<UplinkCtlType, HubFrameCtlType>`）与 `decodeHubFrameCtl`
  （4 种 `hub.*` 帧，CC 5）。两支都由 TS 保证穷举，新增类型仍会编译报错。

### 编码侧

`encodeMeshUplinkCtl`（CC 49）改为：`hub.*` 帧走 `encodeMeshHubFrame`（CC 5，仍用
`encodeHubTokensMessage` 等各自的实现），其余 13 种先由 `toHubWireCtl`（CC 14）归一到 hub 线的线上表示，
再复用 `encodeHubUplinkCtl` —— legacy 剥字段因此收敛到 `encodeHubLegacy` 一处（保持显式剥字段，未表驱动）。
`encodeMeshUplinkCtl` 本体降到 CC 3。

### `packages/shared/src/uplink/codec-fields.ts`

新增 `posInt` 读取器与对应 `CtlFailKind`：两条线原本对 `key.log.req.limit` 各写一份「正整数」校验，
文案分别是 `invalid limit` / `ctl field limit must be a positive integer`，用统一读取器后两边文案原样不变。

### 行为等价性验证

除既有 26 个 codec 用例零改动通过外，另做了两层验证：

1. **新增 `codec-parity.test.ts`（219 行，39 个用例）**：每种 ctl 类型一份字段给满的线上样本，
   断言「两条线各自解码后重新编码」得到同一份线上表示（含 `legacy: true`），并显式钉住三处
   有意分歧：`already_admitted` 只有 hub 线保留、`key.log.res` 只有 hub 线默认拒收、
   seq/字节两种表示互为等价。
2. **一次性差分回归**（跑完即删，未入库）：把 HEAD 版 `codec-hub.ts` / `codec-mesh.ts` 复制到临时目录，
   对 25 份样本 × 全部字段路径（含嵌套，深度 3）× 12 种畸形值 = **7692 组**输入，比对新旧实现的
   接受/拒绝与重新编码后的字节；另有 15 组信封用例（非法 JSON / 非对象 / 超尺寸 / `key.log.res` 门禁 /
   `pendingKeyLogId` 豁免）× hub·mesh × 门禁开关。

   首轮暴露 42 处严格性漂移（都在畸形输入上）：hub 线原本拒绝空串 `id`/`error`/`entry_sid`，
   mesh 线原本接受空串 `key.log.ack.id` / `rtc.signal.rtcSession|to` 且忽略非法 `already_admitted`。
   为此补了 `optText` / `reqText` / `keepAlreadyAdmitted` 三个 profile 开关，**第二轮 7692 组 0 差异**。
   信封层剩 4 处仅报错文案不同（mesh 线 `{t:42}` / `{}` 由
   `uplink ctl must be a JSON object with t` 变为 `unknown uplink ctl t: …`），接受/拒绝结论一致；
   全仓唯一依赖 ctl 报错文案的 `apps/gateway/src/mesh/uplink-reconnect.ts:93` 匹配的是
   `ctl too large`，该文案未变。

### 行数

| 文件 | 改前 | 改后 |
| --- | --- | --- |
| `codec-hub.ts` | 464 | 313 |
| `codec-mesh.ts` | 459 | 343 |
| `codec-fields.ts` | 297 | 305 |
| `codec-decode.ts` | — | 390（新增） |
| `codec-parity.test.ts` | — | 219（新增测试） |

生产代码净 +115 行：换来的是解码只剩一份实现（两条线不会再各自漂移）与三个高 CC 热点消失。

## 二、`UplinkServer` 拆分

`apps/gateway/src/hub/uplink-server.ts` **2224 行 → 582 行**，按方法归属拆出五个协作者
（比原计划的三个更细：key log 与 RTC 会话各自成文件，跨 hub 裸流单独成文件），
共享可变状态放在 `UplinkServerState` 上、由 `UplinkServer` 构造一次分发给各协作者；
协作者之间不互持引用，跨组调用一律走构造时注入的窄回调（如 node-list 拿 `{ sendBytes, … }`、
federation 拿 `{ send, broadcastAllNodeLists, resetCrossHubRelays, … }`）。

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `uplink-server.ts` | 582 | 装配、角色/模式面、`onCtl` 薄分派、`stop`、`onIncomingStream` |
| `uplink-server-state.ts` | 79 | `UplinkServerState` + `LiveConnection`/`PendingAuth` 等共享类型 |
| `uplink-auth-session.ts` | 478 | 准入、认证计时、心跳/存活、吊销驱逐、send/enqueue/背压 |
| `hub-federation.ts` | 557 | token 复制、attachments、跨 hub 转发/中继、keepalive、写转发 |
| `uplink-node-list.ts` | 352 | 节点表投影/广播、`node.status` |
| `uplink-key-log.ts` | 296 | `key.log.req` / `key.log.append` 与追加副作用 |
| `uplink-rtc-sessions.ts` | 198 | RTC 会话注册表与信令路由 |
| `hub-relay-streams.ts` | 255 | 跨 hub 裸流接入/转发/泵送 |

`onCtl` 现在是一段 60 行的纯分派（解码 → 认证前只接 `auth.response` → `assertLiveCert` →
按 `msg.t` 转给对应协作者），CC 仍为 20（switch 分支本身）。

**未改任何测试**：`apps/gateway/src/hub/` 下唯一改动的受版本控制文件就是 `uplink-server.ts`，
`index.ts` / `hub-runtime.ts` / `uplink-server.test.ts` 的 diff 为空——公开导出面通过在
`uplink-server.ts` 里再导出新模块的常量与类型保持不变。

## 三、allowlist

删除：

- `packages/shared/src/uplink/codec-hub.ts:decodeHubInner`（cc 42）
- `packages/shared/src/uplink/codec-mesh.ts:decodeMeshUplinkCtl`（cc 32）
- `packages/shared/src/uplink/codec-mesh.ts:encodeMeshUplinkCtl`（cc 49）
- `apps/gateway/src/hub/uplink-server.ts`（fileLines 2247 → 582，回到 600 门禁内）

随方法迁移改键（阈值与理由沿用，理由后缀注明第二十九轮迁移）：

- `uplink-server.ts:buildNodeList` → `uplink-node-list.ts:buildNodeList`（cc 21）
- `uplink-server.ts:handleHubWriteForward` → `hub-federation.ts:handleHubWriteForward`（cc 16）
- `uplink-server.ts:handleKeyLogAppend` → `uplink-key-log.ts:handleKeyLogAppend`（cc 22）

保留：`apps/gateway/src/hub/uplink-server.ts:onCtl`（cc 20，分派 switch 本身，未降到门禁内）。

门禁 `bun scripts/complexity/gate.ts`：**0 stale allowlist entries**；本任务范围内
（`packages/shared/src/uplink/**`、`apps/gateway/src/hub/**`）0 违规。仍在报的 6 条违规全部落在
其他 agent 在飞的文件（`mesh/peer-dial-race.ts`、`mesh/mesh-runtime.ts`、`mesh/peer-manager.ts`、
`panels/device-console.tsx`、`terminal-ui/*`），不属本任务。

## 四、`docs/known-issues.md`

KI-7 标题改为「`peer-manager.ts` 上帝类待拆」，正文记下本轮已完成的两项（ctl switch 合并、
`UplinkServer` 拆分），保留 `apps/gateway/src/mesh/peer-manager.ts` 拆分未立项一行。

## 五、验证

| 命令 | 结果 |
| --- | --- |
| `packages/shared` `bun test src/uplink` | 65 pass / 0 fail（26 既有 + 39 新增 parity） |
| `packages/shared` `bun test`（全量） | 789 pass / 0 fail |
| `packages/shared` `bunx tsc --noEmit -p .` | 0 error |
| `apps/gateway` `bun test src/hub` | 231 pass / 0 fail |
| `apps/gateway` `bun test src/mesh/integration` | 63 pass / 0 fail |
| `apps/gateway` `bun test src/relay` | 159 pass / 0 fail |
| `apps/gateway` `bun test src/hub/uplink-protocol.test.ts src/mesh/uplink-client.test.ts src/mesh/uplink-pool.test.ts` | 114 pass / 0 fail |
| `apps/gateway` `bunx tsc --noEmit -p .` | 仅 `src/mesh/peer-dial-race.test.ts` 报错（T8b 在飞，非本任务） |
| `packages/app` `bunx tsc --noEmit -p .` | 0 error |
| `bunx biome check`（本任务改动的文件） | clean |
| `bun scripts/complexity/gate.ts` | 0 stale；本任务范围 0 违规 |

## 六、与任务书的偏差

1. **合并后的 switch 拆成两支**。任务书要求「保留穷举 switch」，但 17 个 `case` 天然 CC ≥ 18，
   保留单支就无法退掉 allowlist 条目。折中：按 `hub.*` 帧 / 其余核心类型分区成两个各自穷举的
   switch（`CoreCtlType` / `HubFrameCtlType` 由 `Exclude` 推出，TS 仍保证穷举），落到 CC 14 / 5。
2. **`UplinkServer` 拆成五个协作者而非三个**。按任务书的三分法实测 `hub-federation` 约 640 行、
   `uplink-node-list` 约 700 行，都会顶穿 600 行门禁，于是沿组内天然缝再切三刀：
   `hub-relay-streams.ts`（跨 hub 裸流：`ingestHubRelay` / `acceptHubRelay` / `forwardHubRelay` /
   `pumpToLocalNode` / `openAndPumpHubRelay` / `trackCrossHub` / `resetCrossHubRelays`）从 federation 拆出；
   `uplink-key-log.ts`、`uplink-rtc-sessions.ts` 从 node-list 拆出。
   另有三处随之调整：
   - `applyAuthorizedHubAdvertisement` / `warnUnauthorizedHubAd` / `maybeFenceFromPeer` 移入 federation
     （本就是对端 hub 广播与围栏 = 跨 hub 语义），`effectiveStartMode` 的主体成为同文件的
     `resolveStartMode` 自由函数，`UplinkServer` 只留薄委托；
   - `onIncomingStream` 留在 `UplinkServer`，但只保留 `live` 查表与 `assertLiveCert` 两道守卫，
     其后的主体原样搬到 `HubRelayStreams.routeNodeStream`；
   - `handleNodeStatus` 里内联的 token 快照去重块抽成 `federation.sendTokenSnapshotOnce(live)`
     （守卫顺序、`snapKey`、`tokenSnapshots` 集合均不变）——`tokenSnapshots` 是 federation 的状态，
     不抽就得跨协作者引用。
   `uplink-server.test.ts:181 nodeListCaches()` 直接读私有字段，因此 `UplinkServer` 保留
   `lastNodeListFp` / `lastNodeListSent` 两个字段别名指向 state 上的同一批 Map，测试零改动。
3. **`onCtl` 的 allowlist 条目未退**（CC 20）：分支数就是 ctl 类型数，分派本身已无逻辑可抽。
4. `encodeMeshUplinkCtl` 与 `encodeHubUplinkCtl` 对 `hub.tokens`/`hub.attachments`/`hub.forward`
   仍有一处既有分歧（mesh 侧重新校验并按 `encodeHubTokensMessage` 的字段序输出，hub 侧直接
   `JSON.stringify`），本次未动——parity 测试因此比对的是解析后的 JSON 深等价而非原始字节。

## 七、后续

- `apps/gateway/src/mesh/peer-manager.ts` 的拆分（KI-7 余项）仍待立项，本轮按任务书要求未碰
  `apps/gateway/src/mesh/**`。

---

## 追加：报错文案回归修复（协调者反馈后）

### 真因

`apps/gateway/src/mesh/uplink-protocol.test.ts`「1 MiB key.log.res 仅在存在匹配 pending id 时接受」
确定性失败：1 MiB 的 **`ping`**（带 `pendingKeyLogId`）期望 `/too large/`，实得 `ctl string too long`。

合并前 mesh 的 `assertMeshCtlSize` 有三段：

```ts
if (parsed.t === 'key.log.res' && bytes.byteLength > UPLINK_CTL_MAX_BYTES) { …id 匹配则 return… }
if (bytes.byteLength > UPLINK_CTL_MAX_BYTES) throw new Error('ctl too large');   // ← 合并时漏掉
if (!skipsCtlBounds(parsed.t)) assertCtlBounds(parsed, 0);
```

第二段被漏掉，于是「超尺寸但不是 `key.log.res`、且带着 pending id」的帧不再走尺寸门槛，
掉进 `assertCtlBounds` 报 `ctl string too long`。这不是文案问题：
`apps/gateway/src/mesh/uplink-reconnect.ts:90-99 mapUplinkCtlError` 按字面量分标签，
`'ctl too large'` → `ctl_too_large`、`'ctl string too long' | 'ctl array too long'` → `ctl_too_long`，
指标标签与重连判定被静默改写。

我的首轮对拍没抓到，因为超尺寸语料只覆盖了 `key.log.res`，没做「超尺寸 × 其余 16 种类型 × pending 开关」。

### 修复

1. `codec-decode.ts:assertCtlPayloadBounds` 补回 `if (byteLength > UPLINK_CTL_MAX_BYTES) throw fail('ctl too large')`
   （hub 线因硬上限就是 `UPLINK_CTL_MAX_BYTES`，该分支不可达，行为不变）。
2. 新增 profile 字段 `notStringType(value)`：`t` 非字符串时 hub 线报 `unknown t: <v>`、
   mesh 线报 `uplink ctl must be a JSON object with t`（原先我统一成了前者，会把
   `decode_error` 标签改成 `unknown_type`）。
3. 新增 profile 字段 `rtcFrom(value)`、`optSignalText(value, field)`、`keyLogRes.{notArray,notObject,field}`：
   把此前被我统一掉的 6 组文案逐字还原——
   mesh `rtc.signal.from` 非字符串仍报 `ctl field from must be a string`（**这条会把
   `invalid_field` 标签改成 `decode_error`**，是本次唯一另一处有实际影响的漂移）；
   hub 侧 `invalid rtc.from` / `invalid rtc.sdp` / `invalid rtc.candidate` /
   `invalid records` / `invalid record` 与 `seq|bytes|sig` 字段名也一并还原。

### 加强后的对拍

基线取 `22591087^`（我的重构提交 `22591087` 的父提交；`git show HEAD~1:` 已经是重构后的版本）。
语料扩展为：

- 25 份样本 × 全部嵌套字段路径 × **13** 种畸形值（新增 5000 字符长串）；
- **超尺寸语料**：17 种 ctl 类型各补白到 `UPLINK_CTL_MAX_BYTES+1` / `KEY_LOG_PAGE_MAX_BYTES` /
  `KEY_LOG_PAGE_MAX_BYTES+1`，外加 pending id 匹配 / 不匹配 / 缺失三种 `key.log.res`；
- 信封语料：非法 JSON、空串、非对象、`{t:42}`、`{t:null}`、`{}`、未知 t、超长串 / 超长数组 / 超深嵌套；
- 每组都跑 hub·mesh × `legacy` 开关 × `allowKeyLogRes` / `pendingKeyLogId` 开关。

比较口径从「接受/拒绝 + 重编码字节」升级为**连报错类名与报错文案一起逐字比对**。

结果：**8596 组比较，0 个差异分组**（首轮修复前为 9 组）。对拍脚本跑完即删，未入库。

### 落到测试

`codec-parity.test.ts` 新增 `describe('ctl 信封报错文案（对齐合并前实现）')` 四个用例（348 行，共 43 个用例），
把 `mapUplinkCtlError` 依赖的字面量全部钉死：

- mesh 尺寸门槛四种路径（超硬上限 / 超软上限 / **1 MiB `ping` 带 pending id** / `key.log.res` id 不匹配）
  一律 `'ctl too large'`，id 匹配则放行；
- mesh 非对象 / `{t:42}` / `{}` → `'uplink ctl must be a JSON object with t'`，未知 t → `'unknown uplink ctl t: …'`；
- mesh 越界 → `'ctl string too long'` / `'ctl array too long'` / `'ctl too deep'`；
- mesh 字段层保持 `'ctl field …'` 前缀（`invalid_field` 标签），含 `rtc.signal.from` 两条路径；
- hub 侧 `'ctl too large'` / `'invalid json'` / `'invalid ctl'` / `'unknown t: …'` /
  `'unexpected key.log.res'` / `'invalid records'` / `'invalid record'` / `'invalid rtc.from'` /
  `'invalid rtc.sdp'`，以及异常类型仍是 `UplinkCtlError`。

### 全仓依赖 ctl 报错文案的位置

`grep -rn "too large\|too long" apps packages --include='*.ts'`（排除测试与其它协议的 codec）唯一命中的
消费方是 `apps/gateway/src/mesh/uplink-reconnect.ts:90-99`：

```ts
if (message.startsWith('unknown uplink ctl')) return 'unknown_type';
if (message === 'ctl too large') return 'ctl_too_large';
if (message === 'ctl too deep') return 'ctl_too_deep';
if (message === 'ctl string too long' || message === 'ctl array too long') return 'ctl_too_long';
if (message.startsWith('ctl field')) return 'invalid_field';
if (message.startsWith('ctl ')) return 'invalid_ctl';
```

其余命中（`relay/blobs.ts`、`ws-borsh`、`relay-ca.ts`、`fragmenter.ts` 等）都是别的协议自己的文案，
与 uplink ctl 无关。该分类器覆盖 mesh 线**全部**报错文案，因此上面的 0 差异对拍即等价于
「所有指标标签不变」。

### 复跑

| 命令 | 结果 |
| --- | --- |
| `packages/shared` `bun test src/uplink` | 69 pass / 0 fail |
| `packages/shared` `bun test`（全量） | 793 pass / 0 fail |
| `packages/shared` `bunx tsc --noEmit -p .` | 0 error |
| `apps/gateway` `bun test src/mesh/uplink-protocol.test.ts src/mesh/uplink-client.test.ts src/mesh/uplink-key-log-sync.test.ts src/hub` | 289 pass / 0 fail |
| `apps/gateway` `bun test src/mesh/integration` | 63 pass / 0 fail |
| `apps/gateway` `bunx tsc --noEmit -p .` | 0 error |
| `bunx biome check packages/shared/src/uplink/` | clean |
| `bun scripts/complexity/gate.ts` | **complexity gate ok**（全仓 0 违规 0 stale） |

行数：`codec-decode.ts` 400、`codec-hub.ts` 328、`codec-mesh.ts` 357、`codec-parity.test.ts` 348。
新增函数 CC 均 ≤ 14（`decodeCoreCtl` 14、`toHubWireCtl` 14、`assertCtlPayloadBounds` 8），
allowlist 无需新增条目。

### 教训

「重新编码后的字节一致」不足以证明解码器等价——当调用方按报错文案分流时，**文案就是行为**。
差分对拍必须把报错文案纳入比较口径，并且畸形语料要覆盖每条门槛的每种类型组合，
而不只是触发该门槛最典型的那一种。
