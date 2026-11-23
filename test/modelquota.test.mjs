// A terminal's quota by its model (server/modelquota.js): the general limits plus its model's own weekly one,
// and, when its model has none in the reading, why: it has none, or the usage API (the only source of
// per-model limits: the status line gives the 5-hour and all-models ones) was never read.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelName, modelQuota } from '../server/modelquota.js';
import { quotaText } from '../web/quotafmt.js';

const L = (s, ...a) => s.replace(/\{(\d)\}/g, (_, i) => a[i]);
const general = [
  { key: 'session', label: '5 小时', usedPct: 64, resetsAt: 1795428600000 },
  { key: 'weekly_all', label: '本周 · 所有模型', usedPct: 11, resetsAt: 1796014800000 },
];
const fable = { key: 'weekly_scoped:Fable', label: '本周 · Fable', usedPct: 71, resetsAt: 1796000000000 };

test('a model id gives its short name, whatever the model', () => {
  assert.equal(modelName('claude-fable-5-2'), 'Fable 5.2');
  assert.equal(modelName('claude-fable-5-2[1m]'), 'Fable 5.2');
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.equal(modelName('claude-newmodel-7'), 'Newmodel 7');
});

test('a model with its own weekly limit: it counts, and nothing is said about a missing one', () => {
  const q = modelQuota('claude-fable-5-2[1m]', [...general, fable], { api: { at: 1, error: null } });
  assert.equal(q.key, 'weekly_scoped:Fable');
  assert.deepEqual(q.all.map((l) => l.key), ['session', 'weekly_all', 'weekly_scoped:Fable']);
  assert.equal(q.ownNote, null);
  // another model does not count Fable's
  const o = modelQuota('claude-opus-5-5', [...general, fable], { api: { at: 1, error: null } });
  assert.deepEqual(o.all.map((l) => l.key), ['session', 'weekly_all']);
  assert.deepEqual(o.ownNote, { name: 'Opus 5.5', reason: 'none', error: null });
});

test('the usage API never read (403): its own limit is "not known", with the error, not left out', () => {
  const q = modelQuota('claude-fable-5-2', general, { api: { at: null, error: 'http_403' } });
  assert.equal(q.key, 'session'); // the tightest general one still holds it
  assert.deepEqual(q.ownNote, { name: 'Fable 5.2', reason: 'unread', error: 'http_403' });
  const QT = quotaText(L);
  assert.equal(QT.ownText(q.ownNote), '本周 · Fable 5.2：读不到（额度接口 http_403）');
  assert.equal(QT.ownText({ name: 'Opus 5.5', reason: 'none' }), '本周 · Opus 5.5：无单独额度');
  assert.equal(QT.ownText(null), '');
});

test('read once and failing now: the last per-model value stays and counts', () => {
  const q = modelQuota('claude-fable-5-2', [...general, fable], { api: { at: 1000, error: 'http_403' } });
  assert.equal(q.key, 'weekly_scoped:Fable');
  assert.equal(q.ownNote, null);
});

test('the tool says it too: fleet_status names the missing limit and why', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../server/fleet-mcp.cjs', import.meta.url), 'utf8');
  assert.match(src, /weekly limit of its own: not known \(the usage API answers/);
  assert.match(src, /\$\{ownLimit\(u\.quota\)\}/);
});
