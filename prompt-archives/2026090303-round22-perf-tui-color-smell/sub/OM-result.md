# OM —— WebRTC 直连栈移出首屏（EX5 §0.5 第 3 行 / §8 项 ③）

日期：2026-09-03　　工作区：`/Users/konata/code/tmex-r22`（多 agent 并行，未做任何 git 操作）

## 1. 根因与做法

`packages/ws-client/src/index.ts` 把整棵 `direct/` 从主 barrel re-export，`apps/fe/src/node/node-runtimes.ts`
又静态 `import { BulkClient, DirectCarrierController, registerBulkClient } from '@tmex/ws-client'`，
于是 RTC 栈（含 `bulk-client`）被钉死在入口 chunk 里——而直连只有「WS 已连上 + 目标是远端 node」
时才可能用到。

改法：

1. 新增 `packages/ws-client/src/direct/index.ts` 作为直连栈出口，主 barrel 里 88 行 `direct/*`
   re-export 全部删除（原位留一条注释说明为什么不能 re-export）。
2. `packages/ws-client/package.json` 的 `exports` 增加 `"./direct": "./src/direct/index.ts"`
   （放在 `"./*"` 之前）。
3. `apps/fe/src/node/node-runtimes.ts`：
   - `loadDirectModule()` 按需 `import('@tmex/ws-client/direct')`，模块级缓存 promise；
     失败时清缓存 + `console.warn` 一次（`directLoadLogged`），返回 `null`，连接留在 WS 上，
     **下一次为远端 node 建连时重新 import**。
   - `attachDirectLink()` 在建连的同一帧同步挂好 resume 钩子与诊断占位源，控制器等 chunk 到位后再建。
   - dispose 与加载并发：`connection.dispose` 同步覆写并置 `disposed`，加载完成后若已 dispose
     则**不创建控制器、不登记 bulk**；已创建则 `registerBulkClient(nodeId, null)` + `controller.stop()`
     后再走原始 dispose（顺序与原来一致）。
   - `BorshWebSocketClient` / `createGatewayConnection` 的公开 API 与 options 未动；
     `NodeDirectWiring.createController` 的类型原样保留（只是改为在 chunk 到位后调用），
     新增可选的 `loadDirect?: () => Promise<DirectLinkModule | null>` 测试缝。
   - 新增导出 `directLinkSettled(connection)`（等待本次直连接线落定）。
4. `packages/ws-client/src/direct/types.ts` 新增 `createDeferredDiagnosticsSource()`：
   **这是必须的**。`apps/fe/src/node/direct-diagnostics.ts` 的 `useDirectDiagnostics()` 用
   `useMemo([nodeId])` 只解析一次 `connection.directDiagnostics`，若等 chunk 到了才赋值，
   先挂载的设备页徽标会永远停在桩上（直连/中转徽标失效）。占位源加载期间恒为
   `PRIMARY_ONLY_DIAGNOSTICS`，`attach()` 后转发真实快照并唤醒既有订阅者。
   `types.ts` 是无依赖叶子模块（已被 `@tmex/ws-client/direct/types` 静态引用），不会把 RTC 栈拽回首屏。
5. `packages/panels/src/files/bulk-transfer.ts`：`getBulkClient` 的 import 从主 barrel 改为
   `@tmex/ws-client/direct/bulk-client`（同一模块实例，`registerBulkClient` 写、`getBulkClient` 读不会分叉）。
   `apps/fe/src/node/{direct-diagnostics.ts, device-node-badges.tsx}` 本来就走 `@tmex/ws-client/direct/types`
   子路径，无需改动。

`packages/shared/src/net/dial-breaker.ts` 与 `direct-dial-breaker` 的熔断语义**一行未改**。

## 2. 体积实测（A/B，同一棵工作区，只改「静态 vs 懒加载」这一个变量）

并行 agent 一直在改同一个 worktree，所以没有用「改动前的旧构建」当基线，而是把
`loadDirectModule()` 临时改成返回一份静态 `import * as` 的直连栈（等价于改动前的静态图），
连跑两次 `bunx vite build --outDir …`，测完立刻还原：

| | 入口 chunk raw | 入口 chunk gzip |
| --- | ---: | ---: |
| 静态（改动前语义） | 991,634 | **304,145** |
| 懒加载（改动后） | 948,339 | **291,374** |
| Δ | −43,295 | **−12,771（−4.20%）** |

新增的两个懒加载 chunk：

| chunk | raw | gzip |
| --- | ---: | ---: |
| `assets/index-*.js`（直连控制器 + carrier + fragmenter + ice-stats + fingerprint + breaker） | 27,523 | **8,631** |
| `assets/bulk-client-*.js`（与文件面板共享） | 16,441 | **5,176** |

比 EX5 §0.5 的 −17,391 少约 4.6 KB：EX5 是在 1.1.21 基线上用 `manualChunks` 强切，
本轮工作区已被其他 agent 的精简改动（入口 gzip 已从 347.6 KB 降到 ~304 KB）挪动了共享模块的
归属，`@tmex/shared/link` 之类的公共依赖不再全部计在直连这一侧。−12,771 gz 是本改动**单独**
可归因的硬数字。

（附：本次会话开始时 `dist` 的入口是 304 KB gz，与上表「静态」一栏一致，交叉印证。）

## 3. 测试

`packages/ws-client/src/direct/types.test.ts`（新增 4 个用例）：占位源加载前恒为 primary
且引用稳定、`attach()` 后转发快照并唤醒加载期间的订阅者、`attach(null)` 退订回落、
`resolveDirectDiagnostics` 能取到它。

`apps/fe/src/node/node-runtimes.test.ts`（新增 3 个用例，改造若干）：

- self / 空 nodeId **完全不触发** `loadDirect`（spy 计数为 0）——懒加载只发生在远端 node。
- 远端 node：加载完成前控制器未建、诊断源已可订阅；`await directLinkSettled()` 后
  `loadDirect` 恰好调用 1 次、控制器 `start()`、诊断源转发到控制器快照。
- 加载前挂上的订阅者在控制器就位后收到通知，后续 `emit` 继续透传，dispose 后回落 primary。
- **加载途中 dispose**：控制器不再创建、`registerBulkClient` 零调用、`getBulkClient` 为 null、
  resume 钩子已摘（无悬挂 carrier）。
- **加载失败**：连接照常可用、无 bulk 登记、诊断回落 primary、`dispose()` 不抛；
  **下一次建连重新加载**（`loads` 从 1 涨到 2）并成功建控制器。

调整过的既有断言（等价替换，未削弱）：

- `expect(connection.directDiagnostics).toBe(controller.diagnosticsSource)`
  → `expect(resolveDirectDiagnostics(connection).get()).toBe(controller.diagSnapshot)`
  （中间多了一层占位源，断言的是可观察契约，并补了订阅转发断言）。
- 控制器工厂返回 null 的用例：`expect(connection.directDiagnostics).toBeNull()`
  → `expect(resolveDirectDiagnostics(connection).get()).toBe(PRIMARY_ONLY_DIAGNOSTICS)`
  （`directDiagnostics` 现在恒挂占位源；语义与桩一致）。
- 涉及控制器的用例加 `await directLinkSettled(connection)`；resume 钩子相关用例不需要 await
  （钩子仍是同步挂的），只补了 `loadDirect` 桩避免多余加载。

结果：

| 套件 | 基线 | 改动后 |
| --- | ---: | ---: |
| `packages/ws-client` `bun test` | 394 pass / 0 fail | **398 pass / 0 fail** |
| `apps/fe` `bun test src/` | — | **1762 pass / 0 fail** |
| `packages/panels` `bun test src/files` | — | **105 pass / 0 fail** |
| `packages/stores` `bun test` | — | **440 pass / 0 fail** |

`bunx tsc --noEmit -p .`：`packages/ws-client` 与 `apps/fe` 均**只剩不属于本任务的 1 条错误**
（`apps/gateway/src/tmux-client/pane-stream/osc-handlers.ts` 的 `utf8Decoder`、
`packages/ghostty-terminal/src/canvas-renderer.ts` 的 `GhosttyColorRgb`，都是并行 agent 正在改的文件；
后者在我测基线时就已存在）。本任务相关文件零错误。

`bunx biome check`（8 个改动文件）：clean。`bun scripts/complexity/gate.ts`：`complexity gate ok (1292 files, 11915 functions)`。

未跑 e2e（按要求）。

## 4. 改动文件

- `packages/ws-client/src/index.ts`（删 88 行 direct re-export）
- `packages/ws-client/src/direct/index.ts`（新增）
- `packages/ws-client/src/direct/types.ts`（新增 `createDeferredDiagnosticsSource`）
- `packages/ws-client/src/direct/types.test.ts`（新增）
- `packages/ws-client/package.json`（`exports` 加 `./direct`）
- `apps/fe/src/node/node-runtimes.ts`
- `apps/fe/src/node/node-runtimes.test.ts`
- `packages/panels/src/files/bulk-transfer.ts`（仅 import 行）

## 5. 注意事项 / 遗留

- **chunk 404 的重试是尽力而为**：浏览器 module map 会记住失败的模块，同一文档内再次
  `import()` 同一 specifier 未必重新发请求。代码层面已做到「不缓存失败、下次建连重试」，
  最坏情况也只是继续走 WS（功能不降级，只是没有直连加速）。
- 直连建立比改动前晚一次 `import()` 往返（局域网内几毫秒，且发生在 WS 已可用之后），
  首屏与终端可用性不受影响。
- `directLinkSettled()` 目前只有测试在用；它是接线落定的正式出口，比让测试去 `await`
  若干个微任务更可靠，故保留为导出。
- `apps/fe/src/i18n/core-coverage.test.tsx` 的静态 import 图会因本改动变小（遇 `import()` 即止步），
  属保守方向，无需调整。
