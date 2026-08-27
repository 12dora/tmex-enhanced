# B2-9 结果 — node-side leftovers

worktree：`/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。对照 `f3-3-result.md` §1、`b2-7-result.md` 未能做 1–3、`b3-1-fix-result.md`。未碰生产 tmex / 名为 `tmex` 的 tmux session。未 `bun install`。未 commit。

## 做了什么

1. **`CARRIER_SWITCH` 绑定 attempt**：`attachDirect(session, carrier, {rtcSession})` 把 attempt id 存进 `SwitchState`；`beginSwitch` / `encodeSwitch` / `sendSwitch` 在 `to:'direct'` 与 `to:'primary'` 都填真实值（拿不到时 `''`）。`handleAck(session, epoch, rtcSession)` 必须 epoch **且** rtcSession 都匹配才排空入站缓冲，陈旧/别的 attempt 的 ACK 丢弃。`ws/index.ts` ACK hook 把解码出的 `rtcSession` 传下去；`mesh-runtime` 在 `acceptBrowser` 成功后 `attachDirect(..., { rtcSession: result.rtcSession })`。去掉 `carrier-switch.ts` 两处 `noConfusingVoidType`（`SendControl` 不再含 `void`）。
2. **`node.list` 信任门前移**：`UplinkClient.ingestNodeList` 在 `upsertPeer` 之前按 `node_certs` 过滤（存在、同 `userId`、未吊销）。未知/跨用户/已吊销节点永不写入 `peer_cache`。
3. **`TMEX_PEER_BIND_HOST`**：`config.parsePeerBindHost` 解析逗号分隔主机，缺省双栈 `::` + `0.0.0.0`；写入 `config.peerBindHost`，经 `MeshRuntimeConfig.peerBindHost` 传到 `PeerServer.hostname`。`opts.peerHostname` 仍优先；字符串会再按逗号拆分（assemble 现有 raw env 仍正确）。
4. **`authorizeBrowser` 的 `sid` 必填**：缺省/空串直接 `null`，不建 PC。`rtc-loopback.integration.ts` 补了 `sid`。

## 文件清单

| 文件 | 作用 |
|---|---|
| `apps/gateway/src/mesh/rtc/carrier-switch.ts` | rtcSession 存储/填充/ACK 双重匹配；去掉 void |
| `apps/gateway/src/mesh/rtc/carrier-switch.test.ts` | SWITCH 携带 rtcSession、ACK 双匹配、跨 attempt 陈旧 ACK |
| `apps/gateway/src/mesh/rtc/rtc-peer-manager.ts` | sid 必填；`AcceptBrowserResult.rtcSession`；透传 attach/ACK |
| `apps/gateway/src/mesh/rtc/rtc-peer-manager.test.ts` | 缺 sid 拒绝；attachDirect 转发 rtcSession |
| `apps/gateway/src/mesh/rtc/rtc-loopback.integration.ts` | authorize 传 sid |
| `apps/gateway/src/ws/index.ts` | ACK hook 第三参 `rtcSession` |
| `apps/gateway/src/mesh/uplink-client.ts` | node.list 过滤后再 upsertPeer |
| `apps/gateway/src/mesh/uplink-client.test.ts` | 未知/跨用户/吊销不入 cache；已 admit 的仍写入 |
| `apps/gateway/src/config.ts` | `parsePeerBindHost` / `DEFAULT_PEER_BIND_HOSTS` / `config.peerBindHost` |
| `apps/gateway/src/config.test.ts` | 缺省双栈、逗号拆分、env 覆盖 |
| `apps/gateway/src/mesh/types.ts` | `PeerBindHost` / `DEFAULT_PEER_BIND_HOSTS` |
| `apps/gateway/src/mesh/peer-server.ts` | hostname 类型 + 默认主机常量 |
| `apps/gateway/src/mesh/peer-server.test.ts` | 默认双栈常量 |
| `apps/gateway/src/mesh/mesh-runtime.ts` | peerBindHost 接线、ACK/attachDirect 透传 rtcSession |
| `apps/gateway/src/mesh/mesh-runtime.test.ts` | `peerBindHost: ['127.0.0.1']` 只绑 IPv4 loopback |

## 公开 API

```ts
export type AttachDirectOptions = { rtcSession?: string }
export type SendControl = (
  session: GatewaySession,
  kind: number,
  payload: Uint8Array
) => ControlSendStatus | Promise<ControlSendStatus>
// 原 `| void` 已去掉

CarrierSwitchController.attachDirect(
  session: GatewaySession,
  carrier: DirectCarrier,
  options?: AttachDirectOptions
): void
CarrierSwitchController.handleAck(
  session: GatewaySession,
  epoch: number,
  rtcSession?: string   // 缺省 ''
): void

RtcPeerManager.authorizeBrowser(input): Promise<RtcAuthorizeBrowserResult | null>
// input.sid 运行时必填（空/缺 → null，不建 PC）；类型仍来自 mesh-deps 的 sid?

RtcPeerManager.attachDirect(
  session: GatewaySession,
  carrier: Carrier,
  options?: AttachDirectOptions
): void
RtcPeerManager.handleCarrierSwitchAck(
  session: GatewaySession,
  epoch: number,
  rtcSession?: string
): void

AcceptBrowserResult {
  carrier, pc, uid, sid, via,
  rtcSession: string
}

WebSocketServer.setOnCarrierSwitchAck(
  handler: ((session: GatewaySession, epoch: number, rtcSession: string) => void) | null
): void

parsePeerBindHost(raw: string | undefined): string[]
DEFAULT_PEER_BIND_HOSTS = ['::', '0.0.0.0']  // config.ts 与 mesh/types.ts 各一份，值相同
config.peerBindHost: string[]

type PeerBindHost = string | string[]
MeshRuntimeConfig.peerBindHost?: PeerBindHost
PeerServerOptions.hostname?: PeerBindHost
```

优先级：`opts.peerHostname` > `config.peerBindHost` > `gatewayConfig.peerBindHost`（env / 缺省双栈）。

## 测试

`cd apps/gateway && bun test`：

```
 1802 pass
 0 fail
 6348 expect() calls
Ran 1802 tests across 208 files. [44.48s]
```

相对任务验收基线 1791：**+11**（carrier-switch 3、rtc-peer-manager 2、uplink-client 1、config 3、mesh-runtime 1、peer-server 1）。208 files 不变（只往现有测试文件加用例）。

`bun test ./src/mesh/rtc/rtc-loopback.integration.ts`：`1 pass, 3 skip`（`TMEX_NATIVE_DIR` 未设；无 native 的 carrier-switch 组已带 `sid` / `return 'sent'`）。

## tsc / biome

| | 基线 | 本次 |
|---|---|---|
| gateway tsc | 23 | **23**（owned 文件 0 新增；未升） |
| biome 范围 15 文件 | | **clean** |

## 未能做 / 协调者必须做

1. **`packages/app/src/runtime/assemble.ts`（范围外）** 仍写 `peerHostname: process.env.TMEX_PEER_BIND_HOST?.trim()`。mesh-runtime 会对字符串再按逗号拆分，现网行为已正确；建议改为 `peerBindHost: gatewayConfig.peerBindHost` 并去掉 raw env 读取。
2. **`apps/gateway/src/mesh/mesh-deps.ts`（范围外）** `RtcAuthorizeBrowserInput.sid?` 仍可选。运行时已拒绝缺/空 sid；类型应收成必填，与 `mesh-routes` 已传 sid 对齐。
3. **`apps/gateway/src/mesh/rtc/index.ts`（范围外）** 未再导出 `AttachDirectOptions`（本任务曾写入后按范围撤回）。需要从 barrel 引用时补一行 type export。
4. `DEFAULT_PEER_BIND_HOSTS` 在 `config.ts` 与 `mesh/types.ts` 各一份（config 不能向下 import mesh）。值相同；若要单一来源，把 config 的那份改成引用共享常量需另开任务。

未碰生产 tmex（9883 / `~/Library/Application Support/tmex/`）、默认 tmux session `tmex`。
