发现 **13 项确定问题**。跨文件问题列出了实际故障位置，包含 backend diff 与 mesh、前端的契约不匹配。

1. **blocker — pane 移出后，异步屏幕／历史请求仍泄露内容**  
   [share-metadata-filter.ts:110](/Users/konata/code/tmex-r29/apps/gateway/src/ws/share-metadata-filter.ts:110)，关联 [canonical-feed-session.ts:613](/Users/konata/code/tmex-r29/apps/gateway/src/ws/canonical-feed-session.ts:613)。  
   请求开始时检查归属，但 `captureCanonicalScreen()`／`readPaneHistory()` 返回后不复核；出站只过滤 `PaneData`，屏幕和历史事务全部放行。已用实际类内存复现：等待期间将 pane 移出，接收者仍收到移出后的内容。  
   **最小修复：**异步读取完成后、发送事务前重新检查 scope；移出时取消相关请求及待发送事务。

2. **major — standalone 开放模式将分享连接升级为普通连接**  
   [mesh-http.ts:232](/Users/konata/code/tmex-r29/apps/gateway/src/mesh/mesh-http.ts:232)。  
   未启用本地认证时，开放认证分支在读取分享 cookie 前直接放行，连接没有 `shareScope`，也不进入分享撤销索引。分享创建接口仍允许该配置，因此访客可访问其他终端，撤销也不会关闭此连接。全站开放权限原已存在，但新增分享功能在此配置下无法兑现隔离承诺。  
   **最小修复：**禁止在未启用认证的开放部署中创建分享，返回明确错误；若要支持，需提供强制隔离的入口，不能仅调整 cookie 优先级。

3. **major — Hub 上失效 cookie 阻断重新登录和退出**  
   [stream-auth.ts:44](/Users/konata/code/tmex-r29/apps/gateway/src/mesh/stream-auth.ts:44)。  
   Hub 给分享公开接口附带已有 cookie；验证失败立即拒绝，没有匿名回退。分享 A 撤销后，残留的 HttpOnly cookie 会让同节点分享 B 的 GET、login、logout 全部失败，页面无法自行恢复。  
   **最小修复：**对分享公开 HTTP 路径，将失效凭证降为匿名请求并清除失效 cookie；WS 继续拒绝。

4. **major — Hub 首次 WS 鉴权失败丢失 4401**  
   [stream-targets.ts:458](/Users/konata/code/tmex-r29/apps/gateway/src/mesh/stream-targets.ts:458)。  
   无效分享凭证执行 `reset('share_invalid')`，未编码终态关闭码。Hub 将其当作普通传输失败并尝试切换链路；前端只处理 4401／4410，因此无法回到密码页，会继续重连。  
   **最小修复：**使用 `encodeTerminalStreamClose(4401, 'SHARE_LOGIN_REQUIRED')`。

5. **major — 经同一 Hub 的所有访客共用限流桶**  
   [share-access-routes.ts:62](/Users/konata/code/tmex-r29/apps/gateway/src/share/share-access-routes.ts:62)，关联 [mesh-runtime.ts:993](/Users/konata/code/tmex-r29/apps/gateway/src/mesh/mesh-runtime.ts:993)。  
   节点收到的来源地址固定为 `peer:<hubId>`，实际浏览器 IP 没有传递。因此一个访客输错十次，其他 IP 即使输入正确密码也会被锁定。  
   **最小修复：**通过已认证的 peer 上下文传递 Hub 可信解析的浏览器 IP，或在 Hub 按分享和真实来源 IP 限流；不要直接信任用户提交的转发头。

6. **major — 并发登录绕过失败次数限制**  
   [share-service.ts:313](/Users/konata/code/tmex-r29/apps/gateway/src/share/share-service.ts:313)。  
   限流检查发生在异步密码验证前，计数只在验证失败后增加。并发请求全部可以通过检查，形成超额猜测并消耗 Argon2 资源。内存复现中，同一分享和 IP 的 100 个请求全部进入验证。  
   **最小修复：**在验证前预占尝试额度，或按分享和 IP 串行验证并在实际开始前重新检查；同时限制等待队列。

7. **minor — 永久分享续期没有更新浏览器 cookie**  
   [share-service.ts:279](/Users/konata/code/tmex-r29/apps/gateway/src/share/share-service.ts:279)，关联 [share-access-routes.ts:53](/Users/konata/code/tmex-r29/apps/gateway/src/share/share-access-routes.ts:53)。  
   验证只延长数据库 token 的期限；只有 login 返回设置 cookie 的响应头。浏览器仍在首次登录七天后删除 cookie，持续使用也无法保持登录。  
   **最小修复：**公开 HTTP 验证成功时同步返回 cookie 续期头，并让活跃分享页定期刷新；本机和 Hub 都消费这些响应头。

8. **minor — 元数据补丁泄露未共享 pane 的 ID 和活动**  
   [share-metadata-filter.ts:88](/Users/konata/code/tmex-r29/apps/gateway/src/ws/share-metadata-filter.ts:88)。  
   所有越界 pane upsert 都转换为 removal，原始 pane removal 又全部放行。即使某个 pane 从未属于共享窗口，其 ID 和变化时序仍会发送给接收者。  
   **最小修复：**跟踪实际下发过的实体，仅为曾暴露、现已移出的 pane 发送 removal；其他变化丢弃，保留空 patch 维持 revision 连续。

9. **minor — pane 移出后仍保留 active／hot 订阅**  
   [canonical-feed-session.ts:230](/Users/konata/code/tmex-r29/apps/gateway/src/ws/canonical-feed-session.ts:230)。  
   metadata 更新只发送补丁，不重新过滤 lease。移动 pane 不改变其 ID／epoch，原订阅会持续保留，继续处理输出并占用设备级配额，违反“移出即撤销订阅”的契约。  
   **最小修复：**metadata patch／rebase 后按最新 scope 清理 lease、待发批次和相关任务，不依赖客户端主动重新订阅。

10. **minor — 第十次失败后没有锁满十五分钟**  
    [share-rate-limit.ts:33](/Users/konata/code/tmex-r29/apps/gateway/src/share/share-rate-limit.ts:33)。  
    解锁时间从最早一次失败计算。例如第一次失败后等待十四分五十九秒，再失败九次，只锁一秒；已内存复现。  
    **最小修复：**达到十次时单独记录 `lockedUntil = now + 15min`，与失败统计窗口分开维护。

11. **minor — 结束分享会丢弃最后一批录屏数据**  
    [share-service.ts:204](/Users/konata/code/tmex-r29/apps/gateway/src/share/share-service.ts:204)。  
    先将记录改为 `ended`，再停止 recorder；停止时刷出的缓冲数据被 `appendLog()` 的 active 检查拒绝。正常情况下会丢失最后约 250 ms 的输入／输出。已复现最后一次输入在撤销后消失。  
    **最小修复：**在标记结束前同步刷出缓冲区，再更新状态、关闭连接并释放 recorder。

12. **minor — 设备查询失败会覆盖成功的侧栏缓存**  
    [sidebar-device-list-runtime.tsx:138](/Users/konata/code/tmex-r29/apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx:138)。  
    回写只排除 pending。首次查询失败后，查询状态为非 pending、非 placeholder，设备数组变成空数组，随后覆盖已有成功快照；一次网络故障就会使离线和下次首屏丢失设备列表。  
    **最小修复：**仅在查询成功且不是 placeholder 时回写，至少将 `stats.failed` 纳入守卫。

13. **minor — 无截止时间的熔断提示显示原始插值**  
    [direct-failure-codes.ts:74](/Users/konata/code/tmex-r29/apps/gateway/src/mesh/direct-failure-codes.ts:74)。  
    `coolingUntil=null` 时仍返回 `breaker_cooling`，但没有 `until` 参数；三种语言的模板均要求 `{{until}}`。永久禁拨状态可实际进入该分支，显示“暂停至 {{until}}”。  
    **最小修复：**无截止时间时使用独立的“直连已暂停”翻译键；仅有截止时间时使用现有模板。

验证方面，分享服务、存储、录屏和限流的现有测试 **46 项通过**；上述部分缺陷另以 Bun 内存复现。升级下载进度和 abort-signal 改动未发现确定回归。正确建立的分享连接，其撤销链路在三种 peer 传输中共用 4410 关闭实现；这是代码核查结论，未做真实传输实测。

**Optional hardening**

- [share-session-index.ts](/Users/konata/code/tmex-r29/apps/gateway/src/ws/share-session-index.ts) 未保存 `onEnded()` 返回的解绑函数。建议增加 dispose，解除监听并清理 viewer counter，避免未来同进程重建服务时保留旧实例；当前未确认生产路径存在这种重建，因此不列为确定泄漏。