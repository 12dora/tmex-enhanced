# Task 2B：通用 Host Services 与资源出口

## 背景与边界

tmex 已有可注入连接、`ApiClient`、`createAppRuntime` 和基础 `HostServices`。本 Task 只移除复用 packages 中仍硬编码的 Browser fetch、clipboard、external/reload/download-save，并建立 locale/font 正式 package exports。默认开源 FE 的 URL、交互和错误语义必须不变。

禁止实现 Tauri command、Relay route、Native auth、local companion 或商业 capability；visibility、Canvas、VisualViewport 和 DOM 测量不在本 Task 抽象。不得修改生成的 i18n/font manifest 内容，除非由既有生成脚本产生且内容确实应变化。

## 固定接口

1. `@tmex/api-client` 导出 `FetchLike`；`new ApiClient(baseUrl?, transport?)` 的注入 transport 接收拼好 baseUrl 的 URL 与原始 `RequestInit`。缺省 transport 在每次调用时读取 `globalThis.fetch`，不能在模块加载或构造时捕获。
2. 下载函数完成两段传输后返回结构化 `{ name, blob }`，自身不访问 `URL`、`document` 或下载锚点。现有 abort、progress、错误解析和 best-effort cleanup 语义保留。
3. `HostServices` 增加异步 clipboard read/write、可异步 external、reload 和 `saveFile({ name, blob })`。默认 Browser clipboard 写入保留 Clipboard API 失败后 textarea/`execCommand` fallback；默认保存仍用 object URL + `<a download>` 并保证清理。
4. `stores/tmux.ts` 的远端 clipboard write、Terminal 的 link/copy/paste、device console shortcut paste、page actions reload、files panel copy/download 均经该 runtime 的 host；不增加模块级可变 host 单例。
5. `@tmex/shared` 显式 export i18n resources/types、manifest 和 `en_US`/`zh_CN`/`ja_JP` JSON；`@tmex/theme` 显式 export font API/manifest/types、themes/tokens CSS 和字体二进制 resource 子路径。
6. `apps/fe/public/fonts` 的 15 个已跟踪字体整体迁到 `packages/theme/resources/fonts`，`scripts/fonts/build-fonts.ts` 改写 package resource 目录；开源 FE 通过相对 symlink 继续提供 `/fonts`，不得保留第二套二进制源。

## 实现范围

主要文件：

- `packages/api-client/src/{client,files,index}.ts` 及测试；
- `packages/stores/src/{runtime,tmux,index}.ts` 及测试；
- `packages/terminal-ui/src/components/Terminal.tsx`；
- `packages/panels/src/device-console/{device-console,page-actions}.tsx`、`packages/panels/src/files/files-tab.tsx` 及测试；
- `packages/{shared,theme}/package.json`、`packages/theme/resources/fonts/**`；
- `scripts/fonts/build-fonts.ts`、`apps/fe/public/fonts` 兼容 symlink；
- 本 archive 的实施结果由主 Agent最终补写。

若真实调用链需要改同一 package 内紧邻文件，可改并在结果中说明；不得扩到 vibex 或其他业务面。

## 实现 Agent 初步自查 / 主 review 目标

- transport 注入、baseUrl、init、late-bound global fetch 都有测试；
- 默认与注入 HostServices 都有测试，失败分支清理 object URL/DOM helper；
- 下载传输测试证明返回内容/文件名/progress 正确且在无 document/URL.createObjectURL 环境运行；
- tmux clipboard frame 使用注入 host，非当前 pane/不可见仍不写；
- `rg` 在目标 stores/terminal-ui/panels 源码中不再命中直接 `navigator.clipboard`、`window.open`、`window.location.reload`、`document.createElement('a')`；Browser 默认实现只允许集中在 runtime host；
- package export target 全部存在；15 个字体只有 package resource 一份，开源 FE symlink 目标有效；
- `bun run --filter @tmex/api-client test`、stores、terminal-ui、panels、shared、theme tests 通过；`bun run --filter @tmex/fe build` 通过；根 `bun test` 与 `bun run lint` 不新增失败；
- 不触碰系统 tmex/9883、默认 tmux socket或 `tmex` session，不 commit、不 push。
