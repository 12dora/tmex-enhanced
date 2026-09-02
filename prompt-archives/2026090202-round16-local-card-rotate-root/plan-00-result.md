# 第十六轮执行结果：本机卡片多 hub 显示 + 常规改密保留凭据（v1.1.16）

## 交付

| 需求 | 结果 |
|---|---|
| 本机卡片不能正确显示多 hub | 「当前 Hub」（名称 + 主/备 + 公开地址；主备不一致时附「写者：…」；本机即写者时显示「本机」）、「Hub 列表」（≥2 台，写者优先，含离线标记）、种子地址改为「加入地址」（保留「更换 Hub」）。 |
| 改密不影响 passkey/TOTP | 新记录类型 `rotate-root-keep`（旧根签名；payload 带新根公钥、新 KDF、可选的 TOTP 重封装 `{root_epoch=E+1, seq=record.seq, payload}`）。应用后换根钥/epoch+1，保留 passkey、TOTP（指向本记录）、节点证书、hub 授权，不撤销会话；hub 仍作废未用加入码（已下沉到持久化事务，回放同样生效）。TOTP 启用时 `totp=null` 被拒（关闭仍走 `clear-totp`）。原 `rotate-root` 保留为全量重置。 |
| 主/备任一在线即可改密 | 主 hub 经任一 hub 可达即可（备 hub 转发写入，已有能力）；主 hub 掉线不做本地先改后合并（哈希链不可分叉），界面/CLI 提示「主 Hub 未确认本次修改，结果未知；请恢复连接并刷新状态后再决定是否重试」。不开自动接管。 |
| 前端 | 改密默认常规模式；勾选「同时移除所有通行密钥、两步验证并注销全部会话」（说明：适用于密码可能已泄露的情况）走全量重置；改密成功后两阶段替换会话钥（新登录成功才落盘，失败保留旧会话；TOTP 用户再输一次验证码，可跳过）；`GET /api/auth/totp-record` 只认 404+`TOTP_NOT_ENABLED` 为未启用；用签入记录的 epoch/KDF 重建会话（`/api/auth/mode` 有 5 s 缓存，最多轮询 3 次后回落）。 |
| CLI | `tmex hub user passwd` 默认 keep，`--full-reset` 走原路径；错误映射同前端。 |
| 兼容 | 按记录类型的最低版本表：`admit-hub`/`retire-hub` ≥1.1.13（可 force），`rotate-root-keep` ≥1.1.16（不可 force）；门禁以未吊销证书为准（无 `nodes` 行/版本未知也拦）。 |

## 审查裁决

RV4 后端 3 条（门禁以证书为准、totp-record no-store、加入码失效进事务）全部采纳；RV4 前端 6 条（两阶段替换不提前动持久化、失败路径清零、getTotpRecord 错误语义、用签入值重建会话、HUB_TIMEOUT 文案、TOTP 重登与 e2e 清理）全部采纳。

## 实测（生产，v1.1.16 全网升级后）

- 六节点 1.1.16（本机/A/B `tmex upgrade`，jiefa×2 入口推包，docker-node 手动）。
- 在主 hub B 上 `tmex hub user passwd admin`（keep）：B 写入 seq 9 `rotate-root-keep`；A、本机、jiefa×2、docker-node 数秒内经 `key.log.req` 同步（root_epoch 1→2，根公钥一致）；`node_sessions` 未撤销（改前 37、改后 37/39）、`user_keys` 未动；新密码在 A/B/M 登录成功；再改回原密码（seq 10，epoch 3）同样成功。
- 踩坑：改密后 5 s 内 `/api/auth/mode` 仍可能返回旧 KDF（缓存 TTL），用旧 KDF 派生会得到 `DELEGATION_BAD_SIGNATURE`；前端已轮询处理，脚本需等待或重试。
- 未覆盖：账号未注册 passkey/TOTP，重封装路径只有单测与 e2e（e2e 未执行）。

## 门禁与发版

gateway 3565（5 个负载 flake 隔离复跑 791/0）/ fe 1570 / shared 438 / panels 747 / ui 54 / api-client 142 / stores 419 / app 652（1 个既有 cpu-features 构建前用例）；tsc 0；`bun run lint` 通过。发版 v1.1.16（`d813cd5c`，merge `29d72f19`），Release CI 成功（22.5 MB）。

## 遗留

- jiefa-app 终端延迟突增排查（EX5 诊断进行中，见下一轮档案）。
- 前端 `nodesTooOld` 文案硬编码 1.1.16，与后端常量未联动。
- 海外测试机 2、`replicatedTo` 空数组、大规模 hub 轮询预算仍为遗留。
