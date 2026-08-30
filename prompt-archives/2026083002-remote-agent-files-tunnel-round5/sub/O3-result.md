# O3 结果 — 连接徽标：真实到达路径 + 延迟（前端）

## 做了什么

### 1. `transport` / `rttMs` 一路带到视图层

- `apps/fe/src/node/mesh-nodes.ts`
  - `NodeRow` 新增 `transport: MeshNodeTransport`、`rttMs: number | null`，`reach` 由
    `'lan' | 'relay' | null` 放宽到契约里的 `MeshNodeReach`（含 `'wan'`）。
  - `mergeNodes()` 把 `/api/mesh/nodes` 行上的 `transport` / `rttMs` 归一后带进 `NodeRow`
    （`reachOf` / `transportOf` / `rttOf`：不认识的枚举、负数、非有限值一律归成 `null`）。
  - `patchNodesWithEvent()`：online 事件更新 `transport` / `rttMs`，offline 一并清成 `null`；
    事件里**没带**这两段（老 node 的帧）时保留列表里已有的值，不把已知信息清成未知
    （新增 `pick()` 区分 `undefined`「帧里没有」与 `null`「明确没有」）。

- `apps/fe/src/node/mesh-events.ts`
  - `NodeReach` / 新增 `NodeTransport` 直接复用 `@tmex/api-client` 的 `MeshNodeReach` /
    `MeshNodeTransport`，`reachFromWire` 认 `'wan'`。
  - `NodeEventPayload` 新增可选 `transport` / `rttMs`，解帧时从 borsh 载荷里取；
    **载荷上暂时还没有这两个字段**（见下方「风险」），所以取值走一次窄化读取，
    字段缺失解成 `undefined`、字段畸形解成 `null`。

- `apps/fe/src/node/direct-diagnostics.ts`
  - `useNodeReach()` → `useNodeLink()`，返回 `{ reach, transport, rttMs }`（`NodeLink`）；
    列表里没有这一行时返回恒定的「不可达」快照。`self` 的匹配改用 `SELF_NODE_ID` 常量。

### 2. 徽标改成一枚

`apps/fe/src/node/device-node-badges.tsx` 重写：

- 只渲染一枚徽标（`data-testid="badge-node-link"`，原来的 `badge-browser-to-node` /
  `badge-entry-to-node` 两枚合并），点击仍然展开诊断浮层。
- 取值逻辑抽成纯函数 `resolveLinkBadge({ path, directRttMs, link })`：
  - 浏览器直连（`diagnostics.path === 'direct'`）→ `nodes.badge.direct`，RTT 取 WebRTC
    `getStats()`，tone `ok`；直连活着时压过 entry 侧的到达路径。
  - 否则按 reach：`lan` / `wan` → tone `ok`，`relay` / `null` → tone `muted`，RTT 取 entry↔node
    的 peer ping RTT。
  - `formatLinkBadgeLabel()`：RTT 已知拼 ` · {round(rtt)}ms`，未知**不带后缀**——
    `nodes.badge.rttUnknown`（「延迟未知」）与只剩它用的 `nodes.badge.primary`（「中转」）
    两个 key 已删除。
- 浮层抽成导出的 `NodeLinkDiagnostics`（便于无 DOM 环境直接静态渲染测试），在原 ICE 五行前
  加了「到达路径」「承载」两行；承载映射 `ws-secure` → WebSocket、`dc` → WebRTC、
  `relay` → Hub 中转，未知落到既有的 `nodes.badge.unknown`。

### 3. i18n（只动 `nodes.reach` / `nodes.badge` 两个子对象，三份 locale 同步）

- 新增 `nodes.reach.wan`：公网 / Internet / インターネット。
  （`nodes-table.tsx` 用 `t('nodes.reach.' + row.reach)` 拼 key，`wan` 补上后那张表也直接生效。）
- 新增 `nodes.badge.reachRow`（到达路径 / Reach / 到達経路）、`nodes.badge.transportRow`
  （承载 / Transport / トランスポート）、`transportWs`（WebSocket）、`transportDc`（WebRTC）、
  `transportRelay`（Hub 中转 / Hub relay / ハブ中継）。
- 删除 `nodes.badge.primary`、`nodes.badge.rttUnknown`（无引用）。
- 跑了 `bun run build:i18n` 重新生成 `resources.ts` / `types.ts`。

### 4. 测试

- 新增 `apps/fe/src/node/device-node-badges.test.tsx`（12 例）：`resolveLinkBadge` 的标签/色调/
  延迟后缀矩阵（direct 压过 relay、四种 reach、RTT 缺失与负数/NaN）、`reachLabelKey` /
  `transportLabelKey` 映射、`NodeLinkDiagnostics` 的两行新增内容与 ICE 占位、
  `DeviceNodeBadges` 的 self 不渲染 / 远端一枚徽标 / 列表缺行按不可达渲染。
- `mesh-nodes.test.ts`：online 事件带上 transport+rttMs、offline 清空、事件缺字段时保留旧值、
  `mergeNodes` 带 transport/rttMs 且未知枚举归一成 null、老行补 null。
- `mesh-events.test.ts`：两处 `toEqual` 补 `transport`/`rttMs`，新增 `reach='wan'` 解得出来、
  未知 reach 归一成 null 两例。

## 文件清单

- `apps/fe/src/node/mesh-nodes.ts`、`mesh-nodes.test.ts`
- `apps/fe/src/node/mesh-events.ts`、`mesh-events.test.ts`
- `apps/fe/src/node/direct-diagnostics.ts`
- `apps/fe/src/node/device-node-badges.tsx`
- `apps/fe/src/node/device-node-badges.test.tsx`（新增）
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`（仅 `nodes.reach` / `nodes.badge`）
- 生成物：`packages/shared/src/i18n/{resources.ts,types.ts}`（`bun run build:i18n` 产出）

## 验证结果

- `cd apps/fe && bun test src/` → **689 pass / 0 fail**（baseline 671/0；新增 15 例，其余为并行
  agent 的新增用例）。
- `cd apps/fe && bunx tsc --noEmit -p .` → 8 行报错，**全部在别的 agent 的在途文件**
  （`sidebar-agent-sessions.tsx` / `use-sidebar-agent-sessions.test.ts` 的 agent `nodeId`、
  `packages/panels` 的 `t()` 参数、`directory-picker-modal.tsx` 的 `browseDirectory`）；
  `src/node/` 下 **0 错**。
- `cd packages/shared && bun test` → **365 pass / 0 fail**（与 baseline 一致，i18n key 校验通过）。
- `cd packages/panels && bun test` → 541 pass / 2 fail，两例分别是 `FileRootPathField`（浏览目录）
  与 `DeviceCard`（文件入口），属别的 agent 在途改动，与本任务无关。
- `bunx biome check <上述文件>` → clean（格式化只对自己改的文件跑过 `--write`）。

## 风险 / 遗留（需要 commander 转给 G2）

1. **node 事件的线上载荷还没有 `transport` / `rttMs`。**
   `apps/gateway/src/mesh/mesh-routes.ts` 的 `broadcastNodeEvent()` 签名已经接受
   `transport` / `rttMs`，但 `wsBorsh.encodeNodeEvent()` 没有把它们编进帧——
   `packages/shared/src/ws-borsh/schema.ts` 的 `NodeEventSchema` / `NodeEventWire` /
   `encodeNodeEvent` / `decodeNodeEvent` 仍是七字段版本（该文件不在我的 scope，没有改）。
   现状后果：徽标的 `transport` / `rttMs` 只能来自 `/api/mesh/nodes` 的 30s 轮询，节点事件不会
   刷新延迟。前端已经写成向前兼容——一旦 G2（或 commander）给 borsh schema 补上这两段
   （建议沿用现有 `NodeEventLegacySchema` 回退套路再加一层），`decodeMeshFrame` 会自动取到值，
   `patchNodesWithEvent` 会实时更新，前端零改动。在此之前，事件里缺字段会保留上一次轮询到的
   值，不会把已经显示出来的延迟抹掉。

2. **`nodes.badge.transportRelay` 的三语措辞**：任务书写的是 `relay → "Hub relay"`；
   考虑到 zh_CN 里同一浮层的「到达路径」行已经是「经 Hub 中转」，中文取了「Hub 中转」、
   日文取了「ハブ中継」，英文保持 "Hub relay"。若要求三语统一成 "Hub relay" 字面量，
   改三个 JSON 值即可。

3. **对外 API 变更**：`useNodeReach` 已改名为 `useNodeLink`（全仓仅 `device-node-badges.tsx`
   一处调用，已同步）；徽标 testid 由 `badge-browser-to-node` / `badge-entry-to-node` 合并为
   `badge-node-link`（全仓无其它引用，e2e 里也没有）。
