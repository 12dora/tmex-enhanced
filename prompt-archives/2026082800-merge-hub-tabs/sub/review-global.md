审查完成：**未发现确定的 blocker、major 或 minor 语义丢失；有 1 项存疑。**

但当前会话文件系统被强制设为只读，两次写入均被沙箱拒绝，因此未能创建 `prompt-archives/2026082800-merge-hub-tabs/sub/review-global.md`。报告内容如下。

## 存疑：默认 runtime 的通知注入能力

**文件：** [default-runtime.ts](/Users/konata/code/tmex-enhanced-wt-merge/packages/stores/src/default-runtime.ts:10)、[runtime.ts](/Users/konata/code/tmex-enhanced-wt-merge/packages/stores/src/runtime.ts:332)

- **丢失侧行为：** `feat/sidebar-tabs-ui` 的 `runtime.ts:233-246` 提供 `defaultSinkRef`、`setDefaultNotificationSink()` 和代理 sink；`apps/fe/src/lib/runtime-setup.ts:1-6` 将其注入 `sonnerNotificationSink`。
- **合并后为何可能不成立：** `defaultRuntime` 仍由无参 `createAppRuntime()` 创建，但默认通知出口固定为 `noopNotificationSink`，且不再存在等价的后置注入 API。直接消费 `@tmex/stores/default-runtime` 的单连接宿主将静默丢失 toast。
- **为何只是存疑：** 当前生产浏览器、standalone self runtime 和各 node runtime 都走 [node-runtimes.ts](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/node-runtimes.ts:243)，明确注入 `sonnerNotificationSink`；仓库内也没有生产代码导入 `@tmex/stores/default-runtime`。需要确认该子路径是否仍是受支持的真实宿主 API，还是仅供测试/兼容使用。
- **可复现判断：**
  - 若该 API 受支持，应满足 `defaultRuntime.notifications !== noopNotificationSink`，或提供等价注入入口；当前不满足。
  - 产品路径应满足 self 与各 node runtime 的通知 sink 为 `sonnerNotificationSink`；当前满足。
- **严重度：** 存疑；若 `default-runtime` 属于受支持宿主 API，则为 major，否则不报。

## 其余核验结果

- shared：auth/link 与 hub 父分支一致；五个 mesh kind、schema、严格校验均保留；`ChunkReassembler` 的超时、并发上限、重复/越界及 metadata mismatch 行为完整。
- ws-client：新建及重连均重新调用 `wsUrlFactory()`；close code 缺失回退 1006；宿主回调异常不阻断收敛；pane sink 微任务合并且连接隔离；共享 transport 不被 dispose。
- stores：没有旧 singleton 主入口导入；导航不存在二次 node 前缀。
- 迁移：`0018_agent_query_indexes → 0019_hub_auth` 的 journal、时间、文件名、managed 清单和 `prevId` 完全自洽。规范化后的 `0019_snapshot` 与 hub 原快照哈希一致，只增加 tabs 的两个 agent 索引。
- i18n：三个 locale 各 1045 个 scalar key，key 集一致；生成文件与 JSON 同步。
- 依赖/文档：WebAuthn 依赖同时存在于 manifest 和 lock；无残余 gateway build 调用；文档索引路径及 22 个相对链接全部有效。

验证结果：

- shared：325 pass，0 fail
- ws-client：260 pass，0 fail
- stores：238 pass，0 fail
- 跨契约重点集：182 pass，0 fail
- shared、ws-client、fe TypeScript 检查通过
- stores 有一条两个父分支均已存在的测试类型错误，不属于本次合并语义丢失。