// Updatable app folders. The installed program is a shell (Electron, the window code, node_modules
// with the native terminal module); the server and the pages run from <data>/app/<version>/, so an
// update only puts the new server/ and web/ there and switches current.json; the previous version is
// kept to go back to. Each version folder reaches the shell's node_modules through a junction.
//   <data>/app/current.json  { version, dir, previous: { version, dir } | null, failed: [versions] }
'use strict';
const fs = require('node:fs');
const path = require('node:path');

// What a version's server may expect of the shell: bumped when the shell changes in a way a server
// relies on (IPC messages, preload API, native modules). A version needing more than this shell has
// can't run in it: that update needs a full install.
const SHELL_API = 1;
const KEEP = 4; // version folders kept (current, previous and a couple more)

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

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The installer's shell and an npm-installed one each keep their own version folders ('app',
// 'app-npm'): a version folder's node_modules junction points into the shell that installed it.
function create(dataDir, shellDir, baseName = 'app') {
  const base = path.join(dataDir, baseName);
  const currentFile = path.join(base, 'current.json');

  const read = () => readJson(currentFile);
  const write = (c) => {
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(currentFile, JSON.stringify(c, null, 2));
  };

  /** A version folder this shell can run: its files are there and it asks no more of the shell than it has. */
  function usable(dir) {
    if (!dir || !fs.existsSync(path.join(dir, 'server', 'run.mjs')) || !fs.existsSync(path.join(dir, 'web', 'index.html'))) return false;
    const pkg = readJson(path.join(dir, 'package.json')) || {};
    return (pkg.fleetShellApi || 1) <= SHELL_API;
  }

  /** node_modules of a version folder: a junction to the shell's (the native terminal module lives there). */
  function link(dir) {
    const nm = path.join(dir, 'node_modules');
    try {
      fs.lstatSync(nm);
      return;
    } catch {
      // not there yet
    }
    fs.symlinkSync(path.join(shellDir, 'node_modules'), nm, 'junction');
  }

  function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name);
      const b = path.join(to, e.name);
      if (e.isDirectory()) copyDir(a, b);
      else fs.copyFileSync(a, b);
    }
  }

  /** Installs a version folder from a source tree with server/, web/ and package.json. */
  function install(srcDir, version) {
    const dir = path.join(base, version);
    const tmp = `${dir}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const sub of ['server', 'web']) copyDir(path.join(srcDir, sub), path.join(tmp, sub));
    const pkg = readJson(path.join(srcDir, 'package.json')) || {};
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', fleetBuild: version, fleetShellApi: pkg.fleetShellApi || 1 }, null, 2));
    try {
      fs.unlinkSync(path.join(dir, 'node_modules')); // the junction only, never the shell's modules
    } catch {
      // no earlier copy of this version
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    link(dir);
    return dir;
  }

  /** Makes a version current, keeping the one it replaces as the previous. */
  function switchTo(version, dir) {
    const cur = read();
    write({ version, dir, previous: cur && cur.dir !== dir ? { version: cur.version, dir: cur.dir } : cur?.previous || null, failed: cur?.failed || [] });
    prune();
  }

  /**
   * The folder to run now. The shell's own copy is installed as a version when there is none yet,
   * or when the shell is newer than the current version (a full install came after the last update).
   */
  function resolve(shellVersion) {
    let cur = read();
    const shellBuild = `${shellVersion}-shell`;
    if (!cur || !usable(cur.dir) || cmp(String(cur.version).replace(/-.*$/, ''), shellVersion) < 0) {
      const dir = install(shellDir, shellBuild);
      switchTo(shellBuild, dir);
      cur = read();
    }
    link(cur.dir);
    return cur;
  }

  /** The version that just failed to start is set aside and the previous one comes back. */
  function rollback(reason) {
    const cur = read();
    if (!cur?.previous || !usable(cur.previous.dir)) return null;
    write({ version: cur.previous.version, dir: cur.previous.dir, previous: null, failed: [...(cur.failed || []), { version: cur.version, reason: String(reason || ''), at: new Date().toISOString() }].slice(-10) });
    return read();
  }

  function prune() {
    const cur = read();
    const keep = new Set([cur?.dir, cur?.previous?.dir].filter(Boolean).map((d) => path.resolve(d)));
    let dirs;
    try {
      dirs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.includes('.tmp-')).map((e) => path.join(base, e.name));
    } catch {
      return;
    }
    dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const d of dirs.slice(KEEP)) {
      if (keep.has(path.resolve(d))) continue;
      // Renamed out of the way first: a folder still in use (the terminal host keeps running from the
      // folder it was started from) can't be renamed on Windows, so it stays whole until next time.
      const gone = `${d}.tmp-del-${process.pid}`;
      try {
        fs.renameSync(d, gone);
      } catch {
        continue;
      }
      try {
        fs.unlinkSync(path.join(gone, 'node_modules')); // the junction only, never the shell's modules
      } catch {
        // no junction
      }
      try {
        fs.rmSync(gone, { recursive: true, force: true });
      } catch {
        // left over: skipped by the listing above (.tmp-), tried again by nobody; harmless
      }
    }
  }

  return { base, read, resolve, install, switchTo, rollback, usable };
}

module.exports = { create, SHELL_API, cmp };
