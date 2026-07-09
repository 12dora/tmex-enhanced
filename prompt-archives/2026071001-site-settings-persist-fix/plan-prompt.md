# Prompt 存档

任务源起：对 gateway 设置面做实测契约梳理时发现 `updateSiteSettings` 的
`.set()` 漏写 4 列（详见 plan-00.md）。本任务为独立小修复。

原始诉求（意译）：site PATCH 中 `language` / `sshReconnectMaxRetries` /
`sshReconnectDelaySeconds` 看似生效（响应体与 30 秒内存缓存都返回新值，
`i18next.changeLanguage` 也被调用），但缓存过期或进程重启后回读旧值——
写路径没有把这几列真正落库。
