## 结论

不通过。存在 5 个 blocker，会破坏“取消后零残留”或使 Stop 实际无法停止升级。

## Findings

1. **blocker — PUT 已在目标落盘、但入口尚未收到响应时，取消会留下完整 staged 包。**  
   [`cancelRemoteUpgradeJob()`](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/remote-upgrade-job.ts:163) 仅在 `job.pushed === true` 时删除目标包，而该标记直到 PUT Promise 返回后才设置（[remote-upgrade-job.ts:243](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/remote-upgrade-job.ts:243)）。若目标已写完 `.tgz` 和 `.json`、响应仍在链路中，此时 Stop 会 abort 请求并返回“已取消”，却跳过 DELETE，文件永久保留。现有测试只覆盖 `pushed=true` 后阻塞 POST，没有覆盖 PUT 已提交但 ACK 未到的窗口。目标侧 DELETE 与 PUT 也未串行化（[upgrade.ts:234](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/upgrade.ts:234)），不能可靠补救这一竞态。

2. **blocker — 取消与 staged POST handoff 竞态时，入口会谎报已取消，而目标继续安装。**  
   入口在整个 `start` 阶段仍把 job 视为可取消（[remote-upgrade-job.ts:266](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/remote-upgrade-job.ts:266)）。如果目标已经接受 POST、把包移进 txn，甚至已越过 `commitStarted`，但响应尚未回到入口，Stop 会 abort transport、DELETE 已不存在的 staged 包，然后把 job 标为 `cancelled`（[remote-upgrade-job.ts:286](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/remote-upgrade-job.ts:286)）。FE 随即停止 watcher并显示“已取消”，目标却继续 executing。它不会杀死 applier，但状态结论严重错误；此时应向目标取消并透传 `UPGRADE_NOT_CANCELLABLE`，或建立明确的 handoff acknowledgement。

3. **blocker — last-waiter 只覆盖远端 job，未覆盖共享同一缓存的本机升级。**  
   底层 [`downloadVerifiedRelease()`](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/release-download.ts:143) 的 inflight Promise 只保留第一个调用者的 signal，后续 waiter 的 signal 被忽略；远端 job 又在其外层维护另一套引用计数（[remote-upgrade-job.ts:400](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/remote-upgrade-job.ts:400)）。同一入口同时进行本机升级和远端节点升级、且版本相同时：

   - 本机先下载：远端最后一个 waiter Stop 无法 abort 底层下载，DELETE 可能等待完整下载结束。
   - 远端先下载：本机 Stop 可能删除仍被远端写入的 `.part`，导致另一个 job 失败。
   - 第一个 owner 取消会影响所有未计入同一引用表的消费者。

   必须在唯一的 cache-key inflight 层统一 waiter/ref/abort。

4. **blocker — crash prune 不删除孤儿 staged sidecar。**  
   staged start 先把 `.tgz` 移进 txn，再异步删除 `.json`（[upgrade.ts:583](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/upgrade.ts:583)）。若进程在两步之间崩溃，下一次 repair 会删除 txn，但 [`pruneOrphanStagedFiles()`](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/upgrade.ts:448) 只处理 `.part` 和无记录 `.tgz`，孤儿 `.json` 永久留下。`loadStagedFromDisk()` 遇到 sidecar 指向不存在文件时也只是跳过（[upgrade.ts:399](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/upgrade.ts:399)）。这直接不满足 crash mid-cancel + prune 的 sidecar 零残留要求。

5. **blocker — `pending` 阶段的 Stop 可以返回 NOT_RUNNING，随后原 POST 仍启动升级。**  
   FE 在 POST 前立即进入 pending（[use-node-upgrade.ts:415](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:415)），并把 pending 显示为可停止（[nodes-table.tsx:194](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:194)）。后端 POST 在注册 controller/job 前还会等待 latest 和目标 info；此时 DELETE 会得到 `UPGRADE_NOT_RUNNING`。FE 对该结果只弹 info、既不 abort POST 也不改变状态（[use-node-upgrade.ts:567](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:567)），POST 随后照常启动。这是可稳定出现的“按了停止仍升级”。

6. **should-fix — entry 1.1.12 + target 1.1.11 不能保证清理。**  
   1.1.11 宣告 `staged-package`，所以新入口仍选择 entry-side push（[upgrade-service.ts:339](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/upgrade-service.ts:339)），但旧目标没有两个 DELETE 路由。下载阶段 Stop 正常；截断 PUT 通常能清 `.part`；但 PUT 已完成后 Stop 的包删除只会收到 404，而且 `deleteStagedBestEffort()` 连非 2xx 都不记录（[remote-upgrade-job.ts:333](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/system/remote-upgrade-job.ts:333)）。用户仍看到“已取消”，目标留下 `.tgz`/sidecar。建议对 1.1.11 禁用 staged push，或新增明确的 cancel-capability。

7. **should-fix — 多轮 restore 的总并发可以超过 3。**  
   每次 `rows` 增加都会独立启动一个 `restoreUpgradeStates()`，而每个调用各自创建 3 个 worker（[use-node-upgrade.ts:520](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:520)、[use-node-upgrade.ts:820](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:820)）。第一批三个 GET 未结束时再增加三个节点，会出现六个并发请求。需要一个 hook 级共享队列/semaphore。

8. **should-fix — restore 与行内/批量启动不是严格互斥。**  
   节点在 GET 发出前就被加入 `restoredRef`（[use-node-upgrade.ts:816](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:816)），但行内 Upgrade 没有 `restoring` 门禁，`startAll()` 内部也未检查 restoring（[use-node-upgrade.ts:833](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:833)、[use-node-upgrade.ts:869](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:869)）。目标已 executing、restore GET 在途时点击 Upgrade：POST 可能先以 in-progress 结束并留下 failed；随后 `onActive` 因 `runExclusive` 已占用而被丢弃，且不会重试，最终没有 watcher。Upgrade-all 也存在 effect 启动到 `restoring` state 重渲染之间的可点击窗口。

9. **should-fix — 同一 nodeId 被移除后重新加入不会再次恢复。**  
   [`restoredRef`](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:713) 永不删除 ID。节点从列表消失后以相同 ID 重新出现，不会再次 GET，违反“列表 gains a node 时恢复”的字面要求。应按当前成员集清理记录，或记录 membership generation。

10. **should-fix — entry 1.1.11 + target 1.1.12 的 Stop 兼容表现不友好。**  
    正常情况下 1.1.11 FE 根本没有 Stop；若新 FE/缓存资源连到旧入口，旧入口对 mesh DELETE 返回 `405 method_not_allowed`。当前 FE 只把 501 的 `UPGRADE_CANCEL_UNSUPPORTED` 当兼容警告（[use-node-upgrade.ts:538](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:538)），因此用户看到通用失败 toast，而不是“该节点版本不支持中断”；watcher会继续。建议把该路径的 404/405 也映射为 unsupported。

11. **nit — Stop 没有 cancelling 状态。**  
    按钮点击后仍可再次点击（[nodes-table.tsx:205](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:205)）。并发双击可能得到一次 200、一次 `UPGRADE_NOT_RUNNING`，产生两条 info。后端磁盘状态本身是安全的，但体验嘈杂。

## 做得正确的部分

- 新 mesh DELETE 与 POST/GET 一样经过 `requireSession`；本地目标 DELETE 与原 release POST 保持相同开放模式；package DELETE 与 PUT 使用相同 staged 认证；managed build 对三个升级路径统一 403。
- `commitStarted` 在 spawn 前受 mutex 保护；直接目标取消不会 abort executing applier。远端 request signal 也不会直接杀目标子进程。
- 单一路径下的 aborted PUT 会删除唯一 `.part-*`；直接目标下载取消、staged extraction 取消及 cache 无 sidecar `.tgz` 清理方向正确。
- 普通双取消语义安全：目标第二次返回 `UPGRADE_NOT_RUNNING`；cancelled entry job 再取消仍返回相同 overlay。
- FE 对 `UPGRADE_CANCELLED` 的 restore、watcher和主动取消路径都使用 info，不会产生失败 toast；每节点 watcher AbortController、批量取消计数、executing/restarting 禁用 Stop，以及稳定状态下的行/批互斥均正确。
- 普通列表重渲染不会重复创建 watcher；`restoredRef` 与 `runExclusive` 能挡住常规重复恢复。

本次按要求只读审查，未修改文件；`git diff --check` 干净。