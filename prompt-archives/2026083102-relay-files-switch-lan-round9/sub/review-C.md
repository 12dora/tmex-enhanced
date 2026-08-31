## 1. Blockers

### 1. 候选在选出 winner 前已修改全局链路状态，loser 可能关闭真正的 winner

位置：[apps/gateway/src/mesh/peer-manager.ts:1547](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:1547)、[apps/gateway/src/mesh/peer-manager.ts:1635](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:1635)

`dialDirect()` 在返回给竞速逻辑前已经执行 `track()` 和 `rememberKeys()`。然而 `track()` 不保证返回当前候选：存在同等级 live 链路时，它可能 park 当前候选并返回既有 session。随后 loser 分支无条件关闭这个返回值：

```ts
if (winner ...) {
  session.close('ws-race-lost');
}
```

具体失败场景：

1. A、B 两个 endpoint 的握手 Promise 在同一事件循环轮次完成。
2. A 的 `dialDirect()` 先安装 session A，但外层 `.then()` 尚未执行 winner 选举。
3. B 的 `track()` 看到尚未声明 quiesce 能力的 A，将 B park，并返回 session A；`rememberKeys()` 还会把 B 的密钥写到 A 上。
4. A 被选为 winner。
5. B 的 loser 回调关闭其返回值——也就是 session A。
6. `getLink()` 最终可能返回已关闭的 session，live 链路被异常切换，且 session key 与实际链路不匹配。

这也可能发生在已有 inbound/relay 链路与 endpoint 竞速重叠时。

最小修复：让单 endpoint 拨号只返回“已认证但尚未 track 的候选及其密钥”；在 `raceWsSecureEndpoints()` 中先原子选出 winner，再只对 winner 调用 `track()`/`rememberKeys()`，loser 只关闭其自己的握手 session。补一个两个成功握手在同一轮完成的确定性测试，并断言返回 session、live session、密钥均属于同一候选。

### 2. 被中止的异步 `wsFactory` 结果无人接管，会泄漏 socket

位置：[apps/gateway/src/mesh/peer-manager.ts:1597](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:1597)

`abortable()` 只让包装 Promise 提前 reject，不会取消原始 Promise，也不会处理它之后产生的资源。`wsFactory` 的类型明确允许返回 Promise。

具体失败场景：

1. endpoint A 成功并触发 `child.abort()`，或者 `stop()` 中止整个竞速。
2. endpoint B 正在等待异步 `wsFactory`。
3. `abortable()` 立即 reject，B 的拨号流程结束。
4. B 的 factory 随后解析出一个已建立或正在连接的 WebSocket。
5. 由于局部变量 `ws` 从未获得该值，没有任何代码关闭它；每次竞速或停止都可能留下 socket。

现有 “late handshake” 测试也使用了延迟解析的 `wsFactory`，但只断言没有安装 live 链路，没有验证返回的 transport 已关闭。

最小修复：保留原始 factory Promise，并给迟到结果挂接清理逻辑；若 signal 已中止，解析出的 transport 必须立即关闭。新增 winner abort loser 和 `stop()` 两种测试，分别让 factory 在中止后解析，并断言两端均关闭。

## 2. Should fix

### 1. `directFailure` 会混入上一次尝试的原因，且 relay 后台升级会跳过 DC 记录

位置：[apps/gateway/src/mesh/peer-manager.ts:1421](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:1421)、[apps/gateway/src/mesh/peer-manager.ts:2432](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:2432)

`recordDirectFailure()` 总是从旧记录补齐未提供字段；同时，已有 relay 链路时，`liveOf` 会在第 1435 行直接返回，导致本次 DC 结果尚未写入。

具体场景：上一次记录为 `dc: direct_capable=false`；节点随后开始支持 DC，本次 DC 以 `ice-timeout` 失败，WS 也失败。WS 记录会沿用旧的 `direct_capable=false`，随后 `liveOf` 返回现有 relay，新的 DC 错误永远不会写入。REST 因而把旧原因和本次时间戳组合成一条虚假的“最近一次尝试”。

最小修复：每次 `dial()` 建立独立的 attempt 记录，在该次流程内收集 WS/DC 结果，并在返回现有 relay 或新建 relay前统一提交；不要跨 attempt 合并旧字段。直连成功继续清空失败记录。应覆盖“已有 relay → 能力变化 → 后台升级失败”的测试。

### 2. `/api/mesh/nodes` 新增了平方级 peer-cache 全表查询

位置：[apps/gateway/src/mesh/peer-manager.ts:533](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:533)、[apps/gateway/src/mesh/mesh-routes.ts:215](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/mesh-routes.ts:215)

`collectNodes()` 已经一次性构建 `peerById`，但随后每个节点调用 `linkDetailOf()`，而后者再次执行 `listPeers().find(...)`。`listPeers()` 会读取并转换整张 `peer_cache`，因此 N 个节点产生 N 次全表读取，整体为 O(N²)。

最小修复：至少改用已有的 `userStore.getPeer(nodeId)` 主键查询；更直接的做法是让投影层继续使用已经构建的 `peerById` 提供 endpoints，避免 `linkDetailOf()` 再查数据库。

## 3. Nits

无。

定向测试结果：149 pass、8 fail。8 个失败均发生在 `Bun.listen`/`Bun.serve`，错误为只读沙箱禁止监听端口的 `EPERM`/`EADDRINUSE`；没有观察到断言失败，但两个依赖真实 socket 的新增竞速测试在该环境下未能执行。