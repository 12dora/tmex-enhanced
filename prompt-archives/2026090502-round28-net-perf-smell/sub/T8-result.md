# T8 结果：后端 / shared 清理（D1、C4+隧道门禁、B1/B2/B4/B5、A1、A3、D9、D10）

分支 `feat/round28-net-perf-smell`，工作树 `/Users/konata/code/tmex-r28`。全程未做任何改动 git 状态的操作，未跑 e2e。
本任务分三路并行推进：主 agent 做 D1 与 C4+隧道门禁，两个子 agent 分别做 A1/A3/B* 与 D9/D10。

## 1. D1 步骤 1+2：uplink codec 拆分与读取族统一

### 拆分结果（`packages/shared/src/uplink/`）

原 `codec.ts` 1472 行拆成 4 个实现文件 + 1 个纯 re-export barrel：

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `codec-fields.ts` | 297 | 帧类型表、全部上限常量、`UplinkCtlError`、JSON/b64url/seq 原语、`assertCtlBounds`、**统一读取族工厂** |
| `codec-hub-frames.ts` | 445 | 两条线共用的 hub 角色结构与 `hub.*` 帧：`HubEndpointInfo`/`HubAdvertisement`、`hub.tokens`/`hub.attachments`/`hub.forward`/`hub.write-forward` 的类型 + parse/encode、`applyNodeListExtras`/`stripAttachedHubId` |
| `codec-mesh.ts` | 459 | mesh 线类型 + `decodeMeshUplinkCtl`/`encodeMeshUplinkCtl` |
| `codec-hub.ts` | 464 | hub 线类型 + `decodeHubUplinkCtl`/`encodeHubUplinkCtl` |
| `codec.ts` | 83 | barrel，逐个具名 re-export |

**偏离计划的一点**：计划里写的是 3 个文件（fields/mesh/hub），实测「共用读取族 + 共用 hub.* 帧解析」放进一个 `codec-fields.ts` 会到约 680 行，超过复杂度门禁的 600 行文件阈值，因此把跨线共用的 `hub.*` 帧单独拆成第 4 个文件 `codec-hub-frames.ts`。四个文件全部 < 600 行，无需新增文件级 allowlist 条目。

**barrel 零改动**：全仓 `@tmex/shared/uplink` 的导入方全部落在 `apps/gateway/src/{hub,mesh,auth,config}` 与 `packages/api-client/src/auth/types.ts`（`packages/shared/package.json` 的 `"./uplink"` 仍指向 `codec.ts`），无一处 import 需要改。barrel 采用逐个具名导出而非 `export *`，导出面与拆分前**逐个符号一致**（不多不少），没有顺带把 `TYPE_SET`/`ctlRead`/`parseHub*` 这些内部符号暴露出去。

### 读取族统一

原来两套平行读取器：`m*`（mesh，抛裸 `Error`，文案 `ctl field <字段> must be a ...`）与 `h*`（hub，抛 `UplinkCtlError`，文案 `missing/empty/invalid <字段>`），且签名不同（mesh 收 `(value, field)`，hub 收 `(obj, key)`）。

统一为一个工厂：

```ts
export type CtlFail = (field: string, kind: CtlFailKind, detail?: string) => Error;
export function createCtlReaders(fail: CtlFail): CtlReaders;
export const ctlRead = createCtlReaders(ctlFail);  // 裸 Error，mesh + 共用帧解析
export const hubRead = createCtlReaders(hubFail);  // UplinkCtlError，hub 线解码
```

- 签名统一为 `(value, field)`，hub 侧调用点由 `hStr(parsed, 'nonce')` 改为 `hubRead.str(parsed.nonce, 'nonce')`。
- 错误文案由各自的 `fail` 工厂按 `kind` 映射，**两侧原有报错文案逐字保留**（已有断言 `/32-hex/`、`/64 bytes/`、`/mode/`、`/priority/`、`/publicUrl/` 等全部照常命中）。
- **seq 表示差异按要求显式保留**：读取族同时提供 `seq()`（mesh，返回 `bigint`）与 `seqWire()`（hub，校验后原样返回 `number | string` 线上表示），不做隐式统一。
- 两个 ctl `switch` 未合并（步骤 3 不在本次范围），`switch (t as UplinkCtlType)` 的穷举检查保持不变。

### `NODE_ID_HEX` 大小写不一致（疑似 bug）修复

原来 hub 侧用 `/^[0-9a-f]{32}$/`（大小写敏感，拒绝大写 node id），mesh 侧用 `/^[0-9a-f]{32}$/i`（接受但不归一化）。按要求统一为**解码时大小写不敏感 + 归一化为小写**，两侧共用同一个读取器。

佐证：hub 自己的其它代码早就是这个语义——`apps/gateway/src/hub/uplink-server.ts:358` 就是 `NODE_ID_HEX(/i).test(id) ? id.toLowerCase() : undefined`，`hub/attachment-router.ts`、`hub/hub-relay.ts`、`hub/hub-peer-poller.ts` 用的也都是 `/i`。也就是说 codec 里 hub 分支的大小写敏感确实是唯一的例外，属于真 bug。

新增测试 `packages/shared/src/uplink/codec.test.ts`「两侧解码器都接受大写 node id 并归一化为小写」：同一个大写 `node_id` 的 `enroll.redeemed` 帧，`decodeMeshUplinkCtl` 与 `decodeHubUplinkCtl` 都能解出且值为小写；hub 的 `auth.response` 同样验证。

**连带修改一个 hub 目录下的测试（需要 commander 知晓）**：`apps/gateway/src/hub/uplink-protocol.test.ts` 里的 `auth.response.node_id must be 32 lowercase hex` 断言的正是「大写被拒绝」的旧行为，与本次要求的行为变更直接冲突。已把该断言改成「接受大写并归一化为小写」，用例名同步改为 `auth.response.node_id 必须是 32 位 hex，大小写不敏感且归一化为小写`，其余三条（非法长度、注入换行、非 hex 字符）原样保留。`apps/gateway/src/hub/**` 属于别的 agent 的目录，这是本次唯一一处越界改动，且只改了这一个 test 断言，未动 hub 的任何实现文件。

### allowlist 迁移（路径重命名，非放宽）

函数搬家会让旧 key 变 stale（stale 也会让门禁失败），因此把 `scripts/complexity/allowlist.json` 里 5 条 `packages/shared/src/uplink/codec.ts:*` 条目重新落到新路径，并顺手收紧：

| 旧条目 | 新条目 |
| --- | --- |
| `codec.ts`（fileLines 1473） | 删除（barrel 只有 83 行） |
| `codec.ts:decodeHubInner`（cc 76 / lines 177） | `codec-hub.ts:decodeHubInner`（cc 42，行数限制取消） |
| `codec.ts:decodeMeshUplinkCtl`（cc 67 / lines 181） | `codec-mesh.ts:decodeMeshUplinkCtl`（cc 32，行数限制取消） |
| `codec.ts:encodeMeshUplinkCtl`（cc 49） | `codec-mesh.ts:encodeMeshUplinkCtl`（cc 49，编码穷举 switch，历轮保留） |
| `codec.ts:encodeHubUplinkCtl`（cc 16） | 删除（拆出 `encodeHubLegacy` 后已 ≤15） |
| `codec.ts:parseHubWriteForwardMessage`（cc 24） | 删除（拆出 `parseWriteForwardAck` 后已 ≤15） |

即：解码器 CC 从 76/67 降到 42/32（下降约 45%/52%），另外两条直接降回默认阈值内。

## 2. C4 + 隧道复杂度门禁

### C4：`apps/gateway/src/api/tunnel-routes.ts` `parseAction`

- 抽出 `withAck<T extends TunnelActionRequest>(base, body)`，把原来重复 6 次的 `...(acknowledgeExposure === undefined ? {} : { acknowledgeExposure })` 展开收敛成一处。
- 抽出 `requiredBool(body, key, message)`（`autoStart`/`trustProxy`/`enforceJwt` 三处共用）、`requiredHostname(body)`（`create`/`adopt_external` 两处共用）。
- 按动作拆出 `parseAccessCredentials` / `parseConfigureAccess` / `parseCreateAction`；`set_access_mode` 从 `parseAction` 里挪进 `parseAccessAction`（它本来就是 access 族）。
- 校验顺序原样保留（例如 `create` 仍是先 hostname、再 ack、最后 tunnelName），失败文案与错误码逐字未变。
- `parseAction` CC 30 → 门禁已不再报（阈值 15）。allowlist 里 `tunnel-routes.ts:parseAction`（cc 30）条目保留未动——函数仍在，不会 stale；如果 commander 想顺手收紧可以跑 `--tighten`。

### 隧道门禁 4 条违规（不改 allowlist 修掉）

进场时 `bun run lint` 的门禁输出里属于隧道的 4 条：

```
apps/gateway/src/tunnel/manager.ts: 1519 lines > 1425
apps/gateway/src/tunnel/manager.ts:327 status: CC 17 > 16
apps/gateway/src/tunnel/manager.ts:1396 maybeRecoverEdge: CC 18 > 15
apps/gateway/src/tunnel/edge-resolver.ts:56 isUnusableEdgeIp: CC 17 > 15
```

（注：`git diff -- apps/gateway/src/tunnel/` 为空，这 4 条是 round27 隧道工作留在 main 上、allowlist 没跟上的既有欠账。）

修法：

1. **新增 `apps/gateway/src/tunnel/status-view.ts`（168 行）** —— 纯函数状态视图：`buildTunnelStatus`、`buildAccessStatus`、`tunnelProcessState`、`tunnelPublicUrl`、`edgeHintText`、`connectorHintText`，以及 `FAKE_IP_HINT`。`manager.status()` 由 67 行的对象拼装变成一次带显式输入的调用；`accessStatus()`/`processState()` 变成薄封装（保留原来的 try/catch 与 `emptyAccessStatus()` 兜底）。`status` CC 17 → 门禁不再报。
   - 行为等价性上特意保留了两处副作用顺序：`edge` 仍是 `persisted.externallyManaged ? null : this.currentEdge()`（`currentEdge()` 会写 `this.lastEdge`，不能无条件调用）；`log` 仍在最后取。
2. **新增 `apps/gateway/src/tunnel/edge-recovery.ts`（70 行）** —— 把 fake-IP 静态 edge 恢复的状态机（`degradedSince` / `done` / `inFlight` 三个字段 + 判定 + 重启）搬成 `TunnelEdgeRecovery` 类，依赖用回调注入（`now`/`delayMs`/`resolveEdge`/`currentEdge`/`canRestart`/`restart`/`warn`）。`manager.maybeRecoverEdge` 只剩「非外部托管 → 委托」两行，CC 18 → 4；类内部再拆成 `ready()` / `restartWithStaticEdge()`，单个都 ≤12。
3. **`resolveAccessHostname` 上移到 `apps/gateway/src/tunnel/hostname.ts`** —— 改成纯函数（显式收 `explicit/mode/tunnelHostname/externalHostname/forSync`），manager 里只留取 `store.get()` 的薄封装。
4. **`edge-resolver.ts:isUnusableEdgeIp`** —— 把 6 个私有/保留段的 `if` 链换成 `UNUSABLE_V4_BLOCKS` 表 + 一次 `some()`，CC 17 → 4，判定集合与原来逐一对齐（0/8、10/8、127/8、100.64/10、169.254/16、172.16/12、192.168/16，另加 `a >= 224` 与 fake-IP）。

结果：`manager.ts` 1519 → **1422 行**（≤ allowlist 的 1425），4 条违规全清，**未改 allowlist 里任何一条隧道条目**。`bun test src/tunnel src/api/tunnel-routes.test.ts` 222 pass / 0 fail。

## 3. B1 / B2 / B4 / B5 重复测试清理

由子 agent 执行，逐条核对覆盖关系后删除：

- **B1**：`apps/gateway/src/tmux-client/tmux-version.test.ts` 删掉 parse/compare 重复块（额外发现 `isControlModeSupported` 也是 `compareTmuxVersion` 的重复，一并删），保留 `normalizeTmuxVersionOutput`/`tmuxVersionIdentity`/`tmuxClientMatchesServer` 等 gateway 本地逻辑；`packages/app/src/lib/tmux.test.ts` 删掉两个重导出函数的 describe，保留 `checkTmuxVersion`（本地系统调用）。
- **B2（有偏差，需知晓）**：核对后发现「已被 `packages/shared/src/http/read-body.test.ts` 完全覆盖」这个前提不成立——shared 没有覆盖 happy-path 解析、多 chunk 未超限的拼接分支、`JSON.parse` 抛异常的 catch 分支。因此改为手术式删除：`apps/gateway/src/api/http.test.ts` 与 `packages/app/src/runtime/http.test.ts` 各只删了确实重复的 3 条（content-length 超限、chunked 超限、JSON 数组拒绝），保留上述 3 类唯一覆盖。要彻底清空这两个文件需要先把这 3 条补进 shared，属于后续独立小活。
- **B4**：`apps/gateway/src/agent/tools/terminal-encoding.test.ts` 删 `terminal encoding - keys`（是 `terminal.test.ts` 的真子集），保留 `terminal encoding - combos`（`encodeCombo` 在 `terminal.test.ts` 无覆盖）。
- **B5**：`apps/gateway/src/tmux-client/runtime/canonical-screen-capture.test.ts` 的 `utf8 capture helpers` 块与 `apps/gateway/src/bytes.test.ts` 逐字重复（`concatBytes`/`truncateUtf8Tail` 是同一实现的重导出），整块删除。

## 4. A1 死导出删除

10 个符号逐个 `grep -rw` 确认全仓（含测试、脚本；`prompt-archives` 的审计报告不计）零引用后删除，无 SKIP，并清理了因此变为未使用的 import：

`settings/broadcaster.ts:getTreeOverlayBridge`、`ws/canonical/encoded-size.ts:canonicalEventFrameBytes`、`ws/event-loop-lag.ts:demandGatewayEventLoopLagFast`、`ws/test-helpers.ts:envelopeKind`、`db/schema/mesh-relay.ts:MeshRelayRow`+`MeshSecretRow`、`messaging/handlers/types.ts:CommandModule`、`weixin/ilink/types.ts` 的 4 个常量（`MESSAGE_STATE_GENERATING`/`ITEM_TYPE_VOICE`/`ITEM_TYPE_FILE`/`ITEM_TYPE_VIDEO`）、`api-client/src/local/tls-types.ts:TlsErrorCode`、`api-client/src/local/types.ts:ApiErrorBody`、`stores/src/tmux-selection-actions.ts:snapshotPaneIds`。

mesh/contracts/panels/fe 名下的死导出按分工留给其它 agent，未碰。

## 5. A3（局部）`ws-borsh/canonical-state.ts` 过度导出

全文件 88 个导出：56 个常量/类型/函数被 `ws-borsh/index.ts` 具名重导出，保留；32 个 `*Schema` 里 5 个（`SourceMetadataValueSchema`、`CanonicalResizePaneV11Schema`、`CanonicalCommandEnvelopeSchema`、`SourceMetadataPatchSchema`、`CanonicalEventEnvelopeSchema`）被测试 / `state-snapshot-diff.ts` / bench 引用，保留；其余 **27 个**确认零外部引用后去掉 `export` 关键字（只删关键字，声明本身不动），与审计报告的估计吻合。

## 6. D9 `readCodedError` 折叠

`packages/api-client/src/json-mutation.ts` 加第 4 个**可选**参数 `pick`：

```ts
readCodedError<T>(
  res, fallback,
  make: (code, message, status) => T,
  pick?: (body: unknown, status: number) => T | undefined
): Promise<T>
```

`pick` 拿到已解析的 body（解析失败为 `undefined`）与状态码，命中直接返回完整的 `T`，返回 `undefined` 则退回原来的 `{error:{code,message}}` 契约解析与 `make(fallback, fallback, status)` 兜底。不传 `pick` 时行为与之前逐字一致，`tls-api.ts`/`local-api.ts`/`relay/admin-api.ts` 三个既有调用点未改。

折叠了 3 处手写 `readError`：
- `local/tunnel-api.ts`：它不认顶层 `{error:"..."}` 老形态、兜底 code 固定 `'unknown'`（与 fallback 文案分离），用 `pick` 完整复刻。
- `local/setup-api.ts`：与默认路径同构，直接删函数体走默认路径，无需 `pick`。
- `relay/tenant-api.ts`：原来是 `res.clone()` 先试自有形状 `{code, reason, lastError, lastErrorCode}`（拼 `${code}: ${reason}` + `details`）、失败再委托——现用 `pick` 表达第一段，顺带去掉了 `res.clone()`（只解析一次 body，两条路径复用同一份结果）。

三处均未改变可观察行为。按分工跳过 `apps/fe/src/node/hub-api.ts`。新增测试：`local/tunnel-api.test.ts`（新建）、`local/setup-api.test.ts` 与 `relay/tenant-api.test.ts` 各加一条（JSON 契约体 + 非 JSON 兜底）。

## 7. D10（部分）共享异步工具

新建 `packages/shared/src/async/`：

- `with-timeout.ts`：`withTimeout<T>(promise, ms, message?)`，超时以 `Error(message ?? \`timed out after ${ms}ms\`)` 拒绝，`finally` 里 `clearTimeout`，不留悬挂 timer。
- `abort.ts`：`combineAbortSignals(...signals): AbortSignal | undefined`，零可用信号返回 `undefined`、恰好一个原样透传、多个优先 `AbortSignal.any` 并保留手搭 `AbortController` 回退（转发首个 abort 的 `reason`，随后摘掉全部监听器）。
- `index.ts` 汇总；`packages/shared/src/index.ts` 顶层再导出两个符号（同步更新了 `index.test.ts` 的导出面快照）；`packages/shared/package.json` 的 `exports` 加 `"./async"`，与 `net`/`link`/`auth` 的目录 + `index.ts` 惯例一致。
- 测试：`with-timeout.test.ts`（提前 resolve / 超时默认与自定义文案 / 底层 reject 透传 / `clearTimeout` 确被调用）、`abort.test.ts`（无输入 / 单输入透传 / 首个 abort 带 reason / 原生 `any` 路径与强制降级手搭路径 / 二次 abort 幂等）。

**`packages/app/src/tls/acme-service.ts` 未切换**：`packages/app/package.json` 没有 `@tmex/shared` 依赖，`packages/app/src` 里也无任何 `@tmex/shared` 导入——这是 `tmex-cli` 刻意保持 Node 兼容、不引 workspace 共享包的既定约束（见 AGENTS.md）。按「不新增依赖」的口径，本地 `withTimeout`（`acme-service.ts:133` 附近）原样保留。其余调用点（`system/remote-upgrade-job.ts`、`system/release-download.ts`、`mesh/peer-ws-race.ts`）按分工不在本任务范围，留给后续批次。

## 验收

| 检查 | 结果 |
| --- | --- |
| `packages/shared` `bun test` | 713 pass / 0 fail |
| `packages/api-client` `bun test` | 226 pass / 0 fail |
| `packages/stores` `bun test` | 431 pass / 0 fail |
| `packages/app` `bun test` | 897 pass / 1 skip / 0 fail |
| `apps/gateway` `bun test src/tunnel src/api/tunnel-routes.test.ts` | 222 pass / 0 fail |
| `apps/gateway` `bun test src/hub/uplink-protocol.test.ts src/mesh/uplink-protocol.test.ts` | 11 pass / 0 fail |
| `apps/gateway` `bun test src/hub src/mesh`（codec 覆盖面） | 0 fail（改 codec 前后各跑一次比对；唯一新增失败是上面说的那条断言旧行为的用例，已随行为变更改掉） |
| `bunx tsc --noEmit -p` × `packages/{shared,api-client,stores,app}` | 全部 0 错 |
| `bunx tsc --noEmit -p apps/gateway` | 我方文件 0 错（并发期间偶有别的 agent 的 mesh/rtc 中间态报错，与本任务无关） |
| `bunx biome check` 改动文件 | 全部通过 |
| `bun scripts/complexity/gate.ts` | **我负责的文件 0 违规、0 stale**（uplink / tunnel / api-client / stores / app 全清） |

`apps/gateway` 全量 `bun test`：**4464 pass / 35 fail**（414 文件），35 条失败**全部落在 `apps/gateway/src/mesh/**`**，明细见下。

### 他人目录内的失败（不属于本任务，供 commander 汇总）

全量跑的 35 条失败按文件归类，全部在 mesh agent 正在编辑的目录，我方目录（`tunnel/`、`api/tunnel-routes`、`hub/`、`ws/`、`settings/`、`db/`、`messaging/`、`weixin/`、`agent/tools/`、`tmux-client/`）零失败：

- `mesh/rtc/rtc-peer-manager.test.ts`（11 条）、`mesh/rtc/bulk.test.ts`（5 条）、`mesh/rtc/ice.test.ts`（1 条）
- `mesh/peer-manager.test.ts`（14 条，含 wake / waitForTransport / dc 升级一族）
- `mesh/integration/direct-path.integration.test.ts`（2 条）、`stream-failover` 与 `rtc wake via authenticated uplink` 各 1 条

直接根因可见：并发期间 `bunx tsc --noEmit -p apps/gateway` 报过 `src/mesh/rtc/rtc-peer-manager.ts: Cannot find name 'createRtcSignalApplier'`，是 mesh agent 的编辑中间态，与本任务无关。

门禁里仍在报、但属于他人目录的违规（我未动）：`apps/fe/**`（`totp-section.tsx`/`passkey-section.tsx`/`hub-role-switch-run.ts`/`use-node-upgrade.ts`，另有 3 条 fe 的 stale allowlist 条目）、`apps/gateway/src/mesh/**`、`apps/gateway/src/system/**`、`apps/gateway/src/hub/uplink-server.ts`、`packages/panels/src/agent/chat-thread.tsx`、`packages/shared/src/link/mux.ts`。

## 行数增减（`git diff --stat`，只读）

已跟踪文件：

```
 apps/gateway/src/agent/tools/terminal-encoding.test.ts       |  20 +-
 apps/gateway/src/api/http.test.ts                            |  22 +-
 apps/gateway/src/api/tunnel-routes.ts                        | 189 +++---
 apps/gateway/src/db/schema/mesh-relay.ts                     |   3 -
 apps/gateway/src/hub/uplink-protocol.test.ts                 |   6 +-
 apps/gateway/src/messaging/handlers/types.ts                 |   7 +-
 apps/gateway/src/settings/broadcaster.ts                     |   4 -
 apps/gateway/src/tmux-client/runtime/canonical-screen-capture.test.ts | 15 -
 apps/gateway/src/tmux-client/tmux-version.test.ts            |  30 -
 apps/gateway/src/tunnel/edge-resolver.ts                     |  20 +-
 apps/gateway/src/tunnel/hostname.ts                          |  29 +
 apps/gateway/src/tunnel/manager.ts                           | 242 ++----
 apps/gateway/src/weixin/ilink/types.ts                       |   4 -
 apps/gateway/src/ws/canonical/encoded-size.ts                |   7 -
 apps/gateway/src/ws/event-loop-lag.ts                        |   4 -
 apps/gateway/src/ws/test-helpers.ts                          |  10 -
 packages/api-client/src/json-mutation.ts                     |  28 +-
 packages/api-client/src/local/setup-api.test.ts              |  31 +
 packages/api-client/src/local/setup-api.ts                   |  23 +-
 packages/api-client/src/local/tls-types.ts                   |  14 -
 packages/api-client/src/local/tunnel-api.ts                  |  33 +-
 packages/api-client/src/local/types.ts                       |   4 -
 packages/api-client/src/relay/tenant-api.test.ts             |  21 +
 packages/api-client/src/relay/tenant-api.ts                  |  29 +-
 packages/app/src/lib/tmux.test.ts                            |  42 +-
 packages/app/src/runtime/http.test.ts                        |  22 +-
 packages/shared/package.json                                 |   1 +
 packages/shared/src/index.test.ts                            |   2 +
 packages/shared/src/index.ts                                 |   2 +
 packages/shared/src/uplink/codec.test.ts                     |  26 +
 packages/shared/src/uplink/codec.ts                          | 1551 +---------------
 packages/shared/src/ws-borsh/canonical-state.ts              |  54 +-
 packages/stores/src/tmux-selection-actions.ts                |   8 -
 scripts/complexity/allowlist.json                            |  46 +-
```

新增文件（未计入上表）：

```
packages/shared/src/uplink/codec-fields.ts           297
packages/shared/src/uplink/codec-hub-frames.ts       445
packages/shared/src/uplink/codec-hub.ts              464
packages/shared/src/uplink/codec-mesh.ts             459
apps/gateway/src/tunnel/status-view.ts               168
apps/gateway/src/tunnel/edge-recovery.ts              70
packages/shared/src/async/{abort,with-timeout,index}.ts + 两个 test  211
packages/api-client/src/local/tunnel-api.test.ts      46
```

净效果：删除约 240 行真死代码 / 重复测试；`codec.ts` 1472 → 4 个 ≤464 行的实现文件 + 83 行 barrel；`manager.ts` 1519 → 1422 行；两个解码器 CC 76/67 → 42/32；`parseAction` CC 30、`isUnusableEdgeIp` CC 17、`maybeRecoverEdge` CC 18、`status` CC 17 全部降回默认阈值内。

## 遗留 / 建议

1. **B2 未竟**：`api/http.test.ts` 与 `app/runtime/http.test.ts` 还各留 3 条 shared 未覆盖的用例（happy path、多 chunk 未超限拼接、`JSON.parse` catch 分支）。把它们补进 `packages/shared/src/http/read-body.test.ts` 后即可清空这两个文件。
2. **D1 步骤 3**（合并两个 ctl `switch`）与 `hub/uplink-server.ts` 上帝类拆分仍独立立项；`encodeMeshUplinkCtl` CC 49 是本轮唯一还挂在 allowlist 上的 codec 条目，合并 switch 后可一起收掉。
3. **D10 剩余调用点**：`system/remote-upgrade-job.ts`、`system/release-download.ts`（两份逐字相同的 abort 合并）、`mesh/peer-ws-race.ts` 都可以切到 `@tmex/shared` 的 `combineAbortSignals`/`withTimeout`，本轮因目录归属未动。`packages/app` 因刻意不依赖 workspace 包，`acme-service.ts` 的本地 `withTimeout` 建议长期保留。
4. **allowlist 可再收紧**：`tunnel-routes.ts:parseAction`（cc 30）、`tunnel/manager.ts:status`（cc 16）两条现在实际值已远低于锁值，合并各 agent 改动后跑一次 `bun scripts/complexity/gate.ts --tighten` 可以一并降下来（注意 `--tighten` 会重写整个 allowlist，必须在所有 agent 收工后跑）。
