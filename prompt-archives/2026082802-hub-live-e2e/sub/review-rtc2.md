# Findings

## Blocker

1. **DataChannel fanout 在握手到 Link 的交接窗口会吞消息和关闭事件。**  
   位置：[channel-fanout.ts:20](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/channel-fanout.ts:20)、[channel-fanout.ts:46](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/channel-fanout.ts:46)、[rtc-peer-manager.ts:291](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:291)、[dc-handshake.ts:146](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/dc-handshake.ts:146)

   `handshakeDataChannel()` 的 message/closed 监听器永不注销，`stop()` 只是令其忽略消息。只要 `message.length > 0`，fanout 就不会缓存新消息。因此一侧先完成握手并返回 `getLink()`、另一侧尚未构造 `DataChannelLink` 时：

   - 立即发送的 LinkMux/open frame 会被仍活跃的握手解析器误当 JSON，导致握手失败；或被已停止的握手监听器静默丢弃。
   - 此窗口发生 close 时，后注册的 `DataChannelLink.onClosed` 不会补收到事件，可能返回一个已经关闭但内部仍标记为可用的 link。

   我用当前 helper 复现得到 `{"linkMessages":0,"linkClosed":0,"isOpen":false}`。新增测试只在 link 完全接线后才 close，因此绕过了该竞态。原生库确实是单回调模型，见 [data-channel-wrapper.cpp:335](/Users/konata/code/tmex-enhanced-wt-merge/node_modules/.bun/node-datachannel@0.33.1/node_modules/node-datachannel/src/cpp/data-channel-wrapper.cpp:335) 和 [data-channel-wrapper.cpp:501](/Users/konata/code/tmex-enhanced-wt-merge/node_modules/.bun/node-datachannel@0.33.1/node_modules/node-datachannel/src/cpp/data-channel-wrapper.cpp:501)，但当前 fanout 仍未完成可靠交接。

## Should-fix

2. **接收侧冷却仍可被无效 wake 和连接关闭绕过。**  
   位置：[peer-manager.ts:742](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:742)、[peer-manager.ts:772](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:772)、[peer-manager.ts:1646](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:1646)

   `nextEligibleAt` 只在验签和 offerer 检查全部成功后更新。失陷 hub 可持续注入声称来自可信 peer 的坏签名 wake，每条都会重新 JSON 解析、解码证书并执行 Ed25519 验签；`rtcLogRateLimited` 只限制日志，不限制处理成本。另一个绕过是 `dropPeer()` 删除接收冷却：恶意已 admit 节点可建立 DC、立即关闭、立刻再次发送有效 wake，反复制造 PeerConnection churn。Finding 2 未真正修完。

3. **全局 256 项 nonce FIFO 无法覆盖按 peer 的完整重放窗口。**  
   位置：[peer-manager.ts:289](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:289)、[peer-manager.ts:793](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:793)、[peer-manager.ts:807](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:807)

   缓存由所有 peer 共享，而时间检查允许 `issued_at` 在未来 60 秒：一个恰好快 60 秒的 wake 从首次接收起还能再有效 120 秒。11 个 peer 按 5 秒冷却发送有效 wake，120 秒内即可写入超过 256 个 nonce，驱逐原 nonce；随后重放原签名 wake仍会通过。缓存应按 peer 隔离，并按签名有效期保存，而不是全局按容量淘汰。

4. **接收端没有验证 nonce 是规范的 16 字节 base64url。**  
   位置：[ice.ts:265](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/ice.ts:265)、[ice.ts:272](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/ice.ts:272)

   发送端生成 16 字节 nonce，但解析端接受任意字符串。恶意已 admit 节点可以签署接近 64 KiB 控制帧上限的 nonce，并让最多 256 个大字符串常驻缓存；也破坏了协议的规范编码约束。应解码并严格检查长度与规范 base64url 表示。

5. **压缩 IPv6 的脱敏仍会暴露 host hextet。**  
   位置：[ice.ts:336](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/ice.ts:336)

   实测：

   ```text
   [2001:db8::dead:beef]:3478 -> [2001:db8:dead::]:3478
   2001:db8::1                 -> 2001:db8:1::
   ::1                         -> 1::
   ```

   代码在展开 `::` 前先过滤空段，因此把 host 部分误当成前三个网络 hextet。Selected-pair 日志仍会泄露地址后缀并记录错误前缀。原始 IPv4-mapped finding 已修复，但新增的 bracketed/compressed IPv6 支持不完整。

## Nit

6. **集成测试的 revoked 分支没有走 authenticated uplink/hub。**  
   位置：[rtc-wake.integration.test.ts:297](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/integration/rtc-wake.integration.test.ts:297)、[rtc-wake.integration.test.ts:299](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/integration/rtc-wake.integration.test.ts:299)

   unsigned、wrong-key、spoofed-from 和成功路径走真实 in-process authenticated hub；revoked case 则直接调用 `receiveRtcSignal()`。因此该子场景无法发现 hub 对已建立但刚被吊销的 uplink 路由回归。不过测试整体不是真空通过：唯一成功拨号从较大 ID 单侧发起，必须依赖签名 wake 经 hub 到达较小 ID，才能让双方变为 `dc`。

# 原 8 条结论

| Finding | 结论 |
|---|---|
| 1. Wake 端到端认证 | **部分修复。** Domain 固定为 `tmex-rtc-wake`，固定字段顺序的 JSON 字节同时用于签名和验签，字段篡改会失败；但 nonce 格式及重放缓存范围仍有上述缺口。 |
| 2. 接收限速和 offerer 校验 | **部分修复。** Offerer 校验正确；有效 wake 的正常冷却有效，但无效 wake 和 drop 后重试可绕过。 |
| 3. 冷却后延迟补发 | **已修复。** 补发会在 cooldown 到期执行，DC 到达、拨号结束和 stop 都会取消；未发现 stop 后残留定时器。 |
| 4. stop 返回 false | **已修复。** waiter closure 正确传递布尔值。 |
| 5. waiter timeout/revoke 清理 | **已修复。** 提前成功、stop、revoke 都会 abort timeout 并立即结算。 |
| 6. 单回调 fanout | **未完整修复。** 原生 callback 覆盖问题解决，但引入/保留了上述握手到 link 的事件交接 blocker。 |
| 7. IPv4-mapped 脱敏 | **原场景已修复。** 普通及 bracketed IPv4-mapped 地址正确；压缩 IPv6 仍错误。 |
| 8. 真实 hub 集成测试 | **基本修复。** 正常与多数伪造路径真实经过 hub，成功路径不可能真空通过；revoked 子场景仍是直接注入。 |

# 验证

- 相关 RTC、ICE、authenticated-uplink 测试：22 pass，0 fail。
- 新增 PeerManager 定向用例：10 pass，0 fail。
- 更大范围选定测试：45 pass，6 fail；6 个失败均因只读沙箱禁止 `Bun.serve()` 监听端口。
- `tsc --noEmit` 当前为 20 个既有错误，没有 RTC 相关错误。
- 当前 `HEAD` 的 TURN harness 提交未改变上述后端代码。