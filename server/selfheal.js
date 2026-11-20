// A version set aside by a Windows shutdown comes back by itself. An installed shell older than 0.9.64
// restarts the server while Windows shuts down. The shutdown kills that start, and the shell writes the
// newest version into current.json's `failed` list and runs the previous one. The next morning the app
// is a version behind (0.9.69's system load was gone on 0.9.68).
//
// The server that runs after such a rollback checks for this. A newer version that "failed" before this
// Windows session began, and whose folder is still whole, did not really fail: it is made current again,
// and the shell is asked to swap to it. A version that fails again after the boot is left aside (its
// entry is then newer than the boot), so a version that is really bad can't loop. The shell's own fix
// (0.9.64) needs the installer; this needs none.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// exit codes of a process Windows could not start (0xC000026B, 0xC0000142): not the version's doing
export const ENV_EXIT = [3221226091, 3221225794];
const HEAL_AFTER = 10 * 60_000;
const HEAL_AGAIN = 6 * 3_600_000;

const cmp = (a, b) => {
  const pa = String(a).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = String(b).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    return typeof x === typeof y ? (x < y ? -1 : 1) : typeof x === 'number' ? -1 : 1;
  }
  return 0;
};
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Looks at <data>/app/current.json. If a newer version was set aside before this boot, it is made current
 * again (the running one becomes its previous) and its version is returned. Otherwise returns null.
 * `bootAt` and `shellApi` can be passed for tests.
 */
export function healShutdownRollback({ dataDir, root, shellApi = Number(process.env.FLEET_SHELL_API) || 1, bootAt = Date.now() - os.uptime() * 1000, now = Date.now() }) {
  const base = path.join(dataDir, 'app');
  const file = path.join(base, 'current.json');
  const cur = readJson(file);
  if (!cur?.dir || !Array.isArray(cur.failed) || !cur.failed.length) return null;
  // only the server current.json names (an installed app's version folder), never a checkout or dev run
  if (path.resolve(cur.dir).toLowerCase() !== path.resolve(root).toLowerCase()) return null;
  const usable = (dir) => {
    if (!fs.existsSync(path.join(dir, 'server', 'run.mjs')) || !fs.existsSync(path.join(dir, 'web', 'index.html'))) return false;
    return (readJson(path.join(dir, 'package.json'))?.fleetShellApi || 1) <= shellApi;
  };
  // Also within this Windows session: a server that could not even start its process (Windows' "DLL
  // initialization failed" 0xC000026B, or 0xC0000142: the session or the desktop going away, the app killed as a
  // whole) says nothing about its version. 0.9.72 was set aside that way in the middle of a day, and the app
  // ran the installer's 0.9.69 (no quota display) until it was updated by hand. Such a version comes back
  // 10 minutes later, once per 6 hours at most (healed.json: the shell rewrites current.json without it).
  const healedFile = path.join(base, 'healed.json');
  const healed = (readJson(healedFile) || []).filter((h) => now - Date.parse(h.at) < HEAL_AGAIN);
  const notStarted = (f) => ENV_EXIT.some((c) => String(f.reason || '').includes(`(${c})`));
  const candidates = cur.failed
    .filter((f) => f?.version && /the server exited|crashed/.test(String(f.reason || '')))
    .filter((f) => Date.parse(f.at) < bootAt - 5_000 || (notStarted(f) && now - Date.parse(f.at) >= HEAL_AFTER && !healed.some((h) => h.version === f.version)))
    .filter((f) => cmp(f.version, cur.version) > 0 && usable(path.join(base, f.version)))
    .sort((a, b) => cmp(b.version, a.version));
  const back = candidates[0];
  if (!back) return null;
  try {
    fs.writeFileSync(healedFile, JSON.stringify([...healed, { version: back.version, at: new Date(now).toISOString(), reason: back.reason }], null, 2));
  } catch {
    // without the record a second heal could follow sooner; the boot rule still holds
  }
  const dir = path.join(base, back.version);
  fs.writeFileSync(
    file,
    JSON.stringify(
      { version: back.version, dir, previous: { version: cur.version, dir: cur.dir }, failed: cur.failed.filter((f) => f !== back) },
      null,
      2,
    ),
  );
  return back.version;
}
