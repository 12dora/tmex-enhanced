# EX3 只读核验报告

审查基线为当前 HEAD `9e0f8962`，工作树未修改。结论：7 个 blocker 均仍适用；should-fix 中仅 UpgradeController early-exit、same-version、keepBackup 已完成，journal-less GC 只完成了一部分。

## 总结

| 项目 | 当前状态 |
|---|---|
| 1. 当前事务 staging 被 repair 清理 | 仍是 blocker |
| 2. missing-journal 删除旧顶层目录 | 仍是 blocker |
| 3. preflight 运行完整副作用 runtime | 仍是 blocker |
| 4. 1.0.2 无 startedAt 无法验证 | 仍是 blocker |
| 5. serviceMode=none PID 未做归属校验 | 仍是 blocker |
| 6. SHA256SUMS 404 fail-open | 仍是 blocker |
| 7. backup 阶段恢复可能重复启动旧服务 | 仍是 blocker |
| `upgrade-db.ts` argv | 仍适用 |
| native 离线复用 | 仍适用 |
| Web upgrade.log FD 泄漏 | 仍适用 |
| 1.0.2 shim 指向不存在 cli | 仍适用 |
| TLS listener readiness | 仍适用，工作量中等 |
| UpgradeController early exit | DONE |
| same-version no-op | DONE |
| keepBackup | DONE |
| journal-less GC | 部分 DONE，shim 临时文件清理未接入 |

## 1. 当前事务 staging 被 repair 清理

状态：仍是 blocker；此外当前合并还存在更早的 flag 白名单 blocker。

证据：

- `runLockedUpgrade()` 在读取 `--txn` 前调用 repair：[commands/upgrade.ts:284](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/commands/upgrade.ts:284)。
- 当前事务直到 [commands/upgrade.ts:290](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/commands/upgrade.ts:290) 才读取。
- 无 journal repair 会调用全量 staging GC：[upgrade-apply.ts:443](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:443)、[upgrade-apply.ts:445](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:445)。
- terminal repair 也会清理事务并执行全量 GC：[upgrade-apply.ts:508](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:508)、[upgrade-apply.ts:516](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:516)。
- `sweepOrphanStaging()` 只有收到 `keepTxnId` 才会保留事务：[upgrade-gc.ts:81](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-gc.ts:81)、[upgrade-gc.ts:90](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-gc.ts:90)；当前 repair 调用没有传。
- `cleanupTxn()` 也无保护当前事务的参数：[upgrade-apply.ts:292](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:292)。

实际 CLI 还会先撞上内部白名单：全局参数表接受 `txn`，但 `upgrade.ts` 的 `UPGRADE_FLAGS` 没有它。见 [args.ts:190](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/args.ts:190)、[upgrade.ts:189](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/commands/upgrade.ts:189)、[upgrade.ts:206](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/commands/upgrade.ts:206)。修复白名单后，staging 被 repair 删除的问题仍然存在。

修复计划：

1. 在 `runLockedUpgrade()` 进入 repair 前读取：

   ```ts
   const activeTxnId = asString(opts.parsed.flags.txn) ?? null;
   ```

2. 给 `UpgradeApplyDeps` 增加 `activeTxnId?: string | null`，并传入：

   ```ts
   repairUpgrade(installDir, bunPath, { service, activeTxnId });
   ```

3. 将 `activeTxnId` 继续传入：

   - `repairMissingJournal()`
   - `repairAbortCandidate()`
   - `repairRestartOld()`
   - `repairTerminalCleanup()`
   - `cleanupTxn()`
   - 所有 `sweepUpgradeGarbage()` 调用

4. `cleanupTxn()` 清理的 journal txn 若等于 `activeTxnId`，不得删除其 staging；`sweepUpgradeGarbage()` 使用 `keepTxnId: activeTxnId`。

5. apply 完成后再由正常 commit cleanup 清理当前事务。

测试计划：

- `upgrade-apply.test.ts`：无 journal 时保留 `staging/<activeTxn>`，同时删除另一个孤儿 staging。
- terminal journal 时保留当前活动 txn。
- `commands/upgrade.test.ts`：真实执行“下载 → tar 解压 → extracted `bin/tmex.js` → no-journal repair → apply”，最终断言目标版本提交成功，且 staging 只在 apply/commit 完成后清理。
- 测试 fixture 应使用实际构建的 CLI wrapper，而不是只记录 spawn 参数。

## 2. missing-journal repair 删除旧顶层目录

状态：仍是 blocker。

证据：

- `repairMissingJournal()` 先转换 legacy layout：[upgrade-apply.ts:444](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:444)。
- 随后在没有 committed 事实的情况下调用 `removeLegacyTopLevelDirs()`：[upgrade-apply.ts:446](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:446)、[upgrade-apply.ts:447](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:447)。
- 删除函数会删除顶层 `cli/runtime/resources/native`：[upgrade-gc.ts:47](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-gc.ts:47)、[upgrade-gc.ts:55](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-gc.ts:55)。
- 设计文档要求仅 committed 后删除，但当前 `finishCommittedCleanup()` 之外仍有 premature 调用：[upgrade-gc.ts:110](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-gc.ts:110)。

修复计划：

- 删除 `repairMissingJournal()` 中的 `removeLegacyTopLevelDirs()` 调用。
- `repairMissingJournal()` 只允许：
  - legacy layout 转换；
  - 清理孤儿 staging；
  - 清理临时文件。
- 顶层 legacy 目录只能由 `finishCommittedCleanup()` 删除。

测试计划：

- `upgrade-apply.test.ts` 增加 legacy fixture：
  - 顶层目录存在；
  - 当前旧服务仍运行；
  - missing journal repair；
  - preflight 失败。
- 断言：
  - 顶层目录全部保留；
  - old service 没有被 stop；
  - `current` 仍可启动；
  - journal/候选清理符合预期。

该项与 blocker 1 同时触碰 `repairMissingJournal()`，应合并设计测试，避免一个修复重新引入另一个问题。

## 3. preflight 仍会启动完整 runtime

状态：仍是 blocker。

证据：

- preflight 只设置 `TMEX_ROLES=standalone`：[upgrade-apply.ts:602](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:602)、[upgrade-apply.ts:609](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:609)。
- `createGatewayRuntime()` 仍会执行 Telegram/微信 refresh、push、agent、watch、tunnel 启动：[apps/gateway/src/runtime.ts:123](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/runtime.ts:123)、[runtime.ts:128](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/runtime.ts:128)。
- 启动通知仍会发送：[runtime.ts:130](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/runtime.ts:130)。
- `assembleTmex().start()` 无条件恢复远程 agent session：[assemble.ts:620](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/runtime/assemble.ts:620)、[assemble.ts:622](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/runtime/assemble.ts:622)。
- `server.ts` 仍启动 TLS：[server.ts:27](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/runtime/server.ts:27)、[server.ts:37](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/runtime/server.ts:37)。
- TLS/ACME 生命周期会被创建：[assemble.ts:333](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/runtime/assemble.ts:333)。
- `/healthz` 还会执行 tmux health 检查：[system-routes.ts:78](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/api/system-routes.ts:78)、[system-routes.ts:82](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/api/system-routes.ts:82)。

修复计划：

引入显式 runtime mode，而不是继续依赖 roles：

```ts
type RuntimeMode = 'normal' | 'preflight';
```

修改：

- `apps/gateway/src/runtime.ts`
  - `GatewayRuntimeOptions.mode?: RuntimeMode`
  - preflight 仍运行 migrations；
  - 跳过 seed、refresh、push、agent、watch、tunnel、通知；
  - 不执行远程 session restore。
- `packages/app/src/runtime/assemble.ts`
  - `AssembleTmexOptions.runtimeMode?: RuntimeMode`
  - preflight 分支不创建 auth/mesh/TLS/前端路由。
- `packages/app/src/runtime/server.ts`
  - preflight 只启动临时 HTTP server；
  - 不调用 `assembled.tls.startup()`。
- preflight `/healthz` 只返回：

  ```json
  {
    "status": "ok",
    "version": "...",
    "startedAt": 123
  }
  ```

  其他路径返回 404。

测试计划：

- 新增 `apps/gateway/src/runtime.preflight.test.ts`，或扩展 `packages/app/src/runtime/assemble.test.ts`。
- 为 refresh/start/notification/restore/TLS/tmux 增加 probe。
- 真实 preflight 启动后断言：
  - migrations 执行一次；
  - 所有外部服务调用为 0；
  - 没有 TLS/ACME；
  - 没有 tmux 调用；
  - `/healthz` 版本正确；
  - `/healthz` 之外返回 404。

当前 `upgrade-apply.test.ts:217` 的 tiny Bun health server 只验证升级器轮询，不会覆盖完整 gateway runtime 的副作用。

## 4. 1.0.2 healthz 缺少 version/startedAt

状态：仍是 blocker，而且 rollback 路径也受影响。

证据：

- `HealthzBody` 的字段是可选，但指定 `minStartedAt` 时必须能解析 `startedAt`：[upgrade-health.ts:38](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-health.ts:38)、[upgrade-health.ts:51](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-health.ts:51)。
- `verifyOldServiceRunning()` 无条件 `service.start()`：[upgrade-apply.ts:413](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:413)、[upgrade-apply.ts:420](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:420)。
- 随后无条件要求 `minStartedAt`：[upgrade-apply.ts:429](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:429)、[upgrade-apply.ts:431](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:431)。
- rollback 同样要求 `minStartedAt`：[upgrade-apply.ts:385](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:385)、[upgrade-apply.ts:389](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:389)。
- 当前测试只覆盖 1.1.3 的缺少 version，不覆盖 1.0.2 完整 body：[upgrade-health.test.ts:4](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-health.test.ts:4)。

修复计划：

新增共享的旧服务验证逻辑，例如：

```ts
verifyOldHealthz(
  installDir: string,
  journal: UpgradeJournal,
  healthCheck: HealthCheckFn,
  options: {
    serviceMode?: ServiceMode;
    restarted: boolean;
  }
)
```

规则：

- `serviceMode === 'managed'` 且 `fromVersion === '1.0.2'`：
  - 先确认 service manager 报告 running；
  - 只要求 HTTP `status === 'ok'`；
  - 不要求 `version`；
  - 不要求 `startedAt`。
- 1.1.3 继续允许缺少 version，但已重启时仍要求有效 `startedAt`。
- 若发现旧服务原本已经 running，则不得为了验证再次 `start()`，也不应强制新的 `startedAt`。
- 将该逻辑同时用于：
  - `verifyOldServiceRunning()`；
  - `rollbackToOld()`。
- `repairRestartOld()` 和 `repairVerifyOrRollback()` 需要传入 `serviceMode`。

测试计划：

- `upgrade-health.test.ts`：真实 Bun HTTP server 返回只有 `{status:'ok'}` 的 1.0.2 body，确认 status-only 模式通过。
- `upgrade-apply.test.ts`：
  - 1.0.2 managed service 停止后启动，status-only 验证成功；
  - rollback 到 1.0.2 成功；
  - 1.1.3 旧测试继续要求 startedAt。

## 5. serviceMode=none PID ownership 不安全

状态：仍是 blocker。

证据：

- Web 入口只用 `kill(pid, 0)` 判断 PID 存活：[apps/gateway/src/system/upgrade.ts:141](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/system/upgrade.ts:141)、[upgrade.ts:154](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/system/upgrade.ts:154)。
- `createDirectProcessControl.stop()` 对存活 PID 直接发送终止信号：[upgrade-apply.ts:149](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:149)、[upgrade-apply.ts:157](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:157)。
- direct `isRunning()` 也只检查 PID 存活：[upgrade-apply.ts:176](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:176)。
- `run.sh` 的目标 runtime 是 `current/runtime/server.js`：[install.ts:107](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/install.ts:107)、[install.ts:132](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/install.ts:132)。
- 已有可复用的 cmdline 和启动身份检测：[upgrade-process.ts:32](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-process.ts:32)、[upgrade-lock.ts:40](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-lock.ts:40)。

修复计划：

在 `upgrade-process.ts` 增加统一的归属检查：

```ts
assertOwnedInstallProcess({
  pid,
  installDir,
  expectedIdentity?,
  commandLine?,
})
```

允许的 runtime 目标至少包括：

- `<installDir>/current/runtime/server.js`
- `<installDir>/runtime/server.js`（legacy layout）
- 必要时包含其 realpath 形式。

同时：

1. 扩展 pid record，保存 PID、启动身份和 runtime 路径；继续兼容旧的纯数字 `tmex.pid`。
2. Web `assertNoneModePidOwnership()` 改用统一检查。
3. `createDirectProcessControl()` 增加 `installDir` 或 `ownedRuntimePaths` 参数。
4. `stop()` 在 SIGTERM/SIGKILL 前再次验证 cmdline/identity。
5. live foreign PID 不得被 `isRunning()` 当作 false；应抛 ownership error，防止后续 DB copy/restore。
6. 归属失败时不得删除 pid 文件，不得发送任何 signal。
7. `hasLivePidFile()` 不应继续只表示 PID 存活，必要时新增 `hasOwnedLivePidFile()`。

测试计划：

- Web：pid 文件指向一个真实存活但 cmdline 不属于该 install 的进程，断言不 spawn。
- direct control：foreign PID 上 `stop()` 抛错、不发信号、不删除 pid 文件。
- positive case：启动临时 `<installDir>/current/runtime/server.js` 进程，确认可以正常停止。
- 测试现有 Web 正例 `[system/upgrade.test.ts:327]`，不能再使用 `process.pid` 作为“合法 tmex PID”。
- 更新 `upgrade-process.test.ts` 当前使用普通 bash 进程的测试，使其明确区分 foreign/owned。

该项与 blocker 7 强相关：`service.isRunning()` 必须能区分“旧服务仍在运行”和“无关进程占用了 PID”。

## 6. SHA256SUMS 404 仍 fail-open

状态：仍是 blocker。

证据：

CLI：

- 404 被转换为 `missing: true`：[packages/app/src/lib/release-fetch.ts:100](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/release-fetch.ts:100)、[release-fetch.ts:115](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/release-fetch.ts:115)。
- CLI 对 missing 只记录 warning 并继续：[commands/upgrade.ts:129](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/commands/upgrade.ts:129)、[upgrade.ts:130](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/commands/upgrade.ts:130)。

Web：

- Web 同样把 404 视为 missing：[apps/gateway/src/system/upgrade.ts:297](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/system/upgrade.ts:297)、[upgrade.ts:312](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/system/upgrade.ts:312)。
- `stageGithubRelease()` 只有 sums 存在时才比较 digest：[upgrade.ts:327](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/system/upgrade.ts:327)、[upgrade.ts:332](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/system/upgrade.ts:332)。

install.sh：

- 404 只输出未校验警告：[install.sh:250](/Users/konata/code/tmex-enhanced-wt-upg/install.sh:250)、[install.sh:251](/Users/konata/code/tmex-enhanced-wt-upg/install.sh:251)。

修复政策：

- 目标版本 `>= 1.1.4`：
  - 必须 HTTP 200；
  - 必须存在精确 tarball entry；
  - 必须 digest 匹配；
  - 404 一律中止。
- 旧版本：
  - 只有显式 `--allow-unverified` 才允许 404；
  - CLI 默认不允许；
  - Web 永远不允许；
  - install.sh 也必须显式传 flag。

修复计划：

- 在 CLI `release-fetch.ts` 或 `upgrade-verify.ts` 添加统一策略函数，例如：

  ```ts
  assertReleaseIntegrity(
    version,
    bytes,
    sums,
    { allowUnverified }
  )
  ```

- `delegateUpgrade()` 传入并使用 `allowUnverified`。
- `stageGithubRelease()` 对 missing 直接 throw。
- install.sh 增加并剥离 `--allow-unverified`，不能把它传给 `tmex init`。
- 增加版本比较，CLI 可复用 `packages/app/src/lib/semver.ts`；Web 可复用自身的 `compareVersions()`。
- 更新设计文档中“所有版本 404 可继续”的描述：[docs/release/2026083101-upgrade-crash-safety.md:39](/Users/konata/code/tmex-enhanced-wt-upg/docs/release/2026083101-upgrade-crash-safety.md:39)。

测试计划：

- `commands/upgrade.test.ts`：
  - 1.1.0 + `--allow-unverified` 成功；
  - 1.1.0 无 flag 失败；
  - 1.1.4 + 404 即使有 flag 也失败；
  - 200 无 entry 失败；
  - digest mismatch 失败。
- `apps/gateway/src/system/upgrade.test.ts`：
  - 修改当前 404 仍成功的测试：[system/upgrade.test.ts:85](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/system/upgrade.test.ts:85)；
  - 新增 404 失败断言。
- `install-script.test.ts` 增加带 fake curl/tar 的完整下载策略测试，而不仅是 helper 测试。

## 7. journal 在 stop 前写入 backup

状态：仍是 blocker。

证据：

- `executeUpgradeTxn()` 在 stop 前推进到 `backup`：[upgrade-apply.ts:783](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:783)。
- 实际 `service.stop()` 在之后的 `backupAndSwitch()`：[upgrade-apply.ts:667](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:667)、[upgrade-apply.ts:675](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:675)。
- `backup`/`switching` 恢复动作都是 `restart_old`：[upgrade-state.ts:43](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-state.ts:43)。
- `verifyOldServiceRunning()` 无条件 start：[upgrade-apply.ts:419](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:419)。

修复计划：

建议采用显式 `stopping` 阶段：

1. `UpgradePhase` 增加 `'stopping'`。
2. `recoveryAction('stopping')` 映射到 `restart_old`。
3. 在 `service.stop()` 前写入 `stopping`。
4. 确认 `assertStopped()` 成功后写入 `backup`。
5. 然后复制 DB，再进入 `switching`。

同时保留对旧版本 journal 的兼容：

- 对已有 `backup` journal，`verifyOldServiceRunning()` 先调用 `service.isRunning()`。
- 若旧服务已经运行，不得再次 `start()`。
- 若未运行，才调用 `start()` 并重新验证。

测试计划：

- `upgrade-state.test.ts`：验证 `stopping -> restart_old`。
- `upgrade-apply.test.ts`：
  - `backup` journal + service running：`starts === 0`；
  - `backup` journal + service stopped：`starts === 1`；
  - stopping journal 能恢复；
  - stop 失败时不复制/恢复 DB。

该项与 blocker 4、5 共同影响 `verifyOldServiceRunning()` 和 `service.isRunning()`。

# Should-fix

## A. upgrade-db.ts argv off-by-one

状态：仍适用。

证据：

- `bun -e` 脚本读取 `process.argv[2]`、`process.argv[3]`：[upgrade-db.ts:40](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-db.ts:40)。
- 调用参数是 `-e`, script, src, dest：[upgrade-db.ts:53](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-db.ts:53)。
- Bun 实际 argv 为 `[bun, src, dest]`，因此脚本应读取 `[1]`、`[2]`。
- 失败后静默回退文件复制：[upgrade-db.ts:65](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-db.ts:65)。

修复：

- 将脚本改为 `process.argv[1]` / `process.argv[2]`。
- 对两个参数做非空校验。
- 测试真实 SQLite DB 的 `VACUUM INTO` 路径；最好为 `spawnSync` 增加可注入依赖，断言脚本收到的 argv。

## B. native addon 离线复用

状态：仍适用。

证据：

- `ensureCandidateNativeAddon()` 只要旧版本有 manifest，就直接调用 `enableDirect()`：[upgrade-native.ts:13](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-native.ts:13)、[upgrade-native.ts:21](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-native.ts:21)、[upgrade-native.ts:25](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-native.ts:25)。
- 当前 `reenableDirectIfNeeded()` 的本地 skip 只比较版本和文件存在，不验证 hash/platform/NAPI：[direct.ts:277](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/commands/direct.ts:277)、[direct.ts:309](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/commands/direct.ts:309)。

修复：

- 给 `ensureCandidateNativeAddon()` 增加 `pin?: NativePin | null`。
- 校验旧 addon：
  - 文件存在；
  - manifest 存在；
  - manifest SHA256 与文件匹配；
  - platform 等于 pin；
  - native version 等于 pin.version；
  - NAPI 版本匹配。
- 全部匹配时直接复制旧版本 `native/` 到候选版本，不调用 npm 下载。
- 不匹配时才调用 `enableDirect()`。
- 保留 `allowMissingNative` 语义。

测试：

- 有效本地 addon + `enableDirect` 设置为“若调用则失败”，升级仍成功。
- hash、platform、version、NAPI 任一不匹配时才重新安装。
- 无网络情况下有效 addon 可以完成升级。

## C. Web upgrade.log FD 泄漏

状态：仍适用。

证据：

- `spawnUpgrade()` 先打开 `upgrade.log`：[system/upgrade.ts:173](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/system/upgrade.ts:173)、[system/upgrade.ts:175](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/system/upgrade.ts:175)。
- 之后才执行 serviceMode=none PID 检查：[system/upgrade.ts:180](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/system/upgrade.ts:180)、[system/upgrade.ts:182](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/system/upgrade.ts:182)。
- close 只注册在 spawn/detach 成功路径：[system/upgrade.ts:209](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/system/upgrade.ts:209)。

修复：

- 先读取 service mode 和验证 PID ownership，再打开 log FD。
- 或用 `try/finally` 覆盖所有异常路径。

测试：

- serviceMode=none 且 PID 缺失/归属错误时，断言不创建 `upgrade.log`，并且无 FD 泄漏。
- 可扩展现有拒绝测试：[system/upgrade.test.ts:296](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/system/upgrade.test.ts:296)。

## D. legacy shim 指向不存在的 cli

状态：仍适用。

证据：

- legacy 转换复制存在的目录，但 `cli` 可以不存在：[upgrade-legacy.ts:28](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-legacy.ts:28)、[upgrade-legacy.ts:33](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-legacy.ts:33)。
- 随后无条件安装 shim：[upgrade-legacy.ts:41](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-legacy.ts:41)、[upgrade-legacy.ts:43](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-legacy.ts:43)。
- shim 目标固定为 `current/cli/bin/tmex.js`：[cli-shim.ts:183](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/cli-shim.ts:183)、[cli-shim.ts:189](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/cli-shim.ts:189)。

修复：

- 只有确认 `current/cli/bin/tmex.js` 存在时才写新 shim。
- 旧 layout 没有 CLI 时保留已有 shim，不写入不存在的目标。
- 如需支持 legacy CLI，显式允许 `<installDir>/cli/bin/tmex.js` 作为旧目标。
- 给 `convertLegacyLayout()` 增加隔离 shim 目录参数，便于测试。

测试：

- 构造没有顶层 `cli/` 的 1.0.2 layout。
- 转换后断言不会生成指向不存在路径的 shim。
- 已有 shim 内容保持不变。
- 有 CLI 的旧 layout 继续生成正确 shim。

## E. commit readiness 未检查 TLS listener

状态：仍适用，建议修复；工作量中等。

证据：

- commit 前只检查普通 HTTP `/healthz`：[upgrade-apply.ts:698](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:698)、[upgrade-apply.ts:713](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:713)。
- HTTPS listener 绑定失败会被捕获并记录，不会让启动失败：[https-listener.ts:45](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/tls/https-listener.ts:45)、[https-listener.ts:54](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/tls/https-listener.ts:54)。
- TLS startup 仍可能正常返回：[tls-service.ts:189](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/tls/tls-service.ts:189)。

当前 HTTP healthz 版本正确时，TLS hub listener 失败仍可能被 commit。

修复建议：

- 在 assembled `/healthz` response 中增加 TLS readiness，例如：

  ```json
  "tls": {
    "mode": "selfsigned",
    "listenerRunning": true
  }
  ```

- `HealthCheckOpts` 增加 `requireTlsListener?: boolean`。
- commit readiness 设置该选项；当 TLS mode 为 `selfsigned`/`acme` 时要求 listener running。
- `none`/`external` 模式不要求本地 HTTPS listener。
- preflight 不启用该检查，因为 preflight 应完全跳过 TLS。

测试：

- TLS self-signed 配置 + 端口占用，HTTP healthz 仍返回目标版本，但 listener 为 false；断言升级不 commit。
- listener 正常绑定时继续成功。
- `none`/`external` 模式不被错误阻断。

## F. UpgradeController early exit

状态：DONE。

证据：

- child 在 executing 状态退出会回到 idle：[system/upgrade.ts:120](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/system/upgrade.ts:120)。
- spawn 尚未完成时通过 `pendingEarlyExit` 记录：[system/upgrade.ts:127](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/system/upgrade.ts:127)。
- `run()` 在 spawn 返回后消费该状态：[system/upgrade.ts:103](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/system/upgrade.ts:103)。
- 已有测试覆盖 child early exit：[system/upgrade.test.ts:277](/Users/konata/code/tmex-enhanced-wt-upg/apps/gateway/src/system/upgrade.test.ts:277)。

## G. same-version no-op

状态：DONE。

证据：

- `applyUpgrade()` 在创建事务前比较 current/toVersion：[upgrade-apply.ts:843](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:843)、[upgrade-apply.ts:845](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:845)。
- 已有 no-op 测试：[upgrade-apply.test.ts:341](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.test.ts:341)。

注意：当前 `runLockedUpgrade()` 仍会先 repair；因此事务保护和 flag 白名单修复完成前，same-version 结论只针对 `applyUpgrade()` 内部逻辑。

## H. keepBackup

状态：DONE。

证据：

- `cleanupTxn()` 尊重 `keepBackup`：[upgrade-apply.ts:297](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:297)。
- commit journal 记录 keepBackup：[upgrade-apply.ts:333](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:333)。
- terminal repair 继续传递该标志：[upgrade-apply.ts:508](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.ts:508)。
- 已有测试覆盖后续 repair 不删除 backup：[upgrade-apply.test.ts:366](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-apply.test.ts:366)。

## I. journal-less garbage GC

状态：部分 DONE。

已完成：

- orphan staging、install-root `.tmp`、`current`/`data` 保护已经存在：[upgrade-gc.ts:81](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-gc.ts:81)、[upgrade-gc.ts:99](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-gc.ts:99)。
- 测试已覆盖：[upgrade-gc.test.ts:73](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-gc.test.ts:73)。

未完成：

- `sweepUpgradeGarbage()` 支持 `shimDirs`：[upgrade-gc.ts:101](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/upgrade-gc.ts:101)，但所有 repair 调用都没有传 shim 目录。
- 设计文档要求清理 shim 下的 `tmex.*.tmp`，当前没有实际接线。
- blocker 2 修复后，missing-journal repair 还必须继续保持“不删除 legacy 顶层目录”。

修复：

- 在 repair 入口计算默认 local bin 和 Bun bin 目录。
- 传给 `sweepUpgradeGarbage({ keepTxnId: activeTxnId, shimDirs })`。
- 增加 shim 临时文件测试，同时确认 foreign shim 不被覆盖。

# 合并后 flag parsing 不一致

结论：存在，而且会直接阻断当前 Web/CLI delegated apply。

相关代码：

- 全局 `COMMAND_FLAGS.upgrade` 接受：
  - `no-service`
  - `txn`
  - `allow-missing-native`

  见 [args.ts:190](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/lib/args.ts:190)。

- `passthroughUpgradeFlags()` 会向 extracted CLI 传 `no-service` 和 `txn`：[commands/upgrade.ts:84](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/commands/upgrade.ts:84)、[upgrade.ts:91](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/commands/upgrade.ts:91)、[upgrade.ts:92](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/commands/upgrade.ts:92)。

- 但内部 `UPGRADE_FLAGS` 没有 `no-service`、`txn`：[upgrade.ts:189](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/commands/upgrade.ts:189)。
- `runUpgrade()` 会先执行第二层断言：[upgrade.ts:213](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/commands/upgrade.ts:213)。
- `runLockedUpgrade()` 实际又依赖这两个字段：[upgrade.ts:282](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/commands/upgrade.ts:282)、[upgrade.ts:290](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/commands/upgrade.ts:290)。

另外：

- `allow-unverified` 在两层 flag 表中都不存在。
- `UPGRADE_USAGE` 没有 `--no-service`：[upgrade.ts:203](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/commands/upgrade.ts:203)。
- `parseUpgradeRunFlags()` 不返回 `noService`/`txn`，调用方只能再次直接读取 parsed flags：[upgrade.ts:166](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/commands/upgrade.ts:166)。
- `main()` 在 dispatch 前处理 `--help`：[index.ts:97](/Users/konata/code/tmex-enhanced-wt-upg/packages/app/src/index.ts:97)，因此实际 `tmex upgrade --help` 不会进入 `runUpgrade()` 的专用 usage 分支。

修复建议：

- 统一唯一的 upgrade flag 定义，至少补齐：
  - `no-service`
  - `txn`
  - `allow-unverified`
- 或删除 `upgrade.ts` 第二层重复白名单，仅保留 `args.ts` 的命令级校验。
- `allow-unverified` 只用于外层下载校验，不应无必要地传给 apply 子进程。
- 增加 `parseArgs`/`runUpgrade` 测试，确保 extracted CLI 的完整参数集合能通过两层校验。

# 当前测试文件 inventory 与 stub 模式

主要 upgrader 测试：

- `packages/app/src/commands/upgrade.test.ts`
- `packages/app/src/commands/direct.test.ts`
- `packages/app/src/lib/args.test.ts`
- `packages/app/src/lib/release-fetch.test.ts`
- `packages/app/src/lib/install-script.test.ts`
- `packages/app/src/lib/install.test.ts`
- `packages/app/src/lib/install-layout.test.ts`
- `packages/app/src/lib/cli-shim.test.ts`
- `packages/app/src/lib/service.test.ts`
- `packages/app/src/lib/upgrade-apply.test.ts`
- `packages/app/src/lib/upgrade-db.test.ts`
- `packages/app/src/lib/upgrade-gc.test.ts`
- `packages/app/src/lib/upgrade-health.test.ts`
- `packages/app/src/lib/upgrade-legacy.test.ts`
- `packages/app/src/lib/upgrade-lock.test.ts`
- `packages/app/src/lib/upgrade-native.test.ts`
- `packages/app/src/lib/upgrade-process.test.ts`
- `packages/app/src/lib/upgrade-state.test.ts`
- `packages/app/src/lib/upgrade-switch.test.ts`
- `packages/app/src/lib/upgrade-verify.test.ts`
- `packages/app/src/runtime/assemble.test.ts`
- `packages/app/src/runtime/gateway.test.ts`
- `apps/gateway/src/system/upgrade.test.ts`
- `apps/gateway/src/api/system.test.ts`
- `apps/gateway/src/api/system-managed.test.ts`
- `apps/gateway/src/api/system-routes.healthz.test.ts`

TLS readiness 相关：

- `packages/app/src/tls/https-listener.test.ts`
- `packages/app/src/tls/tls-service.test.ts`
- `packages/app/src/runtime/assemble.test.ts`

Stub 模式：

- service manager：`upgrade-apply.test.ts` 使用 `fakeService()`，维护 `running/starts/stops`；目前没有真正调用 launchd/systemd 的 upgrader integration test。
- managed service rendering：`service.test.ts` 只断言生成的 unit/plist 内容。
- candidate：
  - 大多数测试注入 `runCandidate`；
  - `upgrade-apply.test.ts:217` 使用 tiny Bun `/healthz` server；
  - `upgrade-apply.test.ts:492` 使用真实 detached child 测试 candidate PID 清理。
- health：
  - 多数 apply/recovery 测试注入 `healthCheck`；
  - `upgrade-health.test.ts` 使用真实 Bun HTTP server。
- Web gateway upgrade：
  - `globalThis.fetch` 模拟 GitHub 下载；
  - tarball 使用真实 `tar` 创建；
  - child 使用 `EventEmitter` fake；
  - `UpgradeController` 通过 `spawn/getInstallInfo/stageRelease` dependency injection。
- runtime assemble：
  - 使用 fake gateway、fake mesh、fake hub；
  - TLS 测试使用真实证书和 Bun HTTPS listener。
- install.sh：
  - `install-script.test.ts` 通过 `sourceEval()` source 脚本；
  - 目前主要测试 bash helper 和语法，没有完整模拟 checksum 下载流程。

当前测试缺口正好覆盖 review-J 的核心问题：没有完整 extracted-CLI apply 链路、没有 preflight side-effect probe、没有真实 1.0.2 body、没有 foreign PID、没有 install.sh checksum policy integration。

以上为只读核验结果；本轮未修改文件，也未运行完整测试套件。