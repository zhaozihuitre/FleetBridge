// The PTY host's pipe name, shared by the host and the server: one per data folder, so the dev app
// and the installed app never share terminals.
'use strict';
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const PROTOCOL = 1; // bump only with an incompatible change: a running host outlives updates

function pipeName(dataDir) {
  const tag = crypto.createHash('sha1').update(path.resolve(String(dataDir || '')).toLowerCase()).digest('hex').slice(0, 12);
  return process.platform === 'win32' ? `\\\\.\\pipe\\fleet-ptyhost-${tag}` : path.join(os.tmpdir(), `fleet-ptyhost-${tag}.sock`);
}

module.exports = { pipeName, PROTOCOL };
