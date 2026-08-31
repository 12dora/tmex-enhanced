## 结论

未发现 Blocker。发现 4 项 Should-fix、1 项 Nit。

### Should-fix

1. 本机 Mesh 路径没有稳定保持 `/api/system/upgrade` 的 403/409 优先级  
   [upgrade-service.ts:71](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/system/upgrade-service.ts:71)、[upgrade-service.ts:158](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/system/upgrade-service.ts:158)

   本机请求先查询 GitHub latest，随后先判断 already-latest，最后才检查 `canSelfUpdate` 和控制器并发状态。因此：

   - `canSelfUpdate=false` 且已经是最新版时返回 `409 UPGRADE_ALREADY_LATEST`，而不是要求的 `403 UPGRADE_NOT_ALLOWED`。
   - `canSelfUpdate=false` 且 GitHub 不可用时返回 502，而不是 403。
   - 已有升级进行中且 GitHub 不可用时返回 502，而不是 `409 UPGRADE_IN_PROGRESS`。

   应在本机路径解析 latest 前检查 `canSelfUpdate` 和当前控制器状态；获取 latest 后仍保留 `start()` 的原子并发检查，防止检查与启动之间的竞态。

2. prerelease 版本比较会把旧版本误判为已经最新  
   [upgrade-service.ts:33](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/system/upgrade-service.ts:33)、[semver.ts:32](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/system/semver.ts:32)

   不可解析版本已经正确返回 `false`，但 `compareVersions` 对 prerelease 使用整串字典序。例如：

   ```text
   current = 1.2.3-beta.2
   latest  = 1.2.3-beta.10
   ```

   当前结果是 `isAlreadyAtOrAboveLatest(...) === true`，导致合法升级被 `409 UPGRADE_ALREADY_LATEST` 阻止。版本格式明确允许 prerelease，因此需要按 SemVer 的逐段规则比较，其中纯数字标识符按数值比较。

3. 409 映射允许上游覆盖稳定的 `code` 和 `nodeId`  
   [upgrade-service.ts:151](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/system/upgrade-service.ts:151)、[session-middleware.ts:209](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/mesh/session-middleware.ts:209)

   `readJsonObject()` 的全部字段被展开到 `jsonError()` 的 `extra` 中，而 `jsonError()` 构造的是 `{ code, ...extra }`。远端返回：

   ```json
   {
     "code": "UPGRADE_ALREADY_LATEST",
     "nodeId": "spoof",
     "state": "executing"
   }
   ```

   入口节点最终会原样输出伪造的 `code/nodeId`。这破坏稳定错误映射，前端还可能把真实的并发冲突误当作“已经最新”。

   应只复制 `state`、`targetVersion`、`error`、`startedAt` 等白名单字段，禁止上游覆盖本地 `code/nodeId`。

4. 远端响应正文处理没有大小边界，且 info 读取失败后继续执行 POST  
   [upgrade-service.ts:141](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/system/upgrade-service.ts:141)、[upgrade-service.ts:184](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/system/upgrade-service.ts:184)、[upgrade-service.ts:212](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/system/upgrade-service.ts:212)、[stream-targets.ts:385](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/mesh/stream-targets.ts:385)

   - info 和 409 正文通过 `Response.json()` 无上限缓冲；异常或恶意节点可返回超大/不结束的 JSON，占用入口节点内存。
   - 403/404 被替换成本地响应时没有取消上游正文。底层响应流会主动持续读取并入队，不能依赖丢弃 `Response` 及时释放。
   - `/api/system/info` 返回 200 后若正文截断、解析失败或不是对象，`readJsonObject()` 返回 `{}`，随后仍会发送破坏性的升级 POST，绕过此次 preflight 的 already-latest 判断。

   应使用有上限的 JSON 读取器；替换响应时显式取消上游正文；info 200 的正文读取失败、超限或结构非法时应失败关闭，例如返回 `503 NODE_UNREACHABLE`，而不是继续 POST。

### Nit

1. 服务端会返回共享类型未声明的 `NOT_FOUND`  
   [upgrade-service.ts:62](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/system/upgrade-service.ts:62)、[system.ts:73](/Users/konata/code/tmex-enhanced-wt-r10/packages/shared/src/contracts/system.ts:73)

   未登记或已撤销节点正确返回 `404 NOT_FOUND`，但 `MeshUpgradeErrorCode` 不包含该值。节点在页面展示后被撤销时，客户端会收到契约外错误码。应把 `NOT_FOUND` 加入类型及客户端映射，或改用一个已声明的稳定码。

## 已确认正确

- 三条路由均经过本地 `requireSession`。
- POST 不读取客户端版本；具体版本由服务端 latest Release 解析。
- 远程请求只把 `tmex_s_<targetNodeId>` 的值放入 stream `auth`，不会转发入口 cookie 或 Authorization。
- 固定转发路径只有 `/api/system/info` 和 `/api/system/upgrade`，未进入 `/api/mesh-internal/*`。
- 未登记、已撤销节点在转发前被拒绝；`PeerManager.getLink()` 还会再次校验证书信任状态。
- POST 的转发尝试数固定为 1；GET 最多重试 4 次，且不带请求体，重放安全。
- `/api/system/update-check` 的字段、tarball 判断和 502 行为在抽取前后等价。
- `/api/system/upgrade` 自身的成功、403、409 响应形状未发现抽取回归。

验证命令通过：5 个相关测试文件共 `120 pass / 0 fail`。