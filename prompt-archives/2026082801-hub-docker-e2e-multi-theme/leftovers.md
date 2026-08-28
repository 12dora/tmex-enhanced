# 遗留任务清单（交接）

上下文：本目录 `plan-00.md` / `plan-00-result.md` / `sub/*`；harness 运行指南 `docs/hub/2026082801-hub-docker-e2e.md`；设计 `docs/hub/2026082700-hub-node-architecture.md`。当前代码在分支 `chore/merge-hub-tabs`（worktree `../tmex-enhanced-wt-merge`），本机生产已升级到该版本。

## 1. 跨 NAT 的 RTC 直连从未建立（分体场景 D 停在 `reach=relay`）

- 现象：远端 hub 节点与本地 NAT 内 node-a 两端 `direct_capable=true`，STUN 已改为境内可达的 `stun.miwifi.com`（`TMEX_E2E_STUN_SERVERS`，Google STUN 两端均不可达），但流仍走 hub relay；日志没有任何 RTC/DataChannel 诊断输出。
- 待查：`apps/gateway/src/mesh/rtc/rtc-peer-manager.ts` 是否对"已有 relay 链的 peer"发起 ICE；候选是否收集到 srflx；信令是否经 hub 正确转发；`peer-manager.ts` 的升级拨号是否包含 RTC 候选。需要补 RTC 路径日志（候选类型、ICE 状态、失败原因），并在 `scripts/hub-e2e/split/run.sh` 场景 D 里断言实际 `transport === 'dc'`（`reach=lan` 不能证明 DataChannel）。可能需要 TURN 兜底（`TMEX_TURN_URL/USERNAME/CREDENTIAL`）。
- 证据：`split/out/direct-path.json`、`sub/grok-p7-split-result.md` §D。

## 2. 验收 3「直连中断不丢字」

依赖第 1 项建立 DataChannel 后：注入中断（`docker network disconnect` / 丢 UDP），持续写带序号 marker，断言回落 relay 后输出无丢失、界面提示"直连已断开"。进程内版本可参考 `apps/gateway/src/mesh/integration/direct-path.integration.test.ts`。

## 3. TOTP 登录场景

`hub user totp <user>` 启用后：driver（`TMEX_TOTP`）与 Playwright（验证码输入）登录；覆盖启用、登录、`rotate-root` 后 TOTP 被清空、错误码 `TOTP_INVALID`。加入 `split/run.sh` 或单机 `run.sh`。

## 4. 文件 bulk 直连

直连建立后经 DataChannel 传大文件（`/n/<id>/api/files/*` 的 bulk 路径），断言走 `dc`；构造失败场景验证整次改走 REST 重传（运维文档"已知限制 4"）。

## 5. mesh Playwright e2e 进仓库

`scripts/hub-e2e/split/browser.ts`（密码登录 → 侧栏 → 终端 marker → 注册 passkey → passkey 登录）目前只是 harness 脚本。改成 `apps/fe/tests/mesh-*.spec.ts`：本地进程内起 hub + node（参考 `mesh.integration.test.ts` 的 boot 方式），虚拟 authenticator，接入现有 `run-e2e.ts`。

## 6. harness 重跑前提（agent 需知）

远端测试机已清理干净。重跑分体拓扑需要：传 `ubuntu:24.04`/`caddy:2` 镜像与 `scripts/hub-e2e/build/bun-linux-x64.zip`（目标机拉不到 Docker Hub、访问 github 不稳）、rsync 仓库到 `/root/tmex-e2e/repo`、用 webroot 方式签证书（未知 host 落到 aaPanel 默认站点根 `/www/server/nginx/html`，不改 nginx）、放行 TCP 18443（必需）/39001（可选）；本机镜像用原生架构（不走 qemu）；凭据只走 `RSSH`/`RSYNC_SSH` 包装脚本，绝不入库（P7 曾把密码写进 run.sh，已改写历史清除）。ssh 连接需带重试（面板暴力破解防护会拒绝突发连接）。

## 7. 小尾巴

- 生产安装下 `GET /healthz` 的 `env` 字段显示 `development`（升级前后一致，非本次引入），查 `loadEnv` 与 healthz 的取值来源。
- 既有 tsc 基线错误未清：gateway 21、theme 9、api-client 5、stores 1、app 1。
- `hub join` 时把 `userId` 写进 `node_identity` 已做（迁移 0020）；`resolveUserId` 的回退逻辑可在下个版本移除。
