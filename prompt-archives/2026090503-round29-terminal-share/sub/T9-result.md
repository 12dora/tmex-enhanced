# T9 结果：升级下载阶段的持续进度（KI-2）

## 做了什么

### 1. `apps/gateway/src/system/release-download.ts`

- 新增导出类型 `DownloadProgressFn = (downloadedBytes, totalBytes) => void`。
- `InflightWaiter` 加 `onProgress?`；`InflightDownload` 加 `downloadedBytes` / `totalBytes` 两个共享计数，
  订阅者集合就是原有的 `waiters`（无需第二个集合，settle / abort 时天然退订）。
- `downloadVerifiedRelease(version, { …, onProgress })`：owner 侧把回调装进
  `downloadVerifiedReleaseUncached`，扇出给全部 waiter；**后来者注册后立刻补发一次当前计数**
  （`downloadedBytes > 0 || totalBytes > 0` 才发，避免一次无意义的 0/0）。
- `downloadTarballToFile` 读 `content-length`（缺失 / 非法 / ≤0 一律按 0，新增 `parseContentLength`），
  在既有哈希 `Transform` 里节流上报：累计增量 ≥ 512 KiB **或** 距上次 ≥ 500 ms；`pipeline` 成功后再补一次
  完整计数（保证最后一次一定是 `bytes/total`）。
- 订阅方回调抛错被 `try/catch` 吞掉，不打断下载。

### 2. `apps/gateway/src/system/remote-upgrade-job.ts`

- `Job` 与 `RemoteUpgradeJobSnapshot` 新增**独立**字段 `downloadedBytes` / `downloadTotalBytes`
  （**没有**复用 `pushedBytes` / `totalBytes`）。
- `download` 依赖签名扩为 `DownloadFn = (version, signal?, onProgress?) => Promise<DownloadedRelease>`
  （第三参可选，既有注入 fake 的用例零改动）；`runDownloadPhase` 把回调写进 job 字段；
  `defaultDownload` 把 `onProgress` 透传给 `downloadVerifiedRelease`。
- **为腾出文件行数额度**（allowlist 记 712 行，改前 709 行，只剩 3 行余量）把与状态机无关的管道函数
  抽到新文件 `apps/gateway/src/system/remote-upgrade-io.ts`：`detachRequest` / `fileReadableStream` /
  `abortableSleep`（原 `defaultSleep`）/ `describeUpstream`。纯搬运，无行为变化。
  改后 `remote-upgrade-job.ts` 681 行、`remote-upgrade-io.ts` 67 行。

### 3. `packages/shared/src/contracts/system.ts`

`RemoteUpgradeProgress` 新增两个**可选**字段 `downloadedBytes?` / `downloadTotalBytes?`（对旧 hub / 旧节点
向后兼容）。`apps/gateway/src/system/upgrade-service.ts` 的 `remoteUpgradeProgress()` 一并下发。

### 4. 前端

- `types.ts`：新增 `NodeUpgradeTransfer { kind: 'download' | 'push'; transferredBytes; totalBytes }`，
  `NodeUpgradeEntry.push` **改名并泛化**为 `transfer?: NodeUpgradeTransfer | null`（下载 / 推包共用一条展示通道）。
- `upgrade-budget.ts`：`pushProgressOf` → `transferProgressOf`（push 阶段要求 `totalBytes > 0`；
  download 阶段要求 `downloadedBytes > 0`，`downloadTotalBytes` 允许为 0）；
  `upgradeProgressMark` 指纹加入 `downloadedBytes`——**下载字节的移动与推包字节同等看作进展**，
  慢但在动的下载按 download 阶段预算（10 min + 1 min 富余）重新计时，不再被判「未确认」；
  tracker 的 `onPush` → `onTransfer`。
- `use-node-upgrade.ts`：`upgradePhaseText` 第三参改为 `transfer`，下载阶段文案抽到 `downloadingText()`：
  push → `nodes.upgrade.statePushing`；download 且总量已知 → `nodes.upgrade.stateDownloadingBytes`
  （`formatBytesPair`）；总量为 0 → `nodes.upgrade.stateDownloadingSize`（`formatBytes`）；无进度 → 原
  `stateDownloading`。
- 文案键（三语齐全）：`nodes.upgrade.stateDownloadingBytes` = `Downloading {{progress}}` / `下载中 {{progress}}` /
  `ダウンロード中 {{progress}}`；`nodes.upgrade.stateDownloadingSize` = `Downloading {{size}}` / `下载中 {{size}}` /
  `ダウンロード中 {{size}}`。（跑了一次 `bun run --filter @tmex/shared build:i18n` 以便类型通过。）

### 5. 本机自升级（交付项 4）

**未接**。`UpgradeController.status()` 返回的 `UpgradeStatus` 里没有 `progress` 面（该字段合约上写明
「仅远程升级」），`stageGithubRelease` 也没有上报出口；按任务书「otherwise leave it」保留现状。另有硬约束：
`apps/gateway/src/system/upgrade.ts` 的 allowlist 文件行数上限是 1087，当前 1086 行，只剩 1 行余量，新开一条
进度通道必然破门禁。已在文档里写明这一限制。

### 6. 文档

- `docs/known-issues.md`：删除 KI-2 整节。**未重编号**（KI-3…KI-7 保持原号）——多个 agent 并发改同一文件，
  重编号会互相打架，请 commander 在全部落地后统一整理。
- `docs/update/2026090502-resumable-remote-upgrade-push.md`：新增「下载阶段的字节进度（1.1.32+，原 KI-2）」一节。

## 新增测试

`apps/gateway/src/system/release-download.test.ts`（新增 4 条，含分片流 + 可暂停 gate 的假发行源
`stubStreamedRelease`）：
- content-length 作为总量、100 × 64 KiB 分片按 512 KiB 门槛合并到 ≤ 30 次回调、单调递增、收尾补齐完整计数；
- 无 `content-length` → 总量恒为 0；
- **后来者**在下载卡住时订阅，立刻拿到当前计数（流是暂停的，所以收到的只可能是补发），并继续收后续上报；
- 下载结束后不再回调。

`apps/gateway/src/system/remote-upgrade-job.test.ts`（新增 1 条）：下载途中快照的 `downloadedBytes` /
`downloadTotalBytes` 跟着回调走，起步快照两者为 0，收尾时下载计数不污染 `pushedBytes` / `totalBytes`。

`apps/fe/.../use-node-upgrade.test.ts`：改写 `transferProgressOf` 用例（含 download 有/无总量、旧入口不报），
改写按钮文案用例（push / download 有总量 / download 无总量三分支），新增「下载字节一直在涨 → 预算重新计时，
不在六分钟处判超时」。

## 验证

- `apps/gateway`：`bun test src/system` → **170 pass / 0 fail**；`bunx tsc --noEmit -p .` 在 `src/system/`、
  `contracts/` 下 **0 error**（仓库里另有 `src/ws/share-*.test.ts` 的报错，属其他 agent 在途工作，非本任务）。
- `packages/shared`：`bun test` → **750 pass / 0 fail**；`bunx tsc --noEmit -p .` → **0 error**。
- `apps/fe`：`bun test src/pages/settings/nodes` → **748 pass / 0 fail**；`bun test src/` → 2546 pass，
  唯一失败是 `src/node/device-node-badges.test.tsx` 的 NodeLinkDiagnostics（其他 agent 在途，与升级无关）；
  `bunx tsc --noEmit -p .` 我的文件 0 error（`sidebar-node-section.tsx` / `mesh-events.ts` 的报错属其他 agent）。
- `bunx biome check <本任务 13 个文件>` → clean。
- `bun scripts/complexity/gate.ts`：本任务文件 **0 violation**（全部 9 条违规在 `mesh/**`、`fe/src/node/mesh-nodes.ts`、
  `packages/app`，均为其他 agent 在途文件）。

## 偏离 / 需要 commander 注意

1. **越界的最小改动**：`apps/fe/src/pages/settings/nodes/management/nodes-table.tsx` 第 374 行
   `entry.push` → `entry.transfer`（一处，随 `NodeUpgradeEntry` 字段改名）。
2. **新增文件**：`apps/gateway/src/system/remote-upgrade-io.ts`（为满足 `remote-upgrade-job.ts` 的 712 行
   allowlist 上限而做的纯搬运抽取）。`remote-upgrade-job.ts` 现 681 行，比 allowlist 记录低 31 行，
   后续可在统一 `--tighten` 时收紧（我没跑 `--tighten`，那会重写其他 agent 在途文件的条目）。
3. `docs/known-issues.md` 未重编号，见上。
4. 本机自升级的下载进度未做，理由见第 5 节。
