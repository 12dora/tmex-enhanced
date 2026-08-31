# Task E6：结论

**结论：不具备 crash-safe 自升级能力。**

- 下载/解压阶段通常不影响正在运行的旧版本。
- 一旦进入 `--apply-current-package`，旧版本会被停止并在原目录上逐项删除、复制；断电或杀死 CLI 不会执行 `catch` 中的回滚。
- 新文件在健康检查前已经写入，`install-meta.json` 甚至在服务启动和健康检查前更新。
- 没有数据库备份、升级日志、跨进程锁或启动自修复机制。
- 因此不能保证旧版本可重启，也不能保证新版本仅在验证通过后生效。

## 实际升级顺序

1. 普通 `tmex upgrade` 解析 `latest` 或指定版本，然后从 GitHub Releases 下载 `tmex-cli-<version>.tgz`：`packages/app/src/lib/release-fetch.ts:67`、`:80`；URL 格式见 `packages/shared/src/release/source.ts:14`、`:18`。
2. 下载内容仅执行 HTTP 成功检查并直接 `writeFile`，没有 checksum、签名或 manifest 校验：`packages/app/src/lib/release-fetch.ts:46`、`:80`、`:85`。
3. 下载和解压都位于 `mkdtemp(join(tmpdir(), ...))` 创建的系统临时目录：`packages/app/src/commands/upgrade.ts:98`、`:105`、`:107`。代码没有验证它与安装目录处于同一文件系统。
4. 解压后只检查 `package/bin/tmex.js`：`packages/app/src/commands/upgrade.ts:112`、`:114`；`resolvePackageLayout()` 还会检查 runtime、前端和迁移目录存在，但仍是结构检查：`packages/app/src/lib/install-layout.ts:87`、`:99`、`:105`、`:109`。
5. 随后启动解压 CLI 的 `upgrade --apply-current-package`：`packages/app/src/commands/upgrade.ts:117`、`:118`。
6. apply 阶段读取 `install-meta.json`、检查 Bun、解析当前包布局，并在系统临时目录创建备份目录：`packages/app/src/commands/upgrade.ts:166`、`:175`、`:189`。
7. 先停止服务，再备份文件：`packages/app/src/commands/upgrade.ts:192`、`:193`。备份只包含 `runtime/`、`resources/`、`run.sh`、`install-meta.json`、`cli/`：`packages/app/src/lib/install.ts:146`、`:152`、`:160`、`:164`、`:168`。
8. 备份**不包含** `data/tmex.db`、`tmex.db-wal`、`tmex.db-shm`、`native/`、app.env、shim 或服务 unit/plist。
9. runtime/resources 替换是原地删除再复制：

```ts
await rm(installLayout.runtimeDir, { recursive: true, force: true });
await rm(installLayout.feDir, { recursive: true, force: true });
await rm(installLayout.drizzleDir, { recursive: true, force: true });
...
await copyDirectory(packageLayout.runtimeDirPath, installLayout.runtimeDir);
await copyDirectory(packageLayout.resourceFePath, installLayout.feDir);
await copyDirectory(packageLayout.resourceDrizzlePath, installLayout.drizzleDir);
```

证据：`packages/app/src/lib/install.ts:73`、`:77`、`:84`。

10. CLI 目录随后也会先删除，再创建并逐文件复制：`packages/app/src/lib/cli-shim.ts:25`、`:29`、`:32`、`:36`。
11. `~/.local/bin/tmex` shim 使用临时文件加 rename，单个 shim 写入是原子的：`packages/app/src/lib/cli-shim.ts:133`、`:136`、`:138`；但 `~/.bun/bin/tmex` 是 `rm` 后再 `symlink`，中间存在缺口：`packages/app/src/lib/cli-shim.ts:168`、`:172`、`:173`。
12. 若启用了 direct/native，升级会重新检查并可能替换 `native/`。native staging 位于安装目录内，使用 `native -> native.bak -> native.tmp` 的 rename：`packages/app/src/commands/direct.ts:227`、`:242`、`:243`；但主升级备份和回滚不处理 native。
13. upgrade 只向 app.env 合并缺失键。该文件使用临时文件加 rename：`packages/app/src/lib/env-file.ts:86`、`:95`、`:96`；已有配置不会被重写：`packages/app/src/lib/env-file.ts:114`、`:118`、`:121`。
14. run.sh 使用普通 `writeFile`，不是原子写入：`packages/app/src/lib/install.ts:133`、`:135`。
15. 元数据也使用普通 `writeFile`，不是原子写入：`packages/app/src/lib/json-file.ts:10`、`:12`。
16. 新文件写完后立即更新 `install-meta.json`：`packages/app/src/commands/upgrade.ts:203`、`:207`。
17. 然后重写并启动服务：`packages/app/src/commands/upgrade.ts:209`、`:216`。
18. 健康检查发生在新文件已落地、metadata 已更新、服务已启动之后：`packages/app/src/commands/upgrade.ts:209`、`:216`。
19. 健康检查只请求 app.env 中的 host/port 的 `GET /healthz`，每次请求超时 4 秒，总计等待 30 秒；只要 `response.ok` 就成功，不解析 body：`packages/app/src/commands/upgrade.ts:128`、`:134`、`:140`、`:142`、`:144`。
20. `/healthz` 返回固定 `status: "ok"`，同时附带 tmux 状态，但调用方不检查 `tmux.healthy`：`apps/gateway/src/api/system-routes.ts:68`、`:79`、`:82`、`:87`；也不检查登录页、mesh uplink 或版本号。
21. 运行时首次启动时执行迁移，而不是由 upgrade CLI 单独执行：`apps/gateway/src/runtime.ts:66`、`:76`；迁移目录来自 run.sh 的 `TMEX_MIGRATIONS_DIR`：`packages/app/src/lib/install.ts:126`、`:127`。
22. 升级异常且 CLI 仍存活时才进入回滚：`packages/app/src/commands/upgrade.ts:228`、`:230`。回滚后重新安装/启动旧服务：`packages/app/src/commands/upgrade.ts:231`、`:236`。
23. 回滚本身仍是删除后复制，不是原子切换；并且回滚前没有再次停止新服务：`packages/app/src/lib/install.ts:183`、`:187`；`packages/app/src/commands/upgrade.ts:228`、`:230`。
24. 备份目录只在正常离开 `try/finally` 时删除：`packages/app/src/commands/upgrade.ts:239`、`:240`。断电或 SIGKILL 不会执行 finally。

## 服务路径与版本混用

当前不存在 `versions/<version>` 或 `current` symlink。

安装布局固定为稳定路径：`runtime/`、`resources/`、`native/`、`run.sh`、`cli/`：`packages/app/src/lib/install-layout.ts:30`、`:33`、`:37`、`:39`、`:41`、`:43`。

systemd unit 固定引用稳定的 run.sh：

```ini
WorkingDirectory=<installDir>
ExecStart=/usr/bin/env bash "<installDir>/run.sh"
Restart=always
```

证据：`packages/app/src/lib/service.ts:53`、`:60`、`:64`、`:65`。

run.sh 固定引用稳定目录：

```sh
export TMEX_FE_DIST_DIR='<installDir>/resources/fe-dist'
export TMEX_MIGRATIONS_DIR='<installDir>/resources/gateway-drizzle'
export TMEX_NATIVE_DIR='<installDir>/native'
exec '<bun>' '<installDir>/runtime/server.js'
```

证据：`packages/app/src/lib/install.ts:126`、`:127`、`:128`、`:130`。

因此，逐目录替换期间可能出现：

- 新 runtime + 旧 resources；
- 新 runtime + 部分迁移文件；
- 新 runtime + 旧 native；
- 新 cli + 旧或损坏的 run.sh；
- 旧 run.sh 指向正在被替换的目录。

launchd 同样引用稳定的 run.sh；自动启动 plist 位于 `~/Library/LaunchAgents`，非自动启动 plist 位于安装目录：`packages/app/src/lib/service.ts:37`、`:41`、`:159`、`:162`、`:168`。

## 数据库与迁移

升级代码没有复制数据库文件，故不存在“包含 db/wal/shm 的一致性备份”：`packages/app/src/lib/install.ts:146`、`:152`、`:171`。

服务停止命令错误会被吞掉，也没有验证进程确实退出：

- systemd：`packages/app/src/lib/service.ts:207`、`:208`；
- launchd：`packages/app/src/lib/service.ts:218`、`:221`、`:224`。

数据库默认位于 `<installDir>/data/tmex.db`：`packages/app/src/constants.ts:15`、`:16`。数据库使用 WAL、`synchronous=NORMAL`：`apps/gateway/src/db/client.ts:9`、`:11`、`:13`。

Drizzle SQLite migrator 会在 migration batch 外创建 migration 表，然后对迁移执行 `BEGIN`、`COMMIT`，失败执行 `ROLLBACK`：`node_modules/.bun/drizzle-orm@0.45.1+d3720f6f296df04b/node_modules/drizzle-orm/sqlite-core/dialect.js:587`、`:599`、`:611`、`:613`。

这意味着未提交的迁移具备数据库事务保护，但：

- 已提交迁移没有 downgrade；
- migrator 按最后一次 `created_at` 判断，未校验已记录 migration 的 hash：`.../sqlite-core/dialect.js:595`、`:598`、`:602`；
- 迁移包含删列、删表、重建表等不可逆结构操作：`apps/gateway/drizzle/0012_naive_lizard.sql:1`、`:4`；`apps/gateway/drizzle/0028_magical_doctor_doom.sql:29`、`:30`；
- 如果新 runtime 已提交迁移，然后健康检查失败，当前回滚只恢复文件，不恢复数据库。旧 runtime 可能面对更新后的 schema。

## 中断窗口判定

| 中断位置 | 旧版可用性 / 服务状态 | marker 或自动修复 | 数据风险 |
|---|---|---|---|
| 下载、解压、委托前 | 旧服务继续运行，安装目录未改；临时目录可能残留 | 无需修复；无持久 marker | 无直接 DB 风险 |
| `stopService` 后、部署前 | 旧树完整但服务已停；unit/plist 仍指向稳定 run.sh | 无；可手动重启 | 无备份；停止失败时服务可能仍写 DB |
| 备份过程中 | 旧树仍完整，可手动重启 | 备份仅在 `/tmp`，无 journal | 没有 DB/WAL/SHM 备份 |
| 删除/复制 runtime/resources | 旧树已破坏；稳定 unit 指向部分新树 | 无；重启可能启动部分树 | 文件阶段不直接写 DB |
| 删除/复制 cli | CLI/shim 可能不可用；服务仍可能使用旧 run.sh | 无；shim 未纳入回滚 | 无直接 DB 备份 |
| native rename 中间 | `native/` 可能缺失或新旧不一致 | 仅函数捕获异常时回滚；SIGKILL 无 | 功能风险，主回滚不恢复 native |
| 写 app.env | app.env 本身通常是旧内容或完整新内容 | 临时文件可能残留 | 无直接 DB 风险 |
| 写 run.sh | 文件可能被截断；unit 仍引用该稳定路径 | 无；服务可能无法启动 | 无直接 DB 风险 |
| 写 install-meta.json | JSON 可能损坏；新 metadata 可能早于新服务 | runtime 仅把坏 metadata 当不存在；不修复 | 无直接 DB 风险 |
| 服务 unit/plist 写入、bootout、bootstrap | unit/plist 可能损坏或服务处于未加载状态 | 无；systemd/launchd 只会重试同一路径 | 新 runtime 启动后可能执行迁移 |
| 新 runtime 启动迁移 | 迁移未提交时由 SQLite 事务回滚；已提交后 kill 不会切回旧版 | 无 boot rollback | 无 DB 备份，schema 可能领先旧 runtime |
| 健康检查期间 | 新版本已经 live；kill/power 不会进入 catch | 无；服务管理器可能反复拉起坏树 | 新迁移可能已提交 |
| CLI 存活且健康失败 | 理论上回滚旧文件并重启旧服务 | 仅此次进程内 best-effort | 不恢复 DB、native、shim、app.env、unit/plist |
| 回滚执行中再次 kill | `rm` 后复制可能留下部分旧树；服务可能仍在运行 | 无 journal | DB 不恢复，服务/文件可能不一致 |
| 成功后的 cleanup | 新版本运行；旧备份只在 `/tmp`，不保留可选版本 | 正常 finally 清理；断电会残留 | 无额外 DB 保护 |

## 其他路径与测试

- fresh install 的 `install.sh` 只下载、解压、检查 `package/bin/tmex.js`，没有 release 校验：`install.sh:221`、`:230`、`:235`、`:237`。
- `init` 原地部署，服务启动后才写 metadata，且没有健康检查：`packages/app/src/commands/init.ts:269`、`:272`、`:291`、`:308`。
- `init --force` 会递归删除整个安装目录：`packages/app/src/lib/install.ts:65`、`:69`。
- 中断后的 `init` 只判断目录非空并提示/拒绝，不识别半升级：`packages/app/src/commands/init.ts:250`、`:252`。
- CLI 没有跨进程锁。`withEnvLock()` 只是当前进程内 app.env 读改写串行化：`packages/app/src/lib/env-mutation.ts:1`、`:4`。
- Web API 的 `UpgradeController` 仅在同一 gateway 进程内用内存状态防并发：`apps/gateway/src/system/upgrade.ts:55`、`:61`、`:62`；独立 CLI 进程仍可并发升级。
- `packages/app/src/commands/upgrade.test.ts:7`、`:44` 只覆盖 direct hook、下载、解压、委托；没有 `runUpgrade`、DB backup、rollback、SIGKILL 或 partial-tree 测试。
- `packages/app/src/lib/install.test.ts:57` 只测试 run.sh 内容；`packages/app/src/lib/service.test.ts:4` 只测试 unit/plist 字符串。
- `apps/gateway/src/system/upgrade.test.ts:64`、`:143` 覆盖下载布局和 detached spawn，不覆盖 apply 阶段回滚。

## 严重性排序

1. **P0：原地删除/复制，无持久 journal。** 任意中断都可能留下无法启动的稳定目录。
2. **P0：没有数据库备份。** 新迁移提交后无法自动恢复到旧 schema。
3. **P0：回滚时未停止新服务，且回滚本身非原子。**
4. **P1：新版本在健康检查前已经替换并写入 metadata。**
5. **P1：release tarball 没有 checksum/signature 验证。**
6. **P1：无跨进程升级锁；native、shim、service unit 不在统一事务内。**
7. **P2：健康检查只有本地 `/healthz` 的 HTTP 2xx，不验证版本、登录、mesh uplink 或 direct 功能。**
8. **P2：临时备份/下载目录没有 crash cleanup；Web controller 成功 detached 后甚至没有清理 stageDir：`apps/gateway/src/system/upgrade.ts:80`、`:83`、`:85`。**

## 最小 crash-safe 设计

推荐采用版本目录加原子 `current` 切换：

1. 在安装目录增加：

```text
versions/<version>/{cli,resources,runtime,native}
current -> versions/<known-good-version>
upgrade-state.json
upgrade.lock
data/tmex.db
app.env
run.sh
```

2. 先下载到安装目录同文件系统的 `staging/<transaction-id>`，验证 GitHub Release checksum/signature、包版本、完整 manifest，再 rename 到 `versions/<version>`。
3. 使用 `upgrade.lock` 的 `O_CREAT|O_EXCL` 或等效文件锁，阻止独立 CLI 并发升级。
4. 写入持久化 journal，至少记录 `oldCurrent`、`newVersion`、DB 备份位置和阶段；每个阶段使用原子写入并 fsync。
5. 服务停止后确认进程退出，再做 SQLite 一致性备份；最小方案是 checkpoint 后复制 `tmex.db`、`tmex.db-wal`、`tmex.db-shm`，并记录备份清单。
6. 候选版本使用临时端口和 DB 副本启动；健康检查必须验证 build version、`/healthz`、登录页，以及需要时的 mesh/direct 状态。
7. 候选通过后停止旧服务，原子 rename `current.new` 为 `current`，再启动正式服务。新 runtime、前端、迁移和 native 全部从同一个 `current` 目标解析。
8. 新版本在真实 DB 上执行迁移时仍须采用 expand/contract；若要支持自动回滚，迁移失败或健康失败时必须停止服务、恢复 DB 三件套、切回 `oldCurrent`、启动旧服务。
9. 启动时发现 journal 未处于 `committed`，由稳定 bootstrap 自动恢复；成功健康后才把 metadata 标记为 committed。
10. 至少保留一个 last-known-good 版本，不在首次成功后立即删除旧版本。

需要修改的文件：

- `packages/app/src/lib/install-layout.ts`：增加 `versions/`、`current`、版本目录布局。
- `packages/app/src/commands/upgrade.ts`：改为 journal、锁、DB backup、候选启动、原子切换和 boot rollback。
- `packages/app/src/commands/init.ts`、`install.ts`：fresh install 也先构造版本目录，健康后提交。
- `packages/app/src/lib/fs-utils.ts`、`json-file.ts`：增加 atomic write、fsync、目录 rename 工具。
- `packages/app/src/lib/cli-shim.ts`：shim 固定指向 `<installDir>/current/cli/bin/tmex.js`，不再绑定可变的 `<installDir>/cli`。
- `packages/app/src/lib/install.ts`：run.sh 从 `current` 派生 runtime/resources/native 路径。
- `packages/app/src/commands/direct.ts`：native 放入当前版本，或纳入同一版本切换协议。
- `packages/app/src/lib/service.ts`：unit/plist 保持引用稳定的 `<installDir>/run.sh`，写入使用 atomic rename。
- `apps/gateway/src/system/upgrade.ts`：detached upgrade 记录并清理持久 stage，不能只依赖内存状态。
- `apps/gateway/src/db/migrate.ts` 及迁移策略：明确 expand/contract 和可回滚边界。
- `install.sh`：下载校验后调用具备 journal 的 init。

已安装机器的迁移路径：

1. 获取有效 `install-meta.json` 中的版本；无法确认版本时停止并要求人工确认，不覆盖现有树。
2. 停止服务并确认退出。
3. 将现有 `runtime/`、`resources/`、`cli/`、`native/` 复制到 `versions/<current-version>/`。
4. 原子创建 `current` 指向该目录；`data/`、`app.env` 保持原位置。
5. 原子重写 run.sh 和 shim。
6. 保持 systemd unit / launchd plist 继续引用稳定的 `<installDir>/run.sh`；只在迁移期间原子重写一次。
7. 写入 `upgrade-state.json` 为 committed 后，后续升级才使用新协议。