// Updates a running Fleet Bridge in place from this checkout, without the installer: installs
// server/ and web/ as a new version in the app's folder (<data>/app/<version>/), makes it current and
// asks the app to swap its server (the terminals keep running in the PTY host; the windows reload).
// If the new version doesn't start, the app goes back to the previous one by itself.
//
//   node tools/update.mjs            update the dev app (~/.claude-ops-dev, port 8790)
//   node tools/update.mjs --prod     update the installed app (~/.claude-ops, port 8787)
//   node tools/update.mjs --rollback [--prod]   back to the previous version
//   --from <dir>                     install from another source tree (testing)
//   --data-dir <dir> --port <n>      another app (e.g. a test install)
// The installer's app and an npm-installed one keep their version folders apart (<data>/app,
// <data>/app-npm): the one the running server comes from is updated.
//
// A full install (the installer) is still needed when the shell changes: desktop/*, node_modules,
// Electron, or a server that needs a newer shell API (package.json fleetShellApi).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const appdir = require('../desktop/appdir.cjs');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const prod = flag('--prod');
// the source tree to install (default: this checkout)
const ROOT = path.resolve(opt('--from') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const dataDir = opt('--data-dir') || path.join(os.homedir(), prod ? '.claude-ops' : '.claude-ops-dev');
const port = Number(opt('--port')) || (prod ? 8787 : 8790);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

async function summary() {
  try {
    return await (await fetch(`${base}/api/admin/summary`)).json();
  } catch {
    return null;
  }
}

/** Waits for the app to be serving again (a different server than `beforePid`). */
async function waitSwap(beforePid, timeout = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    await sleep(1000);
    const s = await summary();
    if (s && s.pid !== beforePid && s.started) return s; // the new server has finished starting
  }
  return null;
}

const before = await summary();
if (!before) fail(`no Fleet Bridge answers on ${base} (is it running?)`);
// the version folders of the app that is running: <data>/<base>/<version>/
const inData = before.root && path.resolve(before.root).toLowerCase().startsWith(path.resolve(dataDir).toLowerCase() + path.sep);
const baseName = inData ? path.basename(path.dirname(path.resolve(before.root))) : 'app';
const apps = appdir.create(dataDir, ROOT, baseName); // shellDir only matters for the node_modules junction
const cur = inData ? apps.read() : null;
if (!cur) fail(before.variant === 'headless' ? 'the headless server is not updated in place: install the new version with npm and start it again' : `${dataDir} has no app folder: that app runs from its install (needs 0.9.13+, or FLEET_APPDIR=1 for a dev run)`);
console.log(`running: ${before.version} (pid ${before.pid}), terminals: ${before.liveIds.length}`);

if (flag('--rollback')) {
  if (!cur.previous) fail('there is no previous version to go back to');
  await fetch(`${base}/api/admin/rollback`, { method: 'POST' });
  const after = await waitSwap(before.pid);
  if (!after) fail('the app did not come back within a minute');
  console.log(`✔ rolled back to ${after.version}; terminals still running: ${after.liveIds.filter((id) => before.liveIds.includes(id)).length}/${before.liveIds.length}`);
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if ((pkg.fleetShellApi || 1) > (before.shellApi || 1)) fail(`this version needs shell API ${pkg.fleetShellApi}, the app has ${before.shellApi}: use the installer`);
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const version = `${pkg.version}-${stamp}`;
// the shell's node_modules: where the current version's junction points
const shellModules = fs.realpathSync(path.join(cur.dir, 'node_modules'));
const target = appdir.create(dataDir, path.dirname(shellModules), baseName);
const dir = target.install(ROOT, version);
if (!target.usable(dir)) fail(`installed ${dir} but it is incomplete`);
target.switchTo(version, dir);
console.log(`installed ${version} → ${dir}`);

await fetch(`${base}/api/admin/reload`, { method: 'POST' });
const after = await waitSwap(before.pid);
if (!after) fail('the app did not come back within a minute');
const kept = after.liveIds.filter((id) => before.liveIds.includes(id)).length;
if (after.version !== version) {
  const failed = (target.read()?.failed || []).slice(-1)[0];
  fail(`${version} did not start (${failed?.reason || 'unknown'}); the app went back to ${after.version}. Terminals still running: ${kept}/${before.liveIds.length}`);
}
console.log(`✔ now running ${after.version}; terminals still running: ${kept}/${before.liveIds.length}`);
