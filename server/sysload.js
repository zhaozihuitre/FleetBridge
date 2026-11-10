import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DATA_DIR } from './config.js';

// System load: the whole machine's CPU and memory, and what each terminal's process tree takes (the Claude Code
// process and everything under it: MCP servers, dev servers, builds), so you can tell what to close when memory
// runs short. Cheap by design:
//   the machine     os.cpus() / os.freemem() in this process (no child process, under a millisecond): every 3 s
//                   while a page shows it, every 15 s otherwise (the warning is judged either way)
//   the trees       one Win32_Process query in a PowerShell started for it and gone after (~0.4 s, nothing left
//                   running): every 5 s while the drawer is open, 10 s with the block shown, 30 s folded, never
//                   while no page looks (once when memory runs short, to name what takes it)
// Pages say what they show (POST /api/sys/want); a page that stops saying so counts as gone after 40 s.

const GB = 1024 ** 3;
const HIST = 200; // ~10 minutes at 3 s
const MEM_WARN_BYTES = 1.5 * GB;
const MEM_WARN_PCT = 10;
const MEM_CLEAR_BYTES = 2 * GB; // back above both: the next shortage is a new one
const MEM_CLEAR_PCT = 13;
const CPU_WARN = 90;
const CPU_WARN_MS = 60_000;
const CPU_CLEAR = 80;
const TREE_EVERY = { drawer: 5_000, open: 10_000, folded: 30_000 };
const LEVELS = ['none', 'folded', 'open', 'drawer'];

const total = os.totalmem();
const hist = { cpu: [], used: [] }; // cpu: whole %, used: hundredths of a GB
let now = { cpu: 0, avail: os.freemem(), at: 0 };
let prevCpu = cpuTimes();
const wants = new Map(); // page -> { level, at }
let units = []; // { key, name, pid, owned, agentId }
let tree = null; // the last process tree: { at, units, self, others }
let treeBusy = null;
let prevProcCpu = new Map(); // pid -> [cpu time (100 ns), at]
let warn = { mem: false, cpu: false, since: 0 };
let cpuHighSince = 0;
let onWarn = () => {};
let onChange = () => {};

function cpuTimes() {
  let idle = 0;
  let all = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    all += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, all };
}

/** A page says what it shows: 'drawer' (the ranking open), 'open' (the block), 'folded', 'none' (hidden). */
export function sysWant(page, level) {
  if (!LEVELS.includes(level)) return;
  wants.set(String(page).slice(0, 40), { level, at: Date.now() });
  if (wants.size > 50) wants.delete(wants.keys().next().value);
}
function level() {
  const t = Date.now();
  let best = 0;
  for (const [k, w] of wants) {
    if (t - w.at > 40_000) wants.delete(k);
    else best = Math.max(best, LEVELS.indexOf(w.level));
  }
  return LEVELS[best];
}

/** The terminals to measure (each publish): their Claude Code process ids. */
export function sysUnits(list) {
  units = list.filter((u) => u.pid).map((u) => ({ key: u.key, name: u.name, pid: u.pid, owned: Boolean(u.owned), agentId: u.agentId || null }));
}

function sample() {
  const c = cpuTimes();
  const dAll = c.all - prevCpu.all;
  const cpu = dAll > 0 ? Math.round(100 * (1 - (c.idle - prevCpu.idle) / dAll)) : now.cpu;
  prevCpu = c;
  now = { cpu: Math.max(0, Math.min(100, cpu)), avail: os.freemem(), at: Date.now() };
  hist.cpu.push(now.cpu);
  hist.used.push(Math.round(((total - now.avail) / GB) * 100));
  if (hist.cpu.length > HIST) hist.cpu.shift(), hist.used.shift();
  judge();
}

// short of memory: under 1.5 GB or 10 % available; the CPU: over 90 % for a minute. Told once per shortage.
function judge() {
  const pct = (now.avail / total) * 100;
  const memLow = now.avail < MEM_WARN_BYTES || pct < MEM_WARN_PCT;
  const memOk = now.avail > MEM_CLEAR_BYTES && pct > MEM_CLEAR_PCT;
  if (now.cpu >= CPU_WARN) cpuHighSince ||= Date.now();
  else if (now.cpu < CPU_CLEAR) cpuHighSince = 0;
  const cpuHigh = cpuHighSince && Date.now() - cpuHighSince >= CPU_WARN_MS;
  const was = { ...warn };
  if (memLow) warn.mem = true;
  else if (memOk) warn.mem = false;
  warn.cpu = Boolean(cpuHigh) || (warn.cpu && now.cpu >= CPU_CLEAR);
  if ((warn.mem || warn.cpu) && !(was.mem || was.cpu)) warn.since = Date.now();
  if (!warn.mem && !warn.cpu) warn.since = 0;
  const started = (warn.mem && !was.mem && 'mem') || (warn.cpu && !was.cpu && 'cpu');
  if (started) {
    // name what takes it: a fresh tree first (at most 10 s), then the notice
    const told = () => onWarn({ kind: started, ...summary() });
    const fresh = tree && Date.now() - tree.at < 30_000;
    if (fresh) told();
    else Promise.race([refreshTree(), new Promise((r) => setTimeout(r, 10_000))]).then(told);
  }
}

// ---- the process trees ----
const PS = [
  "$ErrorActionPreference='SilentlyContinue'",
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,WorkingSetSize,KernelModeTime,UserModeTime,CommandLine | ForEach-Object { $c = [string]$_.CommandLine; if ($c.Length -gt 200) { $c = $c.Substring(0, 200) }; \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.WorkingSetSize)`t$([uint64]$_.KernelModeTime + [uint64]$_.UserModeTime)`t$($c -replace '[\\t\\r\\n]+', ' ')\" }",
].join('; ');

function readProcs() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((done) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], { windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err && !out) return done(null);
      const procs = new Map();
      for (const line of String(out).split(/\r?\n/)) {
        const [pid, ppid, name, ws, cpu, cmd] = line.split('\t');
        if (!pid || !/^\d+$/.test(pid)) continue;
        procs.set(+pid, { pid: +pid, ppid: +ppid, name: name || '', mem: +ws || 0, cpuT: +cpu || 0, cmd: cmd || '' });
      }
      done(procs);
    });
  });
}

// "python -m http.server", "node vite", "java (gradle)": the program and what it runs, paths cut to their last part
export function labelOf(p) {
  const name = p.name.replace(/\.exe$/i, '');
  let args = p.cmd.trim();
  // drop the program itself (quoted or not) from the front
  args = args.replace(/^"[^"]*"\s*|^\S+\s*/, '');
  args = args
    .split(/\s+/)
    .filter((a) => a && !a.startsWith('--') && !/^-(no-|inspect|X)/i.test(a))
    .slice(0, 4)
    .map((a) => a.replace(/^"|"$/g, '').replace(/^.*[\\/]([^\\/]+)$/, '$1'))
    .join(' ');
  if (/gradle/i.test(p.cmd) && /^java/i.test(name)) return 'java (gradle)';
  return (name + (args ? ' ' + args : '')).slice(0, 60);
}

// never offered, never ended: Claude Code itself, Fleet Bridge's own processes (its window, server, terminal host,
// the MCP server it gives its terminals) and Windows' own
const PROTECTED_NAME = /^(claude|conhost|openconsole|wininit|csrss|services|lsass|svchost|explorer|winlogon|system|electron|fleet ?bridge)(\.exe)?$/i;
const isProtected = (p) => PROTECTED_NAME.test(p.name) || /fleet-mcp\.cjs|ptyhost\.cjs|[\\/]server[\\/]run\.mjs/i.test(p.cmd);

function build(procs) {
  const t = Date.now();
  // CPU % of each process since the last tree (its time over the elapsed time, all cores = 100 %)
  const cores = os.cpus().length || 1;
  const cpuOf = new Map();
  for (const p of procs.values()) {
    const prev = prevProcCpu.get(p.pid);
    cpuOf.set(p.pid, prev && t > prev[1] ? Math.max(0, Math.min(100, ((p.cpuT - prev[0]) / 1e4 / (t - prev[1]) / cores) * 100)) : 0);
  }
  prevProcCpu = new Map([...procs.values()].map((p) => [p.pid, [p.cpuT, t]]));
  const kids = new Map();
  for (const p of procs.values()) if (p.ppid !== p.pid && procs.has(p.ppid)) (kids.get(p.ppid) || kids.set(p.ppid, []).get(p.ppid)).push(p.pid);
  const subtree = (root) => {
    const out = [];
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id) || !procs.has(id)) continue;
      seen.add(id);
      out.push(id);
      stack.push(...(kids.get(id) || []));
    }
    return out;
  };
  const taken = new Set();
  const round = (v) => Math.round(v * 10) / 10;
  const group = (ids, owned, root) => {
    const list = ids.map((id) => procs.get(id));
    const mem = list.reduce((s, p) => s + p.mem, 0);
    const cpu = list.reduce((s, p) => s + cpuOf.get(p.pid), 0);
    const procsOut = list
      .filter((p) => p.pid !== root)
      .sort((a, b) => b.mem - a.mem)
      .slice(0, 8)
      .map((p) => ({ pid: p.pid, name: p.name, label: labelOf(p), mem: p.mem, cpu: round(cpuOf.get(p.pid)), killable: Boolean(owned) && !isProtected(p) }));
    return { mem, cpu: round(cpu), count: list.length, procs: procsOut };
  };
  const out = [];
  for (const u of units) {
    if (!procs.has(u.pid)) continue;
    const ids = subtree(u.pid).filter((id) => !taken.has(id));
    ids.forEach((id) => taken.add(id));
    out.push({ key: u.key, name: u.name, agentId: u.agentId, owned: u.owned, pid: u.pid, ...group(ids, u.owned, u.pid) });
  }
  // Fleet Bridge itself: this server, the window (its parent) and the terminals' host, less the terminals
  const roots = [process.pid];
  const parent = procs.get(process.ppid);
  if (parent && /electron|fleet/i.test(parent.name)) roots.push(parent.pid);
  for (const p of procs.values()) if (/ptyhost\.cjs/i.test(p.cmd) && p.cmd.toLowerCase().includes((DATA_DIR + path.sep).toLowerCase())) roots.push(p.pid);
  const selfIds = [...new Set(roots.flatMap(subtree))].filter((id) => !taken.has(id));
  selfIds.forEach((id) => taken.add(id));
  const self = group(selfIds, false, -1);
  self.procs.forEach((p) => (p.killable = false));
  // everything else, by program
  const byName = new Map();
  for (const p of procs.values()) {
    if (taken.has(p.pid) || p.pid === 0) continue;
    const n = p.name.replace(/\.exe$/i, '');
    const g = byName.get(n) || { name: n, mem: 0, count: 0 };
    g.mem += p.mem;
    g.count++;
    byName.set(n, g);
  }
  const others = [...byName.values()].sort((a, b) => b.mem - a.mem);
  out.sort((a, b) => b.mem - a.mem);
  return { at: t, units: out, self, others: others.slice(0, 6), otherMem: others.slice(6).reduce((s, g) => s + g.mem, 0), procs };
}

function refreshTree() {
  if (treeBusy) return treeBusy;
  treeBusy = readProcs()
    .then((procs) => {
      if (procs) {
        tree = build(procs);
        onChange();
      }
    })
    .catch(() => {})
    .finally(() => (treeBusy = null));
  return treeBusy;
}

// the biggest process a terminal holds that could be closed (for the warning's advice)
function summary() {
  const avail = now.avail;
  let top = null;
  for (const u of tree?.units || []) for (const p of u.procs) if (!top || p.mem > top.mem) top = { unit: u.name, agentId: u.agentId, owned: u.owned, ...p };
  return { avail, total, cpu: now.cpu, top };
}

/** What the pages show: the machine now, ten minutes of it, the warning, and the trees (without the raw list). */
export function sysState() {
  const t = tree && { at: tree.at, units: tree.units, self: tree.self, others: tree.others, otherMem: tree.otherMem };
  return { total, avail: now.avail, cpu: now.cpu, at: now.at, hist, warn: { ...warn, ...(warn.mem || warn.cpu ? { top: summary().top } : {}) }, tree: t, level: level() };
}

/**
 * Ends a process under one of our terminals (the "end this process" button), after checking it again on a fresh
 * tree: still there, still under that terminal, not Claude Code itself nor Fleet Bridge. Its own children go too.
 */
export async function sysKill(pid, agentId) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 4) return { ok: false, error: 'bad pid' };
  const procs = await readProcs();
  if (!procs) return { ok: false, error: 'no process list' };
  tree = build(procs);
  const u = tree.units.find((x) => x.agentId === agentId && x.owned);
  if (!u) return { ok: false, error: 'not our terminal' };
  // under that terminal, not the terminal's own process, not protected, not Fleet Bridge
  let p = procs.get(pid);
  if (!p || pid === u.pid || isProtected(p) || pid === process.pid || pid === process.ppid) return { ok: false, error: 'not allowed' };
  let up = p.ppid;
  let under = false;
  for (let i = 0; i < 64 && up; i++) {
    if (up === u.pid) {
      under = true;
      break;
    }
    up = procs.get(up)?.ppid;
  }
  if (!under) return { ok: false, error: 'not under that terminal' };
  return new Promise((done) =>
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 }, (err) => {
      refreshTree();
      done(err ? { ok: false, error: String(err.message || err).slice(0, 200) } : { ok: true, name: p.name, label: labelOf(p) });
    }),
  );
}

/** Starts sampling: onWarnFn({ kind, avail, total, cpu, top }) when a shortage begins, onChangeFn when a tree is in. */
export function startSysload({ onWarn: w, onChange: c }) {
  onWarn = w || onWarn;
  onChange = c || onChange;
  let lastTree = 0;
  const tick = () => {
    sample();
    const lv = level();
    const every = TREE_EVERY[lv];
    if (every && Date.now() - lastTree >= every) {
      lastTree = Date.now();
      refreshTree();
    }
    setTimeout(tick, lv === 'none' ? 15_000 : 3_000).unref?.();
  };
  tick();
}
