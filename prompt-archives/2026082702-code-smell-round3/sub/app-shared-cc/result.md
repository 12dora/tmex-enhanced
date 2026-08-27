# app-shared-cc 执行结果

## 背景

降低 `sanitizeBunPath` / `runDoctor` / `parseNode` 的圈复杂度，公开行为不变。检查表顺序仍为 platform → dependencies → install → service → health；bun 路径优先级仍按 `docs/update/2026061502-bun-path-resolution.md`（显式 → execPath → meta → 动态探测 → 硬编码 fallback）。

## 改动

### 1. `packages/app/src/lib/bun.ts` `sanitizeBunPath`

原函数（CC≈18）同时做 ANSI 剥离、按行收集、控制字符清洗和路径排序。拆成：

| 函数 | CC | 行数 | 职责 |
| --- | --- | --- | --- |
| `stripAnsiEscapes` | 5 | 17 | CSI / OSC 剥离（`skipCsi` / `skipOsc`） |
| `extractSanitizedLines` | 4 | 21 | CR/LF 拆行、去控制字符、trim、丢空行 |
| `selectPreferredBunPath` | 4 | 11 | 最后一个以 `/` 开头的行，否则最后一行 |
| `sanitizeBunPath` | 1 | 3 | 三者组合 |

`checkBunVersion` / `probeBunCandidates` 未改（优先级链保持原样）。

### 2. `packages/app/src/commands/doctor.ts` `runDoctor`

原函数（CC≈21）把收集、渲染、`--fix`、hint、exitCode 揉在一起。改为表驱动 + 共享 reporter：

| 函数 | CC | 行数 | 职责 |
| --- | --- | --- | --- |
| `DOCTOR_CHECK_TABLE` | — | — | platform / dependencies / install / service / health |
| `runCheckTable` | 2 | 10 | 按 descriptor 拼接 `DoctorCheck[]` |
| `filterFixableFailures` / `isInstallableDep` / `shouldPrintFixHint` | ≤3 | — | 纯判定 |
| `buildDepFixPlan` / `planDoctorFix` | ≤3 | — | bun/tmux 安装计划（可注入 planner） |
| `doctorRunDecision` | 5 | 14 | fix / hint / done + exitCode |
| `reportDoctorRun` | 4 | 15 | 渲染 + hint + 设 exitCode（`DoctorReporter` 可注入） |
| `runDoctor` | 2 | 9 | 编排：load → collect → report → 可选 fix 后重跑 |

未改 `doctor-checks.ts`（检查实现已在那边）。去掉了原来的 `check.id as 'bun' \| 'tmux'`。

### 3. `packages/shared/src/tmux-layout.ts` `parseNode`

字符级递归下降改为 tokenizer + 节点构建：

| 函数 | CC | 行数 | 职责 |
| --- | --- | --- | --- |
| `tokenizeLayoutBody` | 8 | 26 | 数字 / `x` / `,` / `{}` / `[]` |
| `parseLayoutBounds` | 8 | 31 | `WxH,X,Y` |
| `parseSplitChildren` | 5 | 24 | 逗号分隔子节点直到匹配 closer |
| `buildLayoutNode` | 10 | 46 | leaf 或 row/column |
| `parseWindowLayout` | 8 | 18 | checksum + tokenize + 建树 + 必须耗尽 token |

未改 `packages/shared/src/index.ts` 的公开导出。

## Bug

无行为修复。公开函数语义与原来一致。

## 测试

- `bun.test.ts`：原 `sanitizeBunPath` / `checkBunVersion` 保留；新增 `stripAnsiEscapes`（含 OSC ST）、`extractSanitizedLines`、`selectPreferredBunPath`（多绝对路径取最后一个）。
- 新建 `doctor.test.ts`：检查表顺序、`runCheckTable` 拼接、fixable 过滤、bun/tmux plan、hint/json/exitCode、注入 reporter。
- `tmux-layout.test.ts`：原样本保持；新增嵌套 `[]{{}}`、tokenizer、`buildLayoutNode`（单叶 / 嵌套 / 单子节点 split / 截断 leaf）。畸形输入原表仍绿。

## 文件

- 修改：`packages/app/src/lib/bun.ts`、`packages/app/src/lib/bun.test.ts`
- 修改：`packages/app/src/commands/doctor.ts`
- 新建：`packages/app/src/commands/doctor.test.ts`
- 修改：`packages/shared/src/tmux-layout.ts`、`packages/shared/src/tmux-layout.test.ts`
- 未改：`packages/app/src/commands/doctor-checks.ts`、`packages/shared/src/index.ts`

## 验证

- `bunx biome check --write` 上述 6 个文件：通过
- `cd packages/app && bun test src/lib/bun.test.ts src/commands/doctor.test.ts`：43 pass / 0 fail
- `cd packages/app && bun test`：128 pass / 0 fail（基线 100；本任务 +28）
- `cd packages/shared && bun test src/tmux-layout.test.ts`：25 pass / 0 fail
- `cd packages/shared && bun test`：183 pass / 0 fail（基线 175；本任务 +8）
- `packages/app` `bunx tsc --noEmit -p .`：1 error（`Cannot find type definition file for 'node'`，与基线一致）
- `packages/shared` `bunx tsc --noEmit -p .`：0 error
- `cd apps/gateway && bun test`：1715 pass / 34 fail / 7 errors，均与本任务无关（并行 agent 改动：`pane-emulator-create`、`hierarchy-fields`、`run-command-*` 模块缺失等）

CC 实测（脚本阈值 12）：`sanitizeBunPath` / `runDoctor` / `parseNode` 均已不在列表中；本任务触及的新 helper 全部 CC ≤ 10、≤ 46 行。

## 未做 / 为何

- 未拆 `checkBunVersion`（CC 14）——任务指定的是 `sanitizeBunPath`
- 未拆 `doctor-checks.ts` 的 `checkEnvironment`（CC 13）——任务允许改它但非必须
- tokenizer / builder 未加入 `@tmex/shared` barrel——保持原公开签名
- 未对 `runDoctor` 做真实 install-dir 集成测试（会碰到生产路径）；编排路径用纯 helper + 假 reporter / planner 覆盖
