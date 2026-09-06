# N1 result — non-standard ports (shared helper, backend, CLI, docs)

Scope delivered: shared port-candidate module + probe, `POST /api/setup/precheck` port probing,
new `POST /api/mesh/relay/resolve` + api-client method, `GET /api/tls` builtin `publicUrl`,
CLI probing for `relay enroll` / `relay reauth` / `relay join --tenant` / `hub join`,
`tmex init` public-HTTPS-port question, and the deployment/relay/onboarding docs.
`apps/fe`, locale JSONs and `apps/gateway/src/portmap` were not touched.

## Final API shapes (as fixed in plan-02; N2 can rely on these)

### `POST /api/setup/precheck` → `SetupPrecheckResponse`
```ts
{
  reachable: boolean;
  isSelf: boolean;
  status: number | null;
  error: string | null;
  resolvedUrl: string | null;   // 探到的地址（含端口）；未探测或没探到为 null
  triedPorts: number[];         // 实际发起过探测的端口；未探测为 []
  probed: boolean;              // 只有 https 且地址没写端口时才是 true
}
```
- Probing runs only when the URL parses as `https:` **without** an explicit port
  (`http://127.0.0.1[:port]` and any explicit port keep the old single-`/healthz` behaviour, `probed:false`).
- When probing finds a port, `resolvedUrl` is the canonical address **with** the port and the
  `/healthz` confirmation (which fills `reachable` / `isSelf` / `status`) is run against it.
- When nothing answers: `reachable:false`, `status:null`, `resolvedUrl:null`, `probed:true`,
  `error = "no response on 443 or the built-in candidate ports (443, 2053, …)"`.
- The self-signed CA from `precheckCaPem` is applied to the probe requests too.

### `POST /api/mesh/relay/resolve` (node-session auth, same guard as the rest of `/api/mesh/relay/*`)
Request `{ url: string }` → 200:
```ts
{ url: string | null; port: number | null; explicit: boolean; triedPorts: number[] }
```
- `400 { code: 'INVALID_URL' }` for empty / non-string / non-https (loopback `http://` is allowed) /
  unparseable input — validated with `normalizeRelayUrl` **before** probing, and the returned `url`
  is re-normalised, so it is byte-identical to what `proof-material` / `enroll` will accept.
- Must be called **before** `POST /api/mesh/relay/enroll/proof-material` (the proof is signed over
  `hubHostFromUrl(url)`, which includes the port).
- Hairpin: on a `relay,node` machine, candidates whose **hostname** matches
  `TMEX_RELAY_PUBLIC_URL` are dialled through the loopback gateway
  (`relayProbeDialUrl`, a hostname-based widening of `resolveRelayDialUrl` — the existing
  helper compares host *including* port, which never matches a swept candidate port).
- Client: `RelayTenantApi.resolveRelayAddress(url): Promise<RelayResolveResult>`
  (`packages/api-client/src/relay/tenant-api.ts`, exported through `packages/api-client/src/index.ts`'s
  existing `export *`).

### `GET /api/tls` → `https` section
`resolveEffectiveHttps` now returns a `publicUrl` for the built-in listener:
`{ source: 'builtin', verified: true, publicUrl: 'https://<domain>[:port]' | null }`.
Domain resolution order: ACME domain (when `mode === 'acme'`) → first certificate SAN that is a real
DNS name (has a dot, not `*`, not an IP, not `*.localhost`) → hostname of the configured public URL →
`null`. Port is `listener.port ?? tlsPort`; `443` is omitted, anything else is explicit.
`reverse-proxy` / `none` branches are unchanged.

## Shared module

`packages/shared/src/net/port-candidates.ts`, re-exported from `@tmex/shared/net` (browser-safe,
no `node:*`, injectable `fetchImpl`).

```ts
SUGGESTED_HIGH_PORTS = [2053, 2083, 2087, 2096, 8443, 13443, 23443, 31443]
PROBE_DEFAULT_TIMEOUT_MS = 4000, PROBE_DEFAULT_GRACE_MS = 800, PROBE_DEFAULT_STAGGER_MS = 150
parseProbeTarget(hostOrUrl): { base, protocol, explicitPort, port }
candidateUrls(hostOrUrl, ports?): string[]
probeAddressPorts(hostOrUrl, options): Promise<PortProbeResult>
pickSuggestedPort(rng?) / pickSuggestedPortAvoiding(used, rng?)
isLoopbackHostname(hostname)
```

Probe semantics: explicit port ⇒ a single confirmation, never silently changed (an explicit `:443`
is detected from the raw authority, since `URL` drops the default port); no port ⇒ 443 first with an
800 ms grace window, then the 8 candidates staggered 150 ms, 443 still racing and still able to win;
first healthy answer wins and every loser is aborted; `redirect: 'error'`, per-attempt
`AbortSignal.timeout`; relay ⇒ `GET /api/relay/health` with `ok === true`, hub ⇒ `GET /healthz` with
`status === 'ok'`; loopback and non-https targets have exactly one candidate.

**Deviation from plan-02's signature:** `probeAddressPorts` resolves to a `PortProbeResult` object
whose `url`/`port` are `null` when nothing answers, instead of resolving to `null`. Required because
both the new endpoint and `precheck` must report `triedPorts` on failure. `candidateUrls` /
`parseProbeTarget` / the option names are as planned; an extra `resolveDialUrl?: (url) => string`
option was added for the gateway's hairpin rewrite.

**Concurrency note:** N2 twice overwrote this file (untracked at the time) with their own version.
The current file is N2's reconstruction from my `port-candidates.test.ts`; I reviewed it line by
line against the intended semantics above (443-first + grace, stagger, late-443 win, explicit port
never changed, `redirect:'error'`, per-attempt timeout, loser abort, `triedPorts` = ports actually
attempted, `resolveDialUrl`) and it matches. Their narrowed
`pickSuggestedPort(Avoiding): (typeof SUGGESTED_HIGH_PORTS)[number]` return type was kept.
One cosmetic difference from my original: single-candidate detection keys off *loopback* rather than
*non-https*; unreachable in practice because every caller validates the URL first.

## CLI

New `packages/app/src/lib/probe-address.ts` (`probeAddressForCli`, `requireProbedAddress`,
`probeNotFoundMessage`, `CLI_PROBE_TIMEOUT_MS`) and
`packages/app/src/commands/hub-join-probe.ts` (`probeHubJoinUrl`, `HUB_CA_FETCH_TIMEOUT_MS`).

- `tmex relay enroll|reauth <url>`, `tmex relay join <url> --tenant …`, `tmex hub join <url>`:
  when the address has no port, probe first. Success prints
  `已在 13443 端口探测到中继，使用 https://relay.example.com:13443` /
  `relay found on port 13443; using …` (`port.probe.foundRelay` / `foundHub`, both languages in
  `packages/app/src/i18n/index.ts`); before that, `port.probe.searching`
  (`地址未写端口，正在探测 443 及内置候选端口……`).
  Nothing answering aborts with `port.probe.notFound`
  (`443 及内置候选端口（443, 2053, …）均无响应，请放行端口或直接填写带端口的地址`); the relay
  password-join path maps it to `RelayPasswordJoinError('relay_unreachable', …)`.
- Skipped for explicit ports, loopback hosts, `http://`, and `hub join --insecure-local`.
  The `r3.` join-token path (`hub join --token r3.…` → `runRelayJoin`) is deliberately **not**
  probed: the token carries the authoritative URLs and `orderRelayEntries` requires a byte match.
- Probe requests use `tls: { rejectUnauthorized: false }` — they carry no credentials and only pick a
  port, so a self-signed relay/hub on a high port is still discoverable; the real request that
  follows performs full verification (or CA pinning).
- `fetchPinnedHubCa` now has the missing timeout (`AbortSignal.timeout(HUB_CA_FETCH_TIMEOUT_MS)`,
  15 s, matching `relay-ca.ts`).
- Dead `--url` read in `tmex relay join` deleted (the flag was never in the `relay.join` allowlist,
  so `assertKnownFlags` rejected it before it could be read).

### `tmex init`
- New question before the public-URL prompt:
  `公网 HTTPS 端口（443 为标准端口，{{suggested}} 为建议的高位端口）` /
  `Public HTTPS port (443 = standard, {{suggested}} = suggested when the ISP blocks 443)`
  (`init.prompt.publicPort`), default `443`; the suggestion comes from
  `pickSuggestedPortAvoiding([gatewayPort, peerPort, DEFAULT_TLS_PORT])`. Asked only for
  `hub,node` / `relay` / `relay,node`. Implemented as a text prompt (the CLI has no choice widget) —
  typing any port is the "custom" branch.
- The chosen port is applied with `applyPublicPort(raw, port)`: an address that already has an
  explicit port wins; otherwise the port is appended before validation. `443` is a no-op.
- Non-interactive flag `--public-port <n>` (added to the `init` allowlist in `lib/args.ts` and to
  both `cli/help.ts` usage lines); it only takes effect when `--hub-public-url` /
  `--relay-public-url` has no port of its own.
- `resolveHubPublicUrl` now validates through the new `normalizeHubPublicUrl` (https, `http` only
  for loopback, canonicalised) with the same 3-attempt retry loop as the relay path — previously it
  accepted anything, including an empty or `ftp://` string.

## Files

New: `packages/shared/src/net/port-candidates.ts` (+ `.test.ts`),
`packages/app/src/lib/probe-address.ts` (+ `.test.ts`),
`packages/app/src/commands/hub-join-probe.ts`,
`apps/gateway/src/mesh/relay-resolve-route.ts` (+ `.test.ts`),
`docs/deployment/2026090605-nonstandard-ports.md`.

Edited: `packages/shared/src/net/index.ts`; `packages/app/src/runtime/setup-service.ts`,
`runtime/tls-routes.ts`, `commands/relay.ts`, `commands/hub.ts`, `commands/init.ts`,
`commands/relay-password-join.ts`, `lib/relay-password-join.ts`, `lib/args.ts`, `cli/help.ts`,
`i18n/index.ts`; `packages/api-client/src/local/types.ts`, `src/relay/tenant-api.ts`;
`apps/gateway/src/mesh/relay-routes.ts` (one route-table line + one import);
`docs/relay/2026090304-relay-role.md` (§1 env-var pointer paragraph),
`docs/onboarding/2026083101-connect-devices-panel.md` (new 非标端口 section).
Tests updated: `setup-service.test.ts`, `setup-routes.test.ts`, `tls-routes.test.ts`,
`commands/relay.test.ts`, `commands/init.test.ts`, `commands/relay-password-join.test.ts`,
`lib/hub-password-self-admit.test.ts`, `api-client/src/local/setup-api.test.ts`,
`gateway/src/mesh/relay-routes.test.ts`.

`scripts/complexity/allowlist.json` is **unchanged**: the hub-join probing and the CA timeout
constant went into `commands/hub-join-probe.ts`, leaving `commands/hub.ts` at 1297 lines
(cap 1298, baseline 1294).

## Gates

- `bunx tsc --noEmit`: 0 errors in `packages/shared`, `packages/api-client`, `packages/app`,
  `apps/gateway` (and `apps/fe` was clean too when checked, informational).
- `bun test`: `packages/shared` 826 pass / 0 fail (baseline 799 + 27 new);
  `packages/api-client` 282 / 0; `packages/app` 969 / 0 (baseline 949; +20 new);
  `apps/gateway` 5072 pass / 10 fail — exactly the known baseline (9 "mesh phase-2 integration"
  + 1 flaky DataChannel 8 MiB), with 10 new passing tests
  (`relay-resolve-route.test.ts` 9, `relay-routes.test.ts` +1).
  Two intermediate full runs showed extra relay-integration failures; they were load flakes
  (`posix_spawn failed: EAGAIN` while several agents ran suites at once) and did not reproduce
  in isolation. `apps/gateway/src/relay/integration/relay-mesh-harness.ts` was still hardened:
  its in-process fetch/ws interception now matches the relay by **hostname** instead of host, so a
  port probe's candidate ports (`relay.example:2053`, …) can never escape to the real network.
- `bunx biome check` clean on every touched file.
- `bun scripts/complexity/gate.ts`: ok (1807 files, 15755 functions), no allowlist change.

## Notes for the commander

0. `apps/gateway/src/relay/integration/relay-mesh-harness.ts` was touched (hostname-based
   interception, see above) — it is a test harness, not product code.
1. Existing test fixtures that fake a hub/relay now need a `/healthz` or `/api/relay/health` branch
   when the address under test has no port; three fixtures were updated
   (`hub-password-self-admit.test.ts`, `relay-password-join.test.ts`, `relay.test.ts`'s
   `fakeGateway` origin match). Any new CLI test using a portless URL needs the same.
2. The web "加入已有 Hub" form has no probe of its own — it must submit the `resolvedUrl` returned by
   `precheck` (N2's side). `POST /api/setup/join` does **not** probe internally, by design:
   probing there would happen after the user already confirmed an address.
3. `POST /api/setup/relay-join` (web password join) **does** probe internally, because it goes
   through `performRelayPasswordJoin`.
4. Out of scope and still open from EX4 §8: portmap reserved ports should include `tls_port`, and
   `GET /api/system/addresses` should surface the HTTPS port for the mobile QR candidate.
5. The doc names 1.1.37 as the first version carrying this; adjust if the release number moves.

---

# N1 review round 2 — R1-ports-review findings 1, 2, 3 (backend), 6

Fixed on top of 8051bc32. `apps/fe` untouched (N2 owns findings 3/4/5 front-end halves).

## 1 — explicit `:443` erased before discovery (P2)

`canonicalHubUrl` / `normalizeRelayUrl` strip `:443`, so any path that normalised *before* asking
"did the user write a port?" turned an explicit 443 into "no port" and swept the candidate table.

- `packages/app/src/commands/relay.ts`: new `resolveRelayEnrollUrl()` validates with
  `requireRelayUrl(urlRaw)` (unchanged error text), probes the **raw** input, then normalises the
  selected URL. `enroll` and `reauth` both go through it.
- `packages/app/src/lib/relay-password-join.ts`: `resolveJoinRelayPort()` now takes the raw
  `input.relayUrl`, validates it with `parseJoinRelayUrl` first (so `invalid_url` still fires
  before any network call), probes the raw string, and normalises the result.
- `packages/app/src/commands/hub-join-probe.ts`: already received the raw CLI positional; the
  invariant is now documented so it is not "fixed" into a normalised value later.
- Shared `parseProbeTarget` was already correct — it reads the port from the pre-canonical
  authority (`readExplicitPort(withScheme)`), which is why `https://h:443` is reported as
  `explicitPort: 443` with `base: 'https://h'`.

New tests: `relay.test.ts` "an explicit :443 is confirmed as written and never swept" (asserts the
single `443/api/relay/health` call), `relay-password-join.test.ts` "显式 :443 只确认一次…",
`probe-address.test.ts` "an explicit :443 is treated as explicit and never swept",
plus the pre-existing shared test on `parseProbeTarget('https://relay.example.com:443')`.

## 2 — hairpin attributed loopback health to the wrong public port (P2)

`relayProbeDialUrl` (hostname-based rewrite) is **deleted**. `resolveRelayAddress` now:

- uses plain `resolveRelayDialUrl` for candidate dialling again, i.e. **exact authority matching** —
  only a candidate equal to the configured public URL takes the loopback shortcut, so a loopback
  answer can never be credited to another candidate port;
- short-circuits the one case the sweep cannot decide: when this machine has the `relay` role and
  the input's hostname equals `TMEX_RELAY_PUBLIC_URL`'s hostname **and carries no explicit port**,
  the address is already known — it probes exactly `TMEX_RELAY_PUBLIC_URL` (`ports: []`, so no
  candidate table) through the loopback and reports that canonical URL with `explicit: false`.

Tests (`relay-resolve-route.test.ts`, public URL `https://relay.example.com:13443`, loopback-only
fetch): portless self-address → `https://relay.example.com:13443` / `triedPorts: [13443]` and only
one request, to `127.0.0.1:19663`; explicit correct self port → same, `explicit: true`; explicit
**wrong** self port (`:2053`) → not rewritten to loopback, stays unresolved; another host → normal
sweep; `relay: false` → never short-circuits.

## 3 (backend half) — precheck can select a service that is not a relay (P2)

- `PrecheckKind = 'hub' | 'relay'` in `packages/app/src/runtime/setup-service.ts`;
  `precheckHubUrl(url, deps, kind = 'hub')` uses it for **both** the port sweep and the
  confirmation: hub ⇒ `GET /healthz` + `status === 'ok'`, relay ⇒ `GET /api/relay/health` +
  `ok === true`. `isSelf` stays `false` for relay (the relay health body has no `startedAt`), and
  the error string is now `healthz status …` / `relay health status …`.
- `POST /api/setup/precheck` reads `kind` (`readPrecheckKind`): absent/empty ⇒ `hub`, anything
  other than `hub`/`relay` ⇒ `400 invalid_body`.
- Contract: `SetupPrecheckRequest { url, kind? }` added in `packages/api-client/src/local/types.ts`
  next to the `SetupPrecheckKind` type; `SetupApi.precheck(url, kind?)` was already extended by N2.

Tests: `setup-service.test.ts` — relay kind probes+confirms on `/api/relay/health` and resolves the
13443 candidate; a Hub answering `/healthz` on a candidate port is **refused** under `kind:'relay'`.
`setup-routes.test.ts` — route passes `kind` through (both requests hit `/api/relay/health`), and an
unknown kind is 400.

## 6 — HTTPS card substituted the internal listener port (P2)

`packages/app/src/runtime/tls-routes.ts` `builtinPublicUrl` now returns the configured public URL
**verbatim** when one exists (NAT/port-forwarding means the public port often differs from
`tlsPort`); only when no external address is known does it derive
`https://<acme domain | public SAN>[:listenerPort]`.

Tests: configured `https://box.example.com:13443` with listener on 9443 → reports `:13443`;
no configured URL → `https://box.example.com:13443` derived from SAN + listener port; derived 443
drops the port; the PUT/renew cases now expect the verbatim configured URL.

## Docs

`docs/deployment/2026090605-nonstandard-ports.md`: documented the `kind` parameter and why the
predicate must match the target, the "explicit port is judged from the original input" rule, the
`relay,node` self-address short-circuit, and a new "HTTPS 卡片上的对外地址" section explaining that
the configured public URL wins over the listener port.

## Gates (round 2)

- `bunx tsc --noEmit`: 0 errors in `packages/shared`, `packages/api-client`, `packages/app`,
  `apps/gateway`.
- `bun test`: `packages/shared` 826/0, `packages/api-client` 282/0, `packages/app` 978/0
  (+9 new), `apps/gateway` 10 failures — exactly the known baseline set (9 "mesh phase-2
  integration" + 1 flaky DataChannel 8 MiB), nothing new; `relay-resolve-route.test.ts` 10/0
  on its own.
- `bunx biome check` clean over `packages/app/src`, `packages/api-client/src`,
  `apps/gateway/src/mesh`, `packages/shared/src/net` (512 files).
- `bun scripts/complexity/gate.ts`: the only violation is
  `apps/fe/.../become-relay-form.tsx BecomeRelayForm: 125 lines > 120` — N2's file, being edited
  concurrently; nothing in my scope.
- No git operations.
