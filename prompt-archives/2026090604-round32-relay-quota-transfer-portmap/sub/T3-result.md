# T3 result — transfer engine review fixes (R1-engine 1–11 + sink/driver capabilities for T4)

Worktree `/Users/konata/code/tmex-r32`, branch `feat/round32-relay-quota-transfer-portmap`.

---

## 1. Final sink / driver API (what T4 codes against)

`@tmex/transfer/node` — `packages/transfer/src/node/sink.ts`:

```ts
export type CommitOptions = { onConflict?: 'overwrite' | 'skip' };   // default 'overwrite'

export type CommitResult =
  | { ok: true; path: string; bytes: number; committed: boolean; skipped: boolean }
  | { ok: false; code: 'io_error' };

class ResumableSink {
  status(d: SinkDescriptor): Promise<ReceivedState>;
  write(d: SinkDescriptor, body: ReadableStream<Uint8Array>, opts?: SinkWriteOptions)
    : Promise<SinkWriteResult>;
  commit(d: SinkDescriptor, opts?: CommitOptions): Promise<CommitResult>;
  discard(d: SinkDescriptor): Promise<void>;
  sweep(dir: string, now?: number, ttlMs?: number): Promise<number>;
}

export interface SinkWriteOptions {
  offset?: number;
  contentLength?: number;
  maxWriteBytes?: number;
  registerCancel?: (cancel: () => void) => void;
  signal?: AbortSignal;            // 新增：会话级取消
}

export type SinkFailure =
  | { ok: false; code: 'offset_mismatch'; receivedBytes: number }
  | { ok: false; code: 'too_large' }
  | { ok: false; code: 'incomplete'; receivedBytes: number }
  | { ok: false; code: 'checksum_mismatch' }
  | { ok: false; code: 'aborted' }
  | { ok: false; code: 'invalid' }
  | { ok: false; code: 'io_error' }
  | { ok: false; code: 'conflict' }   // 新增：与在写 / 已确认区间重叠（可重试）
  | { ok: false; code: 'sealed' };    // 新增：半成品已落位封存
```

Deviation from the brief: `commit()` returns **`{ ok, path, bytes, committed, skipped }`** rather than
bare `{ committed, skipped }` — `ok`/`path`/`bytes` were already consumed by
`files/transfer-session.ts` and `transfer/receiver.ts`, and dropping them would have broken both.
`committed` / `skipped` carry exactly the semantics the brief asked for:

| case | result |
|---|---|
| overwrite（默认） | `{ ok: true, committed: true, skipped: false }`，`rename(part → dest)` 原子替换，**不预删目标** |
| skip + 目标不存在 | `{ ok: true, committed: true, skipped: false }`（`link` 抢占成功后 unlink part） |
| skip + 目标已存在 | `{ ok: true, committed: false, skipped: true }`，目标一字节不动，part 丢弃 |
| 重复 commit | 返回第一次成功的同一个对象（幂等，不会二次改名/删目标） |
| 失败 | `{ ok: false, code: 'io_error' }`，闸门解封，可重试 |

`skip` 用 `link(part, dest)`：目标存在时以 `EEXIST` **原子**失败，不存在竞态的「先查后改名」。
`commit()` 串行化于同一个 `.part`，落位前会**封住新预约并排空活跃写入**，成功后封存该半成品——
之后的 `write()` 一律返回 `{ ok:false, code:'sealed' }`。

驱动 `runPush`（`packages/transfer/src/push-driver.ts`）：签名不变，行为新增

- 每轮尝试派生一个中止信号（调用方 signal ∪ 剩余期限），经 `PushPutOptions.signal` 传给
  `transport.put()` 与 `transport.status(signal)`；
- 调用方 signal 一 abort：**不再发放新区间**，在飞的请求被派生信号中止，且
  **取消压过其它结论**（哪怕已有区间落地，整次推送也返回 `{kind:'cancelled'}`）；
- 本轮出结论（失败/取消）后立即 abort 派生信号，收掉还在飞的并行请求；
- 期限用尽返回 `{kind:'failed', error: timeoutError}`。

新增内部模块 `packages/transfer/src/node/part-gate.ts`（从 `@tmex/transfer/node` 导出）：
`reserveWrite` / `finishWrite` / `releaseWrite` / `serializeCommit` / `forgetPart` / `resetPartGates`。
T4 不需要直接用它，但如果接收端要自己做「排空活跃写入再关会话」，`serializeCommit` 的模式可以复用。

---

## 2. R1-engine 11 findings — what changed

| # | 修复 | 位置 |
|---|---|---|
| 1 | `writeAll()` 按 `bytesWritten` 循环补齐；一次都没推进 ⇒ 抛 IO 错误。字节计数与增量 sha256 只按**实际写入**的切片推进（追加 / 乱序两种模式共用） | `node/sink.ts` |
| 2 | 每次写入先按区间**预约**（`part-gate`）：与在写区间重叠、或与**已确认区间**重叠一律拒 `conflict`（可重试）；预约的读-查-插与位图落盘-释放各自在同一把 part 锁内完成，杜绝「读到过期已确认集」的竞态；落位排空活跃写入并封存会话 | `node/part-gate.ts` `node/sink.ts` |
| 3 | 落位不再 `rm(dest)`：overwrite 直接 `rename` 原子替换，skip 用 `link` 抢占；同一半成品的多次 commit 串行且幂等 | `node/sink.ts` |
| 4 | `writeReceivedRanges` 改「写 `<part>.rx.tmp` → rename」原子发布，**不再吞异常**；位图落盘失败上报 `io_error`（HTTP 409 ⇒ 客户端退避续传），该段字节不算已收。数据先 `close()` 落盘再发布位图 | `node/sink-state.ts` `node/sink.ts` |
| 5 | 下载会话不再在「读到文件尾」时回收（`atEof` 只描述请求区间，不代表对端收全）；只由客户端 `DELETE` 或 30 min TTL 清理。客户端在**收全并校验长度之后**才发 DELETE | `api/file-transfer-routes.ts` `api/file-http.ts` `api/file-transfer-sessions.ts` `api-client/download-transfer.ts` |
| 6 | `SinkWriteOptions.signal`：abort 即掐 body reader 并尽快关句柄；已 abort 的信号连文件都不开。`pumpBody` 提前退出（写失败/取消）也 cancel 源流。上传会话把 `session.abort.signal` 传进每次写入 | `node/sink.ts` `files/transfer-session.ts` |
| 7 | `PUT /api/files/upload/:id` 永远下传 `maxWriteBytes = min(8 MiB, size - offset)`，与客户端是否声明 `length` / `Content-Length` 无关 | `api/file-transfer-routes.ts` `files/transfer-session.ts` |
| 8 | 期限信号在**驱动层**派生（覆盖 status / PUT / 响应体消费），传输层改用 `opts.signal`；本轮出结论后 abort 其余 worker | `push-driver.ts` `api-client/upload-transfer.ts` |
| 9 | `client.fetch()` 移进重试范围：建连阶段被 RST 也重试并保留已收字节；用户取消与永久性 HTTP 错误仍立即终止 | `api-client/download-transfer.ts` |
| 10 | `pullFileFromDevice` 对 `local` 设备直接返回原文件路径（`cleanup` 空操作），不再整份 rsync 到 tmpdir；下载会话记录源文件 size/mtime，续传前复核，源文件被改写/消失 ⇒ 400 `invalid` 并回收会话 | `files/device-storage.ts` `files/transfer-session.ts` `api/file-transfer-routes.ts` |
| 11 | `remote-upgrade-job.ts` 直接从 `@tmex/transfer` re-export `PUSH_RETRY_BACKOFF_MS` / `PUSH_MAX_ATTEMPTS`，只保留升级独有的 `LEGACY_PUSH_MAX_ATTEMPTS` | `system/remote-upgrade-job.ts` |

---

## 3. 有意的偏离

1. **越界（`too_large`）时不 cancel 源流。** R1 建议「overflow 或写失败时都 cancel body」，但
   `apps/gateway/src/system/upgrade.test.ts` 有一条既有断言「size cap does not cancel the request
   body before returning 413」，来自更早一轮审查的结论（commit `e6dd6b26`：「中流超限不 cancel
   源流以保证 413 能回传」）——中途掐掉请求体会让 413 送不回发送端。因此：**写失败 / 取消**照常
   cancel，**越界**保留源流，由调用方立刻回状态码让对端停。落笔前就否决的请求（偏移不符 /
   区间冲突 / 已封存）同理不 cancel。
2. **已确认区间选择「不可变 + 拒绝」而非「逐字节比对重复内容」。** 比对要把整段重读一遍，
   代价与重传相当；拒成 `conflict` 后推送端会重新问状态、只补真正的缺口，收敛更快。
3. **没有加 `fsync`。** 位图发布前的顺序（数据 `close()` → 位图 rename）已满足进程崩溃恢复；
   RTC bulk 直连每 16 KiB 帧走一次 `write()`，每帧一次 fsync 代价不可接受。机器掉电级别的
   crash-safety 需要时应作为 descriptor 上的显式开关另行引入。
4. **`packages/panels/src/files/bulk-transfer.ts` 未改**（不在我的 scope）：bulk 直连下载成功后
   仍不发 DELETE，会话要等 30 min TTL 才回收（临时文件滞留；本机设备走直读所以无副本）。
   建议 commander 让 F1 在 `downloadFileWithTransport` 成功分支补一句
   `await deleteQuietly(client, '/api/files/download/<id>')`。我只改了它的**测试**期望
   （REST 回落路径现在多一次 DELETE）。

---

## 4. 测试

新增/改写的回归用例（全部用真实临时目录，不用内存 fs）：

- `packages/transfer/src/node/sink.test.ts` +14：短写补齐（乱序 / 追加两种模式）、零推进 ⇒ IO 错误、
  与在写区间重叠 ⇒ conflict、已确认区间不可改写、落位排空在写流并封存、overwrite 重复 commit
  幂等且不误删目标、skip 命中/未命中、位图落盘失败 ⇒ io_error 且不算已收、位图原子发布无残留
  `.tmp`、signal 取消掐 body、已 abort 的信号不开文件、写失败也掐 body。
- `packages/transfer/src/push-driver.test.ts` +4：取消压过已落地区间且不再发放新区间、已 abort
  的信号不发起推送、期限用尽 abort 卡死的 PUT、出结论后收掉在飞的并行请求。
- `apps/gateway/src/files/transfer-session.test.ts` +6：`maxWriteBytes` 硬上限、重复区间 conflict、
  落位后迟到的重复区间回「已完成」、删会话即掐在写的 body、源文件被改写/消失的下载守卫。
- `apps/gateway/src/files/local-download.test.ts`（新）+3：本机设备直读原路径、cleanup 不删原文件、
  目录/不存在/越 root 的错误码。
- `apps/gateway/src/api/file-transfer-routes.test.ts` +3：不带 length/content-length 的分块请求仍受
  8 MiB 上限约束（413）、下载内容读完不回收会话且可用 Range 续传、DELETE 才清理、源文件变更 ⇒ 400。
- `apps/gateway/src/api/files.test.ts`：3 条断言旧缺陷行为的用例改写（重叠写入现在被拒；
  下载会话读完仍在，DELETE 才清）。
- `packages/api-client/src/download-transfer.test.ts` +3：建连被 RST 走重试并 Range 续传、成功后
  DELETE 会话、永久性 HTTP 错误不重试、三次都失败上抛最后一个链路错误。
- `packages/api-client/src/files-upload.test.ts` +1：PUT 挂在派生信号上，用户取消时在飞请求被中止。
- `packages/panels/src/files/bulk-transfer.test.ts`：3 处调用序列期望补上收尾的 DELETE。

### 结果

| 范围 | 结果 |
|---|---|
| `packages/transfer` | 60 pass / 0 fail（原 43） |
| `packages/api-client` | 282 pass / 0 fail（原 278） |
| `packages/ws-client` | 413 pass / 0 fail |
| `packages/panels` | 1070 pass / 0 fail |
| `apps/gateway` `src/files src/api src/system` | 736 pass / 0 fail |
| `apps/gateway` 全量 | 5049 pass / 11 fail |

全量 11 个失败 = 文档基线的 10 个（9 个 `mesh phase-2 integration` + 1 个偶发的
`8 MiB after a DC re-dial` DataChannel 用例）+ 1 个 **T4 在途**用例
`src/transfer/receiver.test.ts > the orphan sweep removes expired partials and keeps claimed ones`
（`sweepTransferOrphans` / `sweep.ts` / `receiver.test.ts` 都是 T4 新建、尚未提交且当前不过 tsc 的文件，
与本次改动无关：`sweepPartFiles` 的语义没变，`isPartFileName` 只是多排除了 `.rx.tmp` 旁挂临时文件）。

`bunx tsc --noEmit`：`packages/transfer` / `api-client` / `ws-client` / `panels` 均 0 错误。
`apps/gateway` 在我负责的文件上 0 错误；剩余错误全部来自 T4 在改的 `apps/gateway/src/transfer/**`
（`channel.ts` / `mesh-routes.ts` 找不到 `commitFile` / `fileStatus` / `writeFileRange`，
`dest-local.ts` 的 `possibly undefined`，`dest-remote.ts` 的 `FileOpResult<{skipped:true}>` 收窄，
`job-runner.ts` / `expand.ts` 的 `ExpandedFile` / `.files`），与本次改动无关。

`bunx biome check`：我改到的全部文件干净。
`bun scripts/complexity/gate.ts`：我的文件全部通过；唯一 violation 是
`apps/gateway/src/mesh/forwarder.ts: 979 lines > 964`（T4 在途文件，需由 T4/commander 处理）。

---

## 5. commander 需要注意

1. **T4 的 `apps/gateway/src/transfer/**` 目前 tsc 不过**（见上），且 `mesh/forwarder.ts` 超行数门禁。
2. **bulk 直连下载成功后没有 DELETE**（见 §3.4），建议补一行。
3. 上传 PUT 现在可能返回 **409 `conflict`**（区间与在写/已确认区间重叠）。浏览器端驱动已把 409
   当作可重试并重新协商偏移；任何自行调 `PUT /api/files/upload/:id` 的调用方需要同样处理。
4. 本机设备下载**不再复制到 tmpdir**：`DownloadSession.tmpPath` 可能就是用户的原文件，
   任何新代码都不许对它做写/删（现有 `cleanup` 对本机设备是空操作）。
