## Blocker

- `packages/shared/src/auth/key-log.ts:197`：任意位置的 `reset-root` 都改用 payload 中的新根公钥验签，而不要求它是 genesis。恶意 hub 可基于已知的 `seq/prev_hash/root_epoch` 追加一条由攻击者新钥自签的 `reset-root`；`verifyKeyLogRecord()` 会接受，随后攻击者即可签发任意日志记录。这直接破坏“hub 无法签出用户凭证”的核心保证。应仅在显式 bootstrap/reset 流程中允许 `head.seq=0、record.seq=1、prev_hash=0` 的自签 `reset-root`；增量验签必须无条件拒绝它，`verifyKeyLogChain()` 也必须拒绝首条之后再次出现 `reset-root`。

- `packages/shared/src/auth/key-log.ts:209`：没有限制 `rotate-root` 的 signer，现有 passkey 可以直接签根轮换。失陷 entry 可把一次 passkey 登录手势的 WebAuthn challenge 替换为攻击者构造的 `rotate-root` 记录，健康 node 会切换到攻击者根钥，从“最多泄露当前会话窗口”升级为永久接管。应建立严格的 type/signer 矩阵：`rotate-root` 只能由当前根钥签名；`reset-root` 只能走本地 genesis 流程；其余允许 passkey 的类型再进入 WebAuthn 验证分支。

## Major

- `packages/shared/src/auth/delegation.ts:58`：验签只检查 `now < exp`，没有检查 `exp - issued_at == 18h`，也没有拒绝未来的 `issued_at`。例如一条有效签名但 `issued_at=0、exp=2^63` 的 delegation 会被长期接受；未来时间的 delegation 还可预签后延迟启用，绕过固定 18 小时授权窗口。应统一校验精确 TTL、`issued_at <= now`（如需时钟偏差则设很小的明确上限），并让 root 和 passkey 两条验证路径复用该校验。

- `packages/shared/src/auth/key-log.ts:165`：分叉检测只比较 `record_bytes`，没有比较 `sig`，但日志 head 是 `sha256(record_bytes ‖ sig)`。同一条 passkey 记录的 WebAuthn assertion JSON 可以仅改变空白或键顺序而保持验证结果不变，恶意 hub 因而能向两个 node 下发相同记录字节、不同 assertion 字节，使两端得到不同 head hash，而 `detectFork()` 不会报 fork。应让 `existingAtSeq` 包含原始 `sig` 或已存 hash，按 `computeRecordHash()` 比较完整后继；WebAuthn assertion 最好采用唯一的规范二进制编码后再参与哈希。

- `packages/shared/src/auth/encoding.ts:182`：`authorization_sig` 被固定为 64 字节；同时 `packages/shared/src/auth/key-log.ts:286` 无条件把它当 Ed25519 根签名验证。设计允许 enrollment authorization 使用完整 WebAuthn assertion，但 assertion 包含 `clientDataJSON/authenticatorData/signature`，长度不固定，因此 passkey enrollment 无法编码，更无法验签。应把 authorization proof 设计为带 signer、credential ID 和变长 assertion bytes 的明确 union，并在 admission 时按存储的 origin、RP ID、公钥和 counter 完整验证。

- `packages/shared/src/auth/key-log.ts:251`：`reset-root` 与普通 `rotate-root` 共用 reducer，保留全部 `nodeCerts`。灾难恢复后，先前已失陷机器的旧证书仍会被当前 node 当作合法 peer，违背“恢复后重新 enroll/join”的要求。应为本地 reset 使用独立的状态重建逻辑，清空旧 node 证书、peer cache 和相关链路，仅在新 genesis 后重新自签本机 `admit-node`。

- `packages/shared/src/auth/key-log.ts:306`：`admit-node` 对已有 `node_id` 直接覆盖证书。加入中的恶意设备控制 certificate 内容，可选择一个现存 node ID；entry 自动签署 admit 后，所有 node 都会把该 ID 的公钥替换成攻击者公钥，形成身份接管而非新增节点。应禁止任何 node ID 重用，包括已吊销 ID；换钥必须按设计使用新的随机 ID，并显式 revoke 旧证书。

## Minor

- `packages/shared/src/auth/encoding.test.ts:180`：login、authorization、certificate、TOTP AAD 以及多数 key-log payload 仅做实现自身的 encode/decode round-trip，没有硬编码期望字节；字段顺序或枚举编号若同时在编解码器中改变，测试仍通过，但跨版本签名和已存密文会失效。`packages/shared/src/auth/enrollment.test.ts:28` 的 join token 也只验证自身 round-trip，三个 32 字节字段整体换序仍不会失败。应为每个签名对象、关键 payload、join token、delegation challenge、record hash 和固定 nonce 的 AES-GCM ciphertext/tag 增加独立生成并硬编码的 expected hex/base64url 向量。

- `packages/shared/src/auth/root-key.test.ts:103`：测试名称声称覆盖 RFC 8032 strict verify，但只测试正常签名、错误消息和错误公钥；移除 `{zip215:false}` 后仍会全部通过。应加入硬编码的 ZIP-215 可接受但 RFC 8032 严格模式必须拒绝的低阶点或非规范编码向量。

## 结论

当前 63 个 auth 单测虽全部通过，但 `reset-root` 可被任意新钥自签追加，且 passkey 可签 `rotate-root`，两处都能突破设计的信任边界；此外分叉检测、passkey enrollment 和 reset 后成员清理仍不符合 §2。该 diff 目前不可合并，需先修复 blocker 和 major，并补齐真正锁定协议字节与严格验签性质的测试向量。