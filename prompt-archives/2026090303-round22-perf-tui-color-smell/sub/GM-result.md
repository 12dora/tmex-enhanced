# TASK GM 结果（B3 → B2 + 死 `*Row`）

工作区：`/Users/konata/code/tmex-r22`（`feat/round22-perf-tui-color-smell`）
日期：2026-09-03

先做 B3，再做 B2。`ws/` 以当前文件为准（报告行号已过期）。

---

## B3 — 打破 borsh dispatcher ↔ kind-handlers 四环

叶子类型/工具抽到 `apps/gateway/src/ws/borsh-kind-types.ts`：

- `BorshDispatchHost` / `BorshKindHandler` / `BorshKindHandlerMap`
- `schemaHandler` / `decoderHandler` / `decodeBorshKindPayload`

`borsh-dispatcher.ts` 只留装配（`createBorshKindHandlers`）与 `dispatchBorshKind`，并 **re-export** 叶子符号，让 `index.ts` / 既有测试的 import 路径不变。

kind-handlers 全部改从 `borsh-kind-types` 取值导入：

| 文件 | 原 import | 现 import |
|---|---|---|
| `agent-kind-handlers.ts` | `./borsh-dispatcher` | `./borsh-kind-types` |
| `canonical-kind-handlers.ts` | 同上 | 同上 |
| `tmux-kind-handlers.ts` | 同上 | 同上 |
| `tmux-viewport-handlers.ts` | 同上 | 同上 |

值导入图（已核对，`import type` 不计）：

```
borsh-dispatcher → {agent,canonical,tmux}-kind-handlers → borsh-kind-types
tmux-kind-handlers → tmux-viewport-handlers → borsh-kind-types
borsh-kind-types ↛ dispatcher / 任何 *-kind-handlers
```

四个环已断。`*-kind-handlers.ts` 与 `tmux-viewport-handlers.ts` 中 **零处** `from './borsh-dispatcher'`。

---

## B2 — `tmux-command-handlers.ts` 分三簇

| 文件 | 行 | 内容 |
|---|---:|---|
| `tmux-command-handlers.ts` | **381**（原 892，门槛 ≤400） | `TmuxCommandHost` + 结构操作（create/close/rename/reorder/split/focus/paste/input/history/stacked layout） |
| `tmux-selection-handlers.ts` | 179 | `canSelectWindow` / `canSelectPane` / `handleTmuxSelect` / `handleTmuxSelectWindow`；`findWindowForPane` re-export |
| `tmux-geometry-handlers.ts` | 356 | 视口/尺寸：`handleTermResize`、`handleTermViewport`、`applyViewportPolicy`、`distrustLive`、`handleResizePaneById` 等 |

**未合并两条 resize 语义**（round-21）：

- 浏览器上报：`handleTermViewport` → `recordViewportClaim(..., { applyUnknown: false })`
- 暖切换：`handleTmuxSelect` 在 `wantHistory=false` 时传 `distrustLive: true`（并 `skipResize: false`），不信任快照几何
- `handleTermResize` 仍走 `applyUnknown: true`

`findWindowForPane` **实现**落在 geometry（该簇四处使用），selection **re-export** 以符合分簇表。这样只有 `selection → geometry` 单向值依赖，避免 `selection ↔ geometry` 新环。geometry / selection 对 `TmuxCommandHost` 只用 `import type`。

`tmux-command-facade.ts` 不在可改文件内，主文件 **re-export** facade 仍从旧模块取的符号（`handleTmuxSelect` / `handleTermResize` / `dropViewportClaims` / `reconcileDeviceViewportSnapshot` 等）。测试侧 `handleTmuxSelect` 已改从 `tmux-selection-handlers` 导入。

`ws/index.ts` 的 import 行未改：`TmuxCommandHost` 仍在主文件。`tmux-kind-handlers.ts` 只动了 B3 的 borsh import。

---

## 死 `*Row` 类型

删除前对 `apps/` + `packages/` 再 grep，15 个均仅声明、零引用。已从 schema 域文件删除；**保留 `NodeRow`**。

| 文件 | 删除 |
|---|---|
| `db/schema/users-auth.ts` | `UserRow` `UserKeyRow` `UserKeyLogRow` `NodeSessionRow` `NodeCertRow` `EnrollmentTokenRow` |
| `db/schema/mesh.ts` | `NodeIdentityRow` `PeerCacheRow` `HubTrustRow` `MeshHubRow`（留 `NodeRow`） |
| `db/schema/settings.ts` | `TlsConfigRow` `TunnelConfigRow` `TunnelAccessRow` `LocalAuthSettingsRow` `NodeAccessPolicyRow` |

---

## 测量

| 项 | 改前 | 改后 |
|---|---|---|
| `tmux-command-handlers.ts` 行数 | 892 | **381** |
| gateway `tsc --noEmit` error | 0 | **0** |
| `bun test src/ws src/db` | （改后一次跑） | **450 pass / 0 fail**（58 files） |
| biome（本任务 13 个文件） | — | 通过（`--write` 只整理了测试 import 顺序） |
| `bun scripts/complexity/gate.ts` | — | **失败 1 条，非本任务文件**：`apps/gateway/src/mesh/peer-manager.ts` 1939 > allowlist 1930。本任务文件均 ≤900、无 CC/函数行数违规。 |

pane-stream 并行改动未打断 `src/ws` 模块加载，无需重跑。

---

## 改动文件清单

新建：

- `apps/gateway/src/ws/borsh-kind-types.ts`
- `apps/gateway/src/ws/tmux-selection-handlers.ts`
- `apps/gateway/src/ws/tmux-geometry-handlers.ts`

编辑：

- `apps/gateway/src/ws/borsh-dispatcher.ts`
- `apps/gateway/src/ws/agent-kind-handlers.ts`
- `apps/gateway/src/ws/canonical-kind-handlers.ts`
- `apps/gateway/src/ws/tmux-viewport-handlers.ts`
- `apps/gateway/src/ws/tmux-kind-handlers.ts`（import 行）
- `apps/gateway/src/ws/tmux-command-handlers.ts`
- `apps/gateway/src/ws/tmux-command-handlers.test.ts`（`handleTmuxSelect` import）
- `apps/gateway/src/db/schema/{users-auth,mesh,settings}.ts`

未改：`ws/index.ts`（无需动 import）、`ws/tmux-command-facade.ts`（非占用；靠主文件 re-export 维持）、`device-connection-registry.ts` / `canonical/*` 等。

---

## 未做 / 注意

- 复杂度门禁全仓仍红，原因是并行 agent 的 `peer-manager.ts`，本任务无法改该文件。
- 未给 `recordViewportClaim` 新加单测：行为未变，既有 `tmux-command-handlers.test.ts`（`wantHistory` / `distrustLive`）与 `viewport-claims.test.ts` 覆盖。
