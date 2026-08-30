# 审查报告

## MAJOR

1. [`apps/gateway/src/hub/hub-runtime.ts:504`](/Users/konata/code/tmex-enhanced-wt-r4/apps/gateway/src/hub/hub-runtime.ts:504) 将所有 redeem 内部异常错误地转换为 HTTP 400。

   新的外层 `catch` 覆盖了数据库访问、事务执行以及事务提交后的 `redeemSuccessPayload()`。例如 enrollment token 已在事务中消费后，若 `keyLogSource.list()` 因数据库故障抛错，接口会返回 `{ error: <内部异常消息> }` 和 400；客户端因此收到“请求无效”，但服务端状态已经提交。旧代码仅把已知 `RedeemAbort` 转成协议响应，未知异常会继续抛出。这里既改变了错误码和消息，又可能泄漏内部错误。应只捕获请求解析错误和 `RedeemAbort`，其余异常继续抛出。

## MINOR

1. [`apps/gateway/src/mesh/auth-routes.ts:650`](/Users/konata/code/tmex-enhanced-wt-r4/apps/gateway/src/mesh/auth-routes.ts:650) 扩大的 `try/catch` 改变了 passkey verifier 异常的协议结果。

   当 `verifyDelegationPasskey` 拒绝 Promise，例如验证成功后更新 credential counter 时数据库写入失败，新代码在第 659 行将其当作 `DELEGATION_BAD_SIGNATURE`，返回 401；旧代码只捕获 assertion 解码错误，verifier 异常会进入 `handleLogin` 的外层异常路径，返回 `MALFORMED` 400。这是可观察的错误码回归，也把存储故障伪装成签名失败。应把 `await this.verifyPasskey(...)` 移出仅用于解码的 `try/catch`。

验证方面，auth、TLS、hub/init CLI 和 runtime 路由相关测试共 69 项全部通过。其余定向测试中，两个 enroll 测试因环境无法监听本地端口而失败；hub-runtime 测试受 diff 外的 `tryDecodeRecord is not defined` 影响，均未作为本次 finding。

总体结论：编解码去重、TLS upsert 和大部分拆分保持了原行为，但 redeem 的异常边界会在已提交状态后返回错误的 400 响应，属于合并前应修复的行为回归；建议修改后再合并。