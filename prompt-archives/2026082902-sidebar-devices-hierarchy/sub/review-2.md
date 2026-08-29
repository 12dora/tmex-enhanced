你是资深 reviewer。请审查 `prompt-archives/2026082902-sidebar-devices-hierarchy/sub/review-2.diff`（相对仓库根，先用 cat 读它；需要上下文可以只读仓库源码）。这是 tmex（Bun + React 19 + Drizzle/SQLite + 自研轻量路由）monorepo 里三批改动：
1. `packages/shared` 设备文件夹契约与纯树逻辑（成环检测、删除上提、排序归一）；
2. `apps/gateway` 的 device_folders / device_folder_placements 表、0024 迁移、`/api/device-folders` REST、`packages/api-client` 封装；
3. `packages/panels/src/device-management` 的设备卡片（真实种类、连接/断开开关、DeviceCardHost）与按种类分区的编辑对话框、`device-form.ts` 的 authMode 归一。
请只报告**真实的正确性缺陷、数据丢失/破坏风险、安全问题（SQL/校验绕过、成环、事务不完整）、明显的 React 错误（hook 顺序、stale closure、key）、与既有代码模式的严重不一致**。每条给：文件:行、问题、为什么、建议修法。按严重度排序，不要列风格意见与防御性 nit。最后给一段「可以合并 / 需修后合并」的结论。用简体中文。
