import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// Order log: every order given to one of our agents, whether typed straight in, queued, sent later
// from the queue or taken off it, and from where (command center or phone). Appended to a JSONL file
// so the record survives restarts; the newest entries go out with the state for the Orders tab.
const FILE = path.join(DATA_DIR, process.env.MONITOR_DEMO ? 'orders.demo.jsonl' : 'orders.jsonl');
const KEEP = 500; // in memory and after a compaction of the file
const SHOW = 150; // entries sent with each state
const TEXT_MAX = 2000;

let log = load();

function load() {
  try {
    return fs
      .readFileSync(FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(-KEEP);
  } catch {
    return [];
  }
}

/**
 * @param {{kind: 'sent'|'queued'|'dispatched'|'removed', agentId: string, name?: string, project?: string,
 *   text: string, via?: 'cc'|'phone', queuedAt?: number}} entry
 */
export function recordOrder(entry) {
  const e = { at: Date.now(), via: 'cc', ...entry, text: String(entry.text || '').slice(0, TEXT_MAX) };
  log.push(e);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (log.length > KEEP * 2) {
      log = log.slice(-KEEP);
      fs.writeFileSync(FILE, log.map((x) => JSON.stringify(x)).join('\n') + '\n');
    } else fs.appendFileSync(FILE, JSON.stringify(e) + '\n');
  } catch {
    // kept in memory only
  }
}

/** Newest first, texts shortened for the state payload. */
export function recentOrders() {
  return log
    .slice(-SHOW)
    .reverse()
    .map((e) => ({ ...e, text: e.text.length > 400 ? e.text.slice(0, 400) + '…' : e.text }));
}
