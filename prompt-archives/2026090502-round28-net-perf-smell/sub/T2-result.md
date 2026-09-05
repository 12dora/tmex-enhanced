# T2（前端）结果：SSH 路径预选设备类型 + 隧道 fake-IP 边缘诊断

## A. 「添加设备」按 SSH 路径打开即预选 SSH

预选项 `AddDevicePreset = { type: DeviceType }`（复用 `@tmex/shared` 的 `DeviceType`，未新造联合类型）沿整条链路透传：

`ssh-steps` → `startAddDeviceFlow` → `openSelfAddDevice` → 注册表 `AddDeviceTarget.open(preset)` → `NodeDeviceGroup` → `DeviceManagementPanelHandle.openAddDevice(preset)` → `DeviceDialog.initialType` → `createDefaultFormValues(device, initialType)`。

- `packages/panels/src/device-management/events.ts`：新增 `AddDevicePreset` 与 `addDevicePresetFromEvent(event)`；全局事件 `tmex:open-add-device` 的 `detail` 现在可带预选类型，形状不符一律当作没有预选（外部派发方不可信）。
- `device-management-actions.tsx`：`requestAddDevice(onAddDevice?, preset?)`，回调与全局事件两条路都带上预选。
- `device-management-panel.tsx`：`openAddDevice(preset?)`（无参调用行为不变）；内部把 `showAddModal` 布尔换成 `addDialog: { initialType? } | null`，对话框每次都是新挂载，预选自然随每次打开重置；`subscribeOpenAddDevice(enabled, onOpen(preset?))` 从事件 detail 解析预选（standalone 兜底路径与 ref 路径行为一致）。
- `device-dialog.tsx`：新增 `initialType?: DeviceType`；`device-form.ts` 的 `createDefaultFormValues(device?, initialType?)` 只在新建时采用预选，编辑态永远取设备自身类型。
- `apps/fe`：`add-device-targets.ts` 的 `open: (preset?) => void`；`node-device-group.tsx` 转发；`open-add-device.ts` 新增 `OpenAddDeviceOptions.preset`；`ssh-steps.tsx` 导出常量 `SSH_ADD_DEVICE_PRESET = { type: 'ssh' }` 并在按钮里使用，文件头注释同步改为「类型已预选为 SSH」。
- 附带修复：`add-device-menu.tsx` 的 `onClick={target.open}` 会把鼠标事件当第一个实参传进去，改成 `onClick={() => target.open()}`（`open` 变成带参签名后这是必需的）。

## B. 隧道「无边缘连接」的 fake-IP 诊断

- `tunnel-model.ts`：新增纯函数 `edgeDiagnosis(status): 'none' | 'bypassed' | 'bypassFailed'`——旧后端无 `edge` 字段一律 `none`；`mode === 'static'` 为 `bypassed`；`fakeIpDetected && mode === 'system'` 为 `bypassFailed`。`degradedError` 的错误来源链末尾补上 `status.edge?.lastError`（进程 / 连接器都没话说时才用它）。
- `status-card.tsx`：
  - `DegradedNotice` 的排查指引抽成 `DegradedHint`，三档分流：`bypassFailed` 给出代理侧的具体改法（always-real-ip + DIRECT 规则，再清 DNS 缓存 / 重启代理与隧道），`bypassed` 只说明当前走的是真实边缘地址，其余沿用原来的通用 7844 指引（仍只在确证零连接时给）。`edge.lastError` 走原有的错误明细行 `remote-access-degraded-error`。
  - 明细块里连接器一行下方新增 `EdgeRow`（testid `remote-access-edge`），仅在 `bypassed` 时出现，交代当前用的是静态边缘地址。
  - 顺带把已配置状态下的明细块抽成 `TunnelDetails` 子组件——加一行后 `TunnelStatusCard` 冲破了 allowlist 的 201 行上限，抽出后复杂度门禁恢复通过（allowlist 未改）。

## 改动文件

`packages/panels/src/device-management/`：`events.ts`、`device-management-actions.tsx`、`device-management-panel.tsx`、`device-dialog.tsx`、`device-form.ts`、`index.ts`、`device-management-events.test.ts`、`device-form.test.ts`、`device-dialog-initial-type.test.tsx`（新增）。

`apps/fe/src/`：`components/side-panels/connect-devices/{open-add-device.ts,ssh-steps.tsx,open-add-device.test.ts}`、`pages/devices/{add-device-targets.ts,node-device-group.tsx,add-device-menu.tsx}`、`pages/settings/remote-access/{tunnel-model.ts,status-card.tsx,tunnel-model.test.ts,remote-access-tab.test.tsx}`。

`packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` + `bun run build:i18n` 的生成物。

## i18n（3 语各 6 个键，共 18 条）

`settings.remoteAccess.edge.` 下：`label`、`staticActive`、`bypassed`、`bypassFailed`、`bypassFailedFix`、`bypassFailedRetry`。zh_CN 先写，en/ja 同步；均按文案规范（无第二人称、全角标点、数字与英文两侧半角空格）。`bun run build:i18n` 已跑，`resources.ts` / `types.ts` 未手改也未 lint。

## 测试与检查

- `packages/panels`：`bun test` **937 pass / 0 fail**（基线 930，新增 7 条：事件预选 3、表单默认值 2、对话框预选 2）。
- `apps/fe`：`bun test src/` **2410 pass / 0 fail**（收尾时随别的 agent 的新用例一起跑是 2416 pass / 0 fail）（基线约 2400，新增 10 条：`open-add-device` 3、`tunnel-model` 5、`remote-access-tab` 3，其中 `tunnel-model` 有一条是 `degradedError` 的补充）。
- `bunx tsc --noEmit -p apps/fe` 与 `-p packages/panels`：均无输出。
- `bunx biome check`（改动文件所在四个目录，93 文件）：clean。
- `bun scripts/complexity/gate.ts`：本任务相关违规已清零（剩余 4 条全在 `apps/gateway/src/tunnel/{manager,edge-resolver}.ts`，属后端 agent 范围）。
- `packages/shared`：i18n 一致性用例（`src/i18n`）7 pass / 0 fail。

## 说明 / 遗留

- 对话框是 Base UI 的 portal，服务端渲染拿不到内容；`device-dialog-initial-type.test.tsx` 参照既有的 `tool-call-card.dialog.test.tsx` 用 `mock.module` 把 `@tmex/ui/dialog` 换成透传外壳，只为把表单本体渲染出来断言 SSH 区块。该 mock 单独成文件，panels 全量 `bun test` 未受影响。
- 并发观察到的**非本任务**失败：`packages/shared/src/index.test.ts` 的运行时导出快照（别的 agent 新增了 `formatBytes` 等导出，收尾时仍在失败）；`apps/fe/src/page-wrapper.test.tsx` 的 3 条「Too many re-renders」曾随别的 agent 改 `use-page-module.ts` 短暂出现，收尾时已恢复。
- `apps/fe/src/pages/devices/add-device-menu.test.tsx` 的「DropdownMenuLabel contract」用例**单独跑该目录时**会失败（standalone 渲染没有抛错），跑 `bun test src/` 全量时通过——属既有的用例顺序依赖，与本次改动（只把 `onClick={target.open}` 包了一层）无关。
- 另一 agent 跑 `build:i18n` 与我并发时，`apps/fe` 的 i18n core/rest 守卫用例曾瞬时失败一次，重跑即过，属生成物竞态。
