# 执行结果（P1：@tmex/ui，2026-07-06）

## 落地形态

- 新包 `packages/ui`（@tmex/ui，private）：`components/`（21 个 shadcn 组件，git mv 保 blame）+ `utils.ts`（cn）+ `hooks/use-mobile.ts`；`exports` 主入口 + `./*` 子路径直指 src；react/react-dom 为 peerDependencies——后续分包的 package 范式模板。
- fe：47 文件 import 改写（`@/components/ui/*` → `@tmex/ui/*`、cn/useIsMobile 走主入口）；`index.css` 加 `@source "../../../packages/ui/src"`；components.json aliases 与 tsconfig paths 指向包内源码（shadcn CLI 生成落位 packages/ui）。
- Dockerfile 补齐 workspace 包 COPY（@tmex/ui + 存量缺失的 ghostty-terminal）。
- 新增 cn 单测 4 例。

## 验证证据

| 项 | 结果 |
|---|---|
| `bunx tsc --noEmit`（fe） | 0 错误 |
| `bun run --filter @tmex/fe build` | 通过（vite 产物正常） |
| `bun run lint` | 343 错误 < 改动前基线 353（未新增；organizeImports 顺带修复存量排序） |
| bun test | shared 91 / ghostty 108 / ui 4 / app 72 / gateway 826 全 pass（gateway 曾偶现 1 例 switch-barrier 时序 flaky，复跑全绿） |
| Playwright e2e | 87 passed / 3 skipped / 1 failed（`ws-borsh-theme-resize.spec.ts`，**stash 基线复现同样失败**——本环境存量不稳定用例，与本次改动无关） |
| `build:artifacts --outdir … --smoke` | 组装 176 entries，临时实例 `GET /healthz → 200` |
| 明暗双模式截图核对 | devices/settings 页 light+dark 样式完好，`@source` 生效无丢 class |

## 复验（严格「零 break」验收，2026-07-06 晚）

1. **内容等价**：21 个组件 + utils + use-mobile 新旧版本剔除 import 行后逐字节等价；CSS/裸副作用 import 零重排；main.tsx 仅 2 行 import 路径改写；persist/localStorage 零触碰。
2. **全量 e2e 前后对照**（同命令同环境，JSON 报告逐用例 diff，103 用例集完全一致）：回归候选 3 例经重复采样全部排除——mobile-mouse-reporting×2 单跑全过（全量时负载抖动）；theme-propagation rapid-toggle 单 spec 采样基线 4/6 过 vs 改动后 3/4 过（通过率一致，存量抖动用例）；改动后反向修复基线 2 例失败（抖动对称）。**无真回归**。
3. **Dockerfile 隔离演练抓到并修复第二处缺失**：按 COPY 清单在隔离目录完整跑 bun install + build，发现根 tsconfig.json 未入构建上下文（packages/* 的 tsconfig extends 解析失败），补 COPY 后演练通过（f34bb60）。
4. **npm pack --dry-run**：包结构 bin/dist/resources（181 文件）无源码包泄漏；build:artifacts --smoke 复跑探活 200。
5. **组件交互真实走查 8/8**：dialog 开/关、sidebar 折叠展开、tabs 切换、input、select 下拉、switch、settings 五 tab 轮巡（产物形态临时实例）。

## 偏差与遗留

- 本环境全量 e2e 存在约 11-13 例随负载漂移的不稳定用例（两侧基线均复现，集中在 mobile 触控、terminal-mouse-recovery、theme×resize 压力类）；单跑/小组合大多通过。建议后续在低负载 CI 环境建立稳定基线，不阻塞分包推进。
- lint 全仓基线本就有 ~350 个存量错误（多为 shadcn 生成风格与 biome 规则冲突），本次未处理，维持「不新增」原则。
- P2（ws-client）/P3（api-client）/P4（notifications）可并行，见 plan-00.md。
