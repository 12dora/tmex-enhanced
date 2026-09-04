# D1 结果：可升级的 docker 节点镜像

## 交付文件

| 路径 | 说明 |
| --- | --- |
| `scripts/docker-node/Dockerfile` | ubuntu:24.04 + Node 22.18.0 官方 tarball + Bun 1.3.14 + tmux/openssl/curl/procps/ca-certificates；多架构按 `TARGETARCH` 取产物；支持预置 `build/bun-linux-<arch>.zip`；`ARG TMEX_TARBALL` 把 tmex-cli 包 COPY 到 `/opt/tmex-pkg/` 并在构建期解包校验 |
| `scripts/docker-node/entrypoint.sh` | PID 1：首启 `tmex init --no-service` 铺装 `/opt/tmex`，补 app.env 缺键；之后 20s 延迟 + 升级事务检测的看护循环；tmux `demo` 会话；SIGTERM 优雅停机；孤儿回收 |
| `scripts/docker-node/build.sh` | `bun run build` + `npm pack` + `docker build`，`TMEX_TARBALL=<path>` 可跳过构建 |
| `scripts/docker-node/run.sh` | `up` / `down [-v]` / `logs` / `shell` / `status` |
| `scripts/docker-node/build/.gitignore` | 构建上下文临时件不进 git（`*` + `!.gitignore`） |
| `docs/hub/2026090402-docker-node.md` | 中文文档：背景、布局、首启、升级三条路径、看护为什么要慢、命令、注意事项 |

未改动 `packages/app/src` 下任何文件。CLI 的 `--no-service` 非交互 init 完全够用，没有遇到阻塞点。

## 设计要点

- **首启命令**（`init.ts` 的 `ni` 分支要求 `install-dir/host/port/db-path` 必填、`autostart` 必须显式给值）：
  ```
  node /opt/tmex-pkg/package/bin/tmex.js init \
    --no-interactive --no-service --role=standalone \
    --install-dir=/opt/tmex --host=0.0.0.0 --port=9883 \
    --db-path=/var/lib/tmex/tmex.db --peer-port=39001 \
    --autostart=false --bun-path=/usr/local/bin/bun
  ```
  `--role standalone` 时 `shouldEnableDirectForRoles` 为假，init 不会去下 WebRTC 原生模块，首启不需要出网。
- **app.env 补键**：`buildAppEnvValues`（`packages/app/src/lib/install.ts:103`）写的是 `TMEX_SITE_NAME=tmex` 且没有 `TMEX_PEER_BIND_HOST`。因为 `startInstalledRuntime` 在 `writeInstallMeta` 之前就把运行时拉起来了，entrypoint 的顺序是 init → 停进程 → 改 app.env（`TMEX_SITE_NAME`、`TMEX_PEER_BIND_HOST=0.0.0.0`、可选 `TMEX_BASE_URL`）→ 重新起。只在首启覆盖，join 后的值不动。`TMEX_TMUX_SOCKET` 有意不设。
- **看护的两个条件**：`tmex.pid` 连续 20s 不存活，且升级不在进行中。升级检测 =「`upgrade.lock` 存在且持锁 pid 还活着」或「`upgrade-state.json` 的 `phase` 不属于 `committed`/`aborted`/`rolled_back`」。后者必须按 phase 判断——`upgrade-state.json` 提交后不会被删除（只有 `uninstall.ts:169` 删它），另叠 900s mtime 兜底防止容器在升级中途被杀后永久卡住。
- **容器重启**：发现活跃 phase 先跑 `tmex upgrade --repair --no-service`，再按需拉起；正常情况直接拉起，不等 20s。
- **pid 文件兼容**：`run.sh` 写纯数字 `$$`，升级器写 JSON `{"pid":...}`，entrypoint 两种都能解析（与 `packages/shared/src/process/pid-file.ts` 的语义一致）。
- **孤儿回收**：循环里 `sleep N & wait $!`，bash 在 wait 期间会把所有已退出的子进程（含升级器 detach 后被 PID 1 收养的运行时）收干净。实测无 defunct。

## 验证记录（本机 macOS arm64，Docker 29.4.3）

测试容器名 `tmex-node-d1`，端口 29884/39002，卷 `tmex-node-d1-opt` / `tmex-node-d1-data`。全程没有碰已有的 `tmex-node-docker`（验证前后均 `Up 5 days`），没有碰宿主 tmux。

### 1. 构建

```
$ cd packages/app && npm pack --pack-destination scripts/docker-node/build
tmex-cli-1.1.25.tgz
$ TMEX_TARBALL=.../tmex-cli-1.1.25.tgz bash scripts/docker-node/build.sh
naming to docker.io/library/tmex-node:1.1.25 done
naming to docker.io/library/tmex-node:latest done
[docker-node build] built tmex-node:1.1.25 (also tagged tmex-node:latest)
```

随后又跑了一遍**完整路径**（不带 `TMEX_TARBALL`，即 `bun run build` → `npm pack` → `docker build`），EXIT=0；跑前跑后 `git status --short packages/shared/src/i18n/` 均为空，`build:i18n` 没有产生生成文件 diff。

首次跑完整路径时暴露一个 bug 并已修复：`build.sh` 的 `log()` 原本写 stdout，被 `resolve_tarball` 的命令替换吞进返回值，导致路径拼错（`cd: ... No such file or directory`）。改成 `>&2` 后通过。
另修了 `run.sh` 在 bash 3.2（macOS）下 `set -u` + 空数组展开报 `env_args[@]: unbound variable`，改用 `${env_args[@]+"${env_args[@]}"}`。

### 2. 首启

```
$ TMEX_DOCKER_NAME=tmex-node-d1 TMEX_HTTP_PORT=29884 TMEX_PEER_HOST_PORT=39002 \
  TMEX_SITE_NAME=docker-node-d1 TMEX_BASE_URL=http://127.0.0.1:29884 \
  bash scripts/docker-node/run.sh up

# docker logs
[docker-node] first boot: installing tmex-cli into /opt/tmex (serviceMode=none)
[tmex] Initialization completed.
[docker-node] stopping runtime pid=25
[docker-node] starting /opt/tmex/run.sh
[docker-node] tmux session 'demo' created
[tmex] version 1.1.25
[tmex] Service started on http://0.0.0.0:9883

$ curl -fsS http://127.0.0.1:29884/healthz
{"status":"ok","version":"1.1.25",...,"env":"production","tmux":{"healthy":true,"serverVersion":"3.4","reason":"ok"},...}

$ docker exec tmex-node-d1 cat /opt/tmex/install-meta.json
{ "serviceName":"tmex", "platform":"linux", "autostart":false, "installDir":"/opt/tmex",
  "cliVersion":"1.1.25", "bunPath":"/usr/local/bin/bun", "serviceMode":"none" }

$ docker exec tmex-node-d1 cat /opt/tmex/tmex.pid   # 40，kill -0 通过
$ docker exec tmex-node-d1 readlink /opt/tmex/current
versions/1.1.25
$ docker exec tmex-node-d1 tmux ls
demo: 1 windows
tmex: 1 windows (attached)      # 运行时自己建的容器内会话，与宿主隔离
```

app.env（脱敏）确认补键生效：`TMEX_SITE_NAME=docker-node-d1`、`TMEX_PEER_BIND_HOST=0.0.0.0`、`TMEX_BASE_URL=http://127.0.0.1:29884`、`TMEX_PEER_PORT=39001`、`TMEX_BIND_HOST=0.0.0.0`、`DATABASE_URL=/var/lib/tmex/tmex.db`，无 `TMEX_TMUX_SOCKET`。

### 3. 容器内就地升级 1.1.25 → 1.1.26

版本号是构建期 `define` 注入进 runtime bundle 的（`packages/app/scripts/build-runtime.ts:76`），改 package.json 不够。所以用真包造了一个 1.1.26：解包 `tmex-cli-1.1.25.tgz` 到 scratchpad，把 `dist/runtime/server.js` 与 `cli-auth.js` 里**仅有的 2 处** `"1.1.25"`（经确认就是 `getBaseVersion()` 里被 define 替换的那两处字面量）换成 `"1.1.26"`，package.json 版本改 1.1.26，重新打包。

```
$ docker cp tmex-cli-1.1.26.tgz tmex-node-d1:/tmp/
$ docker exec tmex-node-d1 bash -c 'mkdir -p /tmp/pkg && tar -xzf /tmp/tmex-cli-1.1.26.tgz -C /tmp/pkg'
$ docker exec tmex-node-d1 bash -c 'node /tmp/pkg/package/bin/tmex.js upgrade \
    --apply-current-package --yes --no-service --install-dir /opt/tmex'
[tmex] upgrade committed 1.1.25 -> 1.1.26
[tmex] Upgrade completed.
EXIT=0            # 耗时 2s
```

结果核对：

```
$ curl -fsS http://127.0.0.1:29884/healthz
{"status":"ok","version":"1.1.26",...}
$ docker exec tmex-node-d1 readlink /opt/tmex/current
versions/1.1.26
$ docker exec tmex-node-d1 ls /opt/tmex/versions
1.1.25  1.1.26
$ docker exec tmex-node-d1 cat /opt/tmex/install-meta.json | grep -E 'cliVersion|serviceMode'
  "cliVersion": "1.1.26",
  "serviceMode": "none"
$ docker exec tmex-node-d1 cat /opt/tmex/upgrade-state.json | grep phase
  "phase": "committed",
$ docker exec tmex-node-d1 ps -eo pid,ppid,args --no-headers
      1     0 bash /usr/local/bin/tmex-node-entrypoint.sh
     47     1 tmux new-session -d -s demo
    520     1 /usr/local/bin/bun /opt/tmex/current/runtime/server.js
    612     1 sleep 2
```

**只有一个 server 进程**（pid 520，升级器 detach 后被 PID 1 收养）。再等 45s，日志无任何 `restarting` 行，进程数仍为 1，healthz 仍是 1.1.26 —— 看护没有抢跑出重复实例。`ps | grep -c defunct` = 0，无僵尸。

升级后 `tmex.pid` 内容为 `{"pid":520,"identity":"73776332","runtimePath":"/opt/tmex/current/runtime/server.js"}`，`/proc/520/cmdline` = `/usr/local/bin/bun /opt/tmex/current/runtime/server.js`，与网关 `cmdlineOwnsInstallRuntime`（`apps/gateway/src/system/upgrade.ts:858`）的 needle `<installDir>/current/runtime/server.js` 精确匹配，`assertNoneModePidOwnership` 会通过。

### 4. `docker restart`

```
$ docker restart tmex-node-d1 && sleep 20 && curl -fsS http://127.0.0.1:29884/healthz
{"status":"ok","version":"1.1.26",...}

# docker logs
[docker-node] signal received, shutting down
[docker-node] stopping runtime pid=520
[docker-node] existing install detected (cliVersion=1.1.26)
[docker-node] starting /opt/tmex/run.sh
[docker-node] tmux session 'demo' created
[tmex] version 1.1.26
[tmex] Service started on http://0.0.0.0:9883
```

重启走 SIGTERM 优雅停机，回来后**不等 20s**直接拉起，单进程。

### 5. 看护行为专项

- **崩溃恢复**：`kill -9` 运行时 → 日志 `runtime down for 20s and no upgrade in flight, restarting`，healthz 25s 后恢复。
- **升级期不抢跑**（关键回归）：手工写入 `/opt/tmex/upgrade.lock`（持锁 pid=1，活着）后 `kill -9` 运行时，45s 内看护**没有**拉起任何进程（server 进程数 0，healthz DOWN）；删掉 lock 后 21s 恢复。证明 20s 延迟 + 锁检测两道闸都生效。

### 6. 用最终镜像重跑全新首启

`run.sh down -v` 清干净后重新 `up`，25s 后 `run.sh status`：

```
container: tmex-node-d1 Up 25 seconds (healthy) 0.0.0.0:29884->9883/tcp, 0.0.0.0:39002->39001/tcp
{"status":"ok","version":"1.1.25",...}
{ ..., "cliVersion": "1.1.25", "serviceMode": "none" }
```

Dockerfile 的 HEALTHCHECK 也生效（`(healthy)`）。

### 7. 清理

`run.sh down -v` 删除容器与两个卷；`docker volume ls | grep tmex` 为空；`scripts/docker-node/build/` 只剩 `.gitignore`。`tmex-node-docker` 与 `tmex-node:test` 镜像原样保留。本机保留了新建的 `tmex-node:1.1.25` / `tmex-node:latest` 镜像。

## 未验证 / 留意

- **网页 UI 点升级没有端到端跑通**：那条路径要从容器内访问 GitHub Releases 下载安装包，且需要先在容器里建账号登录拿到管理员会话。已逐条核对静态条件（`install-meta.serviceMode=none`、`tmex.pid` 存在且归属校验能过、`TMEX_INSTALL_DIR` 由 `run.sh` 导出使 `resolveInstallDir()` 正确），并用等价的 `--apply-current-package` 路径证明了升级器 + 看护的配合。
- **升级后的运行时 stdout 不再进 `docker logs`**：升级器以 `detached` + `stdio:'ignore'` 拉起新进程；重启容器后恢复。升级自身的日志在容器内 `/opt/tmex/upgrade.log`。已写入文档注意事项。
- **默认容器名/端口与历史手工容器冲突**：`run.sh up` 默认 `tmex-node-docker` + 29883，与本机现有容器同名同端口。要替换时先 `docker rm -f tmex-node-docker`（由用户决定，本次未执行）。
- 构建产物 `apps/fe/dist`、`packages/app/{dist,resources}` 是共享 worktree 里的 gitignore 目录，本任务重建过它们；若其他 agent 同期也在构建，可能相互覆盖（内容由源码决定，无持久影响）。
- `bunx biome check scripts/docker-node docs/hub/2026090402-docker-node.md` 报 "Checked 0 files"（biome 不处理 shell/Dockerfile/markdown）；三个 shell 脚本均通过 `bash -n` 语法检查。未新增 TS，复杂度门禁不受影响。
