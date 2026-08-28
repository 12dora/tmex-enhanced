# api-cc 执行结果

## 改了什么

把 gateway API / db 里 5 处高 CC 函数改成表驱动或声明式字段解析，公开签名与成功路径行为保持不变。

### 1. `shouldReconnectPushSupervisor`（表驱动）

抽出 `api/device-patch.ts`：比较字段表 `RECONNECT_IF_CHANGED`（`type` / `host` / `port` / `username` / `sshConfigRef` / `session` / `authMode`，值变化才重连）+ 出现即重连的密钥字段 `RECONNECT_IF_PRESENT`（`passwordEnc` / `privateKeyEnc` / `privateKeyPassphraseEnc`）。`name`、`defaultWorkingDir` 仍不触发重连。

`nextDevicePushAction` 把 reconnect vs `updateDefaultWorkingDir` vs none 收成纯函数。

### 2. `handleUpdateDevice`（`applyConfigFields`）

`DEVICE_UPDATE_FIELDS` 声明式解析 PATCH body（`name`/`host`/`port`/`username`/`sshConfigRef`/`session`/`defaultWorkingDir`/`authMode`/三个明文密钥）。`defaultWorkingDir` 仍 trim，空白 → `undefined`。密钥在 handler 里 `encryptSecretFields` 后再写入。`type` 不在 `UpdateDeviceRequest` 中，继续忽略。

### 3. `handleUpdateSettings`（同样声明式）

抽出 `api/llm-settings-fields.ts`：`searchProvider` / `defaultProviderId` / `defaultModelId` / `tavilyApiKey` / `braveApiKey`。密钥语义不变：省略不改、空串清除。`toAgentSettingsPatch` 负责 encrypt。

### 4. `buildEffectiveWatchRule`

拆成 `parseWatchTriggerType`、`mergeWatchRuleEffective`（`coalesceDefined`）、`validatePatternTrigger` + `validateRuleSemantics`。`buildEffectiveWatchRule` 只做编排。

### 5. `handlePutTreeOrder` / `createWatchRule`

- `parseTreeOrderBody` + `applyTreeOrderPatch`：windows 必须 `string[]`，panes 必须 `Record<string, string[]>`；空 `windows: []` 仍合法。
- `applyWatchRuleCreateDefaults`：默认值表循环覆盖，`??` 语义用 `!== undefined` 等价实现（`false` / `0` / `''` / `null` 不被默认值吃掉）。

## 文件

修改：

- `apps/gateway/src/api/device-routes.ts`
- `apps/gateway/src/api/llm.ts`
- `apps/gateway/src/api/watch-rule-config.ts`
- `apps/gateway/src/api/tree-order.ts`
- `apps/gateway/src/db/watch.ts`（仅 `createWatchRule` + 新 helper）
- `apps/gateway/src/api/watch-rule-config.test.ts`
- `apps/gateway/src/api/tree-order.test.ts`

新建：

- `apps/gateway/src/api/device-patch.ts` + `device-patch.test.ts`
- `apps/gateway/src/api/llm-settings-fields.ts` + `llm-settings-fields.test.ts`
- `apps/gateway/src/db/watch-defaults.test.ts`

未改：`api/http.ts`、`api/index.ts`、`config-field.ts`。

## Bug 修复

无功能 bug。声明式解析让非法 PATCH body 从「写入脏数据 / TypeError 500」变成 400 `invalidRequest`（与 llm provider / agent-session 一致）：

- 设备 PATCH：字段类型不对、非法 `authMode`、非对象 JSON
- tree-order PUT：JSON `null`（原先解引用 500）

合法客户端 payload 路径不变。

## 测试

每个 helper 都有单测；`shouldReconnectPushSupervisor` 对每个比较字段 / 密钥字段各一条。

- `bunx biome check --write` 上述 12 个文件：通过
- 相关：`device-patch` / `llm-settings-fields` / `watch-defaults` / `watch-rule-config` / `tree-order` / `llm` / `watch` / `agent-watch`：**172 pass / 0 fail**
- `cd apps/gateway && bun test`：约 **1809 pass / 2–3 fail**，失败均不在本任务文件（并行 agent）：
  - `src/agent/tools/run-command-buffer.test.ts`（UTF-8 截断）
  - `src/tmux-client/retention` 一类 `seedFromRetention`
  - 偶发 `src/agent/tools/ipv6-parse.test.ts`（导出尚未落地）
- `bunx tsc --noEmit -p .`：**45 errors**，**均不在本任务文件**。基线 27；增量来自并行任务缺模块 / `SiteSettings` 字段等，未动。

## 未做 / 为何

- **没有给 PATCH `/api/devices/:id` 加 HTTP 级用例**：重连会打 `pushSupervisor.reconnect`（真连 tmux）。表征覆盖在纯函数 `device-patch.test.ts`；合法字段路径与原先一致。
- **未把 `parseStringField` 推进 `config-field.ts`**：本地 parser 足够，避免动共享语义。
- **设备 PATCH 对非字符串 `host`/`name` 等现为 400**：原先会原样写入。契约是 `UpdateDeviceRequest` 字符串/整数/枚举；收紧与 `applyConfigFields` 其它路由一致。
- **`handleCreateDevice` 未改**：不在本次 CC 名单。
