# B3-2 结果 — bulk file transfer over DataChannel

worktree：`/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。  
范围仅 `apps/gateway/src/mesh/rtc/bulk.ts`（+test）与 `apps/gateway/src/api/files.ts`（+test）。未改 `rtc-peer-manager.ts`、`rtc/index.ts`、`transfer-session.ts`、`ws/**`。

## 做了什么

落地浏览器↔node 直连 `bulk:<transferId>` 文件通道：上传 `{op:put} → 64 KiB 裸字节 → {op:done} → {ok}`，下载 `{op:get} → 64 KiB 帧 → {op:eof}`。写/读现有 REST 临时文件，`commit` / HTTP content 路径不变。失败或 abort 按 HTTP 同款清理，便于 v1 整次改走 REST。

## 文件清单

| 文件 | 职责 |
|---|---|
| `apps/gateway/src/mesh/rtc/bulk.ts` | `BulkTransferService`：label 解析、状态机、背压、30s 空闲超时 |
| `apps/gateway/src/mesh/rtc/bulk.test.ts` | FakeDC + 内存/临时文件 hooks |
| `apps/gateway/src/api/files.ts` | `FilesBulkHooks` + 四个操作；init/prepare 记下 mesh uid |
| `apps/gateway/src/api/files.test.ts` | hooks 单测（既有 HTTP 行为仍绿） |

## 公开 API

```ts
// files.ts
export type BulkTransferOwner = {
  uid: string
  tempPath: string
  expectedSize: number
  kind: 'upload' | 'download'   // 防止 put/get 用错会话；规范三字段仍在
}

export type FilesBulkHooks = {
  getTransferOwner(transferId: string): BulkTransferOwner | null
  openDownload(transferId: string): ReadableStream<Uint8Array> | null
  appendUpload(transferId: string, bytes: Uint8Array):
    | { ok: true; received: number }
    | { ok: false; code: string }
  abortTransfer(transferId: string): void
}

export function getTransferOwner(transferId: string): BulkTransferOwner | null
export function openDownload(transferId: string): ReadableStream<Uint8Array> | null
export function appendUpload(transferId: string, bytes: Uint8Array): ...
export function abortTransfer(transferId: string): void
export const filesBulkHooks: FilesBulkHooks

// bulk.ts
export const BULK_CHANNEL_PREFIX = 'bulk:'
export const BULK_FRAME_SIZE = 64 * 1024
export const BULK_IDLE_TIMEOUT_MS = 30_000

export type BulkState = 'idle' | 'put' | 'get' | 'done' | 'eof' | 'aborted'
export type BulkAttachContext = { uid: string }
export type BulkTransferServiceOptions = {
  files: FilesBulkHooks
  now?: () => number
  idleTimeoutMs?: number          // 默认 30s；单测可缩短
}

export function parseBulkChannelLabel(label: string | undefined | null): string | null

class BulkTransferService {
  constructor(opts: BulkTransferServiceOptions)
  attachChannel(dc: DataChannelLike, ctx: BulkAttachContext): void
  close(): void                   // 清 timer / 进行中的 put|get
}
```

`appendUpload` / `abortTransfer` 超出规范点名的两个 lookup，但必须有：前者走现有 `appendUploadChunk`，`session.received` 更新后 REST `commit` 才能过；后者等同 HTTP cancel（删会话 + 临时目录）。

控制帧 JSON（`sendMessage`）；数据帧 `sendMessageBinary(Buffer.from(...))`。数据帧 ≤ `min(64KiB, dc.maxMessageSize())`。下载背压：`bufferedAmount > 4MiB` 暂停，low watermark 1MiB。错误回复 `{ok:false, code}`：`not_found` / `permission_denied` / `too_large` / `invalid` / `timeout` / `aborted` / `protocol`。

uid：`handleUploadInit` / `handleDownloadPrepare` 从 `requestDispatchContext.get(req)?.uid ?? ''` 写入旁路 Map。无 mesh 上下文时 uid 为 `''`。错误 uid / 未知 transfer **不**清理会话；字节数不符、超限、超时、abort、通道关闭（put/get 中）才 `abortTransfer`。成功 put 后保持上传会话，供 REST `commit`。

## RtcPeerManager 接线（本任务不能改 rtc-peer-manager.ts）

`acceptBrowser` 返回的 `pc` 已授权，`bulk:*` 复用、不再鉴权。在拿到 `{pc, uid}` 之后立刻挂（browser 稍后 `createDataChannel('bulk:…')`）：

```ts
import { BulkTransferService } from './mesh/rtc/bulk'
import { filesBulkHooks } from './api/files'

const bulk = new BulkTransferService({ files: filesBulkHooks })

const accepted = await rtc.acceptBrowser(rtcSession, signaling)
accepted.pc.onDataChannel((dc) => {
  const label = dc.getLabel?.() ?? ''
  if (label.startsWith('bulk:')) bulk.attachChannel(dc, { uid: accepted.uid })
})
rtc.attachDirect(gatewaySession, accepted.carrier)
```

`onDataChannel` 可登记多个回调（B3-1 FakePC / native 都是 push）。更稳的是在 `acceptBrowser` **内部**、`waitDataChannel('sess')` 之前登记，以免 sess 与首个 bulk 竞态；assembler 侧后挂在 bulk 通道晚于 sess 的常见时序下够用。

HTTP 转发必须带 `requestDispatchContext`（含 uid），否则 `getTransferOwner().uid === ''`，直连 bulk 会 `permission_denied`。

## 测试

`cd apps/gateway && bun test src/mesh/rtc src/api/files`：

```
 52 pass
 0 fail
 151 expect() calls
Ran 52 tests across 9 files. [271.00ms]
```

bulk 覆盖：happy upload（含 64KiB+尾）、done 字节不符清 temp、abort / 通道关闭清 temp、download 分帧 + eof、背压 pause/resume、错 uid（不删会话）、未知 transfer、超限消息、download 错 uid 不开流、25ms 空闲超时、put.size ≠ init size、非 `bulk:*` label 忽略。  
files 覆盖：getTransferOwner、appendUpload 与 HTTP PUT 同 temp/received、abortTransfer、openDownload 流完清理。既有 init size 校验仍绿。

## tsc / biome

| | 数量 |
|---|---|
| 任务基线 `apps/gateway` | 23 |
| 本次全量 | **25**（增量均在 `hub-runtime.ts` / `push/*` / `tmux-client/*` 等，**非本 scope**） |
| `src/mesh/rtc/bulk.ts` + `src/api/files.ts`（含 test） | **0** |

`bunx biome check apps/gateway/src/mesh/rtc/bulk.ts apps/gateway/src/mesh/rtc/bulk.test.ts apps/gateway/src/api/files.ts apps/gateway/src/api/files.test.ts`：**clean**。

## 协调者必须接的钩子

1. **Assembler**：构造 `new BulkTransferService({ files: filesBulkHooks })`，按上文把 `accepted.pc.onDataChannel` 滤 `bulk:` → `bulk.attachChannel(dc, { uid })`。
2. **`mesh/rtc/index.ts`**：未 re-export `./bulk`（超出 scope）。需要的话加 barrel。
3. **HTTP uid**：init/prepare 已读 `requestDispatchContext`。转发入口必须 `set(req, {uid, viaNodeId})`，否则 bulk 与 REST 会话对不上 uid。
4. **未改 `transfer-session.ts`**：uid 存在 files.ts 的 Map；会话仍无 uid 字段。commit 依赖 `appendUpload` → `appendUploadChunk` 更新 `received`。

## 未做 / 注意

- 未改 `RtcPeerManager` / `acceptBrowser`；接线由协调者做。
- 失败回落 REST 是浏览器侧行为；节点只保证 abort 后会话可重新 `init`/`prepare`。
- 控制 JSON 与数据帧靠「小且以 `{` 开头 + 有 `op`」区分；文件内容恰好是 `{"op":"done"}` 这种小 JSON 会被当成控制帧（与设计一致的实用取舍）。
- 未碰生产 tmex、默认 tmux session `tmex`、`bun install`。
