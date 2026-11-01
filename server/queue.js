import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// Order queues: orders for an agent sent one per turn. When the agent has been idle for a moment
// (and is not waiting on a permission dialog), the next order goes out; then we wait until it has
// actually started working before considering the next one. Kept on disk across restarts.
const FILE = path.join(DATA_DIR, process.env.MONITOR_DEMO ? 'queues.demo.json' : 'queues.json');
const IDLE_MS = 5_000;
const START_TIMEOUT = 60_000; // an order that never made the agent busy: move on anyway

let queues = load(); // agent id -> [{ text, at }] (agent ids stay put across /clear)
const sentAt = new Map(); // agent id -> when the last order went out and we wait for it to start

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(queues));
  } catch {
    // the queue still works in memory
  }
}

export function enqueue(id, text) {
  (queues[id] ||= []).push({ text: String(text).slice(0, 20_000), at: Date.now() });
  save();
}

export function dequeue(id, index) {
  const q = queues[id];
  if (!q) return;
  if (index == null) delete queues[id];
  else q.splice(index, 1);
  if (q && !q.length) delete queues[id];
  save();
}

export const queueOf = (id) => queues[id] || [];

/**
 * Called on every publish with the live units of our agents: sends the next order to each one
 * that is idle and ready. send(agentId, text) types it into the agent.
 */
export function dispatch(units, send, now = Date.now()) {
  for (const u of units) {
    const id = u.agentId;
    const q = queues[id];
    if (!q?.length) continue;
    const waited = sentAt.get(id);
    if (waited) {
      // started: seen busy, or the status changed since (a quick turn can go busy -> idle between polls)
      if (u.status === 'busy' || (u.statusSince || 0) > waited || now - waited > START_TIMEOUT) sentAt.delete(id);
      else continue; // the last order has not started yet
      if (u.status === 'busy') continue;
    }
    if (u.status !== 'idle' || u.permission || now - (u.statusSince || 0) < IDLE_MS) continue;
    const next = q.shift();
    if (!q.length) delete queues[id];
    save();
    if (send(id, next.text)) sentAt.set(id, now);
  }
}
