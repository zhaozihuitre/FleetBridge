// PTY host: a small long-lived process that owns every terminal (agents and shells), so the server
// and the windows can restart (an update, a crash) while the terminals keep running. The server
// talks to it over a local pipe with newline-delimited JSON; on (re)connecting it asks for the list
// and gets each terminal's recent output back to rebuild its screen.
// Started detached by the server (server/ptyclient.js) with Electron's own binary as node; one host
// per data folder (the dev app has its own). It ends when told to (the app quits) or when it has
// had no terminals and no server for a while.
'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { pipeName, PROTOCOL } = require('./ptypipe.cjs');

const DATA_DIR = process.env.MONITOR_DATA_DIR;
const PIPE = pipeName(DATA_DIR);
const BUF_MAX = 512 * 1024; // recent output kept per terminal (replayed to rebuild its screen)
const IDLE_EXIT = 120_000; // no terminals and no server for this long: nothing to keep alive

let pty;
try {
  pty = require('@lydell/node-pty');
} catch (e) {
  log(`node-pty failed to load: ${e.message}`);
  process.exit(3);
}

const terms = new Map(); // id -> { id, p, meta, alive, exitCode, buf }
const clients = new Set();

function log(line) {
  try {
    fs.appendFileSync(path.join(DATA_DIR || '.', 'ptyhost.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // no log
  }
}

function send(c, msg) {
  if (!c.destroyed) c.write(JSON.stringify(msg) + '\n');
}
function broadcast(msg) {
  const line = JSON.stringify(msg) + '\n';
  for (const c of clients) if (!c.destroyed) c.write(line);
}

const info = (t) => ({ id: t.id, pid: t.p.pid, meta: t.meta, alive: t.alive, exitCode: t.exitCode, buf: t.buf });

function handle(c, m) {
  switch (m.t) {
    case 'hello':
      return send(c, { t: 'hello', rid: m.rid, protocol: PROTOCOL, pid: process.pid, terms: terms.size });
    case 'list':
      return send(c, { t: 'list', rid: m.rid, terms: [...terms.values()].map(info) });
    case 'spawn': {
      if (terms.get(m.id)?.alive) return send(c, { t: 'spawned', rid: m.rid, id: m.id, pid: terms.get(m.id).p.pid, existing: true });
      try {
        const p = pty.spawn(m.file, m.args || [], { name: 'xterm-256color', cols: m.cols || 120, rows: m.rows || 32, cwd: m.cwd, env: m.env });
        const t = { id: m.id, p, meta: m.meta || {}, alive: true, exitCode: null, buf: '' };
        terms.set(m.id, t);
        p.onData((d) => {
          t.buf = (t.buf + d).slice(-BUF_MAX);
          broadcast({ t: 'data', id: t.id, d });
        });
        p.onExit(({ exitCode }) => {
          t.alive = false;
          t.exitCode = exitCode;
          broadcast({ t: 'exit', id: t.id, code: exitCode });
          idleCheck();
        });
        log(`spawn ${m.id} pid ${p.pid} ${m.file}`);
        return send(c, { t: 'spawned', rid: m.rid, id: m.id, pid: p.pid });
      } catch (e) {
        return send(c, { t: 'error', rid: m.rid, id: m.id, error: e.message });
      }
    }
    case 'write':
      return terms.get(m.id)?.alive && terms.get(m.id).p.write(m.d);
    case 'resize': {
      const t = terms.get(m.id);
      if (!t?.alive) return;
      try {
        t.p.resize(Math.max(20, m.cols | 0), Math.max(5, m.rows | 0));
        t.meta.cols = m.cols;
        t.meta.rows = m.rows;
      } catch {
        // exiting
      }
      return;
    }
    case 'meta': {
      const t = terms.get(m.id);
      if (t) t.meta = { ...t.meta, ...m.meta };
      return;
    }
    case 'kill': {
      const t = terms.get(m.id);
      if (t?.alive) t.p.kill();
      return;
    }
    case 'forget':
      if (!terms.get(m.id)?.alive) terms.delete(m.id);
      return idleCheck();
    case 'killall':
      // the app quits: its terminals end with it (the roster brings the agents back next start)
      for (const t of terms.values()) if (t.alive) t.p.kill();
      if (m.exit) setTimeout(() => process.exit(0), 1500).unref();
      return send(c, { t: 'killed', rid: m.rid });
  }
}

let idleTimer = null;
function idleCheck() {
  clearTimeout(idleTimer);
  const anyAlive = [...terms.values()].some((t) => t.alive);
  if (anyAlive || clients.size) return;
  idleTimer = setTimeout(() => {
    if (![...terms.values()].some((t) => t.alive) && !clients.size) {
      log('idle: exit');
      process.exit(0);
    }
  }, IDLE_EXIT);
}

const server = net.createServer((c) => {
  clients.add(c);
  clearTimeout(idleTimer);
  let buf = '';
  c.setEncoding('utf8');
  c.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        handle(c, JSON.parse(line));
      } catch (e) {
        log(`bad message: ${e.message}`);
      }
    }
  });
  c.on('error', () => {});
  c.on('close', () => {
    clients.delete(c);
    idleCheck();
  });
});
server.on('error', (e) => {
  // another host already serves this data folder: it keeps the terminals, this one isn't needed
  log(`listen failed: ${e.code || e.message}`);
  process.exit(e.code === 'EADDRINUSE' ? 0 : 4);
});
server.listen(PIPE, () => {
  log(`host ${process.pid} on ${PIPE}`);
  idleCheck();
});
process.on('uncaughtException', (e) => log(`uncaught: ${e.stack || e.message}`));
