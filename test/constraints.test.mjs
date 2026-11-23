// Standing constraints (improvement P-008, server/constraints.js): the secrets rule in the system prompt of
// every agent Fleet Bridge starts, and the read-only switch of fleet_send / fleet_spawn that adds the limits
// to the order.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeTree } from './_fs.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-constraints-'));
process.env.MONITOR_DATA_DIR = tmp;

// a stand-in for the Fleet Bridge server: what the master's tools post to it
const posts = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'POST') posts.push({ url: req.url, body: JSON.parse(body || '{}') });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/state')
      return res.end(JSON.stringify({ units: [{ agentId: 'a1', status: 'idle' }, { agentId: 'a2', status: 'busy' }], agents: [{ id: 'a1', name: 'mdlinkapp', cwd: '/w/mdlinkapp', alive: true }, { id: 'a2', name: 'busy', cwd: '/w/busy', alive: true }] }));
    res.end(JSON.stringify({ ok: true, id: 'new-agent' }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.FLEET_URL = `http://127.0.0.1:${server.address().port}`;
after(() => {
  server.close();
  removeTree(tmp);
});

const { SECRET_HINT, READONLY_MARK, readOnlyNote, readOnlyOrder } = await import('../server/constraints.js');
const { systemHint } = await import('../server/agents.js');
const { REPORT_HINT } = await import('../server/report.js');
const { TOOLS } = createRequire(import.meta.url)('../server/fleet-mcp.cjs');
const tool = (name) => TOOLS.find((t) => t.name === name);

test('the secrets rule: values stay out of answers and reports, reading them is fine, an order can lift it', () => {
  assert.match(SECRET_HINT, /never put the value of an API key, token, password/);
  assert.match(SECRET_HINT, /answers, reports or commit messages/);
  assert.match(SECRET_HINT, /Reading and using them for the task is fine/);
  assert.match(SECRET_HINT, /first 4 characters/);
  assert.match(SECRET_HINT, /only exception is an order that explicitly asks/);
});

test('every agent Fleet Bridge starts has it in its system prompt, the master too', () => {
  for (const kind of [undefined, 'claude', 'master']) assert.ok(systemHint(kind).includes(SECRET_HINT), String(kind));
  assert.ok(systemHint('claude').includes(REPORT_HINT));
  assert.ok(!systemHint('master').includes(REPORT_HINT), 'the master reports to the user, not in a marked block');
  assert.match(systemHint('master'), /fleet-open/);
  const src = fs.readFileSync(path.join(ROOT, 'server', 'agents.js'), 'utf8');
  assert.match(src, /args\.push\('--append-system-prompt', systemHint\(kind\)\)/);
});

test('a read-only order: the limits come after the order, once', () => {
  const order = '【目标】查清 11-20 的登录失败是哪一层返回的';
  const ro = readOnlyOrder(order);
  assert.ok(ro.startsWith(order), 'the order itself stays first');
  assert.ok(ro.endsWith(readOnlyNote()));
  assert.ok(ro.includes(READONLY_MARK));
  for (const part of ['不修改代码和配置', '不提交、不 push', '不部署、不发布', '写进汇报当作建议']) assert.ok(ro.includes(part), part);
  assert.equal(readOnlyOrder(ro), ro, 'not added twice');
  assert.equal(readOnlyOrder('   '), '');
  assert.equal(readOnlyOrder(undefined), '');
});

test('fleet_send readonly: the switch goes to the server with the order, for sent and queued alike', async () => {
  assert.equal(tool('fleet_send').inputSchema.properties.readonly.type, 'boolean');
  assert.ok(!tool('fleet_send').inputSchema.required.includes('readonly'));
  assert.match(tool('fleet_send').description, /readonly: true/);
  assert.match(tool('fleet_send').description, /leave it off when the agent is to change something/);
  assert.match(tool('fleet_send').description, /secrets/);
  posts.length = 0;
  const out = await tool('fleet_send').run({ agents: ['mdlinkapp', 'busy'], text: '查一下', readonly: true });
  assert.deepEqual(posts.map((p) => [p.body.id, p.body.action, p.body.text, p.body.readonly]), [['a1', 'text', '查一下', true], ['a2', 'queue', '查一下', true]]);
  assert.match(out, /mdlinkapp: sent \(read-only limits added\)/);
  assert.match(out, /busy: queued \(read-only limits added\)/);
  // without it: an order as before
  posts.length = 0;
  const plain = await tool('fleet_send').run({ agents: ['mdlinkapp'], text: '改掉它' });
  assert.equal(posts[0].body.readonly, false);
  assert.equal(plain, 'mdlinkapp: sent');
});

test('fleet_spawn readonly: for the first order', async () => {
  assert.equal(tool('fleet_spawn').inputSchema.properties.readonly.type, 'boolean');
  assert.match(tool('fleet_spawn').description, /readonly: true/);
  posts.length = 0;
  const out = await tool('fleet_spawn').run({ cwd: '/w/x', prompt: '查一下', readonly: true });
  assert.equal(posts[0].url, '/api/agents');
  assert.equal(posts[0].body.readonly, true);
  assert.equal(posts[0].body.prompt, '查一下');
  assert.match(out, /read-only limits added to its first order/);
  assert.equal(await tool('fleet_spawn').run({ cwd: '/w/x', readonly: true }), 'started: id new-agent', 'no first order: nothing to add them to');
});

test('the server adds the limits where the order comes in: typed, queued, and a new agent\'s first order', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  assert.match(src, /if \(readonly === true && \(action === 'text' \|\| action === 'queue'\) && typeof text === 'string'\) text = readOnlyOrder\(text\);/);
  assert.match(src, /body\.readonly === true && body\.prompt \? readOnlyOrder\(body\.prompt\) : body\.prompt/);
});
