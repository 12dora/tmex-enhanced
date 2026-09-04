# G5 结果 — 接线 messaging runtime hooks

## 做了什么

命令层的 `registerMessagingRuntime` 现在注入真实实现：tmux 快照 / capture-pane / sendKeys、确认项走 `AgentSupervisor.resolveConfirmation`（与 HTTP decide 同路，会广播 WS）、上行状态与 mesh 节点在线标记按 `/api/mesh/nodes` 同源公式计算。

`startLiveGatewayServices()` 在 Telegram/微信 refresh **之前**注册全部 hooks。relay-only 仍跳过 telegram / weixin / watch / online（G1b 门控不变），但 hooks 仍注册（无害；命令通道本来不会拉起）。

mesh 侧不改 `assemble.ts`：`createMeshRuntime` 通过 `setMessagingMeshRuntime(() => runtime)` 把活实例交给 hooks，`stop` 时清掉。gateway 启动早于 mesh，hooks **调用时**再读 accessor，命令到达时 mesh 已装配。

## 文件

### 新增
- `apps/gateway/src/messaging/runtime-hooks.ts`：六只 hook 的网关实现 + `setMessagingMeshRuntime` accessor
- `apps/gateway/src/messaging/runtime-hooks.test.ts`：各 hook 单测（假快照 / capture 去尾空行 / sendKeys 字面量 / confirmation 路由 supervisor / 各角色 uplink / 节点在线标记）

### 修改
- `apps/gateway/src/runtime.ts`：`startLiveGatewayServices` 注册 hooks；`stop` 时 `resetMessagingRuntime` + 清 mesh accessor
- `apps/gateway/src/runtime.test.ts`：启动时 hooks 已注册（telegram refresh 之前）；relay-only 仍 skip 消息通道
- `apps/gateway/src/mesh/mesh-runtime.ts`：装配时 `setMessagingMeshRuntime`，stop 时清空

未改：`context.ts` / handlers 签名、`assemble.ts`、`hub/**`、`relay/**`、`mesh/relay-routes.ts`。

## 实现要点

| Hook | 行为 |
|---|---|
| `getDeviceTree` | `getDeviceSnapshot`（与 WS lastSnapshot / 设备树同源）；无 session → `null` |
| `capturePane` | 已连接设备的 `tmuxRuntimeRegistry` runtime → `capturePaneText({ historyLines })`（底层 `capture-pane -p -t … -S -<n>`），去掉尾部空行 |
| `sendKeys` | 与 canonical `TerminalInput` 相同：`runtime.sendInputBytes(paneId, utf8(text))`，不做按键名解释。`handleRun` 已把 `\r` 拼进 `text`，hook 不再追加 |
| `decideConfirmation` | `agentSupervisor.resolveConfirmation`；`NotFound` / `AlreadyDecided` 映射为 `{ ok: false, code }` |
| `getUplinkStatus` | standalone → `{ kind: 'none', attached: false }`；否则 `node_identity.uplinkKind` 或角色推断；`attached` = uplink `online` / `attachedHub()` / 本机就是 Hub |
| `listMeshNodes` | 在线公式与 `MeshRoutes.collectNodes` 一致：`self \|\| hubOnline(lastNodeList) \|\| isPeerReachable(reach)` |

未持有设备连接时 capture/sendKeys 抛错，handlers 已捕获为 `captureFailed` / `sendFailed`。

## 验证

```
cd apps/gateway && bun test src/messaging src/runtime src/agent
# 383 pass / 0 fail（44 files）

cd apps/gateway && bun test src/mesh/mesh-runtime.test.ts src/mesh/mesh-runtime-node-presence.test.ts
# 41 pass / 0 fail（accessor 接线未破坏 mesh 装配）

cd apps/gateway && bunx tsc --noEmit -p .
# 仅既有 packages/app/src/lib/native-datachannel.ts TS5097

bunx biome check <本任务文件>     # 通过
bun run lint                      # biome 全仓通过；complexity gate ok
```

## 留给指挥官 / 未决

1. 未改 hook 签名，G1a handlers 测试保持原样。`run` 的 `\r` 仍由 handler 拼接。
2. `listMeshNodes` 未直接调用私有的 `MeshRoutes.collectNodes`（`mesh-routes.ts` 不在范围）；在线标记用同一套 `listHubOnline` + `isPeerReachable` 源。`hubPresenceLive` 未暴露，用 `uplink.state === 'online'` 代替（与 `listHubOnline` 其它条件一致）。
3. capture/sendKeys 走 `tmuxRuntimeRegistry.acquire`（与 WS / watch / agent 共享已有 per-device 连接），不自己对默认 socket spawn tmux。
4. 未跑 live 集成（真实 Telegram/微信打 `windows`/`tail`/`run`/`approve`）；单测覆盖 hook 契约与启动注册。
