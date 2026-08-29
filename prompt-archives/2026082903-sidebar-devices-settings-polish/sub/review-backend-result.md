- **major — `apps/gateway/drizzle/0025_flat_device_groups.sql:1`**  
  迁移仅清空 `parent_id`，却保留原本“各父级内”的局部 `sort_order`。嵌套分组展开后会产生大量重复顺序；`getDeviceFolderLayout()` 又只按 `sort_order` 排序（`apps/gateway/src/db/device-folders.ts:55`），升级后分组次序可能改变且没有稳定保证。  
  **修复：**迁移时生成确定、唯一的全局顺序，再清空 `parent_id`，例如按原树的前序顺序并以 `created_at/id` 作为稳定兜底，重编号为 `0..n-1`。同时增加真正的升级测试：先仅执行至 0024、插入多层且局部顺序重叠的数据，再执行 0025，验证父级清空、顺序唯一稳定、节点 placement 保留、设备 placement 删除。现有 `apps/gateway/src/db/device-folders.test.ts:116` 是在全部迁移完成后才插入旧数据，未覆盖迁移行为。

- **minor — `packages/api-client/src/device-folders.ts:87`**  
  新增的 reset 客户端调用没有测试；当前 `packages/api-client` 下甚至没有对应的 `device-folders.test.ts`，因此请求方法、路径、响应解析和错误 fallback 都未受保护。  
  **修复：**使用现有 `devices.test.ts` 的 `StubApiClient` 模式，至少覆盖 `POST /api/device-folders/reset`、成功返回布局、服务端错误优先以及 fallback 错误。