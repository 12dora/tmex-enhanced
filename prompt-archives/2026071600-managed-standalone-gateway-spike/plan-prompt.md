# Managed Standalone Gateway Spike Prompt

## 2026-07-16 跨仓实施输入

下游 Native App 计划要求在不改变 tmex 默认开源行为的前提下，为 companion-managed Gateway 验证独立 executable：使用固定 Bun 1.3.14 的 `bun build --compile`，当前 Mac 架构必须真实构建、启动和通过健康检查；同时提供 darwin/linux × x64/arm64 的确定性 target matrix 与 fail-closed 验证入口。

managed build 必须从构建图排除 self-update/CLI upgrade 与前端产物依赖，运行时仍需强制 `management_mode` / `update_owner`，并能以 API-only profile 启动。最终 artifact 不得包含独立 Bun、JS/TS source、`node_modules`、tmex CLI、上游 fe-dist 或 npm/CDN/self-update route 特征。

本任务只负责通用 managed standalone Gateway 机制；下游专用的 local transport、updater/watchdog、签名 release 与产品配置不进入 tmex。

安全红线：不触碰系统安装版 tmex、`127.0.0.1:9883`、默认 tmux socket或名为 `tmex` 的 session；不从工作目录隐式加载 production env；不推 main/master。tmex commit 必须保持中性开源语气。
