# snapshot-format 执行结果

## 背景

`splitSnapshotFields`（原 CC≈25）按 fieldCount 分支拼自由文本；`parsePaneSnapshotRow`（原 CC≈16）手写拆字段 + 校验。公开行为保持不变。先按当前实现对齐特征化测试，再改 tokenizer + 列定义表。

## 改了什么

### `snapshot-format-tokenize.ts`（新）

字符扫描 tokenizer：遇 `|` 切字段；`\|` **不**当作转义（反斜杠留在前一字段，分隔符仍切开），与改前 `String.split('|')` 一致。多余 `|` 由 layout 表折回自由文本字段。

| 符号 | 职责 |
| --- | --- |
| `tokenizeSnapshotFields` | 按分隔符切 token，显式处理 `\|` |
| `FLEXIBLE_FIELD_LAYOUTS` | fieldCount → `{ prefix, suffix }`（2/4/8/9） |
| `foldFlexibleFields` | token 数超出时把中间段 join 回一个字段 |
| `parseSnapshotColumns` | 列定义表（name / parse / required）填行；required 解析 `null` 则整行丢弃 |

### `snapshot-format.ts`

- `splitSnapshotFields`：tokenize → 查 `FLEXIBLE_FIELD_LAYOUTS` → fold。未知 fieldCount 原样返回 token。
- `parsePaneSnapshotRow`：tokenize → pane 专用 layout `{ prefix: 9, suffix: 2 }` → `PANE_COLUMNS` 表驱动解析。
- 未把 fieldCount `12` 写入公开 layout 表，避免改变从未被调用的 `splitSnapshotFields(line, 12)`。

复杂度（阈值 12 / 60 行）：

| 函数 | CC | 行数 |
| --- | --- | --- |
| `splitSnapshotFields` | 2 | 8（原 ≈25 / 48） |
| `parsePaneSnapshotRow` | 1 | 4（原 ≈16 / 44） |
| `tokenizeSnapshotFields` | 5 | 19 |
| `foldFlexibleFields` | 2 | 13 |
| `parseSnapshotColumns` | 5 | 16 |
| `assignSnapshotColumn` | 3 | 16 |

## Bug 修复

无行为 bug。等行为重构。

## 测试

先按当前实现写特征化用例（空串、末尾分隔符、`\|`、错误字段数、空白自由文本、非法可选几何），确认 33 pass，再改实现。原有用例保持绿色。

新增覆盖：

- `splitSnapshotFields`：空串、末尾 `|`、过长时 `|` 折进自由字段、`\|` 仍切开、字段过少、未知 fieldCount、fieldCount 8、空中间字段、session 两字段。
- `parsePaneSnapshotRow`：空串、字段过少、末尾分隔符、title 里的 `\|`、多余尾字段并入 title、空白自由文本、title 保留两侧空白 / command·path trim、非法 left/top 不丢行。
- tokenizer / fold 单测。

```
cd apps/gateway && bun test src/tmux-client/snapshot-format.test.ts
# 39 pass / 0 fail
cd apps/gateway && bun test src/tmux-client/snapshot-format.test.ts src/tmux-client/external/snapshot-projector.test.ts
# 63 pass / 0 fail
```

## 文件清单

- 新建：`apps/gateway/src/tmux-client/snapshot-format-tokenize.ts`
- 修改：`apps/gateway/src/tmux-client/snapshot-format.ts`
- 修改：`apps/gateway/src/tmux-client/snapshot-format.test.ts`
- 未改：`parseWindowSnapshotRow`（不在本次 rewrite 列表）、`snapshot-projector.ts` 及其它 tmux-client 文件

## 验证

- `bunx biome check --write` 上述 3 个文件：通过。
- 相关测试：39 pass / 0 fail。
- `cd apps/gateway && bun test`：**1867 pass / 0 fail**（任务基线 1826 / 0；本任务 +23 条特征化/tokenizer 用例，其余增量来自并行任务）。
- `bunx tsc --noEmit -p .`：25 个 `error TS`，与任务基线一致；**本任务文件 0 条**。

## 未做 / 为何

- 未把 `\|` 解成字面 `|`：当前实现与 tmux `-F` 行都不转义分隔符；特征化锁定「反斜杠不能阻止切开」，自由文本里的 `|` 仍靠 layout fold。
- 未改 `parseWindowSnapshotRow`：任务只要求 rewrite `splitSnapshotFields` 与 `parsePaneSnapshotRow`。
- 未把 pane 的 12 列 layout 并入公开 `FLEXIBLE_FIELD_LAYOUTS`：避免改变未使用的 `splitSnapshotFields(_, 12)`。
- 未从 `snapshot-format.ts` 再导出 tokenizer：公开 API 不变，测试直接从 helper import。
