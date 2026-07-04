# 执行结果

按 plan-00 完成，全部验收通过。

## 改动清单

### packages/ghostty-terminal

- `file-path.ts`（新增）：纯 POSIX 路径工具——`normalizePosixPath` / `resolvePathCandidate`（相对路径基于 cwd）/ `isWithinRoots` / `resolveValidFilePath`。不支持 `~`（前端无法得知远端 home）。
- `link-detector.ts`：新增 `detectMatchesInWrappedLines`，统一识别 URL + 文件路径候选。文件路径三种形态：绝对/显式相对（`/a`、`./a`、`../a`）、含斜杠相对（`src/a.ts`）、带字母扩展名的裸文件名（`main.rs`），均可带 `:line[:col]` 后缀（计入可点区间、不参与解析）。先识别 URL 并掩掉区间再匹配文件候选；lookbehind 防止从 `~/work` 的 `/work` 处误匹配；匹配段末尾宽字符 endCol 扩展到 spacer-tail。`detectLinksInWrappedLines` 改为复用新函数（URL-only，导出兼容）。
- `terminal.ts`：
  - `setFileLinkContext({cwd, rootPaths})` / `onFileLinkActivated(cb)` 新 API；命中/点击分派 typed match，file 候选须解析有效才命中，回调收到解析后的绝对路径。
  - 下划线 overlay：render 后节流重算（`LINK_OVERLAY_THROTTLE_MS=150`，trailing 保证终态）；只扫可见 viewport 行（按 wrap 分组逻辑行）；检测结果按逻辑行文本 LRU 缓存（300 条），正则只对新文本执行；滚动（offset 变化）时立即清空下划线层避免错位。
- `canvas-renderer.ts`：新增 link canvas 层（main 与 selection 之间），`drawLinkUnderlines` 用 setLineDash 画虚线（theme.foreground、alpha 0.55、贴字形盒底），独立于主画布的按行局部重绘。
- `types.ts` / `index.ts`：`CompatibleTerminalLike` 可选方法与新导出。

### apps/fe

- `Terminal.tsx`：React Query 取 `['files','roots']`（复用缓存），按 deviceId + enabled 过滤根路径；tmux store 取当前 pane `currentPath`，随变化注入 `setFileLinkContext`；`onFileLinkActivated` 最长前缀匹配 root → `fetchFileStat` 校验 → `navigate(fileRoute(rootId, path))`，失败 toast `terminal.fileLinkNotFound`。
- i18n：三语言新增 `terminal.fileLinkNotFound`，`bun run build:i18n` 重新生成。

## 验证

- 单测：`link-detector.test.ts` 新增 12 例（含宽字符列、跨软换行、URL 掩蔽、`~` 排除）、`file-path.test.ts` 新增 13 例，全过。
- 包内全量 `bun test packages/ghostty-terminal`：88 pass；3 fail + 1 error 与 main 基线完全一致（issue45 mock.module 泄漏的既有问题，另开 detached worktree 对比确认）。canvas 层数断言 3→4 属预期更新。
- e2e（`apps/fe/tests/terminal-file-links.spec.ts`，新增，隔离 socket `tmex-e2e`）：
  1. 有效文件路径与 URL 在 link 层有虚线墨迹（像素断言）、根外路径无墨迹、根内不存在文件点击出 toast 不跳转、有效文件 Ctrl+点击跳转 `/file/:ref` 并渲染内容——通过。
  2. `cd` 进授权根后相对路径 `./rel.txt` 经 pane cwd 解析出下划线——通过。
- 回归 e2e：`terminal-selection-canvas.spec.ts` + `terminal-viewport-render.spec.ts` 6 例全过（新增 canvas 层不影响既有选择/渲染）。
- `tsc --noEmit`（apps/fe）通过；ghostty-terminal 包 tsc 报错均为基线既有（bun:test 类型缺失等）。biome 对改动文件通过。

## 备注 / 遗留

- 有效性判定为「解析后落在授权根内」，不做逐候选存在性检查（避免对 SSH 设备批量 stat）；存在性由点击时 stat 兜底。
- e2e 清理阶段 `DELETE /api/devices/:id` 在设备挂有 file_roots 时报 `FOREIGN KEY constraint failed`（schema 声明了 cascade 但迁移 SQL 疑似未带 ON DELETE CASCADE）——**既有问题**，与本次改动无关，测试用 `.catch` 容忍；建议另开任务修复。
