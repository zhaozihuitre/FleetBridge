import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

// Written by server/hook.js (a Claude Code Notification hook) whenever a session shows a permission prompt.
const FILE = path.join(DATA_DIR, 'notifications.jsonl');

let offset = 0;
let rest = '';
const latest = new Map(); // sessionId -> { at, type, message }

export function readNotifications() {
  let size;
  try {
    size = fs.statSync(FILE).size;
  } catch {
    return latest;
  }
  if (size < offset) offset = 0; // file was truncated or replaced
  if (size > offset) {
    const fd = fs.openSync(FILE, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      const lines = (rest + buf.toString('utf8')).split('\n');
      rest = lines.pop();
      for (const line of lines) {
        try {
          const n = JSON.parse(line);
          if (n.sessionId && n.type === 'permission_prompt') latest.set(n.sessionId, n);
        } catch {
          // skip malformed line
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return latest;
}
