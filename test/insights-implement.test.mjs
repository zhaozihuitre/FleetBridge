// Building an approved proposal (server/insights/implement.js) on a real, throwaway git repository:
// the worktree on its own branch, the development agent's settings, the checks after it, removing it all.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-impl-'));
process.env.MONITOR_DATA_DIR = path.join(tmp, 'data');
fs.mkdirSync(process.env.MONITOR_DATA_DIR, { recursive: true });
const { startImpl, finishImpl, followImpl, discardImpl, needsInstaller, updateResult, findRepo, isFleetRepo, devPrompt, DENY } = await import('../server/insights/implement.js');
after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }));

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
