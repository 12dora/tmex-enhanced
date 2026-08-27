# device-dialog 拆分结果（F7）

## 改动概览

原 `device-dialog.tsx` 405 行、`DeviceDialog` 单函数 368 行（CC≈13），拆为 6 个文件：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `device-dialog.tsx` | 82 | 仅剩对话框壳、表单 state 与三段字段组合 |
| `device-basic-fields.tsx` | 111 | 名称 / 类型 / session / 默认工作目录（`DeviceTypeSelect` 独立子组件） |
| `device-ssh-connection-fields.tsx` | 74 | host / port / username（`SshPortField` 独立子组件） |
| `device-auth-fields.tsx` | 144 | 认证方式选择 + `PasswordAuthFields`/`KeyAuthFields`/`ConfigRefAuthFields`，`AuthModeExtraFields` 做 switch 分发（agent 返回 null） |
| `device-field-primitives.tsx` | 41 | 共用件：`DeviceFieldsProps`、`deviceFieldId(mode, suffix)`、`SectionHeading`、`FieldLabel` |
| `use-device-dialog-submit.ts` | 121 | 纯函数 `buildDevicePayload` / `resolveMutationErrorMessage` + `useDeviceDialogSubmit` hook |

`device-form.ts` 未改动，仅被 import。

## 设计要点

- `buildDevicePayload(values, mode)` 返回可辨识联合 `{ mode: 'create'; payload: CreateDeviceRequest } | { mode: 'edit'; payload: UpdateDeviceRequest }`，hook 按判别式挑 mutation，无需断言即可类型安全，同时让 payload 构造完全可单测。
- `useDeviceDialogSubmit` 内聚两个 mutation、校验、`attempted`/`isSubmitting` 状态与 toast 错误映射；`useMutationCallbacks` 抽出共用的 `onSuccess`（失效 queryKey + 成功 toast + 关闭）与 `onError`。
- 字段组件统一收 `{ mode, values, attempted, onChange }`，`onChange(patch)` 由对话框合并进 state；类型切换时的 `authMode` 迁移（local→auto、auto→agent）保留在 `nextAuthModeForType`。
- 所有 DOM id 走 `deviceFieldId(mode, suffix)`，生成的字符串与原实现逐一相同（`${mode}-device-name` 等）。

## 行为与 testid 保真

对照 `apps/fe/tests/devices.spec.ts` 使用的全部 testid，均原样保留：`device-dialog`、`device-name-input`、`device-type-select`、`device-auth-mode-select`、`device-ssh-config-ref-input`、`device-dialog-save`，另有未被 spec 引用的 `device-session-input`、`device-default-working-dir-input` 也保留。编辑模式禁用类型选择、`aria-invalid` 校验提示、SSH 分区仅在 `type === 'ssh'` 时渲染等行为不变。`resolveMutationErrorMessage` 与原 `err instanceof Error ? err.message : t('common.error')` 语义完全一致（含空 message 情况）。

## 测试

新增 `use-device-dialog-submit.test.ts`，16 个用例覆盖：

- 创建模式：local 基础字段与 session/工作目录回落（`tmex` / `undefined`）；ssh 四种 authMode（agent 不带任何凭据、password 原样不 trim、key 空 passphrase 归一 undefined、configRef trim）。
- 编辑模式：local 不发 `type` 且工作目录留空发空串；**configRef 模式保留 SSH Config 引用**（即上一轮修复的编辑态丢配置 bug 的回归防线）；非 configRef 模式显式清空 `sshConfigRef`；password/privateKey 留空时不出现在 payload 中（不覆盖已存凭据）、填写时提交；host/port/username 始终显式提交 trim 值。
- `resolveMutationErrorMessage` 的 Error / 非 Error 分支。

## 验证

- `cd packages/panels && bun test src/device-management` → 16 pass / 0 fail。
- `bunx tsc --noEmit -p packages/panels` → 无输出（零错误，也未见其他 agent 在途文件的报错）。
- `bunx biome check --write <7 个文件>` → 通过（仅一次格式化改写）。
