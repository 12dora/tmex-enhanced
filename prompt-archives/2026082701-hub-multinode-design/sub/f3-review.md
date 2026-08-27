## blocker

1. `apps/fe/src/node/node-runtimes.ts:188` — bulk 客户端已在直连激活后注册，但 node 侧没有接收 `bulk:*` DataChannel 的生产接线。

   `BulkTransferService` 当前只在测试中构造；`RtcPeerManager.acceptBrowser()` 返回的已授权 `{pc, uid}` 没有安装 `pc.onDataChannel` 路由。实际上传时通道可以正常 `open`，但 node 会忽略 `{op:'put'}`，既不回复 `{ok}` 也不关闭通道；下载同样收不到首帧，面板永久等待，且不会回落 REST。建议在 `acceptBrowser` 成功后，仅在该已授权 PeerConnection 上将 `bulk:*` 通道交给 `BulkTransferService.attachChannel(dc, {uid: accepted.uid})`，并补一条真实接线测试，确保 uid 只能来自授权结果，不能来自 label、REST 参数或浏览器消息。

## major

1. `packages/ws-client/src/carrier-switch.ts:232` — `CARRIER_SWITCH` 只按 session 级 epoch 判断，没有绑定当前 direct attempt。

   attempt A 关闭后会启动 attempt B；如果 primary 拥塞导致 A 的旧 `to:'direct'` 帧延迟到 B 已经 `attachDirect()` 后才到达，这里会把该旧帧应用到 B，并触发控制器把 B 提前标为 `active`。随后终端帧或 bulk 通道可能在 B 的 nonce 尚未被 node 接受时发送，造成输入丢失或 bulk 被未安装处理器的 PeerConnection 吞掉。建议在切换帧中携带 `rtcSession`/carrier generation，并由 `attachDirect` 登记期望值，只接受与当前 carrier 匹配的切换；相应 ACK 也应回显该标识。

2. `packages/ws-client/src/direct/bulk-client.ts:399`、`packages/ws-client/src/direct/bulk-client.ts:496` — 只有 DataChannel `open` 超时，没有请求回复或传输空闲超时。

   新前端连接旧版本 node，或当前缺少 bulk 接线的 node 时，DCEP 通道仍会成功打开，但对端不会回复 `{ok}`、数据或 `{op:'eof'}`；上传会永久停在 `replyPromise`，下载流也永久不结束，因此“bulk 失败后整次回落 REST”不会发生。建议增加操作级空闲超时，在每个合法数据帧或控制帧到达时续期；超时发送 abort、关闭通道并以 `BulkTransferError('timeout')` 结束，使面板清理旧 transferId 后重新走 REST。也可结合节点能力协商，未声明 bulk 能力时直接使用 REST。

3. `packages/ws-client/src/direct/data-channel-carrier.ts:90` — 入站 sess 分片上限错误地取了 `Math.max(64 KiB, sctp.maxMessageSize)`。

   `RTCSctpTransport.maxMessageSize` 描述本端可发送给对端的大小，不应放宽协议规定的入站 64 KiB 上限。常见值为 256 KiB、甚至可能为 `Infinity`；此时目标 node 发送超大单条消息不会触发 `chunk-too-large`，重组器还会先复制 payload，破坏本次修复要求的 64 KiB 硬边界并放大内存占用。建议入站重组器始终使用 `MAX_DC_MESSAGE_BYTES`；协商值只用于计算出站 `effectiveFragmentPayloadSize`。

4. `packages/panels/src/files/bulk-transfer.ts:275` — bulk 下载没有核对实际接收字节数与 `prepare` 返回的 `size`。

   node 若提前发送 EOF，当前代码会把截断 Blob 当作成功文件保存；若持续发送超过声明大小的数据，则会无限向 `chunks` 追加，进度超过 100%，最终可耗尽页面内存。建议累计实际字节数：任何一帧令总数超过 `size` 时立即 `reader.cancel()` 并回落 REST；EOF 后若总数不等于 `size` 也应视为 bulk 失败，清理旧 downloadId 后重新 prepare。

## minor

1. `packages/panels/src/files/bulk-transfer.ts:173`、`packages/panels/src/files/bulk-transfer.ts:242` — cleanup 期间发生取消时会抛出原始传输错误，而不是 `AbortError`。

   例如 DataChannel 先报 `closed`，代码开始等待 DELETE 清理，此时用户点击取消；清理结束后 `signal.aborted` 为真，但抛出的仍是原来的 `BulkTransferError`。当前 UI 因额外检查 signal 尚能显示“已取消”，但导出的传输 API 不满足其取消语义，其他调用方按 `err.name === 'AbortError'` 判断会失败。建议当 `signal?.aborted` 时显式抛出标准 `AbortError`，仅在原错误本身已经是 AbortError 时原样抛出。

## 结论

RFC 8122 作用域解析、attempt 基本隔离、屏障阶段与容量限制、出站整帧排队、信令排序、切换后激活、断线回退和 REST 双 commit 防护总体已落实，但 bulk 的生产接线目前缺失，直连文件传输实际会挂死；同时切换帧未绑定 attempt、bulk 缺少超时和下载字节边界、sess 入站分片上限仍有错误。当前 diff 不应合入，至少需先修复 blocker 和全部 major。