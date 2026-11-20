// The master's done notices (server/master.js doneNotice): the report, the full text's path, the resend.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { removeTree } from './_fs.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-test-'));
process.env.MONITOR_DATA_DIR = tmp;
const { doneNotice } = await import('../server/master.js');
after(() => removeTree(tmp));

const base = { agentId: 'abcdef0123456789', name: 'demo', text: '修复 bug 并汇报', ms: 65_000 };

test('done: a marked report, cut, with the full text\'s path and fleet_read_reply', () => {
  const s = doneNotice({ ...base, reply: '汇报正文', cut: true, marked: true, file: 'C:/data/replies/abcdef/20261120-101500.md' });
  assert.match(s, /完成：demo/);
  assert.match(s, /汇报：\n汇报正文/);
  assert.match(s, /fleet_read_reply/);
  assert.match(s, /全文：C:\/data\/replies\/abcdef\/20261120-101500\.md/);
  assert.doesNotMatch(s, /重发/);
});

test('done after a resend says so; an unmarked answer is an answer', () => {
  const s = doneNotice({ ...base, reply: '做完了', resent: true });
  assert.match(s, /自动重发一次/);
  assert.match(s, /回答：\n做完了/);
  assert.doesNotMatch(s, /全文：/);
});

test('never ran: after the resend, or why it could not be typed again', () => {
  assert.match(doneNotice({ ...base, neverRan: true, resent: true }), /已自动重发一次，仍然没有进去/);
  assert.match(doneNotice({ ...base, neverRan: true, blocked: 'busy-input' }), /输入框里有别的文字/);
  assert.match(doneNotice({ ...base, neverRan: true }), /已经空闲 1 分钟/);
});
