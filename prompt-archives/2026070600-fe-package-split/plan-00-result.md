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

## 偏差与遗留

- e2e 的 `ws-borsh-theme-resize` 在本工作区（空 dev 库）单跑必失败（快照显示 WS 断连重连），基线相同——建议后续单独排查该用例稳定性，不阻塞分包推进。
- lint 全仓基线本就有 ~350 个存量错误（多为 shadcn 生成风格与 biome 规则冲突），本次未处理，维持「不新增」原则。
- P2（ws-client）/P3（api-client）/P4（notifications）可并行，见 plan-00.md。
