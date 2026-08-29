## 高严重度

1. `packages/panels/src/device-management/device-form.ts:22`  
   **问题：** 将 SSH 设备的 `authMode='auto'` 无条件归一为 `agent`。  
   **为什么：** 两种模式并不等价。`resolveSshConnectConfig()` 中，`auto` 会依次使用 Agent、已保存私钥和密码；`agent` 则只走 Agent，并可能在没有 `SSH_AUTH_SOCK` 时直接失败。用户只要编辑并保存一台历史 `auto` 设备，`buildUpdatePayload()` 就会把模式永久改成 `agent`，原本依靠加密私钥或密码连接的设备随即无法连接。  
   **建议修法：** 保留原始 `auto` 值，并在认证方式下拉中提供对应选项；不要在表单初始化时做有损映射。补充“编辑并保存 `auto` 设备仍提交 `auto`”的回归测试。

2. `packages/panels/src/device-management/device-management-panel.tsx:87`  
   **问题：** 远端节点面板没有传入 `nodeContext`，但缺省上下文固定为 `isSelf: true`。现有调用点 `apps/fe/src/pages/devices/node-device-group.tsx:211` 仅把面板放进 `NodeRuntimeScope`，没有提供节点名称和 `isSelf`。  
   **为什么：** 所有远端节点中的设备都会被识别成普通 `local`/`ssh`，不会显示 `nodeLocal`/`nodeSsh`、远端角标和远端信息区块，节点名称也为空。新加的“真实设备种类”在主要的多节点页面上实际没有生效。  
   **建议修法：** `NodeDeviceGroup` 必须显式传入 `{ runtimeNodeId, name, isSelf }`；或者让面板要求必传上下文，避免把任意非 `self` runtime 默认判成本机。

3. `packages/panels/src/device-management/device-management-panel.tsx:194`  
   **问题：** 新增的真实连接开关依赖可选 `connection`，但所有 `DeviceManagementPanel` 生产调用点都没有传入该属性，包括 `DevicesPage.tsx:20、47` 和 `node-device-group.tsx:211`。  
   **为什么：** `DeviceCardConnectToggle` 只在 `connection` 存在时渲染，因此当前实际页面始终退化为单纯的“打开”链接；提交中宣称的连接/断开功能只能在直接渲染组件的测试里出现。  
   **建议修法：** 在 `GlobalDeviceProvider` 内增加宿主包装组件，通过 `useGlobalDevice()` 取得当前 runtime 的 adapter，并连同正确的 `nodeContext` 传给面板；为 standalone 和远端节点页面各补一条集成测试。

## 中严重度

4. `apps/gateway/src/api/device-routes.ts:157`  
   **问题：** 删除设备与删除其 folder placement 是两个独立数据库操作，而且成功后只广播了 `devices`，没有广播 `device-folders`。  
   **为什么：** 如果第二个操作失败，设备已经永久删除但 placement 仍在，接口还会返回 500，无法回滚。即使两步都成功，当前及其他客户端缓存的文件夹布局仍保留旧 placement；随后任意一次基于旧缓存的整体布局 PUT 又会把该 placement 插回数据库。对于远端设备问题更明显：布局按契约存放在 entry 节点，而删除请求运行在远端节点数据库，当前仅删除 `nodeId='self'` 的 helper 根本无法清理 entry 上的远端 placement。  
   **建议修法：** 对本机设备提供一个数据库事务，同时删除设备和 self placement，并在成功后广播 `devices` 与 `device-folders`。远端设备删除成功时，还需要由 entry 侧显式移除对应 `{nodeId, deviceId}` placement，或提供可补偿的 entry 布局清理操作；客户端也应立即失效中央 `device-folders` 查询。

## 结论

**需修后合并。** 当前存在会改变 SSH 认证语义并导致连接失效的数据破坏问题，同时多节点页面没有真正接通设备种类和连接开关，设备删除还会留下或重新写回孤儿 placement。