# O3b 结果 — Hub 主备切换前端修正（RV2 #7 / #8）

## 1. 纪元不再由前端算

- 删掉 `nextWriterEpoch()` 与 `HubRoleSwitchPlan.newEpoch`；升主请求只带 `{ mode: 'active', operationId }`，由目标按契约自行取 `max(已知 writerEpoch)+1`（`packages/shared/src/contracts/hub-role.ts` 已允许省略，后端 G4b 并行落地）。
- `HUB_EPOCH_STALE` 仍然处理：`promoteHub` 收到它就**原样重发一次**（让目标按新的最大值重新取号），再失败即报出去，不无限重试。
- 文案去掉 `{{epoch}}` 插值：`nodes.hubs.role.confirmText`、`stepPromote` 三语同步改写，已跑 `bun run --filter @tmex/shared build:i18n`（未对生成文件做 lint/format）。

## 2. 续跑记录在任何改动请求之前落盘

`HubRoleSwitchRecord` 加 `phase: 'admit' | 'demote' | 'promote' | 'wait'` 与 `intent: 'switch' | 'demoteOnly'`（`operationId` / `targetHubId` / `fromHubId` 原本就有）。`hubRoleSwitchPersist(base)` 生成一个只更新 `phase` 的写入器，`runHubRoleSwitch` 在每一步开打**之前**调用一次：`admit → demote → promote → wait`。

新增 `resumeHubRoleSwitch()`，四档进度都能接：

- `wait`：只回读第 4 步（老行为）；若目标自报 `failed` 且有原主，转成恢复态而不是干失败。
- `admit`：先看 `/api/mesh/hubs`，授权已 `signed` 才继续；没签成就收摊报 `errors.resumeAdmit`——重签要用户凭据，不能刷新后替他按下去。
- `demote` / `promote`（即降原主→升目标那个没有 writer 的窗口）：`writerHubId` 还是原主就用**同一个 operationId** 重发降备（目标幂等），已经不是原主就直接重发升主；`writerHubId` 已经是目标则判 `done`，一个请求都不发。
- `intent: 'demoteOnly'`：只重发那条幂等的 `standby`，绝不会误升主。

`loadHubRoleSwitch` 对不认识的 `phase` / `intent` 退到最保守的一档（`wait` / `switch`：只回读，不重发）。

## 3. 升主失败不再只弹 toast

新增结局 `{ kind: 'recover', message, targetHubId, fromHubId }`：**只在原主确已降备**（`switchWriter` 真的发过 standby，或续跑时发现原主已不在写）而升主定局失败（4xx，或跨重启回读到目标自报 `failed`）时给出——原主不可达跳过降备的那条路仍是普通 `failed`（没有可回滚的原主）。

控制器加 `recovery: HubRoleRecoveryPrompt | null` 与 `resolveRecovery('retry' | 'rollback' | 'dismiss')`，`HubRoleRecoveryDialog`（`hub-role-dialog.tsx`）是一个不点就不走的 AlertDialog，压过待确认的计划框；`running` / `switchingIds` / sessionStorage 记录在恢复期间全部保留，刷新后还能从 `promote` 那一档接着跑。重试与回滚**都用新的 operationId**（目标按 operationId 幂等，沿用旧的只会把那条失败记录原样还回来），两者都走同一个 `promoteHub`，并带回同一套恢复上下文，用户可以来回换。

新文案 `nodes.hubs.role.recovery.{title,description,noWriter,retry,rollback,dismiss}` 与 `errors.resumeAdmit`，三语同步（zh 源 → en → ja），按 `tmex-copy-guidelines.md` 写。

## 4. UUID 回退

`randomUuidV4()`：`crypto.getRandomValues`（没有就退 `Math.random`）取 16 字节，补版本位 `0x40` 与变体位 `0x80`，格式化成 RFC-4122 v4，后端 `OPERATION_ID_RE` 收得下。`randomOperationId()` 优先 `crypto.randomUUID`，非安全上下文退到它。

## 文件

- `apps/fe/src/pages/settings/nodes/management/use-hub-role-switch.ts`（主要改动）
- `apps/fe/src/pages/settings/nodes/management/use-hub-role-switch.test.ts`
- `apps/fe/src/pages/settings/nodes/management/hub-role-dialog.tsx`（恢复框 + 去掉 `{{epoch}}`）
- `apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx`（controller stub 补 `recovery` / `resolveRecovery`，加恢复框正文渲染用例）
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` + 生成物 `packages/shared/src/i18n/{resources.ts,types.ts}`
- `nodes-table.tsx` 未改：它只用 `stateOf` / `hubRoleBlockedText`，接口没变。

## 测试 / tsc / lint

| 项 | 基线 | 现在 |
|---|---|---|
| `cd apps/fe && bun test src/` | 1400 pass / 0 fail | **1418 pass / 0 fail**（81 文件，4084 断言） |
| `cd apps/fe && bunx tsc --noEmit -p .` | 0 | **0** |
| `cd packages/shared && bun test src/i18n` | — | 2 pass / 0 fail |
| `bunx biome check <8 个改动文件>` | — | 全部通过（`--write` 过一次格式化，无 lint 修正） |

新增/改写的用例：升主请求键只有 `{mode, operationId}`；`HUB_EPOCH_STALE` 重发一次即成功 / 重发后仍 stale；每一步落盘的 phase 顺序（含 `admit` 那一档与只降备那一档）；原主已降备时升主被拒 / 回读 failed → `recover`，原主不可达时 → 普通 `failed`；`promoteHub` 的重试与回滚两条路；`resumeHubRoleSwitch` 的 6 种进度（wait / wait+failed / demote / promote / promote-已完成 / admit 已签 / admit 未签 / demoteOnly）；记录的 phase 更新与脏 phase 退档；UUID v4 形状、非安全上下文回退、连 `getRandomValues` 都没有时的兜底。

## 留给后续

- 未做实机验证（需要 G4b 的「省略 writerEpoch 由目标分配」先合流，且要两台真 hub）。合流后按 `docs/hub/2026090104-multi-hub-standby.md` 走一遍，重点看：刷新落在 demote→promote 窗口时续跑是否只重发一次升主；升主定局失败时恢复框是否挡得住。
- 恢复框的两个按钮文案按任务要求写死为「重试升级目标」「回滚：重新升级原主 Hub」，具体机器名放在正文 `recovery.noWriter` 里。
- 续跑记录仍只在发起的那个标签页（sessionStorage），不构成互斥；两个标签页同时切同一台 hub 仍靠目标机的 `HUB_ROLE_BUSY` 兜底。
