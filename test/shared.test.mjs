// Shared working trees (improvement P-007, server/shared.js): agents in the same working tree are found
// (separate git worktrees are not the same tree), the master is told in fleet_status / fleet_send /
// fleet_spawn, and an order of the master's gets the standing rules after it, once per situation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeTree } from './_fs.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-shared-')));
process.env.MONITOR_DATA_DIR = path.join(tmp, 'data');
fs.mkdirSync(process.env.MONITOR_DATA_DIR);

// a stand-in for the Fleet Bridge server: the state the master's tools read, and what they post
const posts = [];
let stateNow = { units: [], agents: [] };
let spawnAnswer = { ok: true, id: 'new-agent' };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'POST') posts.push({ url: req.url, body: JSON.parse(body || '{}') });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/state') return res.end(JSON.stringify(stateNow));
    if (req.url === '/api/agents') return res.end(JSON.stringify(spawnAnswer));
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.FLEET_URL = `http://127.0.0.1:${server.address().port}`;
after(() => {
  server.close();
  removeTree(tmp);
});

const { SHARED_MARK, noteTold, resetShared, sharedGroups, sharedMembers, sharedNote, sharedOf, sharedOrder, treeKey, treeRoot, treesOf } = await import('../server/shared.js');
const { TOOLS } = createRequire(import.meta.url)('../server/fleet-mcp.cjs');
const tool = (name) => TOOLS.find((t) => t.name === name);
beforeEach(() => resetShared());

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
const same = (a, b) => assert.equal(treeKey(a), treeKey(b));

// a repository with a subfolder, a linked worktree of it next to it, and a plain folder
const repo = path.join(tmp, 'work', 'mdlink');
const wt = path.join(tmp, 'work', 'mdlink-p007');
const plain = path.join(tmp, 'notes');
fs.mkdirSync(path.join(repo, 'app', 'src'), { recursive: true });
fs.mkdirSync(plain);
fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
git(repo, 'init', '-q');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'first');
git(repo, 'worktree', 'add', '-q', '-b', 'improve/p-007', wt);

test('the working tree of a folder: the nearest .git at or above it', () => {
  same(treeRoot(repo), repo);
  same(treeRoot(path.join(repo, 'app', 'src')), repo);
  assert.equal(treeRoot(plain), null);
  assert.deepEqual(treesOf(plain), []);
  same(treesOf(path.join(repo, 'app'))[0], repo);
});

test('a linked git worktree is a tree of its own: agents in separate worktrees are not marked', () => {
  assert.ok(fs.statSync(path.join(wt, '.git')).isFile(), 'a worktree has a .git file');
  same(treeRoot(wt), wt);
  const groups = sharedGroups([
    { id: 'a1', name: 'main', cwd: repo },
    { id: 'a2', name: 'p007', cwd: wt },
  ]);
  assert.deepEqual(groups, []);
});

test('agents in one repository are grouped, whatever subfolder they started in', () => {
  const groups = sharedGroups([
    { id: 'a1', name: 'mdlinkapp', cwd: repo },
    { id: 'a2', name: 'mdlink-MagicAuth', cwd: path.join(repo, 'app') },
    { id: 'a3', name: 'p007', cwd: wt },
    { id: 'a4', name: 'elsewhere', cwd: plain },
  ]);
  assert.equal(groups.length, 1);
  same(groups[0].root, repo);
  assert.equal(groups[0].kind, 'repo');
  assert.deepEqual(groups[0].members.map((m) => m.id), ['a1', 'a2']);
  const of = sharedOf(groups);
  assert.deepEqual(of.get('a1').with, [{ id: 'a2', name: 'mdlink-MagicAuth', outside: false }]);
  assert.deepEqual(of.get('a2').with, [{ id: 'a1', name: 'mdlinkapp', outside: false }]);
  assert.equal(of.get('a3'), undefined);
  assert.equal(of.get('a4'), undefined);
});

test('a folder above repositories counts for each of them; outside a repository only the same folder counts', () => {
  const above = sharedGroups([
    { id: 'top', name: 'work', cwd: path.join(tmp, 'work') },
    { id: 'a1', name: 'mdlinkapp', cwd: repo },
    { id: 'a3', name: 'p007', cwd: wt },
  ]);
  assert.deepEqual(above.map((g) => g.members.map((m) => m.id)), [['top', 'a1'], ['top', 'a3']]);
  assert.deepEqual(sharedOf(above).get('top').with.map((x) => x.id), ['a1', 'a3']);
  assert.deepEqual(sharedOf(above).get('a1').with.map((x) => x.id), ['top'], 'the two worktrees still do not meet each other');

  const folders = sharedGroups(
    [
      { id: 'n1', name: 'n1', cwd: plain },
      { id: 'n2', name: 'n2', cwd: plain + path.sep },
      { id: 'n3', name: 'n3', cwd: path.join(plain, 'sub') },
      { id: 'out', name: 'outside', cwd: plain, outside: true },
    ],
    () => [],
  );
  assert.equal(folders.length, 1);
  assert.equal(folders[0].kind, 'folder');
  assert.deepEqual(folders[0].members.map((m) => [m.id, m.outside]), [['n1', false], ['n2', false], ['out', true]]);
});

test('one agent alone, or the same agent listed twice, is no group', () => {
  assert.deepEqual(sharedGroups([{ id: 'a1', name: 'x', cwd: repo }]), []);
  assert.deepEqual(sharedGroups([{ id: 'a1', name: 'x', cwd: repo }, { id: 'a1', name: 'x', cwd: repo }]), []);
  assert.deepEqual(sharedGroups([{ id: 'a1', name: 'x', cwd: '' }, { id: 'a2', name: 'y' }]), []);
});

test('who counts: our live Claude agents and outside sessions; no shell, no master, no ended one, no session of ours twice', () => {
  const agents = [
    { id: 'a1', kind: 'claude', name: 'mdlinkapp', cwd: 'C:/w/mdlink', alive: true },
    { id: 'a2', kind: 'claude', name: null, cwd: 'C:/w/mdlink/app', alive: true },
    { id: 'sh', kind: 'shell', name: 'ps', cwd: 'C:/w/mdlink', alive: true },
    { id: 'm', kind: 'master', name: '主控', cwd: 'C:/data/master', alive: true },
    { id: 'old', kind: 'claude', name: 'old', cwd: 'C:/w/mdlink', alive: false },
    { id: 'fresh', kind: 'claude', name: 'fresh', cwd: 'C:/w/new', alive: true }, // started, its session not bound to it yet
  ];
  const units = [
    { agentId: 'a1', owned: true, sessionId: 's1', name: 'mdlinkapp', cwd: 'C:/w/mdlink' },
    { agentId: 'a2', owned: true, sessionId: 's2', name: 'MagicAuth', cwd: 'C:/w/mdlink/app' },
    { agentId: 'm', owned: true, sessionId: 's0', name: '主控', cwd: 'C:/data/master' },
    { agentId: null, owned: false, sessionId: 's9', name: '', project: 'mdlink', cwd: 'C:/w/mdlink' },
    { agentId: null, owned: false, sessionId: 's8', name: 'fresh?', project: 'new', cwd: 'C:\\w\\new\\' },
    { agentId: null, owned: false, sessionId: 's7', name: 'another master', cwd: 'C:/data/master' },
  ];
  const members = sharedMembers({ agents, units, skip: (cwd) => cwd === 'C:/data/master' });
  assert.deepEqual(members, [
    { id: 'a1', name: 'mdlinkapp', cwd: 'C:/w/mdlink' },
    { id: 'a2', name: 'MagicAuth', cwd: 'C:/w/mdlink/app' },
    { id: 'fresh', name: 'fresh', cwd: 'C:/w/new' },
    { id: 'session:s9', name: 'mdlink', cwd: 'C:/w/mdlink', outside: true },
  ]);
  // and grouped: the two of ours and the outside session are in one tree
  const groups = sharedGroups(members, (cwd) => (cwd.startsWith('C:/w/mdlink') ? ['C:/w/mdlink'] : []));
  assert.deepEqual(groups.map((g) => g.members.map((m) => m.id)), [['a1', 'a2', 'session:s9']]);
});

const info = (...others) => ({ roots: ['C:/w/mdlink'], kind: 'repo', with: others.map((o) => (typeof o === 'string' ? { id: o, name: o, outside: false } : o)) });

test('the rules: after the order, naming who else is there and where', () => {
  const order = '【目标】只提交这些文件';
  const out = sharedOrder('a1', order, info('mdlink-MagicAuth', { id: 'session:s9', name: 'vscode', outside: true }));
  assert.ok(out.startsWith(order), 'the order itself stays first');
  const note = out.slice(order.length).trim();
  assert.ok(note.startsWith(SHARED_MARK));
  assert.equal(note, sharedNote(info('mdlink-MagicAuth', { id: 'session:s9', name: 'vscode', outside: true })));
  for (const part of ['mdlink-MagicAuth', 'vscode（舰桥外的会话）', 'C:/w/mdlink', '只改这条指令范围内的文件', '换行符', '不要还原、格式化或覆盖', '只 git add 自己改的文件', '不要用 git add -A', '先停下，在汇报里说明']) assert.ok(note.includes(part), part);
});

test('told once per situation: again only when who is there changes', () => {
  const first = sharedOrder('a1', '改 A', info('b'));
  assert.ok(first.includes(SHARED_MARK));
  assert.equal(sharedOrder('a1', '继续', info('b')), '继续', 'the same others: not again');
  assert.ok(sharedOrder('a2', '改 B', info('a1')).includes(SHARED_MARK), 'each agent is told for itself');
  assert.ok(sharedOrder('a1', '再改', info('b', 'c')).includes(SHARED_MARK), 'one more joined: told again');
  assert.equal(sharedOrder('a1', '继续', info('c', 'b')), '继续', 'the order of the others does not matter');
  // alone again, then not: told anew
  assert.equal(sharedOrder('a1', '继续', null), '继续');
  assert.ok(sharedOrder('a1', '改 C', info('b', 'c')).includes(SHARED_MARK));
});

test('never twice in one order, nothing for an empty order or an agent on its own', () => {
  const s = info('b');
  const once = sharedOrder('a1', '改 A', s);
  resetShared();
  assert.equal(sharedOrder('a1', once, s), once);
  assert.equal(sharedOrder('a1', '   ', s), '   ');
  assert.equal(sharedOrder('a9', '改', undefined), '改');
  assert.equal(sharedOrder('a9', '改', { roots: [], kind: 'repo', with: [] }), '改');
  // a new agent that got the rules with its first order is not told again by its next one
  noteTold('new-agent', s);
  assert.equal(sharedOrder('new-agent', '继续', s), '继续');
});

// ---- the master's tools ----
const shared = { roots: ['C:\\w\\mdlink'], kind: 'repo', with: [{ id: 'a2', name: 'mdlink-MagicAuth', outside: false }, { id: 'session:s9', name: 'vscode', outside: true }] };
const fleetState = () => ({
  units: [{ agentId: 'a1', status: 'idle' }, { agentId: 'a2', status: 'busy' }, { agentId: 'a3', status: 'idle' }],
  agents: [
    { id: 'a1', name: 'mdlinkapp', cwd: 'C:\\w\\mdlink', alive: true, shared },
    { id: 'a2', name: 'mdlink-MagicAuth', cwd: 'C:\\w\\mdlink', alive: true, shared: { ...shared, with: [{ id: 'a1', name: 'mdlinkapp', outside: false }] } },
    { id: 'a3', name: 'alone', cwd: 'C:\\w\\other', alive: true, shared: null },
  ],
});

test('fleet_status marks the agents that share a working tree, before any order is given', async () => {
  stateNow = fleetState();
  const out = await tool('fleet_status').run({});
  const block = (name) => out.split('\n- ').find((b) => b.startsWith(name));
  assert.match(block('mdlinkapp'), /SHARED working tree C:\\w\\mdlink with: mdlink-MagicAuth, vscode \(outside session\): they change the same files/);
  assert.match(block('mdlinkapp'), /needs the split \(who touches which files, who commits\)/);
  assert.match(block('mdlink-MagicAuth'), /SHARED working tree C:\\w\\mdlink with: mdlinkapp:/);
  assert.doesNotMatch(block('alone'), /SHARED/);
  assert.match(tool('fleet_status').description, /SHARED working tree.*separate git worktrees are not marked/);
});

test('fleet_send: the conflict is said with the split template; not for agents on their own or a read-only order', async () => {
  stateNow = fleetState();
  posts.length = 0;
  const out = await tool('fleet_send').run({ agents: ['mdlinkapp', 'mdlink-MagicAuth', 'alone'], text: '提交改动' });
  assert.deepEqual(posts.map((p) => [p.body.id, p.body.action, p.body.text, p.body.via]), [['a1', 'text', '提交改动', 'master'], ['a2', 'queue', '提交改动', 'master'], ['a3', 'text', '提交改动', 'master']], 'the order goes out as written: the server adds the rules');
  assert.match(out, /^mdlinkapp: sent\nmdlink-MagicAuth: queued\nalone: sent\n\n⚠ mdlinkapp shares the working tree C:\\w\\mdlink with: mdlink-MagicAuth, vscode \(outside session\)\.\n⚠ mdlink-MagicAuth shares the working tree C:\\w\\mdlink with: mdlinkapp\.\n/);
  assert.match(out, /Fleet Bridge has told each of them the general rules/);
  assert.match(out, /【分工】本指令只动：.*不要动：.*提交：由 .* 负责，只提交自己改的文件/);
  assert.doesNotMatch(out, /⚠ alone/);
  assert.equal(await tool('fleet_send').run({ agents: ['alone'], text: '提交改动' }), 'alone: sent');
  assert.equal(await tool('fleet_send').run({ agents: ['mdlinkapp'], text: '查一下', readonly: true }), 'mdlinkapp: sent (read-only limits added)');
  assert.match(tool('fleet_send').description, /shares its working tree with others.*gets the general rules from Fleet Bridge by itself, once.*who commits/);
});

test('fleet_spawn: a new agent in a working tree others work in is said, with whether its first order got the rules', async () => {
  stateNow = fleetState();
  spawnAnswer = { ok: true, id: 'new-agent', shared, sharedTold: true };
  const out = await tool('fleet_spawn').run({ cwd: 'C:\\w\\mdlink', prompt: '改登录页' });
  assert.match(out, /^started: id new-agent\n⚠ it shares the working tree C:\\w\\mdlink with: mdlink-MagicAuth, vscode \(outside session\)/);
  assert.match(out, /added the general rules to its first order/);
  assert.match(out, /【分工】/);
  assert.match(out, /a git worktree of its own avoids this/);
  spawnAnswer = { ok: true, id: 'new-agent', shared, sharedTold: false };
  assert.doesNotMatch(await tool('fleet_spawn').run({ cwd: 'C:\\w\\mdlink' }), /added the general rules/);
  spawnAnswer = { ok: true, id: 'new-agent', shared: null, sharedTold: false };
  assert.equal(await tool('fleet_spawn').run({ cwd: 'C:\\w\\other', prompt: '改' }), 'started: id new-agent');
});

test('the server: the state says who shares, and the master\'s orders get the rules where they come in', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  assert.match(src, /state\.shared = sharedNow\(\);/);
  assert.match(src, /shared: sharing\.get\(a\.id\) \|\| null/);
  // only the master's orders, not read-only ones, typed or queued; each agent of the call with its own text
  assert.match(src, /const sharing = via === 'master' && readonly !== true && \(action === 'text' \|\| action === 'queue'\) && typeof text === 'string' && text\.trim\(\) \? sharedOf\(sharedNow\(\)\) : null;/);
  assert.match(src, /if \(sharing && a\?\.alive && a\.kind === 'claude'\) text = sharedOrder\(a\.id, order, sharing\.get\(a\.id\)\);\s+else text = order;/);
  assert.match(src, /sharedGroups\(\[\.\.\.sharedMembers\(\{ agents: listAgents\(\), units: state\?\.units \|\| \[\], skip: isMasterCwd \}\), \.\.\.\(extra \? \[extra\] : \[\]\)\]\)/);
  // a new agent: told in the answer; its first order gets the rules when the master gave it and it may change files
  assert.match(src, /told = Boolean\(shared && prompt && via === 'master' && body\.readonly !== true && !String\(prompt\)\.includes\(SHARED_MARK\)\);/);
  assert.match(src, /if \(told\) noteTold\(agent\.id, shared\);/);
  assert.match(src, /send\(res, 200, \{ ok: true, id: agent\.id, shared, sharedTold: told \}\)/);
});

test('the page marks them at the terminal\'s title and in the list of terminals, in every language', async () => {
  const app = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(app, /innerHTML = ctxBadge\(u\) \+ sharedBadge\(a\) \+ repoBadge\(u\);/);
  assert.match(app, /\$\{sharedBadge\(a\)\}<\/span>\s+<span class="title">/);
  assert.match(app, /const s = a\?\.alive \? a\.shared : null;/, 'an ended terminal is not marked');
  const i18n = fs.readFileSync(path.join(ROOT, 'web', 'i18n.js'), 'utf8');
  for (const key of ['⚠ 共用仓库 · {0}', '⚠ 共用目录 · {0}', '{0}（舰桥外）']) assert.equal(i18n.split(`'${key}': `).length, 3, key);
});

test('the master\'s guide has the line, and the default before it is known as old', async () => {
  const { GUIDE, OLD_GUIDES } = await import('../server/master.js');
  const line = GUIDE.split('\n').find((l) => l.startsWith('- 共用仓库：'));
  assert.match(line, /SHARED working tree.*git worktree 分开的不算.*【分工】.*谁负责提交.*舰桥会自动附给它们一次/);
  assert.ok(!OLD_GUIDES.includes(GUIDE));
  // the default the shared line came in with: the one before the 待决定 line (test/pending.test.mjs)
  const without = GUIDE.split('\n').filter((l) => !l.startsWith('- 待决定：')).join('\n');
  assert.ok(OLD_GUIDES.includes(without), 'the default with it');
  assert.ok(OLD_GUIDES.includes(without.replace(line + '\n', '')), 'the default before this one');
});
