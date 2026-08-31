# 1. Blockers

结论：**拒绝今晚发布**。共发现 9 个阻断问题，其中第 1、2 项直接影响今晚的 1.1.3 → 1.1.4 回滚安全。

1. **1.1.3 回滚健康检查必然失败，`--repair` 会永久卡在 `started`**

   - 位置：`packages/app/src/lib/upgrade-apply.ts:394-404`、`apps/gateway/src/api/system-routes.ts:85`、`packages/app/src/runtime/assemble.ts:158`
   - 问题：回滚旧服务后仍使用严格版本健康检查，要求响应中的 `version === journal.fromVersion`。但 `version` 字段正是 1.1.4 才加入；已安装的 1.1.3 runtime 不会返回它。
   - 失败场景：1.1.4 启动或健康检查失败；代码恢复 DB、切回 `versions/1.1.3` 并启动旧服务；旧 `/healthz` 返回 `status: ok` 但没有 `version`，于是回滚函数再次抛错，journal 保持 `started`。此后每次 `--repair` 都会先把旧服务当成不健康的新版本，再重复失败的回滚，永远无法进入 `rolled_back`。
   - 最小修复：候选版本继续使用严格版本检查；回滚到不支持版本化 `/healthz` 的旧版本时，允许缺少 `version`，但仍必须验证 `status === ok`、当前 symlink 指向 `fromVersion`，并确认响应来自本次重启后的进程。增加真实 1.1.3 health body 的回归测试。

2. **DB 回滚既不能保证服务已停止，也没有精确恢复 WAL 三件套**

   - 位置：`packages/app/src/lib/upgrade-apply.ts:277-287`、`packages/app/src/lib/upgrade-apply.ts:382-388`、`packages/app/src/lib/upgrade-apply.ts:185-204`
   - 问题：
     - `rollbackToOld()` 吞掉 `service.stop()` 的任何错误，然后继续覆盖 DB。
     - `restoreDbTrio()` 只复制备份中存在的文件，不删除目标侧多出来的 `-wal`/`-shm`。
     - direct process 路径发出 `SIGKILL` 后不等待进程真正退出。
   - 失败场景：新版本迁移后生成新的 WAL；回滚备份只有主 DB。代码复制旧主 DB，但保留新 WAL，旧 SQLite 重启后可能重放与旧 schema 不兼容的新 WAL。若 stop/kill 失败，还会在运行中的 SQLite 连接下逐个覆盖 DB/WAL/SHM，存在数据库损坏和数据丢失风险。
   - 最小修复：stop 失败必须中止恢复并保留 journal/backup；恢复前再次确认进程不存活。目标三件套应先移走或删除，再严格按备份集合恢复，不能保留备份中不存在的 WAL/SHM；恢复后 fsync 文件和目录。direct 的 SIGKILL 路径必须等待退出。

3. **`--no-service` 无法可靠停止现有进程，Web 升级还会擅自安装 launchd/systemd 服务**

   - 位置：`packages/app/src/commands/init.ts:305-312`、`packages/app/src/lib/install.ts:94-134`、`packages/app/src/lib/upgrade-apply.ts:179-220`、`packages/app/src/lib/upgrade-apply.ts:551-560`、`packages/app/src/types.ts:39-46`、`apps/gateway/src/system/upgrade.ts:125-139`
   - 问题：`init --no-service` 不启动进程，也不记录 `tmex.pid`；手动执行的 `run.sh` 同样不写 PID。因此升级时 direct control 通常找不到当前 gateway，`stop()` 实际是 no-op。安装元数据又不保存 service mode，Web 触发器也不传 `--no-service`。
   - 失败场景：用户手动运行 no-service gateway 后升级。CLI 在旧进程仍连接数据库时备份并切换版本，随后新进程因端口占用无法启动；回滚又可能覆盖仍被旧进程使用的 DB。Web 触发时则会走 managed control，并创建原本明确禁止的 launchd/systemd 服务。
   - 最小修复：在 `InstallMeta` 持久化 service mode。没有可靠 PID/进程所有权时，Web 自升级应禁用；CLI 应要求操作者先停止进程并验证端口/进程已退出，或建立由 `run.sh` 维护且可验证身份的 PID 机制。Web 触发必须继承该模式。

4. **升级器崩溃会遗留无法由 `--repair` 停止的 preflight gateway**

   - 位置：`packages/app/src/lib/upgrade-apply.ts:223-240`、`packages/app/src/lib/upgrade-apply.ts:520-533`、`packages/app/src/lib/upgrade-apply.ts:432-440`
   - 问题：候选进程 PID 没有写入 journal。清理只发生在父进程仍能执行 `finally` 时。
   - 失败场景：候选 gateway 已启动后，升级 CLI 被 kill 或机器上的 shell 崩溃。子进程在 Unix 上继续运行并持有本地监听 socket；`--repair` 只删除 candidate/staging 目录并标记 aborted，无法找到或停止这个进程。
   - 最小修复：把候选 PID和进程身份写入 journal；`abort_candidate` 必须终止并确认退出后才能删除目录。也可增加可靠的 parent-death 机制，但仍应让 repair 能处理父进程已经消失的情况。

5. **升级后已安装的 Direct 原生插件必然丢失**

   - 位置：`packages/app/src/lib/upgrade-apply.ts:298-305`、`packages/app/src/lib/upgrade-apply.ts:614-625`、`packages/app/src/commands/direct.ts:271-285`
   - 问题：候选版本部署只复制 runtime、CLI 和 resources，不复制旧版本的 `native/`。切换 `current` 后才调用 `reenableDirectIfNeeded()`；它检查的是新候选目录，发现 addon 和 manifest 都不存在后返回“skipped”，不会下载或迁移插件。
   - 失败场景：1.1.3 已通过 init 安装 `node_datachannel.node`。升级 1.1.4 后 `TMEX_NATIVE_DIR` 指向空的 `current/native`，节点间原生 Direct 能力消失。
   - 最小修复：切换前记录旧版本是否启用了 Direct，并针对候选版本显式安装受校验的当前 pin；或者安全复制旧 addon/manifest 后验证兼容性。测试必须使用真实 `reenableDirectIfNeeded()`，不能只注入 no-op。

6. **Web 自升级完全绕过 SHA256；其他入口在校验请求失败时也 fail-open**

   - 位置：`apps/gateway/src/system/upgrade.ts:220-244`、`packages/app/src/lib/release-fetch.ts:100-118`、`install.sh:232-250`
   - 问题：
     - `stageGithubRelease()` 下载后立即解压并执行，不读取 `SHA256SUMS`。
     - CLI 把网络错误、5xx 和 404 全部当成“校验文件不存在”。
     - `install.sh` 同样把所有 `curl -f` 失败报告成 “not found” 并继续执行。
   - 失败场景：release 已发布 SHA256SUMS，但校验请求被代理返回 500，或 gateway 收到损坏/错误 tarball。Web 路径会直接执行其中的新 CLI；其他入口也会降级为未验证执行。
   - 最小修复：三个入口共享同一语义：只有明确的 404 才允许“未发布 checksum”；网络错误及其他 HTTP 状态必须中止。校验必须发生在解压和执行前，gateway 不能例外。

7. **更新 `~/.bun/bin/tmex` 存在明确的崩溃断点，会让 PATH 上的 `tmex` 消失**

   - 位置：`packages/app/src/lib/cli-shim.ts:169-180`
   - 问题：代码先 `rm(linkPath)`，再创建临时 symlink 并 rename。
   - 失败场景：进程刚删除 `~/.bun/bin/tmex` 就死亡。很多 Bun 安装只把 `~/.bun/bin` 放进 PATH，`~/.local/bin/tmex` 虽仍存在但不可直接调用。因为 legacy conversion 已经创建了 `current`，后续 `--repair` 会跳过 conversion，也不会重装 shim。
   - 最小修复：不要预先删除旧 symlink；先创建临时 symlink，再原子 rename 覆盖受管理的目标。增加“死在 rm 后”的故障注入测试。

8. **PID 复用可让 stale lock 永久阻止升级和 `--repair`**

   - 位置：`packages/app/src/lib/upgrade-lock.ts:50-70`
   - 问题：锁所有权只靠 PID；`startedAt` 从不参与验证。升级器死亡后，如果 PID 被无关长寿命进程复用，锁会永远被认为仍有效。
   - 失败场景：升级器崩溃留下 `upgrade.lock`，稍后同 PID 被其他进程占用。普通升级和 `--repair` 都必须先获得同一把锁，因此没有内建恢复入口。
   - 最小修复：记录并验证 PID 对应进程的启动身份，而不只是“该 PID 存活”；同时提供 repair 可安全回收 stale lock 的规则。加入 PID 存活但身份不匹配的测试。

9. **`switching/backup` repair 即使旧服务启动失败也会删除恢复材料并报告成功**

   - 位置：`packages/app/src/lib/upgrade-apply.ts:443-456`
   - 问题：`service.start()` 的失败被吞掉，随后仍删除候选目录、staging、backup，并把 journal 标成 `aborted`。
   - 失败场景：launchctl bootstrap 暂时失败或 plist 不可读。`tmex upgrade --repair` 返回成功，但服务仍停止，同时 transaction backup 已被删除，下一次 repair 也没有恢复上下文。
   - 最小修复：旧服务启动并通过健康/运行状态验证前，不得清理 transaction 或推进到 terminal phase；启动失败必须保留 journal 和 backup，并返回非零。

# 2. Should fix

1. **运行中的 WAL DB 不能靠逐文件复制获得一致的 preflight 快照**

   - 位置：`packages/app/src/lib/upgrade-apply.ts:262-274`、`packages/app/src/lib/upgrade-apply.ts:494-499`
   - 主 DB、WAL、SHM 在三个 `copyFile` 之间可能发生 checkpoint 或 WAL rollover，候选可能收到互不对应的文件并产生假阴性的 preflight。
   - 应使用 SQLite online backup/snapshot 能力；至少不要把逐文件复制描述为一致的 DB copy。

2. **Web 子 CLI 在 stop 服务前退出时，controller 会永久显示 `executing`**

   - 位置：`apps/gateway/src/system/upgrade.ts:101-102`、`apps/gateway/src/system/upgrade.ts:157-175`
   - 当前只等 `spawn`，不监听后续 `exit`。例如 stale lock 导致新 CLI 立即退出，但旧 gateway 仍运行且状态永久为 `executing`，所有后续 Web 升级返回 busy，直到手工重启 gateway。
   - 应监听早期退出并恢复为 idle/error；真正 stop gateway 后进程自然消失，不需要在旧进程里完成状态更新。

3. **升级到当前相同版本会稳定失败并留下 aborted journal**

   - 位置：`packages/app/src/lib/upgrade-apply.ts:289-295`、`packages/app/src/lib/upgrade-apply.ts:314-317`
   - `toVersion === current` 时，promotion 尝试删除目标版本，`safeRemoveDir()` 正确拒绝删除 current，于是 `tmex upgrade --version <当前版本>` 报错。
   - 应在部署前将相同版本识别为健康 no-op，或采用不会覆盖 current 的重新安装事务。

4. **`--keep-backup` 只保留到下一次 upgrade/repair**

   - 位置：`packages/app/src/lib/upgrade-apply.ts:358-364`、`packages/app/src/lib/upgrade-apply.ts:477`
   - 成功事务留下 backup，但 journal 不记录 `keepBackup`；下一次命令开头执行 repair 时，会无条件 `removeTxnDirs()` 删除它。
   - 应在 journal 中记录保留策略，terminal cleanup 尊重该策略。

5. **`--repair` 没有清理无 journal 或 commit 后中断产生的垃圾**

   - 位置：`packages/app/src/lib/upgrade-apply.ts:427-429`、`packages/app/src/lib/upgrade-apply.ts:477`、`packages/app/src/lib/fs-utils.ts:43-85`
   - 以下内容能在失败/断电后存活，且 `--repair` 不会清除：
     - gateway 或新 CLI 在首次写 journal 前死亡留下的 `staging/<txn>/`、tarball 和解压目录；
     - 1.1.3 delegator 硬退出留下的系统临时目录 `tmex-cli-upgrade-*`；
     - `upgrade-state.json.*.tmp`、`current.*.tmp`、`run.sh.*.tmp`、tarball临时文件，以及两个 shim 目录里的 `tmex.*.tmp`；
     - journal 已写 `committed`、但在 prune/legacy cleanup 前死亡留下的旧 `versions/*` 和顶层 `cli/runtime/resources/native`；
     - legacy conversion 创建 `current` 后、首次 journal 前死亡留下的重复顶层 legacy 目录。
   - repair 应安全枚举可识别的 transaction/temp 命名，并恢复 terminal phase 未完成的 prune/legacy cleanup；不能只清一个 journal txn。

6. **故障注入覆盖不足**

   - 位置：`packages/app/src/lib/upgrade-apply.test.ts:107-329`
   - 现有测试主要使用 fake service/fake health，并未覆盖真实 1.1.3 无版本 health、残留 WAL、stop 失败、PID 丢失、Direct 迁移、no-service Web 路径或各 rename/write 边界死亡。
   - 至少应为上述 release-blocking 路径加入确定性的 fault-injection 测试；不需要触碰本机生产 launchd 或生产 DB。

# 3. Nits

无。

核对通过的部分：

- `current` 使用临时 symlink + rename；在合法 release version 和正常生成的 journal 下，`safeRemoveDir()`/prune 没有发现删除当前版本目录的路径。
- legacy conversion 在切换前先复制，顶层旧 runtime 保留到 commit；launchd plist 始终指向稳定的 `run.sh`。除上述 Bun shim 断点外，旧服务的运行中进程及下一次 restart 路径是连续的。
- 1.1.3 旧 CLI 不传 `--txn` 时，新包可通过自身 `import.meta.url` 定位；新 CLI/Web 传 `--txn` 时也能从 staging 或自身包根定位，self-delegation链路本身成立。
- 新增 CLI 生产路径未发现 `bun:*` import；Bun 专用引用位于测试或 Bun runtime 路径，Node 20 CLI bundle 兼容边界未见新增违规。
- gateway 的 detached spawn 参数、`--apply-current-package`、`--install-dir`、`--version`、`--txn` 和 `--bun-path` 接线正确；问题在 checksum、no-service 传播和子进程早退状态处理。
- 因任务明确要求只读，本次未运行会创建临时目录/文件的 Bun 测试；未声称测试通过。静态 `git diff --check` 无输出。