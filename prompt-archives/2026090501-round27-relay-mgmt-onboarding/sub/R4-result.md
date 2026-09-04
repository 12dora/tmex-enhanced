## 高严重度

1. [apps/gateway/src/mesh/relay-routes.ts:179](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-routes.ts:179)：10 秒超时没有取消实际切换

`runSwitch()` 的 `AbortController` 只用于拒绝 `Promise.race`，没有传给 [UplinkPool.switchTo()](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-pool.ts:668)。底层连接仍使用 pool 的全局 stop signal，最长可以继续到自身 20 秒超时。

因此接口返回 `502 RELAY_SWITCH_FAILED` 后，未结束的连接仍可能认证成功并在后台 `promote`，使节点稍后切到用户刚刚被告知失败的中继；该中继也不会写入首选 URL。

最小修复：让 `switchTo(url, signal)` 接收并组合调用级 `AbortSignal`，超时时使本次 token 失效、停止对应 pending client，并等待清理完成后再返回 502。补充“10 秒后连接成功也不得 promote”的测试。

2. [apps/gateway/src/mesh/uplink-pool.ts:692](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-pool.ts:692)：被并发切换取代的 `switchTo` 会静默成功

当另一个手动切换、RTT 切换或 failback 调用增加 `switchToken` 后，旧调用在发现 token 失效时直接 `return`。调用方无法区分“已经切到目标”与“本操作已被取代”。

路由随后在 [relay-routes.ts:190](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-routes.ts:190) 只检查“任意 live client 是否 online”，而 make-before-break 期间旧连接本来就是 online。因此旧请求可能返回 200，并把自己的 URL 写成首选，即使当前或最终 attached relay 是另一个地址。并发请求可最终形成“attached=C、preferred=B”的矛盾状态。

最小修复：被 supersede 的 `switchTo` 必须抛出明确错误或返回结构化结果；路由成功前同时验证 `attachedHub()` 与请求 URL 相同且对应 client online。首选 URL 只能依据带 operation token 的成功结果写入。

## 中严重度

3. [apps/gateway/src/mesh/uplink-pool.ts:819](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-pool.ts:819)：在线链路的 heartbeat/kicked 错误没有持久化到 per-URL 诊断

连接建立失败会进入 `noteFailure()`，但已经 promote 的链路通过 `waitActiveSession()` 正常结束后直接返回，随后在 `finally` 中清除 live 并调用 `client.stop()`。虽然 [relay-uplink-client.ts:583](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-uplink-client.ts:583) 曾写入 `missed-pong`、`ping-failed` 或 `kicked:*`，`stop()` 又会用 `stopped` 覆盖它，而 pool 从未将原原因复制到 `diagByUrl`。

结果是断线后 `/api/mesh/relay/status` 改用 candidate 诊断时得到 `null`；新增的 `heartbeat-lost`/`kicked` 分类在最需要的路径上无法稳定出现。

最小修复：在清除或停止 live client 前，将其非 `stopped`/`aborted` 的终止错误记录到当前 attached URL；最好让 active-session wait 返回终止 client/reason。另需让远端直接关闭链路时保存 close reason，而不只依赖本地 heartbeat。

4. [apps/gateway/src/mesh/relay-link-error.ts:22](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-link-error.ts:22)：分类器错误处理不了 relay server 实际产生的若干原因

当前实际结果包括：

- `unknown-tenant` → `unknown`，但这是认证拒绝；
- `protocol_error` → `unknown`，因为 `_` 是单词字符，现有 `\bprotocol\b` 不匹配；
- `heartbeat-timeout` → `connect-timeout`，因为缺少 heartbeat 专用规则，先落入宽泛的 timeout 规则。

这些字符串分别由 [relay-uplink-auth.ts:99](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-uplink-auth.ts:99)、[relay-uplink-server.ts:374](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-uplink-server.ts:374) 和 [relay-uplink-server.ts:513](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-uplink-server.ts:513) 直接产生，因而不是假设性输入。它们会让状态和切换失败响应提供错误的稳定错误码。

最小修复：在宽泛 timeout 规则之前增加 `heartbeat[-_]timeout → heartbeat-lost`，并显式加入 `unknown-tenant → auth-rejected`、`protocol[_-]error → protocol`；使用服务端所有实际 close/reject reason 做表驱动测试。

## 低严重度

5. [packages/api-client/src/relay/tenant-api.ts:382](/Users/konata/code/tmex-r27/packages/api-client/src/relay/tenant-api.ts:382)：类型化 API 客户端丢弃切换失败诊断

网关的 502 响应包含 `lastError` 和 `lastErrorCode`，但 `readError()` 只读取 `code`/`reason`，最终构造的 [RelayApiError](/Users/konata/code/tmex-r27/packages/api-client/src/relay/admin-api.ts:111) 也没有保存这些字段。所有使用 `RelayTenantApi.switchRelay()` 的调用者只能得到 `RELAY_SWITCH_FAILED`，无法访问此次改动专门返回的分类信息。

最小修复：为 `RelayApiError` 增加可选 details，或定义 `RelaySwitchError`，解析并保留 `lastError`、`lastErrorCode`；补充 `switchRelay()` 失败响应测试。

6. [apps/gateway/src/relay/relay-uplink-server.ts:109](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-uplink-server.ts:109)：`lastUsagePush` 会永久保留已删除租户

每个认证或 quota 通知都会在该 Map 中写入 tenant ID，但 [handleRelayTenantDelete()](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-admin-routes.ts:162) 只清理 metering、registry、key log 和 tenant store，`stop()` 也没有清空该新 Map。长期创建、连接并删除租户会令其无界增长。

最小修复：增加 uplink tenant cleanup，删除 `lastUsagePush` 对应项，并在 server `stop()` 中清空整个 Map。