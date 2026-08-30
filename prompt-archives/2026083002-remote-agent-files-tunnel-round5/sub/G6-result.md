# G6 result — Fix review findings: Cloudflare Tunnel manager (backend)

## What changed

1. **auth_required（blocker）**  
   standalone（`/api/auth/mode` = `none`，无强制登录）时拒绝 `quick_start` / `create` / `start` / `set_auto_start(true)`，HTTP 409 `{ code: 'auth_required', message: 'Sign-in must be enabled before exposing tmex publicly' }`。boot 时若 `autoStart && mode !== 'off'` 同样跳过并 `console.warn`。`set_auto_start(false)` 仍允许。默认判定：`config.roles` 非 hub/node 即未启用登录；测试可注入 `loginEnforced`。

2. **tunnelName 路径穿越（blocker）**  
   路由与 manager 均用 `^[a-z0-9](?:[a-z0-9_-]{0,62})$` 校验；`credentialsPathFor` `resolve` 后断言文件必须是 `tunnelDir` 的直接子文件。覆盖 `../../x`、`/abs`、换行、超长。

3. **check job**  
   成功：`state: 'done'`, `step: 'ok'`；失败：`state: 'error'` 带 code/message，`step` 为错误码（不再停在 `check`）。

4. **loginUrl / 日志脱敏**  
   `auth.loginUrl` 仅在 login job `running` 时非 null；任意终态清空。写入 ring buffer 前去掉 `https://dash.cloudflare.com/…?…` 以及带 `token=`/`aud=` 的 URL。

5. **quick publicUrl**  
   每次 start / stop 将 `supervisor.publicUrl` 置 null。named URL 只在 `mode === 'named'` 且进程 `running` 时由持久化 hostname 推导，不会当成 quick URL。

6. **mesh 转发 404**  
   `/api/tunnel/*` 在 peer-forwarded dispatch（`viaNodeId !== self`）或 `isPeerInboundRequest`（`clientIp` `peer:` 前缀）时返回 404。本机 `via=self` 仍 200。

7. **origin 跟随 bind host**  
   `originUrlFromBindHost`：`0.0.0.0` → `127.0.0.1`，`::` / `[::]` → `[::1]`，具体地址原样（IPv6 加括号）。`config.originUrl` 注入 manager/provider（named yml `service` 与 quick `--url`）。

8. **create 已配置拒绝**  
   `config.mode !== 'off'` 时 409 `tunnel_exists`（须先 `remove`）。

9. **configuredTrustProxy**  
   经注入的 `readHostEnv` 读 app.env 的 `TMEX_TRUST_PROXY`；缺省镜像 `trustProxy`。`restartRequired = configuredTrustProxy !== trustProxy`。`set_trust_proxy` 只更新已保存值。assemble 在原有 `setPatchHostEnv` 旁增加 `setReadHostEnv`。

## File list

- `apps/gateway/src/tunnel/hostname.ts`
- `apps/gateway/src/tunnel/errors.ts`（`auth_required` / `tunnel_exists` → 409）
- `apps/gateway/src/tunnel/redact.ts`
- `apps/gateway/src/tunnel/provider.ts`
- `apps/gateway/src/tunnel/supervisor.ts`
- `apps/gateway/src/tunnel/manager.ts`
- `apps/gateway/src/tunnel/manager.test.ts`
- `apps/gateway/src/tunnel/util.test.ts`
- `apps/gateway/src/api/tunnel-routes.ts`
- `apps/gateway/src/api/tunnel-routes.test.ts`
- `apps/gateway/src/config.ts`（`originUrlFromBindHost` / `config.originUrl`）
- `apps/gateway/src/config.test.ts`
- `packages/app/src/runtime/assemble.ts`（仅 tunnel host-env 读写 wiring）

未改契约形状。

## Tests / tsc / biome

- G6 相关：`apps/gateway` `src/tunnel` + `tunnel-routes.test.ts` + `config.test.ts` — **67 pass / 0 fail**
- `cd apps/gateway && bun test` — **2616 pass / 1 fail**。失败项 `mesh-http > peer inbound 保留标记，mesh-internal 不因缺 cookie 返回 403`（`mesh-internal-tmux-routes` 查 `devices` 表、测试库无该表），不在本 scope；与 tunnel 路由无关。
- `packages/app` `assemble.test.ts` — **27 pass / 0 fail**
- `bunx tsc --noEmit -p .`（gateway）：**22 errors**（基线 21）。**本任务文件 0 条**。多出的来自并行任务 fixture（agent `nodeId` 等）。
- `packages/app` tsc：**1**（预存 `Cannot find type definition file for 'node'`）
- `bunx biome check` 上述 13 个文件：**通过**

## Left / risky

- 全量 gateway 那 1 条 fail 需 mesh-internal 的 owning agent 修测试夹具。
- `loginEnforced` 默认跟 `TMEX_ROLES`（standalone = 未启用登录）。源码 `bun run dev` 默认 standalone，因此未先加入 mesh 用户前无法拉起公网隧道（符合审查要求）。
- `configuredTrustProxy` 在 assemble 注入 `readHostEnv` 之前（`createGatewayRuntime` 先 `start()`）等于进程内 `trustProxy`；注入后会再读 app.env。当前进程内 `set_trust_proxy` 直接更新缓存。
