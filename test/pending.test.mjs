// The 待决定 list (server/pending.js): what the user still owes an answer to, from the four sources (a terminal's
// report, a dialog nobody answered, the master's own questions, Fleet Bridge's own), merged when asked again,
// kept across restarts, and the master's three tools (server/fleet-mcp.cjs) against a stand-in for the local API.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { removeTree } from './_fs.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-pending-'));
process.env.MONITOR_DATA_DIR = tmp;
after(() => removeTree(tmp));
const { DIALOG_AFTER, answerText, createStore, parseNeeds, pendingView, systemItems } = await import('../server/pending.js');

const T0 = Date.parse('2026-11-24T02:00:00Z');
const clock = (t = T0) => {
  const c = { t, now: () => c.t };
  return c;
};

// ---- S1: a terminal's report ----

const REPORT = `**结论**：做完了。

**改了什么**
- server/x.js

**需要你决定的点**（括号里是我的推荐）
1. 名字（「待决定」）
2. 要不要推送到 GitHub？（建议先不推）
3. 验证码登录失败时：A. 回退到密码登录 B. 直接报错

**文档路径**：C:\\x.html`;

test('S1: a report\'s "needs the user" section gives one item per list entry, with options and the suggestion', () => {
  const n = parseNeeds(REPORT);
  assert.deepEqual(n.map((x) => x.text), ['名字（「待决定」）', '要不要推送到 GitHub？（建议先不推）', '验证码登录失败时：A. 回退到密码登录 B. 直接报错']);
  assert.deepEqual(n[1].options.map((o) => o.label), ['是', '否']);
  assert.equal(n[1].suggestion, '先不推');
  assert.deepEqual(n[2].options, [{ key: 'A', label: '回退到密码登录' }, { key: 'B', label: '直接报错' }]);
  assert.equal(n[2].kind, 'decide'); // it has choices, though it speaks of a login
  // a label ends at a bracket; a suggestion by letter names its option
  const [x] = parseNeeds('**需要你决定**\n- 同步失败时：A. 自动重试三次 B. 立刻提醒用户（建议 A）');
  assert.deepEqual(x.options.map((o) => o.label), ['自动重试三次', '立刻提醒用户']);
  assert.equal(x.suggestion, 'A. 自动重试三次');
});

test('S1: the other ways a report says it — 【需要用户配合】, a bullet list with sub-items, "无", no section', () => {
  assert.deepEqual(parseNeeds('【目标】x\n【需要用户配合】无。\n【汇报格式】y'), []);
  const sub = parseNeeds('**还需要用户做的事**\n- 在手机上扫码登录\n  - 入口：设置页\n- 同意后就地更新\n\n别的话。');
  assert.equal(sub.length, 2);
  assert.match(sub[0].text, /扫码登录\n- 入口：设置页/);
  assert.equal(sub[0].kind, 'do');
  assert.deepEqual(parseNeeds('**需要用户配合**：请在 Google Cloud 建一个 OAuth 客户端').map((x) => x.text), ['请在 Google Cloud 建一个 OAuth 客户端']);
  // no section: the summary's one sentence, or nothing
  assert.deepEqual(parseNeeds('都好了。', '要不要推送 0.9.27？').map((x) => x.text), ['要不要推送 0.9.27？']);
  assert.deepEqual(parseNeeds('都好了。', ''), []);
});

test('S1: a turn seen by both paths is one item; asked again in a later turn it is merged; not asked again: stale', () => {
  const c = clock();
  const s = createStore({ now: c.now });
  const who = { agentId: 'a1', agentName: 'mdlinkapp', sessionId: 's1', project: 'mdlinkapp', cwd: 'E:/p/mdlinkapp' };
  const ids = s.fromReport({ ...who, turnAt: T0, order: '做 X', reply: REPORT });
  assert.deepEqual(ids, ['Q-1', 'Q-2', 'Q-3']);
  // the notices see the same turn a few seconds later
  assert.deepEqual(s.fromReport({ ...who, turnAt: T0 + 4000, order: '做 X', reply: REPORT }), ids);
  assert.equal(s.get('Q-2').seen, 1);
  // a later turn asks two of them again
  c.t += 3_600_000;
  const later = s.fromReport({ ...who, turnAt: c.t, order: '继续', reply: '**需要你决定的点**\n- 要不要推送到 GitHub？\n- 名字（「待决定」）' });
  assert.deepEqual(later, ['Q-2', 'Q-1']);
  assert.equal(s.get('Q-2').seen, 2);
  assert.equal(s.get('Q-2').at, T0); // when it was first asked
  assert.equal(s.get('Q-3').stale, true); // the later report did not ask it: marked, not closed
  assert.equal(s.get('Q-3').status, 'open');
  // a short answer between, with no section, says nothing about them
  s.fromReport({ ...who, turnAt: c.t + 600_000, order: '提交', reply: '提交了。' });
  assert.equal(s.get('Q-1').stale, false);
  // the report is kept with the item (the page shows it), not sent with every state
  assert.match(s.get('Q-1').refs[0].report, /需要你决定的点/);
  assert.equal(pendingView(s.items(), [], c.t).open[0].refs[0].report, undefined);
});

// ---- S2: a dialog nobody answered ----

test('S2: a dialog is listed after 2 minutes; gone from the screen it is answered (terminal alive) or expired', () => {
  const c = clock();
  const s = createStore({ now: c.now });
  const d = (key, agentId) => ({ dialogKey: key, at: T0, agentId, agentName: agentId, project: 'p', text: 'Allow Bash: git push?', options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }] });
  s.syncDialogs([d('k1', 'a1'), d('k2', 'a2')]);
  assert.equal(s.items().length, 0); // the master usually answers within seconds
  c.t = T0 + DIALOG_AFTER;
  s.syncDialogs([d('k1', 'a1'), d('k2', 'a2')]);
  assert.deepEqual(s.items().map((x) => [x.id, x.source, x.status]), [['Q-1', 'dialog', 'open'], ['Q-2', 'dialog', 'open']]);
  s.syncDialogs([d('k1', 'a1'), d('k2', 'a2')]); // read again: no duplicates
  assert.equal(s.items().length, 2);
  c.t += 5000;
  s.syncDialogs([], (id) => id === 'a1');
  assert.equal(s.get('Q-1').status, 'answered');
  assert.equal(s.get('Q-1').answer.by, 'terminal');
  assert.equal(s.get('Q-2').status, 'expired'); // its terminal is gone, and the dialog with it
});

// ---- S3: the master's own question ----

test('S3: a question of the master\'s: added, the same one again merged; answered, dropped, snoozed, reopened', () => {
  const c = clock();
  const s = createStore({ now: c.now });
  const a = s.add({ source: 'master', text: '要不要推送 main 的 2 个提交？', options: [{ key: 'yes', label: '推送' }, { key: 'no', label: '先不推' }], suggestion: '先不推', project: 'FleetBridge' });
  assert.deepEqual(a, { id: 'Q-1', merged: false });
  assert.deepEqual(s.add({ source: 'master', text: '要不要推送 main 的 2 个提交 ？', project: 'FleetBridge' }), { id: 'Q-1', merged: true });
  assert.throws(() => s.resolve('Q-1', { action: 'snooze', until: T0 - 1 }), /until/);
  s.resolve('Q-1', { action: 'snooze', until: T0 + 3_600_000 });
  assert.equal(pendingView(s.items(), [], c.t).count, 0); // snoozed ones are not counted
  c.t = T0 + 3_600_000;
  s.wake();
  assert.equal(s.get('Q-1').status, 'open');
  s.resolve('q-1', { action: 'answered', answer: { option: 'no', text: '', delivered: 'master' }, by: 'ui' });
  assert.equal(s.get('Q-1').status, 'answered');
  assert.equal(s.get('Q-1').answer.delivered, 'master');
  s.resolve('Q-1', { action: 'reopen' });
  assert.equal(s.get('Q-1').status, 'open');
  s.resolve('Q-1', { action: 'dropped' });
  assert.deepEqual(s.get('Q-1').history.map((h) => h.action), ['add', 'snooze', 'wake', 'answered', 'reopen', 'dropped']);
  // asked again after it was closed, in a new turn: a new item
  assert.equal(s.add({ source: 'master', text: '要不要推送 main 的 2 个提交？', project: 'FleetBridge' }).id, 'Q-2');
});

// ---- S4: Fleet Bridge's own ----

test('S4: proposals to approve or install, orders on hold, a folder-trust dialog after 2 minutes; nothing else', () => {
  const sys = systemItems({
    now: T0,
    proposals: [
      { id: 'P-011', status: 'new', title: '安装前检查', createdAt: T0 - 86_400_000 * 2 },
      { id: 'P-007', status: 'built', title: '共用仓库', updatedAt: T0 - 600_000 },
      { id: 'P-005', status: 'installed', title: 'x' },
    ],
    agents: [
      { id: 'a1', name: 'mdlinkapp', cwd: 'E:/p/mdlinkapp', alive: true, queue: [{ text: '继续做 X', at: T0 - 7_200_000, held: 'closed' }, { text: 'not held', at: T0 }] },
      { id: 'a2', name: 'new', cwd: 'E:/p/new', alive: true, queue: [], waiting: { trust: true, at: T0 - DIALOG_AFTER } },
      { id: 'a3', name: 'fresh', cwd: 'E:/p/fresh', alive: true, queue: [], waiting: { trust: true, at: T0 - 1000 } },
    ],
  });
  assert.deepEqual(sys.map((x) => [x.id, x.sys]), [['P-011', 'approve'], ['P-007', 'install'], ['held:a1', 'held'], ['trust:a2', 'trust']]);
  assert.equal(sys[2].n, 1);
  assert.equal(sys[2].project, 'mdlinkapp');
  // counted with the rest; red after 24 hours (P-011), named in the banner
  const v = pendingView([], sys, T0);
  assert.equal(v.count, 4);
  assert.equal(v.red, 1);
  assert.equal(v.amber, 1); // the orders on hold, 2 hours
  assert.deepEqual(v.redList.map((x) => x.id), ['P-011']);
  assert.deepEqual(v.byAgent, { a1: 1, a2: 1 });
});

// ---- kept across restarts ----

test('the list is kept on disk: a restart reads it back; a damaged file is put aside, never overwritten unread', () => {
  const file = path.join(tmp, 'keep', 'pending.json');
  const c = clock();
  const s = createStore({ file, now: c.now });
  s.add({ source: 'master', text: '问题一', project: 'p' });
  s.add({ source: 'master', text: '问题二', project: 'p' });
  s.resolve('Q-2', { action: 'answered', answer: { text: 'ok' } });
  const again = createStore({ file, now: c.now });
  assert.deepEqual(again.items().map((x) => [x.id, x.status]), [['Q-1', 'open'], ['Q-2', 'answered']]);
  assert.equal(again.add({ source: 'master', text: '问题三', project: 'p' }).id, 'Q-3'); // numbering goes on
  // closed ones go after 30 days; open ones stay
  c.t = T0 + 31 * 86_400_000;
  again.add({ source: 'master', text: '问题四', project: 'p' });
  assert.deepEqual(again.items().map((x) => x.id), ['Q-1', 'Q-3', 'Q-4']);
  fs.writeFileSync(file, '{ not json');
  const bad = createStore({ file, now: c.now });
  assert.equal(bad.damaged(), true);
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.endsWith('.bad')));
});

test('the answer sent on names the question, so the terminal knows what it answers', () => {
  const x = { id: 'Q-7', text: '验证码登录失败时：\nA. 回退 B. 报错', options: [{ key: 'A', label: '回退' }, { key: 'B', label: '报错' }] };
  assert.equal(answerText(x, { option: 'A', text: '并记日志' }), '关于你之前提的问题（Q-7：验证码登录失败时： A. 回退 B. 报错），用户的答复：回退：并记日志');
  assert.match(answerText(x, { dropped: true, text: '不需要了' }), /用户的答复：不做了：不需要了$/);
});

// ---- the master's tools, against a stand-in for the local API ----

const calls = [];
let reply = {};
const api = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    let out = {};
    if (req.url === '/api/state') out = { agents: [{ id: 'a1-0000-x', name: 'mdlinkapp', cwd: 'E:/p/mdlinkapp', alive: true, kind: 'claude' }], units: [] };
    else if (req.url === '/api/pending') {
      calls.push(body);
      out = body ? reply : VIEW;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
process.env.FLEET_URL = `http://127.0.0.1:${api.address().port}`;
const { TOOLS } = createRequire(import.meta.url)('../server/fleet-mcp.cjs');
const tool = (n) => TOOLS.find((t) => t.name === n);
after(() => api.close());
const now = Date.now();
const VIEW = {
  count: 2,
  red: 1,
  oldestAt: now - 26 * 3_600_000,
  open: [{ id: 'Q-3', source: 'report', kind: 'decide', project: 'mdlinkapp', agentName: 'mdlinkapp', at: now - 26 * 3_600_000, seen: 2, text: '要不要推送？', options: [{ key: 'yes', label: '是' }, { key: 'no', label: '否' }], suggestion: '先不推', status: 'open' }],
  snoozed: [],
  recent: [],
  system: [{ id: 'P-011', source: 'system', sys: 'approve', project: '舰桥', text: '安装前检查', at: now - 3_600_000 }],
};

test('fleet_pending lists what waits: ids, how long, options, the suggestion, and Fleet Bridge\'s own', async () => {
  const s = await tool('fleet_pending').run({});
  assert.match(s, /^pending decisions: 2 open, 1 waiting over 24h, oldest 26h/);
  assert.match(s, /- Q-3 \[mdlinkapp\] waiting 26h · report · asked 2x\n {2}要不要推送？\n {2}options: yes\. 是 \/ no\. 否\n {2}suggested: 先不推/);
  assert.match(s, /Fleet Bridge's own:\n- P-011 \[舰桥\] waiting 1h · proposal waiting for approval/);
  assert.match(await tool('fleet_pending').run({ project: 'nothing-like-it' }), /\(no open items\)/);
});

test('fleet_pending_add puts the master\'s question on the list, about a terminal by its name', async () => {
  calls.length = 0;
  reply = { ok: true, id: 'Q-9', merged: false };
  assert.equal(await tool('fleet_pending_add').run({ text: '要不要推送？', options: ['推送', '先不推'], suggestion: '先不推', agent: 'mdlinkapp' }), 'Q-9: on the list');
  assert.deepEqual(calls, [{ action: 'add', text: '要不要推送？', options: ['推送', '先不推'], suggestion: '先不推', agent: 'a1-0000-x', via: 'master' }]);
  reply = { ok: true, id: 'Q-9', merged: true };
  assert.match(await tool('fleet_pending_add').run({ text: '要不要推送？', project: 'FleetBridge' }), /already on the list/);
});

test('fleet_pending_resolve answers, drops, snoozes, reopens, and says how the answer went out', async () => {
  calls.length = 0;
  reply = { ok: true, delivered: 'queued', item: { id: 'Q-3', status: 'answered' } };
  assert.equal(await tool('fleet_pending_resolve').run({ id: 'Q-3', action: 'answered', option: 'no', answer: '等 P-011' }), 'Q-3: answered · queued for its terminal (busy now)');
  assert.deepEqual(calls[0], { id: 'Q-3', action: 'answer', text: '等 P-011', option: 'no', via: 'master' });
  reply = { ok: true, delivered: 'not-sent', item: { id: 'Q-3', status: 'dropped' } };
  assert.match(await tool('fleet_pending_resolve').run({ id: 'Q-3', action: 'dropped' }), /NOT sent.*tell the user/);
  reply = { ok: true, item: { id: 'Q-3', status: 'snoozed', snoozeUntil: Date.now() + 7_200_000 } };
  await tool('fleet_pending_resolve').run({ id: 'Q-3', action: 'snooze', until: '+2h' });
  assert.ok(Math.abs(calls.at(-1).until - (Date.now() + 7_200_000)) < 5000);
  await assert.rejects(tool('fleet_pending_resolve').run({ id: 'Q-3', action: 'snooze', until: 'someday' }), /until/);
  reply = { ok: false, error: 'not_open' };
  await assert.rejects(tool('fleet_pending_resolve').run({ id: 'Q-3', action: 'answered', answer: 'x' }), /Q-3: not_open/);
});

test('the master knows the list: its three tools allowed without asking, and the rule in its guide', async () => {
  const src = fs.readFileSync(new URL('../server/master.js', import.meta.url), 'utf8');
  const allowed = src.match(/const ALLOWED = \[(.*?)\]/)[1];
  for (const t of ['fleet_pending', 'fleet_pending_add', 'fleet_pending_resolve']) assert.match(allowed, new RegExp(`'${t}'`));
  const { GUIDE, OLD_GUIDES } = await import('../server/master.js');
  const line = GUIDE.split('\n').find((l) => l.startsWith('- 待决定：'));
  assert.match(line, /fleet_pending_add 登记.*fleet_pending_resolve.*对不上是哪一条时先问用户.*待决定 N 条（最旧 X 小时）/);
  assert.equal(OLD_GUIDES.at(-1), GUIDE.replace(line + '\n', ''), 'the default before this one is known as old');
});
