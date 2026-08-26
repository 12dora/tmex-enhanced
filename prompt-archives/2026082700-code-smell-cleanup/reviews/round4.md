### 1. [Medium｜Confident] 合法 WebSocket 请求的处理器异常被伪装为 payload 解码失败

位置：[apps/gateway/src/ws/index.ts:307](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/index.ts:307)、[borsh-dispatcher.ts:327](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/borsh-dispatcher.ts:327)

`dispatchBorshKind()` 解码后继续 `await handler.handle(...)`，而调用方用同一个 `catch` 包住整个过程。任何非 `WsBorshError` 的运行期处理错误都会被转成 `ERROR_PAYLOAD_DECODE_FAILED`。

旧 switch 实现不会把普通 handler 异常归因于客户端 payload；现在服务端故障会被吞掉且不记录原始错误，并向客户端返回不可重试的“Payload decode failed”。

验证：发送合法 `DEVICE_DISCONNECT` payload，并令 handler 抛出 `Error('boom')`。当前实现返回 `KIND_ERROR`、code `1004`、message `Payload decode failed`、refSeq `42`。应增加“合法 payload＋handler reject”的测试，区分解码失败与处理失败。

### 2. [Medium｜Confident] API 路由测试没有验证生产路由表的优先级和选择性解码

位置：[apps/gateway/src/api/route.test.ts:17](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/api/route.test.ts:17)、[route.test.ts:70](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/api/route.test.ts:70)、生产组装入口 [index.ts:24](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/api/index.ts:24)

测试手写了一份局部路由表并调用生产分派未使用的 `matchRoute`，因此生产 `apiRoutes` 漏项、错序或 method/path 写错时仍会全绿。“固定 `/order` 优先于 `:id`”用例分别使用 `PUT` 和 `GET`，交换这两个路由也不会改变结果，实际没有验证二者的路径优先级。

参数测试也只断言 `matchPath` 保留编码；删除 Telegram chatId/微信 userId 的 `decodeURIComponent`，或错误解码 botId/accountId，测试仍会通过。

验证：修改生产路由顺序或删除真实解码调用，现有测试不失败；应通过 `handleApiRequest` 对真实冲突路径和 percent-encoded 标识符进行入口测试。

### 3. [Low｜Confident] site-settings 聚合测试会在漏接四组 normalizer 时继续通过

位置：[apps/gateway/src/api/site-settings.test.ts:19](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/api/site-settings.test.ts:19)、[site-settings.ts:128](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/api/site-settings.ts:128)

名为“composes per-section normalizers”的测试只通过聚合入口覆盖 `siteName` 和 `language`；其余测试直接调用拆分后的 helper。删除 throttle、notification toggles、SSH reconnect 或 disabled channels 的聚合调用，整份测试仍会通过，而真实 PATCH 会静默忽略对应字段。

验证：临时删除 `site-settings.ts:131-135` 中任一上述调用并运行该测试文件。

### 4. [Low｜Confident] `WebSocketServer` 的公开可写实例字段变成 getter-only 属性

位置：[apps/gateway/src/ws/index.ts:76](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/index.ts:76)

`connections`、`pendingConnectionEntries`、`windowCustomNames` 和 `paneCustomNames` 在基线中是公开、可重新赋值的 own fields；现在变成没有 setter 的 prototype getters。旧调用方替换整个 Map 时会得到 TypeScript 只读错误，并在严格模式下产生 `TypeError`；`Object.hasOwn()` 和枚举语义也发生变化。

仓内没有发现依赖这些赋值或反射语义的调用方，因此评为低风险。可通过对比基线与 HEAD 的字段赋值及 `Object.hasOwn(instance, 'connections')` 验证。