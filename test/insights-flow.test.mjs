// The whole way of a proposal (server/insights/improve.js) with stand-ins for the agent and the updater:
// proposed → approved → developed in a worktree → checked → built → the user's word → installed → rolled back;
// and the decisions that aren't allowed in a status.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { removeTree } from './_fs.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-flow-'));
const dataDir = path.join(tmp, 'data');
process.env.MONITOR_DATA_DIR = dataDir;
fs.mkdirSync(dataDir, { recursive: true });
const { initImprove, decide, improveTick, improveState, analyzeNow } = await import('../server/insights/improve.js');
const { createStore } = await import('../server/insights/proposals.js');
const { setImproveSettings } = await import('../server/insights/settings.js');
after(() => removeTree(tmp));

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const repo = path.join(tmp, 'FleetBridge');
fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fleet-bridge', version: '1.0.0' }) + '\n');
fs.writeFileSync(path.join(repo, 'test', 'ok.test.mjs'), "import { test } from 'node:test';\ntest('ok', () => {});\n");
git(['init', '-q', '-b', 'main'], repo);
git(['add', '-A'], repo);
git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], repo);

const notes = [];
const pushes = [];
const agents = new Map();
let units = [];
let updaterArgs = null;
const store = createStore(path.join(dataDir, 'proposals.json'));
initImprove({
  store,
  dataDir,
  port: 1,
  demo: true,
  repoCandidates: () => [path.join(tmp, 'nothing'), repo],
  transcriptOf: () => null,
  turnOver: () => true,
  turnReply: () => ({ reply: '[[FLEET-REPORT]]做完了[[/FLEET-REPORT]]' }),
  spawnAgent: (o) => {
    agents.set('dev1', { alive: true, o });
    return { id: 'dev1', sessionId: 'dev1' };
  },
  alive: (id) => Boolean(agents.get(id)?.alive),
  endAgent: (id) => agents.has(id) && (agents.get(id).alive = false),
  masterNote: (t) => notes.push(t),
  push: (m) => pushes.push(m),
  spawnProcess: (exe, args, o) => {
    updaterArgs = args;
    fs.writeSync(o.stdio[1], args.includes('--rollback') ? '✔ rolled back to 0.9.72-1; terminals still running: 2/2\n' : '✔ now running 0.9.74-1; terminals still running: 2/2\n');
    return { unref() {} };
  },
});
const wait = async (cond) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
};

test('proposed → approved → built → installed → rolled back, the user told at each step', async () => {
  setImproveSettings({ push: true });
  const p = store.merge([{ fingerprint: 'x', title: '一个提案', finding: 'f', change: 'c', benefit: 'b', effort: 'S', risk: 'r', evidence: [{ ref: 'event:x' }] }]).added[0];
  await assert.rejects(decide(p.id, 'install'), /not_allowed/);
  await decide(p.id, 'approve', '', 'user');
  assert.equal(store.get(p.id).status, 'implementing');
  const impl = store.get(p.id).impl;
  assert.equal(agents.get('dev1').o.cwd, impl.worktree);
  await assert.rejects(decide(store.merge([{ fingerprint: 'y', title: '另一个完全无关的提案', evidence: [] }]).added[0].id, 'approve'), /busy_implementing/, 'one at a time');
  // the agent works, commits, ends its turn
  units = [{ agentId: 'dev1', status: 'busy' }];
  improveTick(units, new Set());
  fs.writeFileSync(path.join(impl.worktree, 'x.js'), 'export default 1;\n');
  git(['add', '-A'], impl.worktree);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], impl.worktree);
  units = [{ agentId: 'dev1', status: 'idle' }];
  improveTick(units, new Set());
  await wait(() => store.get(p.id).status !== 'implementing');
  assert.equal(store.get(p.id).status, 'built', JSON.stringify(store.get(p.id).impl.result));
  assert.match(notes.at(-1), /开发完成/);
  assert.match(store.get(p.id).impl.reply, /做完了/);
  assert.equal(improveState().waiting, 1);
  // the user says update
  await decide(p.id, 'install', '', 'user');
  assert.equal(store.get(p.id).status, 'installing');
  assert.ok(updaterArgs.includes('--from') && updaterArgs.includes(impl.worktree));
  assert.ok(updaterArgs[0].startsWith(impl.worktree), 'the worktree\'s own update.mjs');
  improveTick([], new Set());
  assert.equal(store.get(p.id).status, 'installed');
  assert.match(notes.at(-1), /已就地更新到 0\.9\.74-1/);
  await decide(p.id, 'rollback', '', 'user');
  assert.ok(updaterArgs.includes('--rollback'));
  improveTick([], new Set());
  assert.equal(store.get(p.id).status, 'rolled-back');
  assert.ok(pushes.length >= 3, 'pushed');
  // discard: the worktree and branch go
  await decide(p.id, 'discard', '', 'user');
  assert.ok(!fs.existsSync(impl.worktree));
  assert.equal(store.get(p.id).history.map((h) => h.action).join(' '), 'proposed approved implementing built installing installed rolling-back rolled-back discarded');
});

test('reject keeps the reason; later; an analysis with the feature on (rules only)', async () => {
  const p = store.merge([{ fingerprint: 'z', title: '第三个提案', evidence: [] }]).added[0];
  await decide(p.id, 'reject', '没必要', 'master');
  assert.equal(store.get(p.id).decision.note, '没必要');
  assert.equal(store.get(p.id).decision.by, 'master');
  await assert.rejects(decide('P-999', 'approve'), /unknown_proposal/);
  setImproveSettings({ llm: false });
  const r = await analyzeNow('user');
  assert.equal(r.model, 'off');
  assert.ok(store.lastAnalysis().at > 0);
});

test('retry: the second development agent is told the note and why the first build failed', async () => {
  const p = store.merge([{ fingerprint: 'retry', title: '要重试的提案', finding: 'f', change: 'c', benefit: 'b', effort: 'S', risk: 'r', evidence: [{ ref: 'event:x' }] }]).added[0];
  await decide(p.id, 'approve', '', 'user');
  improveTick([{ agentId: 'dev1', status: 'busy' }], new Set());
  improveTick([{ agentId: 'dev1', status: 'idle' }], new Set()); // its turn ends with nothing changed
  await wait(() => store.get(p.id).status !== 'implementing');
  assert.equal(store.get(p.id).status, 'failed');
  assert.equal(store.get(p.id).impl.result.reason, 'no-changes');
  await decide(p.id, 'retry', '请把 docs 的换行改回 LF', 'master');
  const prompt = agents.get('dev1').o.prompt;
  assert.match(prompt, /^## 这是重试/);
  assert.match(prompt, /请把 docs 的换行改回 LF/);
  assert.match(prompt, /相对基线没有任何改动/);
  await decide(p.id, 'discard', '', 'user');
});
