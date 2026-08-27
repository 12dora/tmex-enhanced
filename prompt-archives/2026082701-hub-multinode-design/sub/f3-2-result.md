# F3-2 结果 — 浏览器侧 bulk 文件直传（ws-client bulk-client + files 面板接线）

对应任务：`sub/f3-2-prompt.md`。设计依据：`docs/hub/2026082700-hub-node-architecture.md` §3「DataChannel 消息尺寸与背压 / bulk 协议」、§4「连接层」。node 侧协议见 `sub/b3-2-result.md`，直连生命周期见 `sub/f3-1-result.md`。

worktree `/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。

## 一、交付文件

### 新增

| 文件 | 作用 |
|---|---|
| `packages/ws-client/src/direct/bulk-client.ts` | `BulkClient`：`bulk:<transferId>` 通道的上传/下载、背压、abort、每 node 的登记表 |
| `packages/ws-client/src/direct/bulk-client.test.ts` | 24 个用例（假 DataChannel） |
| `packages/panels/src/files/bulk-transfer.ts` | 传输路径选择：direct（REST init/prepare + bulk 字节）↔ relay（原 REST 整次回落） |
| `packages/panels/src/files/bulk-transfer.test.ts` | 13 个用例（真 `ApiClient` + 假 gateway + 假 bulk） |

### 修改

| 文件 | 改动 |
|---|---|
| `packages/ws-client/src/direct/direct-carrier-controller.ts` | **加法**：`createDataChannel(label, init?)`，仅 `state === 'active'` 时在已鉴权 PC 上开新通道，否则抛 |
| `packages/ws-client/src/index.ts` | 导出 `bulk-client` 的公开面（未新建 `direct/index.ts`，沿用主 barrel） |
| `packages/panels/src/files/use-directory-upload.ts` | 上传改调 `uploadFileWithTransport`，传 `runtime.nodeId` 与 `onPath` |
| `packages/panels/src/files/file-node-actions.tsx` | 下载改调 `downloadFileWithTransport` |
| `packages/panels/src/files/transfer-toast.tsx` | Toast 增 `setPath()` 与文件名旁的 direct / relay 徽标（含 `title` 提示） |
| `packages/panels/src/files/index.ts` | 导出新传输函数与类型 |
| `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` | 新增 `files.transfer.{pathDirect,pathRelay,pathDirectHint,pathRelayHint}` |
| `packages/shared/src/i18n/{resources,types}.ts` | `bun run build:i18n` 重新生成（生成物，未手工改） |

**超出 prompt 字面 scope 的唯一一处**：`direct-carrier-controller.ts` 的 `createDataChannel`。F3-1 落地时控制器把 `pc` 关在私有 `attempt` 里，外部没有任何途径在已鉴权 PC 上开第二条通道，`BulkClient` 因此无法构造。改动是纯加法、10 行、不改任何既有行为，且 F4-fix 的文件清单里没有这个文件。

## 二、`BulkClient` 公开 API

```ts
// 结构子集：DirectCarrierController 天然满足
interface BulkChannelSource {
  getState(): string;
  createDataChannel(label: string, init?: { ordered?: boolean }): RTCDataChannelLike;
}

new BulkClient(source, {
  frameSize? = 65536, highWaterBytes? = 4 MiB, lowWaterBytes? = 1 MiB,
  openTimeoutMs? = 15000, setTimeoutFn?, clearTimeoutFn?,
})

isAvailable(): boolean                        // source.getState() === 'active'
upload(req): Promise<{ok:true} | {ok:false, code}>
download(req): ReadableStream<Uint8Array>     // 同步返回，start 里开通道并发 {op:'get'}

// 登记表（面板层只有 nodeId，拿不到 GatewayConnection）
registerBulkClient(nodeId, client | null)
getBulkClient(nodeId): BulkClient | null
clearBulkClients()

// 工具
bulkChannelLabel(transferId): string
iterateBulkFrames(Blob | ReadableStream, frameSize): AsyncGenerator<Uint8Array>
class BulkTransferError extends Error { code: string }
```

协议实现要点（与 `apps/gateway/src/mesh/rtc/bulk.ts` 逐字节对齐）：

1. 通道 label `bulk:<transferId>`，`ordered: true`；一次传输一条通道，结束即 `close()`。
2. **控制帧一律文本消息**（`channel.send(JSON.stringify(...))`），**数据帧一律二进制**。据此浏览器侧不用 node 那套「小且以 `{` 开头」的启发式：上传方向入站全是控制帧，下载方向二进制恒为文件内容。
3. 上传：`{op:'put', transferId, size}` → 恰好 64 KiB 的整条二进制消息（末条可短，**不带分片头**）→ `{op:'done'}` → 等 `{ok:true}` / `{ok:false, code}`。
4. 下载：`{op:'get'}` → 逐帧 enqueue → `{op:'eof'}` 关流；`{ok:false, code}` error 流。
5. 背压：`bufferedAmountLowThreshold = 1 MiB`，`bufferedAmount > 4 MiB` 时挂起发送循环，`bufferedamountlow` 唤醒；`send()` 抛异常时先排水再重试一次。
6. abort：`signal` 触发、消费方 `cancel()`、本地越界守卫（源字节多于声明的 `size`、下载帧 > 64 KiB）都会先发 `{op:'abort'}` 再关通道。
7. `open` 15 s 超时；通道未 open 前不发任何控制帧。

**返回值语义**（prompt 里「resolves the node's `{ok}`」与「node `{ok:false}` → rejects」冲突，按签名取前者）：

- node 明确回的 `{ok:false, code}` → **正常 resolve**，调用方据此决定回落；
- 传输层问题（通道打不开 / 中途关闭 / 越界 / 未 active 前先 `{ok:false,'unavailable'}` 之外的异常）→ **reject** `BulkTransferError`；
- 用户取消 → reject `AbortError`。

## 三、面板接线（`bulk-transfer.ts`）

```ts
uploadFileWithTransport(nodeId, rootId, destDir, file, opts, client, deps?): Promise<'direct'|'relay'>
downloadFileWithTransport(nodeId, rootId, path, name, opts, client, deps?): Promise<DownloadedFile & {transferPath}>
```

`opts` = `TransferOpts & { onPath?(path) }`；`deps.resolveBulk` 仅供测试注入，缺省 `getBulkClient(nodeId)`。

**上传**：`POST /api/files/upload/init` → `bulk.upload({transferId: uploadId, size: file.size, source: file})` → `POST /api/files/upload/<id>/commit`（NDJSON，与 REST 路径完全同一套 leg2）。
**下载**：`POST /api/files/download/prepare`（NDJSON）→ `bulk.download({transferId: downloadId})` 收流成 Blob → 交给原 `runtime.host.saveFile`。

回落规则（v1 重试语义）：

| 情况 | 行为 |
|---|---|
| `nodeId === 'self'` | 永不建 bulk，直接 REST |
| 没登记 client / `isAvailable() === false` | 直接 REST |
| init/prepare 失败、bulk 传输失败、node 回 `{ok:false}` | 先 `DELETE` 掉本次会话，再用**原 `uploadFileChunked` / `downloadFileWithProgress` 整次重跑** |
| commit 已开始后失败 | **不回落**，直接上抛 |
| 用户取消（`AbortError`） | 直接上抛，不回落 |

**不会重复 commit**：回落前把 bulk 的 `uploadId` 会话 `DELETE` 掉，REST 路径自己重新 `init` 拿到新的 `uploadId`；同一个 `uploadId` 只可能被 commit 一次，且「commit 之后不回落」这条规则堵死了「bulk 已经 commit 成功再走一遍 REST commit」的重复写入。测试 `node 回 {ok:false} 时整次改走 REST，且只 commit 一次` 逐条断言了调用序列。

进度 UI 未变（仍是两段 leg + 可取消 Toast），只在文件名旁加了一个 `direct` / `relay` 小徽标（`data-testid="transfer-path-badge"`，`title` 为一句话说明）。路径在**选定时**就回调，因此回落时徽标会从 direct 翻成 relay。

## 四、协调者必须接的钩子（本任务 scope 外）

面板只认 `nodeId`，`BulkClient` 需要由建直连控制器的一侧登记。`apps/fe/src/node/node-runtimes.ts` 的 `createNodeConnection` 里，控制器 `start()` 之后加两处：

```ts
import { BulkClient, registerBulkClient } from '@tmex/ws-client';

// 建完 controller 之后
registerBulkClient(nodeId, new BulkClient(controller));

// 包装 dispose 时（现在已经在那里 controller.stop()）
registerBulkClient(nodeId, null);
```

`BulkClient` 只用到 `controller.getState()` 与新加的 `controller.createDataChannel()`，没有别的耦合。**在接上这两行之前，直连文件传输是死代码，行为与改前完全一致（恒走 REST）**。

node 侧还有 `sub/b3-2-result.md` 已经列出的两个钩子（`acceptBrowser` 后把 `bulk:*` 通道喂给 `BulkTransferService`、HTTP 转发带 `requestDispatchContext` 的 uid），不接的话浏览器会收到 `{ok:false, permission_denied}` 并静默回落 REST。

## 五、测试与检查

| 包 | 测试（前 → 后） | tsc | biome |
|---|---|---|---|
| `packages/ws-client` | 140 → **164 pass / 0 fail** | 0 | 本任务文件 clean |
| `packages/panels` | 199 → **212 pass / 0 fail** | 0 | clean |
| `packages/shared` | **282 pass / 0 fail**（i18n 重新生成后） | 0 | 生成物未 lint |
| `apps/fe` | **136 pass / 0 fail**（F4-fix 的红已消） | 0 | — |

`bulk-client.test.ts` 覆盖：Blob / ReadableStream 分帧（含跨 chunk 合并、空源）、`isAvailable` 门禁、happy path（put/整帧/done/`{ok:true}` + 逐帧进度）、默认 64 KiB 帧长、背压 pause→drain→resume、node `{ok:false}`（含传输途中报错即停发、不再发 `done`）、中途 abort 与预先 abort、通道中途关闭、open 超时、oversize 守卫、下载 eof / `{ok:false}` / 未 active / 超尺寸帧 / eof 前关闭 / 消费方 cancel / signal abort、登记表增删。

`bulk-transfer.test.ts` 覆盖：直连时 init→bulk→commit 且**不发 PUT 分块**、两段进度与 `onPath`、`{ok:false}` 回落且只 commit 一次（逐条断言调用序列）、bulk 抛错回落、**commit 阶段失败不回落**、取消不回落、`self` 永不解析 bulk、`isAvailable=false` / 未登记时走 REST、下载 direct（不打 `/content`）、下载失败回收 + 整次 REST、下载取消、下载 `self`。

`packages/ws-client/src/connection.ts` 有一个 biome format 报错，属并发的 F4-fix，未动。

## 六、已知取舍与遗留

1. **node 的控制帧启发式**：node 侧把「≤4096 字节、以 `{` 开头、能解析出字符串 `op`」的二进制消息当控制帧。浏览器把控制帧全部走文本消息，所以正向不受影响；但若文件内容本身是这种小 JSON（末帧），node 会把它吞成控制帧 → 字节数对不上 → 回 `{ok:false, invalid}` → 浏览器整次回落 REST。**不会写坏文件，只会退化成中转**。彻底修需要 node 侧改成「只有文本消息才算控制帧」，属 B3-x。
2. **REST 编排在面板层重写了一遍**：`init` / `commit` / `prepare` 的 NDJSON 解析在 `bulk-transfer.ts` 里各有一份（约 90 行），与 `@tmex/api-client` 的 `upload-transfer.ts` / `download-transfer.ts` 重复。原因是 prompt 的 scope 不含 `packages/api-client`。更干净的做法是给 `uploadFileChunked` / `downloadFileWithProgress` 加一个可注入的「字节段搬运器」钩子，把这两份合并回 api-client——建议后续单开一个小重构。
3. **下载回落会重跑 `prepare`**：prompt 说「回落到 HTTP stream」，但 node 在 abort / 通道中途关闭时会连临时会话一起清掉（`b3-2-result.md` 的清理规则），此时同一个 `downloadId` 的 `/content` 会 404。为保证一定成功，实现选了「回收旧会话 + 整次重跑 REST」，代价是多一次 rsync 拉取。
4. **`apps/fe/src/pages/FilePage.tsx` 的下载仍走纯 REST**：该文件属 F4-fix 的 scope，未动。要让「文件预览页的下载」也吃直连，把那处 `downloadFileWithProgress` 换成 `downloadFileWithTransport(runtime.nodeId, ...)` 即可（已从 `@tmex/panels/files` 导出）。
5. **`TransferToast.setPath` 声明为可选**：`apps/fe/src/pages/FilePage.test.tsx` 里有一个手写的 toast mock，设成必选会让那个 mock 类型不合；调用点统一 `tt.setPath?.(p)`。
6. **单文件单通道**：每次传输开一条 `bulk:*` 通道，没有复用池。node 的 30 s 空闲超时对本实现无影响（浏览器要么在发，要么已经关）。
7. 未碰生产 tmex、名为 `tmex` 的 tmux session，未跑 `bun install`，未执行任何改变状态的 git 命令（唯一一次 `git checkout --` 是撤销 biome 对 `rsync-install-flow.ts` 的顺带 import 排序，把无关文件还原成 HEAD 状态）。
