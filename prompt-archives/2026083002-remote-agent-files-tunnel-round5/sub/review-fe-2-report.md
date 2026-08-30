# 审查结论

发现 1 个 blocker、5 个 should-fix、1 个 nit。当前不建议合入。

## 1. `[blocker]` 隧道名称可造成目录穿越及任意 `.json` 文件写入/删除

**位置：** `apps/fe/src/pages/settings/remote-access/named-step.tsx:120`

前端不校验 `tunnelName`，直接发送任意字符串。后端 `apps/gateway/src/api/tunnel-routes.ts:32` 也只检查类型；随后 `apps/gateway/src/tunnel/manager.ts:482-486` 将名称交给：

```ts
join(tunnelDir, `${tunnelName}.json`)
```

因此 `../../package` 会逃出 tunnel 目录。该路径被传给 cloudflared 的 `--credentials-file`，成功时可覆盖目标 `.json`；移除隧道时 `manager.ts:547-550` 还会删除同一路径。

**最小修复：** 必须在后端拒绝 `/`、`\`、`..`、NUL 及过长名称，并验证解析后的凭证路径仍位于 `tunnelDir` 内。前端同步校验只用于即时反馈，不能代替后端验证。补目录穿越请求测试。

## 2. `[should-fix]` 连通性检查会在真正检查前立即显示“可访问”

**位置：** `apps/fe/src/pages/settings/remote-access/tunnel-actions.ts:82-104`

`checkResultOf()` 把除 `state === 'error'` 外的结果都视为成功。但后端 `apps/gateway/src/tunnel/manager.ts:269-313` 将 `check` 放入后台 job，初始响应是 HTTP 202、`job.state === 'running'`；真正的 `/healthz` 请求随后才执行。

因此点击检查后，前端立即显示“可访问”。如果后台 job 最终失败，轮询只更新 tunnel status，不会更新 `actions.check`，错误结果会永久被先前的成功提示遮蔽。

**最小修复：** 不要从 202 响应推导结果；监听轮询到的 `status.job.kind === 'check'`，仅在 job 进入 `done`/`error` 后设置检查结果。删除“无 job 即成功”的测试，并加入 running → error 状态迁移测试。

## 3. `[should-fix]` “信任反向代理头”开关展示的是生效值，不是已保存值

**位置：** `apps/fe/src/pages/settings/remote-access/wizard.tsx:304-312`

开关由 `status.trustProxy` 控制，而契约明确该字段是“当前进程是否已按该配置运行”。后端保存 env 后只设置 `restartRequired`，不会修改 `trustProxy`；`apps/gateway/src/tunnel/manager.test.ts:267-272` 甚至明确断言保存 `true` 后返回的 `trustProxy` 仍为 `false`。

实际结果是：用户开启后开关立即弹回关闭，但重启后又会突然生效；刷新页面也无法看到待生效值，更无法可靠撤销它。

**最小修复：** 状态契约增加独立的期望值，例如 `configuredTrustProxy`，开关绑定该值；保留 `trustProxy` 表示当前进程的生效值。重启提示由两者不一致推导。

## 4. `[should-fix]` 已配置命名隧道仍可再次执行“创建并启动”

**位置：** `apps/fe/src/pages/settings/remote-access/wizard.tsx:69-89`

配置存在时只锁住方式选择器，但所有步骤的内容始终渲染。对于 `mode === 'named'`，第 3 步仍渲染 `NamedTunnelStep`，其中创建表单和提交按钮仍可用。

后端 `apps/gateway/src/tunnel/manager.ts:470-510` 没有检查当前 mode 是否为 `off`，会再创建一个 Cloudflare 隧道并覆盖本地配置；旧的远端隧道不会在这个流程中删除，容易产生孤儿隧道。

**最小修复：** 前端在已有配置时仅展示只读完成状态，不再展示创建表单；后端同时拒绝配置未移除时的 `create`，避免绕过 UI。

## 5. `[should-fix]` Trust Proxy 文案遗漏已知的可伪造请求头风险

**位置：** `packages/shared/src/i18n/locales/zh_CN.json:367-372`

新文案直接声称位于隧道之后“需要开启”，但 tmex 开启该配置后会信任直连请求的 `X-Forwarded-Proto`/`X-Forwarded-Host`。Cloudflare Tunnel 并不会自动关闭网关的局域网或明文监听端口。

同一项目现有 TLS 设置在 `zh_CN.json:1473-1474` 已明确警告：能直连明文端口的人可以伪造这些请求头。新向导省略该警告，会引导用户开启一个与现有安全说明冲突的配置。

**最小修复：** 三语文案复用 TLS 设置的限制：仅当网关不能被绕过代理直连时开启，并明确要求限制原始监听端口访问。

## 6. `[should-fix]` “移除”无确认，命名模式下实际会强制删除 Cloudflare 远端隧道

**位置：** `apps/fe/src/pages/settings/remote-access/status-card.tsx:139-149`

按钮点击后立即发送 `remove`。后端不仅删除本地配置和凭证，还调用 `cloudflared tunnel delete -f`（`apps/gateway/src/tunnel/provider.ts:177-184`），这是远端、不可轻易恢复的删除操作；“移除”文案没有说明这一点。

**最小修复：** 命名模式增加确认对话框，明确说明会停止服务、删除本地凭证并删除 Cloudflare 隧道。临时隧道可以继续使用轻量流程。

## 7. `[nit]` 创建隧道时会短暂显示原始机器标识 `create`

**位置：** `apps/fe/src/pages/settings/remote-access/tunnel-model.ts:62`

前端只把 `create_tunnel` 列为已知步骤，但后端实际发出的是 `create`（`apps/gateway/src/tunnel/manager.ts:485`）。虽然 locale 已存在 `jobStep.create`，`JobProgress` 仍会把未知步骤原样显示成 `create`。

**最小修复：** 让 `JOB_STEPS` 与后端实际步骤一致，至少加入 `create`；最好为所有后端实际步骤建立共享联合类型或契约测试。

## Verdict

新 i18n 键在中、英、日三份 locale 中保持同构；文件根可见性和 node 级 QueryClient 隔离未发现明显契约错误。但远程访问流程存在一个可逃逸数据目录的文件路径漏洞，以及多个错误状态展示和危险操作问题，需修复后再合入。

最重要的 3 项：

1. 服务端限制 `tunnelName`，阻断凭证路径目录穿越。

2. 等待 check job 完成后再显示连通性结果。

3. 将 Trust Proxy 的“已保存值”和“当前生效值”拆开，并补回直连伪造风险提示。