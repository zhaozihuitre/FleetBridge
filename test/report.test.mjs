// node --test test/  (npm test)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickReply, reportBlock, REPORT_CLOSE, REPORT_OPEN, isStopHook } from '../server/report.js';

const say = (...parts) => ({ type: 'assistant', message: { content: parts.map((p) => (typeof p === 'string' ? { type: 'text', text: p } : p)) } });
const tool = (name = 'Bash') => ({ type: 'tool_use', name, input: {} });
const result = () => ({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });
const hook = () => ({ type: 'user', isMeta: true, message: { role: 'user', content: 'Stop hook feedback:\n[project-docs] 本轮修改了以下文件，但尚未更新项目文档' } });
const block = (s) => `${REPORT_OPEN}\n${s}\n${REPORT_CLOSE}`;

test('reportBlock: the last block, an unclosed one runs to the end', () => {
  assert.equal(reportBlock(`intro\n${block('first')}\nmid\n${block('second')}\nbye`), 'second');
  assert.equal(reportBlock(`x\n${REPORT_OPEN}\nopen to the end`), 'open to the end');
  assert.equal(reportBlock('no block here'), '');
});

test('a stop hook\'s follow-up does not replace the report before it', () => {
  const r = pickReply([say('Let me look.', tool()), result(), say('## 汇报\n改了 a.js，测试通过。'), hook(), say('无需更新文档')]);
  assert.equal(r.reply, '## 汇报\n改了 a.js，测试通过。');
  assert.equal(r.marked, false);
});

test('the follow-up of a stop hook counts when nothing came before it', () => {
  const r = pickReply([say(tool()), result(), hook(), say('文档已更新，C-012')]);
  assert.equal(r.reply, '文档已更新，C-012');
  assert.equal(r.afterHook, true);
});

test('a marked block wins, also one written after the stop hook', () => {
  assert.equal(pickReply([say(`前言\n${block('正式汇报 1')}`), hook(), say('无需更新文档')]).reply, '正式汇报 1');
  const r = pickReply([say(block('旧汇报')), hook(), say(tool('Edit')), result(), say(`文档已更新\n${block('新汇报（含文档）')}`)]);
  assert.equal(r.reply, '新汇报（含文档）');
  assert.equal(r.marked, true);
});

test('the answer is what came after the last tool call, all of it', () => {
  const r = pickReply([say('先看一下。', tool()), result(), say('第一段结论。'), say('第二段细节。')]);
  assert.equal(r.reply, '第一段结论。\n\n第二段细节。');
});

test('a turn ending on a tool call keeps the text before it; sidechains and API errors are left out', () => {
  assert.equal(pickReply([say('结论在这。'), say(tool())]).reply, '结论在这。');
  assert.equal(pickReply([say('主线回答'), { ...say('子代理的话'), isSidechain: true }]).reply, '主线回答');
  assert.equal(pickReply([say('主线回答'), { ...say('API Error: overloaded'), isApiErrorMessage: true }]).reply, '主线回答');
});

test('isStopHook knows the feedback message (string or text parts)', () => {
  assert.equal(isStopHook(hook()), true);
  assert.equal(isStopHook({ type: 'user', message: { content: [{ type: 'text', text: 'Stop hook feedback:\nx' }] } }), true);
  assert.equal(isStopHook({ type: 'user', message: { content: 'please stop the hook' } }), false);
});
