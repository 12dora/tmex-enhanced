# TerminalShortcutsEditor 拆分结果

## 目标

`packages/panels/src/settings/TerminalShortcutsEditor.tsx`（512 行，主组件 306 行）是「状态 + 视图」混杂的上帝组件，拆成数据层 hook + 三块视图 + 布局壳，并补纯逻辑单测。

## 产出文件

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `TerminalShortcutsEditor.tsx` | 89 | 布局壳：加载/错误占位、拼装四个子块、保存/重置页脚 |
| `use-terminal-shortcuts-editor.ts` | 358 | 数据层：草稿态、基线对齐、增删改排序、录入表单、保存 mutation，外加全部纯函数 |
| `shortcut-list.tsx` | 201 | 拖拽列表：`DndContext` + sensors + 行（action / send 两种字段组） |
| `shortcut-add-panel.tsx` | 118 | 三种录入入口：按键捕获、内置动作、高级手填 |
| `shortcut-preview.tsx` | 56 | 实时预览 + 图标开关 |
| `shortcut-action-meta.ts` | 13 | action 图标表（列表徽标与添加按钮共用，避免跨视图文件互相 import） |
| `use-terminal-shortcuts-editor.test.ts` | 176 | 纯函数单测（27 例） |

## 数据层设计

- `TerminalShortcutsEditorModel` 是视图唯一消费面：`items / useIcons / dirty / ready / isSaving` + `save / reset / updateLabel / updatePayload / removeItem / reorder / addAction / addForm`。
- 主 hook 由三个私有子 hook 组合，均短小：`useShortcutDraft`（草稿 + 基线 + dirty）、`useShortcutSaveMutation`（保存 + toast + 基线回写）、`useShortcutAddForm`（捕获态 / 高级面板 / 手填字段）。主 hook 本体 54 行。
- 列表变更全部下沉为纯函数：`reorderShortcuts / removeShortcut / setShortcutLabel / setShortcutPayload / appendSendShortcut / appendActionShortcut / defaultShortcutDraft`，无命中时返回原数组引用。
- 原先「初始化 + 未编辑时跟随服务器」的三段 `useEffect` 分支压成一个纯判定 `shouldAdoptServerShortcuts(server, baseline, draft)`，语义与原实现逐条等价（基线为空必采纳；服务器与基线一致则不动作，避免自循环；草稿已编辑则不覆盖）。`sameShortcutItems` 归一化比较（键顺序无关）原样保留。
- 拖拽 sensors 与 `DragEndEvent` 解析留在 `ShortcutList` 内，只把 `(activeId, overId)` 交回数据层，`arrayMove` 用 3 行 splice 自实现，测试不必加载 dnd-kit。

## 行为保持

- **全部 data-testid 逐字节一致**：与 `git show HEAD` 版本 diff 提取结果为空（`terminal-shortcuts-editor / terminal-shortcuts-error / shortcut-preview / shortcut-use-icons / shortcut-editor-list / shortcut-editor-row-* / shortcut-editor-label-* / shortcut-editor-payload-* / shortcut-editor-remove-* / shortcut-capture-input / shortcut-add-action-* / shortcut-manual-label|payload|add / shortcut-reset / shortcut-save`），`apps/fe/tests/terminal-shortcuts.spec.ts` 依赖的选择器与结构（预览复用 `ShortcutButtonRow`、列表行数、图标开关、保存按钮 disabled 条件）不变。
- 解析行为完全没碰 `@tmex/terminal-ui`：`parseEscapeSequence / escapeForDisplay / keyEventToTerminalSequence` 的调用点与时机（payload 失焦解析、捕获 keydown、手填 add）原样迁移。
- 未新增 i18n key，`build:i18n` 无需重跑；`index.ts` 导出面不变（`TerminalShortcutsEditorProps` 从 hook 文件定义、由组件文件 re-export）。
- 唯一可见差异：`props` 不再解构后逐个传，而是整体交给 hook；`ShortcutPreview` 与 `ShortcutIconsToggle` 拆成两个导出但渲染 DOM 不变。

## 测试

`use-terminal-shortcuts-editor.test.ts` 覆盖：重复添加同一按键（追加为独立条目，仅 id 不同）、label 空回退 payload、payload 空为无效录入、action 追加、按 id 删除 / 删除不存在项、排序（前移后移、同项与未知 id 原样返回）、label/payload 局部更新、dirty（基线为 null、条目变更、图标开关变更、保存后回到干净、重置相对空基线）、`shouldAdoptServerShortcuts` 四种分支。

## 验证

- `cd packages/panels && bun test src/settings` → 36 pass / 0 fail（3 文件）；`bun test` 全包 → 323 pass / 0 fail。
- `bunx tsc --noEmit -p .` → 本次改动文件零报错；仅剩其它 agent 在改的 `packages/ws-client/src/state-machine.ts`（先前一轮还有 `pane-sink-registry.ts` 的 `PaneHistoryGates` 相关错误，均非本任务文件）。
- `bunx biome check --write` 覆盖 7 个改动/新增文件，仅格式化，无 lint 诊断。
- `cd packages/terminal-ui && bun test src/utils/terminalKeySequence.test.ts` → 66 pass / 0 fail（未改该包，作回归确认）。
