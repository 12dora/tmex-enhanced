## 结论

不建议合入。发现 **3 个 blocker、7 个 should-fix、1 个 nit**。其中最严重的问题是：新端点允许请求方自行指定摘要并上传可执行包，在 standalone 开放认证模式下会形成未认证代码执行。

以下行号以提交 `f35358fe` 为准。

## Blocker

1. **[blocker] staged 端点把“触发官方升级”扩大成“上传并执行任意代码”。**  
   [apps/gateway/src/api/system.ts:116](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/api/system.ts:116)、[apps/gateway/src/system/upgrade.ts:376](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/upgrade.ts:376)、[apps/gateway/src/mesh/session-middleware.ts:38](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/session-middleware.ts:38)

   失败场景：standalone 且未启用本地认证时，API 鉴权会开放短路。请求方可以制作包含恶意 `package/bin/tmex.js` 的 tarball，自行计算其 SHA256，先 PUT，再 POST `{source:"staged"}`。目标只验证“文件等于请求方提供的摘要”和包结构，随后以服务用户启动该脚本。原 POST 最多触发受信 GitHub Release；新路径变成任意代码执行。

   应至少将 staged PUT/POST 限制为已验证的 peer-forwarded 请求，或验证不可由上传者伪造的官方/入口签名。仅校验请求方同时提供的 SHA256 不是来源认证。

2. **[blocker] PUT 与 POST 之间仍存在换包 TOCTOU，且并发 PUT 共用同一个 `.part`。**  
   [apps/gateway/src/system/upgrade.ts:188](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/upgrade.ts:188)、[apps/gateway/src/system/upgrade.ts:202](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/upgrade.ts:202)、[apps/gateway/src/system/upgrade.ts:242](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/upgrade.ts:242)、[apps/gateway/src/system/upgrade.ts:377](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/upgrade.ts:377)

   失败场景：两个 entry/hub 同时向同一目标、同一版本上传时，都能在 `idle` 状态通过检查，并打开同一个 `.part`。其中一个 POST 验证旧文件并将 controller 置忙；另一个已经获准的 PUT 仍可随后删除并替换最终文件。`run()` 虽再次哈希，但哈希完成到 `tar` 子进程实际打开路径之间仍可发生 rename，导致提取的不是已验证 inode。并发 PUT 本身也会造成 `.part` 互相截断、rename 失败或记录与文件不一致。

   上传和启动必须共用互斥状态；启动时应原子地把目标包移入当前 txn 的不可再覆盖路径，再对该路径校验、提取。

3. **[blocker] 下载缓存写失败可能以未处理 `error` 事件终止 gateway。**  
   [apps/gateway/src/system/release-download.ts:179](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/release-download.ts:179)、[apps/gateway/src/system/release-download.ts:205](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/release-download.ts:205)

   `writeAll()` 在 `ws.write()` 返回 `true` 后立即移除唯一的 `error` listener。若文件异步打开失败、磁盘满或后续写入失败，`WriteStream` 会发出无人监听的 `error`。我用仓库 Bun 1.3.14 复现了该模式：脚本继续打印后仍以 exit code 1 退出。远程升级遇到缓存目录不可写时可能直接杀死入口 gateway，而不是让 job 进入 failed。

   应为流的完整生命周期保留错误处理，或使用带正确关闭/错误传播的 pipeline。

## Should-fix

4. **[should-fix] 超限时 `reader.cancel()` 会重置 peer 双工流，目标很可能无法返回要求的 413。**  
   [apps/gateway/src/system/upgrade.ts:217](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/upgrade.ts:217)、[apps/gateway/src/mesh/stream-targets.ts:140](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/stream-targets.ts:140)

   peer 请求体的 `cancel()` 会执行 `stream.reset('request-cancelled')`。目标随后虽然构造 413，但响应头已无法写回；入口最终看到的可能是 `503 NODE_UNREACHABLE`，remote job 记录错误的 push 失败原因。现有 size-cap 测试直接调用 controller，没有覆盖真实 peer link。

   同时 [apps/gateway/src/api/system.ts:116](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/api/system.ts:116) 未根据 `Content-Length` 提前拒绝已知超限请求，因此仍会传输并落盘约 256 MiB。应先做可信范围内的 header 快速拒绝，再保留逐块计数兜底，并确保提前响应不会重置响应通道。

5. **[should-fix] detached job 没有自己的截止时间，链路半开时会永久占用该节点 job。**  
   [apps/gateway/src/system/remote-upgrade-job.ts:85](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/remote-upgrade-job.ts:85)、[apps/gateway/src/system/remote-upgrade-job.ts:120](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/remote-upgrade-job.ts:120)、[apps/gateway/src/mesh/forwarder.ts:272](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/forwarder.ts:272)、[apps/gateway/src/system/release-download.ts:80](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/release-download.ts:80)

   从浏览器 Request 分离是正确的，但新 Request 的 signal 永不 abort；PUT/POST forward 没有超时，`SHA256SUMS` fetch 也没有 timeout。若 peer 不关闭但停止发送响应头，job 会永远保持 running，状态永远是 downloading，后续启动永远 409。

   每个 download/push/start 步骤需要独立超时；失败路径还应显式取消未被 forwarder 接管的文件流。

6. **[should-fix] 第二次启动不是稳定返回 409，因为 active-job 检查发生得太晚。**  
   [apps/gateway/src/system/upgrade-service.ts:88](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/upgrade-service.ts:88)、[apps/gateway/src/system/upgrade-service.ts:234](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/upgrade-service.ts:234)、[apps/gateway/src/system/remote-upgrade-job.ts:81](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/remote-upgrade-job.ts:81)

   第二个请求先查询 GitHub latest、再 GET 目标 info，最后才检查 job map。若第一项 job 正在运行，而此时 GitHub 或目标暂时不可达，第二个请求会返回 502/503，而不是规格要求的 `409 UPGRADE_IN_PROGRESS`。现有测试只直接调用 `startRemoteUpgradeJob()`，没有从服务入口覆盖该顺序。

7. **[should-fix] failed job 的十分钟保留期从“开始时间”计算，而不是“失败时间”。**  
   [apps/gateway/src/system/remote-upgrade-job.ts:50](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/remote-upgrade-job.ts:50)

   失败发生在启动 9 分 59 秒后时，错误只能读取约一秒；若 push 卡住十分钟后才失败，下一次状态查询会立即删除失败记录并直接转发目标状态。应记录 `failedAt`，从失败时刻计算 TTL。

8. **[should-fix] crash-safe upgrader会把 `staged/` 和 `release-cache/` 当作孤儿事务删除。**  
   [packages/app/src/lib/upgrade-gc.ts:89](/Users/konata/code/tmex-enhanced-wt-r13/packages/app/src/lib/upgrade-gc.ts:89)、[packages/app/src/lib/upgrade-gc.ts:95](/Users/konata/code/tmex-enhanced-wt-r13/packages/app/src/lib/upgrade-gc.ts:95)、[apps/gateway/src/system/remote-upgrade-job.ts:191](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/remote-upgrade-job.ts:191)

   `--apply-current-package --txn X` 会保留 `staging/X`，所以当前已解压包可以正常找到；但 `sweepOrphanStaging()` 会删除除此之外的所有名称，包括新保留目录。具体影响：

   - 目标升级启动后会删除全部其他 staged 包和 sidecar，重启恢复及最多保留两份的设计失效。
   - entry 正在执行远程下载/推送时若同时自升级，本地 upgrader 可删除正在写或即将打开的 `release-cache`，导致 rename、stat 或 push 失败。
   - [apps/gateway/src/system/upgrade.ts:694](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/upgrade.ts:694) 的本地升级还把缓存放在 txn 内的 `.release-cache`，每次升级都重新下载，并非要求的共享 `<stageRoot>/release-cache`。

   应把 `staged`、`release-cache` 设为保留名称，并让本地与远程下载共同使用 stage root 下的缓存。

9. **[should-fix] 成功收流后的 rename、sidecar 写入不在清理保护范围内。**  
   [apps/gateway/src/system/upgrade.ts:242](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/upgrade.ts:242)、[apps/gateway/src/system/release-download.ts:146](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/release-download.ts:146)

   若 rename 失败，`.part` 会残留；若 sidecar 写入失败，最终 `.tgz` 会作为无记录孤儿保留。接口可能直接 reject，而不是稳定返回 `STAGE_FAILED`；磁盘中孤儿也不参与 TTL/数量裁剪。release cache 有同类问题。应把 finalize 阶段纳入 `try/finally`，失败时清理对应 part/final/sidecar。

10. **[should-fix] staged 校验同步读取并重复哈希整个文件，会阻塞 gateway 事件循环。**  
    [apps/gateway/src/system/upgrade.ts:273](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/upgrade.ts:273)

    remote POST 总会提供 sha，因此每次 `requireStaged()` 会对同一缓冲区计算两次摘要；`tryStart()` 和异步 `run()` 又分别调用一次。接近 256 MiB 上限时会进行多次同步全文件读取/哈希，使所有 API 和 peer 流停顿，并产生很大的瞬时内存占用。应流式校验一次，并基于原子消费后的文件继续提取。

## Nit

11. **[nit] 非法 `source` 被静默当成 `release`。**  
    [apps/gateway/src/api/system.ts:90](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/api/system.ts:90)

    `{source:"stage", version:"..."}` 不会返回 400，而会意外走目标自行下载路径。建议显式拒绝非 `release|staged` 的值。

## 已确认正常

- `version` 正则不允许 `/`、`\` 等路径分隔符，`sha256` 严格限制为 64 位十六进制；当前文件名构造没有直接路径穿越。版本长度未设上限，但主要结果是 `ENAMETOOLONG`/500。
- 新目录和新文件分别请求 `0700`、`0600`；新建路径权限合理。
- release override 只来自进程环境变量，没有从 HTTP 请求读取，不能由本次请求构造 SSRF。
- 默认 `TMEX_RELEASE_BASE_URL` 使用 `RELEASE_REPO_URL`，值为 `https://github.com/12dora/tmex-enhanced`；`update-check.ts` 使用同一仓库的 `https://api.github.com/repos/12dora/tmex-enhanced/releases/latest`，仓库匹配。
- 无 capability 的旧目标仍走原 POST release 路径；managed build 不公布 capability，并对 package 路由返回 403。
- hand-off 后删除 overlay 并转发目标状态的逻辑符合规格。
- raw-body happy path保持逐块背压，3 MiB 内存链路测试证明能跨多个 1 MiB window；但尚未覆盖超限、目标提前响应、源流错误和链路永久停滞。
- `--apply-current-package` 能保留当前 txn；当前包已在 child spawn 前解压到 `<installDir>/staging/<txnId>/package`，CLI 的 package-layout fallback 可以从自身位置找到包。问题是保留目录之外的新缓存目录会被清理。

现有测试覆盖了主要 happy path、SHA mismatch、controller 级 size cap、legacy target、download/push failure 和 hand-off，但没有覆盖上述安全边界与真实失败场景，尤其是开放认证上传、PUT/POST 并发换包、peer 413、写流异步错误、超时、failedAt TTL，以及 CLI 垃圾清理与 remote job 并发。