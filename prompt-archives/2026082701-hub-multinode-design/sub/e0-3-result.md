# E0-3 只读代码勘探报告

## 1. Packaged server startup

当前 packaged server 只构造 `GatewayRuntime`，尚未按 `TMEX_ROLES` 装配 Hub/Mesh。

1. `server.ts` 首先导入 `bootstrap-env`。该模块在导入求值时调用 `loadEnv()`，因此生产 runtime 依赖安装版 `run.sh` 提前注入的环境变量。`packages/app/src/runtime/server.ts:1`、`packages/app/src/runtime/bootstrap-env.ts:1-5`

2. `main()` 读取版本、监听地址、端口和前端静态目录：

   - `TMEX_BIND_HOST` 默认 `127.0.0.1`；
   - `GATEWAY_PORT` 默认 `9883`；
   - `TMEX_FE_DIST_DIR` 存在时使用其绝对路径，否则使用 `import.meta.dir/../../resources/fe-dist`。

   `packages/app/src/runtime/server.ts:9-21`

3. 调用 `createTmexGatewayRuntime()`。该 wrapper 只注入系统 API handler，随后调用 `createGatewayRuntime({ systemApiHandler })`。`packages/app/src/runtime/server.ts:23`、`packages/app/src/runtime/gateway.ts:1-10`

4. `GatewayRuntime` 默认执行迁移。`runMigrations()` 调用 `getDb()`；首次访问数据库时使用 `config.databaseUrl` 创建 SQLite 客户端，并设置 WAL、外键、busy timeout 和 synchronous 等 pragma。`apps/gateway/src/runtime.ts:53-65`、`apps/gateway/src/db/migrate.ts:6-17`、`apps/gateway/src/db/client.ts:16-34`

5. 默认初始化站点数据：

   - `ensureDefaultLocalDeviceSeeded()`；
   - `ensureSiteSettingsInitialized()`；
   - `ensureAgentSettingsInitialized()`。

   `runMigrationsOnStart` 和 `initializeSiteSettings` 均可通过选项关闭，但默认都是 `true`。`apps/gateway/src/runtime.ts:56-72`

6. 启动时还会执行以下副作用：

   - 重置 runtime restart 状态；
   - 调用 `primeLocalShellPath()`；
   - 清理孤立文件传输临时目录；
   - 创建 `WebSocketServer`；
   - 读取站点主题；
   - 注册 connection alert、snapshot、theme、settings、event 和 tree overlay bridge；
   - 刷新 Telegram、微信服务；
   - 启动 push、agent、watch supervisor；
   - 尝试发送 Telegram/微信上线通知。

   `apps/gateway/src/runtime.ts:74-121`

   `primeLocalShellPath()` 并不是 `tmux -V` 版本检查，而是探测登录 shell 环境，并检查 PATH 中是否能找到 `tmux`。`apps/gateway/src/tmux/local-shell-path.ts:173-198`、`apps/gateway/src/tmux/local-shell-path.ts:242-244`

   push supervisor 启动时会遍历设备并建立 tmux runtime；agent supervisor 会恢复数据库中处于运行或等待确认状态的 agent session；watch supervisor 会重新调度启用的规则。`apps/gateway/src/push/supervisor.ts:136-145`、`apps/gateway/src/push/supervisor.ts:233-306`、`apps/gateway/src/agent/supervisor.ts:148-210`、`apps/gateway/src/watch/service.ts:127-145`

7. 创建 Bun server。当前选项只有：

   - `hostname`
   - `port`
   - `fetch`
   - `websocket`

   packaged server 没有设置 gateway 主入口中使用的 `idleTimeout: 255`。`packages/app/src/runtime/server.ts:25-37`、`apps/gateway/src/index.ts:15-29`

8. 当前请求顺序是：

   ```text
   GatewayRuntime.handleRequest
           ↓ 未处理
   serveFrontend
   ```

   `packages/app/src/runtime/server.ts:28-35`

   设计要求的顺序则是：

   ```text
   HubRuntime → MeshRuntime → GatewayRuntime → 静态资源 / SPA
   ```

   `docs/hub/2026082700-hub-node-architecture.md:274-282`

9. Gateway 请求返回非 `undefined` 时，server 直接返回该响应；否则交给 `serveFrontend()`。`packages/app/src/runtime/server.ts:28-35`

10. WebSocket handler 直接使用 `gateway.websocket`。HTTP `/ws` upgrade 由 `GatewayRuntime.handleRequest()` 调用 `WebSocketServer.handleUpgrade()`；成功 upgrade 时返回 `undefined`，交由 Bun 完成 WebSocket 生命周期。`packages/app/src/runtime/server.ts:36`、`apps/gateway/src/runtime.ts:125-160`

11. 静态/SPA 服务行为：

   - 只接受 `GET` 和 `HEAD`，其他方法返回 `405`；
   - URL 编码错误返回 `400`；
   - 路径越界返回 `403`；
   - 带扩展名但文件不存在返回 `404`；
   - 无扩展名且文件不存在时回退到 `index.html`；
   - `index.html` 不存在返回 `500`；
   - 文件存在时用 `Bun.file()` 返回，并按扩展名设置 MIME。

   `packages/app/src/runtime/serve-frontend.ts:26-42`、`packages/app/src/runtime/serve-frontend.ts:45-82`

12. 关停当前只接入“运行时主动请求重启”：

   - `gateway.stop()`；
   - `server.stop(true)`；
   - `process.exit(0)`。

   `packages/app/src/runtime/server.ts:39-44`

   `GatewayRuntime.stop()` 会清除 broadcaster、关闭 WebSocket、停止 watch、agent、push、tmux runtime、Telegram 和微信服务。`apps/gateway/src/runtime.ts:164-178`

   `server.ts` 没有注册 `SIGINT` 或 `SIGTERM` handler；仅注册了 `unhandledRejection` 和 `uncaughtException`。`packages/app/src/runtime/server.ts:49-55`

## 2. `GatewayRuntime` 构造函数与 `handleRequest`

### 当前选项

`GatewayRuntimeOptions` 当前支持四个选项：

| 选项 | 默认值 | 作用 |
|---|---:|---|
| `runMigrationsOnStart` | `true` | 启动时执行 gateway Drizzle 迁移 |
| `initializeSiteSettings` | `true` | 初始化本地设备、站点设置、agent 设置 |
| `migrationsFolder` | 自动解析 | 覆盖迁移目录 |
| `systemApiHandler` | `undefined` | 处理 `/api/system/*` |

`apps/gateway/src/runtime.ts:28-33`、`apps/gateway/src/runtime.ts:53-61`

返回的 runtime 接口包含 `port`、`handleRequest`、`websocket`、`onRestartRequested` 和 `stop`。`apps/gateway/src/runtime.ts:35-51`

### 当前 HTTP/WS 匹配

`handleRequest()` 的判断顺序是：

1. `pathname === '/ws'`：调用 `wsServer.handleUpgrade()`；
2. `pathname.startsWith('/api/')` 或 `pathname === '/healthz'`：调用 `handleApiRequest()`；
3. 其他路径返回 `undefined`，交给 packaged server 的静态处理。

`apps/gateway/src/runtime.ts:123-144`

`/ws` 分支中：

- `handleUpgrade()` 返回 `false` 时返回 `404`；
- 返回 `Response` 时直接返回该响应，当前对应 upgrade 失败时的 `500`；
- 成功 upgrade 时返回 `undefined`。

`apps/gateway/src/runtime.ts:128-137`、`apps/gateway/src/ws/index.ts:135-147`

`handleApiRequest()` 会构造 `ApiRouteContext`，调用统一路由分发器；未匹配路由时始终返回 API JSON `404`。`apps/gateway/src/api/index.ts:42-52`

API 路由表当前包含 capabilities、devices、tmux tree、settings、Telegram、微信、LLM、agent、watch、files、system 和 health 路由。`apps/gateway/src/api/index.ts:26-40`

路由分发器只有在 handler 返回 truthy `Response` 时才停止；handler 返回 `undefined` 时会继续查找，最终由 `handleApiRequest()` 返回 `404`。`apps/gateway/src/api/route.ts:76-89`

因此：

| 请求 | 当前行为 |
|---|---|
| `/ws` | 进入 WebSocket upgrade；失败为 `404` 或 `500` |
| `/api/foo` | 进入 API 路由；未匹配返回 API `404` |
| `/healthz` | 进入 API 路由 |
| `/api` | 不满足 `/api/` 前缀，返回 `undefined`，随后可能被 SPA fallback |
| `/unknown` | 返回 `undefined`，随后进入静态/SPA |
| `/api/system/unknown` | system handler 未返回响应，最终 API `404` |

### `dispatchHttp(Request, ctx)` 落点

设计要求目标 node 在 link 的 HTTP 流上调用：

```text
GatewayRuntime.dispatchHttp(Request, { uid })
```

`docs/hub/2026082701-hub-multinode-design/plan-00.md:31-35`

最自然的代码落点是：

- 在 `GatewayRuntime` 接口中，与现有 `handleRequest` 并列新增 `dispatchHttp`；
- 在 `createGatewayRuntime()` 返回对象中实现；
- 复用现有 API 路由表和业务 handler；
- 不执行 Bun upgrade；
- 将 `{ uid }` 作为新的请求上下文传入。

当前 `ApiRouteContext.server` 是必填的 `Server<unknown>`，但现有 API handler 没有直接使用 `ctx.server`；测试也普遍传入空对象。因此，`dispatchHttp` 可以作为后续解耦 `ApiRouteContext` 的切入点。`apps/gateway/src/api/route.ts:11-15`、`apps/gateway/src/api/route.ts:29-33`

### WS upgrade 对 server 对象的依赖

`WebSocketServer.handleUpgrade()` 需要真实的 Bun `Server`，因为它调用：

```ts
server.upgrade(req, { data: { borshState } })
```

`apps/gateway/src/ws/index.ts:135-147`

因此，远程 link 上的 `/ws` 流不能直接复用当前 `handleUpgrade()`；它应绕过 Bun upgrade，创建 `GatewaySession` 并将 link carrier 接入 WS 状态机。设计已明确 WS 流应包装为 `LinkStreamCarrier` 后挂到新的 `GatewaySession`。`docs/hub/2026082700-hub-node-architecture.md:189-203`、`docs/hub/2026082701-hub-multinode-design/plan-00.md:33-35`

## 3. Install layout 与 CLI

### Install layout

`PackageLayout` 当前字段：

- `packageRoot`
- `cliDistPath`
- `runtimeDirPath`
- `resourceFePath`
- `resourceDrizzlePath`

`packages/app/src/lib/install-layout.ts:6-12`

`InstallLayout` 当前字段：

- `installDir`
- `runtimeDir`
- `runtimeServerPath`
- `resourcesDir`
- `feDir`
- `drizzleDir`
- `envPath`
- `runScriptPath`
- `metaPath`

`packages/app/src/lib/install-layout.ts:14-24`

路径映射如下：

- runtime：`<installDir>/runtime/server.js`
- 前端：`<installDir>/resources/fe-dist`
- 迁移：`<installDir>/resources/gateway-drizzle`
- 环境文件：`<installDir>/app.env`
- 启动脚本：`<installDir>/run.sh`
- 元数据：`<installDir>/install-meta.json`

`packages/app/src/lib/install-layout.ts:26-37`

`resolvePackageLayout()` 会验证 runtime、前端 dist 和 Drizzle 资源是否存在，但没有 native 资源字段或校验。`packages/app/src/lib/install-layout.ts:80-106`

设计要求的 `nativeDir` 应首先加入 `InstallLayout`，映射为：

```text
<installDir>/native
```

对应落点是 `packages/app/src/lib/install-layout.ts:14-37`。由于 node-datachannel addon 是按平台下载，而不是当前 resources 复制流程中的固定资源，`PackageLayout` 是否增加 native 字段需要与 `direct enable|disable` 的下载策略保持一致。设计中明确指定了 `install-layout.nativeDir`。`docs/hub/2026082700-hub-node-architecture.md:290-298`

### app.env 写入与读取

当前 `buildAppEnvValues()` 写入：

- `NODE_ENV`
- `TMEX_BIND_HOST`
- `GATEWAY_PORT`
- `DATABASE_URL`
- `TMEX_MASTER_KEY`
- `TMEX_BASE_URL`
- `TMEX_SITE_NAME`

`packages/app/src/lib/install.ts:15-31`

`writeEnvFile()` 将键按字典序写入，并使用权限 `0600`。`packages/app/src/lib/env-file.ts:21-39`

`writeRunScript()`：

1. 读取 `app.env`；
2. 对每行执行 `export "$line"`；
3. 设置 Bun 和 Homebrew 等 PATH；
4. 强制导出 `TMEX_FE_DIST_DIR`；
5. 强制导出 `TMEX_MIGRATIONS_DIR`；
6. 执行 `<bunPath> <installDir>/runtime/server.js`。

`packages/app/src/lib/install.ts:84-110`

生产环境的 `loadEnv()` 不会再次读取 `app.env` 或仓库 env 文件，而是校验 `run.sh` 注入到进程的值。`packages/shared/src/env/load-env.ts:116-154`

CLI 侧读取 app.env 的位置包括：

- upgrade 健康检查；
- uninstall 获取数据库路径；
- doctor 环境检查。

`packages/app/src/commands/upgrade.ts:51-59`、`packages/app/src/commands/uninstall.ts:43-49`、`packages/app/src/commands/doctor-checks.ts:128-181`

未来应在 `AppEnvInput`、`buildAppEnvValues()` 和 `writeRunScript()` 中接入角色相关变量。主要落点是 `packages/app/src/lib/install.ts:15-31`、`packages/app/src/lib/install.ts:84-105`。若 native loader 依赖显式路径，还需要决定是否增加 `TMEX_NATIVE_DIR`。

### CLI 注册、解析与 prompts

CLI 入口只注册四个命令：

- `init`
- `doctor`
- `upgrade`
- `uninstall`

`packages/app/src/cli-node.ts:12-41`

npm bin 只是加载编译后的 CLI 并捕获异常。`packages/app/bin/tmex.js:1-7`

当前没有使用 commander、yargs 等参数库，而是自定义 `parseArgs()`：

- 第一个非 flag token 是 command；
- 后续非 flag token 进入 `positionals`；
- `--key=value` 支持等号形式；
- `--key value` 支持空格形式；
- 没有专门的 subcommand 结构。

`packages/app/src/lib/args.ts:3-44`

因此，未来的 `hub user add <username>` 当前会被解析为：

```text
command = "hub"
positionals = ["user", "add", "<username>"]
```

需要在 CLI 层增加嵌套命令分派。新命令设计见 `docs/hub/2026082700-hub-node-architecture.md:290-298`。

交互输入使用 Node readline：

- `promptText()`；
- `promptConfirm()`；
- `--no-interactive` 时使用默认值或空值。

`packages/app/src/lib/prompt.ts:4-51`

### init 流程

`runInit()` 的流程是：

1. 检查 service manager；
2. 解析交互或非交互配置；
3. 检查 tmux；
4. 检查 Bun；
5. 检查安装目录是否为空；
6. 解析 package layout 和 install layout；
7. 创建目录并部署 runtime、前端和迁移；
8. 生成 master key；
9. 写 app.env；
10. 写 run.sh；
11. 安装并启动 service；
12. 写 install metadata。

`packages/app/src/commands/init.ts:182-277`

当前 `InitConfig` 没有角色字段。`packages/app/src/types.ts:7-18`

`init --role` 应接入：

- `InitConfig`；
- `buildInitConfig()` 的 flag 解析；
- `buildAppEnvValues()`；
- help 文案；
- native addon 可选安装流程。

对应当前落点是 `packages/app/src/types.ts:7-18`、`packages/app/src/commands/init.ts:67-153`、`packages/app/src/commands/init.ts:232-267`。

### install、upgrade、service

当前没有独立的 `install` CLI 命令。`install.ts` 是安装库，不是命令入口。`packages/app/src/lib/install.ts:1-170`、`packages/app/src/cli-node.ts:19-41`

当前也没有独立的 `service` CLI 命令。`service.ts` 是 service manager 库，被 init、upgrade、uninstall、doctor 调用。`packages/app/src/lib/service.ts:191-205`、`packages/app/src/commands/init.ts:250-255`、`packages/app/src/commands/upgrade.ts:115-147`

`upgrade` 分两种模式：

- 默认模式通过 `npx tmex-cli@<version> upgrade --apply-current-package` 委托升级；
- `--apply-current-package` 模式停止 service、备份 runtime/resources/run.sh/meta、部署新产物、重写 run.sh、更新 metadata、重新安装 service、健康检查；失败时恢复备份。

`packages/app/src/commands/upgrade.ts:30-49`、`packages/app/src/commands/upgrade.ts:80-152`

升级不会重写 `app.env`，也不会在备份中单独备份 app.env；新增角色或 hub 配置需要明确设计保留、迁移和默认值策略。`packages/app/src/commands/upgrade.ts:112-151`、`packages/app/src/lib/install.ts:120-170`

### service 重启

systemd user service：

- 写入 `~/.config/systemd/user/<name>.service`；
- `daemon-reload`；
- 按需 `enable`；
- 总是执行 `restart`；
- unit 设置 `Restart=always`。

`packages/app/src/lib/service.ts:45-72`、`packages/app/src/lib/service.ts:118-151`

launchd：

- plist 目标为 `~/Library/LaunchAgents` 或 installDir；
- 先 bootout 两个可能存在的 job；
- 再执行 `launchctl bootstrap`；
- plist 设置 `RunAtLoad`、`KeepAlive` 和 `AbandonProcessGroup`。

`packages/app/src/lib/service.ts:83-116`、`packages/app/src/lib/service.ts:153-189`

因此当前“服务重启”依赖进程退出和 service manager 拉起，不是 runtime 自己监听系统信号。`packages/app/src/runtime/server.ts:39-55`

## 4. Build / bundle

### runtime/server.js 生成

根脚本的主要构建链是：

```text
build:i18n
→ build:fe
→ build:tmex:resources
→ build:tmex
```

`package.json:8-23`

`packages/app` 的 build 会执行：

```text
clean
→ bundle:resources
→ build:runtime
→ build:cli
```

`packages/app/package.json:19-27`

`build-runtime.ts` 使用 Bun bundler：

- entry：`src/runtime/server.ts`
- output：`./dist/runtime`
- target：`bun`
- format：`esm`
- define：`TMEX_MONOREPO_VERSION`

`packages/app/scripts/build-runtime.ts:18-36`

因此预期输出为：

```text
packages/app/dist/runtime/server.js
```

该路径也是 `resolvePackageLayout()` 的硬性检查目标。`packages/app/src/lib/install-layout.ts:84-94`

当前 app runtime bundle 没有指定 `--external`，也没有 native addon 特殊处理。`packages/app/scripts/build-runtime.ts:18-32`

### 前端 dist 与迁移资源

`bundle-resources.sh`：

- 检查 `apps/fe/dist/index.html`；
- 必要时构建前端；
- 复制前端 dist 到 `packages/app/resources/fe-dist`；
- 复制 `apps/gateway/drizzle` 到 `packages/app/resources/gateway-drizzle`；
- 删除前端 source map；
- 删除 Drizzle snapshot，只保留运行迁移需要的 journal 和 SQL。

`packages/app/scripts/bundle-resources.sh:8-30`

`deployRuntimeFiles()` 会清理并复制 runtime、前端和迁移目录。`packages/app/src/lib/install.ts:48-62`

### tarball 组成与当前大小

npm 包声明包含：

- `bin`
- `dist`
- `resources`
- `README.md`
- `CHANGELOG.md`

`packages/app/package.json:12-17`

`build-artifacts.ts` 生成的独立产物目录包含：

- `runtime`
- `fe-dist`
- `gateway-drizzle`
- `manifest.json`

manifest 会递归枚举文件并记录 SHA-256。`packages/app/scripts/build-artifacts.ts:171-202`、`packages/app/src/lib/artifacts-manifest.ts:19-28`

当前工作区没有已生成的 `packages/app/dist`、`packages/app/resources` 或 npm tarball，因此无法在不执行构建的前提下提供当前 tarball 字节数。构建产物的组成和测量入口已经由上述脚本确定。`packages/app/package.json:19-27`、`packages/app/scripts/build-artifacts.ts:178-202`

### WASM 与 native precedent

项目已有 Ghostty WASM 的打包先例：

- 代码通过 `new URL('./assets/ghostty-vt.wasm', import.meta.url)` 定位；
- 如果 Bun compile 不能可靠嵌入，则回退到可执行文件旁的 WASM；
- `copy-runtime-assets.sh` 在 Bun build 后显式复制 WASM。

`packages/ghostty-terminal/src/ghostty-wasm.ts:3-20`、`packages/app/scripts/copy-runtime-assets.sh:9-24`

managed gateway 也将 WASM 作为签名相邻资源复制，并记录 SHA-256。`apps/gateway/scripts/build-managed.ts:207-237`

native addon 的现有先例只有把可选 native 依赖 `cpu-features` 标记为 external：

- 普通 gateway build：`apps/gateway/scripts/build.ts:23-37`
- managed build：`apps/gateway/scripts/build-managed.ts:145-162`

当前没有 node-datachannel 或 `.node` addon 的加载、复制或校验实现。

设计要求是将 node-datachannel 的 JS 层内联，同时将原生绑定改为运行时按绝对路径加载：

```text
<installDir>/native/node_datachannel.node
```

`docs/hub/2026082700-hub-node-architecture.md:232-238`

当前 app runtime 尚无实现该机制的 bundler 方案。落点应是新增独立 loader，让 bundler 只看到 JS 层，原生绑定使用运行时计算的绝对路径，并结合 pinned manifest、N-API 版本和 integrity 校验。现有 `--external cpu-features` 只能作为参考，不能直接满足“JS 内联、binding 外置”的要求。`apps/gateway/scripts/build.ts:23-37`、`docs/hub/2026082700-hub-node-architecture.md:290-298`

## 5. Env loader

### `loadEnv()` 行为

`resolveEnvName()` 只精确识别：

- `production`
- `test`
- 其他值全部回退到 `development`

`packages/shared/src/env/load-env.ts:50-54`

`loadEnv()` 可通过 `options.nodeEnv` 覆盖环境变量，并就地写入目标 env。`packages/shared/src/env/load-env.ts:35-48`、`packages/shared/src/env/load-env.ts:107-121`

development/test：

1. 删除带安装目录标记的继承变量 `TMEX_MIGRATIONS_DIR`、`TMEX_FE_DIST_DIR`；
2. 读取 `<env>.env`；
3. 读取 `<env>.env.local` 覆盖前者；
4. 文件变量覆盖继承值；
5. 相对 `DATABASE_URL` 解析到仓库根。

`packages/shared/src/env/load-env.ts:156-199`

production：

- 不读取任何仓库 env 文件；
- 不删除安装目录路径变量；
- 校验 `TMEX_MASTER_KEY`、`GATEWAY_PORT`、`TMEX_BIND_HOST`、`DATABASE_URL`；
- 校验 `TMEX_FE_DIST_DIR`、`TMEX_MIGRATIONS_DIR` 存在；
- 失败时 fail-fast。

`packages/shared/src/env/load-env.ts:20-29`、`packages/shared/src/env/load-env.ts:124-154`

### 当前声明与类型

当前只有：

```ts
type MutableEnv = Record<string, string | undefined>
type EnvName = 'development' | 'test' | 'production'
```

没有集中式 env schema，也没有角色条件校验。`packages/shared/src/env/load-env.ts:31-48`

`@tmex/shared` 主入口明确不导出 `loadEnv()`，避免 Node-only 的 `node:fs`、`node:url` 被打入前端 bundle。`packages/shared/src/index.ts:6-9`

gateway config 目前是手写读取：

- `getEnv()`；
- `getBooleanEnv()`；
- 仅端口、tmux 路径和 gateway owner token 有局部校验；
- `TMEX_MASTER_KEY` 只检查 production 下是否存在，没有长度或编码校验。

`apps/gateway/src/config.ts:5-19`、`apps/gateway/src/config.ts:28-71`、`apps/gateway/src/config.ts:74-129`

### 新变量落点

| 变量 | 当前状态 | 应增加的校验/落点 |
|---|---|---|
| `TMEX_ROLES` | 不存在 | 在角色解析器或 `load-env.ts` 中限制为 `standalone`、`node`、`hub,node`；拒绝未知值和重复角色。设计默认值为 `standalone`。`docs/hub/2026082700-hub-node-architecture.md:272-282` |
| `TMEX_HUB_URL` | 不存在 | node 角色使用；应校验 HTTPS/URL 格式，并做角色条件必填。`docs/hub/2026082700-hub-node-architecture.md:284-288` |
| `TMEX_PEER_PORT` | 不存在 | node 角色使用，默认 `39001`，校验整数范围 `1..65535`。`docs/hub/2026082700-hub-node-architecture.md:284-288` |
| `TMEX_HUB_PUBLIC_URL` | 不存在 | hub 角色使用，应校验可被外部访问的 URL。`docs/hub/2026082700-hub-node-architecture.md:284-288` |
| `TMEX_STUN_SERVERS` | 不存在 | hub 配置，逗号分隔解析，逐项校验地址。`docs/hub/2026082700-hub-node-architecture.md:284-288` |
| `TMEX_TURN_URL` | 不存在 | 与 TURN 用户名、credential 组成配置组，校验 URL。`docs/hub/2026082700-hub-node-architecture.md:284-288` |
| `TMEX_TURN_USERNAME` | 不存在 | 与 TURN URL/credential 一致性校验。`docs/hub/2026082700-hub-node-architecture.md:284-288` |
| `TMEX_TURN_CREDENTIAL` | 不存在 | 不应写入日志；与 TURN URL/username 一致性校验。`docs/hub/2026082700-hub-node-architecture.md:284-288` |
| `TMEX_MASTER_KEY` | 已存在 | production 已要求非空，但没有验证 32-byte base64；应在新身份存储启用前增加格式/长度校验。`packages/shared/src/env/load-env.ts:20-26`、`apps/gateway/src/config.ts:74-76`、`apps/gateway/src/config.ts:126-129` |

当前 development/test env 只包含旧配置，没有 hub/node 变量。`development.env:5-30`、`test.env:10-25`

计划文档中的命名存在不一致：C5-1 提到 `TMEX_PUBLIC_URL`，设计 §5 使用 `TMEX_HUB_PUBLIC_URL`，用户本次任务也要求 `TMEX_HUB_PUBLIC_URL`。`prompt-archives/2026082701-hub-multinode-design/plan-00.md:52-55`、`docs/hub/2026082700-hub-node-architecture.md:284-288`

## 6. DB 与 Drizzle migrations

### 当前组织方式

Drizzle 配置：

- dialect：SQLite；
- schema：`./src/db/schema.ts`；
- 输出目录：`./drizzle`；
- 数据库 URL：`DATABASE_URL`，默认 `/data/tmex.db`。

`apps/gateway/drizzle.config.ts:1-10`

当前表定义全部位于 `apps/gateway/src/db/schema.ts`，包括站点、设备、文件、Telegram、微信、LLM、agent 和 watch 表。`apps/gateway/src/db/schema.ts:30-433`

迁移文件位于 `apps/gateway/drizzle/`，当前从 `0000` 到 `0017`。managed 代码中也维护了一份迁移文件名列表。`apps/gateway/src/db/managed-migrations.ts:7-26`

命名格式为：

```text
NNNN_<drizzle-generated-name>.sql
```

journal 中的 tag 与 SQL 文件名 stem 对应。`apps/gateway/drizzle/meta/_journal.json:4-130`

生成和应用命令：

- `bun run db:generate`：`drizzle-kit generate`
- `bun run db:migrate`：执行 `src/db/migrate.ts`

`apps/gateway/package.json:20-21`

`runMigrations()` 的目录优先级是：

1. `TMEX_MIGRATIONS_DIR`；
2. 当前工作目录下的 `drizzle`；
3. `apps/gateway/drizzle` 相对路径。

`apps/gateway/src/db/migrate.ts:6-17`

### 新表落点

设计要求的 hub/node 表包括：

- `users`
- `user_keys`
- `user_key_log`
- `node_sessions`
- `node_certs`
- `nodes`
- `enrollment_tokens`
- `node_identity`
- `peer_cache`

`docs/hub/2026082700-hub-node-architecture.md:115-131`

这些表应继续加入：

```text
apps/gateway/src/db/schema.ts
```

然后生成下一条同一迁移链中的 SQL，输出到：

```text
apps/gateway/drizzle/
```

不能为 hub 和 node 建立两条独立迁移链。设计明确要求 hub 与 node 使用同库结构和同一迁移链，standalone 下空表无害。`docs/hub/2026082700-hub-node-architecture.md:115-131`

hub 与 node 实际上各自拥有本地 SQLite 数据库，但必须共享相同的 schema/migration 版本。`GatewayRuntime` 当前是唯一会执行迁移的 runtime，因此 `hub,node` 双角色应保证只构造一个 GatewayRuntime，并只执行一次 gateway 迁移。`apps/gateway/src/runtime.ts:63-65`

managed build 还需要同步更新硬编码的迁移文件列表，否则新的 SQL 不会被嵌入。`apps/gateway/src/db/managed-migrations.ts:7-26`、`apps/gateway/src/db/managed-migrations.ts:56-69`

普通 packaged build 会复制整个迁移目录；managed build 会把每个 SQL 作为 Bun embedded asset 后再 materialize 到临时目录。`packages/app/scripts/bundle-resources.sh:18-28`、`apps/gateway/scripts/build-managed.ts:56-61`、`apps/gateway/src/db/managed-migrations.ts:56-65`

## 7. 角色矩阵落点

设计矩阵为：

| 角色 | 构造 | 前端 | 迁移 | tmux 检查 | supervisors |
|---|---|---|---|---|---|
| standalone | `GatewayRuntime` | 是 | gateway | 是 | 是 |
| node | `GatewayRuntime + MeshRuntime` | 是 | gateway | 是 | 是 |
| hub,node | `HubRuntime + GatewayRuntime + MeshRuntime` | 是 | 一次 | 是 | 是 |

`docs/hub/2026082700-hub-node-architecture.md:272-282`

| 设计行 | 当前精确落点 | 需要增加的分支 |
|---|---|---|
| standalone 构造 | `packages/app/src/runtime/server.ts:23-36` 当前只创建 Gateway | 保留默认路径，`TMEX_ROLES` 缺省为 standalone |
| node 构造 | `packages/app/src/runtime/server.ts:23`、`packages/app/src/runtime/gateway.ts:6-10` | 在 server 侧创建 MeshRuntime，并将 Gateway dispatch 接入 Mesh |
| hub,node 构造 | `packages/app/src/runtime/server.ts:23` | 创建 HubRuntime、GatewayRuntime、MeshRuntime，并用 `InMemoryLink` 接线 |
| hub → mesh → gateway → static | 当前只有 gateway → static：`packages/app/src/runtime/server.ts:28-35` | 在 `fetch` 中按设计顺序依次调用各 runtime |
| Hub HTTP/WS | 当前不存在 | `HubRuntime.handleRequest()` 负责 `/api/hub/*`、`/hub/uplink` |
| Mesh HTTP/WS | 当前不存在 | `MeshRuntime.handleRequest()` 负责 `/api/auth/*`、`/api/mesh/*`、`/mesh/ws`、`/n/*` |
| Gateway HTTP | `apps/gateway/src/runtime.ts:125-144` | 保留本地 `/api/*`、`/healthz` 和 `/ws` |
| 前端 | `packages/app/src/runtime/server.ts:9-15`、`packages/app/src/runtime/server.ts:34` | 所有角色都继续启用静态/SPA |
| 迁移 | `apps/gateway/src/runtime.ts:63-65` | hub,node 组合时只执行一次 |
| tmux probe | `apps/gateway/src/runtime.ts:74-76`、`apps/gateway/src/tmux/local-shell-path.ts:242-244` | 三种角色都保留 |
| push/agent/watch/messaging | `apps/gateway/src/runtime.ts:109-121` | 三种角色都保留，但必须避免重复构造 GatewayRuntime |
| runtime stop | `apps/gateway/src/runtime.ts:164-178` | 增加 Mesh peer links、uplink、Hub 的分层关闭 |
| 服务重启 | `packages/app/src/runtime/server.ts:39-44` | 让 Hub/Mesh/Gateway 统一 stop 后再退出 |

设计要求的关停顺序是：

```text
peer links → uplink → hub → gateway
```

`docs/hub/2026082700-hub-node-architecture.md:280-282`

当前 `GatewayRuntime.stop()` 的顺序是 watch、agent、push、tmux、Telegram、微信，尚未包含 peer/uplink/Hub。`apps/gateway/src/runtime.ts:171-178`

## 8. 现有测试

### Server startup

当前没有直接启动 packaged `runtime/server.ts` 并验证完整启动链的单测。

现有 runtime 测试只验证 wrapper 将 `handleSystemApiRequest` 传给 factory；测试使用 fake factory，不会实际执行迁移、site settings、supervisor 或 `Bun.serve`。`packages/app/src/runtime/gateway.test.ts:5-21`

静态资源测试覆盖：

- malformed URL；
- path traversal；
- `serveFrontend()` 的 `400`。

`packages/app/src/runtime/serve-frontend.test.ts:20-40`

`build-artifacts.ts --smoke` 可以启动真实 runtime 并轮询 `/healthz`，但它是构建脚本中的冒烟流程，不是 `bun test` 单测。`packages/app/scripts/build-artifacts.ts:95-168`

### Install layout / install

没有独立的 `install-layout.test.ts`。`install.test.ts` 间接使用 `createInstallLayout()`，覆盖：

- IPv6 `TMEX_BASE_URL`；
- shell quoting；
- run.sh 环境读取；
- FE/migration 路径；
- runtime 启动命令；
- bash 语法。

`packages/app/src/lib/install.test.ts:19-103`

### Env file

覆盖 env 内容解析和稳定排序写入。`packages/app/src/lib/env-file.test.ts:4-13`

共享 loader 测试覆盖：

- development/test/production 分支；
- `.env.local` 覆盖；
- 安装版路径变量净化；
- 相对数据库路径解析；
- production 缺少 master key；
- production 资源目录不存在。

`packages/shared/src/env/load-env.test.ts:42-150`

### CLI commands

当前没有 `init.test.ts`、`upgrade.test.ts`、`uninstall.test.ts` 或 `cli-node.test.ts`。

已有 CLI 辅助测试：

- 参数解析：`packages/app/src/lib/args.test.ts:4-25`
- Bun 探测：`packages/app/src/lib/bun.test.ts`
- tmux 探测：`packages/app/src/lib/tmux.test.ts`
- service plist/unit 生成：`packages/app/src/lib/service.test.ts:4-34`
- install helper：`packages/app/src/lib/install.test.ts:19-103`

### Gateway routing / WebSocket

API 路由测试覆盖：

- 路由优先级；
- 参数匹配；
- percent-encoded 参数；
- API `404`；
- Telegram/微信 handler 分派。

`apps/gateway/src/api/index.routing.test.ts:39-164`

WebSocket 测试覆盖：

- `WebSocketServer` 生命周期；
- connection entry 去重；
- shutdown 时释放 runtime；
- Borsh 消息处理。

`apps/gateway/src/ws/index.test.ts:30-164`

这些测试目前都直接操作 `WebSocketServer` 或 `handleApiRequest()`，没有覆盖未来 Hub/Mesh 分层 dispatch，也没有覆盖 `dispatchHttp(Request, { uid })`。