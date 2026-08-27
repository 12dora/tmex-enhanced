## Blocker

- `apps/fe/src/node/enrollment.ts:118`：旧版含 `enrollSk`/`joinToken` 的记录仅被 `filter(isPending)` 从内存结果中过滤，原始 JSON 仍留在 `sessionStorage`。升级后，同源脚本依然可以直接读取此前落盘的 enrollment 私钥并抢先 redeem。读取到旧格式或任何含秘密字段的记录时，应立即 `removeItem(PENDING_STORAGE_KEY)`，或把仅含公开字段的结果同步写回存储。

## Major

- `apps/fe/src/auth/session-key-store.ts:315`：passkey 登录的 origin 过滤仍未真正生效。登录前 `listPasskeys()` 必然因无会话而失败，随后 `selectPasskeyCredential()` 回退到 `allowCredentials[0]`；而当前登录 options 端点仍返回用户的全部凭证。用户在 node A、B 分别注册 passkey 且 A 排在前面时，从 B 登录仍会选择 A 的凭证并触发 `NotAllowedError`。必须在后端生成 options 时按请求的精确 origin 过滤凭证；前端没有可信元数据时不应自行选择未过滤列表。

- `apps/fe/src/auth/account-security-actions.ts:279`：`passkeysForOrigin()` 在精确 origin 无匹配时按 `rp_id` 回退，违反凭证绑定精确 scheme、host、port 的协议。比如凭证注册于 `https://node.example:8443`，当前页面为 `https://node.example`，函数会把它标为可用，但后端以注册 origin 验证 assertion 时必然拒绝。应删除 `rp_id` 回退，只接受 `row.origin === currentOrigin`。

- `apps/fe/src/pages/NodesPage.tsx:270`：`hubAck === false` 时保留 pending 仍不能恢复。当前 `hub=sync` 路由在 hub 未确认后仍会本地 apply：例如双方 head 为 5，首次断网提交后 entry 已到 6、hub 仍为 5；重试会基于本地 head 签 seq 7，hub 因缺少 seq 6 永久拒绝。revoke 同样会先在本地生效。服务端必须在 hub ack 失败时禁止本地 apply，或持久化并重试原始 seq 6 记录，不能靠 UI 保留 pending 修复一致性。

- `packages/stores/src/node-connection-manager.ts:123`：4401 监听只安装在 manager 的默认连接工厂上；实际前端宿主通过 `options.createConnection` 创建连接，因此绕过 `onClose`。新增测试通过手动调用 `notifyClose()` 掩盖了真实接线缺失。实际 `/ws` 或 `/n/:id/ws` 收到 4401 后仍会由 ws-client 重连，也不会派发对应鉴权事件。应让自定义工厂接收强制的关闭回调，或在 manager 外的实际 `appNodeRuntimes` 接线，并用真实宿主构造路径测试。

- `apps/fe/src/pages/NodesPage.tsx:332`：enroll、手动 admit 和 revoke 仍只提示密码并构造根钥 signer，没有实现设计 §2 允许的 passkey 专用 assertion。拥有有效 passkey、但无法提供当前密码的用户仍不能进行任何节点管理操作。应复用精确 origin 过滤后的 passkey 选择流程，把 enrollment 泛化为 `RecordSigner + rootPublicKey`，并让 admit/revoke 同样支持 passkey signer。

- `apps/fe/src/pages/NodesPage.tsx:423`、`apps/fe/src/auth/account-security-actions.ts:84`、`apps/fe/src/node/enrollment.ts:429`：私钥清零仍有未覆盖的失败路径。创建 enrollment 时若 hub 请求失败，刚派生的 `rootKey.seed` 没有进入任何 `finally`；改密时若第二次 Argon2 派生因内存压力失败，旧根钥也绕过后面的 `finally`；`encodeJoinToken()` 还会复制一份含 `enroll_sk` 的 96 字节临时数组，而这里只清零原数组。应从密钥创建处建立完整的所有权式 `try/finally`，仅在成功交给 remembered signer 后转移所有权，并让 join-token 编码器在生成字符串后清零内部临时数组。

- `apps/fe/src/node/enrollment.ts:455`：hub 返回的 `public_url` 未经 shell quoting 就拼入可复制命令。合法 URL 中的 `&` 会破坏命令；恶意或误配置的值如 `https://hub.example; touch /tmp/pwn` 会在用户粘贴执行时运行额外命令。应校验为可信 HTTPS URL，并对 URL 使用现有 `shellQuote()`。

## Minor

- `apps/fe/src/node/enrollment-watch.ts:142`：轮询路径明确声称会报告 `unknown`，实际却只 emit 非 `unknown` 结果。hub 为某 enrollment id 返回不匹配的证书时，UI 会静默忽略，无法触发“收到未知节点证书”告警。应与推送路径一致地派发所有 outcome。

- `packages/stores/src/node-connection-manager.ts:215`：QueryClient 清理由可选 `onDispose` 回调承担，但本 diff 没有在实际前端 manager 实例中注册该回调；新增测试只是直接注入 mock。该 diff 单独合入后，节点 runtime 回收时 QueryClient 仍永久驻留。应在真实宿主创建 manager 时接入 `disposeNodeQueryClient(nodeId)`。

- `apps/fe/src/auth/session-key-store.ts:303`：passkey 流程在创建 `sess.secretKey` 后没有失败清理。用户取消 WebAuthn、origin 选择失败或 options 请求异常时，未授权的 session 私钥只能等待 GC。应把整个 passkey 建立流程包进 `try/finally`，仅在成功转移给全局 session store 后取消清零。

## 结论

不建议合入。`rootEpoch` 强制检查、统一 nodeId 校验、两阶段 TOTP、REST 401 归属和 join 地址来源已按目标接入，未发现新的 standalone 模式回归；但旧 enrollment 私钥仍实际留在 `sessionStorage`，passkey origin 过滤和节点管理支持仍不完整，4401 在真实连接工厂中未接线，且 `hub=sync` 的失败重试会造成不可恢复的 key-log 进度分离。