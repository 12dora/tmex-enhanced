1. **major** — `apps/fe/src/components/global-device-provider.tsx:121`、`apps/fe/src/components/device-connection-status.ts:56`  
   8 秒超时只从 `PendingConnectionRequests` 删除请求。`connectDevice()` 发起时已经把设备加入 `connectedDevices`；网关无响应时，删除 pending 后状态仍会推导为 `connecting`，连接按钮继续被禁用，离线节点的手动连接会永久卡住。应为超时增加独立失败路径：撤销订阅并记录可重试的 error/timeout 状态，同时避免持久化连接意图立即重新订阅。补 fake-timer 测试，覆盖 350ms、8s 无响应及卸载/重挂；现有测试只测纯函数或手动 `settle()`，未执行该 effect。

2. **major** — `apps/fe/src/pages/devices/use-device-folders.ts:141`、`:159`、`:190`  
   `resetLayout` 只防止重复 reset，没有阻止正在执行的 replace/create/delete 等布局写入；`cancelQueries()` 也不会取消 mutation。恢复默认布局与旧 PUT/POST 乱序完成时，旧 mutation 的 `onSuccess`/`onError` 可重新写入布局缓存，创建请求还可能在 reset 后重新生成分组，最终状态不再是默认布局。应把所有布局写操作放入同一串行 mutation scope/队列，或用统一 busy 状态双向禁止并发，并在最终 settled 后重新拉取服务端布局。补受控 Promise 测试验证逆序完成，以及确认框 cancel/confirm 只触发预期请求。

3. **minor** — `apps/fe/src/pages/devices/device-snapshot-store.ts:46`、`:57`、`:89`  
   快照按节点永久创建键，但 `clearDeviceSnapshot()` 在生产代码中从未调用，也没有索引、TTL 或数量上限。被移除节点的快照会无限残留；达到配额后写入只是静默失败，旧快照继续存在，之后所有节点都可能长期显示过期设备列表。应维护带更新时间的快照索引，在权威 mesh 列表加载后清理已删除节点，并采用 TTL/LRU 上限；配额失败时仅淘汰本应用最旧快照并重试。补 stale-node 清理和 `setItem` 抛配额异常的测试。

4. **minor** — `apps/fe/src/pages/DevicesPage.test.tsx:234`、`apps/fe/src/pages/devices/device-folders-view.test.tsx:175`  
   “ready↔offline 保持 NodeRuntimeScope 挂载”没有生命周期回归测试；现有测试使用静态 SSR，分别验证离线输出，effect 不执行，也无法发现运行时被卸载重建、查询缓存丢失或连接被释放。应使用可重渲染的测试宿主，记录 `NodeRuntimeScope` mount/unmount，执行 ready→offline→ready，并断言组件实例和运行时引用保持不变。