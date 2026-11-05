// The server as a child process of the desktop shell (desktop/main.cjs), started from the app folder
// of the current version. It tells the shell when it is ready, asks it to open the command center,
// and on request either makes way for another version (terminals stay in the PTY host) or shuts
// everything down (the app quits).
import * as server from './index.js';

const send = (m) => process.send?.(m);

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
  await server.start();
  send({ type: 'ready', url: server.url, version: server.appVersion });
} catch (e) {
  send({ type: 'failed', error: e.code === 'EADDRINUSE' ? 'EADDRINUSE' : e.message });
  process.exit(1);
}
