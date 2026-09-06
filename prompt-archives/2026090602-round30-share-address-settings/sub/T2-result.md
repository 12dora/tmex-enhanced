# T2 结果（Opus 子代理）：站点访问 URL 候选列表 + 分享地址种类标签

- 新增 `apps/fe/src/pages/settings/{general-fields.tsx,site-url-candidates.tsx,origin-kind-label.ts}`（SiteUrlField 拆出独立模块以便渲染测试；候选行 = 「种类 · host」+ accessUrl + 填入/复制）；`packages/panels/src/share/share-origin-label.ts`。
- `site-settings-form.ts` linkage 携带 `siteAccessOrigins`；分享对话框与分享设置候选项带种类前缀（custom 也显示 host，避免与「自定义」哨兵项混淆）。
- i18n：`common.originKind.*`（core 包，两侧均可用）、`settings.general.url{Hint,ManagedHint,Candidates,OtherCandidates,UseCandidate}`。
- 验证：panels 1015/0、api-client 246/0、fe 2593/12（12 个失败均属其它代理：10 个升级 confirm 端口改造在途、2 个 core-coverage 由 T4 的 `llm-model-select` 键在 rest 包引起）；gate 违规 1 处属 T4 `LlmDefaultsCard`。
