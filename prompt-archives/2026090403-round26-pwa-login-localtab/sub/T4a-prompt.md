# T4a — redesign Settings → 多节点互联 → 本机 (LocalMachineCard)

Result file: /Users/konata/code/tmex-r26/prompt-archives/2026090403-round26-pwa-login-localtab/sub/T4a-result.md

## Scope (files you may edit)
- apps/fe/src/pages/settings/nodes/** EXCEPT: `nodes/relay/relay-service-metrics.tsx` (owned by T4b — a stub exists, import and mount it as-is), `nodes/management/**` and `nodes/https/**` (leave unchanged).
- i18n: your keys live under `nodes.*` and `relay.tenant.*` in `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`; another agent adds keys under `relay.metrics.*` concurrently — edit only your own sub-objects and run `bun run build:i18n` after each batch of key changes. Remove keys that are no longer referenced anywhere (grep the whole repo first).
- Do NOT edit packages/ui, packages/stores, apps/fe/src/pages/settings/relay/**, apps/fe/src/node/**, apps/gateway/**.

## Read first
1. The complete inventory of the current card: /private/tmp/claude-501/-Users-konata-code-tmex-enhanced/f162c75c-ae5d-41f6-8245-2e3de8d399e8/scratchpad/sub/EX3-report.md (sections 1–9, 15–17). It lists every sub-component, field, i18n key, API and visibility rule, plus the identified duplicates/legacy texts.
2. The design in /Users/konata/code/tmex-r26/prompt-archives/2026090403-round26-pwa-login-localtab/plan-00.md, section 「本机 tab 重构设计」.
3. Copy guidelines at /Users/konata/code/tmex-copy-guidelines.md before writing any user-facing text (zh-CN primary; en/ja translations must exist for every key).

## The problem
The card piles hub-era and relay-era fields together: two uplink tabs (接入 Hub / 接入中继) with a localStorage preference, a duplicated standalone relay wizard (rendered both in `HubSetupWizard` and `StandaloneRelaySetup`), URLs repeated in up to five places, tenant id / meta epoch / priority / epoch / authorization / node ids shown inline, `｜`-joined tooltip strings, a "通用设置" heading with a single row, hub-era texts shown to relay nodes (`localAddressHint`, `directRemoveConfirm.description`, `BecomeRelayForm` direct hints), a redundant `directSwitchHint`, and no error display when `/api/local/status` fails with a non-401 error.

## Target layout (implement exactly this; details in plan-00.md)
Header: 「本机」+ role badge + ONE status badge (e.g. 已连接中继 · 45 ms / 已连接 Hub / 未连接 / 独立运行) + an overflow menu (更改角色…, 离开…, 账号安全). Role changes keep the existing transition logic (`membership/role-transition.ts`, leave flows, setup intent) — only the entry point moves into the menu (a `Select` inline is also acceptable if it reads cleaner; keep the existing confirm dialogs).

Section 连接:
- standalone: exactly one setup wizard with four path cards (设为 Hub / 加入 Hub / 加入中继 / 本机作为中继). Delete `StandaloneRelaySetup` (and its slot in `NodesTab`/`LocalMachineCard`) and the two uplink tabs + `uplink-tab-preference.ts`. `BecomeRelayForm` must use the relay-specific direct-connection hints.
- relay mode: relay rows (host, online badge, RTT, "当前挂载" marker, kicked / last error inline as small destructive text); a single stacked notice list (kicked / readmit / metaPending / packPending / notAttached) each with its one action; actions: primary 追加中继, secondary menu 重新输入口令 / 轮换元数据密钥 / 移除 <host>, and a danger-styled 离开中继. The "要改回 Hub 先离开中继" text becomes a one-line muted hint under the actions.
- hub mode: current hub row (name, 主/备, online), hub chips when ≥2, notices (standby/notWriter/hubLoginRejected/hubOffline/hubConnecting), 更换 Hub for plain nodes.
- ▸ 连接详情 (`Collapsible`, collapsed by default): tenant id (copy button), 元数据密钥代数, 经中继可见节点数, quota as `Progress` (currentNodes/maxNodes, streams), key-log caughtUp/blockedSeq, this machine's node id (copy), hub priority/writerEpoch/authorization/lastError. Nothing in this section may appear elsewhere on the card.

Section 中继服务 (only when `isRelayRole(localRole)`): public address (copy) + 口令 已设置/未设置 badge; then `<RelayServiceMetrics publicUrl hasPassword onOpenConsole />` from `./relay/relay-service-metrics` (T4b fills it in; `onOpenConsole` should navigate to the top-level Relay settings tab — find how SettingsPage selects tabs (`?tab=relay`) and use the same mechanism); when `relay.mode === 'none'` show the 接入本机中继 CTA (existing `SelfRelayEntry` logic).

Section 网络: 直连插件 row (status badge 已安装 vX / 未安装 / 本平台不支持, `Switch`, install/remove in the row's overflow or as a text button; disabled switch gets a tooltip instead of `directSwitchHint`), restart-required notice inline with 立即重启; 允许域名访问 row (switch + hosts as muted small text; keep the confirm dialog). Remove the 通用设置 heading.

Error state: when `useLocalStatus` fails with a non-401 error, show a compact error row with retry instead of an empty card.

## Quality bar
- Use existing primitives from `@tmex/ui` (Card, Badge, Button, Collapsible, Progress, Tooltip, DropdownMenu/Select, Switch, Separator). Section headers: small uppercase muted labels or `CardTitle`-sized text consistently across the four sections; consistent 12/16px spacing; mobile-friendly (rows wrap, actions collapse into the menu).
- Keep all behaviours (role transitions, leave dialogs, relay actions/prepare-sign flows, domain access confirm, restart waiter, readmit) — this is a re-composition, not a rewrite of the logic hooks. Prefer moving JSX into small components (`local-machine-header.tsx`, `uplink-section.tsx`, `connection-details.tsx`, `network-section.tsx`, …) each under the complexity gate.
- Update the tests in `nodes/**` (local-machine-card.test.tsx 47 cases, nodes-tab 18, local-uplink-tabs 13 → delete with the component, hub-uplink-panel 15, relay-uplink-panel 13, relay-ui 13, hub-setup-wizard 22, standalone-relay-setup 3 → delete) so they assert the new structure; keep total coverage of behaviours (every conditional section has at least one test).
- i18n: remove keys you made unreferenced (`nodes.machine.uplinkTabHub/uplinkTabRelay`, `relayServiceCounts`, `directSwitchHint`, `nodes.machine.general`, `relay.tenant.strip.detail`, `nodes.hubs.detail`, …) after grepping; add new ones in all three locales; run `bun run build:i18n`; `bunx tsc --noEmit -p .` in apps/fe must be 0.

Baselines: apps/fe `bun test src/` 2179/0, tsc 0, root lint green (complexity gate: `bun scripts/complexity/gate.ts`).
