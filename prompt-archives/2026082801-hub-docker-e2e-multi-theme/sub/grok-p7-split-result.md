# grok-p7-split 执行结果

日期：2026-08-28。工作区 `tmex-enhanced-wt-merge`（`chore/merge-hub-tabs`）。未改 `apps/gateway/**`，无 git 操作。只新增 `scripts/hub-e2e/split/**` 与文档一节。

## 交付物

| 路径 | 作用 |
|---|---|
| `scripts/hub-e2e/split/docker-compose.remote.yml` | 项目 `tmex-split`：caddy 0.0.0.0:18443:443 + hub 39001:39001 |
| `scripts/hub-e2e/split/docker-compose.local.yml` | 项目 `tmex-split-local`：node-a/nat-a、node-b/nat-b、driver；extra_hosts 域名→公网 IP |
| `scripts/hub-e2e/split/Caddyfile` | 真实 LE 证书；`X-Forwarded-Host ai.jiefakj.com:18443` |
| `scripts/hub-e2e/split/setup-remote.sh` | 远端 build `tmex-e2e:split`（不改 latest）、补 app.env 公网 URL、起 hub/caddy |
| `scripts/hub-e2e/split/setup-local.sh` | 本机构建同 tag、起 NAT node |
| `scripts/hub-e2e/split/run.sh` | A→G 编排；`down` 拆两边 |
| `scripts/hub-e2e/split/browser.ts` | 场景 F Playwright |
| `scripts/hub-e2e/split/revoke.ts` | 场景 G 根钥签 revoke-node |
| `scripts/hub-e2e/split/.gitignore` | `out/` |
| `docs/hub/2026082801-hub-docker-e2e.md` | 新节「分体拓扑：远端 hub × 本地 NAT node」 |

复用既有 `Dockerfile` / `entrypoint.sh` / `driver/*.ts`。镜像 **`tmex-e2e:split`**。包用 p6 tarball，未重新 pack。

## 拓扑与端口

- 远端：`tmex-split-hub` + `tmex-split-caddy`。证书 `/root/tmex-e2e/certs/{fullchain,privkey}.pem`（CN/SAN `ai.jiefakj.com`）。
- **实际入站端口**：TCP **18443**（HTTPS，必需）、TCP **39001**（peer，可选）。ufw 已放行。nginx 80/443 未动。
- 本机 Docker 的默认解析会把 `ai.jiefakj.com` 指到 198.18.x.x，所有本地容器 `extra_hosts: ai.jiefakj.com=43.248.129.233`。Playwright 加 `--host-resolver-rules=MAP …`。
- 单机 harness `tmex-e2e` 当时占着 **127.0.0.1:18443**（文档写的是 18543）。未停它。`0.0.0.0:18443` 绑失败后 setup-remote **退到 `43.248.129.233:18443:443`**，公网可达，localhost 18443 仍给 tmex-e2e。
- 远端 NTP `System clock synchronized: no`，曾落后本机 ~73s（超过 `DELEGATION_CLOCK_SKEW_MS=60s`）→ `DELEGATION_ISSUED_IN_FUTURE`。`run.sh` 会 `timedatectl set-ntp false` 并把远端时钟拨到本机 UTC；`run.sh down` 再 `set-ntp true`。

## 最终场景表

主结果：`scripts/hub-e2e/split/out/report.md`（2026-08-28T08:27:54Z）。

| # | 结果 | 说明 |
|---|---|---|
| A join / hub 登录 / nodes online | **PASS** | 两 node 跨互联网 join |
| A 经 hub 打 node-a 终端 | **FAIL** | 见产品缺陷 P2 |
| A 经 hub 读 node-b 文件 | **PASS** | `hello-e2e` |
| B node-a 入口 → 远端 hub 节点 | **PASS** | `isHub:true`，`reach=relay`（39001 未形成 lan） |
| C lan + hub 宕机恢复 | **PASS** | 90s 内 `reach=lan`；hub stop 后终端+文件仍通；120s 内重连；旧 cookie 有效 |
| D direct enable | **PASS** | 两端 `direct_capable=true`；流仍是 `reach=relay`。跨公网 NAT 没有 STUN/TURN 打出 DataChannel 是预期可证范围 |
| E 重启 | **PASS** | node-a / hub restart 后重连，无幽灵行 |
| F Playwright | **FAIL** | 产品：`/login` 抛 `useSidebar must be used within a SidebarProvider`。TLS/解析已通（页面来自 `https://ai.jiefakj.com:18443/assets/…`）。截图 `split/out/f-error.png` |
| G 吊销 node-b | **PASS** | 根钥 `revoke-node` + `POST /api/auth/keylog?hub=sync` 后目标 503 `NODE_UNREACHABLE` |

qemu/amd64 下本机 node 偶发卡住 healthz（与单机 harness 相同）；`ensure_local` 会 restart。Mac Docker 上并行两个 linux/amd64 容器时，hub→node-a 的 relay 流比 hub→node-b 更容易掉。

## 产品缺陷（file:line 假设）

### P1. `/login` 在 SidebarProvider 外用了 useSidebar（阻塞 F）

**现象**：Chromium 打开 `https://ai.jiefakj.com:18443/login` 渲染 React Router 默认错误页：

`Error: useSidebar must be used within a SidebarProvider.`

栈在 `assets/index-*.js`（fe-dist）。真实证书、域名解析均成功，不是 TLS/DNS。

**假设**：`apps/fe/src/main.tsx` 路由里 `/login` 没有包在 `SidebarProvider` 内，但 `LoginPage` / `SidebarTitle` / 某 layout 调用了 `useSidebar`（`packages/ui/src/components/sidebar/sidebar-layout.tsx` 或 `apps/fe/src/components/page-layouts/components/sidebar-title.tsx:11`）。standalone 本地 e2e 可能整树都有 Provider，公网 mesh 入口的 login 路由漏了。

### P2. hub 刚完成 `/n/:id/api/auth/login` 后 POST `/n/:id/api/devices` 503 NODE_UNREACHABLE

**现象**：`/api/hub/nodes` 该行 `online:true`。同一 cookie 下 `POST /n/<node-a>/api/auth/login` 200，紧接着 `POST /n/<node-a>/api/devices` → `{"code":"NODE_UNREACHABLE"}`。对 node-b 的同一路径（login + files）稳定成功。本机 node-a 随后作为入口（B）完全正常。

**假设**：`apps/gateway/src/mesh/peer-manager.ts` `getLink` / relay OPEN 在上一条 HTTP 流关闭后没有立刻保留 live link，第二条流打开失败；或 qemu 下 uplink 在 login 流结束时被当成 idle 掐掉。对照 `openHttpStream` 与 idle 超时。

### P3. 远端 NTP 不同步导致登录 DELEGATION_ISSUED_IN_FUTURE

不是代码 bug，但是公网分体必踩。Hub 校验 `issued_at > now + 60s`（`packages/shared/src/auth/delegation.ts` `DELEGATION_CLOCK_SKEW_MS`）。Harness 已拨时钟。

## 清理两边

```bash
scripts/hub-e2e/split/run.sh down
# 本机：docker compose -p tmex-split-local down -v
# 远端：docker compose -p tmex-split down -v
# 另：远端 timedatectl set-ntp true（down 脚本会做）
```

不删 `tmex-e2e:split` 镜像。不碰 `tmex-e2e` 项目、nginx、本机生产 tmex、名为 `tmex` 的 tmux session。

本机生产 tmex（9883 / `~/Library/Application Support/tmex/`）与默认 socket 上的 `tmex` session 未被触碰。
