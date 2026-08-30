# G7 结果 — 链路 failover 不再发出瞬时 offline

## 做了什么

`PeerManager.dropPeer()` 原先删掉 live link 后立刻 `onLinkInfo(reach=null)`，随后才 `promoteRetiring` / `activateParked`。mesh-runtime 把 null reach 当成 `offline`，会杀掉远端 agent、UI 闪烁。WebRTC → WS/relay 降级是正常事件，不该离线。

修复：

1. 先提升 retiring / parked fallback（提升期间 hold 住内部的 `emitLinkInfo`，避免升完又发一次）。
2. 按**最终** live 状态发**一次** link info；只有没有 fallback 时才发 `reach=null`。
3. `promoteRetiring` 把被提升链路的 `rttMs` / ping 状态清零，重新 `startPing`（切换传输后 RTT 需重测）。

未改 `mesh-runtime.ts`、`node-event-dedupe.ts`（在源头消掉瞬时 null 即可）。

## 测试

- **(a) DC 断开 + retiring ws-secure**（真实 WebRTC 降级；live=DC 时 `track()` 会拒绝更低优先级 inbound，无法把 ws-secure park 在 DC 下面）：observers 只看到一次 `reach=lan`，中间没有 null；提升后 `rttOf` 为 null。
- **parked inbound**：非 quiesce 的 relay live + parked ws-secure，断开 live 后同样只有一次 `wan`、无 null。
- **(b) 最后一条链路断开**：恰好一次 `reach=null`。

红灯证据（修前）：`(a)` 收到 `[null, "lan"]`；parked 路径收到 `[null, "wan"]`。

## 文件

- `apps/gateway/src/mesh/peer-manager.ts`
- `apps/gateway/src/mesh/peer-manager.test.ts`（3 个新用例）

## 验证

| 项 | 结果 |
|---|---|
| `bun test src/mesh/peer-manager.test.ts src/mesh/peer-manager.upgrade.test.ts` | **67 pass / 0 fail** |
| `bun test src/mesh` | **452 pass / 1 fail**（`stream-targets.test.ts`「mesh-internal path traversal does not skip session auth」— 他组正在改该文件，与 G7 无关） |
| `bunx tsc --noEmit -p .`（apps/gateway） | **29 errors**，G7 文件 **0** 条。基线 21；多出的在 `tunnel/`、`tmux-client/`、`stream-targets.test.ts`、`push/` 等并行改动 |
| `bunx biome check`（上述两个文件） | **clean** |

## 风险 / 未做

- live=DC 且 park ws-secure **不是合法状态**（更低优先级 inbound 直接 reject）。(a) 覆盖的是 DC + **retiring** WS，即升级降级的真实路径。
- `notifyTransport` 仍在提升前调用一次（live 已空）；waiter 只在 transport 匹配时 resolve，不会把瞬时 null 当成失败。未改此顺序。
- 未在 `node-event-dedupe` 做防御性过滤；瞬时 null 已不再发出。
