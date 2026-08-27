## Blocker

1. **`packages/app/src/index.ts:44`——新增命令未接入实际 CLI 入口**

   问题：新的命令分派仅存在于 `index.ts`，但 npm 包仍构建并执行 `src/cli-node.ts`；后者仍只识别 `init/doctor/upgrade/uninstall`。

   影响：实际执行 `npx tmex-cli hub user add alice`、`hub join`、`enroll` 等命令都会报 unknown command，所有 §5 新命令均不可用。

   建议修复：让 `cli-node.ts` 委托此处的 `main()`，或把构建入口改为 `index.ts`；同时增加通过实际 `bin/tmex.js` 执行新命令和帮助输出的集成测试。

2. **`packages/app/src/lib/local-auth.ts:134`——Node CLI 直接加载 Bun 专属数据库模块**

   问题：生产路径动态导入 gateway DB client，后者依赖 `bun:sqlite` 和 `drizzle-orm/bun-sqlite`。但发布包的 `bin/tmex.js` 使用 `#!/usr/bin/env node`，构建目标也是 Node。

   影响：即使修复上一项入口问题，任何需要打开本地 DB 的新命令都会在 Node 中因无法加载 `bun:sqlite` 而失败。

   建议修复：保持引导 CLI 的 Node 兼容性，通过已安装的 Bun 启动独立的本地鉴权子命令入口；或者改用 Node 兼容的 SQLite 实现。应增加 `node packages/app/bin/tmex.js ...` 的真实运行测试。

3. **`packages/app/src/commands/hub.ts:337`——join 无条件信任 hub 返回的 `node_certs`**

   问题：签名日志已经独立推导并持久化了可信证书，但随后代码把 hub 响应中的 `node_certs` 逐项直接 `upsertCert`，未验证它们是否与已验证的 `admit-node` 记录完全一致。

   影响：失陷 hub 可返回合法密钥日志，同时为已有 node ID 放入攻击者控制的 `ed_pk` 和任意签名字段。该记录会覆盖日志投影出的真实证书，后续 uplink/peer 验证便会信任攻击者密钥，直接破坏 §2 的信任模型。

   建议修复：不要从响应中的 `node_certs` 写入信任数据；证书必须只由已验证的 key log 投影产生。若保留该数组用于缓存，必须逐字节比对日志推导出的证书、授权、签名、用户 ID、admit seq 和撤销状态，不一致即拒绝整个 join。

## Major

1. **`packages/app/src/commands/enroll.ts:224`——生产环境无法取得 redeemed certificate，且 Ctrl-C 不能终止等待**

   问题：非 hub 角色的 `poll` 恒为 `null`；hub 角色依赖当前 CLI 进程内的 `redeemMailbox`，但真实 redeem 发生在另一个服务进程，从不会写入此 Map。SIGINT handler 仅打印消息，没有改变循环条件；注册 handler 后默认退出行为也被抑制。

   影响：真实执行 `enroll` 后会无限循环，无法自动签发 `admit-node`；按一次 Ctrl-C 只会打印提示，命令仍继续运行。

   建议修复：通过本地受控 API、数据库中的可验证 redeem 结果或明确的 IPC 获取 certificate；收到 SIGINT 时设置取消状态或触发 `AbortController`，确保退出并保留 Nodes 页确认路径。

2. **`packages/app/src/lib/hub-client.ts:60`——HTTPS 限制可被生产参数和重定向绕过**

   问题：`--insecure-local` 在 production 中也无条件允许明文 HTTP；同时所有 fetch 使用默认自动重定向，仅初始 URL 被校验，HTTPS endpoint 可把请求重定向到 HTTP。

   影响：`NODE_ENV=production tmex hub join http://localhost:8080 --insecure-local ...` 会通过校验；或者合法 HTTPS hub 返回 `302 Location: http://...` 后，认证和 redeem 请求会继续走未验证的明文连接，违反“仅接受系统信任链验证通过的 HTTPS”。

   建议修复：CLI 生产路径完全禁用 `--insecure-local`，仅通过测试注入开放；所有相关 fetch 使用 `redirect: 'error'`，或手动跟随并对每个目标重新执行同等 HTTPS 校验。

3. **`packages/app/src/commands/hub.ts:326`——把 token head hash 错当成响应链的最终 head**

   问题：代码将 token 中的 `key_log_head_hash` 直接作为 `verifyChainForJoin` 的最终 head 约束。设计要求是在全量日志中找到该锚点并验证完整链，而不是要求 redeem 时日志仍停留在创建 token 的瞬间。

   影响：创建 enrollment 后，只要另一台设备追加一条合法的 `admit-node`、`set-totp` 等非轮换记录，redeem 返回的全量链 head 就会变化；尚未过期且根钥未变化的 join token也会因 `head_hash_mismatch` 被拒绝。

   建议修复：验证完整链，在链中确认 token head hash 确实出现，同时要求最终根公钥仍等于 token root key；若期间发生 root rotation，则通过最终根钥不匹配或 epoch 校验拒绝。

4. **`packages/app/src/commands/hub.ts:268`——新节点证书的 UID 未与已验证链绑定**

   问题：证书 UID 来自未认证的 `/api/auth/mode` 响应；join 完成后又未检查生成证书 UID、key log genesis UID、`redeemed.user.id` 三者相等。

   影响：失陷 hub 可返回伪造 UID，让客户端用真实 `enroll_sk` 签出属于错误用户的节点证书，再返回 token 所钉住的合法日志链。链校验会通过，但该节点证书永远无法成为该链的合法 `admit-node`，一次性 token 已被消耗，节点留下不一致身份。

   建议修复：从验证后的 genesis 记录取得可信 UID，并在提交任何状态前核对 certificate UID、authorization UID、响应 user ID 与 genesis UID 全部一致。

5. **`packages/app/src/commands/hub.ts:267`——join 跨网络、DB、identity 和 app.env 的提交不是原子的**

   问题：代码先持久化 node identity，redeem 消耗远端一次性 token，再由 `verifyChainForJoin` 写入用户和日志，随后逐条写证书，最后改 app.env。任一步失败都没有回滚或可重试协议。

   影响：例如 hub 返回一个合法链和两张证书，第二张证书的 base64 损坏时，可信链及第一张证书已落库，但角色仍是 standalone；或者 app.env 写入因磁盘满失败时，远端 token 已使用、DB 已变更，重新 join 又会得到 reused。

   建议修复：先在内存中完整解码并验证响应，再用单个 DB 事务提交用户、日志、证书和 identity；app.env 使用临时文件加原子 rename。redeem 需要按 `enroll_pk/node_id` 提供安全的幂等重试，避免响应传输失败永久消耗 token。

6. **`packages/app/src/lib/hub-client.ts:150`——非 hub 节点的 enroll 登录不支持 TOTP**

   问题：root delegation 登录请求从不携带 `totp: {code, k_totp}`，`runEnroll` 也没有读取验证码或派生 TOTP key。

   影响：用户执行 `hub user totp` 后，在普通 node 上运行 `enroll`，目标节点会按 §2 返回 `TOTP_REQUIRED`，导致该命令无法创建 enrollment。

   建议修复：检测本地用户的 TOTP 状态；启用时提示输入一次性验证码，使用当前 root seed/epoch 派生 `k_totp` 并随登录发送，使用后立即丢弃。

7. **`packages/app/src/commands/hub.ts:122`——`hub user add` 会无旧钥确认地重置同名现有用户**

   问题：调用前未拒绝重复 username，而 `bootstrapUser` 对现有用户会删除 key log、passkey、sessions 和证书并生成新的 genesis。

   影响：管理员误重复执行 `hub user add alice`，就会绕过 `passwd` 的旧钥签名要求和显式 `mesh reset-root` 灾难恢复流程，直接使所有既有节点、passkey 和 TOTP 失效。

   建议修复：`hub user add` 必须在派生或写入前拒绝已存在的 username；日常改密只允许 `passwd`，无旧钥恢复只允许显式的本地 `mesh reset-root`。

8. **`packages/app/src/commands/mesh.ts:59`——reset-root/genesis 与本机 self-admit 未作为一个事务提交**

   问题：`bootstrapUser` 已经破坏性重建用户日志和清理证书，之后才生成并应用本机 `admit-node`；`hub user add` 也采用相同顺序。后半段失败时不会恢复旧状态。

   影响：数据库写满、identity 加密失败或 `admit-node` 写入失败时，命令报错，但旧日志和所有节点证书已经消失，本机又没有新的可用证书。

   建议修复：提供专用服务方法，在一个 SQLite 事务中完成 genesis/reset、identity 准备和本机 admit；所有签名材料先在内存生成，确认无误后一次提交。

9. **`packages/app/src/commands/hub.ts:233`——`hub user reset` 会被当前运行中的 uplink 立即撤销效果**

   问题：命令只删除 `nodes` 和 `enrollment_tokens`，没有通知或停止 HubRuntime 中已认证的 uplink。现有 uplink 的证书仍在 `node_certs`，下一次 `node.status` 会重新创建被删除的 node 行。

   影响：灾难恢复时执行 `hub user reset` 后，攻击者或旧节点的存量连接仍可继续工作，并可在数秒内把注册表重新填回去，命令表面成功但没有真正清空 hub 注册状态。

   建议修复：通过本地管理通道让 HubRuntime 原子断开并清空所有相关连接和 registry；同时定义 reset 后的重新注册门槛，避免仅凭旧 `node_certs` 自动重建 `nodes`。

## 结论

该 diff 当前不可合入：实际 CLI 入口未接线且运行时与 Node 发布方式不兼容；更严重的是 join 会把失陷 hub 提供的未验证证书写入信任库。除此之外，enroll 等待流程、HTTPS 边界、TOTP、链锚点以及多处跨 DB/配置/服务状态的一致性都未满足设计要求。