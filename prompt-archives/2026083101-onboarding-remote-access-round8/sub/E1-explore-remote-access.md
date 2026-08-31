You are exploring a Bun + React monorepo (tmex). READ-ONLY. Write your final report (Markdown, in English, concise but with exact file paths and line numbers) to /Users/konata/code/tmex-enhanced-wt-r8/prompt-archives/2026083101-onboarding-remote-access-round8/sub/E1-result.md. Finish by writing that file.

Goal: understand the Settings → "Remote access" (远程访问 / remoteAccess) page in apps/fe so it can be restructured.

Current problem: the page presents a wizard where step 1 is "install cloudflared", step 2 is "choose mode" (quick tunnel / named tunnel / direct), then per-mode steps. "Direct connection" (direct) does NOT need cloudflared at all — it is a peer alternative to Cloudflare Tunnel. Today's UI structure makes it look like cloudflared must be installed before direct connection is possible. We want "Direct connection" to be a top-level choice, parallel to "Cloudflare Tunnel", and only the tunnel branch should contain install-cloudflared / login / etc.

Report:
1. All files involved: page component(s), wizard step components, hooks/queries, the WizardMode type (client-side extension that added "direct"), state machine that computes current step, stores. Give file:line for the step list definition and for the mode selection UI.
2. How the wizard derives "current step" and which steps are shown per mode; how the direct path gates on install status today (if it does).
3. What the API/server shape is (TunnelMode on server, `/api/remote-access/*` or similar) — confirm that the direct path is purely front-end and the server TunnelMode is untouched, so a restructure is front-end only.
4. Existing tests for this page (unit tests under apps/fe/src, e2e specs) that would need updating.
5. i18n keys used (`settings.remoteAccess.*` in packages/shared/src/i18n/locales/*.json) — list the key groups, and which keys would become obsolete or need new ones if the top-level becomes "Cloudflare Tunnel vs Direct connection".
6. A concrete recommended restructure: minimal-diff component plan (which component to split, new top-level selector, what happens to the "mode" step for quick/named). Include how "already configured tunnel" state (tunnel running/externally managed) should interact with the new top-level choice.
Do not modify files.
