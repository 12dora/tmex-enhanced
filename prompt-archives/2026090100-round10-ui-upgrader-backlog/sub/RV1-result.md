## 结论

暂不建议合并。发现 **4 个 Blocker、3 个 Should-fix**。其中 review-J 的 SHA256SUMS、PID 归属和恢复阶段问题仍未完全关闭。

### Blocker

1. **旧版本在 `--allow-unverified` 下仍会接受 HTTP 200 但缺少目标条目的 SHA256SUMS**

   [upgrade-verify.ts:59](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-verify.ts:59) 将 `sums.missing && !sums.hex` 与真正的 404 一并放行；但 [release-fetch.ts:121](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/release-fetch.ts:121) 对“HTTP 200、没有匹配条目”正是返回 `missing: true, unpublished: false`。

   失败序列：

   1. 执行 `tmex upgrade --version 1.1.0 --allow-unverified`。
   2. tarball 下载成功。
   3. `SHA256SUMS` 返回 200，但没有 `tmex-cli-1.1.0.tgz`。
   4. `fetchReleaseSha256Sums()` 返回 `{ hex: null, missing: true, unpublished: false }`。
   5. `assertReleaseIntegrity()` 因 `allowUnverified` 在第 63 行直接返回。
   6. 未验证 tarball 被解压并应用。

   测试漏掉了决定性组合：[upgrade-verify.test.ts:71](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-verify.test.ts:71) 只测试“200 缺条目且没有 allow flag”，没有测试带 `allowUnverified: true`。

2. **install.sh 校验的是 SHA256SUMS 行中指定的路径，不一定是刚下载的 tarball**

   [install.sh:277](/Users/konata/code/tmex-enhanced-wt-upg/install.sh:277) 只做文件名后缀匹配，随后 [install.sh:283](/Users/konata/code/tmex-enhanced-wt-upg/install.sh:283) 把远端清单中的原始整行交给 `shasum -c`。绝对路径或 `../` 路径会让校验器读取临时目录之外的文件。

   失败序列：

   1. installer 下载待安装包到 `$TMEX_INSTALL_TMP/tmex-cli-1.1.4.tgz`。
   2. HTTP 200 的 SHA256SUMS 包含 `H  /tmp/tmex-cli-1.1.4.tgz`。
   3. `/tmp/tmex-cli-1.1.4.tgz` 是另一个现存文件，摘要确实为 `H`。
   4. 后缀 grep 接受该行，`shasum` 校验绝对路径文件并成功。
   5. installer 随后解压的是未经校验的 `$TMEX_INSTALL_TMP/tmex-cli-1.1.4.tgz`。

   应解析严格的目标文件条目并自行比较 `$tgz` 的摘要，不能把清单中的 pathname 直接交给校验工具。现有“无精确条目”测试只用了 `other-file.tgz`，没有覆盖路径限定条目。

3. **none-mode PID 归属仍可能误判并向未验证进程发送信号**

   有两个独立问题：

   - [upgrade-process.ts:170](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-process.ts:170) 和 Web 的 [upgrade.ts:358](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/system/upgrade.ts:358) 都只是 `cmdline.includes(runtimePath)`。旧纯数字 pid 文件没有启动身份，因此 `vim <install>/current/runtime/server.js`、`tail -f .../server.js` 等进程也会被认为属于 tmex。
   - [upgrade-process.ts:218](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-process.ts:218) 只在进入 `stop()` 时检查一次；[killPidAndWait():68](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-process.ts:68) 在 SIGTERM 和稍后的 SIGKILL 前都不重新校验 cmdline/identity。

   失败序列 A：

   1. stale `tmex.pid` 的 PID 被复用为编辑/查看 `server.js` 的进程。
   2. Web 和 apply CLI 的 substring 检查都通过。
   3. `stop()` 对该进程发送 SIGTERM/SIGKILL。
   4. rollback 随后可继续到 [upgrade-apply.ts:337](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:337) 恢复数据库。

   失败序列 B：

   1. `assertOwnedLive()` 正确验证原 tmex 进程。
   2. 该进程在验证后退出，PID 在发送 SIGTERM 前被复用。
   3. `killPidAndWait()` 只检查 PID 存活，向新进程发送 SIGTERM。
   4. 更严重的是，SIGTERM 后等待期间也可能发生 PID 复用，第 79 行会向新进程发送 SIGKILL。

   review-J 明确要求在 SIGTERM/SIGKILL 前再次验证；当前实现和测试均没有覆盖这一点。

4. **`started` 阶段恢复仍会重复启动服务**

   [upgrade-apply.ts:708](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:708) 在启动服务前写入 `started`；但 `repairVerifyOrRollback()` 在 [upgrade-apply.ts:475](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:475) 无条件再次调用 `service.start()`，没有先执行 `isRunning()`。

   失败序列：

   1. journal 写成 `started`。
   2. none-mode `service.start()` 成功启动新 runtime。
   3. upgrader 在 health check/commit 前崩溃。
   4. repair 进入 `verify_or_rollback`，再次 spawn `run.sh`。
   5. 第二个进程覆盖 `tmex.pid` 后因端口冲突退出，而第一个健康进程仍在运行。
   6. health check 可能命中第一个进程并完成 commit，但 pid 文件指向已退出的第二个进程，留下无法正常停止的运行实例。

   新测试只覆盖了 `backup` journal 的“运行时不重复 start”，见 [upgrade-apply.test.ts:640](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.test.ts:640)，没有覆盖 `started` 崩溃窗口。

### Should-fix

1. **preflight 仍执行 import-time runtime 初始化**

   `runtime.ts` 静态导入 `transfer-session`，该模块在 [transfer-session.ts:234](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/files/transfer-session.ts:234) 无条件启动 GC interval。静态导入的 `tunnelManager` 也在 [manager.ts:1188](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/tunnel/manager.ts:1188) 构造，构造期间打开 ORM DB 并注册全局 access guard。

   Telegram/微信、push、agent、watch、tunnel 外部进程、TLS、mesh 和远程 session restore 的显式启动链已经被正确跳过；但“preflight 不启动任何组件”的严格不变量仍不成立。测试只注入 `liveStart` 计数器，无法发现 import-time timer/constructor。

2. **delegated apply 的所谓端到端测试绕过了实际修复接线**

   [commands/upgrade.test.ts:302](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/commands/upgrade.test.ts:302) 自建测试 wrapper，并在 [commands/upgrade.test.ts:321](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/commands/upgrade.test.ts:321) 直接调用：

   ```ts
   repairUpgrade(..., { activeTxnId: txn })
   ```

   它没有经过生产 `runUpgrade()` / `runLockedUpgrade()`，因此即使 [commands/upgrade.ts:263](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/commands/upgrade.ts:263) 将来漏传 `activeTxnId`，测试仍会通过。应至少有一个测试执行真实 `bin/tmex.js` 或直接调用生产命令入口。

3. **1.1.4 版本门槛对预发布版本不一致**

   CLI 的 [semver.ts:9](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/semver.ts:9) 和 install.sh 的 [install.sh:50](/Users/konata/code/tmex-enhanced-wt-upg/install.sh:50) 忽略 prerelease，将 `1.1.4-beta` 当作达到门槛；Web 的 [semver.ts:32](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/system/semver.ts:32) 则判定它低于 `1.1.4`。目前 Web 对旧版本同样 fail-closed，因此不会形成直接绕过，但三入口政策及错误语义并不一致。

### 其余重点结论

- 活动 txn staging 的保留接线正确，missing-journal 和 terminal repair 都会传递 `activeTxnId`。
- missing-journal repair 已不再删除 legacy 顶层目录。
- `TMEX_RUNTIME_MODE=preflight` 从 `runPreflight → server → assemble → gateway runtime` 的显式接线正确，主要外部服务不会启动。
- 1.0.2 的 `{status:'ok'}` rollback/repair 路径已接入 `statusOnly`。
- `stopping → backup → switching` 的 journal 顺序正确，消除了 review-J 指出的 stop 前写 `backup` 和活库备份窗口；剩余双启动问题位于 `started` 恢复。
- upgrade flag 已统一为同一 `UPGRADE_FLAGS`；`txn/no-service/version/apply-current-package` 均被接受，`allow-unverified` 不在 delegated passthrough 列表中。
- Web 入口与 install.sh 的常规 404、缺条目、摘要不匹配策略为 fail-closed；CLI 和 install.sh 仍分别存在上述 Blocker。

本次按只读要求进行静态审查，未运行会创建临时文件、数据库或子进程的测试套件；实现者报告中的测试结果未作为独立验证结论。