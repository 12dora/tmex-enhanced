# B3-1-fix 结果 — `apps/gateway/src/mesh/rtc/` 评审修复

worktree：`/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。  
范围仅 `apps/gateway/src/mesh/rtc/**`（未改 `bulk.ts` / `bulk.test.ts`）。公开方法名未改名，仅加法与语义收紧。

## 文件

| 文件 | 改动 |
|---|---|
| `carrier-switch.ts` | SWITCH 发出后立即切出站；ACK 只放行入站缓冲 |
| `dc-handshake.ts` | 握手接收队列 4 KiB / 8 条上限，超限关 PC |
| `rtc-peer-manager.ts` | `acceptBrowser` 只接 authorize 记录；登记上限 + TTL 定时扫；nonce 成功即删；PC 随 carrier/link 关闭 |
| `fragmenter.ts` | 64 KiB **含头**；1 MiB 重组硬顶；违规抛错；定时 sweep；`dispose()` |
| `data-channel-link.ts` | 带 resolver 的发送队列；`send()` 返回 Promise；低水位从失败分片续传；关闭 reject |
| `data-channel-carrier.ts` | 高水位先检查；已开始的帧内部续完；中途失败关载体 |
| `ice.ts` / `native.ts` | TURN → node-datachannel `IceServer`（`hostname/port/username/password/relayType`） |
| `index.ts` | 导出新常量/类型/错误 |
| `test-fakes.ts` | 背压 / 中途失败夹具 |
| `dc-handshake.test.ts` | **新文件** |
| `*.test.ts` / `rtc-loopback.integration.ts` | 对应回归 |

## 条目 → 改动 → 测试

1. **Switch 顺序（blocker）**  
   `attachDirect`：在当前 active（primary）上 `sendControl(CARRIER_SWITCH{to:direct})`，随后立刻 `session.switchActiveCarrier(direct)`。`handleAck` 只清 `pendingTo` 并 flush 入站缓冲。  
   测试：`sends CARRIER_SWITCH on the old carrier then immediately switches outbound to direct`（switch 发送瞬间 active 仍是 primary；随后 X/Y 走出站 direct 且有序；ACK 前入站 A/B 仍缓冲）。旧测试改为 attach 后 `activeCarrier === direct`。

2. **握手预鉴权队列**  
   `DC_HANDSHAKE_MAX_MESSAGE_BYTES = 4096`，`DC_HANDSHAKE_MAX_QUEUE = 8`。超限 / 通道关闭 → `PeerHandshakeError` + `pc.close()` + `channel.close()`。  
   测试：`dc-handshake.test.ts` 三条（>4 KiB、>8 条、通道关闭）。

3. **`acceptBrowser` / 登记生命周期**  
   未知 `rtcSession` 直接拒绝，不再 `ensureBrowser` 建 PC。`RTC_AUTHORIZE_MAX = 64`，满员新授权返回 `null`（刷新已有记录仍可）。`setInterval` 扫 TTL（默认 15 s，可用 `sweepIntervalMs` / `authorizeTtlMs` 注入）。nonce + 指纹成功后从 Map **删除**记录；`carrier.onClose` / `link.onClose` 关对应 PC。`close()` 清 timer + 全部 live PC。  
   测试：未授权拒绝且不新建 PC；64 条上限 + 刷新已有；TTL 定时器关过期 PC；成功后再次 `acceptBrowser` 失败；`carrier.close()` 后 `pc.closed`。  
   **B2-4：必须先 `authorizeBrowser` 再 `acceptBrowser`**（生产路径 HTTP authorize → 信令 accept 本就如此；旧单测曾反过来，已改）。

4. **重组器硬顶**  
   `MAX_REASSEMBLED_FRAME_BYTES = 1 MiB`。`total > ceil(1MiB/payloadMax)`、单片 `> payloadMax`、累计 `> 1 MiB` → `FragmentProtocolError`（dispose 全部 pending）。15 s deadline 用 timer 主动 sweep；`dispose()` 通道关闭时清空。carrier/link 捕获该错误后关通道。  
   测试：total 超限、单片超限、累计超 1 MiB、timer 无需 push 即扫、dispose 后无法凑齐、carrier/link 入站违规关通道。

5. **Link 发送队列**  
   `send(bytes): Promise<void>`，整帧所有分片被 `sendMessageBinary` 接受后才 resolve；`false` 时停在失败分片，`onBufferedAmountLow` 续传；`close` reject 队列。  
   测试：Promise 在低水位前不 resolve；关闭 reject；入站违规关通道。  
   **B2-4：签名从 `void` 变为 `Promise<void>`（仍符合 `ByteTransport`）。**

6. **Carrier 帧原子性**  
   `bufferedAmount > 4 MiB` **或** 有 remainder → 不开始新帧，返回 `backpressure`（`a.sent.length === 0`）。一旦开始，remainder 内部保存，低水位续完后才算该帧结束；中途 `isOpen()===false` → 关载体返回 `closed`（触发 primary 回退），不返回 `backpressure`。  
   测试：高水位不发片；remainder 续完整帧；中途失败 `closed` + `onClose`。

7. **消息尺寸**  
   `DC_MAX_MESSAGE_BYTES = 65536`（**含 8 字节头**）。`FRAGMENT_PAYLOAD_SIZE = 65528`。有效载荷 `min(65528, channel.maxMessageSize() - 8)`；`maxMessageSize < 8` 的通道构造时抛错并 close。  
   测试：满分片总长 65536；65529 字节切 2 片；`fragmentPayloadSize(7)` 抛错；carrier 拒绝过小通道。

8. **TURN IceServer**  
   `{url/urls, username, credential}` → `{hostname, port, username, password, relayType}`。`turns:` → `TurnTls`，`?transport=tcp` → `TurnTcp`，其余 `TurnUdp`。已是 `{hostname, port, ...}` 的原样保留凭证。  
   测试：原先把 TURN 锁成「只留 URL 字符串」的断言已改掉，并覆盖 TLS / TCP / 透传。

## 公开 API 摘要（相对 B3-1 的变化）

```ts
// 常量（FRAGMENT_PAYLOAD_SIZE 名称不变，值变了）
DC_MAX_MESSAGE_BYTES = 65536
FRAGMENT_PAYLOAD_SIZE = 65528          // 原 65536。F3-1 必须对齐
MAX_REASSEMBLED_FRAME_BYTES = 1 << 20
DC_HANDSHAKE_MAX_MESSAGE_BYTES = 4096
DC_HANDSHAKE_MAX_QUEUE = 8
RTC_AUTHORIZE_MAX = 64
RTC_AUTHORIZE_SWEEP_INTERVAL_MS = 15_000

fragmentPayloadSize(maxMessageSize: number): number
class FragmentProtocolError extends Error
parseTurnUri(url: string): IceServer | null
FrameReassembler.dispose(): void
FrameReassembler.push(chunk): Uint8Array | null  // 协议违规改为 throw FragmentProtocolError

DataChannelLink.send(bytes: Uint8Array): Promise<void>  // 原 void

new RtcPeerManager({
  ...,
  authorizeTtlMs?: number,      // 默认 120_000
  authorizeMax?: number,        // 默认 64
  sweepIntervalMs?: number,     // 默认 15_000
})
RtcPeerManager.acceptBrowser(rtcSession, signaling)  // 未知 session 立即 reject
```

`CarrierSwitchController.attachDirect` / `handleAck` 签名不变，语义变：attach 后 node 出站已是 direct。

新增导出类型：`IceServer`、`IceRelayType`。

## 测试 / tsc / biome

`cd apps/gateway && bun test src/mesh/rtc`：

```
 66 pass
 0 fail
 282 expect() calls
Ran 66 tests across 9 files. [518.00ms]
```

（含 B3-2 已提交的 `bulk.test.ts`，本任务未改。）

`bun test ./src/mesh/rtc/rtc-loopback.integration.ts`：`1 pass, 3 skip`（`TMEX_NATIVE_DIR` 未设；无 native 的 carrier-switch 组已按新顺序更新）。

| | 数量 |
|---|---|
| 任务基线 `apps/gateway` tsc | 24 |
| 本次全量 tsc | **23**（rtc 增量 0；非本 scope 少 1 条） |
| `src/mesh/rtc/**` tsc | **0** |
| `bunx biome check apps/gateway/src/mesh/rtc` | **clean** |

## 协调者必须做

### B2-4（接线，API 稳定但语义收紧）

1. **`acceptBrowser` 之前必须已经 `authorizeBrowser`**，未知 session 不再建 PC。mesh-runtime 应保持「HTTP `/api/rtc/authorize` → 信令 `onLocal` → `acceptBrowser`」顺序。
2. `DataChannelLink.send` 现返回 `Promise<void>`。`LinkMux` 已 `Promise.resolve(transport.send())`，可直接用。
3. `attachDirect` 后 `session.activeCarrier` **已经是 direct**；`CARRIER_SWITCH_ACK` 只放行入站，不要再等 ACK 才切出站。
4. 满 64 条未完成授权时 `authorizeBrowser` 返回 `null`（走现有 `DIRECT_UNAVAILABLE` 路径即可）。

### F3-1（浏览器分片必须对齐，本任务不能改 `packages/ws-client`）

浏览器 `packages/ws-client/src/direct/fragmenter.ts` 当前：

```ts
export const FRAGMENT_PAYLOAD_SIZE = 64 * 1024; // 65536 纯载荷
```

node 侧已改为 **64 KiB = 含 8 字节头的整消息上限**，载荷 65528。常量名仍是 `FRAGMENT_PAYLOAD_SIZE`，请 F3-1 改为：

```ts
export const DC_MAX_MESSAGE_BYTES = 64 * 1024;
export const FRAGMENT_PAYLOAD_SIZE = DC_MAX_MESSAGE_BYTES - FRAGMENT_HEADER_SIZE; // 65528
```

并在发送时 `min(FRAGMENT_PAYLOAD_SIZE, channel.maxMessageSize - 8)`，拒绝 `maxMessageSize < 8` 的通道。否则任何 ≥65529 字节的 Borsh 帧会在浏览器首个满分片（65536+8）上发送失败。

浏览器 `DirectDataChannelCarrier.send` 仍有「中片失败返回 backpressure 且不续传」的对等问题，建议 F3-1-fix 按本侧 remainder 语义一起改。

## 未做

- 未改 `bulk.ts`（B3-2）。bulk 仍用自己的 `BULK_FRAME_SIZE = 64 KiB`（无 8 字节分片头，与 sess 协议独立）。
- 未改 `packages/ws-client`（F3-1 对齐见上）。
- 未接线 `mesh-runtime.ts` / `ws/index.ts` / `peer-manager.ts`（B2-4）。
