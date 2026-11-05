// Remembers which agents the command center was running, so a restart (or a crash) brings them back.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'roster.json');
let last = null;
let frozen = false; // set while quitting: agents exiting then must not empty the saved roster
// Nothing is saved until the start-up restore has run: a refresh before it (taking terminals back
// from the PTY host triggers one) would otherwise overwrite the roster with the few agents running so far.
let restored = false;
export function rosterRestored() {
  restored = true;
}

// An agent whose process exits stays in the roster for a grace period unless the user ended it:
// an update or a hard kill takes the agents down first and the app a moment later, and saving the
// roster in between used to drop them all (nothing came back after the restart). Still running
// after the grace period, the app wasn't going down: the agent really quit, and leaves the roster.
const GRACE = 15_000;

export function saveRoster(agents, now = Date.now()) {
  if (frozen || !restored || process.env.MONITOR_DEMO) return;
  const seen = new Set();
  const keep = (a) => a.alive || (!a.endedByUser && a.exitedAt && now - a.exitedAt < GRACE);
  const live = agents.filter((a) => keep(a) && !seen.has(a.sessionId) && seen.add(a.sessionId)); // one entry per session
  const json = JSON.stringify(live.map(({ sessionId, cwd, name }) => ({ sessionId, cwd, name })));
  if (json === last) return;
  last = json;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, json);
}

export function freezeRoster() {
  frozen = true;
}

// Written just before an update (by whoever runs it) from the roster as it was then: the app being
// replaced may save an emptied roster while it is taken down. Merged in once at the next start
// (if recent), then removed.
const UPDATE_FILE = path.join(DATA_DIR, 'roster.update.json');
const UPDATE_MAX_AGE = 30 * 60_000;

function readList(file) {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}

export function loadRoster() {
  if (process.env.MONITOR_DEMO) return [];
  let list = readList(FILE);
  try {
    if (Date.now() - fs.statSync(UPDATE_FILE).mtimeMs < UPDATE_MAX_AGE) list = [...list, ...readList(UPDATE_FILE)];
    fs.unlinkSync(UPDATE_FILE);
  } catch {
    // no update in progress
  }
  const seen = new Set();
  return list.filter((x) => x?.sessionId && x?.cwd && !seen.has(x.sessionId) && seen.add(x.sessionId));
}

/** Before an update: keep the current roster where the next start will find it. */
export function snapshotRosterForUpdate() {
  try {
    fs.copyFileSync(FILE, UPDATE_FILE);
    return true;
  } catch {
    return false;
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
