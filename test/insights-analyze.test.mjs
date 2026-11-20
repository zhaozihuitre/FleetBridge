// Self-improvement: the rules' detectors, the proposal store (dedup, cool-down, decisions), and an analysis
// with a stand-in model (what it is sent is redacted; what it can't back up is dropped).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { removeTree } from './_fs.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-insights-'));
process.env.MONITOR_DATA_DIR = tmp;
const { detect } = await import('../server/insights/detectors.js');
const { createStore, similar, allowed } = await import('../server/insights/proposals.js');
const { analyze, parseModel, digest } = await import('../server/insights/analyze.js');
const { due } = await import('../server/insights/improve.js');
const { collect, sessionSignals, userMessages } = await import('../server/insights/collect.js');
const { logEvent, readEvents } = await import('../server/insights/events.js');
after(() => removeTree(tmp));

const NOW = Date.parse('2026-11-20T04:00:00Z');
const DAY = 86_400_000;
const ev = (type, minsAgo, f = {}) => ({ at: NOW - minsAgo * 60_000, type, ...f });
const empty = () => ({ now: NOW, since: NOW - 14 * DAY, days: 14, events: [], orders: [], masterSays: [], sessions: [] });

test('nothing over the thresholds: no findings', () => {
  assert.deepEqual(detect(empty()), []);
  const d = empty();
  d.events = [ev('notice.done', 50, { cut: true, agentId: 'a' }), ev('tool.read_reply', 49, { agentId: 'a' })];
  assert.deepEqual(detect(d), []);
});

test('each detector finds its signal', () => {
  const d = empty();
  for (let i = 0; i < 6; i++) d.events.push(ev('notice.done', 600 - i * 60, { cut: true, agentId: 'a1', agent: 'web', len: 4000 }), ev('tool.read_reply', 598 - i * 60, { agentId: 'a1', agent: 'web' }));
  for (let i = 0; i < 12; i++) d.events.push(ev('tool.read_screen', 300 - i, { agentId: 'a2', agent: 'api' }));
  d.events.push(ev('order.resent', 30, { reason: 'sent', agent: 'x' }), ev('order.blocked', 20, { reason: 'dialog', agent: 'x' }), ev('notice.never_ran', 10, { agent: 'x' }));
  for (let i = 0; i < 6; i++) d.events.push(ev('permit.wait', 100 + i, { agent: 'api', text: 'Bash(npm install)', waitMs: 120_000 }));
  for (let i = 0; i < 4; i++) d.events.push(ev('order.correction', 200 + i, { agent: 'web', agentId: 'a1', by: 'terminal', afterMs: 30_000 }));
  d.masterSays = ['结果呢', '汇总一下', '然后呢', '继续', '好了吗'].map((t, i) => ({ at: NOW - i * 60_000, text: t }));
  d.orders = [1, 2, 3].map((i) => ({ at: NOW - i * DAY, kind: 'sent', via: 'cc', name: 'web', text: '跑一遍测试并修复失败的用例' }));
  d.sessions = [
    { sessionId: 's1', name: 'web', toolCalls: 50, stopHooks: 6, interrupts: 5, typed: [], toolErrors: [1, 2, 3].map((i) => ({ at: NOW - i * 1000, tool: 'Bash', arg: 'ls -la', error: "'ls' is not recognized as an internal command" })) },
    { sessionId: 's2', name: 'api', toolCalls: 40, stopHooks: 6, interrupts: 4, typed: [], toolErrors: [1, 2].map((i) => ({ at: NOW - i * 1000, tool: 'Bash', arg: 'ls', error: "'ls' is not recognized as an internal command" })) },
  ];
  const kinds = new Set(detect(d).map((f) => f.detector));
  for (const k of ['cut-then-read', 'master-followups', 'read-screen-heavy', 'order-not-taken', 'permit-wait', 'manual-corrections', 'repeated-order', 'tool-error', 'interrupts', 'stop-hooks']) assert.ok(kinds.has(k), `${k} not found`);
  for (const f of detect(d)) {
    assert.ok(f.fingerprint && f.title && f.finding && f.change && f.benefit && f.risk, f.detector);
    assert.ok(['S', 'M', 'L'].includes(f.effort));
    assert.ok(f.evidence.length >= 1, `${f.detector} has evidence`);
  }
});

test('store: the same problem is one proposal; a rejected one never comes back unless 3x worse (once)', () => {
  const s = createStore(path.join(tmp, 'p1.json'));
  const c = { fingerprint: 'cut-then-read', title: '完成通知截断后主控总要再读全文', finding: 'f', change: 'c', benefit: 'b', effort: 'S', risk: 'r', evidence: [{ ref: 'x' }], count: 5 };
  const r1 = s.merge([c], NOW);
  assert.equal(r1.added.length, 1);
  assert.equal(r1.added[0].id, 'P-001');
  const r2 = s.merge([{ ...c, count: 9 }], NOW + 1);
  assert.equal(r2.added.length, 0);
  assert.equal(s.get('P-001').count, 9);
  // a different fingerprint but nearly the same title: the same proposal
  assert.equal(s.merge([{ ...c, fingerprint: 'model:x', title: '完成通知截断后，主控总要再读全文' }], NOW).added.length, 0);
  s.setStatus('P-001', 'rejected', 'user', { decision: { action: 'reject', note: '不需要' } });
  assert.equal(s.merge([{ ...c, count: 20 }], NOW + 2).added.length, 0, 'not 3x worse than 9');
  const back = s.merge([{ ...c, count: 30 }], NOW + 3);
  assert.equal(back.added.length, 1, '3x worse: once more');
  assert.match(back.added[0].finding, /P-001 曾被拒绝：不需要/);
  assert.equal(s.merge([{ ...c, fingerprint: 'cut-then-read', count: 90 }], NOW + 4).added.length, 0, 'only once');
  // survives a restart
  assert.equal(createStore(path.join(tmp, 'p1.json')).list().length, 2);
});

test('store: later wakes after 7 days; installed quiet for 30; the buttons per status', () => {
  const s = createStore(path.join(tmp, 'p2.json'));
  const a = s.merge([{ fingerprint: 'a', title: 'aaa 一', evidence: [] }], NOW).added[0];
  s.setStatus(a.id, 'later', 'user', {}, NOW);
  assert.equal(s.wake(NOW + 6 * DAY), 0);
  assert.equal(s.wake(NOW + 7 * DAY), 1);
  assert.equal(s.get(a.id).status, 'new');
  const b = s.merge([{ fingerprint: 'b', title: '完全不同的东西', evidence: [] }], NOW).added[0];
  s.setStatus(b.id, 'installed', 'system', {}, NOW);
  assert.equal(s.merge([{ fingerprint: 'b', title: '完全不同的东西', evidence: [] }], NOW + 10 * DAY).skipped[0].why, 'installed-recently');
  assert.deepEqual(allowed('new'), ['approve', 'reject', 'later']);
  assert.deepEqual(allowed('built'), ['install', 'discard']);
  assert.deepEqual(allowed('installed'), ['rollback']);
  assert.deepEqual(allowed('rejected'), []);
  assert.ok(similar('完成通知截断', '完成通知截断了') > 0.6);
  assert.ok(similar('完成通知截断', '授权久等') < 0.2);
});

test('analysis: the model gets only redacted data, its unbacked proposals are dropped, the rules\' stay', async () => {
  const d = empty();
  for (let i = 0; i < 6; i++) d.events.push(ev('notice.done', 600 - i * 60, { cut: true, agentId: 'a1', agent: 'web' }), ev('tool.read_screen', 598 - i * 60, { agentId: 'a1', agent: 'web' }));
  d.masterSays = [{ at: NOW - 1000, text: '用这个 token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 推一下，邮箱 bob@corp.example 密码 password=Hunter22!' }];
  d.orders = [{ at: NOW - 5000, kind: 'sent', via: 'master', name: 'web', text: 'export API_KEY=sk-ant-api03-SECRETSECRET123 然后部署' }];
  const store = createStore(path.join(tmp, 'p3.json'));
  let sent = '';
  const runModel = async (prompt) => {
    sent = prompt;
    const masterRef = prompt.match(/"ref":"(master:[^"]+)"/)[1];
    return `好的：[{"title":"截断上限提高并保留汇报块","basis":"cut-then-read","finding":"62%","evidence":[{"metric":"cut_then_read_rate","value":"100%"}],"change":"turns.js","benefit":"省一次调用","effort":"S","risk":"低"},
      {"title":"编造的提案","basis":"model:made-up","finding":"x","evidence":[{"ref":"master:1999-01-01 00:00"}],"change":"x","benefit":"x","effort":"S","risk":"x"},
      {"title":"主控派单附带验收标准","basis":"model:order-template","finding":"y","evidence":[{"ref":"${masterRef}","quote":"…"}],"change":"GUIDE","benefit":"少返工","effort":"S","risk":"低"}]`;
  };
  const r = await analyze({ data: d, store, settings: { llm: true, model: 'claude-sonnet-5-5' }, runModel, redact: { home: 'C:\\Users\\bob', user: 'bob', secrets: [] }, now: NOW });
  for (const s of ['ghp_abcdefghij', 'bob@corp.example', 'Hunter22!', 'sk-ant-api03-SECRET']) assert.ok(!sent.includes(s), `${s} was sent to the model`);
  assert.equal(r.model, 'used');
  const titles = store.list().map((p) => p.title);
  assert.ok(titles.includes('截断上限提高并保留汇报块'));
  assert.ok(titles.includes('主控派单附带验收标准'));
  assert.ok(!titles.includes('编造的提案'), 'no evidence that was in the input: dropped');
  assert.equal(store.list().find((p) => p.title === '截断上限提高并保留汇报块').fingerprint, 'cut-then-read');
  assert.equal(store.lastAnalysis().model, 'used');
});

test('analysis: model off → never called; model failing → the rules\' proposals', async () => {
  const d = empty();
  for (let i = 0; i < 12; i++) d.events.push(ev('tool.read_screen', 300 - i, { agentId: 'a2', agent: 'api' }));
  let called = 0;
  const s1 = createStore(path.join(tmp, 'p4.json'));
  const r1 = await analyze({ data: d, store: s1, settings: { llm: false }, runModel: async () => (called++, '[]'), now: NOW });
  assert.equal(called, 0);
  assert.equal(r1.model, 'off');
  assert.equal(r1.added.length, 1);
  const s2 = createStore(path.join(tmp, 'p5.json'));
  const r2 = await analyze({ data: d, store: s2, settings: { llm: true }, runModel: async () => 'not json at all', now: NOW });
  assert.equal(r2.model, 'failed');
  assert.equal(r2.added[0].source, 'rules');
});

test('parseModel keeps only evidence that was given', () => {
  const allowedRefs = { refs: new Set(['order:2026-11-19 10:00 web']), metrics: new Set(['count:notice.done']), fingerprints: new Set() };
  const out = parseModel('[{"title":"t","basis":"weird basis!","evidence":[{"ref":"order:2026-11-19 10:00 web"},{"ref":"nope"},{"metric":"count:notice.done","value":"3"}],"effort":"XL"}]', allowedRefs);
  assert.equal(out.length, 1);
  assert.equal(out[0].evidence.length, 2);
  assert.equal(out[0].effort, 'M');
  assert.match(out[0].fingerprint, /^model:/);
  assert.throws(() => parseModel('no array', allowedRefs));
});

test('the schedule: daily slot, enough turns, never twice within 6 hours, off is off', () => {
  const s = { enabled: true, hour: 12, minute: 30, minTurns: 30 };
  const at = (h, m) => new Date(2026, 10, 20, h, m).getTime();
  assert.equal(due(at(12, 31), { at: at(9, 0) - DAY }, s, 0), true);
  assert.equal(due(at(12, 0), { at: at(0, 0) - DAY }, s, 0), false, 'before the slot');
  assert.equal(due(at(12, 31), { at: at(12, 30) + 0 }, s, 0), false, 'ran at the slot');
  assert.equal(due(at(20, 0), { at: at(12, 40) }, s, 40), true, 'enough turns');
  assert.equal(due(at(14, 0), { at: at(12, 40) }, s, 40), false, 'within 6 hours');
  assert.equal(due(at(12, 31), null, { ...s, enabled: false }, 99), false);
});

test('collect: events, orders, the master\'s own words, an agent\'s failed tool calls', () => {
  const dir = path.join(tmp, 'collect');
  fs.mkdirSync(dir, { recursive: true });
  const t = (ms) => new Date(NOW - ms).toISOString();
  fs.writeFileSync(path.join(dir, 'events.jsonl'), [ev('tool.read_screen', 5, { agentId: 'sA' }), { at: NOW - 30 * DAY, type: 'old' }].map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'orders.jsonl'), JSON.stringify({ at: NOW - 1000, kind: 'sent', agentId: 'sA', name: 'web', text: 'do it' }) + '\n');
  const master = path.join(dir, 'master.jsonl');
  fs.writeFileSync(master, [
    { type: 'user', timestamp: t(5000), message: { content: '结果呢' } },
    { type: 'user', timestamp: t(4000), message: { content: '【舰桥通知】✅ 完成：…' } },
    { type: 'user', timestamp: t(3000), isMeta: true, message: { content: 'Stop hook feedback: x' } },
  ].map((e) => JSON.stringify(e)).join('\n'));
  const agent = path.join(dir, 'a.jsonl');
  fs.writeFileSync(agent, [
    { type: 'assistant', timestamp: t(900), message: { content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', timestamp: t(800), message: { content: [{ type: 'tool_result', tool_use_id: 'u1', is_error: true, content: "'ls' is not recognized" }] } },
    { type: 'user', timestamp: t(700), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    { type: 'user', timestamp: t(600), message: { content: '换个方法' } },
  ].map((e) => JSON.stringify(e)).join('\n'));
  const data = collect({ now: NOW, days: 14, dataDir: dir, masterSession: 'M', transcriptOf: (id) => ({ M: master, sA: agent })[id] || null });
  assert.equal(data.events.length, 1);
  assert.equal(data.orders.length, 1);
  assert.deepEqual(data.masterSays.map((m) => m.text), ['结果呢']);
  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0].toolErrors[0].tool, 'Bash');
  assert.equal(data.sessions[0].interrupts, 1);
  assert.deepEqual(data.sessions[0].typed.map((m) => m.text), ['换个方法']);
  assert.equal(userMessages([], 0).length, 0);
  assert.equal(sessionSignals([], 0).toolCalls, 0);
});

test('events: written only while the feature is on, read back by time', () => {
  const f = path.join(tmp, 'ev.jsonl');
  logEvent('x.one', { agent: 'a', text: 'y'.repeat(500) }, { file: f, force: true, now: NOW - 1000 });
  logEvent('x.two', {}, { file: f, force: true, now: NOW });
  const all = readEvents(0, f);
  assert.equal(all.length, 2);
  assert.ok(all[0].text.length <= 160);
  assert.equal(readEvents(NOW - 10, f).length, 1);
  void digest;
});
