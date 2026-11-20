import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { staleShortcuts, cleanShortcuts, CURRENT } from '../server/shortcuts.js';
import { removeTree } from './_fs.mjs';

const menu = (base) => path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs');

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-lnk-'));
  const appData = path.join(dir, 'Roaming');
  const programData = path.join(dir, 'ProgramData');
  for (const [base, name] of files) {
    const d = menu(base === 'user' ? appData : programData);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, name), 'lnk');
  }
  return { dir, appData, programData };
}

test('all-users install: the per-user leftover "Fleet Bridge.lnk" is found', () => {
  const f = fixture([['all', CURRENT], ['user', 'Fleet Bridge.lnk']]);
  try {
    assert.deepEqual(staleShortcuts(f), [path.join(menu(f.appData), 'Fleet Bridge.lnk')]);
  } finally {
    removeTree(f.dir);
  }
});

test('nothing is touched without the installer\'s current shortcut, and the current one never', () => {
  const f = fixture([['user', 'Fleet Bridge.lnk'], ['user', 'CLAUDE OPS.lnk']]);
  try {
    assert.deepEqual(staleShortcuts(f), []);
    fs.writeFileSync(path.join(menu(f.appData), CURRENT), 'lnk');
    const found = staleShortcuts(f);
    assert.equal(found.length, 2);
    assert.ok(found.every((p) => path.basename(p) !== CURRENT));
  } finally {
    removeTree(f.dir);
  }
});

test('cleanShortcuts removes them on the installed Windows app only and refreshes the icons', () => {
  const f = fixture([['all', CURRENT], ['user', 'Fleet Bridge.lnk']]);
  const env = { APPDATA: f.appData, ProgramData: f.programData, FLEET_VARIANT: 'installer' };
  let refreshed = 0;
  const opts = { env, refresh: () => refreshed++, log: () => {} };
  try {
    assert.deepEqual(cleanShortcuts({ ...opts, platform: 'linux' }), []);
    assert.deepEqual(cleanShortcuts({ ...opts, platform: 'win32', env: { ...env, FLEET_VARIANT: 'dev' } }), []);
    assert.equal(refreshed, 0);
    const removed = cleanShortcuts({ ...opts, platform: 'win32' });
    assert.equal(removed.length, 1);
    assert.equal(fs.existsSync(removed[0]), false);
    assert.equal(fs.existsSync(path.join(menu(f.programData), CURRENT)), true);
    assert.equal(refreshed, 1);
    assert.deepEqual(cleanShortcuts({ ...opts, platform: 'win32' }), []); // once gone, nothing more to do
    assert.equal(refreshed, 1);
  } finally {
    removeTree(f.dir);
  }
});
