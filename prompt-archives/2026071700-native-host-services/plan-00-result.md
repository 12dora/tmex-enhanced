# Task 2B 实施结果：通用 Host Services 与资源出口

## 结果

本 Task 已完成：共享包不再为 fetch、clipboard、external、reload 和 download-save 硬编码浏览器宿主；默认开源 FE 行为保持兼容，并建立 i18n/font 正式 package exports。实施由 Grok 完成，主 Agent 负责固定契约、review、修正、验收和集成；Grok 正常执行，未启用 OMP fallback。

## 主要改动

- `ApiClient` 接受可注入 `FetchLike`，默认 fetch 保持 late-bound；下载返回 `{ name, blob }`。
- `HostServices` 提供文本 clipboard read/write、external、reload 和 file-save；默认浏览器实现集中在 stores runtime。
- Terminal、tmux、device console、page actions 和 files panel 的相应副作用均通过当前 runtime host。
- shared/theme 增加 locale、manifest、CSS、font API 与二进制资源显式 exports。
- 15 个字体文件唯一迁到 theme package resource；FE 以相对 symlink 兼容原 URL。

## Review 修正

- Grok 首轮自查发现 `apps/fe/src/pages/FilePage.tsx` 漏接 host save，并在同一 session 修复。
- 主 Agent 补齐下游 Vibe X runtime 的新增 host 方法透传。
- 主 Agent 将 object URL/anchor 的清理覆盖到 `appendChild` 失败分支，并增加测试。
- 主 Agent 消化异步 external/reload 的拒绝，避免宿主 Promise 失败成为未处理 rejection。
- 接口名固定为 `writeClipboardText` / `readClipboardText`，`reload` 允许同步或异步宿主实现。

## 验收

- api-client：28 passed；stores：55 passed；terminal-ui：89 passed；shared：95 passed；theme：6 passed。
- `bun run --filter @tmex/fe build`：通过。
- `files-context-menu.spec.ts`：3 passed，含流式下载保存目标用例。
- `@tmex/panels` 当前没有可发现的 test 文件，filter test 按 Bun 语义以 `No tests found` 退出；相关改动由 FE TypeScript/生产构建与目标 E2E 覆盖。
- 静态扫描：Browser 副作用只保留在 stores runtime 的默认 host；字体共 15 个且 symlink 有效。
- 全量 `bun run test`：package/gateway 测试通过；FE E2E 93 passed、3 skipped、8 failed。失败为非本 Task 的临时 tmux session、移动端交互、外部 LLM 设置与 theme-resize 波动，目标下载/clipboard 用例通过，因此未扩项修改。
- Biome 对改动文件仅命中 `device-console.tsx` 第 573 行的既有 hook dependency 告警；本次只改该文件第 1032 行附近的 clipboard 调用。
- tmex 全仓 `bun run lint` 仍有 337 个基线错误；未为本 Task 改写无关文件。

未触碰系统 tmex、9883、默认 tmux socket 或名为 `tmex` 的 session。
