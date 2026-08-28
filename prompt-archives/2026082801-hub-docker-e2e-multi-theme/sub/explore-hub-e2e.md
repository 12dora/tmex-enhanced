# tmex Hub/Node Docker 实测方案审阅报告

以下结论基于当前工作区源码静态审阅，未修改文件，也未连接本机生产 tmex。

## 1. Linux 容器可运行制品

### 构建与打包

根目录构建链为：

- `package.json:11-18`：构建 i18n、前端、runtime resources、`tmex-cli`。
- `packages/app/package.json:12-27`：
  - `build:runtime`：构建 Bun runtime。
  - `build:cli`：构建 Node 兼容 CLI。
  - `build`：清理并重新构建完整 npm 包。
- `packages/app/scripts/build-runtime.ts:26-54`：
  - `runtime/server.js` 和 `runtime/cli-auth.js` 目标为 Bun。
  - 仅显式 externalize `cpu-features`。
- `packages/app/package.json:12-17`：npm 包只包含 `bin`、`dist`、`resources`、文档，不包含 `node_modules` 或 native `.node` 文件。

macOS 上生成 tarball：

```bash
bun install
bun run build
(cd packages/app && npm pack)
```

当前版本会生成：

```text
tmex-cli-1.0.2.tgz
```

该 tarball 的 JavaScript 和前端资源本身与 CPU 平台无关。macOS 构建不会把 macOS native addon 打进包内：

- `build-runtime.ts:56-94`：验证 node-datachannel JS 已内联，native 文件通过绝对路径运行时加载。
- `packages/app/src/lib/native-manifest.ts:22-30`：native addon 按平台从 npm registry 下载。
- `native-manifest.ts:59-70`：Linux x64 选择 `linux-x64-gnu`；musl 返回不支持。
- 当前版本 native addon 为 `@node-datachannel/linux-x64-gnu@0.33.1`，N-API 8。

### `cpu-features` 与 ssh2

`build-runtime.ts:35-36` 将 `cpu-features` externalize。ssh2 本身被打进 runtime；其源码对 `cpu-features` 使用 try/catch：

```text
node_modules/.bun/ssh2@1.17.0/node_modules/ssh2/lib/protocol/constants.js:5-8
```

因此容器不安装 `cpu-features` 时，SSH 功能理论上仍可运行，但失去 CPU 特性优化。当前打包产物中的 ssh2 还包含构建机绝对路径形式的 `__dirname`，应在 Linux 容器执行 SSH smoke test，不能只凭 macOS 构建成功判断。

### Node.js、Bun 与直接连接

- `packages/app/bin/tmex.js:1-8`：npm bin 使用 Node shebang。
- `packages/app/src/index.ts:32-67`：普通 CLI 在 Node 中运行；认证类命令再转交 Bun。
- `packages/app/src/lib/auth-spawn.ts:44-107`：`hub user add`、`hub join`、`enroll` 等命令要求安装目录存在 `app.env`，然后执行 `runtime/cli-auth.js`。
- 因此：
  - 运行 `runtime/server.js`：只需要 Bun。
  - 运行 `runtime/cli-auth.js`：只需要 Bun。
  - 使用 `npx tmex-cli`：需要 Node.js/npm/npx。
  - 若容器只执行 Bun 命令，则不需要 Node.js。

建议基础镜像为 glibc Ubuntu/Debian 系列，至少安装：

```text
Bun >= 1.3.0
bash
ca-certificates
tmux
rsync
```

Bun 最低版本来自 `packages/app/src/constants.ts:4`。Alpine/musl 不适合 direct 验收。

### `init` 不适合容器

`init --no-interactive --autostart false` 仍然不适合无 systemd 的容器：

- `packages/app/src/commands/init.ts:268-272`：首先要求检测到 systemd/launchd；无服务管理器直接失败。
- `init.ts:319-348`：即使 `autostart=false`，仍会调用 `installService`。
- `packages/app/src/lib/platform.ts:5-17`：无 systemd 时返回 `none`。
- `packages/app/src/lib/service.ts:191-205`：服务管理器为 `none` 时抛错。

`init` 缺 Bun 时的自动安装命令是：

```text
curl -fsSL https://bun.sh/install | bash
```

位置为 `packages/app/src/lib/dep-install.ts:63-71`。只有 `--install-deps` 或交互模式才会尝试执行；非交互且未开启安装时只打印提示。它需要网络、curl 和写入用户目录的权限。

### 容器内推荐手工布局

准备如下目录：

```text
/opt/tmex-pkg/dist/cli-node.js
/opt/tmex-pkg/dist/runtime/server.js
/opt/tmex-pkg/dist/runtime/cli-auth.js
/opt/tmex-pkg/resources/fe-dist
/opt/tmex-pkg/resources/gateway-drizzle

/opt/tmex/runtime/server.js
/opt/tmex/runtime/cli-auth.js
/opt/tmex/resources/fe-dist
/opt/tmex/resources/gateway-drizzle
/opt/tmex/native
/opt/tmex/app.env
```

布局对应 `packages/app/src/lib/install-layout.ts:29-42`。

生产 runtime 至少要求：

```text
NODE_ENV=production
TMEX_MASTER_KEY=<每个容器自己的密钥，数据库迁移期间保持不变>
GATEWAY_PORT=9883
TMEX_BIND_HOST=0.0.0.0
DATABASE_URL=/var/lib/tmex/tmex.db
TMEX_FE_DIST_DIR=/opt/tmex/resources/fe-dist
TMEX_MIGRATIONS_DIR=/opt/tmex/resources/gateway-drizzle
TMEX_NATIVE_DIR=/opt/tmex/native
TMEX_TMUX_SOCKET=tmex-node-a
```

`loadEnv()` 在 `packages/shared/src/env/load-env.ts:116-152` 会校验生产必需变量，但不会读取仓库 env 文件。

直接作为 PID 1：

```bash
exec bun /opt/tmex/runtime/server.js
```

对应生成的 `run.sh` 行为为 `packages/app/src/lib/install.ts:108-135`。`packages/app/src/runtime/server.ts:21-34` 会创建 Bun HTTP/WebSocket 服务并保持进程运行。

### Direct addon 的 CLI 缺陷

这里存在一个重要问题：

- `packages/app/src/index.ts:14-29,49-67`：`direct` 命令在 Node CLI 进程中直接加载。
- `packages/app/src/commands/direct.ts:96` 使用 `Bun.write`。
- `packages/app/src/lib/native-datachannel.ts:127` 使用 `Bun.file`。
- `direct.ts:168-198`：失败时只打印 `direct enable skipped`，不设置失败退出码。

所以普通：

```bash
npx tmex-cli direct enable --install-dir /opt/tmex
```

在 Node 进程中会在 native 写入/校验阶段引用不存在的 `Bun` 全局，随后被当作 skipped，退出码仍可能为 0。`init --role node` 的自动 direct 也会吞掉错误，见 `init.ts:56-79`。

容器内应先验证：

```bash
bun /opt/tmex-pkg/dist/cli-node.js direct enable --install-dir /opt/tmex
```

然后必须同时检查：

```text
/opt/tmex/native/node_datachannel.node
/opt/tmex/native/manifest.json
GET /api/mesh/nodes[].direct_capable === true
```

不能只看 `direct enable` 的退出码。

---

## 2. `hub join`、`hub leave`、`mesh reset-root` 重启语义

### `hub join`

`packages/app/src/commands/hub.ts:267-344` 的顺序是：

1. 校验 HTTPS URL 和 token。
2. GET `/api/auth/mode` 获取 hub UID。
3. 本地生成 node certificate。
4. POST `/api/hub/enrollments/redeem`。
5. 校验并提交 key log。
6. 写入 `app.env` 的 `TMEX_ROLES`、`TMEX_HUB_URL`。
7. 调用 `maybeRestart()`。

`maybeRestart()` 位于 `hub.ts:107-116`。默认会调用 `restartService`。

无 systemd/launchd 的容器中：

- join 数据和 `app.env` 可能已经写成功；
- 随后 `restartService` 在 `service.ts:342-386` 抛出 unsupported platform；
- Node CLI 最终返回非零。

### `hub leave`

`hub.ts:467-480` 先写入本地身份和 `app.env`，然后同样调用 `maybeRestart()`。容器中也会出现“状态已写入，但命令非零退出”。

### `mesh reset-root`

`packages/app/src/commands/mesh.ts:29-66` 只重建 root user/key log，不调用 restart。项目中“这几个命令都重启服务”的前提并不准确。

它会输出需要重新 enroll 其他机器；实际验证应：

1. 停止相关容器；
2. 执行 `mesh reset-root`；
3. 重新 enroll 所有其他节点；
4. 启动容器；
5. 重新建立登录和 mesh 状态。

### 是否存在跳过重启选项

CLI 帮助没有 `--skip-restart`，见 `packages/app/src/cli/help.ts:10-18`。

`HubIo.skipRestart` 只存在于测试/源码注入接口，见 `hub.ts:43-57,107-126`，普通 `npx tmex-cli` 不会将 CLI flag 映射为该字段。

### 容器安全顺序

推荐：

1. 节点容器停止。
2. 在节点容器中执行 `hub join ... --install-dir /opt/tmex`。
3. 接受命令因为无服务管理器而非零退出。
4. 不要重复使用 token 重试。
5. `docker compose up -d node-a`。
6. 等待 node uplink online。

`hub join` 的网络操作不要求本地 node server 正在监听，因此停止后执行最干净。

---

## 3. HTTPS、反向代理与 uplink

### URL 校验规则

`packages/app/src/lib/hub-client.ts:75-99`：

- 任意 `https:` URL 接受。
- `http:` 只有同时满足以下条件才接受：
  - `--insecure-local`；
  - hostname 为 `127.0.0.1` 或 `localhost`；
  - `NODE_ENV !== production`。
- 非 loopback HTTP 即使 `NODE_ENV=development` 也拒绝。

因此远程 Docker 环境必须使用 TLS。

### Gateway 不直接提供 TLS

`apps/gateway/src/index.ts:11-29` 的 `Bun.serve()` 没有 `tls.key`、`tls.cert` 等配置。runtime 入口 `packages/app/src/runtime/server.ts:29-34` 也没有 TLS 配置。

结论：使用 Caddy/Nginx/Traefik 终止 TLS，反代到容器内部的 `http://hub:9883`。

Caddy 必须支持：

```text
HTTPS
WebSocket Upgrade
X-Forwarded-Host
X-Forwarded-Proto
```

### 必要环境变量

Hub：

```text
TMEX_HUB_PUBLIC_URL=https://hub.<ip-dashed>.sslip.io
TMEX_BASE_URL=https://hub.<ip-dashed>.sslip.io
TMEX_TRUST_PROXY=true
```

Node：

```text
TMEX_HUB_URL=https://hub.<ip-dashed>.sslip.io
TMEX_TRUST_PROXY=true
```

`TMEX_HUB_PUBLIC_URL` 被 `apps/gateway/src/mesh/mesh-runtime.ts:537-542` 优先作为 hub endpoint。`TMEX_TRUST_PROXY` 的定义见 `apps/gateway/src/config.ts:188-191`；实际 forwarded scheme/host 处理见 `session-middleware.ts:212-233`。

注意：`packages/app/src/lib/install.ts:45-55` 生成的 `TMEX_BASE_URL` 默认是内部 HTTP 地址，且 installer 不写 `TMEX_TRUST_PROXY`。反代部署不能直接依赖 init 生成的值，应手工修正 `app.env`。

### uplink URL 与证书

`apps/gateway/src/mesh/uplink-protocol.ts:411-419`：

```text
https://... -> wss://.../hub/uplink
http://...  -> ws://.../hub/uplink
```

uplink 客户端使用：

- `apps/gateway/src/mesh/uplink-client.ts:78-80`：`new WebSocket(url)`；
- `uplink-client.ts:329-335`：连接 `/hub/uplink`；
- `uplink-client.ts:440-463`：node certificate challenge。

源码没有 `rejectUnauthorized`、`tls.ca` 或自定义 WebSocket TLS 选项，也没有读取 `NODE_EXTRA_CA_CERTS`。

Bun 官方环境变量文档当前明确列出的是 `NODE_TLS_REJECT_UNAUTHORIZED=0`，该选项会关闭证书校验，不适合真实验收：[Bun 环境变量文档](https://bun.sh/docs/runtime/environment-variables)。

因此最安全、最可重复的方案是：

- 使用公网可验证的 Let’s Encrypt 证书；
- 使用 `<ip-dashed>.sslip.io`；
- 不使用内部 CA；
- 不设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`。

如果 Docker 容器访问公网 IPv4 存在 hairpin 问题，可让证书域名在 Docker DNS/`extra_hosts` 中解析到 Caddy 内部地址，但仍必须保持 HTTPS 和正确 hostname。

### Peer server

- 默认 `TMEX_PEER_PORT=39001`，见 `apps/gateway/src/config.ts:93-103`。
- 默认绑定 `::,0.0.0.0`，见 `config.ts:115-125`。
- 建议显式设置：

```text
TMEX_PEER_BIND_HOST=0.0.0.0
```

IPv6 绑定失败时 `peer-server.ts:101-130` 只要 IPv4 成功就能继续，但容器仍可能向其他节点广告不可达 IPv6 地址。

---

## 4. 非交互凭证与 HTTP 登录

### CLI 凭证

`packages/app/src/cli/help.ts:20-23`：

- `hub user add`：非 TTY 从 `TMEX_PASSWORD` 读取。
- `enroll`：从 `TMEX_PASSWORD` 读取。
- TOTP：从 `TMEX_TOTP` 读取。
- `hub user passwd` 旧密码使用 `TMEX_PASSWORD_OLD`。

`enroll.ts:210-245` 会从密码派生 root key，并校验 root public key。

### 推荐 enrollment 流程

在 Hub 容器：

```bash
TMEX_PASSWORD="$PASSWORD" npx tmex-cli hub user add alice --install-dir /opt/tmex
```

然后运行：

```bash
TMEX_PASSWORD="$PASSWORD" npx tmex-cli enroll --install-dir /opt/tmex
```

`enroll.ts:247-260` 在 hub 角色下创建本地 enrollment token；`enroll.ts:296-299` 立即打印 join token 和 join 命令。

但 `enroll` 默认不会立即退出，见 `enroll.ts:301-365`。它会等待节点 redeem，然后自动执行 `admit-node`。因此：

1. 保持 `enroll` 进程运行；
2. 从容器日志中提取 token；
3. 在 node 容器执行 `hub join`；
4. 等待 Hub 的 enroll 进程输出 `node admitted`。

不要为了拿 token 而提前终止 enroll，否则 node 可能只完成 redeem，未完成 key log admission。

Node 容器执行：

```bash
npx tmex-cli hub join \
  https://hub.<ip-dashed>.sslip.io \
  --token "$TOKEN" \
  --name node-a \
  --install-dir /opt/tmex
```

`hub join` 不需要 `TMEX_PASSWORD`；它使用 token、本地 node identity 和 hub certificate 流程，见 `hub.ts:289-326`。

### 非 hub `enroll` 的已知问题

`packages/app/src/commands/enroll.ts:261-293` 在非 hub node 上会：

1. GET `/api/auth/mode`；
2. 通过 `loginWithRootKey()` 登录 hub；
3. POST `/api/hub/enrollments`。

但 `packages/app/src/lib/hub-client.ts:198-216` 要求 `/api/auth/login` JSON 返回 `sid`。

实际 gateway `apps/gateway/src/mesh/auth-routes.ts:321-326` 返回：

```json
{ "expires_at": 1234567890 }
```

session id 放在内部响应头 `x-tmex-set-session`，不是 JSON body。现有 `enroll.test.ts` mock 返回 `sid`，没有捕获这个差异。

因此第一轮实测应使用“Hub 上运行 `enroll`，Node 上运行 `hub join`”，不要依赖非 hub `enroll`。

### 浏览器密码登录的准确请求序列

浏览器不直接向服务器发送密码。实现位于：

- `apps/fe/src/pages/LoginPage.tsx:138-188`
- `apps/fe/src/auth/session-key-store.ts:218-228,441-505`
- `apps/gateway/src/mesh/auth-routes.ts:98-214,217-326`

Entry 登录：

1. `GET /api/auth/mode`

   返回 `uid`、`kdfParams`、`rootEpoch`、`totpEnabled`、`nodeId` 等。

2. 浏览器使用 `kdfParams` 和密码本地执行 Argon2 派生 seed/root key。

3. 生成临时 Ed25519 session key。

4. 使用 root key 创建 delegation。

5. `POST /api/auth/challenge`

   ```json
   { "uid": "<user-id>" }
   ```

   返回：

   ```json
   {
     "challenge_id": "...",
     "nonce": "...",
     "nodePk": "..."
   }
   ```

6. 使用 challenge、nonce、目标 node ID、公钥和 `entry` 字段构造 login，分别生成：

   ```text
   login
   sig
   delegation
   delegation_sig
   ```

7. `POST /api/auth/login`

   ```json
   {
     "login": "...",
     "sig": "...",
     "delegation": "...",
     "delegation_sig": "...",
     "totp": {
       "code": "...",
       "k_totp": "..."
     }
   }
   ```

   TOTP 字段仅在启用时发送。

8. gateway 响应 body 只有 `{expires_at}`，同时设置 session cookie。浏览器自动保存 `tmex_s_self`。

Remote node 登录：

1. 使用 Entry cookie；
2. `POST /n/<node-id>/api/auth/challenge`；
3. 校验返回的 `nodePk` 与 `/api/mesh/nodes` 公钥一致；
4. 构造 `entry=<entry-node-id>` 的 login；
5. `POST /n/<node-id>/api/auth/login`；
6. 保存返回的 `tmex_s_<node-id>` cookie。

已有可复用实现：

- `apps/gateway/src/mesh/auth-routes.test.ts:251-317`
- `apps/gateway/src/mesh/integration/mesh.integration.test.ts:135-216`

`runtime/cli-auth.js` 是本地数据库/enrollment CLI，不是 HTTP 登录 cookie 工具。

---

## 5. 可观测 endpoint 与终端/文件 API

### 状态接口

| 用途 | 请求 | 返回/断言 |
|---|---|---|
| 健康检查 | `GET /healthz` | `{status:"ok", env:"production", ...}`；`system-routes.ts:67-92` |
| Hub 节点状态 | `GET /api/hub/nodes` | `{nodes:[{id,name,status,online,version,last_seen_at,direct_capable,...}]}`；`hub-runtime.ts:240-267` |
| Mesh 节点状态 | `GET /api/mesh/nodes` | `{nodes:[...]}`；DTO 见 `mesh-routes.ts:34-45` |
| RTC 配置 | `GET /api/mesh/rtc-config` | `{stun:[...],turn:null\|object}` |
| 当前连接 | `GET /api/mesh/connection?cid=<cid>` | `{connectionId}`；无连接为 `404 NO_CONNECTION` |
| RTC 授权 | `POST /api/rtc/authorize` | body 为 `rtcSession`、`fp_browser`、可选 `connectionId`；成功返回 `{nonce,fp_node}` |

`/api/hub/nodes` 的 `online` 表示 Hub registry 中存在已认证 uplink，见 `hub-runtime.ts:255-267`。

`/api/mesh/nodes` 的关键字段：

```json
{
  "id": "...",
  "name": "...",
  "publicKey": "...",
  "online": true,
  "reach": "lan",
  "version": "1.0.2",
  "direct_capable": true,
  "inventory": {},
  "loggedIn": true,
  "isHub": false
}
```

`reach` 来自 `peer-manager.ts:386-399`：

- `relay`：当前 link 通过 Hub relay；
- `lan`：当前 link 不是 relay，包括直接 WebSocket 和 RTC；
- `null`：已知但没有 live link。

所以该接口不能区分 `ws-secure` 与 RTC，`direct_capable` 也只表示 native 能力，不表示当前连接已经走 RTC。

### Peer/LAN 地址

节点状态上报包含：

```text
endpoints: ["ws://<non-loopback-ip>:39001/peer"]
```

来源：

- `mesh-runtime.ts:390-409`
- `mesh-runtime.ts:715-724`
- `peer-manager.ts:943-959`

但 `/api/hub/nodes` DTO 不返回 `endpoints`，只返回 `direct_capable` 等字段。因此脚本不能只靠该 HTTP API 读取广告的 LAN 地址。需要：

- 检查节点日志；
- 读取节点自身/entry 的 peer cache；
- 或使用 in-process harness 检查 `endpointsJson`。

Hub down 验证重点应使用 `/api/mesh/nodes` 的 `reach`，而不是 `/api/hub/nodes`。

### Remote terminal/tmux

没有“REST 创建 tmux session”的接口。

可行步骤：

1. 在 node 容器创建专用 tmux session：

   ```bash
   tmux -L tmex-node-b new-session -d -s e2e-b \
     "sh -lc 'echo READY; exec sh'"
   ```

2. 通过目标 node API 创建 local device：

   ```http
   POST /n/<node-id>/api/devices
   Content-Type: application/json
   ```

   ```json
   {
     "name": "node-b-local",
     "type": "local",
     "session": "e2e-b",
     "authMode": "auto"
   }
   ```

   `device-routes.ts:67-105` 负责 body；成功返回 `{device}`。

3. 获取 tmux 树：

   ```http
   GET /n/<node-id>/api/tmux/tree?deviceId=<device-id>
   ```

   返回：

   ```json
   {
     "devices": [{
       "deviceId": "...",
       "deviceName": "...",
       "session": {
         "windows": [...]
       }
     }]
   }
   ```

   见 `apps/gateway/src/api/tmux-tree.ts:10-55`。

4. 真实输入/输出必须使用 WebSocket：

   ```text
   /n/<node-id>/ws?cid=<tab-nonce>
   ```

   `forwarder.ts:206-245` 负责远程 WS 转发。

5. WS 使用二进制 Borsh 协议，不是 JSON：
   - C2S `HELLO`
   - `DEVICE_CONNECT`
   - `TMUX_SELECT`
   - `TERM_INPUT`
   - 解码 `TERM_HISTORY` / `TERM_OUTPUT`

   schema 见 `packages/shared/src/ws-borsh/schema.ts:54-99,209-250`；已有 builder 见 `packages/ws-client/src/message-builder.ts:14-73,145-190`。

最小断言是向 pane 输入唯一 marker，例如 `TMEX_E2E_MARKER_001`，等待 `TERM_OUTPUT` 中出现该 marker。

### 文件列表

先在目标 node 创建 file device 和 file root：

```http
POST /n/<node-id>/api/devices
POST /n/<node-id>/api/files/roots
```

root body：

```json
{
  "deviceId": "...",
  "path": "/e2e",
  "enabled": true
}
```

root 返回 `{root}`，见 `file-root-routes.ts:41-115`。

目录列表：

```http
GET /n/<node-id>/api/files/list?rootId=<root-id>&path=%2Fe2e
```

返回：

```json
{
  "path": "/e2e",
  "entries": [{
    "name": "marker.txt",
    "path": "/e2e/marker.txt",
    "type": "file",
    "category": "text",
    "size": 10,
    "modifiedAt": "...",
    "isSymlink": false
  }],
  "truncated": false
}
```

实现见：

- `file-browser-routes.ts:6-63`
- `device-storage.ts:154-180`
- `packages/shared/src/contracts/files.ts:72-100`

文本读取：

```http
GET /n/<node-id>/api/files/content?rootId=<root-id>&path=%2Fe2e%2Fmarker.txt
```

下载/原始文件：

```http
GET /n/<node-id>/api/files/raw?rootId=<root-id>&path=...
GET /n/<node-id>/api/files/download?rootId=<root-id>&path=...
```

本地文件功能依赖 `rsync`；缺失时会返回 `rsync_missing_local`。

---

## 6. 现有 E2E 基础设施

### Playwright

`apps/fe/playwright.config.ts`：

- 默认 gateway `9665`、frontend `9885`：`21-27`
- testDir 为 `./tests`：`68-85`
- gateway 使用 Bun source 启动：`92-115`
- frontend 使用 `bun run dev`：`116-135`
- `NODE_ENV=test`
- 数据库为临时数据库
- tmux socket 为 `tmex-e2e`

`apps/fe/scripts/run-e2e.ts:58-88` 会自动选择可用端口。

`apps/fe/tests/global-setup.ts:7-32` 会检查 `/healthz` 的 `env === "test"`，防止误连生产实例。

### 是否已有多容器 mesh harness

当前没有发现 `apps/fe/e2e` 多容器 mesh harness，也没有 `virtual authenticator` 使用。现有可复用内容：

- `apps/fe/tests/helpers/tmux.ts:1-45`：专用 tmux socket 和 session 创建。
- `apps/fe/tests/helpers/device.ts:7-52`：创建设备、等待终端。
- `apps/gateway/src/mesh/integration/mesh.integration.test.ts:471-484`：
  - 浏览器式登录；
  - remote node 登录；
  - `/n/B/api/devices` 访问。
- 同文件 `:486` 起：
  - `/n/B/ws`；
  - HELLO；
  - DEVICE_CONNECT。
- `apps/gateway/src/mesh/integration/direct-path.integration.test.ts:180-230`：
  - 浏览器授权；
  - RTC signaling；
  - carrier switch；
  - bulk 数据。
- 同文件 `:738-901`：
  - 真实 HubRuntime/UplinkServer；
  - node-to-node DC；
  - 断言 `transportOf() === "dc"`。
- `apps/gateway/src/mesh/rtc/rtc-loopback.integration.ts:149-200`：
  - 真实 `node_datachannel.node`；
  - node-to-node DataChannel round-trip。

默认测试脚本不会发现 `*.integration.ts`，真实 native 测试需要显式指定文件，并设置 `TMEX_NATIVE_DIR`。

建议为远程 hub 单独增加 Playwright 配置：

```text
baseURL=https://entry.<ip-dashed>.sslip.io
webServer 不启动本地 gateway/frontend
globalSetup 不使用本地 test-env 断言
```

密码登录不需要 virtual authenticator。

---

## 7. 风险与未知项

1. `npx tmex-cli direct enable` 与 Node-target CLI 使用 Bun API，可能静默 skipped；必须用 Bun 运行 CLI 或预装 native 文件。
2. 非 hub `enroll` 的 `sid` 预期与真实 gateway 登录响应不一致。
3. Alpine/musl 不支持当前 Linux native direct addon。
4. `init --autostart false` 仍要求 systemd/launchd，不能用于普通容器。
5. Hub/gateway 本身只提供 HTTP，必须由 Caddy 终止 TLS。
6. uplink 没有应用层 CA 配置；真实验证应使用公网可信证书。
7. `GATEWAY_PORT` 源码默认是 9663，安装版 runtime 默认是 9883；compose 必须显式设置。
8. Peer port 默认 39001，建议显式 `TMEX_PEER_BIND_HOST=0.0.0.0`。
9. `reach:"lan"` 同时代表直接 WS 和 RTC，不能据此证明已经使用 RTC。
10. `/api/hub/nodes` 不返回 advertised LAN endpoints。
11. Hub down 时现有 live direct link 可以继续；relay link 依赖 Hub，Hub down 后不能保证继续。
12. cached endpoint 实际是 cached `ws://.../peer` 地址，不是缓存的 RTC signaling。
13. `enroll` token 会出现在日志和命令行参数中，应限制日志权限并在测试后清理。
14. 文件列表依赖 `rsync`，终端依赖 `tmux`。
15. 容器网络可能广告 Docker 内部 IPv6/多网卡地址；应固定 IPv4 bind 并检查实际 endpoints。
16. `hub` 进程作为 entry 时无法测试 hub down；必须准备 node-a 作为备用 entry。

## 建议的 Docker Compose 拓扑

### 服务与网络

| 服务 | 网络 | 用途 |
|---|---|---|
| `caddy` | `edge` | 公网 HTTPS、反代 hub 和 node-a |
| `hub` | `edge`、`uplink-a`、`uplink-b` | `TMEX_ROLES=hub,node` |
| `node-a` | `edge`、`uplink-a`、`lan` | 备用 entry、LAN 对端 |
| `node-b` | `uplink-b`、`lan` | 远程目标节点 |
| `node-mac` | 外部公网，仅出站 | 可选 Docker Desktop NAT 节点 |

网络设计使：

- hub 与 node-a、node-b 分别拥有独立 uplink；
- node-a/node-b 只有通过 `lan` 才能直接发现彼此；
- 移除 `lan` 后可强制 relay；
- node-a 通过 Caddy 暴露为备用 entry；
- node-b 不暴露公网端口；
- hub 可选择发布 `39001:39001`，用于验证 hub node 的 peer 入站。

Caddy 路由：

```text
hub.<ip-dashed>.sslip.io   -> http://hub:9883
entry.<ip-dashed>.sslip.io -> http://node-a:9883
```

公网端口：

```text
80/tcp  -> Caddy
443/tcp -> Caddy
39001/tcp -> hub，可选
```

### Hub 环境

```text
NODE_ENV=production
TMEX_ROLES=hub,node
TMEX_BIND_HOST=0.0.0.0
GATEWAY_PORT=9883
DATABASE_URL=/var/lib/tmex/tmex.db
TMEX_MASTER_KEY=<hub-secret>
TMEX_BASE_URL=https://hub.<ip-dashed>.sslip.io
TMEX_HUB_PUBLIC_URL=https://hub.<ip-dashed>.sslip.io
TMEX_TRUST_PROXY=true
TMEX_PEER_PORT=39001
TMEX_PEER_BIND_HOST=0.0.0.0
TMEX_TMUX_SOCKET=tmex-hub
TMEX_FE_DIST_DIR=/opt/tmex/resources/fe-dist
TMEX_MIGRATIONS_DIR=/opt/tmex/resources/gateway-drizzle
TMEX_NATIVE_DIR=/opt/tmex/native
```

### Node-a 环境

```text
NODE_ENV=production
TMEX_ROLES=node
TMEX_HUB_URL=https://hub.<ip-dashed>.sslip.io
TMEX_BIND_HOST=0.0.0.0
GATEWAY_PORT=9883
DATABASE_URL=/var/lib/tmex/tmex.db
TMEX_MASTER_KEY=<node-a-secret>
TMEX_BASE_URL=https://entry.<ip-dashed>.sslip.io
TMEX_TRUST_PROXY=true
TMEX_PEER_PORT=39001
TMEX_PEER_BIND_HOST=0.0.0.0
TMEX_TMUX_SOCKET=tmex-node-a
TMEX_FE_DIST_DIR=/opt/tmex/resources/fe-dist
TMEX_MIGRATIONS_DIR=/opt/tmex/resources/gateway-drizzle
TMEX_NATIVE_DIR=/opt/tmex/native
```

### Node-b 环境

与 node-a 相同，但使用独立：

```text
TMEX_MASTER_KEY=<node-b-secret>
TMEX_TMUX_SOCKET=tmex-node-b
DATABASE_URL=/var/lib/tmex/tmex.db
```

每个容器必须使用独立数据库和独立 master key。`app.env` 也应分别挂载到 `/opt/tmex/app.env`，因为 `npx` 认证命令会读取该文件；Compose `environment` 不会自动生成 `app.env`。

## 有序验证脚本大纲

1. macOS 执行 `bun run build` 和 `npm pack`，生成 `tmex-cli-1.0.2.tgz`。
2. 构建 glibc Linux 镜像，安装 Bun、Node/npm、tmux、rsync、ca-certificates。
3. 准备 `/opt/tmex` runtime/resources/app.env 和独立持久化数据库。
4. 先启动 Caddy、hub、node-a、node-b；确认 `/healthz`。
5. 在 hub 上执行 `hub user add`。
6. 保持 hub 上的 `enroll` 进程运行，从日志取得 token。
7. 停止 node-a，执行 `hub join`；接受无 service manager 导致的非零退出。
8. 启动 node-a；等待 `/api/hub/nodes` 中 `online=true`。
9. 对 node-b 重复 enrollment/join 流程。
10. 通过 `hub.<ip-dashed>.sslip.io` 浏览器密码登录；确认 entry cookie、`/api/hub/nodes`、`/api/mesh/nodes`。
11. 访问 node-b：
    - `/n/B/api/devices`
    - `/n/B/api/tmux/tree`
    - `/n/B/ws`
    - 文件 roots/list/content。
12. 无 `lan` 时确认 node-a → node-b 的 `reach:"relay"`。
13. 连接 `lan` 后确认 `reach:"lan"`，并在日志或 in-process harness 中确认实际 `transportOf() === "dc"`。
14. 先建立 node-a 与 node-b 的 live direct link，再停止 hub 容器。
15. 使用 `entry.<ip-dashed>.sslip.io` 登录的既有浏览器会话继续访问 node-b，确认终端 marker 和文件列表仍可用。
16. 恢复 hub，确认 uplink online、Hub 节点列表恢复，浏览器无需重新登录。
17. 在 Linux 容器内用 Bun 执行 `direct enable`，检查 native 文件、manifest 和 `direct_capable=true`。
18. 运行显式的 `rtc-loopback.integration.ts` real-native 测试。
19. 对已建立 direct carrier 注入受控网络中断，持续写入带序号 marker，确认 fallback carrier 没有丢失输出。
20. 最后再加入 macOS Docker Desktop node，验证无入站 peer port 时只能通过 relay 或已建立的 direct path。