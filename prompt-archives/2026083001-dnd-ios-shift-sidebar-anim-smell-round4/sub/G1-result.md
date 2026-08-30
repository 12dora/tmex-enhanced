# G1 结果：去重 mesh/hub uplink 协议编解码

## 做了什么

把 `apps/gateway/src/mesh/uplink-protocol.ts` 与 `apps/gateway/src/hub/uplink-protocol.ts` 里重复的常量、JSON 边界、seq/b64 与两侧完整 encode/decode 抽到 `packages/shared/src/uplink/codec.ts`（无 `node:*`，从 `../auth/encoding` 取 base64url）。两端文件改成再导出 + mesh 独有的 `uplinkWsUrl`。

两侧 **decode 开关没有合成一个**：校验松紧、错误类/文案、输出形态（mesh 用 `Uint8Array`/`bigint`，hub 用 b64 字符串 / wire seq）、大页策略（`pendingKeyLogId` vs `allowKeyLogRes`）均不同。合成会改可观察行为。共享层保留两套入口：`decodeMeshUplinkCtl` / `decodeHubUplinkCtl`（及对应 encode），公共原语只写一份。

未写入 `packages/shared/src/index.ts`，也未加 `package.json` 的 `./uplink` 入口（后者不在 scope）。gateway 用相对路径 `../../../../packages/shared/src/uplink/codec` 导入，避免把编解码打进 FE 主 barrel。`link/` 走独立 subpath，本任务不能改 package.json。

## 变更文件

| 文件 | 摘要 |
|------|------|
| `packages/shared/src/uplink/codec.ts` | 新建：共享常量、`assertCtlBounds`、seq/b64、mesh/hub 编解码 |
| `packages/shared/src/uplink/codec.test.ts` | 新建：原语 + 大页策略差异回归 |
| `apps/gateway/src/mesh/uplink-protocol.ts` | 薄适配：再导出 + `uplinkWsUrl` |
| `apps/gateway/src/hub/uplink-protocol.ts` | 薄适配：再导出（含 `UplinkCtlError` / seq / b64） |

## 行数（三文件指标）

| 文件 | 前 | 后 | Δ |
|------|----|----|---|
| `apps/gateway/src/mesh/uplink-protocol.ts` | 494 | 29 | −465 |
| `apps/gateway/src/hub/uplink-protocol.ts` | 550 | 37 | −513 |
| `packages/shared/src/uplink/codec.ts` | 0 | 843 | +843 |
| **合计** | **1044** | **909** | **−135** |

`codec.test.ts` 67 行，不计入上述三文件目标。目标 −80 已达到（−135）。

## `git diff --stat`

未跟踪新文件不会出现在 `git diff --stat` 里。已跟踪适配层：

```
 apps/gateway/src/hub/uplink-protocol.ts  | 587 ++-----------------------------
 apps/gateway/src/mesh/uplink-protocol.ts | 503 +-------------------------
 2 files changed, 56 insertions(+), 1034 deletions(-)
```

新文件：`packages/shared/src/uplink/codec.ts`（843 行）、`packages/shared/src/uplink/codec.test.ts`（67 行）。

## 死导出

`rg` 全仓（排除 node_modules/dist）后：

**mesh，去掉 `export`（类型并入 `MeshUplinkCtlMessage` 或随实现迁走）：**

`UplinkAuthChallenge`、`UplinkAuthResponse`、`UplinkAuthOk`、`UplinkPing`、`UplinkPong`、`UplinkNodeStatusMsg`、`UplinkNodeInfo`、`UplinkKeyLogHead`、`UplinkHubInfo`、`UplinkKeyLogReq`、`UplinkKeyLogRes`、`UplinkKeyLogAppend`、`UplinkCtlType`、`DecodeUplinkCtlOptions`

仍从 mesh 再导出（有外部引用）：`UplinkCtlMessage`、`UplinkNodeList`、`UplinkKeyLogRecord`、`UplinkKeyLogAck`、`UplinkRtcSignal`、`UplinkEnrollRedeemed`。

**hub，去掉 `export`：** `NodeListHubInfo`、`KeyLogAckMessage`（codec 内仍作局部类型使用）。`UplinkCtlType` 仍由 `hub/index.ts` 再导出，保留。

## 测试 / tsc / biome

**开始前（本 worktree 实测）：**

- `cd apps/gateway && bun test`：2482 pass / 0 fail
- `cd apps/gateway && bunx tsc --noEmit -p .`：22 个 `error TS`（任务书写 21；未增加）
- `cd packages/shared && bun test`：358 pass / 0 fail
- shared tsc：开始时无 uplink 相关错误

**结束后：**

- biome：`bunx biome check` 上述 4 个文件，通过
- `packages/shared` `bun test`：367 pass / 0 fail（本任务新增 5 个 codec 测试；其余增量来自并行 agent）
- 范围内 gateway 测试：`uplink-protocol.test.ts` ×2 + `uplink-client.test.ts` + `uplink-server.test.ts`：**87 pass / 0 fail**
- gateway tsc：21 个 `error TS`（未增加；scoped 文件无新错误）
- shared tsc：`uplink/codec` 无错误。`src/link/fragment-core.test.ts` 有预存/并行 agent 错误，非本 scope

全量 `cd apps/gateway && bun test` 曾出现 3 fail，根因是并行 agent 改坏 `apps/gateway/src/mesh/auth-routes.ts`（语法错误，随后 bun panic）。该文件不在 G1 scope，未动。

## 修过的 bug

无。未发现范围内的行为 bug；只做去重，wire / 错误文案 / 大页策略保持原样。

## 刻意跳过

- **两套 decode switch 合成一套**：mesh 宽松 + `Error` + domain 类型；hub 严格 + `UplinkCtlError` + wire 类型。合成会改变错误码映射（`mapUplinkCtlError` 依赖 `ctl field` 前缀）或 hub 测试依赖的 `UplinkCtlError`。
- **`packages/shared/src/index.ts` / 新 package export**：`package.json` 不在 scope；主 barrel 是 FE 契约。用相对 import 避免把 codec 送进浏览器入口。
- **上一轮保留热点**（`emitOsc` 等）：不在本文件。
- **并行 agent 的 auth-routes / fragment-core 失败**：未改那些文件。
