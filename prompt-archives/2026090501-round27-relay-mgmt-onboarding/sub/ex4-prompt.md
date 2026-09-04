You are exploring the tmex monorepo (Bun + React + TypeScript). READ-ONLY: do not modify files. Output the COMPLETE report as your final message (you cannot write files). Be precise: cite file paths with line numbers, quote the relevant i18n keys (packages/shared/src/i18n/locales/zh_CN.json is the source language; en_US/ja_JP mirror it; packages/shared/src/i18n/resources.ts and types.ts are generated, ignore them). Keep the report structured and actionable for engineers who will implement changes without having read the code.

Topic: "接入设备" side panel (apps/fe/src/components/side-panels/connect-devices/connect-devices-panel.tsx and any sub-components / models it uses, plus its tests) — specifically the "服务器或电脑" (server or computer) flow that shows onboarding steps.

Report:
1. Component tree with file:line: how device kinds are chosen, how steps are rendered (step-card primitives, copy blocks, join-code generation, links to settings pages), all i18n keys used and their zh_CN text.
2. What data/actions are available in the panel: current local roles (hub/relay/node/standalone), whether the machine is enrolled in a relay or hub, join-code / relay password generation APIs, the enrollment API for adding an SSH remote device to an existing node (find the "add remote device via SSH" flow: where the device add dialog lives and how it is opened from elsewhere).
3. Related install/CLI commands users are told to run (tmex-cli install / enroll / relay join / hub join / relay password-join): find the authoritative command syntax in packages/app/src/commands/** and existing copy in the panel and in Settings → Nodes setup wizard (apps/fe/src/pages/settings/nodes/setup/**), so the rewritten steps can reuse real commands.
4. Existing explanation copy about Hub vs Relay anywhere in the UI or docs (docs/relay/**, docs/hub/**), summarized in 5 lines: what each is, when to use which.
5. Tests for the panel and what they assert, so the rewrite can keep them green or adjust them.
