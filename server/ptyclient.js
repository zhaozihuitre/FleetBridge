// The server's side of the PTY host (server/ptyhost.cjs): connects to it (starting it when there is
// none), spawns terminals there and relays their input, output and exits. The host outlives the
// server, so after a restart the server reconnects and takes its terminals back (list()).
import { spawn as spawnProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';

const require = createRequire(import.meta.url);
const { pipeName, PROTOCOL } = require('./ptypipe.cjs');
const HOST_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ptyhost.cjs');
const PIPE = pipeName(DATA_DIR);

let sock = null;
let ready = null; // promise of a connected socket
let rid = 0;
const waiting = new Map(); // rid -> resolve
const dataFns = new Map(); // id -> fn(data)
const exitFns = new Map(); // id -> fn(code)
let lostFn = () => {};
export let hostInfo = null; // { protocol, pid } of the connected host

function connectOnce() {
  return new Promise((resolve, reject) => {
    const s = net.connect(PIPE);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

function startHost() {
  // Electron's binary runs it as node (ELECTRON_RUN_AS_NODE); under plain node, node itself
  const child = spawnProcess(process.execPath, [HOST_SCRIPT], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MONITOR_DATA_DIR: DATA_DIR },
  });
  child.unref();
}

function wire(s) {
  s.setEncoding('utf8');
  let buf = '';
  s.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.t === 'data') dataFns.get(m.id)?.(m.d);
      else if (m.t === 'exit') exitFns.get(m.id)?.(m.code);
      else if (m.rid && waiting.has(m.rid)) {
        waiting.get(m.rid)(m);
        waiting.delete(m.rid);
      }
    }
  });
  s.on('close', () => {
    if (sock !== s) return;
    sock = null;
    ready = null;
    lostFn(); // the host is gone, and its terminals with it
  });
  s.on('error', () => {});
}

/** Connects to the host, starting it if needed. */
export function ensureHost() {
  if (ready) return ready;
  ready = (async () => {
    let s = null;
    try {
      s = await connectOnce();
    } catch {
      startHost();
      for (let i = 0; i < 50 && !s; i++) {
        await new Promise((r) => setTimeout(r, 100));
        s = await connectOnce().catch(() => null);
      }
    }
    if (!s) {
      ready = null;
      throw new Error('PTY host did not start');
    }
    sock = s;
    wire(s);
    hostInfo = await request({ t: 'hello' });
    if (hostInfo.protocol !== PROTOCOL) throw new Error(`PTY host protocol ${hostInfo.protocol}, expected ${PROTOCOL}: quit the app to restart it`);
    return s;
  })();
  ready.catch(() => {});
  return ready;
}

function post(msg) {
  if (sock && !sock.destroyed) sock.write(JSON.stringify(msg) + '\n');
}

function request(msg, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const id = ++rid;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`PTY host did not answer ${msg.t}`));
    }, timeout);
    waiting.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    post({ ...msg, rid: id });
  });
}

/** Terminals the host has (after a server restart: ours to take back). */
export async function list() {
  await ensureHost();
  return (await request({ t: 'list' })).terms;
}

/**
 * A terminal in the host. Returns at once with a handle (writes queue behind the spawn in the pipe);
 * the pid comes with `started`, a spawn failure with `failed`.
 */
export function spawn(id, file, args, { cwd, env, cols = 120, rows = 32, meta = {} }) {
  const started = ensureHost().then(() => request({ t: 'spawn', id, file, args, cwd, env, cols, rows, meta }));
  return {
    started: started.then((m) => {
      if (m.t === 'error') throw new Error(m.error);
      return m.pid;
    }),
    ...handle(id),
  };
}

/** Input, resize and kill for a terminal in the host (also for one taken back after a restart). */
export function handle(id) {
  return {
    write: (d) => post({ t: 'write', id, d }),
    resize: (cols, rows) => post({ t: 'resize', id, cols, rows }),
    kill: () => post({ t: 'kill', id }),
    onData: (fn) => dataFns.set(id, fn),
    onExit: (fn) =>
      exitFns.set(id, (code) => {
        dataFns.delete(id);
        exitFns.delete(id);
        fn({ exitCode: code });
      }),
  };
}

export const setMeta = (id, meta) => post({ t: 'meta', id, meta });
export const forget = (id) => post({ t: 'forget', id });

/** The app quits: every terminal ends, and the host with them. */
export async function killAll() {
  if (!sock) return;
  await request({ t: 'killall', exit: true }, 3000).catch(() => {});
}

export function onHostLost(fn) {
  lostFn = fn;
}
