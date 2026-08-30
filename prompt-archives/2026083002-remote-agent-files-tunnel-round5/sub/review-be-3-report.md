# 审查结果

## 1. blocker — Access 守卫没有覆盖真实 HTTP/WS 入口

位置：[assemble.ts:159](/Users/konata/code/tmex-enhanced-wt-r5/packages/app/src/runtime/assemble.ts:159)、[assemble.ts:465](/Users/konata/code/tmex-enhanced-wt-r5/packages/app/src/runtime/assemble.ts:465)、[index.ts:21](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/index.ts:21)、[managed-entry.ts:163](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/managed-entry.ts:163)

`guardTunnelAccess` 被放在 `meshHttp()` 内，而组装运行时会先执行 TLS、本机管理、setup 和 hub handler；这些路由可以在守卫前直接返回。更严重的是，`apps/gateway/src/index.ts` 与 `managed-entry.ts` 完全不调用守卫，其 `/api/*` 及 `/ws` upgrade 都不会执行本机 Access JWT 校验。

这意味着状态可以显示 `access.enforceJwt=true`，但部分运行入口和路由实际上没有该保护。

最小修复：把守卫放到每个 Bun `fetch` 的最外层、任何路由分派和 WebSocket upgrade 之前；为可信 peer 请求及必要的 hub 机器端点定义明确豁免，不要依赖某个 mesh handler 顺带执行。补 direct gateway、managed gateway、组装运行时 HTTP/WS 集成测试。

## 2. should-fix — `/n/:id/*` 会在远端再次校验入口节点的 Access JWT，并转发 bearer token

位置：[mesh-http.ts:151](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/mesh/mesh-http.ts:151)、[forwarder.ts:954](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/mesh/forwarder.ts:954)

入口已验证请求后，`filterRequestHeaders` 仍转发 `cf-connecting-ip` 和 `Cf-Access-Jwt-Assertion`。远端 `handleRequest` 在判断 `isPeerInboundRequest` 之前再次运行守卫：

- 远端若配置了另一套 Access AUD/teamDomain，合法 `/n/:id/api/*` 会得到 403。
- 入口域名的 bearer JWT 被无必要地发送给远端节点。
- WS 走另一条链路，不会同样失败，造成 HTTP/WS 行为分裂。

最小修复：只在浏览器入口边界校验；可信 peer-inbound 请求跳过 Access 守卫。同时从 mesh 转发头中删除 `cf-connecting-ip`、`cf-access-jwt-assertion` 等 Cloudflare 身份头。

## 3. blocker — 整站 Access 应用会阻断 mesh 节点加入和常驻 uplink

位置：[access-client.ts:74](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/tunnel/access-client.ts:74)、[uplink-protocol.ts:21](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/mesh/uplink-protocol.ts:21)

创建的 Access 应用使用裸 `hostname`，因此覆盖整个站点。远端节点则直接连接 `wss://hostname/hub/uplink`，没有浏览器 Access cookie或 service-token header；CLI enrollment 请求同样没有。配置 Access 后，Cloudflare 边缘会在请求到达 tmex 的协议认证前将其拦截，导致节点离线或无法加入。

Cloudflare 支持按路径划分 Access 应用，而且更具体的路径策略优先：[Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)。

最小修复：二选一：

- mesh/hub 模式禁止配置这种整站邮箱 Access 应用；或
- 为 `/hub/uplink` 及 enrollment 所需端点配置更具体的 Bypass/Service Auth 策略，并继续依赖现有 peer 加密认证。对应本机守卫也必须明确豁免这些机器端点。

## 4. blocker — 策略替换失败时仍宣称只允许新规则，可能实际放行额外用户

位置：[access-client.ts:196](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/tunnel/access-client.ts:196)

`replaceAllowPolicy` 更新任意第一条策略，然后删除其余策略，但删除错误被 `.catch(() => {})` 吞掉。随后 manager 仍保存新规则并启用 JWT 校验。

Cloudflare 会综合应用多条策略，额外 Allow 策略可以签发同一应用 AUD 的合法 JWT；本机只检查签名、issuer 和 AUD，并不会重新检查邮箱。因此残留策略允许的用户仍能进入，而 UI 显示的规则更窄。Bypass、Service Auth 还有更高执行优先级。[Cloudflare Access policy execution](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)。

最小修复：只管理明确命名/记录的 tmex 策略；任何必须删除的授权策略删除失败都应让 job 失败。保存 `rules`、`aud`、`enforceJwt=true` 前重新读取策略并验证不存在未预期的授权入口。

## 5. should-fix — JWT 的 `exp` 并非必填，畸形 JSON 还会抛出 500

位置：[access-jwt.ts:79](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/tunnel/access-jwt.ts:79)、[access-jwt.ts:95](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/tunnel/access-jwt.ts:95)、[access-jwt.ts:119](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/tunnel/access-jwt.ts:119)

当前逻辑只在 `exp` 是数字时检查过期，因此签名正确但缺少 `exp` 的 token 会被接受。Cloudflare application token 明确定义 `exp`，官方验证示例使用会强制检查过期时间的 JWT 库：[Application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)、[Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)。

另外，`splitJwt` 会把 JSON `null` 强制断言为 `JwtHeader`；实际调用已可复现 `TypeError: null is not an object (evaluating 'header.alg')`，返回 500 而非 403。

最小修复：要求 header/payload 是普通对象，要求 `exp` 为有限数字且未过期；`nbf` 存在时也要求为有限数字。所有解析/验证异常统一返回 `false`。

## 6. should-fix — 守卫与 `exposureProtected` 使用了不同的 hostname 状态机

位置：[manager.ts:508](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/tunnel/manager.ts:508)、[manager.ts:524](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/tunnel/manager.ts:524)

`exposureProtected` 要求 Access hostname 与当前隧道 hostname 相同；`accessGuardState` 却只检查 Access 记录本身是否 configured/enforced。

例如删除一个 Access 命名隧道后，Access 记录仍保留；用户再确认风险启动 quick tunnel，状态正确显示“未保护”，但 quick URL 请求没有旧应用的 JWT，守卫仍会返回 403。Access 状态和实际请求门禁相互矛盾。

最小修复：守卫快照也必须包含当前隧道配置，并仅在 Access hostname 与当前 named/external hostname 匹配时启用；切换到 quick/off 时不得继续应用旧 AUD。

## 7. should-fix — 外部隧道探测会拼接不同实例，并忽略实际 `--config`

位置：[external-detect.ts:107](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/tunnel/external-detect.ts:107)、[external-detect.ts:113](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/tunnel/external-detect.ts:113)、[external-detect.ts:120](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/tunnel/external-detect.ts:120)、[external-detect.ts:375](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/tunnel/external-detect.ts:375)

存在三个相关错误：

- 始终只读取 `~/.cloudflared/config.yml`；argv/plist 中解析出的 `--config /custom/path` 只用于展示，从未读取其内容。
- `running` 只要系统存在任意 cloudflared tunnel 进程就为真。
- 第一份 launchd/systemd 参数会与第一个进程参数直接合并，可能把不同 tunnel 的 token、日志、运行状态拼成一个候选。
- token 旁的 `hostname` 文件未经 origin ingress/端口核验便被接受，与“只接受指向本机 origin 的 hostname”不符。

这会让 UI 接管错误隧道，并持续错误显示“运行中”。

最小修复：按进程/服务/config 构造独立候选，以 tunnel ID、token file 或 config path 关联；读取候选声明的真实配置文件；只有获得该候选指向目标 origin 的 ingress 证据后才发布 hostname/running。

## 8. should-fix — Access 启用后“检查连接”必然无法读取 `/healthz`

位置：[manager.ts:857](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/tunnel/manager.ts:857)

`jobCheck` 从服务端匿名请求公网 `/healthz`。整站 Access 应用会先返回登录跳转或 403；服务端请求没有浏览器 cookie、binding cookie或 service token，因此不会取得包含 `startedAt` 的 origin 响应。结果是 Access 配置成功后，UI 的检查动作稳定失败。

最小修复：为检查设计受支持的机器凭证/Service Auth；或者把“Cloudflare 入口可达”和“origin health”拆为不同检查，并明确报告 Access 拦截状态，不能继续把匿名 `/healthz` 当作完整连通性验证。

## 9. should-fix — 删除 Access 应用失败仍清空本地状态并报告成功

位置：[manager.ts:978](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/tunnel/manager.ts:978)

Cloudflare DELETE 的所有错误都被吞掉，随后本地 `appId/aud/rules/enforceJwt` 无条件清空，job 进入 `done`。权限错误或网络错误会留下无法再从 UI 管理的孤儿应用；响应丢失时也无法判断远端是否已删除。

最小修复：只把确认的 404 当作幂等成功；其他错误令 job 失败并保留本地记录。重试 DELETE 后再清理本地状态。

## 10. should-fix — API token 权限提示不完整，会导致按提示创建的 token 保存失败

位置：[access-client.ts:58](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/tunnel/access-client.ts:58)、[tunnel.ts:177](/Users/konata/code/tmex-enhanced-wt-r5/packages/shared/src/contracts/tunnel.ts:177)、[zh_CN.json:487](/Users/konata/code/tmex-enhanced-wt-r5/packages/shared/src/i18n/locales/zh_CN.json:487)

UI 和契约只提示 `Access: Apps and Policies — Edit`，但保存凭证时首先调用 `/access/organizations` 获取 `auth_domain`。该接口还要求 Organizations 相关的 Read/Write/Revoke 权限：[Cloudflare Organizations API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/)。

用户严格按提示创建最小权限 token 时，会在第一步得到 403。

最小修复：三语文案和契约同时列出 `Access: Apps and Policies Write` 与 `Access: Organizations… Read`；或者取消该 API 调用，改由用户提供并校验 team domain。

## Verdict

不建议合入。当前有 3 个 blocker：守卫未覆盖真实入口、整站 Access 会破坏 mesh 机器链路、策略更新可能留下未展示的额外授权。

迁移 `0029` 的 SQL、snapshot 和 journal 注册关系未发现结构性问题；三语 `settings.remoteAccess` 键集合均为 203 个且完全同构。本 diff 不包含 O10/O12 的实际前端改动，因此未将分屏关闭和侧栏规则作为本 diff 的结论来源。

最重要的 3 项：

1. 把 Access 校验移到真正的 HTTP/WS 入口边界，并正确处理 peer/hub 机器流量。
2. 解决整站 Access 与 `/hub/uplink`、enrollment 的冲突。
3. 策略变更必须原子失败，不能吞掉额外授权策略的删除错误。