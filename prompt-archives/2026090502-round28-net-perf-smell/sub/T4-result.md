# T4 结果：远程推包扛住链路复位（断点续传 + 退避重试）

## 背景与结论

EX1 定位：13.5 MB 升级包经中继隧道 PUT 给目标节点，中继一 RST（节点重连、心跳判死、上行切换、顶号）整条 peer link 就死；
`forwardAuthorizedHttp` 把 PUT 当不可重试（`IDEMPOTENT_HTTP` 只含 GET/HEAD），目标删掉 `.part`，任务以一句英文原文失败，
FE 的 6 分钟预算又短于后端 15 分钟推包超时。

本轮把推包改成**可续传、可重试、可观测**：目标按 `(version, sha256)` 保留半成品，入口先问已收偏移再只补发缺的那一段，
失败按退避重试并把进度写进任务快照，FE 按进度重算预算并把原始英文错误串翻成中文。

**实测中发现并修掉的关键点**（EX1 未覆盖）：中继 RST 在接收端**不是报错，而是请求体「干净地结束」**——
不比对 `content-length` 就会把「传到一半断了」误判成「包坏了」并删掉半成品，续传直接失效。
现在 `PUT` 带 content-length，收不满即 `PACKAGE_INCOMPLETE`（500）并保留 `.part`。

## 协议变更

### 目标节点（`/api/system/upgrade/package`）

| 方法 | 变更 |
| --- | --- |
| `GET`（新增） | `?version=&sha256=` → `200 {version, sha256, receivedBytes, complete}`；鉴权与 PUT 一致（须有会话 + `canSelfUpdate`），非法参数 400，未登录 403 `staged_requires_auth` |
| `PUT` | 新增 `?offset=N`：从 `.part` 的第 N 字节续写；缺省 / 0 = 从头覆写。`content-length` 现在参与判定（见下） |
| `DELETE` | 行为不变，另会清掉该版本遗留的 `.part` |

`PUT` 新增两个状态：

- `409 {code:'UPGRADE_OFFSET_MISMATCH', receivedBytes}`：`offset` 与盘上长度对不上（或前缀重算 hash 失败），回报真实偏移让推送端对齐。
- `500 {code:'PACKAGE_INCOMPLETE', receivedBytes}`：按 `content-length` 该收 N 字节只收到 M<N，判定为链路中断，**保留 `.part`**。

`.part` 命名由随机改成确定的 `tmex-cli-<version>.tgz.part-<sha256 前 16 位>`；只有确定性失败（sha 不符、超限、rename/sidecar 失败）才删，
链路类失败一律保留。半成品保留期 24 h（`repairStagingArtifacts` 按 mtime 清），并发语义仍是「一次只暂存一个包」，
但**同一 `(version, sha256)` 的续传可以顶掉挂死的上一条 PUT**（先 cancel 旧 reader 再接手），别的版本仍是 409 `UPGRADE_IN_PROGRESS`。

### 能力位

`GET /api/system/info` 的 `upgradeCapabilities` 增加 `'staged-package-resume'`，完整值：
`['staged-package', 'upgrade-cancel', 'uninstall', 'staged-package-resume']`。

### 入口（`GET /api/mesh/nodes/:id/upgrade`）

running 的远程任务在状态里多带一段 `progress`：

```ts
interface RemoteUpgradeProgress {
  phase: 'download' | 'push' | 'start';
  pushedBytes: number;   // 目标已确认收到的偏移
  totalBytes: number;    // 下载完成前为 0
  attempt: number;       // 第几次推送尝试，从 1 起
}
```

### 不可达原因

`NodeUnreachableReason` 新增 `'link_lost'`：`stream-aborted` / `relay-rst*` / `link-closed` / `replaced` / `relay-replaced` / `stopped`
从 `no_link` 拆出来——前者是「链路建起来又断了」，重试通常能成；`no_link` 仍表示「压根没有链路」。

### 转发层

`forwardAuthorizedHttp` 新增 `retry?: { attempts: number }`（上限 `HTTP_FAILOVER_MAX_ATTEMPTS=4`），
不再靠扩大 `IDEMPOTENT_HTTP` 白名单。**带 `rawBody` 的请求一律 attempts=1**：流只能读一次，重发必须由调用方按偏移重建。
目前用它的是取消时的 `DELETE /api/system/upgrade/package`（`attempts: 2`）。

## 入口推包逻辑（`remote-upgrade-job.ts`）

- 目标带 `staged-package-resume`：每次尝试先 `GET` 已收偏移 → `fileReadableStream(path, start)` 只读剩余段 →
  `PUT ?offset=N`，`content-length` = `total - offset`。目标回 `complete: true` 时直接跳过推包进 start（上一轮回包丢了而包其实已落地）。
- 重试：退避 1 / 2 / 4 / 8 / 15 s（封顶 15 s），最多 8 次，整个阶段共用 `pushMs = 15 min` 预算，取消或预算耗尽即停。
  只有链路类失败才重试：抛错、5xx（含 503 `NODE_UNREACHABLE`、500 `PACKAGE_INCOMPLETE`）、`UPGRADE_OFFSET_MISMATCH`；4xx 一次收尾。
- 不带能力位的旧目标：不问偏移、不带 offset，链路类失败最多从零重传 3 次（一次 + 2 重试）。
- 快照记 `phase / pushedBytes / totalBytes / attempt`，经 `upgrade-service.ts` 下发。
- 成功 / 取消路径的小 JSON 回包改为 `await res.text()`，不再 `body.cancel()`——后者会在转发层留下
  `forward aborted status=200 sent=0` 与 `reset('aborted')` 的假告警。

## 前端

- `watchUpgrade` 的预算改为「有进展就重新计时」：`progress` 指纹（phase:pushedBytes:attempt）一变就把 deadline 推到 `now + 6 min`，
  硬上限 `now(start) + 30 min`（覆盖后端 10 min 下载 + 15 min 推包 + 1 min 启动）。没有 `progress` 字段的旧入口 / 本机升级行为完全不变。
- 推包进度进表格：升级按钮在推包阶段显示「推送中 3.20 MB / 12.9 MB」（`formatBytesPair`，`NodeUpgradeEntry.push`），
  只在数值变化时下发，不会每轮刷一次表格。
- 错误文案：`UPGRADE_OFFSET_MISMATCH` 与后端原始串（`push failed: …` / `download failed: …` / `start failed: …` / 含 `link_lost`）
  按前缀翻成中文；认不出的仍原样显示，绝不谎报原因。

新增 i18n key（zh/en/ja 三语同步，已跑 `bun run build:i18n`）：
`nodes.upgrade.statePushing / linkLost / pushFailed / pushTimeout / downloadFailed / startFailed`。

## 改动文件

新增：
- `apps/gateway/src/system/upgrade-staging.ts`（`.part` 命名、偏移校验、前缀重算 hash、暂存相关类型；从 `upgrade.ts` 抽出）

修改：
- `apps/gateway/src/system/upgrade.ts`、`upgrade-service.ts`、`remote-upgrade-job.ts`
- `apps/gateway/src/api/system.ts`
- `apps/gateway/src/mesh/forwarder.ts`、`forwarder-unreachable.ts`
- `packages/shared/src/contracts/system.ts`
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`（+ 生成物）
- `apps/fe/src/pages/settings/nodes/management/{use-node-upgrade.ts,types.ts,nodes-table.tsx}`
- `scripts/complexity/allowlist.json`（见「注意事项」）

测试：
- `apps/gateway/src/system/upgrade.test.ts`（+6 新增，3 处按新语义更新）
- `apps/gateway/src/api/system.test.ts`（+4 新增，1 处更新）
- `apps/gateway/src/system/remote-upgrade-job.test.ts`（+6 新增，1 处更新）
- `apps/gateway/src/system/upgrade-service.test.ts`（1 处补 progress 断言）
- `apps/gateway/src/mesh/forwarder-unreachable.test.ts`（+8 条 link_lost 用例）
- `apps/gateway/src/mesh/forwarder.test.ts`（+1 retry/rawBody 用例）
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.test.ts`（+5 新增，1 处更新）

### 有意更新的既有断言

| 用例 | 原语义 | 新语义 |
| --- | --- | --- |
| `aborted PUT body …` | 中断即删 `.part`，目录清空 | 保留 `.part`（32 字节前缀），供下一次 offset 续写 |
| `aborted PUT over an in-memory link …` | 目录清空 | 带 content-length 时保留 `.part`（这正是中继 RST 的真实形态） |
| `PUT writes to a unique .part-<id>` | 随机名 | 确定名 `…part-<sha 前 16>` |
| `orphan .part … pruned on the next start` | 立即清 | 只清超过 24 h 的（用例把 mtime 拨老两天） |
| `GET /api/system/info upgradeCapabilities` | 三项 | 四项（含 `staged-package-resume`） |
| `push NODE_UNREACHABLE …` | 一次即失败 | 链路类失败重传 3 次后失败（错误文案不变，用例注入 no-op sleep） |

## 验收

| 项 | 结果 |
| --- | --- |
| `apps/gateway` `bun test` | 4496 pass / 1 fail（414 文件）。唯一失败是 `src/mesh/rtc/ice.test.ts` 的 `binds RTC to one concrete peer address …`（`bindAddress` 期望 undefined 实得 `localhost`），属并行 agent 在 RTC/ICE 的在途改动，与本任务无关。我的相关子集 `bun test src/system/ src/api/ src/mesh/` 全绿（1853 pass / 0 fail，135 文件）|
| `apps/fe` `bun test src/` | 2406 pass / 0 fail（137 文件）|
| `packages/shared` `bun test` | 713 pass / 0 fail（`bun run build:i18n` 之后）|
| `bunx tsc --noEmit -p apps/gateway` | 我的文件 0 error（`mesh/relay-stream-router.ts` 有一处 TS2322，属并行 agent 的在途改动，不在我的范围） |
| `bunx tsc --noEmit -p apps/fe` / `-p packages/shared` | 0 error |
| `bunx biome check <改动文件>` | clean |
| `bun scripts/complexity/gate.ts` | 我引入的 2 处 CC>15（`watchUpgrade`、`safeUnreachableReason`）已重构消除；三处文件行数上调 allowlist；剩余违规均属其他 agent 的范围 |

## 注意事项 / 遗留

1. **`scripts/complexity/allowlist.json` 是并行 agent 共用文件**。我按 key 做了 read-modify-write（只动
   `use-node-upgrade.ts` 1283→1362、`system/upgrade.ts` 970→1087、新增 `remote-upgrade-job.ts` 712；
   并删掉已不再超标的 `upgrade.ts:stagePackageLocked`）。若别的 agent 在我之后整体重写该文件，需要复核这三项还在不在。
2. **`content-length` 是续传判定的基石**。推送端必须如实声明剩余长度（入口已按 `total - offset` 填）。
   走 chunked 而无 content-length 时退化为旧行为（收完即校验 sha，不符就删），不会更糟但也没有续传保护。
3. **下载阶段仍是固定预算**：`progress.phase='download'` 期间 `pushedBytes` 恒为 0，指纹不变，FE 预算不会重算。
   后端下载超时 10 min > FE 的 6 min，慢网下仍可能先报「未确认」。要彻底解决需要入口把下载字节数也报上来——本轮未做，
   属既有行为，未因本轮变差。
4. **旧目标（无 `staged-package-resume`）只能从零重传**，13.5 MB 会重发。这是协议约束；等目标升到 1.1.31+ 自动走续传。
5. **在途流保护（P0-2）不在本任务范围**：`dropPeer` / `uplink-pool` 切换仍会打断在途流。本轮做的是「打断后能接上」，
   由另一 agent 负责「尽量别打断」。两者叠加才是完整方案。
6. 未做真机实测（本轮为纯单测验证）。上线前建议按 EX1 的复现路径跑一次：经中继给远端节点推包，中途重启中继或顶号，
   观察节点侧 `.part` 是否保留、入口是否只补发剩余字节、UI 是否显示「推送中 x / y」而不是超时。
