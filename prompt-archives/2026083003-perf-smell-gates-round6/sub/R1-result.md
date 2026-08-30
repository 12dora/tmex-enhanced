# R1 结果 — 有界上传 / 无拷贝 raw 读 / 有界 rsync list

## 做了什么

### 1. 上传 chunk：先校验再读，有界消费，异步落盘
- `Content-Length` 超过 advertised 8 MiB 或剩余声明 size 时直接 413，不碰 `req.body`。
- 有 body 时按 cap 增量读；多出一字节即 `cancel` + 413，不写盘、`received` 不变。
- HTTP 路径用 `fs.promises.open(..., 'a')` 异步追加，**写成功后才** `received += n`。
- `appendUploadChunk` 仍保持同步（`appendFileSync`）：`files.ts` / mesh bulk 不在本任务范围，改成 async 会破坏 RTC 同步 `appendUpload`。

### 2. Raw 远程文件：去掉二次 `Uint8Array` 拷贝，改为 temp 流
- `readRawFile` 不再 `readFileSync` + `new Uint8Array(buf)`，rsync 到 `tmex-rfile-` 临时文件后返回 `{ tmpPath, size, name, mime, cleanup }`。
- `GET /api/files/raw` 走已有 `streamTempFile`：EOF / 打开失败 / `cancel` 都会 cleanup。
- 补了 `Content-Length`（以前 buffer body 由运行时隐式带上）。

### 3. rsync list-only：按行消费，只保留能进页的条目
- `runRsync({ onStdoutLine })` 不累积 stdout 全文。
- `createListOnlyCollector(MAX_ENTRIES)` 用大小 `MAX_ENTRIES+1` 的堆，按**目录优先、再 name**（`Intl.Collator` numeric + base，与原 `sortEntries` 同语义）保留可能出现在返回页的条目。
- **未**提前 kill rsync：任意后续行都可能挤进当前页，提前杀会错页。
- **行为变化（仅截断目录）**：原先是 rsync 顺序先 slice 2000 再排序；现在是全局排序后的前 2000。未截断目录结果不变。

## 文件

修改：
- `apps/gateway/src/api/file-transfer-routes.ts`
- `apps/gateway/src/api/file-browser-routes.ts`
- `apps/gateway/src/files/transfer-session.ts`
- `apps/gateway/src/files/device-storage.ts`
- `apps/gateway/src/files/rsync.ts`
- `apps/gateway/src/files/transfer-session.test.ts`
- `apps/gateway/src/files/rsync.test.ts`

新增：
- `apps/gateway/src/api/file-transfer-routes.test.ts`
- `apps/gateway/src/api/file-browser-routes.test.ts`

bench（throwaway）：
- `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/6c2fc705-32ec-470c-8790-255ad37938cd/scratchpad/r1-rsync-list-bench.ts`

## 测量（200k 合成 list-only 行）

独立进程，200_000 文件 + 2 目录，末尾才出现 `adir`/`zdir`：

| | ms | RSS Δ | retained | returned |
|---|---:|---:|---:|---:|
| before（`parseListOnly` 全量） | 89.85 | 163.0 MiB | 200002 | 2000 |
| after（有界堆 + 行消费） | 970.18 | 63.1 MiB | 2001 | 2000 |

CPU 变慢是 top-k 对每条做 collator 比较（约 200k·log k）；rsync 网络/子进程仍是大目录的主成本。内存按页有界（2001 vs 20 万对象）；生产路径不再缓冲 stdout 全文，RSS 还会低于 bench（bench 的 unbounded 还含 10.7 MiB 拼接串）。

## 验证

- `cd apps/gateway && bun test src/files src/api` → **479 pass / 0 fail**
- `bunx tsc --noEmit -p apps/gateway` → **21 errors**（= 基线，无新增）
- `bunx biome check` 上述 9 个文件 → **0 error**

## 未做 / 风险

- **未提前 kill rsync**（见上）。若以后能证明远端 `--list-only` 已按同一顺序排出，再考虑。
- Mesh / `files.ts` 的 `appendUpload` 仍走同步 `appendFileSync`（范围外）。HTTP 上传已异步。
- 截断目录的返回集合与旧 slice-then-sort 不同（改为真正的目录优先页）。未截断时字节级一致。
- Raw 响应现在显式带 `Content-Length`；客户端 disconnect 依赖 `ReadableStream.cancel` → cleanup，与 download 路径相同。
