// Claude Code Notification hook: records "Claude needs your permission" prompts so the
// monitor can alert you. Installed in ~/.claude/settings.json; reads the hook JSON on stdin.
// Only writes a local file, and never fails loudly: a broken monitor must not disturb Claude Code.
// Self-contained on purpose: the app copies it to ~/.claude-ops/hook.js so it runs without the app folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = path.join(process.env.MONITOR_DATA_DIR || path.join(os.homedir(), '.claude-ops'), 'notifications.jsonl');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const d = JSON.parse(raw);
    const entry = {
      at: Date.now(),
      sessionId: d.session_id,
      cwd: d.cwd,
      type: d.notification_type || d.hook_event_name,
      message: String(d.message || '').slice(0, 300),
    };
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(entry) + '\n');
  } catch {
    // ignore: never block or error the Claude Code session
  }
});
