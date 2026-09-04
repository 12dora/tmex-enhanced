# V1 结果：canonical v1.1 门槛修正到 1.1.23 + 「谁太旧」提示

## 一、结论

1. `CANONICAL_V11_MIN_PEER_VERSION` 由 `1.1.22` 改为 `1.1.23`（真实互通下限：1.1.22 网关只播报
   `canonical-state-v1`，1.1.22 浏览器又硬编码 `clientVersion: '0.1.0'`）。
2. 拒绝用的 ERROR message 契约改为**两种形态**，拼装与解析都收进 shared，网关与浏览器共用一份实现：

   ```
   canonical-state-v1.1 required: client <clientVersion> < <minVersion>
   canonical-state-v1.1 required: node <nodeId> version <peerVersion> < <minVersion>
   ```

   node 形态必须点名 `nodeId`——入口网关拒掉的转发流对端未必是浏览器当前 runtime 的 node
   （按指挥官追加要求实现，`rejectStaleNodeStream` 已有 `pump.nodeId` 与 `pump.replay.peerVersion`）。
3. transport 事件 `server-too-old` 改为携带 `{ side: 'gateway' | 'node' | 'client'; minVersion;
   version: string | null; nodeId?: string | null }`（原字段 `serverVersion` 更名为 `version`）。
4. 提示按 `side` 分流为四条新 i18n 文案，旧 `websocket.serverTooOld` 已删除（全仓无引用）。
5. 提示去重：同一 `side + nodeId + version` 只弹一次，重新协商成 canonical 后清空记忆——
   READY+unsupported 路径每次重连（含惰性 transport 在切标签页唤醒时的重连）都会重走，不去重会连弹。

## 二、改动文件

### shared
- `packages/shared/src/ws-borsh/canonical-version.ts`
  - 门槛常量改 1.1.23；新增 `CANONICAL_V11_UNKNOWN`、`CanonicalV11PeerSide`、
    `CanonicalV11RequiredErrorInfo`、`formatCanonicalV11RequiredError(info)`、
    `parseCanonicalV11RequiredError(code, message)`；`_dev` 后缀处理保持不变。
- `packages/shared/src/ws-borsh/index.ts`：导出上述新符号。
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` 的 `websocket` 子对象：
  删除 `serverTooOld`，新增 `gatewayTooOld` / `nodeTooOld` / `nodeTooOldUnnamed` / `clientTooOld` /
  `unknownVersion`（三语同键，已跑 `bun run build:i18n` 重生成 `resources.ts` / `types.ts` /
  `locales/generated/*`）。zh_CN 文案遵循 `tmex-copy-guidelines.md`：无第二人称、全角标点、
  `<失败的事>：<原因/下一步>。` 句式。

### gateway
- `apps/gateway/src/ws/canonical-gate.ts`：`clientTooOldMessage` / `peerNodeTooOldMessage` 改为
  转调 shared 的 formatter；`peerNodeTooOldMessage` 签名加 `nodeId`；
  `CANONICAL_V11_REQUIRED_PREFIX` 改为引用 shared 常量（不再各写一份字面量）。
- `apps/gateway/src/mesh/stream-replay-state.ts`：仅调用点，传入 `pump.nodeId`。
- `apps/gateway/src/ws/index.ts`：未改（`clientTooOldMessage` 签名未变）。

### ws-client
- `transport-types.ts`：新增 `ServerTooOldSide`；`server-too-old` 事件加 `side` / `nodeId`，
  `serverVersion` → `version`。
- `transport-message-decoder.ts`：ERROR 帧改用 `parseCanonicalV11RequiredError`，把 side /
  nodeId / version 原样带出。
- `websocket-transport.ts`：READY+unsupported 走 `emitServerTooOld({ side: 'gateway', ... })`；
  删掉原来「解码器 version 为 null 时用本连接 serverVersion 补一刀」的逻辑——那对 node 侧是
  错的（补的是入口网关自己的版本）；新增按 `side:nodeId:version` 的去重，canonical 激活时清空。

### stores
- `tmux-event-router.ts`：新增 `tooOldMessage()` 按 side 选词；node 侧优先用事件里的 `nodeId`，
  没有才退回 `ctx.core.nodeId`，都取前 8 位显示（stores 只有编号没有名称）；self runtime 且事件
  未点名时用 `nodeTooOldUnnamed`；版本为 null 时用 `websocket.unknownVersion` 兜底。
  console.error 也带上 side/node/version。

### docs / CHANGELOG
- `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`：门槛 1.1.23 + 新增 message 两种形态的契约说明。
- `docs/ws-protocol/2026021403-ws-state-machines.md`、
  `docs/terminal/2026021404-terminal-switch-barrier-design.md`、
  `docs/hub/2026082800-hub-node-operations.md`：门槛数字与提示分流说明。
- `packages/app/CHANGELOG.md`：新建 `# 1.1.24` 段（English + 中文，沿用既有格式），置于 1.1.23 之上。

## 三、测试

新增/改写：
- shared `canonical-version.test.ts`：门槛断言改 1.1.23；新增拼装/解析 4 例
  （两种形态、unknown 归一成 null、format↔parse 互逆、非该类错误返回 null）。共 11 例。
- ws-client `transport-message-decoder.test.ts`：node / client / 全 unknown 三侧解码（原 1 例扩为 3 例）。
- ws-client `websocket-canonical-gate.test.ts`：
  新增「同一网关重连后不再重复弹，升级到 canonical 后重新计数」与
  「ERROR 帧里的节点编号与版本原样上报，不被入口网关自身版本覆盖」；
  原「服务端版本低于 1.1.22」用例改为 1.1.23 门槛下的 1.1.22。
- ws-client `client.test.ts`：拒绝 message 改用 shared formatter 构造。
- stores `tmux-event-router.test.ts`：harness 加 `nodeId` 选项与 `t` 调用记录；
  新增 4 例（gateway / 优先点名事件里的 node / 退回 runtime node / self+版本未知兜底 / client）。
- gateway `canonical-gate.test.ts`：门槛用例改 1.1.23（1.1.23 通过、1.1.22 被拒），
  ERROR message 改为逐字比对；新增「两条 message 由共享模块拼装且可解析回 side/节点/版本」。
- gateway `forwarder.test.ts`：坏 HELLO 用例的 message 断言改为逐字比对 `node <OTHER> version unknown`；
  另一处 `encodeHelloS2CFrame('1.1.22')` 改 `1.1.23`（否则新门槛下该「正常转发」用例失效）。
- gateway `stream-replay-state.test.ts`：仅用例标题里的版本数字。

## 四、验证输出

| 项目 | 结果 |
|---|---|
| `bunx tsc -p packages/shared` | 0 error |
| `bunx tsc -p packages/ws-client` | 0 error |
| `bunx tsc -p packages/stores` | 1 error（`host-services.test.ts`，基线既有） |
| `bunx tsc -p apps/gateway` | 0 error |
| `bunx tsc -p packages/panels` / `packages/ui` | 0 error |
| `bunx tsc -p apps/fe` | 3 error，全部在 `settings/nodes/setup/hub-setup-wizard.test.tsx`、`settings/relay/relay-status-store.test.ts`、`settings/relay/relay-tab.test.tsx`（并行 agent 的在途改动，非本任务） |
| `bun test src/`（shared） | 631 pass / 0 fail |
| `bun test src/`（ws-client） | 396 pass / 0 fail（基线 392，+4） |
| `bun test src/`（stores） | 415 pass / 0 fail（基线 411，+4） |
| `bun test src/`（apps/fe） | 1899 pass / 0 fail |
| `bun test src/`（gateway） | 4143 pass / 1 fail —— 失败项在两次运行间漂移，均落在并行 agent 正在改的文件（`mesh/relay-routes.test.ts`、`mesh/relay-dial.test.ts`、`auth/key-log-store.test.ts`），与本任务无关 |
| 本任务 gateway 相关文件定向跑 | `ws/canonical-gate.test.ts` + `mesh/forwarder.test.ts` + `mesh/stream-replay-state.test.ts` 全绿 |
| `bunx biome check <本任务文件>` | 121 files，无问题 |
| `bun scripts/complexity/gate.ts` | 3 violation，全部在并行 agent 的文件（`settings/nodes/local-machine-card.tsx`、`settings/nodes/uplink/hub-uplink-panel.tsx`、`auth/user-store.ts`）；本任务文件均未超限（最大 `tmux-event-router.ts` 290 行） |

## 五、需要指挥官处理

1. **`packages/app/CHANGELOG.md` 的 1.1.24 段是我新建的**（scope 允许，但 packages/app 由别的 agent
   在改）。若其他 agent 也各自加了 1.1.24 段，合并时要把条目并进同一段，别留两个 `# 1.1.24`。
2. **`apps/gateway/src/mesh/forwarder.test.ts` 我改了 2 行**（一处版本字面量 `1.1.22 → 1.1.23`，
   一处 message 断言）。它属于 mesh 目录，若与「mesh relay 文件」的 agent 有重叠请复核。
3. **门槛值等于当前发布版 1.1.23**：本轮发 1.1.24 后，1.1.23 的浏览器/节点仍然放行（`>=`），
   只有 1.1.22 及以下被拒。若本轮想把门槛顶到 1.1.24，需要另行决策（会把刚升上 1.1.23 的节点全拒掉，
   不建议）。
4. **删除了 i18n key `websocket.serverTooOld`**：全仓（含 `apps/fe/tests`）已无引用，但生成文件
   `resources.ts` / `types.ts` / `locales/generated/*` 随 `build:i18n` 一起变了，提交时别漏。
5. 我发现 i18n 三语 key 集合在 `en_US` 上有既有差异（复数形式 `*_one` / `*_other`，如
   `devices.folders.itemCount`），属基线现象，未处理。
6. 建议 e2e 复测点：1.1.23 浏览器打开 1.1.22 远端节点终端，确认 toast 变为
   「终端连接失败：节点 xxxxxxxx 的 tmex 版本 1.1.22 过低，请升级到 1.1.23 或更新版本。」
   且切标签页往返不会重复弹。
