// Building an approved proposal (server/insights/implement.js) on a real, throwaway git repository:
// the worktree on its own branch, the development agent's settings, the checks after it, removing it all.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { removeTree } from './_fs.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-impl-'));
process.env.MONITOR_DATA_DIR = path.join(tmp, 'data');
fs.mkdirSync(process.env.MONITOR_DATA_DIR, { recursive: true });
const { startImpl, finishImpl, followImpl, discardImpl, needsInstaller, updateResult, findRepo, isFleetRepo, devPrompt, DENY } = await import('../server/insights/implement.js');
after(() => removeTree(tmp));

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function makeRepo(name) {
  const repo = path.join(tmp, name);
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fleet-bridge', version: '1.0.0' }, null, 2) + '\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  fs.writeFileSync(path.join(repo, 'test', 'ok.test.mjs'), "import { test } from 'node:test';\ntest('ok', () => {});\n");
  git(['init', '-q', '-b', 'main'], repo);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], repo);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], repo);
  return repo;
}
const P = { id: 'P-001', title: '测试提案', finding: 'f', change: 'c', benefit: 'b', effort: 'S', risk: 'r', evidence: [{ ref: 'event:x' }] };

test('repo detection: only a FleetBridge checkout', () => {
  const repo = makeRepo('detect');
  assert.equal(isFleetRepo(repo), true);
  assert.equal(isFleetRepo(tmp), false);
  assert.equal(findRepo('', [tmp, repo]), path.resolve(repo));
  assert.equal(findRepo('', [tmp]), null);
});

test('a worktree on its own branch, the agent started in it with deny rules; built after a passing change', async () => {
  const repo = makeRepo('build');
  const dataDir = path.join(tmp, 'd1');
  let spawned = null;
  const impl = startImpl(P, { repo, dataDir, baseSettings: { theme: 'dark-ansi', permissions: { deny: ['Bash(x)'] } }, spawnAgent: (o) => ((spawned = o), { id: 'ag1', sessionId: 'ag1' }) });
  assert.equal(impl.branch, 'improve/p-001');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], impl.worktree), 'improve/p-001');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repo), 'main', 'the checkout stays on its branch');
  assert.equal(spawned.cwd, impl.worktree);
  assert.deepEqual(spawned.extraArgs, ['--permission-mode', 'acceptEdits']);
  assert.match(spawned.prompt, /\[\[FLEET-REPORT\]\]/);
  assert.match(spawned.prompt, /不要 git push/);
  const st = JSON.parse(fs.readFileSync(spawned.settingsFile, 'utf8'));
  assert.equal(st.theme, 'dark-ansi');
  for (const r of ['Bash(x)', ...DENY]) assert.ok(st.permissions.deny.includes(r), r);
  assert.ok(fs.existsSync(path.join(impl.worktree, 'node_modules', 'dep', 'index.js')), 'node_modules joined');

  // following: not done until seen working and then idle with the turn over
  const alive = () => true;
  assert.equal(followImpl(impl, { status: 'idle' }, { alive, turnOver: () => true }), 'running');
  assert.equal(followImpl(impl, { status: 'busy' }, { alive, turnOver: () => true }), 'running');
  assert.equal(followImpl(impl, { status: 'idle' }, { alive, turnOver: () => false }), 'running');
  assert.equal(followImpl(impl, { status: 'idle' }, { alive, turnOver: () => true }), 'done');
  assert.equal(followImpl(impl, { status: 'idle' }, { alive: () => false, turnOver: () => true }), 'gone');

  // nothing changed yet
  assert.equal((await finishImpl(impl, {})).reason, 'no-changes');
  // the agent's change, committed in the worktree
  fs.writeFileSync(path.join(impl.worktree, 'feature.js'), 'export const x = 1;\n');
  git(['add', '-A'], impl.worktree);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'feature'], impl.worktree);
  const r = await finishImpl(impl, { reply: '做完了' });
  assert.equal(r.status, 'built', JSON.stringify(r));
  assert.deepEqual(r.files, ['feature.js']);
  assert.equal(r.tests.ok, true);
  assert.equal(r.tests.fail, 0);
});

test('failing tests, or the user\'s checkout changed meanwhile: failed', async () => {
  const repo = makeRepo('fail');
  const impl = startImpl({ ...P, id: 'P-002' }, { repo, dataDir: path.join(tmp, 'd2'), spawnAgent: () => ({ id: 'a', sessionId: 'a' }) });
  fs.writeFileSync(path.join(impl.worktree, 'test', 'bad.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('bad', () => assert.equal(1, 2));\n");
  const r = await finishImpl(impl, {});
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'tests-failed');
  fs.writeFileSync(path.join(repo, 'stray.txt'), 'written outside the worktree');
  assert.equal((await finishImpl(impl, {})).reason, 'main-repo-changed');
});

test('a branch rebased onto a newer main is counted from where it parts from main, not its approval base', async () => {
  const repo = makeRepo('rebase');
  const impl = startImpl({ ...P, id: 'P-004' }, { repo, dataDir: path.join(tmp, 'd4'), spawnAgent: () => ({ id: 'a', sessionId: 'a' }) });
  assert.equal(impl.mainBranch, 'main');
  const id = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
  // the agent's change
  fs.mkdirSync(path.join(impl.worktree, 'server'), { recursive: true });
  fs.writeFileSync(path.join(impl.worktree, 'server', 'x.js'), 'export const x = 1;\n');
  git(['add', '-A'], impl.worktree);
  git([...id, 'commit', '-qm', 'proposal'], impl.worktree);
  // meanwhile main gets the shell and a dependency (needs the installer, but not the proposal's doing)
  fs.mkdirSync(path.join(repo, 'desktop'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'desktop', 'main.cjs'), '// shell\n');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fleet-bridge', version: '1.0.1', dependencies: { dep: '1.0.0' } }, null, 2) + '\n');
  git(['add', '-A'], repo);
  git([...id, 'commit', '-qm', 'main moves on'], repo);
  const snapshot = git(['status', '--porcelain'], repo);
  // not rebased: only the branch's own change
  let r = await finishImpl({ ...impl, snapshot }, {});
  assert.deepEqual(r.files, ['server/x.js']);
  assert.equal(r.status, 'built', JSON.stringify(r));
  // rebased onto the new main: still only its own change, no installer
  git([...id, 'rebase', '-q', 'main'], impl.worktree);
  r = await finishImpl({ ...impl, snapshot }, {});
  assert.deepEqual(r.files, ['server/x.js']);
  assert.equal(r.status, 'built', JSON.stringify(r));
  assert.equal(r.base, git(['rev-parse', 'main'], repo));
  assert.doesNotMatch(r.stat, /package\.json|desktop/);
  // an old proposal without mainBranch finds main too
  r = await finishImpl({ ...impl, snapshot, mainBranch: undefined }, {});
  assert.deepEqual(r.files, ['server/x.js']);
});

test('discard removes the worktree and branch, never the checkout\'s node_modules', () => {
  const repo = makeRepo('discard');
  const impl = startImpl({ ...P, id: 'P-003' }, { repo, dataDir: path.join(tmp, 'd3'), spawnAgent: () => ({ id: 'a', sessionId: 'a' }) });
  const out = discardImpl(impl);
  assert.ok(!fs.existsSync(impl.worktree), out);
  assert.equal(git(['branch', '--list', impl.branch], repo), '');
  assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'dep', 'index.js')), 'the checkout\'s node_modules untouched');
});

test('installer needed for the shell or dependencies; the update log read', () => {
  assert.equal(needsInstaller(['server/x.js', 'web/y.js']), false);
  assert.equal(needsInstaller(['desktop/main.cjs']), true);
  assert.equal(needsInstaller(['package-lock.json']), true);
  assert.equal(needsInstaller(['package.json'], '-  "version": "1.0.0",\n+  "version": "1.0.1",'), false);
  assert.equal(needsInstaller(['package.json'], '+  "dependencies": {'), true);
  const log = path.join(tmp, 'u.log');
  fs.writeFileSync(log, 'running: 0.9.72\ninstalled 0.9.74-2026 → x\n');
  assert.equal(updateResult(log, Date.now()).done, false);
  fs.appendFileSync(log, '✔ now running 0.9.74-20261120; terminals still running: 3/3\n');
  assert.deepEqual({ ...updateResult(log, Date.now()), tail: undefined }, { done: true, ok: true, version: '0.9.74-20261120', kept: '3/3', tail: undefined });
  fs.writeFileSync(log, '✖ 0.9.74 did not start (x); the app went back to 0.9.72\n');
  assert.equal(updateResult(log, Date.now()).ok, false);
  fs.writeFileSync(log, '');
  assert.equal(updateResult(log, Date.now() - 10 * 60_000).done, true, 'no answer in 5 minutes: failed');
  assert.match(devPrompt(P, { branch: 'improve/p-001', base: 'abcdef0123', dirtyBase: true, repo: 'E:/x' }), /基线不包含它们/);
});

test('the acceptance run: node --test output parsed (as P-001\'s "48 passed / 2 failed"), the npm-test node used', async () => {
  const { parseTestOutput, failingTests, testNode } = await import('../server/insights/implement.js');
  const out = [
    '✔ a test (1ms)',
    '✖ C:/x/test/insights-flow.test.mjs (1040.0905ms)',
    '✖ C:/x/test/insights-implement.test.mjs (1037.3208ms)',
    'ℹ tests 50',
    'ℹ pass 48',
    'ℹ fail 2',
    '✖ failing tests:',
    '',
    'test at test/insights-flow.test.mjs:20:1',
    '✖ C:/x/test/insights-flow.test.mjs (1040.0905ms)',
    "  Error: EPERM, Permission denied: 'C:/Temp/fleet-flow-h35LkT'",
    '✖ C:/x/test/insights-implement.test.mjs (1037.3208ms)',
    "  Error: EPERM, Permission denied: 'C:/Temp/fleet-impl-9wjWSc'",
  ].join('\n');
  const r = parseTestOutput(out, null);
  assert.equal(r.ok, false);
  assert.equal(r.pass, 48);
  assert.equal(r.fail, 2);
  assert.deepEqual(r.failures, ['C:/x/test/insights-flow.test.mjs', 'C:/x/test/insights-implement.test.mjs']);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0], /EPERM/);
  assert.equal(parseTestOutput('ℹ pass 48\nℹ fail 0', null).ok, true);
  assert.equal(parseTestOutput('ℹ pass 48\nℹ fail 0', new Error('exit 1')).ok, false);
  const E = String.fromCharCode(27);
  assert.deepEqual(failingTests(`${E}[31m✖ one ${E}[90m(2ms)${E}[39m${E}[39m\n✖ two`), ['one', 'two'], 'colors taken out');
  const n = testNode();
  assert.ok(n === null || fs.existsSync(n));
});

test('a retry tells the agent the user\'s note and why the last build failed', () => {
  const p = { ...P, decision: { action: 'retry', note: '修那 2 项并还原文档噪声' }, impl: { result: { status: 'failed', reason: 'tests-failed', files: ['server/turns.js'], tests: { pass: 48, fail: 2, node: 'app v24.22.1', failures: ['test/insights-flow.test.mjs'], errors: ['Error: EPERM, Permission denied'] } } } };
  const s = devPrompt(p, { branch: 'improve/p-001', base: 'abcdef0123', dirtyBase: false, repo: 'E:/x' });
  assert.match(s, /^## 这是重试/);
  assert.match(s, /用户的要求（务必照做）：修那 2 项并还原文档噪声/);
  assert.match(s, /48 通过 \/ 2 失败/);
  assert.match(s, /insights-flow\.test\.mjs/);
  assert.match(s, /EPERM/);
  assert.match(s, /## 提案 P-001/, 'the proposal itself still follows');
  assert.match(s, /LF/, 'the line-ending rule');
  // the first build: no retry part
  assert.doesNotMatch(devPrompt(P, { branch: 'b', base: 'abcdef0', repo: 'x' }), /这是重试/);
});

test('.gitattributes keeps project-docs LF: a CRLF rewrite shows only what really changed', () => {
  const repo = makeRepo('eol');
  fs.copyFileSync(path.join(process.cwd(), '.gitattributes'), path.join(repo, '.gitattributes'));
  fs.mkdirSync(path.join(repo, 'docs', 'project-docs'), { recursive: true });
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
  fs.writeFileSync(path.join(repo, 'docs', 'project-docs', 'entries.json'), lines.join('\n') + '\n');
  git(['add', '-A'], repo);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'docs'], repo);
  // pdoc on Windows: the same lines in CRLF, one new at the end
  fs.writeFileSync(path.join(repo, 'docs', 'project-docs', 'entries.json'), [...lines, 'new entry'].join('\r\n') + '\r\n');
  git(['add', '-A'], repo);
  const stat = git(['diff', '--cached', '--numstat'], repo);
  assert.match(stat, /^1\s+0\s+docs\/project-docs\/entries\.json$/m, stat);
});
