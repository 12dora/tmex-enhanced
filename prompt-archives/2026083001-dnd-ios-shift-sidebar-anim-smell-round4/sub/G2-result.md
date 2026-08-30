# G2 结果：跨端重复传输代码

## 结论

Fragmenter 已抽到 `packages/shared/src/link/fragment-core.ts`（浏览器安全、无 `node:*`）。两侧只保留错误类型、出站边界、violation/throw 策略，以及 gateway 的 `setTimeout` 接线。Queued pump **未落地**（试抽后净增行，违反本轮 #1 指标）。

**本 scope 净行数：-60**（目标 -120，未达标；原因见文末）。

## 改动文件

| 文件 | 摘要 |
|------|------|
| `packages/shared/src/link/fragment-core.ts` | **新建**。LE 头（DataView）、`fragmentBytes`、`FragmentAssembler`（重组 / 淘汰 / 超时 / 可选 timer） |
| `packages/shared/src/link/fragment-core.test.ts` | **新建**。钉死头布局 `[frameId u32 LE][idx u16 LE][total u16 LE]` 与分片切分 |
| `packages/shared/src/link/index.ts` | 按现有 `./link` 子路径导出 core 符号 |
| `apps/gateway/src/mesh/rtc/fragmenter.ts` | 薄封装：`FragmentProtocolError`、throw 策略、timer 接线、`fragmentPayloadSize` |
| `packages/ws-client/src/direct/fragmenter.ts` | 薄封装：`FragmentViolation` / `onViolation`、`FragmentBoundsError`、出站越界 |
| `packages/shared/src/link/websocket-link.ts` | 仅删 3 处 JSDoc（行为不变） |
| `apps/gateway/src/mesh/link-stream-carrier.ts` | **未改**（pump 回退） |

## `git diff --stat`（仅本 scope 已跟踪文件）

```
 apps/gateway/src/mesh/rtc/fragmenter.ts     | 237 +++++---------------------
 packages/shared/src/link/index.ts           |  10 ++
 packages/shared/src/link/websocket-link.ts  |   9 -
 packages/ws-client/src/direct/fragmenter.ts | 251 ++++++----------------------
 4 files changed, 102 insertions(+), 405 deletions(-)
```

未跟踪：`fragment-core.ts` 211 行 + `fragment-core.test.ts` 32 行。

## 行数（`wc -l`）

| 文件 | 前 | 后 | Δ |
|------|----|----|---|
| `apps/gateway/src/mesh/rtc/fragmenter.ts` | 241 | 88 | -153 |
| `packages/ws-client/src/direct/fragmenter.ts` | 267 | 116 | -151 |
| `apps/gateway/src/mesh/link-stream-carrier.ts` | 132 | 132 | 0 |
| `packages/shared/src/link/websocket-link.ts` | 287 | 278 | -9 |
| `packages/shared/src/link/index.ts` | 68 | 78 | +10 |
| `packages/shared/src/link/fragment-core.ts` | 0 | 211 | +211 |
| `packages/shared/src/link/fragment-core.test.ts` | 0 | 32 | +32 |
| **合计** | **995** | **935** | **-60** |

已跟踪 diff：+102 / -405；加上新文件 +243 → 净 **-60**。

## 测试 / tsc / biome

**开始前（本会话基线）**

| 包 | bun test | tsc --noEmit |
|----|----------|----------------|
| `apps/gateway` | 2482 pass / 0 fail | 21 errors |
| `packages/shared` | 358 pass | 0 |
| `packages/ws-client` | 261 pass | 0 |

**结束后**

| 包 | bun test | tsc --noEmit |
|----|----------|----------------|
| `apps/gateway` | **2497 pass / 0 fail** | **21 errors**（未增加） |
| `packages/shared` | **365 pass / 0 fail** | **0** |
| `packages/ws-client` | **261 pass / 0 fail** | **0** |

gateway / shared 用例数上升来自 **并行 agent** 在其它文件加的测试 + 本任务 2 个 golden 测试。本 scope 相关套件均绿：

- `fragmenter.test.ts`（gateway + ws-client）
- `fragment-core.test.ts`
- `data-channel-carrier.test.ts`（gateway + ws-client）
- `data-channel-link.test.ts`、`dc-handshake.test.ts`
- `link-stream-carrier.test.ts`、`websocket-link.test.ts`

`bunx biome check`（上述 6 个改动文件）：通过。

线格式：core 测试钉死 `frameId=0x01020304` → 头字节 `[0x04, 0x03, 0x02, 0x01, 0, 0, 1, 0]`（与原 ws-client golden 一致）。两侧 `fragmenter.test.ts` 原套件仍通过。

## 修复的 bug

无（未指定、范围内也未发现行为 bug）。

## 刻意跳过

**Queued pump 抽取（`queued-transport.ts`）未合并。**

试过 `createQueuedPump`（约 70 行模块 + 51 行测试）：carrier 只省约 13 行，websocket-link 只省约 26 行（循环体内仍是 server `0/-1`、client 高水位 poll）。合计约 **净增 +80 行**，违反「每次重构必须删多于增」。

两处 pump 不是同一台状态机：

- carrier：`async write` / `end`、pending 字节、drain 回调、`finally` 重入
- websocket：同步 `send`、peek/shift、`paused`/`opened`、client poll

参数化两者会变成 option bag，比原循环更大。已回退，`link-stream-carrier.ts` 保持原样。

仓库里另有 `apps/gateway/src/mesh/stream-pump.ts`（其它 agent，ReadableStream→LinkStream），与本任务的 queue+pumping 重复不是同一段代码，未碰。

**未达标说明：** fragmenter 抽出后生产代码约 -73（508→88+116+211），加上 core 测试 +32、index +10、websocket JSDoc -9，净 -60。策略差异（throw vs `onViolation`、timer、pendingBytes、出站 `FragmentBoundsError`）必须留在两侧，core 的参数化抵消了部分删除。要到 -120 需要 pump 也能净减，但试抽结果相反。
