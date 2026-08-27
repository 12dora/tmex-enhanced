# global-device-provider 拆分结果

## 目标

`apps/fe/src/components/global-device-provider.tsx`（286 行）把持久化读写、连接状态派生、连接生命周期混在一个文件里。拆出两个纯模块，Provider 只保留查询、订阅副作用与 context 组装。

## 产出文件

| 文件 | 职责 |
| --- | --- |
| `apps/fe/src/components/device-connection-persistence.ts` | localStorage 读写：`DeviceIdStorage`、存储键常量、`readPersistedIds` / `writePersistedIds`、`pruneUnknownDeviceIds`、集合增删 `withDeviceId` / `withoutDeviceId` |
| `apps/fe/src/components/device-connection-status.ts` | 纯派生：`DeviceConnectionSnapshot` / `DeviceRuntimeSlices`、`createDeviceConnectionSnapshot`、`deriveDeviceConnectionStatus`、`isDeviceConnected`、`shouldEnsureDeviceSubscription`、`shouldEnsureRouteDeviceSubscription`、`matchRouteDeviceId`、`selectStaleSubscribedDeviceIds`、`selectRestorableDeviceIds` |
| `apps/fe/src/components/device-connection-persistence.test.ts` | 损坏载荷矩阵、storage 抛错、集合工具 |
| `apps/fe/src/components/device-connection-status.test.ts` | 状态派生优先级矩阵、订阅判定、路由解析、选择器 |

`global-device-provider.tsx` 现在只剩 Provider 与其内部 hooks：

- `usePersistedDeviceIds(key)`：state + 写回 effect，两处连接意图共用。
- `useDeviceIntentState()`：聚合两份持久化集合，暴露 `markConnectIntent` / `markDisconnectIntent` / `pruneToKnownDevices`。
- `useDeviceStoreActions()` / `useDeviceStatusSlices()`：tmux store 切片读取。
- `useRouteDeviceSubscription()`：路由设备自动订阅。
- `useReconcileWithDeviceList()`：设备列表就绪后的清理与恢复，循环体改为消费两个纯选择器。
- `useIntentActions()` / `useDeviceConnectionAdapter()`：`DeviceConnectionAdapter` 组装。

## 兼容性

模块出口保持不变：`global-device-provider.tsx` 顶部 re-export `DeviceIdStorage`、`readPersistedIds`、`writePersistedIds`、`pruneUnknownDeviceIds`、`DeviceConnectionSnapshot`、`deriveDeviceConnectionStatus`、`shouldEnsureDeviceSubscription`、`shouldEnsureRouteDeviceSubscription`。grep 确认的三处外部 import（`main.tsx`、`page-layouts/components/sidebar-device-list.tsx`、`pages/DevicePage.tsx`）只用 `GlobalDeviceProvider` / `useGlobalDevice`，均未改动。既有 `global-device-provider.test.ts` 未做任何修改，依旧从原路径导入并全绿。

## 关于「versioning」

原实现没有版本号，载荷就是裸 `string[]`；现有测试断言写入结果为 `["device-a"]`，且线上已有用户数据是该格式。引入版本信封会破坏回读兼容与既有断言，属于行为变更而非重构，故未引入。改为把版本关注点显式收敛到持久化模块：存储键常量（带 runtime `storagePrefix` 命名空间）与解析逻辑同处一文件，并在注释中约定「载荷结构变更走新键名而非原地升级」。新增测试锁定键名后缀与载荷格式。

## 行为等价性

- 读取容错路径不变（缺失 / 非法 JSON / 非数组 / 非字符串元素 → 空集合；storage 抛错吞掉）。
- 状态优先级不变：主动断开 > 重连中 > 错误 > 已连接 > 已订阅未确认 > 断开；`hasOwnProperty` 守卫保留，原型链键不会误判。
- effect 注册顺序不变：两个持久化写回 effect 仍在路由订阅 effect 与设备列表对账 effect 之前。
- `connect` / `disconnect` 的集合更新仍在无变化时返回原引用（`withDeviceId` / `withoutDeviceId` 用 `null` 表示无变化）。

## 验证

```
cd apps/fe && bun test src/      → 109 pass / 0 fail（6 files）
cd apps/fe && bunx tsc --noEmit -p .  → 0 error
bunx biome check --write <5 个文件>   → No fixes applied
```

## 备注

Provider 文件行数由 286 → 318。增量来自 re-export 块（12 行）与 hook 参数接口声明；单个函数体全部控制在 60 行、CC ≤ 12 以内（Provider 本体 48 行），文件内不再有混合职责的长函数。未新增第三个源文件，因为剩余 hooks 属于任务约定由 Provider 保留的「订阅与 context 组装」。
