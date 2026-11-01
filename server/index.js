import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { collectGit } from './collectors/git.js';
import { collectSessions } from './collectors/sessions.js';
import { collectUsage } from './collectors/usage.js';
import { collectHistory } from './collectors/history.js';
import { collectToday } from './collectors/today.js';
import { demoSessions } from './demo.js';
import { resumeSession } from './launch.js';
import { focusProcess } from './focus.js';
import { buildState, snooze } from './state.js';
import { WebSocketServer } from 'ws';
import { freezeRoster, loadRoster, planRestore, saveRoster } from './roster.js';
import { agentSupport, bindAgents, getAgent, killAgent, killAll, listAgents, onAgentsChange, removeAgent, resizeAgent, sendKey, sendText, spawnAgent, writeRaw } from './agents.js';

const STATIC = {
  '/web/': path.join(ROOT, 'web'),
  '/lib/xterm/': path.join(ROOT, 'node_modules', '@xterm', 'xterm'),
  '/lib/xterm-fit/': path.join(ROOT, 'node_modules', '@xterm', 'addon-fit'),
  '/lib/xterm-webgl/': path.join(ROOT, 'node_modules', '@xterm', 'addon-webgl'),
};
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

// MONITOR_DEMO=1: fake busy sessions; MONITOR_DEMO=empty: no sessions, to preview the resume list
const sessionsNow = { 1: demoSessions, empty: () => [] }[process.env.MONITOR_DEMO] || collectSessions;

let usage = null;
let gitByCwd = {};
let history = [];
let today = null;
let state = null;
let stateJson = '';
const clients = new Set();

function publish() {
  const sessions = sessionsNow();
  const running = new Map(sessions.map((s) => [s.sessionId, s.pid]));
  bindAgents(sessions);
  const agents = listAgents();
  saveRoster(agents); // after binding, so /clear'd agents are saved under their current session
  const live = agents.filter((a) => a.alive);
  const byPid = new Map(live.filter((a) => a.pid).map((a) => [a.pid, a.id]));
  const bySession = new Map(live.map((a) => [a.sessionId, a.id]));
  const base = buildState({ sessions, gitByCwd, usage });
  state = {
    ...base,
    // "owned": launched by the command center, so we can open its terminal (agentId) and type into it
    units: base.units.map((u) => {
      const agentId = byPid.get(u.pid) || bySession.get(u.sessionId) || null;
      return { ...u, owned: Boolean(agentId), agentId };
    }),
    history: history.map((h) => ({ ...h, pid: running.get(h.sessionId) ?? null, owned: bySession.has(h.sessionId), agentId: bySession.get(h.sessionId) || null })),
    agents,
    agentSupport: agentSupport(),
    today,
  };
  const json = JSON.stringify(state, (k, v) => (k === 'now' ? undefined : v));
  if (json === stateJson) return;
  stateJson = json;
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(payload);
}

async function refreshUsage(force = false) {
  usage = await collectUsage(force);
  publish();
}

let gitBusy = false;
async function refreshGit() {
  if (gitBusy) return;
  gitBusy = true;
  try {
    const sessions = sessionsNow();
    gitByCwd = await collectGit(sessions.map((s) => s.cwd));
    history = collectHistory();
    today = collectToday();
    publish();
  } finally {
    gitBusy = false;
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/web/index.html';
  if (pathname === '/widget' || pathname === '/pet') pathname = '/web/widget.html';
  if (pathname === '/term') pathname = '/web/term.html';
  const prefix = Object.keys(STATIC).find((p) => pathname.startsWith(p));
  if (!prefix) return false;
  const base = STATIC[prefix];
  const file = path.resolve(base, '.' + pathname.slice(prefix.length - 1));
  if (!file.startsWith(base + path.sep)) return false; // no escaping the served folders
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not_found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
  return true;
}

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(s || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  // Only same-origin pages may call the API: the data includes account email and project paths.
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${config.port}` && origin !== `http://localhost:${config.port}`) return send(res, 403, { error: 'forbidden' });

  if (req.method === 'GET' && req.url === '/api/state') {
    if (!state) publish(); // first request can arrive before the initial refresh finishes
    return send(res, 200, state);
  }
  if (req.method === 'GET' && req.url === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/focus') {
    const { pid } = await readBody(req);
    if (!state?.units.some((u) => u.pid === pid)) return send(res, 400, { error: 'unknown_pid' });
    return send(res, 200, await focusProcess(pid));
  }
  if (req.method === 'POST' && req.url === '/api/resume') {
    const { sessionId } = await readBody(req);
    // only sessions we listed ourselves: the id and folder come from our own scan, never the client
    const h = history.find((x) => x.sessionId === sessionId);
    if (!h) return send(res, 400, { error: 'unknown_session' });
    // already running: resuming again would fork it, so bring its terminal forward instead
    const live = state?.units.find((u) => u.sessionId === sessionId);
    if (live) return send(res, 200, { ...(await focusProcess(live.pid)), focused: true });
    return send(res, 200, await resumeSession(h.cwd, h.sessionId));
  }
  if (req.method === 'POST' && req.url === '/api/agents') {
    const { cwd, name, prompt, resume } = await readBody(req);
    try {
      let agent;
      if (resume) {
        // resume only sessions from our own scan, in the folder the transcript says
        const h = history.find((x) => x.sessionId === resume);
        if (!h) return send(res, 400, { error: '未知会话' });
        if (h.pid && !getAgent(resume)?.alive) return send(res, 409, { error: '这个会话正在外部终端里运行' });
        agent = spawnAgent({ cwd: h.cwd, resume, name, prompt });
      } else {
        agent = spawnAgent({ cwd: String(cwd || '').trim(), name: name ? String(name).trim() : undefined, prompt: prompt ? String(prompt) : undefined });
      }
      setTimeout(refreshGit, 4000); // pick up the new unit's repos without waiting for the next scan
      return send(res, 200, { ok: true, id: agent.id });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  if (req.method === 'POST' && req.url === '/api/agents/action') {
    const { id, action, text, key } = await readBody(req);
    const ids = Array.isArray(id) ? id : [id];
    const results = ids.map((one) => {
      const a = getAgent(one);
      if (!a) return false;
      if (action === 'text' && typeof text === 'string' && text.trim()) return sendText(a, text);
      if (action === 'key') return sendKey(a, key);
      if (action === 'kill') {
        killAgent(a);
        return true;
      }
      if (action === 'remove') return removeAgent(one);
      return false;
    });
    return send(res, 200, { ok: results.some(Boolean), results });
  }
  if (req.method === 'POST' && req.url === '/api/snooze') {
    const { key, minutes } = await readBody(req);
    if (typeof key !== 'string') return send(res, 400, { error: 'bad_key' });
    snooze(key, Math.min(Math.max(Number(minutes) || 10, 1), 24 * 60));
    publish();
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && req.url === '/api/refresh') {
    await Promise.all([refreshUsage(true), refreshGit()]);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && serveStatic(req, res)) return;
  send(res, 404, { error: 'not_found' });
});

// Terminal channel: /ws/agents/<id>. Output is raw terminal data; input arrives as JSON
// {type:'input', data} keystrokes or {type:'resize', cols, rows}.
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  const m = req.url.match(/^\/ws\/agents\/([0-9a-f-]{36})$/);
  const agent = m && getAgent(m[1]);
  if (!agent || (origin !== `http://127.0.0.1:${config.port}` && origin !== `http://localhost:${config.port}`)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.send(agent.buffer); // replay the screen so far
    agent.clients.add(ws);
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'input' && typeof msg.data === 'string') writeRaw(agent, msg.data);
      else if (msg.type === 'resize') resizeAgent(agent, msg.cols, msg.rows);
    });
    ws.on('close', () => agent.clients.delete(ws));
  });
});

onAgentsChange(() => publish());

// Agents are our child processes: end them with the app rather than leaving orphans.
export function shutdown() {
  freezeRoster(); // keep the roster as it was, so the next start restores these agents
  killAll();
}

// Bring back the agents the last run left behind (a quit, an update, or a crash).
async function restoreRoster() {
  const roster = loadRoster();
  if (!roster.length || !agentSupport().ok) return;
  const { resume, skipped, killed } = planRestore(roster, collectSessions());
  if (killed.length) await new Promise((r) => setTimeout(r, 1500)); // let the orphans release their sessions
  for (const r of resume) {
    try {
      spawnAgent({ cwd: r.cwd, resume: r.sessionId, name: r.name || undefined });
    } catch (e) {
      console.error('restore failed', r.cwd, e.message);
    }
  }
  console.log(`roster: restored ${resume.length}, cleaned ${killed.length} orphan(s), skipped ${skipped.length} running elsewhere`);
}

export function liveAgents() {
  return listAgents().filter((a) => a.alive);
}
process.on('exit', killAll);

export const url = `http://127.0.0.1:${config.port}`;

// Rejects with EADDRINUSE when another instance already serves the port.
export async function start() {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', resolve);
  });
  await restoreRoster();
  await Promise.all([refreshUsage(), refreshGit()]);
  setInterval(publish, config.intervals.sessions);
  setInterval(() => refreshUsage(), config.intervals.usage);
  setInterval(refreshGit, config.intervals.git);
  console.log(`FLEET//BRIDGE  ${url}`);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'server', 'index.js')) {
  start();
  process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
}
