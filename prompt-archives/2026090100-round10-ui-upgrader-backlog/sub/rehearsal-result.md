# 升级器三环境演练记录（2026-09-01）

包：wt-upg `feat/crash-safe-upgrade`（含 428f53e7 double-start 修复）`npm pack` → pkg115（版本号 1.1.5，实为待发内容）。legacy 素材：round9 scratch 的 `pkg113/package`（真实 1.1.3）。全程未触碰生产（9883 / `~/Library/Application Support/tmex/` / `com.tmex.tmex` / 默认 tmux socket）。

## A. scratch no-service（macOS）

- 布局：`setup-legacy.sh` 搭 1.1.3 顶层布局（cli/runtime/resources + app.env 19899 + run.sh 写 pid + meta cliVersion 1.1.3），`bash run.sh` 起服务。
- `upgrade --apply-current-package --no-service`：exit 0，`committed 1.1.3 -> 1.1.5`，`current→versions/1.1.5`，healthz 带新 `tls:{mode,listenerRunning}` 字段，legacy 顶层目录在 commit 后删除，staging/backups 清空，journal 含 candidatePid/dbBackup/keepBackup。
- 回滚：破坏 1.1.5 server.js + journal 改 `started` + 停进程 → `--repair` exit 0 → `rolled_back`，current→1.1.3，1.1.5 候选删除，1.1.3 healthz（无 version）正常。
- **实测发现真 bug**：服务仍在跑时 repair `started` 路径无条件 `service.start()`，第二个 run.sh 覆盖 `tmex.pid` 后因端口占用退出，留下死 pid 记录（与 RV1-Blocker4 相互印证）。已修（`isRunning()` 守卫 + 回归测试，428f53e7）。

## B. kill 注入矩阵（install-b，全新 1.1.3，四个时点）

| kill 时点 | 被杀时 journal | 被杀后旧服务 | 重跑 upgrade | 终态 |
|---|---|---|---|---|
| 0.3s | staging | 1.1.3 ok | exit 0 | committed / 1.1.5 ok |
| 0.6s | preflight | 1.1.3 ok | exit 0 | committed / 1.1.5 ok |
| 1.0s | preflight | 1.1.3 ok | exit 0 | committed / 1.1.5 ok |
| 1.4s | started | 瞬时 DOWN（正常，正在切换） | exit 0 | committed / 1.1.5 ok |

## C. launchd managed（macOS，label `com.tmex.tmex-r10-rhl`，与生产 `com.tmex.tmex` 隔离）

- bootstrap 1.1.3 服务 → `upgrade --apply-current-package --service-name tmex-r10-rhl`：exit 0 committed，launchd 下新版本健康。
- 回滚：破坏 1.1.5 + journal `started` + `kickstart -k` 使 KeepAlive 进入崩溃循环 → `--repair`：exit 0 `rolled_back`，1.1.3 恢复、launchd 服务 active。
- 演练后 bootout + 删除 plist。

## D. systemd managed（docker debian:12 + systemd，`systemctl --user`）

- 容器：privileged + `/sbin/init`；需补装 `libpam-systemd dbus-user-session` 并 `enable-linger root` 才有 user bus（`XDG_RUNTIME_DIR=/run/user/0`）。
- user unit `tmex-r10-sysd.service`（按 `buildSystemdServiceContent` 模板，Restart=always）跑 1.1.3 → `bun bin/tmex.js upgrade --apply-current-package --service-name tmex-r10-sysd`：exit 0 committed，healthz 1.1.5，unit active。
- 回滚：破坏 + journal `started` + restart 进崩溃循环 → `--repair`：exit 0 `rolled_back`，1.1.3 恢复，unit active。

## 覆盖范围备注

- `--apply-current-package` 路径不触发 SHA256SUMS 下载校验（该政策属 delegate/下载路径，靠单测 + review 把关）。
- 1.0.2 兼容与 preflight 零副作用探针靠单测覆盖（`upgrade-health.test.ts` / `runtime.preflight.test.ts`）。
