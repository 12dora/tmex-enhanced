# 可删除代码审计报告

基于当前工作树静态扫描，排除测试、生成文件、`dist`、`vendor`、`node_modules`，并检查了 `package.json` 的 `exports`、`bin`、动态导入和文档引用。共发现约 740 行可删除源代码候选。

当前工作区已有未提交改动；已排除正在处理的 JSON helper、LLM API、`parseApiError` 等重复代码，不重复建议。未修改文件，也未运行测试。

## P0

### 1. 孤立的 SSH 探测模块

- 文件：[`apps/gateway/src/tmux-client/ssh-probe.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/ssh-probe.ts:1)（L1-L163）
- 证据：
  
  ```ts
  export async function probeSshDevice(...)
  ```
  
  `rg -n 'ssh-probe|probeSshDevice|SshProbeResult'` 排除测试后只命中该文件自身。包含测试后，唯一外部命中是 [`ssh-probe.test.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/ssh-probe.test.ts:6)（L6、L110-L125）。

  当前生产测试连接入口是 [`test-connection.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/api/test-connection.ts:28)（L28-L65），通过 `tmuxRuntimeRegistry.acquire()`，并未调用该模块。

- 建议：删除 `ssh-probe.ts` 及其仅测试该模块的测试；保留 `test-connection.ts` 的运行时实现。
- 行数变化：约 `-163` 行源代码。
- 风险：low。Gateway 没有对应 `exports`/`bin`，且无动态导入。
- 优先级：P0。

### 2. `@tmex/ws-client` 中未使用的 S2C 解码包装层及默认实例重置导出

- 文件：
  - [`packages/ws-client/src/message-builder.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ws-client/src/message-builder.ts:363)（L363-L423）
  - [`packages/ws-client/src/index.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ws-client/src/index.ts:3)（L3-L18、L46-L72、L104-L114）
  - [`packages/ws-client/src/client.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ws-client/src/client.ts:518)（L518-L523）
  - [`packages/ws-client/src/pane-sink-registry.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ws-client/src/pane-sink-registry.ts:335)（L335-L337）
  - [`packages/ws-client/src/state-machine.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ws-client/src/state-machine.ts:663)（L663-L668）

- 证据：

  ```ts
  export function decodeDeviceConnected(...)
  export function decodeTermOutput(...)
  export function decodeSiteThemeUpdate(...)
  ```

  生产解码器 [`transport-message-decoder.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ws-client/src/transport-message-decoder.ts:9)（L9-L126）直接调用 `wsBorsh.decodePayload`，不调用这些包装函数。

  `rg` 排除测试后，这些符号只命中自身声明和根 barrel 导出。`resetBorshClient`、`getDefaultPaneSinkRegistry`、`resetSelectStateMachine` 也只有声明和根导出。

- 建议：删除 S2C 解码包装函数，以及三个无人使用的默认实例/状态重置导出；测试改为直接使用 `wsBorsh` 或删除包装层测试。
- 行数变化：约 `-90` 行源代码。
- 风险：low。包是 private，文档只使用 `getBorshClient` 和 `createGatewayConnection`。
- 优先级：P0。

### 3. Gateway Borsh C2S 解码辅助函数全部无生产调用

- 文件：[`apps/gateway/src/ws/borsh/codec-borsh.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/borsh/codec-borsh.ts:203)（L203-L281）
- 证据：

  ```ts
  export function decodeHelloC2S(...)
  export function decodeTmuxSelect(...)
  export function decodeTermSyncSize(...)
  ```

  `apps/gateway/src/ws/index.ts` 只导入 `createBorshClientState`、`encodeCanonicalEvent`（L25-L27）；`borsh-dispatcher.ts` 只导入 `decodeCanonicalCommand`。这些 C2S 包装函数的唯一调用来自 [`index.test.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/borsh/index.test.ts:7)（L7-L13、L40-L83）。

- 建议：删除 L203-L281 的解码包装函数；测试直接使用 `wsBorsh.decodePayload`。
- 行数变化：约 `-65` 行源代码。
- 风险：low。Gateway 内部模块，无包导出或动态导入。
- 优先级：P0。

### 4. Gateway Borsh S2C 编码辅助函数全部无生产调用

- 文件：[`apps/gateway/src/ws/borsh/codec-borsh.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/borsh/codec-borsh.ts:35)（L35-L98、L125-L131）
- 证据：

  ```ts
  export function encodeDeviceConnected(...)
  export function encodeStateSnapshot(...)
  export function encodeClipboardWrite(...)
  ```

  生产切换屏障只使用 `encodeLiveResume`、`encodeSwitchAck`、`encodeTermHistory`、`encodeTermOutput` 和 `sendToClient`，见 [`switch-barrier.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/borsh/switch-barrier.ts:7)（L7-L14）。Gateway 根模块只使用 `encodeCanonicalEvent`。

  排除测试后，`rg` 对这些符号只命中声明；测试使用见 [`index.test.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/borsh/index.test.ts:10)（L10-L12、L40-L83）。

- 建议：删除未使用的 S2C 编码包装函数；测试直接调用共享 `wsBorsh` API。
- 行数变化：约 `-64` 行源代码。
- 风险：low。
- 优先级：P0。

## P1

### 5. 未使用的宿主共享 Transport 实现

- 文件：
  - [`packages/ws-client/src/shared-transport.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ws-client/src/shared-transport.ts:1)（L1-L105）
  - [`packages/ws-client/src/transport.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ws-client/src/transport.ts:22)（L22-L26）
  - [`packages/ws-client/src/index.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ws-client/src/index.ts:26)（L26-L44）

- 证据：

  ```ts
  export function createSharedGatewayTransport(...)
  ```

  排除测试后，`createSharedGatewayTransport`、`SharedGatewayTransport` 只命中自身声明及两个 barrel 导出。当前文档实际示例使用的是 `createGatewayConnection({ wsUrl })`，见 [`docs/frontend/packages.md`](/Users/konata/code/tmex-enhanced-wt-smell/docs/frontend/packages.md:37)（L37-L56），没有使用共享 Transport 工厂。

- 建议：删除 `shared-transport.ts`，移除 `transport.ts` 和根 barrel 的对应导出；保留 `GatewayTransport` 接口和 `createGatewayConnection` 的自定义 `transport` 注入能力。
- 行数变化：约 `-111` 行源代码。
- 风险：med。代码注释明确预留了宿主共享场景，删除前需确认没有仓外嵌入方。
- 优先级：P1。

### 6. CLI 中无人调用的 `startService` 分支

- 文件：
  - [`packages/app/src/lib/service.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/app/src/lib/service.ts:229)（L229-L275）
  - [`packages/app/src/i18n/index.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/app/src/i18n/index.ts:49)（L49-L50、L180-L181）
  - [`packages/app/src/cli-node.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/app/src/cli-node.ts:19)（L19-L40）

- 证据：

  ```ts
  export async function startService(...)
  ```

  CLI 只支持 `init`、`doctor`、`upgrade`、`uninstall`，没有 `start` 命令。`rg -n 'startService|startSystemd'` 排除测试后只命中 `service.ts` 自身。

  `service.systemd.startFailed` 没有任何使用；`startRuntimeFailed` 只被该死分支使用。

- 建议：删除 `startSystemd`、`startService` 及两个语言中的四个死 i18n key。
- 行数变化：约 `-51` 行源代码。
- 风险：low。包的 `files` 不包含 `src`，且 CLI bin 没有暴露该接口。

  `BUG:` 如果未来重新接入 `startService`，`detectServiceManager()` 返回 `none` 时会静默成功而不启动服务；重新接入时应显式报错。

- 优先级：P1。

### 7. 未被 package script 或文档引用的 managed Linux smoke 脚本

- 文件：[`apps/gateway/scripts/smoke-managed-linux.sh`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/scripts/smoke-managed-linux.sh:1)（L1-L51）
- 证据：

  ```bash
  # 用法：bash scripts/smoke-managed-linux.sh <linux-arm64|linux-x64>
  ```

  `rg -n 'smoke-managed-linux' package.json apps packages docs scripts` 只命中脚本自身。当前 manifest 的 smoke 命令是：

  ```json
  "smoke:managed": "bun scripts/run-managed-smoke.ts"
  ```

- 建议：确认没有发布人员手工使用后删除该脚本；若仍需保留，应将其纳入明确的 package script 或部署文档。
- 行数变化：约 `-51` 行。
- 风险：med。可能是未文档化的手工发布验证工具。
- 优先级：P1。

## P2

### 8. 未被构建流程引用的两个手工脚本

- 文件：
  - [`packages/ghostty-terminal/scripts/smoke-compiled.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/scripts/smoke-compiled.ts:1)（L1-L22）
  - [`scripts/theme/build-shortcut-tokens.ts`](/Users/konata/code/tmex-enhanced-wt-smell/scripts/theme/build-shortcut-tokens.ts:1)（L1-L25）

- 证据：

  ```ts
  // 构建：`bun build --compile ... smoke-compiled.ts`
  ```

  两个脚本均未出现在 package script 或文档命令中。`build-shortcut-tokens` 的其他命中只是源文件注释，没有可执行调用。

- 建议：确认当前 checked-in 产物由其他流程生成后删除；否则应把生成脚本接入正式构建流程，而不是保持孤立脚本。
- 行数变化：约 `-47` 行。
- 风险：med。删除主题生成脚本可能影响未来 token 更新。
- 优先级：P2。

### 9. Gateway 中仅测试使用的便捷导出集合

- 文件：
  - [`apps/gateway/src/api/route.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/api/route.ts:81)（L81-L94）
  - [`apps/gateway/src/db/watch.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/db/watch.ts:92)（L92-L100）
  - [`apps/gateway/src/files/categorize.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/files/categorize.ts:186)（L186-L188）
  - [`apps/gateway/src/agent/secret-scan.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/secret-scan.ts:87)（L87-L89）
  - [`apps/gateway/src/agent/run-resource-scope.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/run-resource-scope.ts:148)（L148-L150）
  - [`apps/gateway/src/agent/tools/hosted.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/tools/hosted.ts:21)（L21-L23）
  - [`apps/gateway/src/tmux-client/target-missing.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/target-missing.ts:22)（L22-L24）
  - [`apps/gateway/src/tmux-client/input-encoder.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/input-encoder.ts:5)（L5-L10）

- 证据：

  ```ts
  export function matchRoute(...)
  export function hasSecret(...)
  export function encodeInputToHexChunks(...)
  ```

  排除测试后，`rg` 对这些符号只命中声明。生产代码使用的是：

  - `dispatchRoutes`，而不是 `matchRoute`；
  - `getAllWatchRules`，而不是 `listWatchRulesByDevice`；
  - `detectSecrets`，而不是 `hasSecret`；
  - `paneEmulatorRegistry.destroy`，而不是 `destroyPaneEmulator`；
  - `HOSTED_TOOL_KEYS.includes(...)`，而不是 `isHostedToolKey`；
  - `encodeBytesToHexChunks`，而不是 `encodeInputToHexChunks`。

- 建议：删除上述便捷导出及函数；测试改用实际生产函数，或删除只覆盖包装函数的测试。
- 行数变化：约 `-44` 行。
- 风险：low。
- 优先级：P2。

### 10. 仅测试或内部路径可见的死导出、协议声明和 barrel

- 文件：
  - [`packages/api-client/src/devices.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/api-client/src/devices.ts:34)（L34-L44）
  - [`packages/app/src/i18n/index.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/app/src/i18n/index.ts:297)（L297-L299）
  - [`packages/ghostty-terminal/src/selection-model.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/selection-model.ts:73)（L73-L77）
  - [`apps/gateway/src/weixin/ilink/types.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/weixin/ilink/types.ts:10)（L10-L23、L87-L90）
  - [`apps/gateway/src/system/index.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/system/index.ts:1)（L1-L17）
  - [`packages/terminal-ui/src/components/index.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/terminal-ui/src/components/index.ts:1)（L1-L9）

- 证据：

  ```ts
  export async function fetchDevice(...)
  export function getLang(): CliLang
  export function lineModelFromText(...)
  ```

  这些符号排除测试后没有生产调用。测试调用分别见：

  - [`devices.test.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/api-client/src/devices.test.ts:7)（L7-L8、L60-L73）
  - [`i18n/index.test.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/app/src/i18n/index.test.ts:2)（L2、L18-L20）
  - `selection-model.test.ts`、`link-detector.test.ts` 中的测试辅助调用。

  Weixin 中以下声明没有非测试引用：

  ```ts
  export const MESSAGE_TYPE_USER = 1;
  export const MESSAGE_STATE_NEW = 0;
  export const ITEM_TYPE_IMAGE = 2;
  export interface GetUpdatesReq { ... }
  ```

  应保留仍被运行时代码使用的 `MESSAGE_TYPE_BOT`、`MESSAGE_STATE_FINISH` 和 `ITEM_TYPE_TEXT`。

  `system/index.ts` 没有导入者；生产代码通过 [`api/system.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/api/system.ts:52)（L52-L64）直接动态导入 `system/update-check` 和 `system/upgrade`。`terminal-ui` 根入口也直接导出 `components/Terminal`，见 [`src/index.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/terminal-ui/src/index.ts:3)（L3-L11），没有使用该 barrel。

- 建议：删除这些测试专用函数、未使用协议声明和两个无消费者的内部 barrel；相应测试直接构造底层数据或删除包装层测试。
- 行数变化：约 `-56` 行源代码。
- 风险：low。`@tmex/api-client`、`@tmex/terminal-ui` 等包为 private；但仍建议确认仓外源码没有通过 wildcard 子路径导入。
- 优先级：P2。

## 明确排除的候选

- `legacy-feed-broadcaster.ts` 和 `state-snapshot-diff.ts` 仍被 Gateway/Stores 的旧协议路径使用，不能仅因名称含 `legacy` 删除。
- `createGatewayConnection` 虽然当前生产调用较少，但已在 [`docs/frontend/packages.md`](/Users/konata/code/tmex-enhanced-wt-smell/docs/frontend/packages.md:37)（L37-L56）作为嵌入 API 文档化，因此未建议删除整个连接抽象。
- 未发现高置信度的“只声明未读取”环境变量或 feature flag。
- `scripts/health-check.sh` 已被部署文档引用，因此未列为未使用脚本。