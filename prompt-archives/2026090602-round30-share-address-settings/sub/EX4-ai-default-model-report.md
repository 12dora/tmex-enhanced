# EX4 — Settings → AI 默认模型探索报告（Opus 子代理）

## 根因
- `packages/panels/src/settings/llm-providers-tab.tsx:180-198` `LlmDefaultsCard` 的「默认模型」是 `<Input list=…>` + `<datalist>`，不是 Select；候选仅取 `defaultProviderId` 对应 provider 的 `models`（:137-138），未设默认提供商时列表为空；显示值为库中 `agent_settings.default_model_id` 的原样字符串（GPT-5.5 非硬编码）。
- 同类反模式：`packages/panels/src/watch/llm-fields.tsx:63,102-114`。
- 现成参考实现：`packages/panels/src/agent/model-picker.tsx:28-116`（按 provider 分组 Select，`providerId::modelId` 编码，过期模型占位项，空态 disabled）。

## 后端
- 存储 `apps/gateway/src/db/schema/agent.ts:57-71`（`default_model_id` 无 FK/校验）；`db/llm.ts:122-149` `computeProviderModels` 为启用模型唯一真源。
- API `apps/gateway/src/api/llm.ts:305-330`；`llm-settings-fields.ts:39-42` 任意字符串均接受；删除 provider 时 FK 置空 provider 但 model id 残留（:239-249）。
- 消费方：`llm/provider-registry.ts:34-77`、`api/agent-session-config.ts:120-127`、watch 规则。round25 消息指令不涉及模型。

## 测试
- e2e `apps/fe/tests/settings-llm.spec.ts:285-299` 断言 `fill('model-alpha')` 自由文本行为，需改为 Select 操作。
- 单测 `apps/gateway/src/api/llm.test.ts:441-473`、`llm-settings-fields.test.ts`；`LlmDefaultsCard` 无单测。

## 建议（指挥官裁决）
- FE：抽 `LlmModelSelect`（按已启用 provider 分组列出已启用模型，选模型同时设 provider；库中值不在候选时显示「已停用」占位；无候选时 disabled + 提示），复用于 LlmDefaultsCard 与 watch llm-fields；导出 model-picker 的 encode/decode。
- 后端仅做删除 provider 时同时清空 defaultModelId；**不加 PATCH 交叉校验与运行时守卫**（避免 e2e 用桩 provider 设默认值的用例断裂）。
