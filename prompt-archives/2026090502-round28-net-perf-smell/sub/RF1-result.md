# RF1：R-backend 五项修复 + 推包进度补充

## 1. 隧道自愈的取消语义（P1-1）

- `tunnel/edge-recovery.ts`：新增 generation，`reset()` 兼作取消点，并把 `EdgeRecoveryToken`（`cancelled` getter）透传给 `restart`。DoH 解析返回后先校验 token 才继续。
- `tunnel/manager.ts`：`restartWithEdge(edge, token)` 在停旧进程**前后**各校验一次（后置还比对 `lastStartOpts` 是否被手动启动换掉）；`startProcess` 开头即 `edgeRecovery.reset()`（原来的重复 reset 已删）；`jobRemove` 补 `resetEdge()`。
- `stop`/`jobStop`/`jobRemove`/`startProcess` 都在 `supervisor.stop()` 之前同步作废 token，恢复流程从 token 校验到 `supervisor.stop()` 之间无 await，不会被插入。
- 测试：`edge-recovery.test.ts`（新建，3 例）+ `manager.test.ts`「a stop while the recovery resolution is pending does not restart the tunnel」。已验证：去掉 token 校验后这两个用例会红。

## 2. 整长度 `.part` 的续传（P1-2）

- `system/remote-upgrade-job.ts`：`readPushedOffset` 改回 `{ offset, complete }`，**只有 `complete === true` 才跳过 PUT**。`receivedBytes === totalBytes && !complete` 时按该偏移发零长度 PUT（`content-length: 0`），由目标校验 sha256 并提交。
- 目标若判 `PACKAGE_SHA256_MISMATCH`，`shouldReuploadFromZero` 允许**退回整包重传一次**（只退一次，之后照常失败收尾）。
- 接收侧 `api/system.ts`：`offset > 0` 且 `req.body` 为空时补一条空流（直连 HTTP 下 `content-length: 0` 的 PUT 会让 `req.body` 为 null），`upgrade.ts` 的 `truncatedTransfer` / 前缀 hash / commit 路径原样走通，正式包与 sidecar 均落位。
- 测试：`remote-upgrade-job.test.ts` 两例（零长度收尾成功；收尾被判 sha 不符后整包重传）、`upgrade.test.ts` 一例、`api/system.test.ts` 一例（无请求体的收尾 PUT → 200 + tgz + json sidecar）。

## 3. DoH 预算（P1-3）

- `tunnel/edge-resolver.ts`：一次 `resolveEdgeViaDoh` 内维护 `DohRunState`（成功端点 `preferred` 优先复用、超时端点进 `timedOut` 跳过）；`requestSignal` 暴露 `timedOut`，`dohQuery` 把自身超时归为 `DohTimeoutError`（HTTP 5xx/网络错不算，仍会重试该端点）。所有端点都超时时回落到全量列表，仍受总预算约束。
- `resolveEdgeViaDoh` 新增第 4 参 `{ requestTimeoutMs }`，仅供测试注入。
- 测试：`edge-resolver.test.ts`「skips the endpoint that timed out and reuses the one that answered」——注入时钟，Cloudflare 黑洞（每次吃 5 s 预算）、Google 正常，断言 Cloudflare 只被打一次、两次 A 查询都走 Google 且解析成功。旧实现在该用例下解析失败。
- 未做并行 SRV 查询（可选项）：串行 + 端点跳过已把最坏路径从「5+5 s 耗尽」降到「5 s 一次」。

## 4. 自愈解析结果直接用于 spawn（P1-4）

- `tunnel/supervisor.ts`：`start(opts, edgeOverride)` 记住 override（含崩溃自动重启期间沿用，`stop()` 清空），`spawnChild` 传给 provider。
- `tunnel/provider.ts`：`spawnNamedRun` / `spawnQuickRun` 新增 `edgeOverride`，`resolveEdgeForSpawn(override)` 有 override 就直接用，不再二次解析。
- 测试：`manager.test.ts`「reuses the recovery resolution even when the provider cannot resolve again」——第三次及以后解析抛错，进程仍带 `--edge 198.41.192.7:7844`。旧实现该用例红。

## 5. 转发重试重建请求体（P2-5）

- `mesh/forwarder.ts`：`forwardAuthorizedHttp` 里的 JSON 体改为每次尝试用 `nextBody()` 重建；`rawBody` 仍只计一次尝试（`countStreamBytes` 包一层后复用同一条流）。
- 测试：`forwarder.test.ts`「显式重试逐次重建 JSON 体」——第一次尝试取 reader 后断链（流保持 locked），第二次仍成功并收到完整 `{}`。

## 6. 长传进度（协调者追加项）

- `forwardAuthorizedHttp` 新增 `onProgress(uploadedBytes)`（`AuthorizedUpgradeForwardInput` 同步声明），由 `countStreamBytes` 驱动，节流为「≥ 1 s 或 ≥ 256 KiB 触发一次」。
- `remote-upgrade-job.ts` 的 `attemptPush` 用它把 `job.pushedBytes` 更新为 `offset + uploaded`（封顶 totalBytes），快照因此在 PUT 进行中就会增长，FE 的「有进度就重置预算」可以生效。
- 测试：`forwarder.test.ts`（真实节流，4×256 KiB → 至少 3 次回调、单调递增、末值等于总长）、`remote-upgrade-job.test.ts`（192 KiB 分块推送，逐块观察快照 `pushedBytes` 递增）。
- **下载阶段未接进度**：`release-download.ts` 的 `downloadVerifiedRelease` 走 inflight 共享（一个下载多个 waiter），没有现成的字节回调，且 job 的 `deps.download` 签名只有 `(version, signal)`；接进度要改共享结构与签名，超出本次范围，故跳过。

## 验收

- `cd apps/gateway && bun test src/tunnel src/system src/api src/mesh/forwarder.test.ts src/mesh/forwarder-unreachable.test.ts` → **912 pass / 0 fail**。
- `bunx tsc --noEmit -p apps/gateway` → 无错误。
- `bunx biome check` 对全部 16 个改动文件 → clean。
- `bun scripts/complexity/gate.ts` → 我的文件全部通过（未改 allowlist）。`manager.ts` 因新增校验超了 1425 行门禁，已就地压回 1424 行：把只有一个调用点的 `maybeRecoverEdge` 内联进 `connectorPollLoop`、删掉 `startProcess` 里重复的 `edgeRecovery.reset()`。仓库仍剩 1 条违规 `apps/fe/.../use-node-upgrade.ts`（非本人范围）。
- 未动 T11 的文件，未做任何 git 状态变更，未跑 e2e。
