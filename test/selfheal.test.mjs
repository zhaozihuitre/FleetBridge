// A version set aside without its own fault comes back (server/selfheal.js), as on 11-19: 0.9.72's server
// "exited (3221226091)" twice mid-day, the shell ran the installer's 0.9.69 and the quota display was gone.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { ENV_EXIT, healShutdownRollback } from '../server/selfheal.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-heal-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const MIN = 60_000;
const BOOT = Date.parse('2026-11-19T03:16:39Z');
const FAILED_AT = Date.parse('2026-11-19T04:14:15.799Z');

function setup(name, failed) {
  const dataDir = path.join(tmp, name);
  const base = path.join(dataDir, 'app');
  for (const v of ['0.9.69-shell', '0.9.72-20261116044026']) {
    fs.mkdirSync(path.join(base, v, 'server'), { recursive: true });
    fs.mkdirSync(path.join(base, v, 'web'), { recursive: true });
    fs.writeFileSync(path.join(base, v, 'server', 'run.mjs'), '');
    fs.writeFileSync(path.join(base, v, 'web', 'index.html'), '');
    fs.writeFileSync(path.join(base, v, 'package.json'), '{"fleetShellApi":1}');
  }
  const root = path.join(base, '0.9.69-shell');
  fs.writeFileSync(path.join(base, 'current.json'), JSON.stringify({ version: '0.9.69-shell', dir: root, previous: null, failed }));
  return { dataDir, root, base };
}
const env = (at = FAILED_AT) => ({ version: '0.9.72-20261116044026', reason: 'the server exited (3221226091)', at: new Date(at).toISOString() });

test('a start Windows failed comes back after 10 minutes, within the same boot, once', () => {
  const { dataDir, root, base } = setup('env', [env()]);
  const o = { dataDir, root, shellApi: 1, bootAt: BOOT };
  assert.equal(healShutdownRollback({ ...o, now: FAILED_AT + 5 * MIN }), null, 'not before 10 minutes');
  assert.equal(healShutdownRollback({ ...o, now: FAILED_AT + 11 * MIN }), '0.9.72-20261116044026');
  const cur = JSON.parse(fs.readFileSync(path.join(base, 'current.json'), 'utf8'));
  assert.equal(cur.version, '0.9.72-20261116044026');
  assert.equal(cur.previous.version, '0.9.69-shell');
  assert.deepEqual(cur.failed, []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(base, 'healed.json'), 'utf8'))[0].version, '0.9.72-20261116044026');
  // it fails the same way again: the shell sets it aside again; not brought back a second time within 6 hours
  fs.writeFileSync(path.join(base, 'current.json'), JSON.stringify({ version: '0.9.69-shell', dir: root, previous: null, failed: [env(FAILED_AT + 20 * MIN)] }));
  assert.equal(healShutdownRollback({ ...o, now: FAILED_AT + 40 * MIN }), null, 'no loop');
  assert.equal(healShutdownRollback({ ...o, now: FAILED_AT + 7 * 60 * MIN }), '0.9.72-20261116044026', 'after 6 hours once more');
});

test('a real failure within this boot stays aside; one before the boot comes back (as before)', () => {
  const real = setup('real', [{ version: '0.9.72-20261116044026', reason: 'the server exited (1)', at: new Date(FAILED_AT).toISOString() }]);
  assert.equal(healShutdownRollback({ dataDir: real.dataDir, root: real.root, shellApi: 1, bootAt: BOOT, now: FAILED_AT + 60 * MIN }), null);
  const crash = setup('crash', [{ version: '0.9.72-20261116044026', reason: 'crashed 3 times (1)', at: new Date(FAILED_AT).toISOString() }]);
  assert.equal(healShutdownRollback({ dataDir: crash.dataDir, root: crash.root, shellApi: 1, bootAt: BOOT, now: FAILED_AT + 60 * MIN }), null);
  const before = setup('before', [{ version: '0.9.72-20261116044026', reason: 'the server exited (1)', at: new Date(BOOT - 60 * MIN).toISOString() }]);
  assert.equal(healShutdownRollback({ dataDir: before.dataDir, root: before.root, shellApi: 1, bootAt: BOOT, now: BOOT + MIN }), '0.9.72-20261116044026');
});

test('never a version whose folder is gone, or that needs a newer shell, or an older one', () => {
  const gone = setup('gone', [env()]);
  fs.rmSync(path.join(gone.base, '0.9.72-20261116044026', 'web'), { recursive: true });
  assert.equal(healShutdownRollback({ dataDir: gone.dataDir, root: gone.root, shellApi: 1, bootAt: BOOT, now: FAILED_AT + 20 * MIN }), null);
  const shell = setup('shell', [env()]);
  fs.writeFileSync(path.join(shell.base, '0.9.72-20261116044026', 'package.json'), '{"fleetShellApi":2}');
  assert.equal(healShutdownRollback({ dataDir: shell.dataDir, root: shell.root, shellApi: 1, bootAt: BOOT, now: FAILED_AT + 20 * MIN }), null);
  assert.deepEqual(ENV_EXIT, [3221226091, 3221225794]);
});
