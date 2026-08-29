# F10 result — React #185 (infinite update loop) when opening a remote node's pane

## Summary

Reproduced locally against a real 2-node mesh, found the root cause, fixed it in
`packages/stores/src/react.tsx` (in scope), added a regression test, and verified
before/after with Playwright against a from-source hub+node install.

The crash is **not** related to `paneId` / `%250` double-encoding or to the `@0` window id.
Those are red herrings — the same URL loads fine on a hard navigation. It only breaks on an
**in-SPA navigation from one node's route to another node's route**.

## Root cause

`NodeRuntimeBoundary` renders

```
<RuntimeProvider runtime={runtime}>
  <QueryClientProvider client={nodeQueryClient(nodeId)}>
    <GlobalDeviceProvider>{children}</GlobalDeviceProvider>
```

and `main.tsx` mounts the same `NodeShell` component for both the `/` and the `/n/:nodeId`
route branches. So when you click a remote node's pane in the sidebar and the router goes
`/` → `/n/<nodeId>/devices/.../panes/%250`, **React Router reuses the whole component tree**:
`NodeRuntimeBoundary` merely swaps the two context values (runtime and QueryClient); nothing
below it unmounts.

That is fatal for `@tanstack/react-query`. In `useBaseQuery`
(`node_modules/.bun/@tanstack+react-query@5.90.20/.../build/modern/useBaseQuery.js`):

```js
const client = useQueryClient(queryClient)
...
const [observer] = React.useState(() => new Observer(client, defaultedOptions))
...
React.useEffect(() => { observer.setOptions(defaultedOptions) }, [defaultedOptions, observer])
```

The `QueryObserver` is constructed **once**, with whatever `QueryClient` was in context at
mount time, and is never rebound when the provider's `client` prop changes — only its options
are updated. So after the node switch, the already-mounted `GlobalDeviceProvider` keeps
reading the **entry (self) node's** `['devices']` cache while everything else about it
(`useRuntime()`, `runtime.storagePrefix`, the tmux store, the `DeviceIntentStore`) has already
become the remote node's.

That mismatch turns the two `GlobalDeviceProvider` instances that exist for the remote node
(one from the route boundary, one from the sidebar's `NodeRuntimeScope`) into a ping-pong:

- the *sidebar's* provider is freshly mounted under the remote node's QueryClient, so its
  `devicesData` is correct → `useRouteDeviceSubscription` calls `connectDevice(<remote device>)`;
- the *route* provider is the reused one, so its `devicesData` is the **self node's** device
  list → `useReconcileWithDeviceList` computes `knownDeviceIds = {<self device>}`, sees
  `connectedDevices = {<remote device>}`, classifies it as stale via
  `selectStaleSubscribedDeviceIds` and calls `disconnectDevice(<remote device>)`;
- each `connectDevice`/`disconnectDevice` writes a new `connectedDevices` Set into the tmux
  store, which is an effect dependency of both hooks → both effects re-run → repeat.

React aborts after ~50 nested updates with error #185 ("Maximum update depth exceeded"), which
the router's default error boundary renders as "Unexpected Application Error!".

Instrumented evidence from the reproduction (same provider instance `vc4f`, tracked via a
`useRef` id, before and after the click; `qc` is the QueryClient identity):

```
[F10] GDP2 inst=vc4f prefix=""                    qc=cg4c devices=["19290242-…"]   # before click (self)
[F10] GDP2 inst=vc4f prefix="n:699579…:"          qc=15pf devices=["19290242-…"]   # after click: runtime swapped, data still self's
[F10] GDP2 inst=34ml prefix="n:699579…:"          qc=15pf devices=["b695a647-…"]   # sidebar provider: correct
[F10] reconcile n:699579…:… known=["19290242-…"] connected=["b695a647-…"]
[F10] disconnectDevice b695a647-…      (at reconcileDeviceSubscriptions)
[F10] connectDevice    b695a647-…      (at useRouteDeviceSubscription)
…repeats until React error #185
```

Note `inst=vc4f` keeps its `useRef` value across the node switch — proof the component was
reused, not remounted — while `qc` changed from `cg4c` to `15pf` yet `devices` stayed the self
node's.

## Fix

`packages/stores/src/react.tsx` — `RuntimeProvider` now wraps its children in a keyed
`Fragment` whose key is stable per `AppRuntime` instance (`WeakMap` + counter, exported as
`runtimeSubtreeKey`). Swapping the runtime therefore unmounts the old subtree and mounts a new
one, so every subscription built against the old runtime — react-query observers included, and
also zustand store subscriptions and terminal instances — goes away with it.

This is deliberately placed in `RuntimeProvider` rather than in the host:

- it is inside my scope (`node-runtime-boundary.tsx` belongs to F7);
- it holds for **every** host that swaps a runtime in place, including `NodeRuntimeScope` and
  any future boundary, instead of relying on each call site remembering to pass a `key`;
- in both current hosts `RuntimeProvider` is the outermost of the pair, so remounting it also
  remounts the per-node `QueryClientProvider` beneath it, which is what actually rebinds the
  observers.

Steady-state cost is zero: the key only changes when the runtime instance changes, so
same-node navigation (`/n/A/devices` → `/n/A/settings`) does not remount anything.

## Files changed

- `packages/stores/src/react.tsx` — keyed subtree + `runtimeSubtreeKey()` + rationale comment.
- `packages/stores/src/react.test.tsx` — **new**, 4 regression tests.

Nothing else was touched. `packages/stores/src/site.ts` / `site-fallback.ts` show as modified
in `git status` — those are F8's, not mine.

## Regression test

The repo has no DOM test environment (`bun test` only ever does `react-dom/server` static
rendering), so the test asserts the exact property React uses to decide reuse vs. remount:
same element type, key changes iff the runtime instance changes. It calls `RuntimeProvider`
as a plain function and inspects the returned element.

`packages/stores/src/react.test.tsx`:

1. same runtime → same key and same type (no spurious remounts);
2. different runtime instances → same type but **different key** (forces the remount);
3. a rebuilt runtime for the same `nodeId` also gets a new key;
4. `children` are passed through untouched, only wrapped in the keyed layer.

Verified it fails without the fix: with `RuntimeProvider` reverted to
`<RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>`, tests 2 and 4
fail (`2 pass / 2 fail`); with the fix, `4 pass / 0 fail`.

## How to verify (reproduction recipe)

Everything below runs off scratch dirs and ports 22101/22102 + 29101/29102; production
(port 9883, `~/Library/Application Support/tmex/`) and the tmux session named `tmex` on the
default socket were never touched.

Scratch dir: `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/aa9de10f-9bbe-4a6a-8bda-48566133bc05/scratchpad`

1. Unminified build:
   `cd apps/fe && bunx vite build --minify false --outDir <scratch>/f10-fe-after`
2. Mesh: `bun <scratch>/f10-boot.ts --state <scratch>/f10-state.json` — a copy of
   `apps/fe/tests/helpers/mesh-boot.ts` with port bases 22101/29101, tmux sockets
   `tmex-f10-hub` / `tmex-f10-node`, `FE_DIST_DIR` pointed at the scratch dist and the fe
   rebuild disabled. It does the real `hub user add` → `enroll` → `hub join` flow and writes
   the hub/node/user/password/nodeId state file.
   (`TMEX_TMUX_SOCKET` is supported — `apps/gateway/src/config.ts:169` — so both instances run
   on their own tmux sockets; each gateway auto-creates its own session there.)
3. Playwright: `bun <scratch>/f10-click.ts <tag>` — logs in, opens the remote node section
   (F7's new on-demand sign-in gate), clicks the remote node's window row in the sidebar
   (which is what navigates to `/n/<nodeId>/devices/<id>/windows/@0/panes/%250`), then reports
   `device-page` / `.xterm` presence, whether the error boundary rendered, and page errors.

Because F7/F8/F9 are editing the same worktree, I isolated my change by building the **same
tree twice**, once with the fix reverted:

| bundle | build | result |
| --- | --- | --- |
| `f10-fe-ctrl` | current tree, `RuntimeProvider` reverted | `APP ERROR IN BODY: true`, `device-page: 0`, `xterm: 0`, `React error #185 … at connectDevice … at commitHookEffectListMount` |
| `f10-fe-after` | current tree, fix applied | `APP ERROR IN BODY: false`, `device-page: 1`, `xterm: 1`, no page errors |

Screenshot `<scratch>/f10-after.png` shows the remote node's pane rendering live terminal
output (`konata@KonatadeMacBook-Pro ~ %`) with the "Via hub / Relayed" badges. `f10-ctrl.png`
shows the error boundary.

All scratch servers, the boot supervisor and both scratch tmux sockets were killed; the scratch
dirs were left in place.

## Test / tsc numbers

| package | baseline | after |
| --- | --- | --- |
| `packages/stores` | 257 pass / 0 fail, tsc 1 | **261 pass / 0 fail**, tsc 1 |
| `apps/fe` (`bun test src/`) | 470 / 0, tsc 0 | **511 pass / 0 fail**, tsc 0 |
| `packages/panels` | 368 / 0, tsc 0 | **372 pass / 0 fail**, tsc 0 |

- `packages/stores` +4 = my new file. The single tsc error is the pre-existing baseline one in
  `src/host-services.test.ts(93,23)`, untouched by me.
- `apps/fe` and `packages/panels` counts are above their baselines because F7/F8/F9 added tests
  in parallel; both are at 0 failures.
- `bunx biome check packages/stores/src/react.tsx packages/stores/src/react.test.tsx` → clean.

## Out-of-scope notes for the commander

1. **No out-of-scope change is required** — the fix is entirely inside `packages/stores`.
   If you would rather pin the remount at the host instead (F7 owns the file), the equivalent
   one-liner is below; do **not** apply both, one is enough (applying both is harmless but
   redundant):

   ```diff
   --- a/apps/fe/src/node/node-runtime-boundary.tsx
   +++ b/apps/fe/src/node/node-runtime-boundary.tsx
   @@
   -    <RuntimeProvider runtime={runtime}>
   +    <RuntimeProvider key={nodeId} runtime={runtime}>
          <QueryClientProvider client={queryClient}>
            <GlobalDeviceProvider>{children}</GlobalDeviceProvider>
          </QueryClientProvider>
        </RuntimeProvider>
   ```

   I prefer the `RuntimeProvider` version because it also covers `NodeRuntimeScope` and any
   future boundary, and because it keys on the runtime *instance* rather than on `nodeId`
   (a runtime recycled and rebuilt for the same node also gets a fresh subtree).

2. **Latent duplicate of the same hazard**: any component that calls `useQuery` and sits under
   a `QueryClientProvider` whose `client` prop can change is exposed to the same stale-cache
   bug. Today that is `GlobalDeviceProvider` (`apps/fe/src/components/global-device-provider.tsx`)
   and `useConsoleTargets` (`packages/panels/src/device-console/use-console-targets.ts`), both
   on `['devices']`. The remount fixes both. If anyone later moves a `QueryClientProvider`
   *above* `RuntimeProvider`, or introduces a second per-node client swap outside a
   `RuntimeProvider`, the guarantee is lost — worth a note in whatever design doc covers the
   per-node QueryClient isolation.

3. Observed while testing, unrelated to this task and left alone:
   - the devices page renders raw i18n keys `devices.nodes.status.online` /
     `devices.nodes.status.hub` / `devices.nodes.status.signedOut` /
     `devices.nodes.signInToManage` — F9's locale keys are not built yet (`bun run build:i18n`);
   - two harmless `401 Unauthorized` console entries appear right after login on the hub, both
     before and after the fix;
   - `vite build --mode development` currently fails to produce a React dev build here (React
     still resolves to the production build), so the "Minified React error #185" text remains
     even in an unminified bundle; the unminified app code was enough to get named frames
     (`connectDevice`, `reconcileDeviceSubscriptions`) plus injected logging.

## Open issues

None for this task. The fix is verified end-to-end on a real mesh and by unit test.
