import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { config, DATA_DIR, ROOT } from './config.js';
import { collectGit } from './collectors/git.js';
import { collectSessions } from './collectors/sessions.js';
import { collectUsage, limitLabel, withStatusline } from './collectors/usage.js';
import { getLang, L, setLang } from './i18n.js';
import { collectHistory, historyFiles } from './collectors/history.js';
import { searchSessions } from './search.js';
import { changes, commit, diff, pushRepo } from './gitops.js';
import { collectToday } from './collectors/today.js';
import { buildOffline, offlineSessions } from './offline.js';
import { forecast, recordUsage } from './forecast.js';
import { dequeue, dispatch, enqueue, queueOf } from './queue.js';
import { mobileInfo, phoneUrl, setMobile, startMobile, stopMobile } from './mobile.js';
import { pushInfo, pushQuests, setPush, testPush } from './push.js';
import { screenHtml } from './screenhtml.js';
import { demoSessions } from './demo.js';
import { resumeSession } from './launch.js';
import { focusProcess } from './focus.js';
import { buildState, snooze } from './state.js';
import { WebSocketServer } from 'ws';
import { freezeRoster, loadRoster, planRestore, saveRoster } from './roster.js';
import { STATUSLINE_USAGE, agentSupport, answerPrompt, bindAgents, getAgent, permissionPrompt, screenLines, menuOptions, killAgent, killAll, listAgents, onAgentsChange, removeAgent, resizeAgent, sendKey, sendText, spawnAgent, writeRaw } from './agents.js';

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
let offlineGit = {}; // git of offline projects: rescanned every 2 minutes, not every 30 s
let offlineGitAt = 0;
// Offline cards change rarely: rebuilt when the set of offline sessions changes or every 30 s,
// not on each 3 s publish (that stat-ed 16 transcripts every time).
let offlineCache = { key: null, at: 0, cards: [] };
function offlineCards(sessions) {
  const list = offlineSessions(history, sessions.map((s) => s.cwd));
  const key = list.map((h) => h.sessionId).join(',');
  if (key !== offlineCache.key || Date.now() - offlineCache.at > 30_000) {
    offlineCache = { key, at: Date.now(), cards: buildOffline(list, { ...offlineGit, ...gitByCwd }) };
  }
  return offlineCache.cards;
}
let state = null;
const promptSeen = new Map(); // agent id -> when its current permission dialog was first seen
function promptSince(id) {
  if (!promptSeen.has(id)) promptSeen.set(id, Date.now());
  return promptSeen.get(id);
}
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
  // Our agents waiting on a permission dialog: what it asks, read off their screens so it can be answered
  // here. The screen alone also raises the reminder, for when no Notification hook fired (hooks can fail).
  const prompts = new Map();
  for (const s of sessions) {
    const id = byPid.get(s.pid) || bySession.get(s.sessionId);
    const prompt = id ? permissionPrompt(getAgent(id)) : null;
    if (!prompt) {
      promptSeen.delete(id);
      continue;
    }
    prompts.set(s.sessionId, prompt);
    s.permission ||= { at: promptSince(id), message: prompt.text.split('\n')[0] };
  }
  const merged = withStatusline(usage, STATUSLINE_USAGE);
  recordUsage(merged); // readings from the status line feed the burn forecast too
  const view = merged && { ...merged, limits: merged.limits?.map((l) => ({ ...l, label: limitLabel(l.key) })) };
  const fc = forecast(view?.limits);
  const base = buildState({ sessions, gitByCwd, usage: view, forecast: fc });
  state = {
    ...base,
    // "owned": launched by the command center, so we can open its terminal (agentId) and type into it
    units: base.units.map((u) => {
      const agentId = byPid.get(u.pid) || bySession.get(u.sessionId) || null;
      const prompt = prompts.get(u.sessionId) || null;
      return { ...u, owned: Boolean(agentId), agentId, permission: u.permission && { ...u.permission, prompt } };
    }),
    history: history.map((h) => ({ ...h, pid: running.get(h.sessionId) ?? null, owned: bySession.has(h.sessionId), agentId: bySession.get(h.sessionId) || null })),
    // projects with nothing running: their latest session, as cards after the live units
    offline: offlineCards(sessions),
    agents: agents.map((a) => ({ ...a, queue: queueOf(a.id) })),
    agentSupport: agentSupport(),
    today,
    forecast: fc,
    lang: getLang(),
  };
  // queued orders: the next one goes to each of our agents that has finished its turn
  dispatch(state.units.filter((u) => u.owned), (id, text) => sendText(getAgent(id), text));
  // phone push: whatever needs you, whether or not anyone is looking at a screen
  pushQuests(state.quests, phoneUrl());
  const json = JSON.stringify(state, (k, v) => (k === 'now' ? undefined : v));
  if (json === stateJson) return;
  stateJson = json;
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(payload);
}

async function refreshUsage(force = false) {
  usage = await collectUsage(force);
  recordUsage(usage);
  publish();
}

let gitBusy = false;
async function refreshGit() {
  if (gitBusy) return;
  gitBusy = true;
  try {
    const sessions = sessionsNow();
    gitByCwd = await collectGit(sessions.map((s) => s.cwd));
    history = await collectHistory();
    today = await collectToday();
    const off = offlineSessions(history, sessions.map((s) => s.cwd)).map((h) => h.cwd);
    if (Date.now() - offlineGitAt > 120_000 || off.some((c) => !(c in offlineGit))) {
      offlineGit = await collectGit(off);
      offlineGitAt = Date.now();
    }
    offlineCache.at = 0; // fresh git and history: rebuild the offline cards on this publish
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

/** One action for one or more of our agents; shared by the command center and the phone page. */
function agentAction({ id, action, text, key, choice, index }) {
  const ids = Array.isArray(id) ? id : [id];
  const results = ids.map((one) => {
    const a = getAgent(one);
    if (!a) return false;
    if (action === 'text' && typeof text === 'string' && text.trim()) return sendText(a, text);
    if (action === 'key') return sendKey(a, key);
    if (action === 'answer') return answerPrompt(a, String(choice));
    if (action === 'queue' && typeof text === 'string' && text.trim()) {
      enqueue(a.id, text.trim());
      return true;
    }
    if (action === 'unqueue') {
      dequeue(a.id, Number.isInteger(index) ? index : null);
      return true;
    }
    if (action === 'kill') {
      killAgent(a);
      return true;
    }
    if (action === 'remove') return removeAgent(one);
    return false;
  });
  return { ok: results.some(Boolean), results };
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
        if (!h) return send(res, 400, { error: L('未知会话', 'Unknown session', '不明なセッション') });
        if (h.pid && !getAgent(resume)?.alive) return send(res, 409, { error: L('这个会话正在外部终端里运行', 'This session is running in an outside terminal', 'このセッションは外部ターミナルで実行中です') });
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
  if (req.method === 'POST' && req.url === '/api/agents/action') return send(res, 200, agentAction(await readBody(req)));
  // phone access (on / off, new key, QR): only from this computer
  if (req.url === '/api/mobile') return send(res, 200, req.method === 'POST' ? await setMobile(await readBody(req)) : await mobileInfo());
  // phone push (ntfy): on / off, new channel, a test message
  if (req.url === '/api/push') return send(res, 200, req.method === 'POST' ? await setPush(await readBody(req)) : await pushInfo());
  if (req.method === 'POST' && req.url === '/api/push/test') return send(res, 200, await testPush(phoneUrl()));
  // Review / commit / push: only repos the git collector found (live and offline projects).
  if (req.url.startsWith('/api/git/')) {
    const url = new URL(req.url, 'http://localhost');
    const body = req.method === 'POST' ? await readBody(req) : {};
    const repo = url.searchParams.get('repo') || body.repo;
    const known = Object.values({ ...offlineGit, ...gitByCwd }).flat().some((r) => r.path === repo);
    if (!known) return send(res, 404, { error: L('不认识这个仓库', 'Unknown repository', '不明なリポジトリ') });
    try {
      if (req.method === 'GET' && url.pathname === '/api/git/changes') return send(res, 200, { files: await changes(repo) });
      if (req.method === 'GET' && url.pathname === '/api/git/diff') return send(res, 200, { diff: await diff(repo, url.searchParams.get('file') || '', url.searchParams.get('status') || '') });
      if (req.method === 'POST' && url.pathname === '/api/git/commit') {
        const message = String(body.message || '').trim();
        if (!message) return send(res, 400, { error: L('提交说明不能为空', 'The commit message is empty', 'コミットメッセージが空です') });
        const output = await commit(repo, message, Boolean(body.push));
        refreshGit(); // the cards show the new state right away
        return send(res, 200, { ok: true, output });
      }
      if (req.method === 'POST' && url.pathname === '/api/git/push') {
        const output = await pushRepo(repo);
        refreshGit();
        return send(res, 200, { ok: true, output });
      }
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
    return send(res, 404, { error: 'not_found' });
  }
  if (req.method === 'GET' && req.url.startsWith('/api/search?')) {
    const q = (new URL(req.url, 'http://localhost').searchParams.get('q') || '').trim().slice(0, 200);
    if (q.length < 2) return send(res, 400, { error: 'query_too_short' });
    const files = history.filter((h) => historyFiles.has(h.sessionId)).map((h) => ({ sessionId: h.sessionId, file: historyFiles.get(h.sessionId) }));
    try {
      const results = await searchSessions(files, q);
      return send(res, 200, { q, results });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }
  // Saved prompts (the console's library): a plain list in the data folder.
  if (req.url === '/api/prompts') {
    const file = path.join(DATA_DIR, 'prompts.json');
    if (req.method === 'POST') {
      const { list } = await readBody(req);
      if (!Array.isArray(list)) return send(res, 400, { error: 'bad_list' });
      const clean = list.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.slice(0, 4000)).slice(0, 100);
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(clean, null, 2));
      return send(res, 200, { list: clean });
    }
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // none saved yet
    }
    return send(res, 200, { list });
  }
  if (req.method === 'POST' && req.url === '/api/lang') {
    const { lang } = await readBody(req);
    setLang(lang);
    publish(); // reminders and operator lines are rebuilt in the new language
    return send(res, 200, { ok: true, lang: getLang() });
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
  stopMobile();
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
  await startMobile({ clients, getState: () => state, action: agentAction, screen: (id) => {
    const a = getAgent(id);
    return { html: screenHtml(a?.screen), menu: a ? menuOptions(a) : [] };
  } });
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
