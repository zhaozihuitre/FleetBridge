import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// Order queues: orders for an agent sent one per turn. When the agent has been idle for a moment
// (and is not waiting on a permission dialog), the next order goes out; then we wait until it has
// actually started working before considering the next one. Kept on disk across restarts.
//
// Orders that outlived what they were queued for are held, not sent (improvement P-005): the agent's
// terminal ended (they pass to the session when it is opened again, or to a new one in the same folder),
// or its turn stopped on the quota. A held order goes out only after a person says so (release), or is
// dropped: it may be out of date by then. Orders queued after that are not held and go out as usual.
const FILE = path.join(DATA_DIR, process.env.MONITOR_DEMO ? 'queues.demo.json' : 'queues.json');
const IDLE_MS = 5_000;
const START_TIMEOUT = 60_000; // an order that never made the agent busy: move on anyway
const RESET_MARGIN = 60_000; // after the quota's reset time, before saying it is back
const NEAR_STOP = 30 * 60_000; // how long after a quota stop the usage reading still tells when that quota resets

let queues = {}; // agent id -> [{ text, at, via?, held?: 'closed'|'quota', heldAt? }] (agent ids stay put across /clear)
let meta = {}; // agent id -> { cwd, name, sessionId, closedAt? }: whose queue it is, to find it again once its terminal is gone
let quota = {}; // agent id -> { at, resetsAt, name, told?, dismissed? }: turns stopped on the quota, until they go on
const sentAt = new Map(); // agent id -> when the last order went out and we wait for it to start
load();

function load() {
  queues = {};
  meta = {};
  quota = {};
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === '_meta') meta = v && typeof v === 'object' ? v : {};
      else if (k === '_quota') quota = v && typeof v === 'object' ? v : {};
      else if (Array.isArray(v) && v.length) queues[k] = v;
    }
  } catch {
    // no file yet
  }
}

function save() {
  for (const id of Object.keys(meta)) if (!queues[id]) delete meta[id];
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ ...queues, _meta: meta, _quota: quota }));
  } catch {
    // the queue still works in memory
  }
}

const who = (a) => ({ cwd: a.cwd || '', name: a.name || null, sessionId: a.sessionId || null });

/** via: who queued it ('master' turns are reported back to the master once they end). agent: whose queue (kept with it). */
export function enqueue(id, text, via, agent) {
  (queues[id] ||= []).push({ text: String(text).slice(0, 20_000), at: Date.now(), ...(via ? { via } : {}) });
  if (agent) meta[id] = { ...meta[id], ...who(agent) };
  save();
}

/** Takes one order (or the whole queue; heldOnly: only its held orders) off; returns what was removed. */
export function dequeue(id, index, { heldOnly = false } = {}) {
  const q = queues[id];
  if (!q) return [];
  let removed;
  if (index != null) removed = q.splice(index, 1);
  else if (heldOnly) {
    removed = q.filter((x) => x.held);
    queues[id] = q.filter((x) => !x.held);
  } else removed = q.splice(0);
  if (!queues[id].length) delete queues[id];
  save();
  return removed;
}

export const queueOf = (id) => queues[id] || [];

/** Holds the orders of a queue that are not held yet; returns them. */
function hold(id, reason, now) {
  const fresh = (queues[id] || []).filter((x) => !x.held);
  for (const x of fresh) Object.assign(x, { held: reason, heldAt: now });
  return fresh;
}

/** The held orders of a queue go out again, in their place, one per turn; returns them. */
export function release(id) {
  const held = (queues[id] || []).filter((x) => x.held);
  for (const x of held) {
    delete x.held;
    delete x.heldAt;
  }
  if (held.length) save();
  return held;
}

const sameDir = (a, b) => Boolean(a && b) && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * Called on every publish with every agent (listAgents): a queue whose terminal is gone is held, and passes
 * to the session when it runs again (the same session by its id, or a session started later in the same
 * folder), still held. Returns the orders newly held, for the order log: [{ id, name, cwd, items }].
 */
export function reconcile(agents, now = Date.now()) {
  const alive = agents.filter((a) => a.alive && (a.kind || 'claude') === 'claude');
  const byId = new Map(alive.map((a) => [a.id, a]));
  const newly = [];
  let changed = false;
  for (const id of Object.keys(queues)) {
    const a = byId.get(id);
    if (a) {
      const m = meta[id];
      if (!m || m.cwd !== (a.cwd || '') || m.name !== (a.name || null) || m.sessionId !== (a.sessionId || null) || m.closedAt) {
        meta[id] = who(a);
        changed = true;
      }
      continue;
    }
    const m = (meta[id] ||= { cwd: '', name: null, sessionId: null });
    const items = hold(id, 'closed', now);
    if (items.length || !m.closedAt) {
      m.closedAt ||= now;
      changed = true;
      if (items.length) newly.push({ id, name: m.name, cwd: m.cwd, items });
    }
    const heir =
      alive.find((x) => x.sessionId === id || (m.sessionId && (x.id === m.sessionId || x.sessionId === m.sessionId))) ||
      alive.find((x) => sameDir(x.cwd, m.cwd) && (x.startedAt || 0) >= m.closedAt);
    if (!heir) continue;
    queues[heir.id] = [...queues[id], ...(queues[heir.id] || [])]; // the older orders first
    delete queues[id];
    meta[heir.id] = who(heir);
    sentAt.delete(id);
    changed = true;
  }
  if (changed) save();
  return newly;
}

/** Queues nobody runs now (their terminal ended and the session was not opened again): [{ id, name, cwd, closedAt, queue }]. */
export function orphanQueues(agents) {
  const alive = new Set(agents.filter((a) => a.alive).map((a) => a.id));
  return Object.keys(queues)
    .filter((id) => !alive.has(id))
    .map((id) => ({ id, name: meta[id]?.name || null, cwd: meta[id]?.cwd || '', closedAt: meta[id]?.closedAt || 0, queue: queues[id] }));
}

/**
 * Called on every publish with the live units of our agents: sends the next order to each one
 * that is idle and ready. send(agentId, text) types it into the agent. Held orders are passed over;
 * the orders waiting when a turn stopped on the quota are held (onHold(agentId, items)).
 */
export function dispatch(units, send, now = Date.now(), onHold = () => {}) {
  for (const u of units) {
    const id = u.agentId;
    const q = queues[id];
    if (!q?.length) continue;
    if (u.limit && u.status !== 'busy') {
      // queued before it stopped: sending them now would only fail on the quota too
      const fresh = q.filter((x) => !x.held && x.at <= (u.limit.at || now));
      if (fresh.length) {
        for (const x of fresh) Object.assign(x, { held: 'quota', heldAt: now });
        save();
        onHold(id, fresh);
      }
    }
    const i = q.findIndex((x) => !x.held);
    if (i < 0) continue;
    const waited = sentAt.get(id);
    if (waited) {
      // started: seen busy, or the status changed since (a quick turn can go busy -> idle between polls)
      if (u.status === 'busy' || (u.statusSince || 0) > waited || now - waited > START_TIMEOUT) sentAt.delete(id);
      else continue; // the last order has not started yet
      if (u.status === 'busy') continue;
    }
    if (u.status !== 'idle' || u.permission || now - (u.statusSince || 0) < IDLE_MS) continue;
    const [next] = q.splice(i, 1);
    if (!q.length) delete queues[id];
    save();
    if (send(id, next.text, next)) sentAt.set(id, now);
  }
}

/**
 * Turns of our agents that stopped on the quota, followed until they go on. Called on every publish with
 * the live units of our agents (each with .limit, .quota) and the usage reading's limit gating now.
 * Returns those whose quota has reset since, once each: [{ agentId, name, resetsAt, held }] (held: how many
 * of its queued orders wait for a go-ahead), for the notice to the master.
 */
export function quotaWatch(units, gate, now = Date.now()) {
  const due = [];
  let changed = false;
  const seen = new Set();
  for (const u of units) {
    const id = u.agentId;
    if (!id) continue;
    seen.add(id);
    if (!u.limit || u.status === 'busy') {
      // it went on (any new prompt clears the stop)
      if (quota[id]) {
        delete quota[id];
        changed = true;
      }
      continue;
    }
    // the reset time is the reading's around the stop: a stop found long after (a session resumed days later)
    // has none, and is never reported as "back"
    const near = now - (u.limit.at || 0) < NEAR_STOP;
    const resetsAt = (near && ((u.quota?.resetsAt > now && u.quota.resetsAt) || (gate?.resetsAt > now && gate.resetsAt))) || 0;
    let w = quota[id];
    if (!w || w.at !== (u.limit.at || 0)) {
      w = quota[id] = { at: u.limit.at || 0, resetsAt, name: u.name || u.title || u.project || null };
      changed = true;
    } else if (!w.resetsAt && resetsAt) {
      w.resetsAt = resetsAt;
      changed = true;
    }
    if (w.resetsAt && now >= w.resetsAt + RESET_MARGIN && !w.told) {
      w.told = now;
      changed = true;
      if (!w.dismissed) due.push({ agentId: id, name: w.name, resetsAt: w.resetsAt, held: queueOf(id).filter((x) => x.held).length });
    }
  }
  for (const id of Object.keys(quota))
    if (!seen.has(id)) {
      delete quota[id]; // its terminal ended
      changed = true;
    }
  if (changed) save();
  return due;
}

/** Stopped on the quota and not gone on: [{ agentId, at, resetsAt, back }] (back: the quota has reset since). */
export function quotaStops(now = Date.now()) {
  return Object.entries(quota)
    .filter(([, w]) => !w.dismissed)
    .map(([agentId, w]) => ({ agentId, at: w.at, resetsAt: w.resetsAt || 0, back: Boolean(w.resetsAt && now >= w.resetsAt + RESET_MARGIN) }));
}

/** "Don't remind me": the stop is no longer listed (until the agent stops on the quota again). */
export function dismissQuota(id) {
  if (!quota[id]) return false;
  quota[id].dismissed = true;
  save();
  return true;
}

/** For the tests: read the file again, as a server starting would. */
export function reloadQueues() {
  sentAt.clear();
  load();
}
