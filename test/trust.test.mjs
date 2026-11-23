// The folder-trust dialog (improvement P-003): answered by what the choice says, the folders trusted without
// asking (server/trust.js), and the master's one notice for several agents. Uses its own data folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { removeTree } from './_fs.mjs';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-test-')));
process.env.MONITOR_DATA_DIR = path.join(tmp, 'data');
fs.mkdirSync(process.env.MONITOR_DATA_DIR, { recursive: true });
const { cleanDirs, underDirs, autoTrusts, trustSettings, setTrustSettings } = await import('../server/trust.js');
const { trustPrompt, answerTrust, dialogShowing } = await import('../server/agents.js');
const { trustNotice, sameAsk } = await import('../server/master.js');
after(() => removeTree(tmp));

const { Terminal } = createRequire(import.meta.url)('@xterm/headless');
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** An agent whose screen shows these lines; what is typed into it is kept in .typed. */
async function agentShowing(lines, cwd = path.join(tmp, 'proj')) {
  const screen = new Terminal({ cols: 100, rows: 24, allowProposedApi: true });
  await new Promise((ok) => screen.write(lines.join('\r\n'), ok));
  const a = { id: 'a1b2c3d4-0000', alive: true, cwd, screen, typed: [] };
  a.term = { write: (d) => a.typed.push(d) };
  return a;
}
const DIALOG = (first, second, folder = 'E:\\project\\kumi') => [
  '────────────────────────────────────────────',
  ' Accessing workspace:',
  ` ${folder}`,
  '',
  ' Quick safety check: Is this a project you created or one you trust?',
  '',
  ` ❯ ${first}`,
  `   ${second}`,
  '',
  ' Enter to confirm · Esc to cancel',
];
const YES = 'Yes, I trust this folder';
const NO = 'No, exit';
const UP = '\x1b[A';
const DOWN = '\x1b[B';

test('trustPrompt: the folder, and each choice with what it does', async () => {
  const a = await agentShowing(DIALOG(NO, YES));
  const p = trustPrompt(a);
  assert.equal(p.trust, true);
  assert.equal(p.folder, 'E:\\project\\kumi');
  assert.deepEqual(p.options.map((o) => [o.key, o.label, Boolean(o.yes), o.current]), [['1', NO, false, true], ['2', YES, true, false]]);
  assert.match(p.options[0].hint, /退出/);
  assert.match(p.options[1].hint, /信任/);
  assert.equal(dialogShowing(a), true);
  assert.equal(trustPrompt(await agentShowing(['❯ ', 'just a prompt'])), null);
});

test('answerTrust(yes): moves to "Yes, I trust" and presses Enter, cursor on No above it', async () => {
  const a = await agentShowing(DIALOG(NO, YES));
  assert.equal(answerTrust(a, true), true);
  await wait(250);
  assert.deepEqual(a.typed, [DOWN, '\r']);
  assert.ok(a.trustAnsweredAt);
});

test('answerTrust(yes): Yes listed first with the cursor on it is just Enter (never a move onto No)', async () => {
  const a = await agentShowing(DIALOG(YES, NO));
  assert.equal(answerTrust(a, true), true);
  await wait(250);
  assert.deepEqual(a.typed, ['\r']);
});

test('answerTrust(no): picks "No, exit" wherever it is', async () => {
  const below = await agentShowing(DIALOG(YES, NO));
  assert.equal(answerTrust(below, false), true);
  const above = await agentShowing(DIALOG(NO, YES));
  assert.equal(answerTrust(above, false), true);
  await wait(250);
  assert.deepEqual(below.typed, [DOWN, '\r']);
  assert.deepEqual(above.typed, ['\r']);
});

test('answerTrust: a second call right after presses nothing more; no dialog, or a dead agent, is false', async () => {
  const a = await agentShowing(DIALOG(NO, YES));
  answerTrust(a, true);
  assert.equal(answerTrust(a, true), true);
  await wait(250);
  assert.deepEqual(a.typed, [DOWN, '\r']);
  const idle = await agentShowing(['────────', '❯ ']);
  assert.equal(answerTrust(idle, true), false);
  assert.deepEqual(idle.typed, []);
  const dead = await agentShowing(DIALOG(NO, YES));
  dead.alive = false;
  assert.equal(answerTrust(dead, true), false);
  assert.deepEqual(dead.typed, []);
});

test('cleanDirs: absolute folders only, no drive roots, no repeats', () => {
  const a = path.join(tmp, 'work');
  const root = path.parse(tmp).root;
  assert.deepEqual(cleanDirs(`${a}\n\n  ${a}${path.sep} \nrelative/dir\n${root}\n"${path.join(tmp, 'with space')}"`), [a, path.join(tmp, 'with space')]);
  assert.deepEqual(cleanDirs([a, 42, null]), [a]);
  assert.deepEqual(cleanDirs(undefined), []);
});

test('underDirs: the folder itself and what is below it, by whole path segments', () => {
  const work = path.join(tmp, 'work');
  assert.equal(underDirs(work, [work]), true);
  assert.equal(underDirs(path.join(work, 'a', 'b'), [work]), true);
  assert.equal(underDirs(work + path.sep, [work]), true);
  assert.equal(underDirs(path.join(tmp, 'work2'), [work]), false);
  assert.equal(underDirs(tmp, [work]), false); // its parent is not covered
  assert.equal(underDirs(work, []), false);
  assert.equal(underDirs('', [work]), false);
  assert.equal(underDirs(work, [path.parse(work).root]), false); // a root in the list covers nothing
  if (process.platform === 'win32') assert.equal(underDirs(work.toUpperCase(), [work.toLowerCase()]), true);
});

test('settings: off with no folders at first; auto-trust needs both the switch and a listed folder', () => {
  const work = path.join(tmp, 'work');
  fs.mkdirSync(path.join(work, 'sub'), { recursive: true });
  assert.deepEqual(trustSettings(), { auto: false, dirs: [] });
  assert.equal(autoTrusts(work), false);
  setTrustSettings({ dirs: work });
  assert.equal(autoTrusts(work), false); // listed, but the switch is off
  setTrustSettings({ auto: true });
  assert.equal(autoTrusts(work), true);
  assert.equal(autoTrusts(path.join(work, 'sub')), true);
  assert.equal(autoTrusts(path.join(tmp, 'elsewhere')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.MONITOR_DATA_DIR, 'trust.json'), 'utf8')), { auto: true, dirs: [work] });
  // add / remove one folder; a root is never added
  setTrustSettings({ add: path.join(tmp, 'other') });
  setTrustSettings({ add: path.parse(tmp).root });
  assert.deepEqual(trustSettings().dirs, [work, path.join(tmp, 'other')]);
  setTrustSettings({ remove: work });
  assert.equal(autoTrusts(work), false);
  setTrustSettings({ auto: false });
  assert.equal(autoTrusts(path.join(tmp, 'other')), false);
  // what was given is not what is held
  const got = trustSettings();
  got.dirs.push('x');
  assert.equal(trustSettings().dirs.length, 1);
});

test('trustNotice: several agents in one notice, with what the choices do and how to trust', async () => {
  const one = { agentId: 'a5a129ef-1111', name: 'kumi-经理', project: 'kumi', prompt: trustPrompt(await agentShowing(DIALOG(NO, YES))) };
  const two = { agentId: 'b7c0d9e2-2222', name: 'kumi-开发', project: 'kumi', prompt: trustPrompt(await agentShowing(DIALOG(NO, YES, 'E:\\project\\kumi-dev'))) };
  const s = trustNotice([one, two]);
  assert.equal(s.match(/【舰桥通知】/g).length, 1);
  assert.match(s, /^【舰桥通知】2 个新开的 agent/);
  assert.match(s, /- kumi-经理（a5a129ef）：E:\\project\\kumi\n- kumi-开发（b7c0d9e2）：E:\\project\\kumi-dev/);
  assert.match(s, /No, exit）= Claude Code 直接退出/);
  assert.match(s, /fleet_answer，choice 填 "trust"/);
  assert.match(s, /不要填 1/);
  assert.match(trustNotice([one]), /对这个 agent 调 fleet_answer/);
  // the hints are not part of what makes it the same question (a notice is not sent twice over them)
  assert.equal(sameAsk(one, { ...one, prompt: { ...one.prompt, options: one.prompt.options.map(({ hint, ...o }) => o) } }), true);
});

test('answerPrompt on the trust dialog: 2 is "Yes, I trust" and 1 is "No, exit", whichever is listed first', async () => {
  const { answerPrompt } = await import('../server/agents.js');
  const yesFirst = await agentShowing(DIALOG(YES, NO));
  assert.equal(answerPrompt(yesFirst, '2'), true);
  const noFirst = await agentShowing(DIALOG(NO, YES));
  assert.equal(answerPrompt(noFirst, '1'), true);
  await wait(250);
  assert.deepEqual(yesFirst.typed, ['\r']);
  assert.deepEqual(noFirst.typed, ['\r']);
});
