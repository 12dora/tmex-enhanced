# 1. Security holes

- **[blocker] `node.list` 与 enrollment 仍把 hub 当成节点身份信任根。** 设计称“`peer_cache` 首次见到某 node 的公钥即钉住”，且浏览器只把挑战中的 `pk_T` 与 entry 从 hub 获得的清单比较（[§2 节点缓存](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:117)、[§2 登录](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:133)）。这是对同一不可信来源做自洽检查，不是认证。

  攻击路径：

  1. 失陷 hub 在 A 第一次发现 B 前，将 B 的 `public_key`、`x25519_public_key` 和 endpoint 换成攻击者的值，或直接插入一个冒充 B 的节点。
  2. A 对攻击者密钥执行 TOFU；浏览器看到的清单和假 B 返回的 `nodePk` 一致。
  3. 浏览器按设计自动为清单中的节点签署登录消息，密码路径还会把 `k_totp` 发送给假 B。
  4. 攻击者虽然不能拿该签名登录真 B，但可以冒充 B、读取用户本来要发给 B 的命令和文件，并返回恶意内容。这已经违反“hub 失陷不能读取经它促成的流量”。

  enrollment 同样没有绑定设备密钥：根钥只签了 `{token_hash, exp}`，未签新 node 的 Ed25519/X25519 公钥（[§2 enrollment](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:146)）。hub 在 redeem 时看到 `token_secret`，可抢先把攻击者密钥注册到受害用户下面；“攻击者 token 加入的 node 只属于攻击者”这一结论不成立。join 串中的根公钥只认证用户根钥，没有认证新 node 密钥。

  应改成用户签名的 node certificate，例如固定编码的 `{userId,nodeId,nodeEdPk,nodeX25519Pk,hubId,issuedAt,epoch}`。join 可采用两阶段批准，或在 join 串中放一次性 enrollment 签名私钥，其公钥由根钥授权；redeem 只发送签名后的设备证书，绝不能把该一次性私钥交给 hub。`node.list` 只能搬运证书，不能决定密钥。重装换钥也必须提供新的用户签名证书，而不是依赖 UI 对 hub 提示的 TOFU 变更点确认。

- **[blocker] `hub_public_key` 从 enrollment 响应中自我声明，不能认证 enrollment 响应。** “redeem 返回 `hub_public_key`，然后写入 `node_identity`”（[§2 enrollment](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:147)）是循环信任。

  攻击路径：

  1. join 若允许 HTTP、自签证书或未严格验证的 HTTPS，中间人返回自己的 hub 公钥。
  2. 新 node 将其永久钉住，并把后续 uplink、目录和信令交给攻击者。
  3. 配合上述首次节点换钥和当前 WebRTC MITM 缺陷，攻击者可以读取流量。

  必须规范为：join 只允许系统信任链验证成功的 HTTPS，或者 join 串/out-of-band 输入包含 hub 公钥指纹并在 redeem 前验证。仅从响应体读取公钥不能建立信任。

- **[blocker] `via` 绑定没有把权限限制在“活跃会话”，最多 24 小时的 bearer ticket 可被 entry 留存。** 设计规定 `node-session` “仅在来自 `via` 的链路上”接受，但有效期可达 24 小时（[§2 信任矩阵](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:124)）。

  攻击路径：

  1. 浏览器向 entry E 请求 `/n/T/*` 时，E 必然能看到并提取 `tmex_s_<T>` cookie；E 同时持有自己的 node 私钥。
  2. E 在用户关闭页面前保存该票。
  3. 页面关闭后，E 仍能以自身 node 身份连接 T，并重放该票至过期。
  4. 因而 passkey 登录也不是安全边界表所称“只泄露本次活跃会话”（[安全边界](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:282)）。

  更根本的问题是 entry 控制页面 origin 和前端代码；它可以保留 cookie、注册 Service Worker 或持续维持会话。仅靠 bearer cookie 无法严格实现“只在用户活跃时”。要么产品接受明确的会话窗口并缩短/撤销 ticket，要么引入不由 entry 托管的可信客户端边界；当前安全结论不可成立。

- **[blocker] 密码泄露后的影响不止“到 passwd 前”。** entry 得到密码即可派生根私钥，并签署 `add-passkey`、`set-totp` 或恶意 `rotate-root`。当前 `rotate-root` 不会自动删除此前添加的 passkey。

  攻击路径：

  1. 失陷 entry 捕获用户输入的密码。
  2. 攻击者用根钥签署自己的 `add-passkey` 记录。
  3. 用户随后执行 `passwd`，旧根钥失效，但攻击者 passkey 仍在 `user_keys`。
  4. 攻击者继续登录所有机器，或在用户改密前先旋转根钥将用户锁出。

  如果设计要承诺“改密后恢复”，根轮换必须建立新的安全 epoch，撤销全部会话，并要求重新确认 passkey、TOTP 和其他由旧根授权的持久凭证；还需要一个不依赖已泄露旧根的灾难恢复流程。否则应明确承认输入密码到失陷 entry 可能造成永久账户接管。

- **[should-fix] 登录消息和 challenge 状态没有完整绑定。** 当前消息是 `M = tag ‖ nonce ‖ pk_T ‖ uid ‖ E`（[§2 登录](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:134)）。

  攻击路径取决于实现者如何补空白：

  1. `uid`、`E` 是变长字段，但没有长度前缀或规范编码，可能出现拼接歧义。
  2. 如果 nonce 记录未绑定 `{uid,targetNodeId,targetPk,authenticatedPeerE,method}`，攻击者可以改变请求字段或在另一条链路重放。
  3. 如果成功后未原子消费 nonce，同一签名可以反复签发 session。
  4. 如果 `E` 来自请求体而不是已经认证的 peer link，攻击节点可以请求签发 `via=其他节点` 的票。

  应定义固定的 CBOR/Borsh/长度前缀编码，并将协议版本、登录方法、目标 `nodeId`、目标公钥、uid、entry nodeId、challenge ID 和期限全部签入。T 必须从链路身份导出 E，challenge 成功后原子消费。

- **[blocker] TOTP 不是独立第二因素，旧审查的 H1 实质上仍未解决。** 设计把 TOTP secret 用同一个密码 seed 派生的 `k_totp` 加密（[§2 TOTP](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:100)）。

  攻击路径：

  1. 任意失陷 node 得到根公钥、KDF salt/参数和 TOTP ciphertext。
  2. 攻击者离线猜密码；根公钥是确定性的密码正确性验证器。
  3. 一旦猜中，同一个 seed 同时给出根私钥和 `k_totp`，从而解出 TOTP secret。
  4. 攻击者拥有密码签名和 TOTP，可登录所有其他机器。TOTP 没有为离线口令破解增加第二个独立秘密。
  5. 即使尚未破解密码，受控目标 T 也能在用户从诚实 entry 登录 T 时截获稳定的 `k_totp`，永久取得全局 TOTP secret，进一步消除第二因素。

  在“每台机器不能持有可用于其他机器的秘密”前提下，传统共享密钥 TOTP 与离线 node 验证本身不兼容。应删除 TOTP，或改用真正用户持有的非对称第二因素，例如要求 passkey 与密码共同认证；不能把“用密码加密 TOTP secret”描述成第二因素。

- **[should-fix] TOTP 密文格式仍缺少安全必需字段。** `AES-GCM(k_totp, secret)` 未定义随机 nonce、tag、AAD、算法版本和 root epoch。若同一根钥下 `set-totp` 重用 nonce，会破坏 GCM 的机密性和完整性；AES-GCM 要求同一 key 下 nonce 唯一（[RFC 5116 §5.1.1](https://www.rfc-editor.org/rfc/rfc5116.html#section-5.1.1)）。此外，根轮换后新 seed 无法解密旧 ciphertext。记录至少要包含随机 96-bit nonce，并以 `{userId,rootEpoch,logSeq,alg}` 为 AAD；根轮换必须明确重加密或重设 TOTP。

- **[blocker] `user_key_log` 不是一条定义完整、可防回放/分叉/降级的签名链。** 设计只说每条记录“带 `sig`”，并由旧根或当前根签署（[§2 key log](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:99)）。

  攻击路径：

  1. 若 `seq`、类型、用户、root epoch、前一记录 hash 没有全部签入，失陷 hub 可给旧 `add-passkey` 换序号，在 `remove-passkey` 后重放。
  2. hub 可向不同 node 提供不同合法前缀；当前的 peer gossip 没有定义分叉选择或冲突失败规则。
  3. 新 node 的 join 串携带“当前根公钥”，但全量日志里的旧记录由历史根钥签署；从当前根无法向后认证旧根，因此“逐条验签全量日志”存在启动循环。
  4. hub 可向新 node 提供过期但仍合法的状态快照，而 join 串没有绑定日志 head/checkpoint。
  5. `rotate-root` 也未说明是否签入新 KDF salt/参数、TOTP 新密文以及旧/新 root epoch。

  应把每条记录规范为签名覆盖 `{domain,userId,seq,prevHash,rootEpoch,type,canonicalPayload}`；node 只接受 `seq=local+1 && prevHash=localHead`。join 串必须绑定当前签名 checkpoint/hash，或携带由当前根签署的完整当前状态快照。检测到同一 `seq/prevHash` 的两个后继必须硬失败并提示分叉，不能由 hub 选胜者。

- **[blocker] WebRTC 的身份签名没有绑定 DTLS 通道，失陷 hub 可做透明 MITM。** peer 握手只签 nonce、nodeId 和签名方 X25519 公钥（[§2 peer auth](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:149)）；浏览器直连只发送 bearer nonce（[§3 RTC authorize](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:182)）。`rtc.signal` 的 hub 侧来源检查在 hub 已失陷时没有安全价值。

  攻击路径：

  1. hub 改写 SDP/candidate，在 A 与 B 之间建立 A↔H、H↔B 两条 DTLS/DataChannel。
  2. H 在两条通道间转发握手 nonce 和 Ed25519 签名；由于签名不含 DTLS fingerprint/exporter，两端都验证成功。
  3. 浏览器直连同理：H 先从浏览器收到 authorize nonce，再转发给真正 T。
  4. H 终止两端 DTLS，因此能读取和修改全部 `sess`、`bulk` 和 node peer 数据。

  必须把节点签名绑定到双方 DTLS certificate fingerprint或通道 exporter、rtcSession、双方身份和角色。更稳妥的方案是在所有 DataChannel 上继续运行应用层 SecureChannel；`node-datachannel` 本身暴露 `remoteFingerprint()`，可用于绑定（[官方 API](https://github.com/murat-dogan/node-datachannel/blob/master/API.md#peerconnection-class)）。

- **[blocker] relay SecureChannel 会在重连后重用 AES-GCM key/nonce。** 设计使用静态 X25519 共享密钥和“方向位 + 64 位计数器”（[§3 SecureChannel](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:164)），却没有每次连接的会话 KDF。

  攻击路径：

  1. A、B 的静态 X25519 密钥不变，ECDH 输出长期不变。
  2. relay 重连后计数器通常从零重新开始。
  3. hub 收集两次连接中相同 key/nonce 下的 ciphertext。
  4. AES-GCM nonce 重用会破坏机密性和完整性，hub 可恢复明文关系并最终伪造数据。

  应每次握手使用临时 X25519，或至少以双方随机 nonce、身份、rtc/relay session ID 和完整握手 transcript 作为 HKDF-SHA-256 salt/info，派生独立的 A→B、B→A key。每个方向使用独立 96-bit nonce 空间，并在握手签名中绑定 transcript。

- **[blocker] 响应头策略仍允许被攻破 node 取得 entry origin 的脚本权限。** 白名单包含整个 `image/*`（[§3 响应头策略](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:176)），因此包含可执行脚本的 `image/svg+xml`。SVG 明确允许 `<script>`（[MDN](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/script)）。

  攻击路径：

  1. 失陷 T 返回 `Content-Type: image/svg+xml` 和带脚本的 SVG。
  2. entry 保留该 MIME；`nosniff` 只会确保浏览器按 SVG 解释，不会禁用 SVG 脚本。
  3. 当前前端有图片内联地址和“新窗口打开原文件”的链接（[FilePage.tsx:97](/Users/konata/code/tmex-enhanced/apps/fe/src/pages/FilePage.tsx:97)、[FilePage.tsx:278](/Users/konata/code/tmex-enhanced/apps/fe/src/pages/FilePage.tsx:278)）。
  4. 用户打开该 SVG 后，脚本运行在 entry origin，可携带 HttpOnly cookie 调用其他 node 的 API/WS。
  5. 一台普通目标 node 因此可以操作全部机器；早期安全审查的 H2 blocker 未解决。

  entry 应覆盖为 `Content-Security-Policy: sandbox; default-src 'none'; base-uri 'none'; form-action 'none'`，并采用精确 MIME allowlist，至少排除 SVG/XML；不能使用 `image/*`。`Content-Disposition` 必须覆盖而非追加，响应头最好采用 allowlist，同时删除 `Refresh`、`Content-Security-Policy-Report-Only` 等可改变导航/加载行为的字段。

# 2. Factual errors

- **[blocker] “一次 passkey 后并行登录所有 node”不符合 WebAuthn challenge 行为。** 每个目标的 `M` 包含不同的 `pk_T` 和 nonce，因此每个目标需要不同 assertion；一个 assertion 只能验证它实际签署的一个 challenge。当前描述会产生 N 次 `navigator.credentials.get()` 和 N 次用户交互，而不是“一次 passkey”（[登录体验](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:140)）。如需一次交互，应让 assertion 授权一个短期浏览器临时公钥或签署包含完整目标集合的 batch，再由临时钥签目标 challenge。

- **[blocker] `expectedOrigin` 不能取自 OPEN 载荷中 entry 自报的值。** WebAuthn 要求 RP 将 `clientDataJSON.origin` 与自己预先期望的 origin 比较，而不是与请求方提供的任意字符串比较；规范明确要求不得接受意外 origin（[WebAuthn Level 3 §13.4.9](https://www.w3.org/TR/webauthn-3/#sctn-validating-origin)）。`@simplewebauthn/server` 的 `expectedOrigin` 也是服务端配置/记录值（[官方示例](https://simplewebauthn.dev/docs/packages/server/#2-verify-authentication-response)）。`user_keys` 必须存根钥签名的精确 origin，并从该记录取 `expectedOrigin`。

- **[should-fix] “passkey 只在 https 或 localhost entry 提供”对 IP 地址描述不完整。** WebAuthn RP ID 必须是有效域名；规范明确排除 IPv4/IPv6 host，即使是 HTTPS IP 也不能作为 RP ID。只有 `http://localhost` 有特殊例外（[WebAuthn RP ID 规则](https://www.w3.org/TR/webauthn-3/#relying-party-identifier)）。因此 `https://192.168.x.x` 也不能按“RP ID = entry host”工作。UI 不能只检查 `window.isSecureContext`，还要检查有效域名/localhost。

- **[should-fix] `navigator.credentials.get` 的示例不是实际 Web API 形状。** 原生 API 是 `navigator.credentials.get({publicKey: {challenge, rpId, ...}})`；如果采用 `@simplewebauthn/browser`，则应使用其 `startAuthentication()` 及 JSON 序列化类型。当前 `navigator.credentials.get({challenge, rpId})`（[§2 登录](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:136)）不能直接实现。

- **[should-fix] node-datachannel 与浏览器 DataChannel 的背压 API 不同。** 浏览器使用属性和事件；node-datachannel 使用 `bufferedAmount()`、`setBufferedAmountLowThreshold()`、`onBufferedAmountLow()`，并提供 `maxMessageSize()`（[官方 API](https://github.com/murat-dogan/node-datachannel/blob/master/API.md#datachannel-class)）。[§3 的属性写法](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:213)必须由适配器分别实现，不能共享原生对象调用。

- **[should-fix] “只内联 JS，再下载一个 `.node`”尚不足以描述 node-datachannel 的加载方式。** 0.33.1 主包依赖 `detect-libc`，平台二进制通过多个 `optionalDependencies` 包提供，并声明 Node ≥18.20、N-API 8（[0.33.1 package.json](https://raw.githubusercontent.com/murat-dogan/node-datachannel/v0.33.1/package.json)）。设计需要明确改写后的 binding loader 如何从 `<installDir>/native/` 加载 addon、`detect-libc` 是否内联、addon tarball 的内部路径和 Bun N-API 验证；仅“解出 `.node`”不足以保证上游 JS 能找到它。

- **[should-fix] 响应白名单会破坏当前 PDF 预览。** `application/pdf` 不在白名单，会被改成下载；当前前端却在 iframe 中预览 PDF（[FilePage.tsx:128](/Users/konata/code/tmex-enhanced/apps/fe/src/pages/FilePage.tsx:128)）。若这是有意禁用远端 PDF 预览，应写明；若要保留，必须使用 sandboxed、独立 origin 的 viewer，不能简单把 PDF 加回同源白名单。

v1 的 Bun `crypto.sign('ed25519', ...)` blocker 已消失：v3 改用 `@noble/curves`。若实现中仍使用 Bun `node:crypto`，Bun 1.3.14 与 Node 一样要求 `sign(null, ...)` / `verify(null, ...)`（[Node crypto 官方示例](https://nodejs.org/api/crypto.html)）。`hash-wasm` 官方声明支持浏览器、Node 和 Deno，但未把 Bun 列为正式目标；v3 将跨浏览器/Bun 测试向量列为待验证项是必要的，而不是可省略测试。

# 3. Design gaps that would break implementation

v1 blocker 中，独立 bulk 协议、`GatewaySession/Carrier`、`dispatchHttp`、请求头过滤、角色启动矩阵、路由优先级、per-node `AppRuntime`、native 的 libc 映射均已在 v3 中得到设计层修正。当前源码仍是 Bun-bound `handleRequest(req, bunServer)`（[runtime.ts:35](/Users/konata/code/tmex-enhanced/apps/gateway/src/runtime.ts:35)），且 WS 状态仍以 socket 为 Map key（[ws/index.ts:82](/Users/konata/code/tmex-enhanced/apps/gateway/src/ws/index.ts:82)），所以这些明确是待实现重构，不是当前代码事实错误。

- **[blocker] passkey 注册流程没有定义。** “注册记录由根钥签名后广播”不能替代 WebAuthn registration ceremony。缺少：

  - registration options/challenge 由谁生成并保存；
  - `expectedOrigin`、RP ID、user handle、UV/UP 要求；
  - `verifyRegistrationResponse()`；
  - credential public key、counter、transports、backup flags 的提取；
  - 根钥签名究竟覆盖哪些验证结果；
  - passkey-only 会话能否添加/删除 passkey；
  - 多 node 并行 assertion 的 counter 更新和冲突规则。

- **[blocker] 载体切回只恢复输出，不定义浏览器→node 的交付语义。** [切换屏障](/Users/konata/code/tmex-enhanced/docs/hub/2026082700-hub-node-architecture.md:188)解决了初次 cutover 的顺序，但 direct 突然断开时：

  - 已发送但未确认的终端输入可能丢失或重复；
  - agent、settings、tmux mutation 等非终端命令没有 replay/cursor；
  - `LIVE_RESUME` / `TERM_HISTORY` 只修复输出；
  - 当前 Borsh `seq` 仍只是透传，没有连续性或去重校验（[protocol-dispatcher.ts:50](/Users/konata/code/tmex-enhanced/packages/ws-client/src/protocol-dispatcher.ts:50)、[gateway ws:316](/Users/konata/code/tmex-enhanced/apps/gateway/src/ws/index.ts:316)）。

  需要 session-wide message ID、ACK、幂等规则和失败边界，或者取消整个 WS 的载体切换。

- **[should-fix] HTTP mux 缺少双向 half-close 语义。** 单个 `END` 未说明是“请求体结束但等待响应”，还是关闭整个双向 stream；也未定义目标提前响应、entry 取消响应体、RST 与 Request/Response stream cancel 的竞态。当前文件传输确实依赖取消来终止 rsync 和清理临时文件（[files.ts:288](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/files.ts:288)、[files.ts:408](/Users/konata/code/tmex-enhanced/apps/gateway/src/api/files.ts:408)）。应定义每方向独立 FIN、RST 的传播规则，以及 HEAD/DATA 的精确编码。

- **[should-fix] 密码/KDF 与签名的规范编码不足。** 需要固定：

  - 密码 UTF-8 与 Unicode normalization 规则；
  - `hash-wasm` 的 `memorySize=65536` KiB、输出类型和 Argon2 版本；
  - seed、公私钥、COSE/X25519 key 的字节序列化；
  - HKDF hash、salt、info 和输出长度；
  - 所有签名对象的 canonical encoding。

  否则浏览器和 CLI/Bun 很容易派生不同根钥或签署不同字节。

- **[blocker] “hub 不可达时 LAN peers 仍工作”的保证依赖未定义的地址稳定性。** 设计删除 mDNS，只使用 `peer_cache.endpoints_json`。若 hub 停机期间 DHCP、Wi-Fi、VPN 或 IPv6 地址变化，节点无法重新发现彼此。必须明确验收是否只要求“缓存地址仍有效时可工作”；若要求网络变化后也自动恢复，就需要受认证的 LAN discovery、静态主机配置或其他本地寻址机制。

- **[should-fix] `TMEX_PUBLIC_URL` 无法表达同一 node 的多个 WebAuthn origin。** 同一 node 可能从 localhost、LAN 域名和 Cloudflare 域名访问；RP ID 不含端口，但 `expectedOrigin` 包含 scheme、host、port。设计需要明确每个 credential 绑定哪个精确 origin、如何注册多个 origin，以及当前访问 origin 如何选择可用 credential。

# 4. Over-engineering

- **[should-fix] 可以删除浏览器→目标 node 的第二条 WebRTC 载体，而不削弱已声明的 mesh 硬要求。** 硬要求是 node↔node 直连并以 hub relay 兜底；浏览器仍可连接 entry，由 entry 通过 node↔node DataChannel 直达目标。这样仍满足每个 node 都是入口、LAN 低延迟和 hub 离线互通，同时可以删除：

  - 浏览器↔目标 PeerConnection；
  - `rtc/authorize` bearer nonce；
  - `DirectCarrierController`；
  - 双载体切换屏障和失败重放；
  - 浏览器 direct 专用 `bulk:*`；
  - 一整套浏览器侧 ICE 诊断和第二枚路径徽标。

  文件上传现有的 8 MiB HTTP PUT 可以被 mux 拆成有界 DATA 帧，下载继续走流和取消，不需要另建浏览器 bulk 协议。只有产品另有“浏览器必须绕过 entry 直达目标”的延迟指标时，这个简化才会削弱需求。

- **[nit] 若保留浏览器直连，两套路径徽标和完整 ICE 诊断可延后。** 它们不影响正确性或安全边界；先提供单一实际路径状态和 RTT 即可。删除诊断不会削弱安全要求，但会减少排障信息。

- **[nit] 不应为了简化而删除用户签名的 key log/node certificate。** TOFU、hub 签名目录或仅 TLS 保护都会重新让 hub 成为信任根，直接削弱“hub 失陷不波及其他机器”的要求。可以用签名 checkpoint 简化新节点启动，但不能删掉端到端签名链。

# 5. Open questions for the product owner

1. node↔node 直连是否已经满足“直连”，还是浏览器也必须绕过 entry 直接连接目标 node？
2. “活跃会话”精确定义是什么；是否接受失陷 entry 在 ticket 有效期内继续操作，若不接受，是否愿意引入独立可信客户端/origin？
3. TOTP 是否必须保留为真正第二因素；若必须，是否接受改为“密码 + passkey”，而不是共享密钥 TOTP？
4. passkey 是要求每个 entry origin 各注册一次，还是可以要求所有 entry 使用同一受控域名/RP ID？
5. hub 离线时的 LAN 互通是否必须在 DHCP、网络接口或 IP 地址变化后仍能自动恢复？