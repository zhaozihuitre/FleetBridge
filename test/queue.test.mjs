// Order queues that outlive what they were queued for (improvement P-005, server/queue.js): kept on disk,
// held when the agent's terminal ended or its turn stopped on the quota, passed to the session opened again,
// sent on only after a go-ahead; and the reminder once the quota has reset. Uses its own data folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { removeTree } from './_fs.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-test-'));
process.env.MONITOR_DATA_DIR = path.join(tmp, 'data');
fs.mkdirSync(process.env.MONITOR_DATA_DIR, { recursive: true });
const FILE = path.join(process.env.MONITOR_DATA_DIR, 'queues.json');
const { enqueue, dequeue, queueOf, dispatch, reconcile, release, orphanQueues, quotaWatch, quotaStops, dismissQuota, reloadQueues } = await import('../server/queue.js');
const { quotaBackNotice } = await import('../server/master.js');
after(() => removeTree(tmp));

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
  reloadQueues();
});

const T0 = Date.parse('2026-11-20T02:00:00Z');
const DIR = path.join(tmp, 'agentmcp');
const agent = (id, o = {}) => ({ id, sessionId: id, kind: 'claude', name: 'agentmcp', cwd: DIR, alive: true, startedAt: T0, ...o });
const idle = (agentId, o = {}) => ({ agentId, status: 'idle', statusSince: T0, ...o });
/** One round of dispatch; what went out. */
function round(units, now, held = []) {
  const sent = [];
  dispatch(units, (id, text) => (sent.push(`${id}:${text}`), true), now, (id, items) => held.push(...items.map((x) => `${id}:${x.text}`)));
  return sent;
}
const texts = (id) => queueOf(id).map((q) => (q.held ? `[${q.held}] ` : '') + q.text);

test('a queue goes out one order per turn, and is on disk in between', () => {
  const a = agent('a1');
  enqueue('a1', 'one', 'master', a);
  enqueue('a1', 'two', 'master', a);
  assert.deepEqual(reconcile([a], T0), []);
  assert.deepEqual(round([idle('a1')], T0 + 1000), [], 'not idle long enough yet');
  assert.deepEqual(round([idle('a1')], T0 + 6000), ['a1:one']);
  assert.deepEqual(round([idle('a1')], T0 + 12_000), [], 'the first has not started yet');
  reloadQueues(); // a server starting: the rest is still there
  assert.deepEqual(texts('a1'), ['two']);
  assert.deepEqual(round([idle('a1', { statusSince: T0 + 60_000 })], T0 + 70_000), ['a1:two']);
  assert.deepEqual(queueOf('a1'), []);
});

test('the terminal ended: its orders are held, and pass to the same session opened again', () => {
  const a = agent('a1', { sessionId: 's2' }); // its session id moved on (/clear)
  for (const t of ['one', 'two', 'three']) enqueue('a1', t, 'master', a);
  reconcile([a], T0);
  // it exits
  const held = reconcile([{ ...a, alive: false }], T0 + 1000);
  assert.equal(held.length, 1);
  assert.deepEqual(held[0].items.map((x) => x.text), ['one', 'two', 'three']);
  assert.equal(held[0].name, 'agentmcp');
  assert.deepEqual(reconcile([{ ...a, alive: false }], T0 + 2000), [], 'held once');
  assert.deepEqual(orphanQueues([{ ...a, alive: false }]).map((o) => [o.id, o.name, o.queue.length]), [['a1', 'agentmcp', 3]]);
  // the session is resumed: a new agent whose id is the session's
  const b = agent('s2', { startedAt: T0 + 60_000 });
  reconcile([{ ...a, alive: false }, b], T0 + 61_000);
  assert.deepEqual(queueOf('a1'), []);
  assert.deepEqual(texts('s2'), ['[closed] one', '[closed] two', '[closed] three']);
  assert.deepEqual(orphanQueues([b]), []);
  // nothing goes out by itself, however idle it is
  assert.deepEqual(round([idle('s2', { statusSince: T0 + 61_000 })], T0 + 120_000), []);
  // the user says yes: they go out in order, one per turn
  assert.deepEqual(release('s2').map((x) => x.text), ['one', 'two', 'three']);
  assert.deepEqual(round([idle('s2', { statusSince: T0 + 61_000 })], T0 + 121_000), ['s2:one']);
  assert.deepEqual(texts('s2'), ['two', 'three']);
});

test('after a restart with no terminal left, the queue waits for a new session in the same folder', () => {
  const a = agent('a1');
  enqueue('a1', 'one', 'cc', a);
  reconcile([a], T0);
  reloadQueues(); // the app quit and started again: no agents
  assert.equal(reconcile([], T0 + 5000).length, 1);
  assert.deepEqual(orphanQueues([]).map((o) => [o.id, o.cwd, o.closedAt]), [['a1', DIR, T0 + 5000]]);
  // a session that was already running in that folder is not it, nor one elsewhere
  const old = agent('old', { startedAt: T0 - 1000 });
  const other = agent('other', { cwd: path.join(tmp, 'elsewhere'), startedAt: T0 + 9000 });
  reconcile([old, other], T0 + 10_000);
  assert.deepEqual(texts('a1'), ['[closed] one']);
  // a new one in the same folder takes it, ahead of what it has queued itself, still held
  const b = agent('b2', { cwd: DIR.toUpperCase(), startedAt: T0 + 20_000 });
  enqueue('b2', 'new', 'cc', b);
  reconcile([old, other, b], T0 + 21_000);
  assert.deepEqual(texts('b2'), ['[closed] one', 'new']);
  // the order queued since is not held: it goes out, the old one stays
  assert.deepEqual(round([idle('b2', { statusSince: T0 + 21_000 })], T0 + 30_000), ['b2:new']);
  assert.deepEqual(texts('b2'), ['[closed] one']);
  reloadQueues();
  assert.deepEqual(texts('b2'), ['[closed] one'], 'the hold is on disk too');
});

test('held orders can be dropped: all of them, leaving the ones queued since', () => {
  const a = agent('a1');
  enqueue('a1', 'one', 'cc', a);
  reconcile([{ ...a, alive: false }], T0);
  reconcile([a], T0 + 1000); // the same id runs again
  enqueue('a1', 'two', 'cc', a);
  assert.deepEqual(texts('a1'), ['[closed] one', 'two']);
  assert.deepEqual(dequeue('a1', null, { heldOnly: true }).map((x) => x.text), ['one']);
  assert.deepEqual(texts('a1'), ['two']);
  assert.deepEqual(release('a1'), []);
});

test('a turn stopped on the quota: what was queued behind it is held, not sent into the limit', () => {
  const a = agent('a1');
  enqueue('a1', 'one', 'master', a);
  enqueue('a1', 'two', 'master', a);
  const at = Date.now() + 1000; // the stop, after both were queued
  const held = [];
  assert.deepEqual(round([idle('a1', { limit: { text: 'limit reached', at } })], at + 60_000, held), []);
  assert.deepEqual(held, ['a1:one', 'a1:two']);
  assert.deepEqual(texts('a1'), ['[quota] one', '[quota] two']);
  assert.deepEqual(round([idle('a1', { limit: { text: 'limit reached', at } })], at + 120_000, held), []);
  assert.equal(held.length, 2, 'held once');
  release('a1');
  // told to go on: the stop is cleared by the new prompt, the queue goes out again
  assert.deepEqual(round([idle('a1', { statusSince: at + 200_000 })], at + 300_000), ['a1:one']);
});

test('the quota reset: each stopped turn is reported once, with its held orders', () => {
  const a = agent('a1');
  enqueue('a1', 'one', 'master', a);
  const at = Date.now() + 1000;
  const resetsAt = at + 3_600_000;
  const u = idle('a1', { name: 'agentmcp', limit: { text: 'limit reached', at }, quota: { resetsAt } });
  round([u], at + 10_000);
  assert.deepEqual(quotaWatch([u], null, at + 10_000), []);
  assert.deepEqual(quotaStops(at + 10_000), [{ agentId: 'a1', at, resetsAt, back: false }]);
  reloadQueues(); // remembered over a restart
  // the reading rolled over: no reset time in it any more, the one noted counts
  const after = { ...u, quota: { resetsAt: 0 } };
  assert.deepEqual(quotaWatch([after], null, resetsAt + 10_000), [], 'a minute of margin');
  assert.deepEqual(quotaWatch([after], null, resetsAt + 120_000), [{ agentId: 'a1', name: 'agentmcp', resetsAt, held: 1 }]);
  assert.deepEqual(quotaWatch([after], null, resetsAt + 180_000), [], 'once');
  assert.equal(quotaStops(resetsAt + 180_000)[0].back, true);
  // the notice to the master: ask the user first, then fleet_requeue
  const note = quotaBackNotice({ agentId: 'a1b2c3d4-0000', name: 'agentmcp', resetsAt, held: 1 });
  assert.match(note, /agentmcp/);
  assert.match(note, /fleet_requeue/);
  assert.match(note, /fleet_send/);
  assert.doesNotMatch(quotaBackNotice({ agentId: 'a1b2c3d4-0000', name: 'agentmcp', resetsAt, held: 0 }), /fleet_requeue/);
  // it went on: forgotten
  quotaWatch([idle('a1', { status: 'busy' })], null, resetsAt + 200_000);
  assert.deepEqual(quotaStops(resetsAt + 200_000), []);
});

test('the reset time comes from the usage reading when the unit has none, and a dismissed stop is not listed', () => {
  const at = Date.now();
  const u = idle('a1', { limit: { text: 'limit reached', at } });
  assert.deepEqual(quotaWatch([u], null, at + 1000), []);
  assert.equal(quotaStops(at + 1000)[0].resetsAt, 0);
  quotaWatch([u], { resetsAt: at + 600_000 }, at + 2000);
  assert.equal(quotaStops(at + 2000)[0].resetsAt, at + 600_000);
  // a stop found long after it happened (a session resumed days later): today's reset is not its reset
  const stale = idle('z9', { limit: { text: 'limit reached', at: at - 86_400_000 }, quota: { resetsAt: at + 600_000 } });
  quotaWatch([u, stale], null, at + 2500);
  assert.equal(quotaStops(at + 2500).find((x) => x.agentId === 'z9').resetsAt, 0);
  assert.equal(dismissQuota('a1'), true);
  assert.deepEqual(quotaStops(at + 3000).map((x) => x.agentId), ['z9']);
  assert.deepEqual(quotaWatch([u, stale], null, at + 700_000), [], 'nor reported to the master');
  assert.equal(dismissQuota('nobody'), false);
});

test('a queue file written before holds existed still loads', () => {
  fs.writeFileSync(FILE, JSON.stringify({ a1: [{ text: 'old', at: T0 }] }));
  reloadQueues();
  assert.deepEqual(texts('a1'), ['old']);
  assert.deepEqual(round([idle('a1')], T0 + 6000), ['a1:old']);
});
