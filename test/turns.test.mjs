// The master's turns (server/turns.js): the answer from a transcript, the full answer on disk, and an
// order that didn't go in typed again once. Uses its own data folder, never the app's.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { removeTree } from './_fs.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-test-'));
process.env.MONITOR_DATA_DIR = path.join(tmp, 'data');
fs.mkdirSync(process.env.MONITOR_DATA_DIR, { recursive: true });
const { endedTurns, noteOrder, turnReply, received, clip, RESEND_AFTER, REPLY_MAX, REPORT_MAX } = await import('../server/turns.js');
const { historyFiles } = await import('../server/collectors/history.js');
const { saveReply, readReply, listReplies } = await import('../server/replies.js');
after(() => removeTree(tmp));

const T0 = Date.parse('2026-11-20T01:00:00Z');
const iso = (ms) => new Date(T0 + ms).toISOString();
function transcript(id, entries) {
  const file = path.join(tmp, `${id}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  historyFiles.set(id, file);
  return file;
}
const user = (ms, content, extra = {}) => ({ type: 'user', timestamp: iso(ms), message: { role: 'user', content }, ...extra });
const assistant = (ms, content, stop = 'end_turn') => ({ type: 'assistant', timestamp: iso(ms), message: { role: 'assistant', stop_reason: stop, content } });

test('turnReply: the report, not the reply to the stop hook after it', () => {
  transcript('s-hook', [
    user(-60_000, '上一轮'),
    assistant(-50_000, [{ type: 'text', text: '上一轮的回答' }]),
    user(0, '修复 bug 并汇报'),
    assistant(1000, [{ type: 'text', text: '先看看' }, { type: 'tool_use', name: 'Edit', input: {} }], 'tool_use'),
    user(2000, [{ type: 'tool_result', content: 'ok' }]),
    assistant(3000, [{ type: 'text', text: '已修复：a.js 第 3 行，测试通过。' }]),
    user(4000, 'Stop hook feedback:\n[project-docs] 本轮修改了以下文件', { isMeta: true }),
    assistant(5000, [{ type: 'text', text: '无需更新文档' }]),
  ]);
  const r = turnReply('s-hook', T0);
  assert.equal(r.reply, '已修复：a.js 第 3 行，测试通过。');
  assert.equal(r.interrupted, false);
});

test('received: the order as a user message after it went out', () => {
  transcript('s-recv', [user(-30_000, '旧指令'), user(1000, '新的指令：跑一遍测试'), user(1500, 'Stop hook feedback: x', { isMeta: true })]);
  assert.equal(received('s-recv', T0, '新的指令：跑一遍测试'), true);
  assert.equal(received('s-recv', T0, '另一条从没进去的指令'), false);
  assert.equal(received('s-recv', T0 + 60_000, '新的指令：跑一遍测试'), false); // before this turn
  assert.equal(received('s-none', T0, 'x'), null);
});

test('an order that never went in is typed again once, then told as never run', () => {
  const agent = { id: 'a-resend', kind: 'claude' };
  noteOrder(agent, 'master', '首条指令：检查依赖', T0);
  const unit = { agentId: 'a-resend', sessionId: 's-absent', name: 'demo', status: 'idle', lastPrompt: '之前的指令', statusSince: T0 - 5000 };
  const calls = [];
  const resend = (id, text) => (calls.push([id, text]), 'sent');
  assert.deepEqual(endedTurns([unit], new Set(), T0 + 5000, { resend }), []); // too early
  assert.equal(calls.length, 0);
  assert.deepEqual(endedTurns([unit], new Set(), T0 + RESEND_AFTER + 1, { resend }), []);
  assert.deepEqual(calls, [['a-resend', '首条指令：检查依赖']]);
  assert.deepEqual(endedTurns([unit], new Set(), T0 + RESEND_AFTER * 2, { resend }), []); // waits after the resend
  const done = endedTurns([unit], new Set(), T0 + RESEND_AFTER * 4, { resend });
  assert.equal(calls.length, 1); // only once
  assert.equal(done.length, 1);
  assert.equal(done[0].neverRan, true);
  assert.equal(done[0].resent, true);
});

test('a resent order that then runs ends as a normal turn, marked resent', () => {
  const agent = { id: 'a-ok', kind: 'claude' };
  noteOrder(agent, 'master', '做一件事', T0);
  const idle = { agentId: 'a-ok', sessionId: 's-ok', name: 'ok', status: 'idle', lastPrompt: '旧的', statusSince: T0 - 1000 };
  endedTurns([idle], new Set(), T0 + RESEND_AFTER + 1, { resend: () => 'sent' });
  transcript('s-ok', [user(RESEND_AFTER + 2000, '做一件事'), assistant(RESEND_AFTER + 9000, [{ type: 'text', text: '做完了' }])]);
  endedTurns([{ ...idle, status: 'busy', lastPrompt: '做一件事' }], new Set(), T0 + RESEND_AFTER + 3000, { resend: () => 'sent' });
  const done = endedTurns([{ ...idle, lastPrompt: '做一件事', statusSince: T0 + RESEND_AFTER + 9000 }], new Set(), T0 + RESEND_AFTER + 10_000, { resend: () => 'sent' });
  assert.equal(done.length, 1);
  assert.equal(done[0].neverRan, false);
  assert.equal(done[0].resent, true);
});

test('not typed over a dialog or other text: retried, then told with the reason', () => {
  const agent = { id: 'a-blocked', kind: 'claude' };
  noteOrder(agent, 'master', '被挡住的指令', T0);
  const unit = { agentId: 'a-blocked', sessionId: 's-absent2', name: 'b', status: 'idle', lastPrompt: '', statusSince: 0 };
  let n = 0;
  const resend = () => (n++, 'busy-input');
  assert.deepEqual(endedTurns([unit], new Set(), T0 + RESEND_AFTER + 1, { resend }), []);
  assert.deepEqual(endedTurns([unit], new Set(), T0 + RESEND_AFTER * 2, { resend }), []);
  const done = endedTurns([unit], new Set(), T0 + RESEND_AFTER * 3, { resend });
  assert.equal(n, 3);
  assert.equal(done[0].neverRan, true);
  assert.equal(done[0].blocked, 'busy-input');
});

test('an order already in the transcript is not typed again', () => {
  const agent = { id: 'a-in', kind: 'claude' };
  noteOrder(agent, 'master', '已经收到的指令', T0);
  transcript('s-in', [user(500, '已经收到的指令')]);
  let n = 0;
  endedTurns([{ agentId: 'a-in', sessionId: 's-in', name: 'in', status: 'idle', lastPrompt: '旧', statusSince: 0 }], new Set(), T0 + RESEND_AFTER * 2, { resend: () => (n++, 'sent') });
  assert.equal(n, 0);
});

test('replies on disk: saved whole, read newest first, kept to 50', () => {
  const dir = path.join(tmp, 'replies');
  const long = 'x'.repeat(5000) + '\n结尾';
  const f1 = saveReply({ agentId: 'agent-1', name: 'demo', order: '第一条', reply: '第一条的回答', at: T0 }, dir);
  const f2 = saveReply({ agentId: 'agent-1', name: 'demo', order: '第二条', reply: long, at: T0 + 1000, status: 'done' }, dir);
  assert.ok(f1 && f2 && f1 !== f2);
  const latest = readReply('agent-1', 0, dir);
  assert.ok(latest.text.includes(long), 'the whole answer, not cut');
  assert.ok(latest.text.includes('第二条'));
  assert.equal(latest.count, 2);
  assert.ok(readReply('agent-1', 1, dir).text.includes('第一条的回答'));
  assert.equal(readReply('agent-1', 2, dir), null);
  assert.equal(readReply('nobody', 0, dir), null);
  assert.equal(saveReply({ agentId: 'agent-1', reply: '  ' }, dir), null);
  for (let i = 0; i < 60; i++) saveReply({ agentId: 'agent-2', reply: `r${i}`, at: T0 + i * 1000 }, dir);
  assert.equal(listReplies('agent-2', dir).length, 50);
  assert.ok(readReply('agent-2', 0, dir).text.includes('r59'));
  assert.ok(!fs.existsSync(path.join(dir, '..', 'agent-1')), 'stays in its folder');
});

// P-001: the notices cut at 1500 characters were read in full afterwards (answers of 2363 and 2951 characters)
test('clip: an answer up to REPLY_MAX goes whole; a longer one keeps its start and its end', () => {
  for (const n of [2363, 2951, REPLY_MAX]) {
    const a = 'a'.repeat(n);
    assert.deepEqual(clip(a), { text: a, cut: false, len: n });
  }
  const long = 'S' + 'x'.repeat(REPLY_MAX + 998) + 'E';
  const c = clip(long);
  assert.equal(c.cut, true);
  assert.equal(c.len, REPLY_MAX + 1000);
  assert.ok(c.text.startsWith('S') && c.text.endsWith('E'));
  assert.match(c.text, /\n…（中略 1000 字）…\n/);
  assert.equal(c.text.replace(/\n…（中略 \d+ 字）…\n/, '').length, REPLY_MAX);
  assert.deepEqual(clip('  \n短\n '), { text: '短', cut: false, len: 1 });
  assert.deepEqual(clip(null), { text: '', cut: false, len: 0 });
});

test('clip: a marked report goes whole past REPLY_MAX, and is cut only past its hard limit', () => {
  assert.ok(REPORT_MAX > REPLY_MAX);
  const report = '- 结论：做完了\n' + '改动说明。'.repeat(REPLY_MAX / 5 + 200) + '\n- 需要用户注意的事：重启';
  assert.ok(report.length > REPLY_MAX && report.length <= REPORT_MAX);
  assert.equal(clip(report).cut, true, 'unmarked: cut');
  assert.deepEqual(clip(report, { marked: true }), { text: report, cut: false, len: report.length });
  const huge = '- 结论：做完了\n' + 'y'.repeat(REPORT_MAX * 2) + '\n- 需要用户注意的事：重启';
  const c = clip(huge, { marked: true });
  assert.equal(c.cut, true);
  assert.ok(c.text.length < REPORT_MAX + 40, 'the hard limit holds');
  assert.ok(c.text.startsWith('- 结论：做完了') && c.text.endsWith('- 需要用户注意的事：重启'), 'the conclusion and what is left for the user stay');
});

test('a marked report of a turn longer than REPLY_MAX reaches the notice whole', () => {
  const body = '- 结论：做完了\n' + '细节。'.repeat(1200) + '\n- 需要用户注意的事：无';
  transcript('s-longreport', [user(0, '做任务'), assistant(1000, [{ type: 'text', text: `过程说明${'。'.repeat(500)}\n[[FLEET-REPORT]]\n${body}\n[[/FLEET-REPORT]]` }])]);
  const r = turnReply('s-longreport', T0);
  assert.equal(r.marked, true);
  assert.ok(r.reply.length > REPLY_MAX);
  assert.deepEqual(clip(r.reply, { marked: r.marked }), { text: body, cut: false, len: body.length });
});
