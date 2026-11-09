import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// When you last looked at each session (opened its terminal, on any page): a turn that ended after that is
// "done, not looked at yet" (the green light) until you open it. A session seen for the first time counts as
// looked at then, so nothing already finished lights up after an install or a restart.
// Kept in <data>/seen.json (an update restarts the server).
const FILE = path.join(DATA_DIR, 'seen.json');
const KEEP = 500;
const seen = new Map(load());
let dirty = false;

function load() {
  try {
    return Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')) || {});
  } catch {
    return [];
  }
}

function save() {
  if (!dirty) return;
  dirty = false;
  // the newest ones only
  const entries = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, KEEP);
  try {
    fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // kept in memory only
  }
}
setInterval(save, 5000).unref?.();

/** When the session was last looked at (first sight: now). */
export function seenAt(sessionId, now = Date.now()) {
  if (!sessionId) return now;
  if (!seen.has(sessionId)) {
    seen.set(sessionId, now);
    dirty = true;
  }
  return seen.get(sessionId);
}

/** You looked at it now (opened its terminal). */
export function markSeen(sessionId, now = Date.now()) {
  if (!sessionId || typeof sessionId !== 'string') return false;
  seen.set(sessionId, now);
  dirty = true;
  return true;
}

export function flushSeen() {
  save();
}
