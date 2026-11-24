// The master's guide (server/master.js GUIDE, written to its CLAUDE.md): the order template (improvement
// P-002), and that only a missing guide or an untouched older default is replaced.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { removeTree } from './_fs.mjs';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-guide-'));
process.env.MONITOR_DATA_DIR = tmp;
const { GUIDE, OLD_GUIDES, refreshGuide } = await import('../server/master.js');
after(() => removeTree(tmp));

const dir = (name) => path.join(tmp, name);
const read = (d) => fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8');

test('the guide has the order template: the user\'s words, goal, scope, acceptance, the user\'s part, report', () => {
  for (const part of ['【用户原话】', '【目标】', '【范围】', '【验收标准】', '【需要用户配合】', '【汇报格式】']) assert.ok(GUIDE.includes(part), part);
  assert.match(GUIDE, /原样引用/);
  assert.match(GUIDE, /fleet_send、fleet_spawn 的首条指令/);
});

test('investigate-and-fix orders name what the user must do; small orders go without the template', () => {
  assert.match(GUIDE, /「调查并修复」.*【需要用户配合】不能省/);
  assert.match(GUIDE, /验证码/);
  assert.match(GUIDE, /小指令免模板/);
});

// the defaults in turn: OLD_GUIDES[8] the 0.9.79 one (no template), [9] with the template (P-002), [10] with
// wrap-up (P-010); the current one adds the read-only switch and the secrets rule (P-008)
test('the rest of the guide is as before: the template, wrap-up, then the read-only switch and the secrets rule (P-008), are only added', () => {
  const before = OLD_GUIDES[8].split('\n');
  const now = GUIDE.split('\n');
  for (const line of before) assert.ok(now.includes(line), line);
  const later = /^- (收工|只读调查|密钥|共用仓库|待决定)：/; // lines of their own (P-010: test/wrapup.test.mjs; P-008: below)
  const added = now.filter((l) => !before.includes(l) && !later.test(l));
  assert.equal(added.length, 10); // the template (P-002): as it came in, OLD_GUIDES[9]
  assert.deepEqual(added, OLD_GUIDES[9].split('\n').filter((l) => !before.includes(l)));
  assert.ok(added.every((l) => /^ {0,2}- /.test(l)));
  const withWrapup = OLD_GUIDES[10].split('\n');
  assert.ok(withWrapup.some((l) => l.startsWith('- 收工：')));
  // [11] is the P-008 default; then the shared working tree line (P-007: test/shared.test.mjs) and the 待决定 line
  // (test/pending.test.mjs)
  const withP8 = OLD_GUIDES[11].split('\n');
  assert.deepEqual(now.filter((l) => !withP8.includes(l)).map((l) => l.slice(0, l.indexOf('：') + 1)), ['- 共用仓库：', '- 待决定：']);
  const p8 = withP8.filter((l) => !withWrapup.includes(l));
  assert.equal(p8.length, 2);
  assert.match(p8[0], /^- 只读调查：.*readonly: true.*要 agent 动手改的任务不要带/);
  assert.match(p8[1], /^- 密钥：.*不原样输出.*需要原值/);
});

test('a missing guide is written', () => {
  const d = dir('none');
  assert.equal(refreshGuide(d), true);
  assert.equal(read(d), GUIDE);
  assert.equal(refreshGuide(d), false); // already the current one
});

test('every older default is replaced by the current guide', () => {
  assert.ok(OLD_GUIDES.length >= 10);
  assert.ok(!OLD_GUIDES.includes(GUIDE));
  assert.equal(new Set(OLD_GUIDES).size, OLD_GUIDES.length);
  OLD_GUIDES.forEach((old, i) => {
    const d = dir(`old${i}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'CLAUDE.md'), old);
    assert.equal(refreshGuide(d), true);
    assert.equal(read(d), GUIDE);
  });
});

test('a guide the user edited is left alone', () => {
  const d = dir('edited');
  fs.mkdirSync(d, { recursive: true });
  const mine = OLD_GUIDES.at(-1) + '- 我自己加的一条\n';
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), mine);
  assert.equal(refreshGuide(d), false);
  assert.equal(read(d), mine);
});

test('the tools say it too, for a master whose guide was edited: fleet_send and fleet_spawn', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'fleet-mcp.cjs'), 'utf8');
  const desc = (name) => src.slice(src.indexOf(`name: '${name}'`)).match(/description: '((?:[^'\\]|\\.)*)'/)[1];
  assert.match(desc('fleet_send'), /order template/);
  assert.match(desc('fleet_send'), /quoted word for word/);
  assert.match(desc('fleet_send'), /small order/);
  assert.match(desc('fleet_spawn'), /order template/);
});
