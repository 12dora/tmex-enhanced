# E2E-2：两条本轮回归

## 结论

两条都已跑绿，**未改用例、未回退本轮性能改动**（键盘 follow 循环收敛退出、viewport 按窗口仲裁都保留）。

| 用例 | 判断 | 处理 |
|---|---|---|
| `mobile-keyboard-avoidance:246` | **协议观察失效**：键盘避让仍收缩 `<main>` 并触发上报，但 canonical 把 `TERM_RESIZE` 收成 `KIND_CANONICAL_COMMAND`，计数器看到 0，15 s poll 超时 | 传输层把尺寸命令留在 legacy 控制面 |
| `ws-borsh-resize:268` | **协议观察失效**：焦点恢复仍走 `onSync`，但 `terminal-sync-size` 同样被收成 `ResizePane`，`counts.sync === 0` | 同上，保留 `TERM_SYNC_SIZE` vs `TERM_RESIZE` 区分 |

嫌疑 1（follow 循环提前 park）和嫌疑 2（viewport 按窗口仲裁）都不是根因：resize 模式本来就不走 follow 循环；客户端发出的 kind 在进网关之前就被换掉了。

## 根因

CAN 默认开启后，`WebSocketGatewayTransport.sendReadyCommand` 把 `terminal-resize` / `terminal-sync-size` 都交给 `CanonicalStateClient`，编成一条 `ResizePane`（`KIND_CANONICAL_COMMAND`）。

网关侧两条路径最终都进 `handleTermResize`（viewport 仲裁），**产品侧尺寸应用没坏**。但：

- canonical schema 没有「补一次尺寸」与「用户/容器改尺寸」的区分；
- e2e（以及产品契约）用线协议 kind 观察这一点：焦点恢复必须是 `TERM_SYNC_SIZE` 且 `TERM_RESIZE === 0`；键盘 resize 模式必须看到 `TERM_RESIZE`/`TERM_SYNC_SIZE`。

main 上没有这条拦截，所以同样的用例在 main 通过。

## 修复

`packages/ws-client/src/websocket-transport.ts`：canonical 模式下 **不拦截** 这两条命令，仍走 `encodeGatewayTransportCommand` → `KIND_TERM_RESIZE` / `KIND_TERM_SYNC_SIZE`。

- 网关行为不变（legacy handler 本来就是 `handleTermResize`）。
- `CanonicalStateClient` 仍保留 `ResizePane` 映射，供单测 / roundtrip 直接调用；生产 FE 只走 transport。
- 与 CAN 已有约定一致：没有 canonical 等价物的控制命令（viewport、选窗、布局等）继续走 legacy。

单测：`websocket-canonical-gate.test.ts` 锁住 canonical 协商完成后这两条仍发 legacy kind。

## 验证

定向 e2e（`TMEX_MESH_E2E_BUILD_FE=1`）：

```
✓ mobile keyboard mode "resize": shrink available height and resize terminal (3.5s)
✓ ws-borsh: focus restore resyncs one stale terminal without reintroducing resize loop (3.6s)
2 passed (12.0s)
```

全量 e2e：`104 passed / 9 failed / 1 skipped`（本轮基线 103 pass / 10 fail；这两条已从失败集拿掉）。

失败集相对允许的 8 条既有项：

| 用例 | 本轮 |
|---|---|
| `mobile-terminal-interactions:82/150` | 仍失败（既有） |
| `terminal-mouse-recovery:315/359/411` | 仍失败（既有） |
| `terminal-render-regressions:241` | 仍失败（负载敏感，既有） |
| `viewport-policy:77/128` | 仍失败（main 上同样失败） |
| `split-screen-desktop:61` | **全量时失败、定向复跑通过（3.7s）**。断言是 gutter 线 `width > 0`，与尺寸 kind 无关，判定为负载敏感 flake |

单测 / 类型 / 门禁：

| 检查 | 结果 |
|---|---|
| `packages/ws-client && bun test` | 382 pass |
| `packages/terminal-ui && bun test` | 379 pass |
| `packages/ghostty-terminal && bun test` | 278 pass |
| `packages/panels && bun test` | 786 pass |
| `apps/fe && bun test src/` | 1744 pass |
| gateway `viewport-policy` / `viewport-claims` / `tmux-command-handlers` | 47 pass |
| `tsc --noEmit` | ws-client / terminal-ui / ghostty-terminal / panels / fe 均为 0 |
| `bunx biome check` 改动文件 | pass |
| `bun scripts/complexity/gate.ts` | ok（未改 allowlist） |

未碰生产 tmex、未碰名为 `tmex` 的 tmux session、未回退键盘 follow 循环或 viewport 按窗口仲裁。

## 改动文件

- `packages/ws-client/src/websocket-transport.ts`
- `packages/ws-client/src/websocket-canonical-gate.test.ts`
