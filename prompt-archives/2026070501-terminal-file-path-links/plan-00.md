# 终端文件路径识别与可点击跳转（含 URL/文件链接虚线下划线）

## 背景

- 终端是自研 `packages/ghostty-terminal`（Ghostty WASM + 三层 canvas 渲染），链接识别为自定义实现：
  - 检测：`link-detector.ts`，仅 `https?://` 正则，`detectLinksInWrappedLines` 跨软换行识别。
  - 命中：`terminal.ts` `linkAtPoint`（按需、单逻辑行），Cmd/Ctrl+左键触发 `emitLinkActivated`。
  - 前端 `apps/fe/src/components/terminal/Terminal.tsx` 订阅 `onLinkActivated` → `window.open`。
  - 目前无任何下划线装饰，仅修饰键 hover 时指针变 pointer。
- Files 子系统：`file_roots` 表绑定设备（`deviceId` + 绝对 `path` + `enabled`），前端 `GET /api/files/roots`（React Query `['files','roots']`）；文件预览路由 `/file/:ref`，`ref = base64url(rootId\npath)`，helper `fileRoute(rootId, path)`（`apps/fe/src/utils/fileUrl.ts`）。
- pane 的 pwd 已由后端采集（`pane_current_path`）并暴露为 `TmuxPane.currentPath`，前端 tmux store `snapshots[deviceId].session` 可查到。
- 渲染循环 `terminal.ts render()`：每帧拿到的 `rows` 即可见 viewport 行（带 `wrap`/`wrapContinuation`/`text`），天然支持"只扫可见区域"。

## 目标

1. 识别终端可见区域中的文件路径候选（绝对路径、`./`/`../`/含 `/` 的相对路径、带 `:line[:col]` 后缀的文件名），结合当前 pane 的 cwd 解析为绝对路径，若落在该设备已启用的授权根目录内则视为有效文件链接。
2. 有效文件链接与 URL 一样：Cmd/Ctrl+左键点击跳转——URL 开新标签，文件链接 SPA 跳转到 `/file/:ref` 预览；点击文件链接前先 stat 校验，不存在则 toast 提示。
3. URL 与有效文件链接在终端里绘制虚线下划线（始终可见，非 hover 才出现）。

## 性能要求（用户明确提出）

- 只读取终端可见区域：检测仅基于每帧 render 的 viewport rows。
- 限制读取频率：下划线重算节流（≥150ms trailing）；按逻辑行文本做检测缓存（LRU），正则只对新文本执行；滚动（viewport offset 变化）时立即清空下划线层避免错位，节流后重算。
- 点击/hover 命中检测保持现状（按需、单逻辑行），无需节流。

## 设计

### packages/ghostty-terminal（保持通用，不感知 device/root 业务概念）

1. `link-detector.ts`：
   - 新增文件路径候选正则（POSIX 风格，排除空白与 `"'`<>()[]{}` 定界符；先检测 URL 并屏蔽其区间，再在剩余文本上检测文件候选；剥离尾部句读；捕获可选 `:line[:col]` 后缀计入下划线区间但不参与路径解析）。
   - 新增 `detectMatchesInWrappedLines(models): WrappedMatch[]`，`WrappedMatch = { kind: 'url' | 'file', lineIndex, startCol, endCol, url?, rawPath? }`；原有导出保持兼容。
   - 不支持 `~/` 前缀（前端无法得知远端 home），文档注明。
2. 新增 `file-path.ts`（纯函数）：`normalizePosixPath`（`.`/`..`/多斜杠折叠）、`resolvePathCandidate(raw, cwd)`、`isWithinRoots(abs, rootPaths)`（根为 `/` 时特殊处理）。
3. `terminal.ts`：
   - `setFileLinkContext({ cwd, rootPaths } | null)`：宿主传入当前 pane 的 cwd 与该设备已启用根路径列表；变更后触发下划线重算。
   - 下划线 overlay：`render()` 后调度节流重算——把可见行按 wrap 分组成逻辑行（沿用 `lineCache` 向上/向下扩展），以逻辑行文本为 key 查检测缓存，文件候选经 `resolvePathCandidate` + `isWithinRoots` 过滤，产出 `{row, startCol, endCol}` 段传给 renderer 绘制。
   - `linkAtPoint` 扩展为返回 typed match；mousedown 分派：url → `emitLinkActivated`，file → 新增 `emitFileLinkActivated(resolvedAbsPath)`；hover 指针同样覆盖有效文件链接。
   - 新 API：`onFileLinkActivated(cb)`；`types.ts` 同步。
4. `canvas-renderer.ts`：新增 link 下划线 canvas 层（main 与 selection 之间），`drawLinkUnderlines(segments, color)` 用 `setLineDash` 画虚线（前景色半透明、贴字形盒底部，与现有 underline 定位一致）；层独立于主画布的 partial redraw。

### apps/fe

5. `Terminal.tsx`：
   - `useQuery(['files','roots'], fetchFileRoots)` 复用现有缓存；按 `deviceId` + `enabled` 过滤出根路径列表。
   - 从 tmux store 取当前 pane 的 `currentPath`；effect 中 `instance.setFileLinkContext(...)`（roots/cwd 变化时更新）。
   - `onFileLinkActivated`：最长前缀匹配确定 root → `fetchFileStat(rootId, path)` 校验存在 → `navigate(fileRoute(rootId, path))`；失败 toast（新增 i18n key）。
6. i18n：`packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` 加 key，跑 `bun run build:i18n`（生成文件不 lint）。

## 任务清单

- [ ] link-detector 扩展 + file-path 纯函数 + 单测
- [ ] terminal.ts：context/overlay 节流重算/命中分派/新事件 + types
- [ ] canvas-renderer：虚线下划线层
- [ ] Terminal.tsx 接线（roots + cwd + 跳转 + toast）
- [ ] i18n key + build:i18n
- [ ] 测试：bun test（包内单测），无头浏览器视觉验收虚线渲染
- [ ] typecheck/lint（不含生成文件）

## 验收标准

- 终端输出中的 URL 与有效文件路径显示虚线下划线；无效路径（不在授权根/无 cwd 的相对路径）不显示。
- Cmd/Ctrl+点击 URL 开新标签；点击有效文件路径跳到 `/file/:ref` 预览；文件不存在 toast。
- 高频输出/滚动时无明显性能退化（检测仅可见区、缓存+节流）。

## 风险与注意

- 误报噪音：无存在性检查（避免对 SSH 设备批量 stat），靠"授权根前缀 + 点击时 stat"兜底；裸文件名要求带扩展名或 `:line` 后缀以降噪。
- 滚动瞬间下划线消失后重现（节流所致）属预期行为。
- 生产环境与名为 `tmex` 的 tmux session 严禁触碰；验证用仓库内临时实例/独立 socket。
