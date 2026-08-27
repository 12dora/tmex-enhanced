# v3.1 二次审查

结论：v3.1 修复了多数 v3 blocker，但仍有 5 个 blocker：自动 `admit-node` 可变成 hub 的签名预言机、临时钥可升级为持久 passkey、`method` 错配可绕过 TOTP、滑动 session 可被无限续期、浏览器直连仍无法抵抗失陷 entry。按当前文本，尚不满足“任意单点失陷只影响该点”。

## 1. design-review-01 逐项状态

### Security holes

- `[blocker] node.list / enrollment 信任根 — PARTIALLY：`公钥已改由用户证书链提供，但自动 `admit-node` 未绑定页面本地 pending enrollment，失陷 hub 仍可能诱导页面签入攻击者证书。

- `[blocker] hub_public_key 循环信任 — RESOLVED：`join 现仅接受系统信任链验证成功的 HTTPS。

- `[blocker] via 与活跃会话 — PARTIALLY：`明确承认 entry 在会话窗口内有权限，但滑动续期使被窃 ticket 可无限延长，不是最多 18 小时。

- `[blocker] 密码泄露后 passwd 恢复 — PARTIALLY：`新 epoch 会清除 passkey/TOTP/session；但攻击者可先执行 `rotate-root` 锁死用户，仍无独立恢复路径。

- `[should-fix] 登录对象与 challenge 绑定 — PARTIALLY：`Borsh、链路 entry、原子消费已补；`login.method` 未要求等于 `delegation.method`，challenge/delegation 的期限检查也未写入验证步骤。

- `[blocker] TOTP 不是独立第二因素 — DELIBERATELY REJECTED：`TOTP 保留，并明确限定只防不掌握 node 数据的远程猜测/旁观。

- `[should-fix] TOTP AES-GCM 格式 — RESOLVED：`已定义算法、随机 12 字节 nonce、tag、AAD、epoch 与 seq。

- `[blocker] user_key_log 链不完整 — PARTIALLY：`已加入 seq/prev_hash/epoch、分叉硬失败和 join head；仍缺记录 hash 算法、rotate epoch 验证状态机，以及临时授权签持久记录的有效期语义。

- `[blocker] WebRTC 未绑定 DTLS — RESOLVED：`节点握手和浏览器直连都加入了实际 DTLS fingerprint 绑定；具体 API/信任路径问题见下文。

- `[blocker] relay 重连重用 GCM key/nonce — RESOLVED：`每次握手使用临时 X25519，并以 transcript 经 HKDF 派生方向密钥。

- `[blocker] 响应头允许 SVG 同源脚本 — RESOLVED：`已改为精确 MIME allowlist、排除 SVG/XML/HTML，并强制 CSP sandbox。

### Factual errors

- `[blocker] 一次 passkey 无法登录所有 node — RESOLVED：`passkey 现在只签一次浏览器临时钥 delegation，后续各 node challenge 由临时钥签。

- `[blocker] expectedOrigin 来自 OPEN 自报值 — RESOLVED：`登录验证改从 credential 记录读取精确 origin。

- `[should-fix] HTTPS IP 可使用 passkey — RESOLVED：`已明确 IP origin 不支持。

- `[should-fix] WebAuthn 浏览器 API 形状 — PARTIALLY：`改用了 SimpleWebAuthn，但 `startAuthentication({challenge: ...})` 仍不是当前 API 形状。

- `[should-fix] 两套 DataChannel 背压 API — RESOLVED：`已明确浏览器/Bun 分别适配。

- `[should-fix] node-datachannel native loader — RESOLVED：`已明确内联 `detect-libc`、绝对路径加载、manifest addon 路径与 N-API 探测。

- `[should-fix] PDF 预览被 MIME allowlist 破坏 — RESOLVED：`已加入 `application/pdf` 并置于 CSP sandbox。

- `[nit] Bun Ed25519 / hash-wasm 验证 — RESOLVED：`继续使用 noble，并保留 Bun/浏览器测试向量要求。

### Implementation gaps

- `[blocker] passkey 注册流程未定义 — PARTIALLY：`主要 ceremony 已补；仍缺 registration challenge 的持久化/原子消费、完整 `backupState/deviceType` 状态及被签 payload 的精确定义。

- `[blocker] 载体切回缺少全会话 ACK — DELIBERATELY REJECTED：`作者接受浏览器→node 最近输入可能丢失，并仅做 UI 提示。

- `[should-fix] HTTP mux half-close — RESOLVED：`已定义双向 END、RST、提前响应和 abort/cancel 传播。

- `[should-fix] KDF/签名规范编码 — PARTIALLY：`KDF、NFKC、密钥格式和 HKDF hash 已补；各对象的精确 Borsh 字段类型、时间编码、hash 定义仍缺。

- `[blocker] hub 离线后 IP 变化无法发现 — DELIBERATELY REJECTED：`v1 明确只保证缓存地址仍有效时工作。

- `[should-fix] TMEX_PUBLIC_URL 无法表达多 origin — RESOLVED：`改为每 credential 保存精确 RP ID/origin。

### Over-engineering

- `[should-fix] 删除浏览器↔node 直连 — DELIBERATELY REJECTED：`作者明确保留第二条 WebRTC 载体。

- `[nit] 两套路径徽标与完整 ICE 诊断 — NOT ADDRESSED：`仍全部保留。

- `[nit] 不应删除 key log/node certificate — RESOLVED：`两者均保留。

## 2. v3.1 新机制的安全审查

### Enrollment key → certificate → admit-node

- **[blocker] 自动 admit 未绑定本地 enrollment，失陷 hub 可注入成员。** [注册流程](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:161)只说 hub 将 `{certificate, cert_sig}` 推给页面，页面随后自动签 `admit-node`，没有要求页面核对 `certificate.enroll_pk` 等于自己刚生成并授权的 pending `enroll_pk`。

  攻击路径：① hub 生成自己的 enroll key 和攻击者 node certificate；② 等待用户创建合法 enrollment；③ 用攻击者 certificate 替换“join 完成”通知；④ 页面自动用用户授权链签 `admit-node`；⑤ 所有 node 接受攻击者成员。必须把 pending authorization hash/enroll_pk 保存在页面状态，并只签完全匹配且 `cert_sig` 验证成功的 certificate。

- **[should-fix] 证书链文本和持久化结构不一致。** 文本声称验证 `root → authorization → certificate → admit`，但 `node_certs` 不保存 `authorization_json/signature`，`admit-node` payload 也只写 `{certificate, cert_sig}`；其他 node 无法验证所述中间链。[表结构](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:122) [证书链](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:164) 当前实际安全边界只能是“根钥签过整个 admit payload”。

- **[should-fix] admit 签名权限互相矛盾。** key log 规定临时钥只能签 `add-passkey/set-totp`，但 enrollment 又要求仅持 `sk_sess` 的页面签 `admit-node`。[key log](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:110) [admit](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:163) 若放宽为临时钥可签 admit，会扩大失陷 entry 的持久化能力；不放宽则流程无法执行。

### Browser session-key delegation

- **[blocker] passkey delegation 可升级为永久账户接管。** 文本允许 passkey 授权的 `sk_sess` 签 `add-passkey`。[delegation](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:109) [key log](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:110)

  攻击路径：① 用户通过 passkey 登录失陷 entry；② entry 注入的前端取得内存中的 `sk_sess + delegation`；③ 攻击者在同一 RP 注册自己的 passkey；④ 用 `sk_sess` 签 `add-passkey`；⑤ 18 小时后攻击者仍可用新 passkey 登录全部 node。因而“passkey 登录只泄露 18 小时”不成立。

  临时 delegation 应只授权登录；持久 key-log mutation 应由根钥，或由 passkey 对该条完整 mutation 做一次专用 assertion。否则还存在无法可靠判断“记录是在 delegation 到期前签署还是事后回填时间”的问题。

- **[blocker] delegation 证明没有完整进入 key-log payload。** 文本只说 payload 记录 `delegation`，没有记录 passkey assertion/`delegation_sig`；离线 node 无法证明该 `sess_pk` 确由 passkey 授权。

### Login object 与 challenge

- **[blocker] `method` 错配可直接绕过 TOTP。** `delegation.method` 与 `login.method` 分属两个签名对象，而验证步骤只按 `login.method === root` 决定是否检查 TOTP，没有要求两者相等。[登录步骤](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:150)

  攻击路径：① 只知道密码的远程攻击者派生根钥并签一个 `method:'root'` delegation；② 用对应 `sk_sess` 签 `login.method='passkey'`；③ T 分别验签均成功；④ TOTP 分支被跳过。验证方法必须从已验证的 delegation 类型导出，不能信任 login 中独立声明的方法。

- **[should-fix] 期限没有进入明确验证步骤。** challenge 登记了 60 秒、delegation 带 `exp`，但步骤 3 只写“取出、原子消费、验 delegation”，未明确拒绝过期值。[challenge](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:150) 按协议文本实现会允许 entry 留存一次尚未消费的签名，日后再换取新 session。

### rotate-root epoch

- **[blocker] `passwd` 仍不能保证恢复。** ① 失陷 entry 得到旧根钥；② 攻击者先签 `rotate-root`，把新根设为攻击者密钥；③ node 顺序应用并清空合法凭证；④ 用户的 passwd 已无当前根钥可签，或形成硬失败分叉。故“后果止于 passwd”仍缺恢复前提。[轮换声明](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:111)

- **[should-fix] epoch 状态机未定义。** 必须明确 rotate 记录外层 `root_epoch` 是旧值还是新值、用哪把钥验签、应用后何时切换到新钥，以及普通记录必须严格等于当前 epoch；当前文字只定义 payload 中的 `old+1`。

### Peer transcript、DTLS 与 HKDF

- 在固定 hello 排序并比较实际 `remoteFingerprint()` 的前提下，未找到 hub-only DTLS MITM 路径；hub 改写 SDP 后无法同时伪造 node 签名和匹配实际远端证书。[peer 握手](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:170)

- **[should-fix] `role` 使 transcript/KDF 不确定。** 若双方分别写 `initiator/responder`，签名对象和 `sha256(transcript)` 不同，派生不出同一组密钥；若 `role` 是全局角色，文本又未定义。应给 hello 固定排序、固定 `offerer_id`，并以同一个无视角差异的 transcript 作为 HKDF salt；方向 info 使用明确的 `sender_node_id → receiver_node_id`。

### Browser ↔ node rtc/authorize

- **[blocker] 它只能防失陷 hub，不能防失陷 entry。** `/rtc/authorize` 的请求、响应和 SDP 全经过 entry；“hub 无法篡改”成立，但 entry 本身可篡改。[直连授权](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:208)

  攻击路径：① 失陷 entry 将浏览器提交的 `fp_browser` 换成自己的 `fp_A`；② T 将 nonce 绑定到 A 的 PeerConnection；③ entry 再向浏览器替换 `fp_node` 和 SDP，使浏览器连接 entry 的另一张证书；④ entry 在两条 DTLS 通道间转发 nonce和数据，读取全部 `sess/bulk` 内容。此机制没有独立于 entry 的浏览器→T 信任锚。

  这也暴露了目标与安全表的冲突：总目标说任意 node 失陷只影响自身，[目标 §3](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:24)；安全表却明确允许正在使用的 entry 操作其他机器。[安全边界](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:308)

### Response-header allowlist 与 CSP

未发现普通目标 node 借此取得 entry-origin 脚本权限的具体路径。精确排除 HTML/SVG/XML、覆盖未知 MIME、丢弃目标 CSP/Refresh/Set-Cookie，再由响应 CSP `sandbox` 产生 opaque origin，已经封住上一版攻击链。[响应头策略](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:202)

### 18h sliding node-session

- **[blocker] 滑动期限不是“18 小时窗口”，而是攻击者可永久续期。** ① 用户经 entry A 登录 T；② A 捕获 `tmex_s_T`；③ 浏览器关闭后，A 仍以自身 node 身份向 T 重放；④ 每次成功请求都把 expiry 重置为 `now+18h`；⑤ A 每 18 小时内使用一次即可永久操作 T。[滑动规则](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:144)

- **[blocker] remove-passkey 无法按当前 schema 撤销对应 session。** 撤销规则声称可由 `sess_public_key` 回溯 delegation，但 `node_sessions` 没有 `credential_id`、delegation hash 或签发方法。[表结构](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:121) [撤销规则](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:183) 被删除 passkey 签发的 ticket 因而可能继续滑动。

## 3. 新文本中的事实错误

- **[should-fix] SimpleWebAuthn 调用形状仍错。** 当前 API 要求 `startAuthentication({optionsJSON})`，其中 options 至少包含 challenge、RP ID、allowCredentials、userVerification；不是 `startAuthentication({challenge})`。[文档原文](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:109) [SimpleWebAuthn 官方文档](https://simplewebauthn.dev/docs/packages/browser/)

- **[should-fix] passkey assertion 验证描述不完整。** 除 `expectedOrigin` 外还必须校验 expected challenge、RP ID hash、UP/UV、签名和 credential 状态；当前登录步骤只特别写了 origin。[WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/)

- **[should-fix] “counter 回退即拒绝”不是普适 WebAuthn 规则。** authenticator 可以始终返回零；非零 counter 的不递增只表示克隆、故障或竞态信号。严格拒绝会误伤部分同步 passkey。[WebAuthn §6.1.1](https://www.w3.org/TR/webauthn-3/#sctn-sign-counter)

- **[should-fix] `remoteFingerprint()` 不是字符串。** `node-datachannel@0.33.1` 返回 `{value, algorithm}`；比较必须同时规范化算法和值。[node-datachannel API](https://github.com/murat-dogan/node-datachannel/blob/v0.33.1/API.md)

- **[should-fix] node-datachannel 没有本地 fingerprint getter。** 本地指纹只能在生成 local description 后从 `localDescription().sdp`/`onLocalDescription` 解析；其 polyfill `RTCCertificate.getFingerprints()` 不能作为实现依据。浏览器侧同样必须先创建 offer 并 `setLocalDescription()`，不是仅创建 `RTCPeerConnection` 就能读取。[直连文字](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:208)

- **[should-fix] Borsh 本身是确定编码，但数据库 JSON 无法自动保存“被签字节”。** Borsh u64 是小端整数，项目使用的 Zorsh 以 `bigint` 表示；`issued_at/exp` 等时间字段若用 u64，不能直接进入 `payload_json`。必须固定字段类型，并保存原始 Borsh bytes 或定义无损 JSON 映射。[Borsh 规范](https://github.com/near/borsh#specification)

- **[should-fix] AES-GCM tag 长度仍未定义。** 12 字节 nonce、AAD 和每连接新 key 均正确；但协议需要固定 16 字节 authentication tag，否则不同 WebCrypto/native 实现可选择不同 tagLength。[RFC 5116](https://www.rfc-editor.org/rfc/rfc5116.html)

- **[should-fix] HKDF 算法使用正确，但输入编码不完整。** transcript salt 的思路符合 HKDF；问题是双方 transcript/方向 info 未规范为完全相同的字节序列。`"tmex-totp" ‖ root_epoch` 也应规定 epoch 的固定宽度和端序。[RFC 5869](https://www.rfc-editor.org/rfc/rfc5869.html)

X25519 临时钥、HKDF-Extract+Expand、每方向独立 GCM key/nonce 的总体用法没有发现事实错误；当前锁定的 `@noble/curves@1.9.7` 也会拒绝产生全零共享秘密的低阶输入。

## 4. 相对需求的过度设计

- **[should-fix] passkey delegation 不应承担持久 key-log mutation。** 它既增加授权链、过期时间和撤销映射，又制造永久提权漏洞；只保留“一次 passkey → 18h 登录临时钥”即可。

- **[should-fix] DB-backed `node-session` 再做 node 私钥签名是重复机制。** T 每次都必须查 `node_sessions` 判断 expiry/revocation，随机 opaque `sid` 已足够；签名没有带来无状态验证。

- **[should-fix] 18h 滑动续期引入 DB 节流、响应头、cookie 刷新和 WS 特殊续期，却弱化安全边界。** 固定绝对到期时间更简单，也至少能给 ticket 泄露设置上界。

- **[nit] DataChannel 路径派生 `k_ab/k_ba` 后完全不用。** 可仅在 relay/SecureChannel 路径执行 X25519+HKDF；DataChannel 路径只做签名 transcript 与 DTLS fingerprint 绑定。

- **[should-fix] 浏览器直连、第二载体、bulk、切换屏障和双 ICE 诊断仍是最大的一组额外复杂度。** 作者已明确拒绝删除；它服务于浏览器绕过 entry 的延迟目标，而不是单点失陷安全要求，并且当前 authorize 方案实际上仍无法绕过失陷 entry。