# T3d 结果 — `forwarder.ts` 拆到文件行数门禁以下

## 做了什么

`apps/gateway/src/mesh/forwarder.ts` 从 **1042 行**（allowlist 964）拆到 **802 行**（目标 ≤900，余量约 100 行）。`Forwarder` 类公开 API 不变，未从 `forwarder.ts` 再导出抽出的 helper。`isCanonicalNodeId` 已在 `auth/cookies.ts`（T3c），未重复搬迁。

抽出的无副作用模块：

| 模块 | 内容 |
| --- | --- |
| `forwarder-path.ts` | `parseNodePrefix`（`/n/:nodeId` 解析） |
| `forwarder-unreachable.ts` | `classifyUnreachableReason` / `safeUnreachableReason` / `nodeUnreachableResponse`（503 体） |
| `forwarder-auth-policy.ts` | `applyAuthPolicy`、`expireNodeCookieOn`、`peekJsonCode`、401 改写常量 |
| `forwarder-headers.ts` | `copyUpstreamHeaders`、`filterRequestHeaders` 及 allow/deny 列表 |

对应单测放到同名 `*.test.ts`。`forwarder.test.ts` 的 HTTP/WS 集成用例保留；`safeUnreachableReason` 的纯函数断言改由 `forwarder-unreachable.test.ts` 覆盖。门禁跳过 `*.test.ts`，`forwarder.test.ts`（2281 行）无需再拆。

未改 `scripts/complexity/allowlist.json`。

## 文件清单

- `apps/gateway/src/mesh/forwarder.ts`（1042 → 802）
- `apps/gateway/src/mesh/forwarder.test.ts`
- `apps/gateway/src/mesh/forwarder-path.ts`（新）
- `apps/gateway/src/mesh/forwarder-path.test.ts`（新）
- `apps/gateway/src/mesh/forwarder-unreachable.ts`（新）
- `apps/gateway/src/mesh/forwarder-unreachable.test.ts`（新）
- `apps/gateway/src/mesh/forwarder-auth-policy.ts`（新）
- `apps/gateway/src/mesh/forwarder-auth-policy.test.ts`（新）
- `apps/gateway/src/mesh/forwarder-headers.ts`（新）
- `apps/gateway/src/mesh/forwarder-headers.test.ts`（新）

## 验证

| 项 | 结果 |
| --- | --- |
| `cd apps/gateway && bun test src/mesh` | **1211 pass / 0 fail**（含 integration；基线未单独记录，改后全绿） |
| 其中 `forwarder*` | **139 pass / 0 fail**（6 文件，含新单测） |
| `bunx tsc --noEmit -p .`（apps/gateway） | **0** |
| `bunx biome check`（触及文件） | clean |
| `bun scripts/complexity/gate.ts` | **ok**（1515 files）。`forwarder.ts` 802 ≤ allowlist 964，未出现在 near-limit 列表，无新违规 |

## 未做 / 残留

- `isCanonicalNodeId` 仍在 `apps/gateway/src/auth/cookies.ts`，未再导出。
- `forwarder.ts` 仍在 allowlist（964）；实测 802，下次小改不会再撞门禁。未收紧 allowlist（任务禁止改该文件）。
- 未把 pending-stream / pump 队列等有副作用逻辑再拆出去。
