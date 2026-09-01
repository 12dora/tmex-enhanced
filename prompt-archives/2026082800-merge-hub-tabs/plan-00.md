# plan-00：合并 feat/hub-node × feat/sidebar-tabs-ui 并上线本机

## 背景

`feat/hub-node`（hub/node mesh 多节点架构，75 commit）与 `feat/sidebar-tabs-ui`（3-tab 侧边栏 + 数十个 perf/bugfix）都从 `main`（`4a14ff2` / `bf5b998`）拉出，互不相知。2026-08-28 把 hub-node 单独构建上线本机后，用户发现左侧菜单从 3-tab 退回旧结构——因为 tabs 分支的改动完全不在这份构建里，同时丢失的还有 OSC 52 剪贴板修复、ghostty 渲染与滚动性能、terminal-ui resize、legacy history 恢复等一批修复。

用户决策：合并两个分支，之后删除 `feat/sidebar-tabs-ui` 分支，避免同类问题再次发生。

## 关键约束

### 生产库迁移顺序（硬约束）

本机生产库 `~/Library/Application Support/tmex/data/tmex.db` 的 `__drizzle_migrations` 已按下列顺序应用过两个分支各自的 `0018`：

| rowid | when | 来源 |
|---|---|---|
| 19 | 1787808955472（2026-08-27 05:35 UTC） | tabs 的 `0018_agent_query_indexes` |
| 20 | 1787844349224（2026-08-27 15:25 UTC） | hub 的 `0018_hub_auth` |

drizzle 的 sqlite migrator 按 `when > 库内最大 created_at` 决定是否执行。因此合并后**必须**保持：`0018 = agent_query_indexes`（when 不变）、`0019 = hub_auth`（when 不变）。反过来编号会让生产库重复执行 `CREATE INDEX` 而报错。

### 其他

- 不改版本号 / CHANGELOG / 发版脚本（本仓库是 fork，改动要能直接回馈上游）。
- 生成文件（i18n `resources.ts` / `types.ts`）合并后必须用 `bun run build:i18n` 重建，不得手改、不得 lint。
- 严禁触碰生产 tmex 服务目录与名为 `tmex` 的 tmux session；验证一律用临时实例。

## 冲突面

`git merge feat/sidebar-tabs-ui` 产生 26 个冲突文件、约 41 处冲突块：

| 分组 | 文件数 | 负责人 |
|---|---|---|
| `apps/gateway/src/**`（api/files、db/schema、db/managed-migrations、ws/*） | 10 | grok 4.6 high |
| `apps/fe/**` + `packages/panels/**` + `packages/stores/**` | 13 | Opus 5 high |
| `apps/gateway/drizzle/**`（重编号 + journal + snapshot） | 3 | 指挥官 |
| `docs/2026021000-tmex-bootstrap/deployment.md`（modify/delete） | 1 | 指挥官 |

## 分工与流程

1. **探索（codex gpt-5.6-luna xhigh，只读）**：产出「语义丢失风险清单」——逐文件列出两侧引入的可验证行为点，标注真冲突、隐性耦合，以及被 git **静默自动合并**（无冲突标记但可能语义错乱）的风险文件。产物 `sub/explore-conflicts.md`。
2. **后端（grok 4.6 high）**：解 gateway 10 个文件。产物 `sub/backend-result.md`。
3. **前端（Opus 5 high）**：解 fe/panels/stores 13 个文件，核心是让 **3-tab 侧边栏（tabs 侧）** 与 **node 聚合分节（hub 侧）** 共存——tab 是外层容器，node 分节与设备树是「设备」tab 的内容。产物 `sub/frontend-result.md`。
4. **指挥官**：drizzle 重编号（`0018_hub_auth.sql` → `0019_hub_auth.sql`，`meta/0018_snapshot.json` 取 tabs 版、新建 `meta/0019_snapshot.json` = hub 版 + agent 索引且 `prevId` 指向 tabs 版、`_journal.json` 两条并存）、`deployment.md` 保留 hub 重写版、`docs/README.md` 补 bootstrap 与 hub 两个小节、i18n 生成文件重建。
5. **审查（codex gpt-5.6-sol high）**：按 backend / frontend / 全局三路并行，对照探索阶段的 checklist 核验是否有一侧语义被合丢。codex 偏过度防御，逐条由指挥官判定后再派修复。
6. **上线**：全量 `bun run build` → `npm pack` → 临时实例烟测（临时 env + 端口 19983 + 临时库）→ `npx ./tmex-cli-1.0.2.tgz upgrade --apply-current-package --yes --lang zh-CN` → 校验 `/healthz`、迁移条数不新增（应仍为 20 条）、3-tab 侧边栏可见。
7. **收尾**：合并结果推 origin，删除 `feat/sidebar-tabs-ui`（本地 + 远端）与其 worktree。

## 验收标准

| 包 | hub-node 基线 | tabs 基线 | 合并后要求 |
|---|---|---|---|
| apps/gateway | 1823 pass / tsc 23 | 1870 pass / tsc 25 | ≥ 1870 pass，0 fail，tsc ≤ 25 |
| packages/panels | 217 / 0 | 347 / 0 | ≥ 347 pass，0 fail，tsc 0 |
| packages/stores | 125 / 1 | 214 / 1 | ≥ 214 pass，0 fail，tsc ≤ 1 |
| apps/fe | 208 / 0 | 109 / 0 | ≥ 208 pass，0 fail，tsc 0 |

外加：`packages/shared`、`ws-client`、`api-client`、`terminal-ui`、`ui`、`notifications`、`theme`、`app` 各包 0 fail 且 tsc 不高于既有基线；`bunx drizzle-kit generate` 报无 schema 变更（证明 snapshot 与 schema.ts 一致）；standalone e2e 不低于既有基线（7 个既有失败见 `docs/known-issues.md`）。

## 风险

- **静默自动合并**：无冲突标记但语义错乱的文件（`stores/src/index.ts`、`stores/src/runtime.ts`、`ws-client/src/connection.test.ts`、gateway ws 下其他 auto-merge 文件）比显式冲突更危险，探索与审查阶段重点排查。
- **侧边栏融合**：两侧都重写了侧边栏容器与设备列表，是本次最容易「看起来能跑但少一半功能」的地方，必须人工看 UI 验证。
- **迁移编号**：若编号或 `when` 写错，生产升级会在迁移阶段失败；上线前用临时实例 + 生产库副本演练可提前发现。
