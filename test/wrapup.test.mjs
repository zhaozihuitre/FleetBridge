// Wrap-up (improvement P-010, server/wrapup.js): the idle terminals of ours ended in one go. Which ones count
// as idle with nothing owed, which are passed over and why, and the master's tool (fleet_close) that lists
// first and only ends with confirm: true.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JUST_ORDERED, busyReason, wrapupPlan } from '../server/wrapup.js';

const T0 = Date.parse('2026-11-20T06:23:00Z');
const agent = (id, o = {}) => ({ id, kind: 'claude', name: id, cwd: `C:/work/${id}`, alive: true, queue: [], masterTurn: false, waiting: null, orderedAt: null, ...o });
const unit = (agentId, o = {}) => ({ agentId, status: 'idle', statusSince: T0 - 60_000, permission: null, ...o });

test('idle terminals with nothing owed are ended; shells and ended ones are not part of it', () => {
  const agents = [agent('kumi-mgr'), agent('kumi-staff'), agent('p001-a'), agent('p001-b'), agent('sh', { kind: 'shell' }), agent('old', { alive: false })];
  const plan = wrapupPlan({ agents, units: agents.map((a) => unit(a.id)), now: T0 });
  assert.deepEqual(plan.close.map((x) => x.id), ['kumi-mgr', 'kumi-staff', 'p001-a', 'p001-b']);
  assert.deepEqual(plan.skip, []);
  assert.deepEqual(plan.close[0], { id: 'kumi-mgr', name: 'kumi-mgr', project: 'kumi-mgr', unseen: false });
});

test('a terminal with something going on or owed is passed over, with the reason', () => {
  const agents = [
    agent('busy'),
    agent('permit'),
    agent('question'),
    agent('starting'),
    agent('trust', { waiting: { trust: true, text: 'Do you trust this folder?', options: [] } }),
    agent('fresh', { orderedAt: T0 - 3000 }),
    agent('queued', { queue: [{ text: 'next', at: T0 - 1000 }] }),
    agent('held', { queue: [{ text: 'old', at: T0 - 9e6, held: 'closed' }] }),
    agent('owes', { masterTurn: true }),
    agent('free'),
  ];
  const units = [
    unit('busy', { status: 'busy' }),
    unit('permit', { permission: { message: 'Bash', prompt: { kind: 'permission', options: [] } } }),
    unit('question', { permission: { message: '?', prompt: { kind: 'question', options: [] } } }),
    unit('fresh'),
    unit('queued'),
    unit('held'),
    unit('owes'),
    unit('free'),
  ];
  const plan = wrapupPlan({ agents, units, now: T0 });
  assert.deepEqual(plan.close.map((x) => x.id), ['free']);
  assert.deepEqual(Object.fromEntries(plan.skip.map((x) => [x.id, x.reason])), {
    busy: 'working',
    permit: 'needs-approval',
    question: 'needs-answer',
    starting: 'starting',
    trust: 'needs-answer',
    fresh: 'just-ordered',
    queued: 'queued',
    held: 'queued',
    owes: 'unreported',
  });
});

test('an order typed in a moment ago counts as work even while the status still says idle', () => {
  const a = agent('a1', { orderedAt: T0 });
  assert.equal(busyReason(a, unit('a1'), T0 + JUST_ORDERED - 1), 'just-ordered');
  assert.equal(busyReason(a, unit('a1'), T0 + JUST_ORDERED), null);
});

test('a result nobody looked at yet is said, and does not keep the terminal', () => {
  const plan = wrapupPlan({ agents: [agent('a1'), agent('a2')], units: [unit('a1', { seenAt: T0 - 120_000 }), unit('a2', { seenAt: T0 - 1000 })], now: T0 });
  assert.deepEqual(plan.close.map((x) => [x.id, x.unseen]), [['a1', true], ['a2', false]]);
});

test('a selection: only those are considered, and what is not a live Claude terminal is never ended', () => {
  const agents = [agent('a1'), agent('a2'), agent('a3', { queue: [{ text: 'x', at: T0 }] }), agent('sh', { kind: 'shell' }), agent('old', { alive: false })];
  const plan = wrapupPlan({ agents, units: agents.map((a) => unit(a.id)), only: ['a1', 'a3', 'sh', 'old', 'nobody', 'a1'], now: T0 });
  assert.deepEqual(plan.close.map((x) => x.id), ['a1']);
  assert.deepEqual(plan.skip.map((x) => [x.id, x.reason]), [['a3', 'queued'], ['sh', 'not-claude'], ['old', 'gone'], ['nobody', 'gone']]);
});

// ---- the master's tool, against a stand-in for the local API ----
const calls = [];
const live = [agent('kumi-mgr'), agent('kumi-staff'), agent('worker')];
const liveUnits = [unit('kumi-mgr'), unit('kumi-staff'), unit('worker', { status: 'busy' })];
const api = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    let out = {};
    if (req.url === '/api/state') out = { agents: live, units: liveUnits };
    else if (req.url === '/api/agents/wrapup') {
      calls.push(body);
      const plan = wrapupPlan({ agents: live, units: liveUnits, only: body.ids || null, now: T0 });
      out = body.dry ? { ok: true, dry: true, ...plan } : { ok: plan.close.length > 0, closed: plan.close, skip: plan.skip };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
process.env.FLEET_URL = `http://127.0.0.1:${api.address().port}`;
const { TOOLS } = createRequire(import.meta.url)('../server/fleet-mcp.cjs');
const close = TOOLS.find((t) => t.name === 'fleet_close');
after(() => api.close());

test('fleet_close without confirm only lists: what would be ended, what is skipped and why', async () => {
  calls.length = 0;
  const s = await close.run({});
  assert.deepEqual(calls, [{ dry: true, via: 'master' }]);
  assert.match(s, /would end \(2\): kumi-mgr \[kumi-mgr\], kumi-staff \[kumi-sta\]/);
  assert.match(s, /skipped \(1\): worker \[worker\]: working/);
  assert.match(s, /Nothing was ended yet.*confirm: true/);
});

test('fleet_close with confirm ends them in one call; named agents are resolved to ids', async () => {
  calls.length = 0;
  assert.match(await close.run({ agents: ['idle'], confirm: true }), /^ended \(2\): kumi-mgr .*\nskipped \(1\): worker/);
  assert.deepEqual(calls, [{ dry: false, via: 'master' }]);
  calls.length = 0;
  const s = await close.run({ agents: ['#kumi-staff', 'worker'], confirm: true });
  assert.deepEqual(calls, [{ ids: ['kumi-staff', 'worker'], dry: false, via: 'master' }]);
  assert.match(s, /^ended \(1\): kumi-staff/);
  assert.match(s, /skipped \(1\): worker \[worker\]: working/);
  await assert.rejects(close.run({ agents: ['nobody-here'], confirm: true }), /no live agent matches/);
});

test('the master knows the tool: allowed without asking, in its guide, and the older default guide is replaced', async () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(dir, '..', 'server', 'master.js'), 'utf8');
  assert.match(src.match(/const ALLOWED = \[(.*?)\]/)[1], /'fleet_close'/);
  process.env.MONITOR_DATA_DIR ||= fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'fleet-wrapup-'));
  const { GUIDE, OLD_GUIDES } = await import('../server/master.js');
  assert.match(GUIDE, /收工：.*fleet_close.*不要给每个终端逐条派「\/exit」/);
  assert.ok(!OLD_GUIDES.includes(GUIDE));
  // the defaults around it are known as old: without wrap-up (before P-010), and with it but without P-008's lines
  const noP8 = GUIDE.replace(/^- (只读调查|密钥)：.*\n/gm, '');
  assert.ok(OLD_GUIDES.includes(noP8.replace(/^- 收工：.*\n/m, '')), 'the default before this one is known as old');
  assert.ok(OLD_GUIDES.includes(noP8), 'the wrap-up default (before P-008) is known as old');
});
