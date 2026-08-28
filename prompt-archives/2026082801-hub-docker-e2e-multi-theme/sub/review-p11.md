结论：**Request changes。** 6 个旧 finding 均已关闭，但发现 1 个新增 P1。

## Findings

1. **P1 — 未认证 uplink 可绕过 CTL 64 KiB 上限，造成 hub 内存/CPU DoS。**  
   [uplink-protocol.ts:185](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-protocol.ts:185)、[uplink-server.ts:382](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-server.ts:382)、[uplink-server.ts:525](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-server.ts:525)

   新 decoder 对 `key.log.res` 放宽到 1 MiB，并跳过通用字符串/深度限制；但 hub 在认证前也用该 decoder，且只在完整解码后才检查连接是否已认证。攻击者无需证书即可连接 `/hub/uplink`，反复发送带大 `pad` 字段的 `{"t":"key.log.res","records":[]}`。消息会进入持有原始字节的 Promise 队列，解析后才被静默忽略；CTL 又立即返还 WINDOW，可持续堆积并耗尽 hub 内存或事件循环。

   实测 decoder 接受 **1,048,576 字节**该消息，旧上限为 **65,536 字节**。

   修复建议：hub 入站按方向拒绝 `key.log.res`；认证前仅允许 `auth.response`，始终保留 64 KiB 上限。1 MiB 特例只应用于 node 接收、且存在匹配 pending request 的响应，并为 CTL 处理队列增加有界背压。

## 旧 finding 关闭状态

| # | 状态 |
|---|---|
| 1 撤销后提升 parked 链 | 已关闭 |
| 2 parked OPEN/CTL 无界堆积 | 已关闭 |
| 3 key-log 无分页及 O(N²) 峰值内存 | 已关闭 |
| 4 NODE_EVENT optional 被改成 false | 已关闭 |
| 5 overflow 节点互相饿死 | 已关闭 |
| 6 send rejection 未关闭 transport | 已关闭 |

self-entry auth 修复未见可利用绕过：只有 challenge 已记录为 `self` 时才接受目标真实 node id；转发 challenge 的 `entryNodeId` 来自可信 peer dispatch context，因此另一 entry 提交目标自身 id 会得到 `ENTRY_MISMATCH`。

验证：相关 7 个测试文件 **151 pass / 0 fail**；auth 回归用例 **1 pass / 0 fail**。