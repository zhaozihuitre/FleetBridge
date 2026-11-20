// The master's tools after an in-place update (server/fleet-mcp.cjs, master.js refreshMcpScript): the copy is
// written again by the new server, and the MCP process that is already running takes its tools from it on
// its next call, without the master being restarted (fleet_status had lost its model and quota line).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'server', 'fleet-mcp.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-mcp-'));
process.env.MONITOR_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function client(file) {
  const p = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  const msgs = [];
  const waiting = [];
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      msgs.push(m);
      for (const w of [...waiting]) if (w.test(m)) (waiting.splice(waiting.indexOf(w), 1), w.resolve(m));
    }
  });
  let id = 0;
  const call = (method, params) =>
    new Promise((resolve) => {
      const my = ++id;
      waiting.push({ test: (m) => m.id === my, resolve });
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n');
    });
  return { call, msgs, close: () => p.stdin.end() };
}

test('a running MCP process takes the new tools when its file is rewritten', async () => {
  const file = path.join(tmp, 'fleet-mcp.cjs');
  fs.copyFileSync(SRC, file);
  const c = client(file);
  try {
    const init = await c.call('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(init.result.capabilities.tools.listChanged, true);
    const before = (await c.call('tools/list')).result.tools.map((t) => t.name);
    assert.ok(before.includes('fleet_status'));
    assert.ok(!before.includes('fleet_probe'));
    assert.match((await c.call('tools/call', { name: 'fleet_probe', arguments: {} })).error.message, /unknown tool/);
    // the update: a new version of the file, with one more tool
    const next = fs.readFileSync(SRC, 'utf8').replace('const TOOLS = [', "const TOOLS = [\n  { name: 'fleet_probe', description: 'test', inputSchema: { type: 'object' }, async run() { return 'probe from the new file'; } },");
    fs.writeFileSync(file, next);
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(file, t, t);
    const r = await c.call('tools/call', { name: 'fleet_probe', arguments: {} });
    assert.equal(r.result.content[0].text, 'probe from the new file');
    assert.ok(c.msgs.some((m) => m.method === 'notifications/tools/list_changed'), 'the client is told the list changed');
    assert.ok((await c.call('tools/list')).result.tools.some((t) => t.name === 'fleet_probe'));
    // a broken copy (half-written): the tools there are stay
    fs.writeFileSync(file, 'const TOOLS = [ this is not javascript');
    const t2 = new Date(Date.now() + 10_000);
    fs.utimesSync(file, t2, t2);
    assert.ok((await c.call('tools/list')).result.tools.some((t) => t.name === 'fleet_probe'));
  } finally {
    c.close();
  }
});

test('the server writes the copy when it differs, and only then', async () => {
  const { refreshMcpScript } = await import('../server/master.js');
  const copy = path.join(tmp, 'fleet-mcp.cjs');
  fs.writeFileSync(copy, '// an old version without the quota line');
  assert.equal(refreshMcpScript(), true);
  assert.equal(fs.readFileSync(copy, 'utf8'), fs.readFileSync(SRC, 'utf8'));
  const at = fs.statSync(copy).mtimeMs;
  assert.equal(refreshMcpScript(), false, 'the same: not written (its time stays, no reload)');
  assert.equal(fs.statSync(copy).mtimeMs, at);
  assert.match(fs.readFileSync(copy, 'utf8'), /quota \$\{u\.quota\.label\}/, 'the model and quota line of fleet_status');
});
