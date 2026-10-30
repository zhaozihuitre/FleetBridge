// Remembers which agents the command center was running, so a restart (or a crash) brings them back.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'roster.json');
let last = null;
let frozen = false; // set while quitting: agents exiting then must not empty the saved roster

export function saveRoster(agents) {
  if (frozen || process.env.MONITOR_DEMO) return;
  const seen = new Set();
  const live = agents.filter((a) => a.alive && !seen.has(a.sessionId) && seen.add(a.sessionId)); // one entry per session
  const json = JSON.stringify(live.map(({ sessionId, cwd, name }) => ({ sessionId, cwd, name })));
  if (json === last) return;
  last = json;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, json);
}

export function freezeRoster() {
  frozen = true;
}

export function loadRoster() {
  if (process.env.MONITOR_DEMO) return [];
  try {
    const r = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const seen = new Set();
    return Array.isArray(r) ? r.filter((x) => x?.sessionId && x?.cwd && !seen.has(x.sessionId) && seen.add(x.sessionId)) : [];
  } catch {
    return [];
  }
}

// pid -> parent pid is alive? One PowerShell call for all of them.
function parentsAlive(pids) {
  if (!pids.length || process.platform !== 'win32') return {};
  const list = pids.map(Number).filter(Number.isInteger).join(',');
  const script = `foreach ($p in @(${list})) { $x = Get-CimInstance Win32_Process -Filter "ProcessId=$p"; if ($x) { $pp = Get-Process -Id $x.ParentProcessId -ErrorAction SilentlyContinue; "$p=$([int][bool]$pp)" } }`;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    return Object.fromEntries(out.split(/\r?\n/).filter(Boolean).map((l) => l.trim().split('=')).map(([p, a]) => [p, a === '1']));
  } catch {
    return {};
  }
}

/**
 * Which roster entries to resume. A session still running with a live parent is someone's
 * terminal now: leave it alone. One whose parent is gone is our orphan from a hard kill: end it, then resume.
 * @returns {{resume: object[], skipped: object[], killed: number[]}}
 */
export function planRestore(roster, sessions) {
  const running = roster.map((r) => [r, sessions.find((s) => s.sessionId === r.sessionId)]);
  const alive = parentsAlive(running.filter(([, s]) => s).map(([, s]) => s.pid));
  const resume = [];
  const skipped = [];
  const killed = [];
  for (const [r, s] of running) {
    if (!s) resume.push(r);
    else if (alive[s.pid] === false) {
      try {
        process.kill(s.pid);
        killed.push(s.pid);
      } catch {
        // already gone
      }
      resume.push(r);
    } else skipped.push(r);
  }
  return { resume, skipped, killed };
}
