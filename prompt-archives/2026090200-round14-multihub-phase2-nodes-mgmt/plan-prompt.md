# prompt 存档

## 2026-09-02 第十四轮启动

> 继续开发, 请你分批commit并在最后push替换本机tmex, Think in English, Send English prompt.
> 任务：
> 1. 上次的遗留任务
>     1. 多 hub 第二阶段：hub 间 relay（挂在不同 hub 的节点互访）、节点/浏览器按 RTT 选最近 hub、自动选主。
>     2. hub 授权走用户签名：TMEX_HUB_PEERS 是各机 env、不随 mesh 复制，主 hub 仍需手动 allow；应改为 key log 里用户签名的 admit-hub 记录。
>     3. standby 复制 enrollment token：目前 standby 不能创建/兑换加入码，主 hub 挂掉期间无法加新节点。
>     4. fail-back 靠 60 s 探测：改为主 hub 恢复时主动通知，缩短切回时间。
>     5. TLS CA 轮换靠 10 分钟轮询广告指纹：TLS 服务无变更事件，运行中换 CA 最多延迟 10 分钟才广播。
>     6. 批量升级刷新后不续接批次编排：刷新后各行独立恢复，但「全部升级」的 hub→本机 顺序与汇总 toast 不会续接。
>     7. /api/mesh/hubs.candidates 的 lastError 未在 UI 展示：诊断信息只在 API 与日志里。
> 2. 设置-远程访问和设备与文件tab位置切换
> 3. 设置-多节点互联-节点管理
>     1. 表格新增多选(当前节点不可选), 并在上方提供全选/全不选(合并为1个按钮)
>     2. 添加右侧增加更多按钮, 点击后跳出下拉菜单, 提供升级/移除节点/卸载tmex 能力; 移除原全部升级按钮
>     3. 新增卸载能力, 允许远程干净卸载该节点tmex
>     4. 允许切换主备hub, 在主 Hub / 备Hub 标签右侧新增切换按钮, 当前节点标签改为"当前"
>     5. 所有状态都必须刷新后能够preserve, 例如下载中, 卸载中等
>
> 注:
> 1. cursor grok 4.6, high担任后端编码
> 2. opus5(high)担任前端编码
> 3. codex（gpt-5.6-luna,  xhigh)探索代码
> 4. codex（gpt-5.6-sol,  high)担任code reviewer, codex存在过度防御的问题, 你应该自行判断问题是否修复
> 5. 你担任指挥官和planner, 激进并行
> 6. 为避免压缩轮数太多影响会话质量, 请你在适当时候开新会话, 而不是无限继续用老会话
