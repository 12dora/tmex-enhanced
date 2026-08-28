# grok hub-e2e 执行结果

日期：2026-08-28。工作区 `tmex-enhanced-wt-merge`，未改应用源码，无 git 操作。

## 交付物

全部在 `scripts/hub-e2e/`（另有文档 `docs/hub/2026082801-hub-docker-e2e.md`）：

| 路径 | 作用 |
|---|---|
| `Dockerfile` | `ubuntu:24.04` + Bun 1.3.14 + Node 22.18.0 + tmux/rsync/openssl + 打进 tarball 的 runtime |
| `docker-compose.yml` | 项目名 `tmex-e2e`；caddy / hub / node-a / node-b / driver |
| `caddy/Caddyfile` | `hub.tmex.test` → hub:9883，`entry.tmex.test` → node-a:9883 |
| `entrypoint.sh` | 生成并 source volume 上的 `app.env`，`exec bun runtime/server.js` |
| `gen-ca.sh` | 私有 CA + SAN `hub.tmex.test,entry.tmex.test` |
| `run.sh` | 有序驱动：build/up/enroll/join/login/断言/report |
| `driver/{lib,login,nodes,terminal,files}.ts` | Bun 脚本，从仓库根 import `packages/shared` |

驱动选择：**helper 容器 `driver` 挂在 `edge` 网上**，挂仓库 `/workspace`，`NODE_EXTRA_CA_CERTS=/ca/ca.crt`。Caddy 用 network alias 提供 DNS。宿主机只发布 `127.0.0.1:18443`。curl 必须 `--cacert`（不认 `NODE_EXTRA_CA_CERTS`）。

拓扑相对探索报告的一处有意偏差：hub **不加入** `uplink-b`，node-b 只经 Caddy HTTPS 连 hub，避免与 hub 共网把 peer:39001 判成 `lan`。`lan` 网不在 compose 里预挂，场景 4 `docker network create/connect`。

镜像：`linux/amd64`（本机 arm64 走 Rosetta/qemu）。

## 最终场景表

最近一次完整跑：`scripts/hub-e2e/out/report.md`（2026-08-28T05:13:28Z）。

| 场景 | 结果 | 证据 |
|---|---|---|
| 1a hub `/healthz` | PASS | `{"status":"ok"}` |
| 1b `hub user add alice` | PASS | `user alice created` + 根公钥指纹 |
| 1c `/api/auth/mode` mesh 字段 | PASS | `rootEpoch=1`、`rootPublicKey`、`hubPublicUrl=https://hub.tmex.test` |
| 2a enroll+join node-a/node-b | PASS | token 128 字符；join 写 `TMEX_HUB_URL`/`TMEX_ROLES=node`（restart 因无 systemd 非零，按设计接受） |
| 2b hub 入口登录 | PASS | 拿到 `tmex_s_self` |
| 2c `/api/hub/nodes` 两者 online | PASS | `node-a`/`node-b` `online:true` `version:1.0.2` |
| 3a–3f hub 看 mesh、登录 node-b、创建设备、tmux tree、`reach=relay` | PASS | device POST 201；relay 断言 ok |
| 3g 终端 marker 经 hub relay | PASS | WS `HELLO_S2C` + `DEVICE_CONNECTED` + `STATE_SNAPSHOT` + `TERM_OUTPUT 0x305`，观察到 `TMEX_E2E_MARKER_001` |
| 4a 登录 node-a 入口 | PASS | `entry.tmex.test` cookie |
| 4b node-a 登录 node-b | **FAIL（产品）** | 等 60s 后 node-a `/api/mesh/nodes` 仍只有 self + hub 证书行，**没有 node-b**；`mode.hubNodeId=null` |
| 4c `reach=lan` | **FAIL（产品，被 4b 挡住）** | 同上，node-b 根本不在 node-a 的 mesh 列表 |
| 4d lan 路径 marker | **FAIL（产品）** | 经 node-a 打 `/n/<b>/ws` 无 `HELLO_S2C`（目标不可达） |
| 5 文件 list+content | PASS | 经 **hub** entry：`/e2e/marker.txt` content=`hello-e2e\n` |
| 6 hub down 后 node-a→node-b | **FAIL（产品）** | node-a 从未与 node-b 建 live link；hub down 后 `NODE_UNREACHABLE`；mesh 仍不含 node-b |
| 7a hub 恢复后 registry online | PASS | 90s 内 `/api/hub/nodes` 三者 `online:true` |
| 7b 旧 hub cookie | PASS | 无需重登即可拉 hub mesh/nodes |
| 8 `direct enable` | SKIP | 容器内 `bun … direct enable` rc=0 但 `/opt/tmex/native/node_datachannel.node` 未出现（npm 拉包失败被 CLI 吞掉） |

1–3、5、7 为 harness 可证的产品路径。4/6 卡在「非 hub 节点学不到后加入的 peer 证书」，不是编排错误。

## 产品问题（含文件/行假设）

### P1. 非 hub node 的 mesh 列表不含后加入的 peer（阻塞 4/6）

**现象**：hub `/api/hub/nodes` 显示 node-a、node-b 均 `online:true`。从 hub 登录后 `/n/<node-b>/*` 走 relay 成功。但从 `https://entry.tmex.test`（node-a）看：

```json
[
  {"name":"self","id":"<node-a>"},
  {"name":"<hub-id>","online":false,"reach":null,"isHub":false}
]
```

没有 node-b。`GET /api/auth/mode` 的 `hubNodeId` 为 `null`。`POST /n/<node-b>/api/auth/challenge` → 503 `NODE_UNREACHABLE`。等 60s 不变。连上 `lan` 网后仍不变。

**假设**：`apps/gateway/src/mesh/mesh-routes.ts` `collectNodes`（约 206–218 行）只把 `userStore.listCerts()` + self 放进列表。node-a 在 `hub join` 时只写入 **hub** 的证书；之后 uplink 的 `node.list` 若没有把 node-b 的证书/`hub_meta` 写入本机 store，则永远看不到 node-b，也无法把 hub 标成 `isHub`。对照 `apps/gateway/src/mesh/uplink-client.ts` 处理 `node.list` 的路径，以及 `userStore.getHubMeta()`。

这会让「任意已加入的 node 都可作入口」在第二台 node 加入后不成立，直到该机重新 join 或有别的证书同步。

### P2. `node dist/cli-node.js` 在容器里吞掉 bun 子进程 stdout

`hub user add` / `enroll` 经 Node CLI spawn `runtime/cli-auth.js` 时，docker exec 捕获不到 token 行。直接 `bun /opt/tmex/runtime/cli-auth.js` 正常。Harness 已改走 bun。探索报告建议的 `node …/cli-node.js` 在无 TTY 容器不可用。

### P3. `writeEnvFile` + symlink

`packages/app/src/lib/env-file.ts` `rename(tmp, envPath)` 会把 `/opt/tmex/app.env` 的 symlink 替换成 overlay 普通文件，join 状态在 `compose run --rm` 后丢失。Harness 把写完的文件拷回 `/var/lib/tmex/app.env`。`--no-restart` 修不了这个问题。

### P4. 无 systemd 时 `hub join` 非零

符合探索：写完 `app.env` 后 `restartService` 抛 `Automatic service installation is not supported on this platform: linux`。Harness 检查 env 后 start 容器。并行 agent 的 `--no-restart` 落地后可简化。

### P5. qemu/amd64 下 mesh 进程偶发卡在 `assembleTmex`（healthz 起不来）

并行起三个 bun 或 join 后以 `node` 角色重启时，日志停在 `refreshed config: 0 webhooks`，不 listen 9883。`docker restart` 后正常。Harness 在 50s 未 healthy 时自动 restart 一次。疑似 Rosetta 下 native/uplink 初始化卡住，不是逻辑死锁。

## 远端怎么跑

```bash
# 本机构建
TMEX_TARBALL=/path/to/tmex-cli-1.0.2.tgz scripts/hub-e2e/run.sh
docker save tmex-e2e:latest caddy:2 -o tmex-e2e-images.tar

# 目标机（无 Docker Hub）
docker load -i tmex-e2e-images.tar
# 需要仓库（driver 要 import packages/shared）+ 已 load 的镜像
TMEX_E2E_SKIP_BUILD=1 TMEX_TARBALL=/path/to/tmex-cli-1.0.2.tgz scripts/hub-e2e/run.sh --image-tar tmex-e2e-images.tar
# 或仅 load 后 SKIP_BUILD=1 直接 up（tarball 已烤进镜像）

scripts/hub-e2e/run.sh down
```

本机生产 tmex（9883 / `~/Library/Application Support/tmex/`）和默认 socket 上名为 `tmex` 的 session 未被触碰。
