# grok-docker-result

日期：2026-08-27  
范围：仅 Docker / compose / gateway 镜像 / nginx / 部署文档。未改 `apps/fe/src`、`packages/panels`、`packages/stores`、`packages/shared/src/i18n`、`apps/fe/tests`。未执行会改 git 状态的命令。未构建前端镜像。未触碰本机生产 tmex（9883 / `~/Library/Application Support/tmex`）以及名为 `tmex` 的 tmux session。

## 原来有什么问题

1. `docker-compose.yml` 的 gateway 服务写了两次 `environment:`（先 list、后 mapping）。YAML 重复 key，后者覆盖前者，`NODE_ENV` / `TMEX_MASTER_KEY` / `DATABASE_URL` 等会全部丢失，只剩 `SSH_AUTH_SOCK`。
2. `version: '3.8'` 对 Compose V2 已过时（警告）。
3. 生产 `loadEnv()` 契约（`packages/shared/src/env/load-env.ts`）要求 `TMEX_MASTER_KEY`、`GATEWAY_PORT`、`TMEX_BIND_HOST`、`DATABASE_URL` 非空，且 `TMEX_FE_DIST_DIR` / `TMEX_MIGRATIONS_DIR` 必须是真实存在的目录。compose 原先缺这三项路径/绑定，`NODE_ENV=production` 会直接 fail-fast。
4. gateway Dockerfile 只拷了 `packages/shared` + `apps/gateway` 的 package.json，但 `bun.lock` workspaces 覆盖 `apps/*` 与 `packages/*`。`bun install --frozen-lockfile` 会因缺失 workspace 清单失败。也没拷 `ghostty-terminal` 源码（gateway 依赖）。
5. 生产镜像 `useradd -u 1000 bunuser` 会与 `oven/bun` 已有的 `bun`（uid 1000）冲突。SSH 挂载路径 `/home/bunuser/.ssh` 对不上。
6. 镜像未带 drizzle 目录；`dist/index.js` 启动后 `runMigrations()` 找不到 SQL。也未带 `ghostty-vt.wasm`。
7. 原先把整个 builder `node_modules` 拷进生产层，既大又无必要：`bun build --target bun` 已打成单文件 `dist/index.js`。
8. compose 里的 `JWT_SECRET` / `TMEX_ADMIN_PASSWORD` 是旧鉴权残留，当前 gateway 不读。文档仍当必需项。
9. 仓库没有 `.dockerignore`，构建上下文会带上本机 `node_modules`（darwin 二进制），污染 linux 镜像。
10. fe nginx 没反代 `/healthz`，文档却让人 `curl localhost:3000/healthz`。文件上传默认 `client_max_body_size 1m`，对 2GB 传输上限不够。
11. `bun build` 会把源码里静态的 `process.env.NODE_ENV` 内联成构建期取值。builder 不设的话，healthz 的 `env` 字段会永远是 `development`（第一次验证已复现）。

## 拓扑结论（未删除 fe 服务）

- `apps/gateway/src/index.ts` 只处理 `/api/*`、`/ws`、`/healthz`，其余 404。
- `packages/app/src/runtime/server.ts`（npm 安装版）才会用 `TMEX_FE_DIST_DIR` 托管静态资源。
- **Docker 保持双容器**：gateway API + fe nginx 反代。gateway 镜像**不构建前端**（符合任务约束）。
- 生产契约仍要求 `TMEX_FE_DIST_DIR` 目录存在，镜像里放了空的 `/app/fe-dist` 占位。静态页面仍由 fe 容器提供。
- 不要删 fe 服务：删了之后 compose 没有 SPA 入口。

## 改了哪些文件

- `docker-compose.yml`
- `apps/gateway/Dockerfile`
- `apps/fe/Dockerfile`
- `apps/fe/nginx.conf`
- `.dockerignore`（新建）
- `docs/2026021000-tmex-bootstrap/deployment.md`

未改 `packages/app` runtime / `build-runtime.ts` / `copy-runtime-assets.sh`（Docker 不走那条打包路径）。

## 命令与结果

### 1. 构建 gateway 镜像

```bash
docker build -f apps/gateway/Dockerfile -t tmex-gateway:verify .
```

**结果：OK**（exit 0）

- `bun install --frozen-lockfile`：702 packages
- `bun run build`：Bundled 580 modules，`index.js` 4.61 MB，注入 `TMEX_MONOREPO_VERSION=1.0.2`
- 未构建前端
- 最终镜像约 74 MB
- 镜像内：`tmux 3.5a`、`OpenSSH_10.0p2`、`/app/drizzle/meta/_journal.json`、`/app/assets/ghostty-vt.wasm`、空 `/app/fe-dist`、用户 `bun` uid 1000

第二次构建（builder 增加 `ENV NODE_ENV=production`）同样 OK，install 层命中 cache。

### 2. 一次性容器打 /healthz

```bash
docker run -d --name tmex-gateway-verify \
  -p 18080:8080 \
  --tmpfs /data:uid=1000,gid=1000,mode=1777 \
  -e NODE_ENV=production \
  -e TMEX_MASTER_KEY='tGd9gPmdUkJrpRQK+db60sc+NkxymxgGqKrReDU4Kus=' \
  -e JWT_SECRET=dummy-jwt-secret-not-used \
  -e TMEX_ADMIN_PASSWORD=dummy-admin \
  tmex-gateway:verify

curl -sf http://127.0.0.1:18080/healthz

docker stop tmex-gateway-verify
docker rm tmex-gateway-verify
```

**结果：OK**

```json
{"status":"ok","restarting":false,"env":"production","tmux":{"healthy":true,"clientVersion":"tmux 3.5a","clientProvenance":null,"serverVersion":"3.5a","reason":"ok"},"owner":null}
```

日志：

```
[env] production: 使用 app.env 注入变量（不读仓库 env 文件） port=8080 host=0.0.0.0 db=/data/tmex.db
[gateway] tmex 1.0.2
[gateway] listening on 0.0.0.0:8080
```

容器已 stop+rm。本机 `127.0.0.1:9883` 的生产 bun 进程全程未动；18080 已释放。

## 指挥官构建 fe 镜像时必须做的事

1. **等前端 agents 改完再 build fe**。当前 `apps/fe/Dockerfile` 的 `bun run build` 是 `tsc && vite build`，源码还在飞，现在打会失败或打到半成品。
2. 仓库根已有 `.dockerignore`（排除 `**/node_modules`）。务必用仓库根当 context：`docker compose up -d --build` 或 `docker build -f apps/fe/Dockerfile .`。不要让本机 darwin `node_modules` 进 linux builder。
3. fe Dockerfile 已改为拷齐全部 workspace `package.json` + `bun install --frozen-lockfile`，并拷 `packages/app/package.json`（vite 构建期读版本）。
4. **不要**在 fe 镜像构建时把 `TMEX_GATEWAY_URL` 设成绝对地址。前端 API/WS 用相对路径（`/api`、`window.location.host/ws`），由 nginx 反代到 `gateway:8080`。
5. compose 启动前必须提供 `TMEX_MASTER_KEY`（32 bytes base64）。可在仓库旁 `.env`（仅给 compose 插值，生产进程不读仓库 env 文件）：
   ```
   TMEX_MASTER_KEY=<base64-32-bytes>
   TMEX_PORT=3000
   ```
   `JWT_SECRET` / `TMEX_ADMIN_PASSWORD` 已不再需要。
6. 入口是 fe 的 `${TMEX_PORT:-3000}`。gateway 不映射到宿主机。就绪后：
   - `curl http://localhost:3000/healthz`（nginx 已反代）
   - 浏览器打开 `http://localhost:3000`
7. 不要删 fe 服务。gateway 镜像是 API-only。
8. 前端还在改 `packages/panels` / `stores` / `shared/src/i18n` 时，fe 镜像必须把这些包的**最终源码** COPY 进去再 `bun run build`。
