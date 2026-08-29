# prompt 存档

## 2026-08-29 任务

> 继续开发, 请你分批commit并在最后push替换本机tmex, Think in English, Send English prompt. 在chore/merge-hub-tabs分支工作
> 任务：
> 1. 当前node/hub功能在tmex没有任何UI入口, 请你在合适位置补充这些ui, 使用户可以图形化的使用,请你和我讨论细节后再动工 /grilling 注:
> 2. grok（4.6, high)担任后端编码
> 3. opus5(high)担任前端编码
> 4. codex（gpt-5.6-luna,  xhigh)探索代码
> 5. codex（gpt-5.6-sol,  high)担任code reviewer, codex存在过度防御的问题, 你应该自行判断问题是否修复
> 6. 你担任指挥官和planner, 激进并行, 合理控制每个agent的工作量, 避免单一agent上下文过大

## 讨论中的补充

> 现在顶部按钮间距较大,考虑适当缩小间距容纳新图标

> 似乎现在会需要用到ca, 自签或者let's encrypt, 你的图形化ui是否包括了这部分功能,如有包括了哪些

> 集成自签,let's encrypt(签发,自动续期) 3种功能,都需要有图形化界面

## grilling 决策（按顺序）

| 问题 | 决定 |
|---|---|
| 覆盖范围 | 入口 + standalone 开启 hub 向导 + 直连开关；不做 leave / reset-root UI |
| 入口位置 | 设置页"节点"标签 + mesh 下侧边栏节点图标（收紧顶部间距） |
| 向导安全门槛 | 不加（与 standalone 现有信任一致） |
| 重启方式 | 写好配置后 `process.exit(0)`，由 launchd/systemd/dev-supervisor 拉起；前端轮询 `/healthz` |
| 做 hub 表单 | 一步到位：公网地址（预填当前 origin）+ 用户名 + 密码×2 |
| 直连插件 | 向导默认勾选下载；节点页可启用/停用 |
| mesh 下标签内容 | 嵌入完整节点管理（抽共享组件）+ 本机区块 + 账号安全按钮 |
| TLS 监听 | 新增独立 https 监听（`TMEX_TLS_PORT` 默认 9443），明文保留 |
| 自签信任 | 本地私有 CA 签发 + join 串带 CA 指纹；UI 提供 CA 下载 |
| ACME 验证 | HTTP-01 + DNS-01（Cloudflare） |
| TLS 适用角色 | 所有角色含 standalone |

## 2026-08-29 第二轮需求

> 任务：
> 1. 重写hub/node页所有文案, 使文案简洁专业易懂, 就像大型软件里的文案一样; 删除冗余/啰嗦文案. 例如"join串", 普通用户就很难看懂
> 2. 直连插件, 安装/删除用另外一个按钮, 而不是和开关绑定, 但是该按钮要和开关联动
> 3. 将远端服务器设为hub,另加本机,docker容器node, 总共3个node,我要进行测试

补充：grok 后续改为 cursor-agent（`cursor-grok-4.6-high`）调用；远程测试机 43.248.129.233:10022（经 `ai.jiefakj.com` 访问）；Cloudflare 测试域 `konata.tv`（凭据见用户消息，不落档）。
