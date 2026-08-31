#!/usr/bin/env bun
/**
 * hub-ops —— 通过 tmex Hub 自身的 API（等价于浏览器）对远端机器做运维操作。
 *
 * 依赖仓库源码（auth / ws-borsh 编解码），用 TMEX_SRC 指向任一 tmex 工作区根目录。
 * 口令只从环境变量 HUB_PASSWORD 读取，仅驻留内存，不落盘、不打印。
 */

const SRC = process.env.TMEX_SRC ?? '/Users/konata/code/tmex-enhanced-wt-r9';
const BASE = (process.env.HUB_BASE ?? 'https://ai.jiefakj.com:18443').replace(/\/+$/, '');

const auth = (await import(`${SRC}/packages/shared/src/auth/index.ts`)) as any;
const codec = (await import(`${SRC}/packages/shared/src/ws-borsh/codec.ts`)) as any;
const schema = (await import(`${SRC}/packages/shared/src/ws-borsh/schema.ts`)) as any;
const KIND = (await import(`${SRC}/packages/shared/src/ws-borsh/kind.ts`)) as any;
const chunking = (await import(`${SRC}/packages/shared/src/ws-borsh/chunk.ts`)) as any;

// ========== CLI 参数 ==========

interface Args {
  cmd: string;
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const cmd = argv[0] ?? '';
  const flags: Record<string, string | true> = {};
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i] as string;
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq > 0) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[token.slice(2)] = next;
      i++;
    } else {
      flags[token.slice(2)] = true;
    }
  }
  return { cmd, flags };
}

function str(args: Args, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === 'string' ? v : undefined;
}

function required(args: Args, name: string): string {
  const v = str(args, name);
  if (!v) fail(`缺少必需参数 --${name}`);
  return v as string;
}

function fail(message: string): never {
  process.stderr.write(`hub-ops: ${message}\n`);
  process.exit(1);
}

// ========== 会话 ==========

type CookieJar = Map<string, string>;

interface Session {
  mode: any;
  jar: CookieJar;
  /** 复用同一份 sk_sess + delegation 登录所有 node（浏览器同样如此）。 */
  sessSk: Uint8Array;
  delegationBytes: Uint8Array;
  delegationSig: Uint8Array;
  loggedInNodes: Set<string>;
}

function cookieHeader(jar: CookieJar): string {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

function mergeSetCookies(jar: CookieJar, res: Response): void {
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(';', 1)[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

/** node 路径前缀：self 与 hub 自身 id 都不加前缀。 */
function prefix(session: Session, node: string): string {
  return node === 'self' || node === session.mode.nodeId ? '' : `/n/${node}`;
}

async function api(
  session: Session,
  node: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('cookie', cookieHeader(session.jar));
  const res = await fetch(`${BASE}${prefix(session, node)}${path}`, { ...init, headers });
  mergeSetCookies(session.jar, res);
  return res;
}

async function apiJson(
  session: Session,
  node: string,
  path: string,
  init?: RequestInit
): Promise<any> {
  const res = await api(session, node, path, init);
  const text = await res.text();
  if (!res.ok) {
    fail(`${init?.method ?? 'GET'} ${prefix(session, node)}${path} -> ${res.status} ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`${path} 返回的不是 JSON：${text.slice(0, 200)}`);
  }
}

async function openSession(): Promise<Session> {
  const password = process.env.HUB_PASSWORD;
  if (!password) fail('未设置环境变量 HUB_PASSWORD');

  const modeRes = await fetch(`${BASE}/api/auth/mode`);
  if (!modeRes.ok) fail(`GET /api/auth/mode -> ${modeRes.status}`);
  const mode = (await modeRes.json()) as any;
  if (!mode.kdfParams) fail('/api/auth/mode 缺少 kdfParams');

  const seed = await auth.deriveSeed(password, {
    salt: auth.decodeBase64url(mode.kdfParams.salt),
    memory_kib: mode.kdfParams.memory_kib,
    iterations: mode.kdfParams.iterations,
    parallelism: mode.kdfParams.parallelism,
  });
  const rootKey = auth.rootKeyFromSeed(seed);
  const sess = auth.generateEd25519KeyPair();
  const delegation = auth.createDelegation(rootKey, {
    uid: mode.uid,
    sessPk: sess.publicKey,
    now: Date.now(),
  });

  const session: Session = {
    mode,
    jar: new Map(),
    sessSk: sess.secretKey,
    delegationBytes: delegation.bytes,
    delegationSig: delegation.sig,
    loggedInNodes: new Set(),
  };

  await loginTo(session, 'self');
  return session;
}

/** 对一个 node（含 hub 自身）做 challenge/login，cookie 落进 jar。 */
async function loginTo(session: Session, node: string): Promise<void> {
  const isSelf = node === 'self' || node === session.mode.nodeId;
  const key = isSelf ? 'self' : node;
  if (session.loggedInNodes.has(key)) return;

  const path = isSelf ? '' : `/n/${node}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (session.jar.size > 0) headers.cookie = cookieHeader(session.jar);

  const chRes = await fetch(`${BASE}${path}/api/auth/challenge`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ uid: session.mode.uid }),
  });
  const chText = await chRes.text();
  if (!chRes.ok) fail(`POST ${path}/api/auth/challenge -> ${chRes.status} ${chText.slice(0, 300)}`);
  const challenge = JSON.parse(chText) as { challenge_id: string; nonce: string; nodePk: string };

  const login = auth.buildLogin({
    challengeId: challenge.challenge_id,
    nonce: auth.decodeBase64url(challenge.nonce),
    target: isSelf ? 'self' : node,
    targetPk: auth.decodeBase64url(challenge.nodePk),
    uid: session.mode.uid,
    // 远端 node 记录的 entry 是 hub 的真实 nodeId；本机入口用哨兵 'self'。
    entry: isSelf ? 'self' : session.mode.nodeId,
  });

  const res = await fetch(`${BASE}${path}/api/auth/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      login: auth.encodeBase64url(auth.encodeLogin(login)),
      sig: auth.encodeBase64url(auth.signLogin(session.sessSk, login)),
      delegation: auth.encodeBase64url(session.delegationBytes),
      delegation_sig: auth.encodeBase64url(session.delegationSig),
    }),
  });
  const text = await res.text();
  if (!res.ok) fail(`POST ${path}/api/auth/login -> ${res.status} ${text.slice(0, 300)}`);
  mergeSetCookies(session.jar, res);

  if (!session.jar.has(`tmex_s_${key}`)) fail(`登录 ${node} 成功但没有拿到 tmex_s_${key}`);
  session.loggedInNodes.add(key);
}

/** 访问远端 node 前确保已登录该 node。 */
async function ensureNode(session: Session, node: string): Promise<void> {
  if (node === 'self' || node === session.mode.nodeId) return;
  if (!/^[0-9a-f]{32}$/.test(node)) fail(`--node 必须是 self 或 32 位十六进制 nodeId，收到 ${node}`);
  await loginTo(session, node);
}

// ========== 终端输出清洗 ==========

const ANSI_RE = new RegExp(
  [
    '\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)', // OSC
    '\\u001b\\[[0-?]*[ -/]*[@-~]', // CSI
    '\\u001b[()#][0-9A-Za-z]', // 字符集
    '\\u001b[@-Z\\\\-_]', // 其他单字符 ESC
    '[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]', // 控制字符（保留 \t \n \r）
  ].join('|'),
  'g'
);

function cleanTerminalText(raw: string): string {
  return raw.replace(ANSI_RE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// ========== WS：在 pane 里执行命令 ==========

interface RunTarget {
  /** 指定既有 pane；与 newWindow 二选一。 */
  windowId?: string;
  paneId?: string;
  /** 建一个临时 window 跑命令，跑完自动关掉（用于所有 pane 都被交互式程序占用的机器）。 */
  newWindow?: { name: string; cwd?: string };
}

interface RunResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  windowId: string;
  paneId: string;
}

function wsUrl(session: Session, node: string): string {
  const cid = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
  return `${BASE.replace(/^http/, 'ws')}${prefix(session, node)}/ws?cid=${cid}`;
}

async function runInPane(
  session: Session,
  node: string,
  deviceId: string,
  target: RunTarget,
  command: string,
  timeoutMs: number
): Promise<RunResult> {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex');
  // 标记串在输入行里被 printf 的 %s 拆开，因此 shell 回显那一行不含完整标记，
  // 只有真正执行产生的输出才含 BEGIN_/DONE_ 全串。
  // 整条命令必须在一行内发出：多行会让 shell 分两次回显，回显文本会混进采集结果。
  const cmdBody = command.replace(/\s+$/, '').replace(/;+$/, '');
  const line =
    `printf 'BEG%s_%s\\n' 'IN' '${nonce}'; ` +
    `${cmdBody}; ` +
    `__hub_rc=$?; printf 'DON%s_%s_%s\\n' 'E' '${nonce}' "$__hub_rc"\n`;
  const beginMark = `BEGIN_${nonce}`;
  const doneMark = new RegExp(`DONE_${nonce}_(\\d+)`);

  const ws = new WebSocket(wsUrl(session, node), {
    headers: { cookie: cookieHeader(session.jar), origin: BASE },
  } as any);
  ws.binaryType = 'arraybuffer';

  let seq = 0;
  const send = (kind: number, sch: any, data: unknown): void => {
    ws.send(codec.encodeEnvelope(kind, codec.encodePayload(sch, data), ++seq));
  };

  let buffer = '';
  const decoder = new TextDecoder();
  const reassembler = new chunking.ChunkReassembler();

  return await new Promise<RunResult>((resolve, reject) => {
    let settled = false;
    let acked = false;
    let inputSent = false;
    let createSent = false;
    let baseline: Set<string> | null = null;
    let createdWindowId: string | null = null;
    let windowId = target.windowId ?? '';
    let paneId = target.paneId ?? '';
    let selectTimer: ReturnType<typeof setInterval> | undefined;

    const finish = (result: RunResult | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (selectTimer) clearInterval(selectTimer);
      // 临时 window 必须先关掉再断开，否则会在对方会话里留下垃圾窗口。
      if (createdWindowId && ws.readyState === WebSocket.OPEN) {
        try {
          send(KIND.KIND_TMUX_CLOSE_WINDOW, schema.TmuxCloseWindowSchema, {
            deviceId,
            windowId: createdWindowId,
          });
        } catch {
          /* ignore */
        }
      }
      const done = (): void => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      if (createdWindowId) setTimeout(done, 600);
      else done();
    };

    const timer = setTimeout(() => {
      if (!acked) {
        finish(new Error(`选择 pane 超时：网关未回 SWITCH_ACK（pane ${paneId || '?'} 是否在快照中？）`));
        return;
      }
      const text = cleanTerminalText(buffer);
      const start = text.indexOf(beginMark);
      finish({
        output: start >= 0 ? text.slice(text.indexOf('\n', start) + 1) : text,
        exitCode: null,
        timedOut: true,
        windowId,
        paneId,
      });
    }, timeoutMs);

    // 网关对不在快照里的 pane 会静默丢弃 TMUX_SELECT（无 ACK、无错误），因此重试到 ACK 为止。
    const trySelect = (): void => {
      if (acked || settled || !windowId || !paneId) return;
      send(KIND.KIND_TMUX_SELECT, schema.TmuxSelectSchema, {
        deviceId,
        windowId,
        paneId,
        selectToken: crypto.getRandomValues(new Uint8Array(16)),
        wantHistory: true,
        // 不带尺寸：避免改动目标 pane 的实际大小。
        cols: null,
        rows: null,
      });
    };

    const onSnapshot = (payloadBytes: Uint8Array): void => {
      const snap = codec.decodePayload(schema.StateSnapshotSchema, payloadBytes) as any;
      const windows = (snap.session?.windows ?? []) as any[];

      if (!target.newWindow) {
        if (windows.some((w) => (w.panes ?? []).some((p: any) => p.id === paneId))) trySelect();
        return;
      }

      if (baseline === null) {
        baseline = new Set(windows.map((w) => w.id as string));
        if (!createSent) {
          createSent = true;
          send(KIND.KIND_TMUX_CREATE_WINDOW, schema.TmuxCreateWindowSchema, {
            deviceId,
            name: target.newWindow.name,
            cwd: target.newWindow.cwd ?? null,
          });
        }
        return;
      }

      if (createdWindowId) {
        trySelect();
        return;
      }
      const fresh = windows.find((w) => !(baseline as Set<string>).has(w.id) && (w.panes ?? []).length > 0);
      if (!fresh) return;
      createdWindowId = fresh.id as string;
      windowId = fresh.id as string;
      paneId = fresh.panes[0].id as string;
      trySelect();
      if (!selectTimer) selectTimer = setInterval(trySelect, 1500);
    };

    const dispatch = (kind: number, payloadBytes: Uint8Array): void => {
      switch (kind) {
        case KIND.KIND_HELLO_S2C:
          send(KIND.KIND_DEVICE_CONNECT, schema.DeviceConnectSchema, { deviceId });
          return;

        case KIND.KIND_DEVICE_CONNECTED:
          if (!target.newWindow) {
            trySelect();
            selectTimer = setInterval(trySelect, 1500);
          }
          return;

        case KIND.KIND_STATE_SNAPSHOT:
          onSnapshot(payloadBytes);
          return;

        case KIND.KIND_SWITCH_ACK:
          acked = true;
          if (selectTimer) clearInterval(selectTimer);
          return;

        case KIND.KIND_LIVE_RESUME:
          // 屏障解除后才发输入，保证后续 TERM_OUTPUT 都是本次命令产生的。
          if (inputSent) return;
          inputSent = true;
          send(KIND.KIND_TERM_INPUT, schema.TermInputSchema, {
            deviceId,
            paneId,
            encoding: 2,
            data: new TextEncoder().encode(line),
            isComposing: false,
          });
          return;

        case KIND.KIND_TERM_OUTPUT: {
          const payload = codec.decodePayload(schema.TermOutputSchema, payloadBytes) as any;
          if (payload.paneId !== paneId || !inputSent) return;
          buffer += decoder.decode(payload.data, { stream: true });
          const text = cleanTerminalText(buffer);
          const match = doneMark.exec(text);
          if (!match) return;
          const start = text.indexOf(beginMark);
          const out =
            start >= 0
              ? text.slice(text.indexOf('\n', start) + 1, match.index)
              : text.slice(0, match.index);
          finish({
            output: out.replace(/\n+$/, ''),
            exitCode: Number(match[1]),
            timedOut: false,
            windowId,
            paneId,
          });
          return;
        }

        case KIND.KIND_ERROR: {
          const payload = codec.decodePayload(schema.ErrorSchema, payloadBytes) as any;
          finish(new Error(`网关错误 code=${payload.code} ${payload.message}`));
          return;
        }

        case KIND.KIND_DEVICE_EVENT: {
          const payload = codec.decodePayload(schema.DeviceEventSchema, payloadBytes) as any;
          if (payload.eventType === 1 || payload.eventType === 3) {
            finish(new Error(`设备事件 type=${payload.eventType} ${payload.message ?? ''}`));
          }
          return;
        }

        default:
          return;
      }
    };

    ws.onopen = (): void => {
      send(KIND.KIND_HELLO_C2S, schema.HelloC2SSchema, {
        clientImpl: 'tmex-hub-ops',
        clientVersion: '0.1.0',
        maxFrameBytes: codec.DEFAULT_MAX_FRAME_BYTES,
        supportsCompression: false,
        supportsDiffSnapshot: false,
      });
    };

    ws.onerror = (event: any): void => {
      finish(new Error(`WS 错误: ${event?.message ?? String(event)}`));
    };

    ws.onclose = (event: any): void => {
      if (settled) return;
      const hint = event.code === 4401 ? '（会话未登录或已失效）' : '';
      finish(new Error(`WS 在命令完成前关闭: code=${event.code}${hint} reason=${event.reason || '(空)'}`));
    };

    ws.onmessage = (event: any): void => {
      let env: any;
      try {
        env = codec.decodeEnvelope(new Uint8Array(event.data as ArrayBuffer));
      } catch {
        return;
      }
      // 超过帧上限的 STATE_SNAPSHOT / TERM_HISTORY / TERM_OUTPUT 会被网关分片下发。
      if (env.kind === KIND.KIND_CHUNK) {
        try {
          const done = reassembler.addChunk(codec.decodeChunk(env.payload));
          if (done) dispatch(done.kind, done.payload);
        } catch {
          /* 丢弃损坏的分片流 */
        }
        return;
      }
      dispatch(env.kind, env.payload);
    };
  });
}

/** 从 tmux 树里定位 pane 所属的 window（TMUX_SELECT 要求 windowId 与 paneId 同时提供）。 */
async function resolveWindowId(
  session: Session,
  node: string,
  deviceId: string,
  paneId: string
): Promise<string> {
  const tree = await apiJson(session, node, `/api/tmux/tree?deviceId=${encodeURIComponent(deviceId)}`);
  for (const device of tree.devices ?? []) {
    for (const win of device.session?.windows ?? []) {
      for (const pane of win.panes ?? []) {
        if (pane.id === paneId) return win.id as string;
      }
    }
  }
  fail(`设备 ${deviceId} 上找不到 pane ${paneId}`);
}

// ========== 子命令 ==========

const NODE_COLS = [34, 14, 9, 7, 7, 11, 9, 4, 9];

async function cmdNodes(session: Session): Promise<void> {
  const mesh = await apiJson(session, 'self', '/api/mesh/nodes');
  const hub = await apiJson(session, 'self', '/api/hub/nodes').catch(() => ({ nodes: [] }));
  const hubById = new Map<string, any>((hub.nodes ?? []).map((n: any) => [n.id, n]));

  console.log(`hub: ${BASE}  nodeId=${session.mode.nodeId}  uid=${session.mode.uid}`);
  const row = (cells: unknown[]): string =>
    cells.map((v, i) => String(v).padEnd(NODE_COLS[i] as number)).join('');
  console.log(row(['ID', 'NAME', 'VERSION', 'ONLINE', 'REACH', 'TRANSPORT', 'LOGGEDIN', 'HUB', 'STATUS']));
  for (const n of mesh.nodes ?? []) {
    console.log(
      row([
        n.id,
        n.name ?? '',
        n.version ?? n.inventory?.version ?? '',
        n.online,
        n.reach ?? '-',
        n.transport ?? '-',
        n.loggedIn,
        n.isHub ? 'yes' : '-',
        hubById.get(n.id)?.status ?? '-',
      ])
    );
  }
}

async function cmdDevices(session: Session, node: string): Promise<void> {
  await ensureNode(session, node);
  const devices = await apiJson(session, node, '/api/devices');
  const tree = await apiJson(session, node, '/api/tmux/tree');
  const treeById = new Map<string, any>((tree.devices ?? []).map((d: any) => [d.deviceId, d]));

  if ((devices.devices ?? []).length === 0) console.log('(该 node 上没有设备)');
  for (const d of devices.devices ?? []) {
    console.log(
      `device ${d.id}  name=${d.name}  type=${d.type}  session=${d.session ?? '-'}  tmuxAvailable=${d.tmuxAvailable}  lastSeenAt=${d.lastSeenAt ?? '-'}`
    );
    const s = treeById.get(d.id)?.session;
    if (!s) {
      console.log('  (无 tmux 快照)');
      continue;
    }
    console.log(`  session ${s.id} "${s.name}"`);
    for (const w of s.windows ?? []) {
      console.log(`    window ${w.id} index=${w.index} name="${w.name}"${w.active ? ' *active' : ''}`);
      for (const p of w.panes ?? []) {
        console.log(
          `      pane ${p.id} index=${p.index} ${p.width}x${p.height} cmd=${p.currentCommand ?? '-'} path=${p.currentPath ?? '-'}${p.active ? ' *active' : ''}`
        );
      }
    }
  }
}

async function cmdRun(session: Session, args: Args): Promise<void> {
  const node = str(args, 'node') ?? 'self';
  await ensureNode(session, node);
  const deviceId = required(args, 'device');
  const command = required(args, 'cmd');
  const timeoutMs = Number(str(args, 'timeout') ?? 60) * 1000;

  let target: RunTarget;
  if (args.flags['new-window']) {
    target = { newWindow: { name: str(args, 'window-name') ?? 'hub-ops', cwd: str(args, 'cwd') } };
  } else {
    const paneId = required(args, 'pane');
    target = {
      paneId,
      windowId: str(args, 'window') ?? (await resolveWindowId(session, node, deviceId, paneId)),
    };
  }

  const result = await runInPane(session, node, deviceId, target, command, timeoutMs);
  process.stdout.write(result.output === '' ? '' : `${result.output}\n`);
  if (result.timedOut) {
    process.stderr.write(`hub-ops: 命令在 ${timeoutMs / 1000}s 内未完成（上面是超时前的输出）\n`);
    process.exit(124);
  }
  console.log(`--- exit code: ${result.exitCode} (window ${result.windowId} pane ${result.paneId}) ---`);
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}

async function cmdRoots(session: Session, node: string): Promise<void> {
  await ensureNode(session, node);
  const data = await apiJson(session, node, '/api/files/roots');
  if ((data.roots ?? []).length === 0) console.log('(该 node 上没有文件根)');
  for (const r of data.roots ?? []) {
    console.log(
      `root ${r.id}  path=${r.path}  name=${r.name}  device=${r.deviceName ?? r.deviceId}  enabled=${r.enabled}`
    );
  }
}

async function cmdRootAdd(session: Session, args: Args): Promise<void> {
  const node = str(args, 'node') ?? 'self';
  await ensureNode(session, node);
  const deviceId = required(args, 'device');
  const dir = required(args, 'dir');
  if (!dir.startsWith('/')) fail('--dir 必须是绝对路径');
  const data = await apiJson(session, node, '/api/files/roots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId, path: dir, enabled: true }),
  });
  console.log(`created root ${data.root.id}  path=${data.root.path}  device=${data.root.deviceId}`);
}

async function cmdUpload(session: Session, args: Args): Promise<void> {
  const node = str(args, 'node') ?? 'self';
  await ensureNode(session, node);
  const rootId = required(args, 'root');
  const localPath = required(args, 'file');
  const file = Bun.file(localPath);
  if (!(await file.exists())) fail(`本地文件不存在: ${localPath}`);
  const bytes = new Uint8Array(await file.arrayBuffer());

  const roots = await apiJson(session, node, '/api/files/roots');
  const root = (roots.roots ?? []).find((r: any) => r.id === rootId);
  if (!root) fail(`node ${node} 上没有 root ${rootId}`);

  // --path 是目标目录（相对路径按 root.path 解析），--name 缺省用本地文件名。
  const rawPath = str(args, 'path') ?? '';
  const destDir =
    rawPath === ''
      ? root.path
      : rawPath.startsWith('/')
        ? rawPath
        : `${String(root.path).replace(/\/+$/, '')}/${rawPath}`;
  const name = str(args, 'name') ?? (localPath.split('/').pop() as string);

  const init = await apiJson(session, node, '/api/files/upload/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rootId, path: destDir, name, size: bytes.byteLength }),
  });
  const uploadId = init.uploadId as string;
  const chunkSize = (init.chunkSize as number) > 0 ? (init.chunkSize as number) : 8 * 1024 * 1024;
  console.log(
    `upload init: id=${uploadId} chunkSize=${chunkSize} size=${bytes.byteLength} dest=${destDir}/${name}`
  );

  // 分片必须严格顺序：offset 必须等于服务端已收字节数，否则 409。
  for (let offset = 0; offset < bytes.byteLength; ) {
    const end = Math.min(offset + chunkSize, bytes.byteLength);
    const res = await api(session, node, `/api/files/upload/${uploadId}?offset=${offset}`, {
      method: 'PUT',
      body: bytes.slice(offset, end),
    });
    const text = await res.text();
    if (!res.ok) {
      await api(session, node, `/api/files/upload/${uploadId}`, { method: 'DELETE' });
      fail(`PUT chunk offset=${offset} -> ${res.status} ${text.slice(0, 300)}`);
    }
    offset = end;
  }

  const commit = await api(session, node, `/api/files/upload/${uploadId}/commit`, { method: 'POST' });
  if (!commit.ok) fail(`commit -> ${commit.status} ${(await commit.text()).slice(0, 300)}`);

  // commit 是 NDJSON 流：错误藏在 200 响应体里，没有 done 事件即视为失败。
  let done = false;
  let rest = '';
  const reader = (commit.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    rest += dec.decode(value, { stream: true });
    const lines = rest.split('\n');
    rest = lines.pop() ?? '';
    for (const raw of lines) {
      if (!raw.trim()) continue;
      const event = JSON.parse(raw) as any;
      if (event.type === 'progress') console.log(`  progress ${event.pct}% ${event.rate ?? ''}`);
      else if (event.type === 'done') {
        console.log(`upload done: ${event.uploaded}`);
        done = true;
      } else if (event.type === 'error') fail(`commit 失败 code=${event.code} ${event.detail ?? ''}`);
    }
  }
  if (!done) fail('commit 流结束但没有 done 事件');
}

// ========== 入口 ==========

const USAGE = `用法: HUB_PASSWORD=... bun hub-ops.ts <子命令> [参数]

  nodes
  devices    [--node <nodeId|self>]
  run        [--node <nodeId|self>] --device <id> --cmd '<单行 shell>'
             （二选一）--pane <%N> [--window <@N>]
                       --new-window [--window-name <名字>] [--cwd </abs/dir>]
             [--timeout 60]
  roots      [--node <nodeId|self>]
  root-add   [--node ...] --device <id> --dir </abs/path>
  upload     [--node ...] --root <rootId> [--path <目标目录>] [--name <文件名>] --file <本地文件>

--new-window 会建一个临时 tmux window 跑命令并在结束后自动关闭，
适用于目标机所有 pane 都被交互式程序（codex/grok/top 等）占用的情况。

环境变量: HUB_PASSWORD（必需）、HUB_BASE（默认 ${BASE}）、TMEX_SRC（默认 ${SRC}）`;

const args = parseArgs(process.argv.slice(2));
if (!args.cmd || args.cmd === 'help' || args.flags.help) {
  console.log(USAGE);
  process.exit(args.cmd ? 0 : 1);
}

const session = await openSession();
switch (args.cmd) {
  case 'nodes':
    await cmdNodes(session);
    break;
  case 'devices':
    await cmdDevices(session, str(args, 'node') ?? 'self');
    break;
  case 'run':
    await cmdRun(session, args);
    break;
  case 'roots':
    await cmdRoots(session, str(args, 'node') ?? 'self');
    break;
  case 'root-add':
    await cmdRootAdd(session, args);
    break;
  case 'upload':
    await cmdUpload(session, args);
    break;
  default:
    fail(`未知子命令 ${args.cmd}\n\n${USAGE}`);
}
process.exit(0);
