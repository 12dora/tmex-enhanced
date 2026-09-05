发现 **4 项 major、5 项 minor**。其中两项标注为“后端上下文”，不在给定 frontend.diff 内，但会直接破坏分享页的 Hub 访问流程。

1. **major — 分享 WebSocket 未绑定页面的 shareId，可能使用错误权限和撤销生命周期。**  
   位置：[apps/fe/src/share/share-runtime.ts:87](/Users/konata/code/tmex-r29/apps/fe/src/share/share-runtime.ts:87)  
   初次连接和重连都使用普通 `/ws` 地址。后端优先常规登录态，因此已登录浏览器打开分享页时，连接没有 `shareScope`，会收到完整设备元数据，也不会在分享撤销时关闭。免登录节点同样绕过分享鉴权。  
   另一个触发场景是同时打开同节点的分享 A、B：登录 B 覆盖唯一的 `tmex_sh_<via>` cookie，A 重连后便绑定到 B 的权限和撤销生命周期。  
   **最小修复：** 初始及重连握手显式携带 `shareId`；direct 与 Hub 均强制验证匹配的分享凭证，不回退常规权限；不匹配返回 4401。同步修订契约 §2.4 的“无常规会话时”条件。这不是未登录提权，但违反分享页隔离和撤销要求。

2. **major — 失效 cookie 会阻断 Hub 上后续分享登录。【后端上下文】**  
   位置：[apps/gateway/src/mesh/stream-auth.ts:43](/Users/konata/code/tmex-r29/apps/gateway/src/mesh/stream-auth.ts:43)  
   Hub 对分享信息、login、logout 都转发现存分享 cookie，而流鉴权在判断公开路径之前拒绝失效 token。分享 A 撤销后，残留的 HttpOnly cookie 会让同节点分享 B 的信息查询及正确密码登录都返回 `401 share_invalid`，无法进入登录路由替换 cookie。  
   **最小修复：** HTTP 的公开分享路径遇到无效分享凭证时按匿名继续，且不注入凭证；WebSocket 继续严格拒绝。

3. **major — Hub 分享 WebSocket 握手失败丢失 4401，导致持续重连。【后端上下文】**  
   位置：[apps/gateway/src/mesh/stream-targets.ts:459](/Users/konata/code/tmex-r29/apps/gateway/src/mesh/stream-targets.ts:459)  
   握手时凭证失效只调用 `stream.reset('share_invalid')`。Hub 无法将它识别为终态关闭，转成 1011；前端只对 4401/4410 停止重连。因此在 HTTP 认证成功后、WS 建立前凭证被退出或撤销时，页面不会回到密码表单。  
   **最小修复：** 分享握手拒绝使用 `encodeTerminalStreamClose(4401, 'SHARE_LOGIN_REQUIRED')`，沿所有 peer 载体透传。

4. **major — 日志回放裁掉较大终端的下方和右侧画面。**  
   位置：[apps/fe/src/pages/settings/share/use-replay-terminal.ts:81](/Users/konata/code/tmex-r29/apps/fe/src/pages/settings/share/use-replay-terminal.ts:81)  
   初始化仅执行一次 `fit()`，播放随后按录制的行列数 `resize()`。回放容器固定为 `22rem`，Ghostty 默认视口又是 `overflow:hidden`；常见 120×40、200×60 录像会超出容器，底部命令和右侧内容无法查看。  
   **最小修复：** 打开终端后启用 `term.setViewportPan(true)`，保持录制尺寸，并验证窄屏可以平移至右下角。

5. **minor — 分享访客仍看到并能触发被禁止的结构操作。**  
   位置：[apps/fe/src/share/share-console.tsx:76](/Users/konata/code/tmex-r29/apps/fe/src/share/share-console.tsx:76)、[packages/panels/src/device-console/device-console-toolbar.tsx:126](/Users/konata/code/tmex-r29/packages/panels/src/device-console/device-console-toolbar.tsx:126)  
   `shareViewer` 目前只关闭分享入口等功能，没有关闭桌面分屏按钮、窗格关闭按钮及标题栏拖动操作。正常分享连接会被后端拒绝，但界面仍允许点击；关闭操作还会先切换本地焦点，最终窗格却没有关闭。  
   **最小修复：** 将结构操作能力传到 toolbar 和分屏组件，在分享模式隐藏入口并禁用相应回调；保留允许的尺寸仲裁。

6. **minor — 第二次打开创建弹窗不再预选默认地址。**  
   位置：[packages/panels/src/share/use-share-dialog.ts:83](/Users/konata/code/tmex-r29/packages/panels/src/share/use-share-dialog.ts:83)  
   弹窗关闭后仍挂载，重开会清空 `draft.origin`。填默认地址的 effect 仅依赖 `origins`；React Query 对相同响应保持引用，因此即使重新请求也不会再次填值，创建被“请选择地址”拦住。  
   **最小修复：** 重置草稿时从缓存的 origins 初始化地址，或让默认地址 effect 同时响应 `open`。

7. **minor — 服务端已确认分享结束，弹窗仍显示进行中。**  
   位置：[packages/panels/src/share/use-share-dialog.ts:131](/Users/konata/code/tmex-r29/packages/panels/src/share/use-share-dialog.ts:131)  
   `created.share` 永久作为活动查询的兜底。创建后保持弹窗打开，分享到期或被另一页面撤销，即使轮询返回空 `active`，仍显示旧链接、在线人数和终止按钮，无法直接新建。  
   **最小修复：** 创建成功时更新查询缓存，此后以查询结果为准；或在首次成功同步后停止使用创建结果兜底。

8. **minor — 分享操作错误在中文界面直接显示英文。**  
   位置：[packages/panels/src/share/use-share-dialog.ts:117](/Users/konata/code/tmex-r29/packages/panels/src/share/use-share-dialog.ts:117)  
   API 客户端丢弃响应 `code`，这里直接 toast 服务端错误文本。例如窗口关闭后提交创建，会显示 `Terminal window not found on this device.`。撤销及设置页存在同类路径。  
   **最小修复：** 保留错误码，统一映射到 i18n key；未知错误使用本地化通用提示。

9. **minor — 设备列表请求失败会清空历史成功快照。**  
   位置：[apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx:138](/Users/konata/code/tmex-r29/apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx:138)  
   冷启动请求最终失败时，`isPending=false`、`isPlaceholderData=false`、`data=undefined`，设备列表回落为 `[]`。这里只检查 pending，会把空列表写入历史快照；之后离线设备消失，保存的空数组还会阻止 inventory 兜底。  
   **最小修复：** 仅在查询成功且不是占位数据时保存快照；正常成功返回的空列表仍应保存。

相关 Bun 测试 **126 通过、0 失败**，未进行浏览器或真实 mesh 集成实测。中、英、日分享键均存在；链路失败码翻译及升级下载进度字段未发现确定不匹配。Abort-signal 修复本体不在此 diff；补读当前实现后，未发现 Bun 原生 `AbortSignal.any` 路径的新缺陷。

### Optional hardening

- 回放逐页复制累计日志并重建完整时间轴；较大日志可改为增量索引或限制一次载入量，减少内存和主线程压力。
- `useShareSession` 的请求没有取消或代次检查。建议在卸载、切换分享身份时废弃旧响应，并按 `nodeId/shareId` 重建运行时，防止迟到响应恢复旧页面状态。