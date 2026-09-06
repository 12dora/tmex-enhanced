# Round 30 — 分享地址 / 站点 URL / 分享设置布局 / AI 默认模型

## 原始 prompt（2026-09-06）

继续开发, 请你分批commit并在最后push替换本机tmex, Think in English, Send English prompt.
任务：
1. 目前节点分享功能使用的地址不正确, 例如点击共享获取的地址是tmex.konata.tv(通过tunnel)而延迟更低更优的选择应该是通过中继/hub的tmexhub-sh.jiefakj.com. 然而该地址甚至不可选
2. 设置-通用-站点访问url显示由hub更改地址决定,然而当前根本不在hub模式下, 且实际是有2个可访问url. 一个通过中继, 一个通过tunnel
3. 设置-分享-分享设置:在宽屏下使日志保留天数,日志上线,分享地址位于同一行
4. 设置-AI-默认模型不可选固定为GPT-5.5, 正确的行为应该随LLM提供商已启用模型改变

注:
1. opus5(high)子代理担任编码
2. opus5(high)子代理探索代码
3. codex（gpt-6-astra,  high)担任code reviewer, codex存在过度防御的问题, 你应该自行判断问题是否修复
4. 你担任指挥官和planner, 激进并行
5. 为避免压缩轮数太多影响会话质量, 请你在适当时候为分工的agent开新会话, 而不是无限继续用老会话
6. 针对软件内的文案, 必须简洁专业易懂, 就像大型软件内的文案一样, 禁止过度白话, 啰嗦

## 背景

- 上一轮 round29（`prompt-archives/2026090503-round29-terminal-share/`）交付了终端分享，地址按预设优先级（自建域名 > 中继 > 隧道 > 公网 IP）选取；本轮修正该优先级与候选来源在「本机中继角色/非 hub 模式」下的缺陷。
- 本机生产：1.1.34，节点通过中继 `tmexhub-sh.jiefakj.com` 接入，另有 Cloudflare Tunnel `tmex.konata.tv`。
- worktree：`/Users/konata/code/tmex-r30`，分支 `feat/round30-share-address-settings`。

## 追加 prompt（2026-09-06，第二条）

任务：
1. 节点管理-升级功能
    1. 无论升级多少节点, 都会每个节点完整下载一遍最新版然后推送过去,正常应该缓存最新版而不是每次下载(但要注意缓存生命, 避免遗留垃圾, 下次升级时如果检测到上次遗留升级包应清除)
    2. 升级弹窗由浏览器弹窗改为app内弹窗

## 追加 prompt（2026-09-06，第三条）

任务：
1. 检查设置-通知-通知触发(包括webhook, 各种bot)是否已适配多节点互联, 例如是否只会通知本机的, 还是会通知所有节点的
