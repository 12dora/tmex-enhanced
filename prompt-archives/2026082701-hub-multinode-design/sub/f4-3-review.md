## Blocker

- `apps/fe/src/pages/NodesPage.tsx:503`：join 命令始终使用当前页面的 `location.origin`，而不是 hub 的公开 URL。用户从普通 node entry（例如 `https://node-a`）发起 enrollment 时，新设备会请求 `https://node-a/api/hub/enrollments/redeem`；该机器没有 `HubRuntime`，redeem 会返回 404，违反“任意 entry 均可 enrollment”。建议由 hub 管理 API 或 enrollment 创建响应返回 `public_url`，并用该地址生成 join token 命令，不能回退到 entry origin。

- `apps/fe/src/node/enrollment-watch.ts:127`：实际候选来源均不包含证书。当前 `/api/mesh/nodes` 和 `/api/hub/nodes` 都不返回 `certificate/cert_sig`，而 hub 的 `enroll.redeemed` 只进入 gateway 的 uplink 回调，本 diff 没有将其传给浏览器。因此设备成功 redeem 后，自动 admit 和手动确认都会永远得到空候选，未知证书告警也没有实际触发路径。建议将 `enroll.redeemed` 通过 `/mesh/ws` 的明确帧类型转发给发起页面，或提供按 enrollment id 查询 redeemed certificate 的 API，再统一交给 `offerCertificate()` 验证。

## Major

- `apps/fe/src/pages/NodesPage.tsx:133`：过期 pending 只在页面挂载时清理一次；页面保持打开时，新创建的 pending 在十分钟后仍保留于内存和 `sessionStorage`。此外，`apps/fe/src/pages/NodesPage.tsx:448` 的 `created` 状态在 admit 或 expiry 后从未清空，含 `enroll_sk` 的 join token 会继续显示在 DOM 中。建议按最早的 `exp` 安排清理定时器，在 expired outcome 中立即移除 pending，并让 admit/expiry 同时清空对应的 `created` 状态；`signAdmit` 在异步取 head 后也应重新确认尚未过期。

- `apps/fe/src/pages/NodesPage.tsx:241`：admit 成功只表示 entry 本地 key-log 已写入；本地 publisher 向 hub 的发送是 best-effort，但代码随即删除 pending。若 entry 可经 LAN peer 访问 hub、但 uplink 此时断开，本地 append 会成功、hub 永远收不到记录，而 uplink 重连时对“本地 head 领先”也不会补传；结果是 pending/enroll key 已丢失，新 node 却无法成为全 mesh 成员。建议在清除 pending 前取得 hub 对该记录的持久化确认，例如增加 hub key-log/admit 提交端点，并在确认后再由正常同步更新本地。

- `apps/fe/src/pages/NodesPage.tsx:679`：revoke 将同一条记录先 append 到本地，再调用会再次 append 的 hub revoke 端点，两条独立通道存在竞态。本地 append 会立即经 uplink 推送；若该帧先到 hub，随后 HTTP revoke 会因 `seq_gap` 返回错误，UI 错报 hub 失败。若本地成功后 HTTP 与 uplink发送都失败，本地列表会移除节点且没有重试入口，但 hub 仍允许该节点连接。建议只把签名记录提交给 hub revoke 端点，由该端点原子地 append key-log、应用撤销并广播；或者为完全相同的记录实现幂等确认和可持久重试，不能把第二次失败降级为一次性 warning。

- `apps/fe/src/node/enrollment.ts:331`：enrollment 输入被硬编码为 `RootKey`，Nodes 页的 enrollment、手动 admit 和 revoke 也都只提供密码提示。已注册且可用的 passkey 无法执行设计 §2 明确允许的任何节点管理操作。建议将 enrollment 构造泛化为 `RecordSigner + rootPublicKey`，从受信任 API 获取当前根公钥，并复用账号安全模块的凭据选择及 passkey assertion 流程处理 enroll/admit/revoke。

- `apps/fe/src/node/mesh-events.ts:260`：任何 WebSocket `open` 都立即将退避次数清零，`onclose` 又忽略关闭码。entry session 过期时，服务端会接受升级后以 4401 关闭；客户端因此每秒执行一次“open → reset → close → reconnect”，既不跳登录页，也永远无法进入指数退避。默认退避还固定为最多 30 秒且没有设计要求的抖动，服务恢复时会造成同步重连。建议识别 4401、调用全局未授权处理并停止重连；仅在连接稳定或收到有效帧后重置 attempt，同时采用带抖动的 1–60 秒退避。

## Minor

- `apps/fe/src/node/mesh-events.ts:31`：Borsh 解码后没有严格校验协议版本和枚举值；未知 `NODE_EVENT.status` 被当成 `online`，未知 `RTC_SIGNAL.from` 被当成 `browser`。滚动升级或损坏帧使用新枚举值时，会把离线节点误标在线，或把未知来源信令交给浏览器控制器。建议要求 envelope version 等于当前支持版本，并对两个枚举做完整 allowlist；未知值整帧返回 `null`。

结论：该 diff 的 React 文本渲染未发现 node name/inventory XSS，standalone 侧边栏也没有触发 mesh endpoint；`sessionStorage` 保存 `enroll_sk` 本身符合设计。但 enrollment 当前在非 hub entry 无法 redeem、任何 entry 都无法取得证书完成 admit，并且敏感 pending 的清理、key-log 持久化及 WS 鉴权重连仍存在严重缺口，因此不能合入。