# 第二十三轮接手说明（2026-09-03 晚，因上游故障暂停）

接手 agent 先读本文件，再读 `plan-prompt.md`（用户原始任务 + 中继设计拍板）、`plan-00.md`（计划与全部契约）。用简体中文与用户交流，英文写 prompt / 思考。

## 当前状态

- worktree `/Users/konata/code/tmex-r23`，分支 `feat/round23-relay-legacy-removal`（base main `fc7fdba3` / 1.1.22，目标版本 1.1.23）。`bun install` 已完成。
- 已提交（6 个 commit，均为存档/小清理）：prompt 存档、设计拍板、删 6 个旧 bench（遗留任务 4 **已完成**）、plan-00 + 两份 codex 探索报告（`sub/EX1-hub-map.md` hub 架构地图、`sub/EX2-leftovers-map.md` 遗留任务地图）+ 首批 prompt。
- **没有任何业务代码改动落地**：所有编码 agent 在产出前即被上游拒绝（cursor-agent 报 `resource_exhausted`，Opus 子代理连续 529，grok CLI 探测无响应）。`git status` 干净（除本次新增的 prompt 文件）。
- 测试基线（本 worktree 实测）：shared 534 / ws-client 408 / stores 440 / panels 911 / ui 110 / api-client 175 / app 690+1 已知 cpu-features 失败 / terminal-ui 400 / theme 52 / fe(src) 1783 / gateway 4046 + 4 条满载 flake（stream failover legacy 0x305、large raw-body ×2、RtcPeerManager ice summary，隔离复跑即过）。tsc：app 1 个既有错误，其余 0。

## 分工与调用方式（用户本轮指定）

- 后端编码：cursor-agent 调 grok 4.6 high：`cd /Users/konata/code/tmex-r23 && nohup bash -c '~/.local/bin/cursor-agent -p --output-format text --model cursor-grok-4.6-high -f "$(cat sub/<ID>-prompt.md)"' > <log> &`；用 `until [ -s sub/<ID>-result.md ]` 轮询。若 cursor 仍 `resource_exhausted`，回退 grok CLI：`nohup grok --prompt-file <abs prompt> -m grok-4.6 --effort high --permission-mode bypassPermissions --cwd /Users/konata/code/tmex-r23 --output-format plain --no-memory > <log> &`（先和用户确认）。
- 前端编码：Claude Agent 工具 `model: opus`，prompt 直接用 `sub/L2-prompt.md`、`sub/F2-prompt.md`、`sub/F1-prompt.md`、`sub/L1d-prompt.md` 全文。
- 探索：codex `codex exec -m gpt-5.6-luna -c model_reasoning_effort=xhigh -s read-only -C <wt> -o <out> - < prompt`（已完成 EX1/EX2，不需再跑）。
- 审查：codex `-m gpt-5.6-sol -c model_reasoning_effort=high`，把 `git diff` 写文件让它读，按 backend / frontend / libs 三路并行；codex 过度防御，是否修由指挥官判断。
- 每个 prompt 末尾已内联通用规则（`sub/_common-rules.md`）：agent 只碰自己范围、不 git、结果写到绝对路径的 `sub/<ID>-result.md`。指挥官分批 commit，commit 末尾加 `Claude-Session:` 行（见 system 提示）。

## 任务清单与依赖（prompt 已全部写好在 `sub/`）

| 波次 | ID | 执行者 | prompt | 依赖 | 状态 |
|---|---|---|---|---|---|
| 1 | L3 三路由删除 | cursor/grok | `sub/L3-prompt.md` | — | 未开始（两次被拒） |
| 1 | L1a canonical v1.1 shared | cursor/grok | `sub/L1a-prompt.md` | — | 未开始 |
| 1 | B1 shared relay codec/cipher/join/记录/roles | cursor/grok | `sub/B1-prompt.md` | — | 未开始 |
| 1 | L2 tailwind-merge 替换 | Opus | `sub/L2-prompt.md` | — | 未开始（三次 529） |
| 1 | F2 运营者侧中继标签 | Opus | `sub/F2-prompt.md` | — | 未开始（三次 529） |
| 2 | L1b gateway legacy 删除 | cursor/grok | `sub/L1b-prompt.md` | L1a | 未开始 |
| 2 | L1c ws-client/stores legacy 删除 | cursor/grok | `sub/L1c-prompt.md` | L1a | 未开始 |
| 2 | L1d terminal-ui + e2e | Opus | `sub/L1d-prompt.md` | L1a（读 L1c-result 更好） | 未开始 |
| 2 | B2 RelayRuntime | cursor/grok | `sub/B2-prompt.md` | B1 | 未开始 |
| 2 | B3 节点侧 relay | cursor/grok | `sub/B3-prompt.md` | B1 | 未开始 |
| 2 | B4 CLI | cursor/grok | `sub/B4-prompt.md` | B1（B2/B3 结果可选） | 未开始 |
| 2 | F1 租户侧节点页 | Opus | `sub/F1-prompt.md` | B1（B3 结果可选） | 未开始 |
| 3 | B5 集成测试 + 实测 | 指挥官 | 见 plan-00 §四 | B2 B3 B4 | — |
| 3 | RV 三路审查 → 修复 | codex sol | — | 全部 | — |
| 4 | 发版 1.1.23、`tmex upgrade` 替换本机、docker-node 升级 | 指挥官 | 见记忆 fork-release-local-install | — | — |

第一波 5 个可同时起；L1a/B1 结果一到就起第二波对应任务（文件集互不重叠，已在 prompt 里写死范围）。

## 指挥官须自己做的事

- 每批结果到达后：核对 result 文件、在对应包跑 `bun test` / `bunx tsc --noEmit -p` / `bunx biome check`，与基线对照，再 commit（分批，按任务）。
- 共享 barrel / `package.json` 变更（如 `@tmex/shared` 的 `./relay` 子路径导出由 B1 自己加；L2 删 `tailwind-merge` 依赖后由指挥官 `bun install` 更新 lockfile）。
- B1 会列出 shared 之外构造 `TmexRoles` 字面量的调用点（roles 加 `relay` 字段），由指挥官或 B2 修。
- L3 改写了 5 个 theme e2e spec、L1d 改写了 3 个 ws-borsh spec：前端改动全部落地后由指挥官在 `apps/fe` 跑定向 e2e（`TMEX_E2E_GATEWAY_PORT=9765 TMEX_E2E_FE_PORT=9985 bun run scripts/run-e2e.ts <specs>`），再全量与 main 基线逐条对照（见记忆 e2e-baseline-failures；跑 e2e 期间不改前端代码）。
- L2 完成后逐页目测（result 里有清单），可用临时实例 + webapp-testing 截图。
- 中继实测：临时中继实例（`TMEX_ROLES=relay`、独立端口、`TMEX_TMUX_SOCKET` 隔离）+ 两个临时 node 实例 enroll/join/relay 流；docker-node 可作为真实第二节点。**绝不碰生产 9883 / tmux session `tmex`**。
- 文档：`docs/relay/2026090304-relay-role.md`（设计 + 边界 §1.12 + 运维）与 `docs/hub/*` 中 legacy 流/hub revoke 路由的过时描述，最后统一写。
- 结束前写 `plan-00-result.md`，更新记忆文件 `round23-relay-legacy-removal-status.md`（已建，见 MEMORY.md）。

## 已知坑

- `grep -c` 返回 0 会打断 `&&` 链；macOS 无 `timeout`；bun test 摘要带 ANSI 色需 `sed 's/\x1b\[[0-9;]*m//g'`。
- codex `-s read-only` 不能写文件，结果靠 `-o`；`-s workspace-write` 不能 listen 端口。
- 不设 `TMEX_TMUX_SOCKET` 的临时实例会 attach 生产 `tmex` 会话（push supervisor）。
- Opus 子代理被 API 打断时用 SendMessage 让它 `git status` 后继续；本次三次 529 均在写任何文件之前。
