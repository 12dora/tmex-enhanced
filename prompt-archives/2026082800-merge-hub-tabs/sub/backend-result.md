# backend 冲突融合结果

范围：`apps/gateway` 分配的 10 个文件。未做任何 git 写操作。未改 `apps/gateway/drizzle/`。

验收时本 worktree 最初没有 `node_modules`，先 `bun install --frozen-lockfile` 再跑测试。

---

## 1. 逐文件融合

### `apps/gateway/src/api/files.ts`（1 处）

- **hub**：整文件承载 REST 文件路由 + mesh bulk 钩子（`filesBulkHooks` / uid 绑定 / 临时文件复用）。
- **tabs**：把 REST 拆到 `file-root-routes` / `file-browser-routes` / `file-transfer-routes`，本文件只再导出 `filesRoutes`。
- **融合**：保留 tabs 的拆路由再导出；把 hub 的 bulk API 留在本文件（`getTransferOwner` / `openDownload` / `appendUpload` / `abortTransfer` / `filesBulkHooks` / `rememberTransferUid`）。`files.test.ts` 与 `mesh-runtime` 仍从这里 import bulk 钩子。REST 体校验、非整数 offset 拒绝走拆出去的路由，不回退成单体文件。

### `apps/gateway/src/db/managed-migrations.ts`（1 处）

- **hub**：清单末尾 `0018_hub_auth.sql`。
- **tabs**：清单末尾 `0018_agent_query_indexes.sql`。
- **融合**：按指挥官指定顺序两边都留——`0018_agent_query_indexes.sql`，`0019_hub_auth.sql`。当前 drizzle 目录里已经是这个文件名。

### `apps/gateway/src/db/schema.ts`（1 处）

- **hub**：为 hub 鉴权表补 `blob` / `primaryKey` / `uniqueIndex`。
- **tabs**：为 agent 查询索引补 `index`。
- **融合**：采用更完整的 drizzle import（含 `index`）。表体在冲突外已同时包含 hub 鉴权表和 tabs 的 `agent_queued_messages_session_seq_idx` / `agent_confirmations_session_status_created_at_idx`。

### `apps/gateway/src/ws/borsh/session-state.ts`（4 处）

- **hub**：状态机按 `GatewaySession` 键控；`create()` 复用 `session.state`。
- **tabs**：输出门限字节/帧上限、overflow 发 `SourceGap(resource_exhausted)`、notification throttle TTL prune（保留正在检查的 key）。
- **融合**：
  - 键类型为 `GatewaySession | ServerWebSocket<unknown>`（生产走 session，tabs overflow 单测允许 dummy socket）。
  - `create()` 优先用 `session.state`，没有则 `createSessionState()`。
  - `createSessionState()` 补上 `lastNotificationPruneAt: 0`。
  - `bufferOutput` 带 `overflowed` 短路；overflow 经 `session.activeCarrier` 发 SourceGap。
  - 构造器保留 tabs 的 `now` / max bytes / max frames / prune interval。

### `apps/gateway/src/ws/device-connection-registry.ts`（4 处）

- **hub**：全部 API 改为 `GatewaySession`。
- **tabs**：`connectGenerations` 在同 socket 断开后丢弃 in-flight connect；connect/disconnect/reconnect 失败时同步/释放 legacy pane observer。
- **融合**：generation 与 `abandonSocket` 按 `GatewaySession` 键控；connect 成功后 `session.borshState.selectedPanes[id] ??= null` 并 `syncLegacyPaneObservers`；disconnect / `finalizeReconnectFailure` 先 bump generation、再 `releaseLegacyPaneObservers`，selectedPanes 仍走 `client.borshState`。

### `apps/gateway/src/ws/device-connection-registry.test.ts`（1 处）

- **hub**：`createGatewaySession`。
- **tabs**：pending connect vs disconnect 用例需要 `RUNTIME_IDLE_GRACE_MS`。
- **融合**：两个 import 都留；pending 用例改用 `createGatewaySession()`（与 `createBorshTestWs` 同实现）。

### `apps/gateway/src/ws/index.ts`（2 处）

- **hub**：`bindingOf` + closed-session inbound 丢弃；`closeSession` 关所有 carrier、mesh teardown。
- **tabs**：入站帧当 view 传（不 copy）；close 时 `abandonSocket` + `releaseLegacyPaneObservers`。
- **融合**：
  - `handleMessage`：先 `bindingOf`、closed 则 return，再 `const data: Uint8Array = message`（view）。
  - `closeSession`：hub 的 carrier 关闭路径 + tabs 的 `abandonSocket` / `releaseLegacyPaneObservers`。
  - 另加 `handleClose` 薄封装（`bindingOf` → `closeSession`），因为 tabs 测试与旧调用点仍走这个名字；生产 bun close 走 `handleCarrierClose`。
  - `syncLegacyPaneObservers` / `releaseLegacyPaneObservers` 签名改为 `GatewaySession`。

### `apps/gateway/src/ws/index.test.ts`（1 处）

- **hub**：carrier drain 隔离、`attachStreamSession`、closeSession/carrier close 语义、per-carrier metrics。
- **tabs**：legacy pane observer 计数，无人听则跳过 batch。
- **融合**：两套 `describe` 都保留。

### `apps/gateway/src/ws/legacy-feed-broadcaster.ts`（1 处）

- **hub**：`GatewaySession`。
- **tabs**：抽出 `legacy-event-delivery`；observer 计数跳过无人听的 batch。
- **融合**：两边 import 都留；observer map / `clientObservedPanes` 改为 `client.borshState`。`deliverBell` 等仍吃 `ServerWebSocket<ClientState>`（该文件不在本次范围），调用处对 `entry.clients` 和 `this.host` 做 `as never`，等 delivery 模块改完可去掉。

### `apps/gateway/src/ws/tmux-command-handlers.ts`（2 处）

- **hub**：`session.borshState.selectedPanes`。
- **tabs**：select / focus / subscribe 后 `syncLegacyPaneObservers`。
- **融合**：`session.borshState.selectedPanes[deviceId] = paneId` + `host.syncLegacyPaneObservers(session, deviceId)`。`handleSubscribePanes` 里残留的 `ws` 一并改成 `session`。Host 接口签名改为 `GatewaySession`。

---

## 2. 需要指挥官复核的取舍点

1. **REST 创建 transfer 时的 uid 绑定**  
   hub 在 `upload/init` 和 `download/prepare` 里 `rememberTransferUid(id, requestDispatchContext.uid)`。这些 handler 已在 tabs 的 `file-transfer-routes.ts`（本次不能改）。bulk 钩子仍可用，未绑定时 `getTransferOwner().uid === ''`（现有单测即此预期）。`rememberTransferUid` 已从 `files.ts` 导出，若 mesh bulk 要校验 HTTP 发起方 uid，需要在 file-transfer-routes 里补调用。

2. **`legacy-event-delivery.ts` 仍是 `ServerWebSocket<ClientState>`**  
   该文件不在本次范围，且 `ClientState` 已从 `types.ts` 消失。broadcaster 里用 `as never` 桥接。delivery 模块改成 `GatewaySession` 后应删掉这些断言。

3. **`handleClose` 兼容封装**  
   生产关闭路径是 `handleCarrierClose` → `closeSession`。`handleClose` 只为 tabs 测试（`legacy-observer-wiring` / `inbound-frame`）保留。若指挥官希望测试也改成 `closeSession`，可以再删封装。

4. **整包 tsc 37 > 25**  
   分配文件里只有 1 条：`src/ws/index.test.ts:231` `process.off('unhandledRejection')`，hub 分支同位置同错，属于基线。其余 36 条在未分配文件（`legacy-observer-wiring.test.ts` 12、`legacy-event-delivery*`、`push/supervisor.test.ts`、tmux-client/telegram 等），等对应 agent 改完应变回 ≤25。

5. **drizzle SQL / journal**  
   按指示未改。`managed-migrations.ts` 已按 0018 indexes + 0019 hub_auth 写。现场目录里这两个文件已经存在。

---

## 3. 验收输出

命令均在 `apps/gateway` 下执行。

### `bun test src/`（摘要）

```
 2221 pass
 0 fail
 8262 expect() calls
Ran 2221 tests across 237 files. [47.29s]
```

0 fail，pass 2221 ≥ 1870（两边基线较大值），高于 hub 1823 / tabs 1870，未合丢测试。

### `bunx tsc --noEmit -p .`（error TS 计数）

```
37
```

分配文件仅 1 条（hub 基线同款）。整包 37 来自尚未融合的其它文件，见上一节。

### `bunx biome check <改过的文件>`

```
Checked 10 files in 28ms. No fixes applied.
```

10 个源文件干净。
