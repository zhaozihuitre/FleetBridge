// The server as a child process of the desktop shell (desktop/main.cjs), started from the app folder
// of the current version. It tells the shell when it is ready, asks it to open the command center,
// and on request either makes way for another version (terminals stay in the PTY host) or shuts
// everything down (the app quits).
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import * as server from './index.js';
import { DATA_DIR, ROOT } from './config.js';
import { healShutdownRollback } from './selfheal.js';

const send = (m) => process.send?.(m);

// The installed app has no console: what the server prints goes to <data>/server.log (kept short),
// so a server that won't start says why.
const LOG = path.join(process.env.MONITOR_DATA_DIR || '.', 'server.log');
try {
  if (fs.statSync(LOG).size > 2_000_000) fs.renameSync(LOG, LOG + '.old');
} catch {
  // no log yet
}
const write = (level, args) => {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${level} ${util.format(...args)}\n`);
  } catch {
    // nowhere to write
  }
};
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    write(level, args);
    try {
      orig(...args);
    } catch {
      // no stdout
    }
  };
}
process.on('uncaughtException', (e) => {
  write('fatal', [e.stack || e.message]);
  process.exit(1);
});
process.on('unhandledRejection', (e) => write('error', ['unhandled rejection:', e?.stack || e]));

server.setUiOpener(() => send({ type: 'openMain' }));

process.on('message', async (m) => {
  if (m?.type === 'shutdown') {
    await server.shutdown().catch(() => {});
    send({ type: 'down' });
    process.exit(0);
  }
  if (m?.type === 'detach') {
    await server.detach().catch(() => {});
    send({ type: 'down' });
    process.exit(0);
  }
});
// the shell is gone (it crashed or was killed): this server goes too; the terminals stay in the host
process.on('disconnect', () => process.exit(0));

try {
  console.log(`server ${server.appVersion} starting (pid ${process.pid})`);
  await server.start({ onListening: () => send({ type: 'ready', url: server.url, version: server.appVersion }) });
  console.log('server started');
  // a newer version set aside by the last Windows shutdown (an old shell's misjudgment) comes back
  setTimeout(() => {
    try {
      const back = healShutdownRollback({ dataDir: DATA_DIR, root: ROOT });
      if (back) {
        console.log(`version ${back} was set aside by the last shutdown, not a real failure: back to it`);
        send({ type: 'reload' });
      }
    } catch (e) {
      console.error('shutdown rollback check failed:', e.message);
    }
  }, 5_000);
} catch (e) {
  console.error('server failed to start:', e.stack || e.message);
  send({ type: 'failed', error: e.code === 'EADDRINUSE' ? 'EADDRINUSE' : e.message });
  process.exit(1);
}
