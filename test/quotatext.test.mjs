// When a quota resets, as the page (web/quotafmt.js) and the notices (server/quotatext.js) say it: local time
// with its day, the last hour counting down; the limit holding things back picked out.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { removeTree } from './_fs.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-test-'));
process.env.MONITOR_DATA_DIR = tmp;
after(() => removeTree(tmp));
const { quotaText, tightest } = await import('../web/quotafmt.js');
const { resetText, whenText, gatingLimit } = await import('../server/quotatext.js');
const { doneNotice } = await import('../server/master.js');

// the page's translator: Chinese with {0}, {1} filled in
const L = (s, ...a) => s.replace(/\{(\d)\}/g, (_, i) => a[i]);
const QT = quotaText(L);
const at = (d, h, m) => new Date(2026, 10, d, h, m).getTime(); // local time, November 2026
const NOW = at(20, 12, 45);
const MIN = 60_000;

test('page: today, tomorrow, a later day, in local time', () => {
  assert.equal(QT.resetText(at(20, 18, 10), NOW), '今天 18:10 重置');
  assert.equal(QT.resetText(at(21, 9, 0), NOW), '明天 09:00 重置');
  assert.equal(QT.resetText(at(23, 13, 0), NOW), '11/23 13:00 重置');
});

test('page: the last hour counts down; past or not started', () => {
  assert.equal(QT.resetText(at(20, 13, 10), NOW), '还有 25 分钟 · 13:10 重置');
  assert.equal(QT.resetText(NOW + 59 * MIN + 30_000, NOW), '还有 60 分钟 · 13:44 重置');
  assert.equal(QT.resetText(NOW + 20_000, NOW), '还有 1 分钟 · 12:45 重置');
  assert.equal(QT.resetText(NOW - 1000, NOW), '即将重置');
  assert.equal(QT.resetText(0, NOW), '未开始');
  assert.equal(QT.resetText(undefined, NOW), '未开始');
});

test('page: a limit in a line, and the tightest of them', () => {
  const five = { key: 'session', label: '5 小时', usedPct: 69.4, resetsAt: at(20, 13, 10) };
  const week = { key: 'weekly_all', label: '本周 · 所有模型', usedPct: 45, resetsAt: at(23, 13, 0) };
  assert.equal(QT.limitLine(five, NOW), '5 小时 69% · 还有 25 分钟 · 13:10 重置');
  assert.equal(QT.limitLine(week, NOW), '本周 · 所有模型 45% · 11/23 13:00 重置');
  assert.equal(tightest([five, week]), five, 'the most used');
  assert.equal(tightest([five, { ...week, active: true }]).key, 'weekly_all', 'the one gating now first');
  assert.equal(tightest([]), null);
});

test('server: the same words (Chinese by default)', () => {
  assert.equal(resetText(at(20, 18, 10), NOW), '今天 18:10 重置');
  assert.equal(resetText(at(23, 13, 0), NOW), '11/23 13:00 重置');
  assert.equal(resetText(at(20, 13, 10), NOW), '还有 25 分钟 · 13:10 重置');
  assert.equal(whenText(at(21, 9, 5), NOW), '明天 09:05');
  const limits = [
    { key: 'session', label: '5 小时', usedPct: 100, resetsAt: at(20, 13, 10), active: true },
    { key: 'weekly_all', label: '本周', usedPct: 45, resetsAt: at(23, 13, 0) },
    { key: 'x', label: '过期', usedPct: 99, resetsAt: NOW - MIN },
  ];
  assert.equal(gatingLimit(limits, NOW).key, 'session');
  assert.equal(gatingLimit([limits[2]], NOW), null, 'a window already past is no reset to tell');
});

test('the master\'s quota notice says when it resets', () => {
  const x = { agentId: 'abcdef0123456789', name: 'web', text: '跑测试', ms: 60_000, error: "You've hit your limit · resets 1pm", resetsAt: Date.now() + 3 * 3_600_000, resetLabel: '5 小时' };
  const s = doneNotice(x);
  assert.match(s, /额度到限/);
  assert.match(s, /额度重置：5 小时 · (今天|明天) \d\d:\d\d 重置。/);
  assert.doesNotMatch(doneNotice({ ...x, resetsAt: 0 }), /额度重置：/);
});
