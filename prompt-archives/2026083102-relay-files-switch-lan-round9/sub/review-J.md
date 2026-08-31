复核 Review I 的 9 项：#2、#4、#7、#8 已修复；#1、#3、#5、#6、#9 仅部分修复。其中 1.1.3 回滚兼容已修，但 1.0.2 未覆盖；native 在线重装已实现，但离线保留未实现；checksum 仍对 404 fail-open。

# 1. Blockers

1. **`packages/app/src/lib/upgrade-apply.ts:443-448`、`packages/app/src/commands/upgrade.ts:255-263` — repair 会删除当前正在执行的 staged package**

   `runLockedUpgrade()` 在读取 `--txn` 对应的 package 之前先调用 `repairUpgrade()`。无 journal 时，`repairMissingJournal()` 调用 `sweepUpgradeGarbage()`；有旧终态 journal 时，`repairTerminalCleanup()` 同样会 sweep。二者都没有保留当前 txn，最终由 `sweepOrphanStaging()` 删除整个 `staging/<txn>`。

   失败序列：普通 `tmex upgrade` 或 Web 升级把 1.1.4 解压到 `staging/T/extract/package`，从其中启动 CLI；CLI 进入 repair，删除 `staging/T`；随后 `packageLayoutFromStaged()` 找不到 package，回退到已被删除的 `import.meta.url` 所在目录，最终报 package root 不存在。首次正常在线升级必然失败。

   最小修复：把当前 `txnId` 传给 repair/GC，并在所有 repair 分支中保留该 staging；不得对正在执行的 txn 调用 `cleanupTxn()`。补一个真实的“下载 staging → 启动 extracted CLI → no-journal repair → apply”测试。

2. **`packages/app/src/lib/upgrade-apply.ts:443-448` — 首次旧布局转换后，在提交前删除运行中服务依赖的顶层文件**

   `repairMissingJournal()` 调用 `convertLegacyLayout()` 后立即执行 `removeLegacyTopLevelDirs()`，与文档声明的“仅 committed 后删除”相反。

   失败序列：1.1.3/1.0.2 旧服务仍使用 `<installDir>/resources/fe-dist`；升级刚把文件复制到 `versions/<from>` 并切换 `current`，便删除顶层 `resources/runtime/native/cli`。旧进程仍指向原顶层静态目录，预检期间前端立即返回 500。结合 blocker 1，升级随后失败，旧服务会一直缺少静态文件，直到人工重启。

   最小修复：missing-journal repair 绝不删除旧顶层目录；只允许在新版健康且 journal 已写成 `committed` 后由 `finishCommittedCleanup()` 删除。补覆盖“旧服务仍在运行且预检失败”的测试。

3. **`packages/app/src/lib/upgrade-apply.ts:602-621`、`apps/gateway/src/runtime.ts:123-133`、`packages/app/src/runtime/assemble.ts:620-623` — preflight 会启动生产副作用**

   候选只把 `TMEX_ROLES` 改为 `standalone`，其余生产环境、凭证和复制的数据库全部保留。真实 runtime 启动时会刷新 Telegram/微信、启动 push/watch/tunnel、恢复 running agent session，并发送 gateway-online 通知；TLS/ACME 也会启动。`standalone` 只关闭 mesh，并不关闭这些组件。

   失败序列：生产库存在一个 running agent 或启用了 Telegram；升级预检在旧服务仍运行时启动候选，候选重新执行 agent 的最后一步并发送第二条上线通知，可能重复执行工具、产生外部写入或费用。ACME 模式还会因正式 TLS 端口被旧进程占用而触发额外签发流程。

   最小修复：增加明确的 preflight runtime 模式，只运行迁移和无副作用的健康端点；禁止启动 agent、通知、push/watch、tunnel、TLS/ACME、mesh 及任何外连。需要用真实 runtime、注入副作用探针的集成测试验证调用次数为零。

4. **`packages/app/src/lib/upgrade-apply.ts:385-390,419-432`、`packages/app/src/lib/upgrade-health.ts:51-59` — 1.0.2 无法完成回滚或中断修复**

   1.1.3 的 `/healthz` 有 `startedAt`，因此 Review I #1 的直接问题已修复；但仓库历史 `bb9d84f6:apps/gateway/src/api/index.ts:404-418` 显示 1.0.2 同时没有 `version` 和 `startedAt`。当前旧版验证始终要求 `minStartedAt`。

   失败序列：Linux hub 从 1.0.2 升级后新版健康失败，回滚已经正确恢复 DB、切回 1.0.2 并启动服务；健康轮询仍因缺少 `startedAt` 等待 60 秒后失败，journal 保持非终态。以后每次 `--repair` 都重复失败。升级在 `backup`/`switching` 阶段被杀也有同样结果。

   最小修复：为不提供 `startedAt` 的旧 runtime 提供兼容验证：在已确认 managed service 停止、重新启动且 `current` 指向 `fromVersion` 后，允许仅用新的 service-manager 运行状态加 `status=ok` 验证。补真实 1.0.2 health body 的 rollback 和 repair 测试。

5. **`apps/gateway/src/system/upgrade.ts:141-165`、`packages/app/src/lib/upgrade-apply.ts:155-178` — `serviceMode=none` 只验证 PID 存活，没有验证所有权**

   `assertNoneModePidOwnership()` 的名称与实现不符：它只调用 `kill(pid, 0)`；`createDirectProcessControl.stop()` 随后会无条件杀该 PID。

   失败序列：`tmex.pid` 遗留的 PID 已被另一个进程复用。Web 升级认为其有效；apply 杀掉无关进程，但真正的旧 gateway 继续运行。升级备份运行中的 SQLite，候选因端口占用失败；回滚又在旧 gateway 仍持有数据库时删除并恢复 DB/WAL，可能造成数据库损坏或丢写。

   最小修复：Web 入口和实际 `stop()` 都必须验证 PID 对应的命令行/启动身份属于该安装的 `current/runtime/server.js` 或受支持的 legacy runtime；验证失败时不得发信号或接触数据库。

6. **`packages/app/src/commands/upgrade.ts:128-134`、`packages/app/src/lib/release-fetch.ts:115-121`、`apps/gateway/src/system/upgrade.ts:312-334`、`install.sh:250-252` — SHA256 仍然 fail-open**

   CLI、Web 和 `install.sh` 都把 `SHA256SUMS` 的 404 当作警告并继续执行；Web 测试还明确断言了该行为。因此 Review I #6 没有修复。

   失败序列：release 资产上传不完整、镜像返回错误的 404，或 tarball 被替换但 sums 暂不可见时，下载内容仍会在校验前被解压并执行。结构检查无法证明其完整性或来源。

   最小修复：目标 1.1.4 及后续版本必须要求 `SHA256SUMS` 为 200、包含精确文件条目且摘要匹配；404 也应中止。若必须兼容旧 release，应使用显式的人工 `--allow-unverified`，不能作为 Web 或默认安装路径。

7. **`packages/app/src/lib/upgrade-apply.ts:675,783-793`、`packages/app/src/lib/upgrade-state.ts:43-45`、`packages/app/src/lib/upgrade-apply.ts:419-432` — no-service 在 `backup` 阶段崩溃后会启动第二个进程**

   journal 在调用 `service.stop()` 之前已推进到 `backup`。恢复把 `backup` 映射为 `restart_old`，而 `verifyOldServiceRunning()` 无条件调用 `service.start()`。

   失败序列：no-service 升级刚写入 `phase=backup`、尚未 stop 就被 `SIGKILL`；旧 gateway 仍运行。repair 再启动一个 `run.sh`，新进程覆盖 `tmex.pid` 后因端口占用退出；健康检查命中旧进程，但其 `startedAt` 早于 repair，最终失败。原 gateway 继续运行却失去 PID 所有权，后续 repair 无法自动恢复。

   最小修复：增加明确的 `stopping` 阶段，或让 recovery 先验证旧服务是否仍运行：已运行则不重复启动，并按“未曾停止”的路径验证；只有确认停止后才执行 restart。

# 2. Should fix

- **`packages/app/src/lib/upgrade-db.ts:43-69`**：`bun -e` 的用户参数从 `process.argv[1]` 开始，但脚本读取 `[2]`、`[3]`。因此 `VACUUM INTO` 实际总是失败并退化为运行中逐文件复制 DB/WAL/SHM。修正索引，并用真实 Bun 调用覆盖 `copyPreflightDb()`；fallback 也应先可靠 checkpoint 或使用 SQLite backup API。

- **`packages/app/src/lib/upgrade-native.ts:21-33`**：已有可用 native addon 时仍强制从 npm registry 重下。离线 Linux 使用本地 `--apply-current-package` 时会在停服前安全失败，但无法完成升级；`--allow-missing-native` 又会让节点失去 direct 能力。若旧 manifest、hash、平台及当前 pin 一致，应复制已验证的 addon，仅在 pin 改变时下载。

- **`apps/gateway/src/system/upgrade.ts:173-183`**：在 no-service PID 检查前打开 `upgrade.log`；检查抛错时 FD 没有关闭。反复点击升级会持续泄漏描述符。应在检查后打开，或用统一 `finally` 关闭。

- **`packages/app/src/lib/upgrade-legacy.ts:38-44`**：1.0.2 的旧布局没有部署 `cli/`，但转换时立即把 shim 改为 `current/cli/bin/tmex.js`。预检失败后 shim 永久指向不存在的文件。应在当前版本确有 CLI 时才更新，或推迟到候选切换成功。

- **`packages/app/src/lib/upgrade-apply.ts:709-714`、`apps/gateway/src/api/system-routes.ts:79-97`**：正式提交只验证 HTTP `/healthz` 的版本；配置为 TLS 的 hub 即使 HTTPS listener 启动失败也会被视为升级成功。应让 readiness 覆盖已配置角色和 TLS listener，至少不能在配置的公网入口失败时返回可提交状态。

# 3. Nits

无。