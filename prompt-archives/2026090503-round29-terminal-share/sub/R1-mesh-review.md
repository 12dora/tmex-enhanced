发现 **7 项问题：1 blocker、5 major、1 minor**。相关纯单测 40 项通过；未运行真实节点、Hub 或浏览器集成测试。

1. **blocker — 开放模式绕过分享权限隔离**  
   [apps/gateway/src/mesh/mesh-http.ts:233](/Users/konata/code/tmex-r29/apps/gateway/src/mesh/mesh-http.ts:233)

   standalone 未开启常规鉴权时，`isStandaloneOpenAuth()` 提前放行，分享 cookie 不会进入校验。随后创建的会话没有 `shareScope`，接收者可以操作其他设备、窗口及管理功能；撤销分享也无法关闭该连接。

   **最小修复：** 分享连接必须进入作用域鉴权；同时要求开启常规鉴权后才能创建对外分享。只调整 cookie 判断顺序不够，否则接收者删除 cookie 即可恢复匿名全权限访问。

2. **major — Hub 的失效分享 cookie 阻断重新登录**  
   [apps/gateway/src/mesh/stream-auth.ts:45](/Users/konata/code/tmex-r29/apps/gateway/src/mesh/stream-auth.ts:45)

   分享 token 无效时，在判断公开路径之前直接拒绝。分享被撤销后，浏览器仍持有 `tmex_sh_<node>`，该节点上的分享查询、登录和退出请求都会返回 `401 share_invalid`。由于 cookie 按节点共用，打开同节点的新分享、输入正确密码也无法恢复；前端还会把这个 401 误报为密码错误。

   **最小修复：** 对分享公开 HTTP 路径，将无效分享凭证降级为匿名请求，让查询、密码登录和清 cookie 的退出路由正常执行。普通 API 和 WS 继续拒绝无效凭证。

3. **major — Hub 转发丢失来源 IP，所有访客共用限速额度**  
   [apps/gateway/src/mesh/forwarder.ts:609](/Users/konata/code/tmex-r29/apps/gateway/src/mesh/forwarder.ts:609)；[mesh-runtime.ts:993](/Users/konata/code/tmex-r29/apps/gateway/src/mesh/mesh-runtime.ts:993)

   HTTP OPEN 没有携带浏览器来源 IP，节点统一设置 `clientIp = peer:<hubId>`。分享登录限速因此实际按“分享 + Hub”计数：任意访客输错十次，就会锁住经该 Hub 访问此分享的所有人，违反“分享 + 来源 IP”的契约。

   **最小修复：** 增加由 Hub 根据可信请求上下文填写、浏览器不可覆盖的来源 IP 元数据，并用于节点端分享登录限速。

4. **major — 失效常规 cookie 遮蔽有效分享凭证**  
   [apps/gateway/src/mesh/forwarder.ts:95](/Users/konata/code/tmex-r29/apps/gateway/src/mesh/forwarder.ts:95)

   `remoteWsAuthFor()` 只要发现常规 cookie 就选用它。若 sid 已在节点撤销、浏览器尚未清除 cookie，节点收不到有效分享 token，导致分享密码登录成功但终端无法连接。本机路径先验证常规会话，不存在这一差异。

   **最小修复：** 将两套候选凭证传给节点，验证常规会话失败后再尝试分享凭证；或者增加明确的分享连接标记。不能全局改成分享 cookie 优先，否则会影响普通页面。

5. **major — 分享 WS 初次鉴权失败丢失约定关闭码**  
   [apps/gateway/src/mesh/stream-targets.ts:460](/Users/konata/code/tmex-r29/apps/gateway/src/mesh/stream-targets.ts:460)

   初验失败直接 `reset('share_invalid')`，没有编码 4401。Hub 将其解释为 1011 链路错误并尝试 failover，最终前端收不到 `4401 SHARE_LOGIN_REQUIRED`，无法返回密码页。无效 cookie、撤销后重连均可触发。

   **最小修复：** 分享初验失败使用 `encodeTerminalStreamClose(4401, 'SHARE_LOGIN_REQUIRED')`；能够明确识别分享已结束时返回 4410。

6. **major — 升级期间到达的撤销事件可能永久丢失**  
   [apps/gateway/src/mesh/mesh-runtime.ts:459](/Users/konata/code/tmex-r29/apps/gateway/src/mesh/mesh-runtime.ts:459)

   `notifyClose()` 只保存关闭标志，`onClose()` 晚注册时不补发结果。Hub 创建 mesh stream 后，到浏览器 `websocket.open` 注册监听前存在时间窗口；若此时收到撤销的 4410，浏览器不会被立即关闭，后续输入还可能触发普通 failover。

   **最小修复：** 缓存完整关闭结果；流已关闭时，`onClose(cb)` 立即回调该结果。使用实际函数的 Bun 内存复现已确认晚注册监听收不到事件。

7. **minor — 熔断文案显示未替换的 `{{until}}`**  
   [apps/gateway/src/mesh/direct-failure-codes.ts:74](/Users/konata/code/tmex-r29/apps/gateway/src/mesh/direct-failure-codes.ts:74)

   RTC 连续失败进入 disabled 状态后，可能返回 `coolingUntil: null`。这里仍生成 `breaker_cooling`，却不提供 `until`；中、英、日三语文案均依赖此参数，界面会显示“暂停至 {{until}}”，且把禁用误描述为冷却。

   **最小修复：** 无时间戳时使用不带时间插值的暂停／禁用文案；仅有时间戳时使用 `breaker_cooling`，同步三语及类型定义。

**Optional hardening**

- [auth-public-paths.ts:13](/Users/konata/code/tmex-r29/apps/gateway/src/mesh/auth-public-paths.ts:13)：目前整个 `/api/share-access/*` 前缀都被视为公开。可收紧为契约中三个端点及其 HTTP 方法，避免未来新增同前缀管理路由时意外匿名开放。当前未发现可据此访问已有管理接口的路径。