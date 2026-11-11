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
export function healShutdownRollback({ dataDir, root, shellApi = Number(process.env.FLEET_SHELL_API) || 1, bootAt = Date.now() - os.uptime() * 1000 }) {
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
  const candidates = cur.failed
    .filter((f) => f?.version && /the server exited|crashed/.test(String(f.reason || '')))
    .filter((f) => Date.parse(f.at) < bootAt - 5_000) // set aside in the Windows session before this one
    .filter((f) => cmp(f.version, cur.version) > 0 && usable(path.join(base, f.version)))
    .sort((a, b) => cmp(b.version, a.version));
  const back = candidates[0];
  if (!back) return null;
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
