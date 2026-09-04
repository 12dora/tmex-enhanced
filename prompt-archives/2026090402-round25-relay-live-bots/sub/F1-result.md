# F1 结果：进入「设置 → 节点」不再先闪「无法连接到 Hub」

## 结论

红条只在**探测已经落地并且失败**时出（`hubFailure !== null`）；首屏 / 重置态什么都不出；
首次探测在飞时改出一句灰字「正在连接 Hub…」。`online` / `writable` 语义未动。

## 复核过的现状（与任务描述一致）

- `useHubNode`（`apps/fe/src/node/mesh-nodes.ts:715-778`）返回 `online: hubNodes !== null`，初值 `hubNodes=null, loading=false, failure=null` → `online=false`。
- 旧 `HubUplinkNotices` 只判 `hubOnline`，false 就渲染 `nodes.hubOffline` 红条，因此每次进入节点管理都会先闪红条，直到首次 `GET /n/<hub>/api/hub/nodes`（可能先 401 → 静默登录 → 重试）回来。
- `HubUplinkPanel` 全仓只有 `local-uplink-tabs.tsx` 一处渲染，改 props 不影响其它调用方。
- **不需要三态**：`hubOnline === (hubNodes !== null)`，所以「`hubNodes === null && loading`」等价于 `!hubOnline && loading`，只把 `useHubNode` 已有的 `loading` 透传下来即可。`mesh-nodes.ts` / `hub-load-coordinator.ts` **未改动**。

## 改动文件

- `apps/fe/src/pages/settings/nodes/uplink/hub-uplink-panel.tsx`
  - `HubUplinkPanelProps` 新增 `hubLoading: boolean`，`HubMembershipRows` 透传。
  - `HubUplinkNotices` 改为导出（供测试直接渲染），分档改成：
    1. `writesBlocked` → `nodes-hub-standby`（保留原有最高优先级）；
    2. `hubOnline` → 不出提示；
    3. `hubFailure !== null` → 红条，`auth` 走 `nodes.hubLoginRejected`，其余走 `nodes.hubOffline`（`hubFailureNotice` 未改）；
    4. `hubLoading` → 灰字 `nodes-hub-connecting`（`Loader2` 转圈，`motion-reduce` 下不转）；
    5. 其余（首屏 / reset）→ `null`。
  - 失败后同目标重试（`loading=true` 且 `failure!=null`）仍留红条，不会每一拍闪成「正在连接」——与协调器「同一目标保留失败态」的既有语义一致。
- `apps/fe/src/pages/settings/nodes/uplink/local-uplink-tabs.tsx`：新增 `hubLoading={uplink.hub.loading}`。
- `apps/fe/src/pages/settings/nodes/uplink/hub-uplink-panel.test.tsx`：导出引用 + 新增 `describe('上级 hub 的提示分档')`，6 个用例（初始态无提示 / 在飞出灰字 / 打不通与拒登两条红条 / 失败后重试留红条 / 已加载后后台刷新与残留失败都不打扰 / standby 压过全部）。
- `apps/fe/src/pages/settings/nodes/uplink/local-uplink-tabs.test.tsx`：直接渲染 `HubUplinkPanel` 的那处补 `hubLoading={false}`。
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`：`nodes.hubConnecting`
  - zh_CN `正在连接 Hub…`；en_US `Connecting to Hub…`；ja_JP `ハブに接続しています…`（与同段落既有 `hubOffline` 的 `ハブ` 用词保持一致）。
  - 三语都加了：`packages/shared/src/i18n/locale-consistency.test.ts` 要求三语 key 集合完全一致，只加两语会直接挂。

## 验证

- `cd apps/fe && bun test src/pages/settings/nodes src/node` → **982 pass / 0 fail**（53 文件，3055 expect）。
- `cd apps/fe && bunx tsc --noEmit -p .` → exit 0（基线 0 error，未新增）。
- `bunx biome check`（本次改动的 4 个 tsx + 3 个 locale json）→ exit 0。
- 未跑 `bun run build:i18n`、未跑 git 命令、未碰生成文件（`resources.ts` / `types.ts` / `locales/generated/*`）。

## 留给 commander 的一件事

`packages/shared` 的 `locale-consistency.test.ts` 现在有 **2 个预期内失败**（「resources.ts 与 locales/*.json 同步」「locales/generated 的 core/rest 与源文件、前缀表同步」），原因就是新 key `nodes.hubConnecting` 还没进生成物。跑一次 `bun run --filter @tmex/shared build:i18n` 即消。三语 key 集合一致性那条已通过。

注：`apps/fe` 的 tsc 目前并没有对 `t()` 的 key 做字面量校验，所以缺生成类型不会报错；`bun test`/`tsc` 均已在缺生成物的状态下全绿。
