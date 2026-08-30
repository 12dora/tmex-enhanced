# 代码审查报告

## 1. Blocker — 默认 standalone 模式会把无鉴权的 tmex 直接暴露到公网

**位置：** `apps/gateway/src/api/tunnel-routes.ts:50`、`apps/gateway/src/tunnel/provider.ts:196`

**问题：** `quick_start`/named tunnel 将完整 gateway 转发到公网，但 standalone 是默认角色，`authenticateRequest()` 在 standalone 下直接认证成功，不要求任何会话。远程访问页面也没有禁止这种组合。

**证据：**

- `packages/app/src/lib/roles.ts:8-24` 显示默认角色为 standalone。
- `apps/gateway/src/mesh/session-middleware.ts:41-42` 对 standalone 无条件返回认证成功。
- Cloudflared origin 是完整的 `http://127.0.0.1:<gateway-port>`，没有路径或 Cloudflare Access 限制。
- 新增的文件浏览甚至明确不受 roots 白名单约束；公网访问者可以继续调用设备、文件、终端等现有 API。

这不只是隧道管理 API 未鉴权，而是整个 tmex 工作区会被公开。

**最小修复：** 在不存在强制登录的 standalone 模式下禁止 `quick_start`、`create`、`start` 和 auto-start，并在前端明确说明必须先启用 mesh 登录；如确实需要支持 standalone，则必须先实现独立的公网鉴权层或 Cloudflare Access 接入。

## 2. Should-fix — `tunnelName` 可造成目录穿越及任意 `.json` 文件写入/删除

**位置：** `apps/gateway/src/api/tunnel-routes.ts:32`、`apps/gateway/src/tunnel/manager.ts:482-484`、`apps/gateway/src/tunnel/provider.ts:73-74`

**问题：** 只校验了 hostname，`tunnelName` 可包含 `/`、`..`、换行或前导选项字符，随后直接用于：

```ts
join(tunnelDir, `${tunnelName}.json`)
```

例如 tunnel 目录为 `/srv/tmex/tunnel` 时，名称 `../../victim` 会解析为 `/srv/victim.json`。Cloudflared 会被要求向该路径写凭据；`remove` 又会删除同一路径。

**最小修复：** 对隧道名称实施严格白名单和长度限制，例如 `^[a-z0-9](?:[a-z0-9_-]{0,62})$`；同时对最终路径执行 `resolve()` 并验证仍位于 `tunnelDir` 内。

## 3. Should-fix — 链路降级时先发送离线事件，已有备用链路仍会中止远程 Agent

**位置：** `apps/gateway/src/mesh/peer-manager.ts:1931`

**问题：** `dropPeer()` 删除当前 live link 后立即调用 `onLinkInfo`，此时 `listReach()` 返回 null；随后才执行 `promoteRetiring()` 和 `activateParked()` 恢复备用链路。

**证据：**

- `mesh-runtime.ts` 将 null reach 转成 `offline` 事件。
- `emitNodeEvent()` 对任何 offline 事件立即调用 `notifyNodeOffline()`。
- 只有在发出 offline 之后，较低优先级的 WS/relay 链路才被提升并再次发出 online。

因此 WebRTC → WebSocket 等正常链路降级会产生瞬时离线，正在运行的远程 Agent 会被永久置为 error，UI 也会离线/上线闪烁。

**最小修复：** 先提升 retiring/parked 链路，再根据最终 live 状态发送一次 link info；若提升成功，由 `emitLinkInfo(best)` 负责通知，不应先发 null reach。

## 4. Should-fix — “检查连通性”必定先显示成功，实际检查结果被忽略

**位置：** `apps/gateway/src/tunnel/manager.ts:269-270,294-313`、`apps/fe/src/pages/settings/remote-access/tunnel-actions.ts:100-104`

**问题：** 后端通过 `enqueueJob()` 异步执行 `check`，立即返回 202 和 `state: running`。前端却把 check 当作同步动作；只要返回的 job 尚未是 error，就立即显示“可访问”。

真实 `/healthz` 请求最多五秒后才结束。失败结果只会出现在后续轮询的 job 中，而前端没有据此更新 `actions.check`。

**最小修复：** 保持异步契约时，前端应记录 check job id，等轮询到相同 job 进入 done/error 后再生成结果；或者把后端 check 改成真正同步返回最终状态。

## 5. Should-fix — Cloudflare 授权 URL 在任务结束后仍通过状态和日志泄露

**位置：** `apps/gateway/src/tunnel/manager.ts:215-220,329-334,429-432`、`apps/gateway/src/tunnel/redact.ts:1-2`

**问题：**

- `status()` 中 ternary 的两个分支都是 `this.loginUrl`，所以并未实现契约所说的“仅 login job 进行中返回”。
- 成功登录时 `finally` 不清空 URL。
- 登录输出在解析 URL 前已写入日志；当前脱敏规则只处理长 hex/base64 字符串，不会移除包含 `aud`、短 token、`-`、`_` 等字符的授权 URL。

最终授权地址会长期出现在 `auth.loginUrl` 和 `status.log` 中。

**最小修复：** 仅在 login job 运行时返回 URL，任务任何终态都清空它；日志写入前专门识别并替换 Cloudflare 授权 URL或其查询串。

## 6. Should-fix — quick tunnel 重启/停止后继续暴露旧 URL

**位置：** `apps/gateway/src/tunnel/supervisor.ts:57-70,85`、`apps/gateway/src/tunnel/manager.ts:199-205`

**问题：** quick 模式启动时保留现有 `publicUrl`，停止时也不清空。后果包括：

- 第二次 quick start 在新地址产生前仍显示旧地址。
- named → quick 切换时暂时把 named hostname 当作 quick URL。
- quick 启动失败或已停止后仍显示并允许检查已失效的地址。
- 前端仅以 `mode === quick && publicUrl !== null` 判断“临时隧道已启动”。

**最小修复：** 每次启动 quick 模式前将 `publicUrl` 置 null；stop 时也清空。Named 地址可由持久化 hostname 重新投影，无需保留 supervisor 中的旧值。

## 7. Should-fix — “只配置 entry 自身”只是客户端约定，服务端仍允许 `/n/:id/api/tunnel/*`

**位置：** `apps/gateway/src/api/tunnel-routes.ts:50-60`

**问题：** 契约和客户端都声明 tunnel API 只作用于浏览器直连的 entry，但这些路由按普通 `/api/*` 注册且不检查 mesh dispatch context。现有 Forwarder 会代理任意非 internal API，因此登录远端 node 后可以手工请求：

```text
/n/<remote-id>/api/tunnel/actions
```

从而在远端 node 下载二进制、写配置并启动公网隧道。

**最小修复：** 路由处理器检查 `ctx.mesh`/`requestDispatchContext`，对经 peer 转发的 tunnel 请求返回 403 或 404；直接访问该机器时仍允许，因为此时它就是 entry。

## 8. Should-fix — Cloudflared origin 硬编码 IPv4 loopback，与合法 bind 配置不兼容

**位置：** `apps/gateway/src/tunnel/manager.ts:93`、`apps/gateway/src/tunnel/provider.ts:196-202`

**问题：** named 和 quick 两种模式都固定连接 `127.0.0.1`，但 gateway 支持 `TMEX_BIND_HOST=::1`、指定 LAN 地址等配置。这些情况下 gateway 并未监听 IPv4 loopback，隧道会不断注册/重启却无法访问 origin。

**最小修复：** 从实际 bind host 生成 origin URL：通配 IPv4 使用 `127.0.0.1`，通配 IPv6 使用 `[::1]`，具体地址使用该地址并正确包裹 IPv6；将完整 origin URL传给 manager/provider。

## 9. Should-fix — diff 中的 SSH 目录浏览只支持 GNU find

**位置：** `apps/gateway/src/files/directory-browse.ts:159-167`

**问题：** 远端命令使用 `find -xtype` 和 `-printf`。BSD/macOS 自带 find 不支持这两个选项，因此所有 macOS SSH 设备的路径选择器都会返回 unknown/命令失败，尽管 SSH Device 契约没有 Linux 限制。

**最小修复：** 改用 POSIX shell 的目录遍历与 `[ -d ]`、`[ -L ]` 判断并输出 NUL 分隔结果，或检测 GNU find 后提供 portable fallback；补一个模拟 BSD find 失败的回归测试。

## Verdict

**请求修改。** 当前 diff 存在一个会将默认无鉴权实例直接公开到互联网的 blocker，另有文件路径穿越、链路降级误判离线和前后端异步契约错误。修复这些问题前不建议合入或进行真实 tunnel 发布验证。

最重要的三项：

1. 禁止无鉴权 standalone 实例建立公网隧道。
2. 严格校验 `tunnelName` 并保证凭据路径不能逃逸 `tunnelDir`。
3. 链路 failover 完成后再决定是否发送 offline，避免误杀远程 Agent。