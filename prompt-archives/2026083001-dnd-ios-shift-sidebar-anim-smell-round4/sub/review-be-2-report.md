# 代码审查报告

## MAJOR

1. [apps/gateway/src/mesh/stream-targets.ts:403](/Users/konata/code/tmex-enhanced-wt-r4/apps/gateway/src/mesh/stream-targets.ts:403) — 收到响应头后，`finally` 无条件中止并取消请求体 reader；`pumpToLink` 随后因 `stopped()` 为真而不会调用 `stream.end()`，正常的 `cancel()` 也不会触发 `onError` 中的 RST。触发场景是上游在有限但尚未上传完成的请求体之前提前返回响应，例如未读取完整上传就返回 4xx。旧实现会继续上传至 EOF 并发送 END；新实现会永久留下未关闭的发送半流，导致远端 `LinkStream.closed` 不完成，并持续占用 PeerManager 的并发流计数。取消上传时必须显式 reset/end，或者允许 pump 完成半关闭。

2. [apps/gateway/src/mesh/stream-pump.ts:20](/Users/konata/code/tmex-enhanced-wt-r4/apps/gateway/src/mesh/stream-pump.ts:20) — 通用 pump 丢弃了零长度但 `head: true` 的合法 DATA 帧。`LinkStream.write(new Uint8Array(0), { head: true })` 明确会发送 HEAD 帧，旧 `copyDirection` 也无条件保留该标记；新代码因为 `bytes.byteLength` 为零而跳过写入。任何通过 relay 发送空 HEAD 的流都会在目的端丢失消息边界，例如目的端等待 HEAD 时只收到 END 并报“closed before response head”。判断条件应允许 `head` 为真时写入零长度 payload。

3. [apps/gateway/src/mesh/auth-routes.ts:656](/Users/konata/code/tmex-enhanced-wt-r4/apps/gateway/src/mesh/auth-routes.ts:656) — passkey verifier 异常虽然被移出了局部“坏签名”捕获边界，但仍会被 [apps/gateway/src/mesh/auth-routes.ts:255](/Users/konata/code/tmex-enhanced-wt-r4/apps/gateway/src/mesh/auth-routes.ts:255) 的外层 catch 转换成 `MALFORMED` 400，并计入客户端失败次数。触发场景包括断言验证成功后 `updateKeyCounter` 数据库写入抛错。该状态是服务端故障，不应被归类为客户端请求畸形或推动登录限流；当前改动也没有真正实现预期的错误边界。应让 verifier 的运行时/存储异常进入 5xx 路径，仅将解码或验证返回 false 映射为客户端错误。

## 总体结论

未发现 BLOCKER，但存在 3 个应在合并前修复的 MAJOR：一个会泄漏提前响应请求的半关闭流，一个会改变 relay 的帧语义，另一个错误地把 passkey 存储故障归咎于客户端。因此当前版本不建议合并。