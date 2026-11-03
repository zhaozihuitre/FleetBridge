// MCP server (stdio) for the master console: a Claude Code session that commands the other agents.
// It runs as its own process (Electron's node, or plain node) and drives Fleet Bridge through the
// local HTTP API, so the master sees and does what the command center can, nothing more.
// Protocol: newline-delimited JSON-RPC 2.0; only what Claude Code uses (initialize, tools/*, ping).
const BASE = process.env.FLEET_URL || 'http://127.0.0.1:8787';

async function api(path, body) {
  const res = await fetch(BASE + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const short = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};
const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
const ago = (t) => {
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

// Our agents (we can type into them) with what their session says about them.
async function fleet() {
  const st = await api('/api/state');
  const units = new Map(st.units.filter((u) => u.agentId).map((u) => [u.agentId, u]));
  const ours = st.agents
    .filter((a) => a.alive && a.kind !== 'master')
    .map((a) => {
      const u = units.get(a.id);
      const status = a.kind === 'shell' ? 'shell' : !u ? 'starting' : u.permission ? 'needs-approval' : u.status === 'busy' ? 'working' : 'idle';
      return { a, u, status, name: a.name || u?.name || base(a.cwd), project: base(a.cwd) };
    });
  return { st, ours };
}

// "agent" may be an id (or its first 8 characters), a name, or a project folder name.
function resolve(ours, ref) {
  const r = String(ref || '').trim().toLowerCase();
  if (!r) throw new Error('agent is required');
  const hits = (f) => ours.filter(f);
  for (const f of [(x) => x.a.id.toLowerCase() === r, (x) => x.a.id.toLowerCase().startsWith(r) && r.length >= 4, (x) => x.name.toLowerCase() === r, (x) => x.project.toLowerCase() === r, (x) => x.name.toLowerCase().includes(r) || x.project.toLowerCase().includes(r)]) {
    const h = hits(f);
    if (h.length === 1) return h[0];
    if (h.length > 1) throw new Error(`"${ref}" matches several agents: ${h.map((x) => `${x.name} (${x.a.id.slice(0, 8)})`).join(', ')}. Use the id.`);
  }
  throw new Error(`no live agent matches "${ref}". Call fleet_status to see them.`);
}

const TOOLS = [
  {
    name: 'fleet_status',
    description: 'List every live agent under Fleet Bridge command: id, name, project folder, state (working / idle / needs-approval / starting / shell), queued orders, last order and its latest reply, context use. Also lists Claude Code sessions running outside Fleet Bridge (read-only). Call this first.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const { st, ours } = await fleet();
      const lines = ours.map(({ a, u, status, name, project }) => {
        const out = [`- ${name} [${a.id.slice(0, 8)}] ${project} · ${status}${u?.statusSince ? ' ' + ago(u.statusSince) : ''}${a.queue?.length ? ` · ${a.queue.length} queued` : ''}${u?.contextPct != null ? ` · ctx ${u.contextPct}%` : ''}`, `  cwd: ${a.cwd}`];
        if (u?.permission) out.push(`  asks: ${short(u.permission.prompt?.text || u.permission.message, 300)}`, `  options: ${(u.permission.prompt?.options || []).map((o) => `${o.key}=${o.label}`).join(' | ')}`);
        if (u?.lastPrompt) out.push(`  last order: ${short(u.lastPrompt, 200)}`);
        if (u?.lastText) out.push(`  last reply: ${short(u.lastText, 300)}`);
        return out.join('\n');
      });
      const outside = st.units.filter((u) => !u.owned).map((u) => `- ${u.name || u.project} · ${u.status} · ${u.cwd} (outside Fleet Bridge: read-only)`);
      return [`Our agents (${ours.length}):`, ...(lines.length ? lines : ['(none: use fleet_spawn)']), ...(outside.length ? ['', `Outside sessions (${outside.length}):`, ...outside] : [])].join('\n');
    },
  },
  {
    name: 'fleet_read_screen',
    description: "Read an agent's terminal screen as text: what it is doing right now, a question or menu it shows, an error. agent = id, name or project.",
    inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] },
    async run({ agent }) {
      const { ours } = await fleet();
      const x = resolve(ours, agent);
      const { lines } = await api(`/api/agents/screen?id=${encodeURIComponent(x.a.id)}`);
      return `${x.name} [${x.a.id.slice(0, 8)}] screen:\n${(lines || []).join('\n') || '(blank)'}`;
    },
  },
  {
    name: 'fleet_send',
    description: 'Give an order (a prompt) to one or more agents, typed into their Claude Code as if the user wrote it. mode "auto" (default): idle agents get it now, working ones get it queued and sent when they finish their turn. "now": type it in immediately even if working. "queue": always queue. agents = list of ids / names / projects, or ["all"].',
    inputSchema: { type: 'object', properties: { agents: { type: 'array', items: { type: 'string' } }, text: { type: 'string' }, mode: { type: 'string', enum: ['auto', 'now', 'queue'] } }, required: ['agents', 'text'] },
    async run({ agents, text, mode = 'auto' }) {
      const { ours } = await fleet();
      const list = agents?.length === 1 && String(agents[0]).toLowerCase() === 'all' ? ours.filter((x) => x.status !== 'shell') : (agents || []).map((r) => resolve(ours, r));
      if (!list.length) throw new Error('no agents to send to');
      const out = [];
      for (const x of list) {
        const queue = mode === 'queue' || (mode === 'auto' && (x.status === 'working' || x.status === 'needs-approval' || x.a.queue?.length));
        const r = await api('/api/agents/action', { id: x.a.id, action: queue ? 'queue' : 'text', text, via: 'master' });
        out.push(`${x.name}: ${r.ok ? (queue ? 'queued' : 'sent') : 'failed'}`);
      }
      return out.join('\n');
    },
  },
  {
    name: 'fleet_answer',
    description: "Answer the permission prompt an agent is waiting on, by option number (see fleet_status 'options'; usually 1 = yes, 2 = yes and don't ask again, 3 = no). Only after the user agreed, unless the request is plainly harmless.",
    inputSchema: { type: 'object', properties: { agent: { type: 'string' }, choice: { type: 'string' } }, required: ['agent', 'choice'] },
    async run({ agent, choice }) {
      const { ours } = await fleet();
      const x = resolve(ours, agent);
      const r = await api('/api/agents/action', { id: x.a.id, action: 'answer', choice: String(choice), via: 'master' });
      return `${x.name}: ${r.ok ? `answered ${choice}` : 'failed (no prompt showing?)'}`;
    },
  },
  {
    name: 'fleet_key',
    description: 'Press a key in an agent\'s terminal: "esc" interrupts its current turn or closes a menu; also enter, up, down, tab, shift-tab, ctrl-c.',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' }, key: { type: 'string', enum: ['esc', 'enter', 'up', 'down', 'tab', 'shift-tab', 'ctrl-c'] } }, required: ['agent', 'key'] },
    async run({ agent, key }) {
      const { ours } = await fleet();
      const x = resolve(ours, agent);
      const r = await api('/api/agents/action', { id: x.a.id, action: 'key', key, via: 'master' });
      return `${x.name}: ${r.ok ? `pressed ${key}` : 'failed'}`;
    },
  },
  {
    name: 'fleet_unqueue',
    description: "Remove queued orders of an agent: one by its 0-based index, or all when index is omitted.",
    inputSchema: { type: 'object', properties: { agent: { type: 'string' }, index: { type: 'integer' } }, required: ['agent'] },
    async run({ agent, index }) {
      const { ours } = await fleet();
      const x = resolve(ours, agent);
      const r = await api('/api/agents/action', { id: x.a.id, action: 'unqueue', index: Number.isInteger(index) ? index : undefined, via: 'master' });
      return `${x.name}: ${r.ok ? 'removed' : 'failed'}`;
    },
  },
  {
    name: 'fleet_projects',
    description: 'Project folders Claude Code has been used in (most recent first), to pick a cwd for fleet_spawn or a session to resume.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const st = await api('/api/state');
      const seen = new Map();
      for (const h of st.history || []) if (!seen.has(h.cwd)) seen.set(h.cwd, h);
      return [...seen.values()].slice(0, 40).map((h) => `- ${h.cwd} · last ${ago(h.updatedAt)} ago${h.title ? ' · ' + short(h.title, 80) : ''} · session ${h.sessionId}`).join('\n') || '(none)';
    },
  },
  {
    name: 'fleet_spawn',
    description: 'Start a new Claude Code agent in a folder (it opens in the command center), optionally with a name and a first order. resume = a session id from fleet_projects to continue that session instead.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string' }, name: { type: 'string' }, prompt: { type: 'string' }, resume: { type: 'string' } } },
    async run({ cwd, name, prompt, resume }) {
      const r = await api('/api/agents', { cwd, name, prompt, resume });
      return `started: id ${r.id}`;
    },
  },
];

function reply(id, result, error) {
  process.stdout.write(JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications
  if (method === 'initialize')
    return reply(id, { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fleet', version: '1.0.0' } });
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return reply(id, null, { code: -32602, message: `unknown tool ${params?.name}` });
    try {
      return reply(id, { content: [{ type: 'text', text: await tool.run(params.arguments || {}) }] });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
    }
  }
  reply(id, null, { code: -32601, message: `method not found: ${method}` });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // not JSON: ignore
    }
  }
});
process.stdin.on('end', () => process.exit(0));
