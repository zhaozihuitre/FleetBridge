import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { config, DATA_DIR, DEV, DEV_PREFIX, ROOT } from './config.js';
import { collectGit } from './collectors/git.js';
import { collectSessions } from './collectors/sessions.js';
import { collectUsage, limitLabel, withStatusline } from './collectors/usage.js';
import { getLang, getTheme, L, setLang, setTheme } from './i18n.js';
import { collectHistory, historyFiles } from './collectors/history.js';
import { searchSessions } from './search.js';
import { changes, commit, diff, pushRepo } from './gitops.js';
import { collectToday } from './collectors/today.js';
import { buildOffline, offlineSessions } from './offline.js';
import { forecast, recordUsage } from './forecast.js';
import { dequeue, dispatch, enqueue, queueOf } from './queue.js';
import { clip, endedTurns, masterTurn, noteOrder, turnReply } from './turns.js';
import { hostInfo } from './ptyclient.js';
import { mobileInfo, phoneUrl, setMobile, startMobile, stopMobile } from './mobile.js';
import { pushInfo, pushQuests, setPush, testPush } from './push.js';
import { screenHtml } from './screenhtml.js';
import { demoSessions } from './demo.js';
import { resumeSession } from './launch.js';
import { focusProcess } from './focus.js';
import { buildState, snooze } from './state.js';
import { WebSocketServer } from 'ws';
import { freezeRoster, loadRoster, planRestore, rosterRestored, saveRoster } from './roster.js';
import { recordOrder, recentOrders } from './orders.js';
import { adoptMaster, isMasterCwd, masterInfo, masterTurnDone, masterWanted, notifyMaster, startMaster, stopMaster, trackMaster } from './master.js';
import { STATUSLINE_USAGE, agentSupport, answerPrompt, bindAgents, getAgent, permissionPrompt, questionPrompt, trustPrompt, screenLines, menuOptions, killAgent, endAgent, killAll, attachHost, listAgents, onAgentsChange, removeAgent, resizeAgent, sendKey, sendText, spawnAgent, spawnShell, writeRaw } from './agents.js';

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
  // the installed app leaves out the sessions of a dev run (its agents are named dev·…)
  const everything = DEV ? sessionsNow() : sessionsNow().filter((s) => !String(s.name || '').startsWith(DEV_PREFIX));
  bindAgents(everything);
  trackMaster();
  // the master console's own session isn't part of the fleet: no unit, no reminders
  const sessions = everything.filter((s) => !isMasterCwd(s.cwd));
  const running = new Map(sessions.map((s) => [s.sessionId, s.pid]));
  const all = listAgents();
  const agents = all.filter((a) => a.kind !== 'shell' && a.kind !== 'master'); // plain shells aren't agents: no unit, no roster
  saveRoster(agents); // after binding, so /clear'd agents are saved under their current session
  const live = agents.filter((a) => a.alive);
  const byPid = new Map(live.filter((a) => a.pid).map((a) => [a.pid, a.id]));
  const bySession = new Map(live.map((a) => [a.sessionId, a.id]));
  // Our agents waiting on a permission dialog: what it asks, read off their screens so it can be answered
  // here. The screen alone also raises the reminder, for when no Notification hook fired (hooks can fail).
  const prompts = new Map();
  const asks = [];
  const starting = new Map(); // agent id -> the trust dialog it waits on (no session, so no unit, yet)
  for (const s of sessions) {
    const id = byPid.get(s.pid) || bySession.get(s.sessionId);
    // a permission dialog, or any other question with a numbered menu (AskUserQuestion, plan approval)
    const a = id && getAgent(id);
    const prompt = a ? permissionPrompt(a) || questionPrompt(a) : null;
    if (!prompt) {
      promptSeen.delete(id);
      continue;
    }
    prompts.set(s.sessionId, prompt);
    s.permission ||= { at: promptSince(id), message: prompt.text.split('\n').find((l) => l.trim()) || prompt.options.map((o) => o.label).join(' / ') };
    asks.push({ agentId: id, name: a.name || s.name || s.project, project: s.project, prompt });
  }
  // our agents that have no session yet: one stopped on the folder-trust dialog waits on a person too
  const seen = new Set(asks.map((x) => x.agentId));
  for (const ag of all) {
    if (!ag.alive || ag.kind !== 'claude' || seen.has(ag.id) || byPid.has(ag.pid) || [...bySession.values()].includes(ag.id) && sessions.some((x) => x.sessionId === ag.sessionId)) continue;
    const prompt = trustPrompt(getAgent(ag.id));
    if (prompt) {
      asks.push({ agentId: ag.id, name: ag.name || path.basename(ag.cwd), project: path.basename(ag.cwd), prompt });
      starting.set(ag.id, prompt);
    }
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
    agents: all.filter((a) => a.kind !== 'master').map((a) => ({ ...a, queue: queueOf(a.id), masterTurn: Boolean(masterTurn(a.id)), waiting: starting.get(a.id) || null })), // the master has its own column
    agentSupport: agentSupport(),
    master: masterInfo(),
    today,
    orders: recentOrders(),
    forecast: fc,
    lang: getLang(),
    theme: getTheme(),
  };
  // queued orders: the next one goes to each of our agents that has finished its turn
  dispatch(state.units.filter((u) => u.owned), (id, text, item) => {
    const a = getAgent(id);
    const ok = sendText(a, text);
    if (ok) {
      recordOrder({ kind: 'dispatched', ...orderTarget(a), text, queuedAt: item?.at });
      noteOrder(a, item?.via || 'cc', text); // a queued order of the master's is its turn once it goes out
    }
    return ok;
  });
  // the master hears without having to look: our agents waiting on a person (once per question),
  // and the turns it gave out that have ended, with their answers
  const owned = state.units.filter((u) => u.owned && u.agentId);
  for (const t of endedTurns(owned, new Set(asks.map((x) => x.agentId)))) {
    const r = turnReply(t.sessionId, t.since);
    if (r?.messaged) continue; // it already answered the master itself (SendMessage)
    const u = owned.find((x) => x.agentId === t.agentId);
    const { text: reply, cut } = clip(r?.reply || u?.lastText || '');
    masterTurnDone({ agentId: t.agentId, name: getAgent(t.agentId)?.name || t.name, text: t.text, ms: t.ms, reply, cut });
  }
  notifyMaster(asks);
  // phone push: whatever needs you, whether or not anyone is looking at a screen
  if (!process.env.MONITOR_DEMO) pushQuests(state.quests, phoneUrl()); // never push made-up sessions to a phone
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
    history = (await collectHistory()).filter((h) => !isMasterCwd(h.cwd) && (DEV || !String(h.title || '').startsWith(DEV_PREFIX)));
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

// Who an order went to, for the order log: the agent's name and project folder at that moment.
function orderTarget(a) {
  const u = state?.units.find((x) => x.agentId === a.id);
  return { agentId: a.id, name: a.name || u?.name || u?.title || null, project: path.basename(a.cwd || '') || null };
}

/** One action for one or more of our agents; shared by the command center and the phone page. */
function agentAction({ id, action, text, key, choice, index, via = 'cc' }) {
  const ids = Array.isArray(id) ? id : [id];
  const results = ids.map((one) => {
    const a = getAgent(one);
    if (!a) return false;
    if (action === 'text' && typeof text === 'string' && text.trim()) {
      const ok = sendText(a, text);
      if (ok && a.kind !== 'shell' && a.kind !== 'master') {
        recordOrder({ kind: 'sent', ...orderTarget(a), text, via });
        noteOrder(a, via, text);
      }
      return ok;
    }
    if (action === 'key') return sendKey(a, key);
    if (action === 'answer') return answerPrompt(a, String(choice));
    if (action === 'queue' && typeof text === 'string' && text.trim()) {
      enqueue(a.id, text.trim(), via);
      recordOrder({ kind: 'queued', ...orderTarget(a), text: text.trim(), via });
      return true;
    }
    if (action === 'unqueue') {
      for (const q of dequeue(a.id, Number.isInteger(index) ? index : null)) recordOrder({ kind: 'removed', ...orderTarget(a), text: q.text, queuedAt: q.at, via });
      return true;
    }
    if (action === 'kill') {
      if (a.kind === 'master') stopMaster();
      endAgent(a);
      return true;
    }
    if (action === 'remove') return removeAgent(one);
    return false;
  });
  return { ok: results.some(Boolean), results };
}

// UI commands for the command center page, sent as a named SSE event; the page runs it and posts
// back what it did and what it now shows. With no page open the desktop app opens the window and
// the command waits for its stream.
const uiWaiters = new Map();
const uiPending = [];
let uiSeq = 0;
let uiOpener = null;
export function setUiOpener(fn) {
  uiOpener = fn;
}
function uiCommand(cmd) {
  return new Promise((resolve) => {
    const id = ++uiSeq;
    const timer = setTimeout(() => {
      uiWaiters.delete(id);
      resolve({ ok: false, error: L('指挥中心没有响应（窗口没打开？）', 'The command center did not answer (window closed?)', '指揮センターが応答しません（ウィンドウが閉じている？）') });
    }, 8000);
    uiWaiters.set(id, (r) => {
      clearTimeout(timer);
      uiWaiters.delete(id);
      resolve(r);
    });
    const payload = `event: ui\ndata: ${JSON.stringify({ ...cmd, id })}\n\n`;
    const pages = [...clients].filter((c) => c.main);
    if (pages.length) for (const c of pages) c.write(payload);
    else {
      uiPending.push({ payload, at: Date.now() });
      if (uiPending.length > 20) uiPending.shift();
      uiOpener?.();
    }
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
  if (req.method === 'GET' && (req.url === '/api/stream' || req.url === '/api/stream?main=1')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    clients.add(res);
    if (req.url.endsWith('main=1')) {
      res.main = true; // the command center page: takes UI commands from the master
      for (const p of uiPending.splice(0)) if (Date.now() - p.at < 8000) res.write(p.payload); // not the ones already given up on
    }
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
    const { cwd, name, prompt, resume, shell, via } = await readBody(req);
    try {
      let agent;
      if (shell) {
        agent = spawnShell({ cwd: String(cwd || '').trim() || os.homedir() });
        return send(res, 200, { ok: true, id: agent.id });
      }
      if (resume) {
        // resume only sessions from our own scan, in the folder the transcript says
        const h = history.find((x) => x.sessionId === resume);
        if (!h) return send(res, 400, { error: L('未知会话', 'Unknown session', '不明なセッション') });
        if (h.pid && !getAgent(resume)?.alive) return send(res, 409, { error: L('这个会话正在外部终端里运行', 'This session is running in an outside terminal', 'このセッションは外部ターミナルで実行中です') });
        agent = spawnAgent({ cwd: h.cwd, resume, name, prompt });
      } else {
        agent = spawnAgent({ cwd: String(cwd || '').trim(), name: name ? String(name).trim() : undefined, prompt: prompt ? String(prompt) : undefined });
      }
      if (prompt) noteOrder(agent, via === 'master' ? 'master' : 'cc', prompt); // fleet_spawn's first order is the master's turn
      setTimeout(refreshGit, 4000); // pick up the new unit's repos without waiting for the next scan
      return send(res, 200, { ok: true, id: agent.id });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  // the master console: start (resumes its last session), new (a fresh session), stop
  if (req.method === 'POST' && req.url === '/api/master') {
    const { action } = await readBody(req);
    try {
      if (action === 'stop') stopMaster();
      else if (action === 'new') {
        stopMaster();
        await new Promise((r) => setTimeout(r, 800)); // let the old process let go of its folder
        startMaster(url, { fresh: true });
      } else startMaster(url);
      publish();
      return send(res, 200, { ok: true, ...masterInfo() });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  // For the desktop shell and the update tool (no Origin: not from a page): what runs, and swapping
  // this server for a newly installed version or back to the previous one.
  if (req.url === '/api/admin/summary' && req.method === 'GET') {
    const live = liveAgents();
    return send(res, 200, { version: appVersion, started: startedUp, root: ROOT, pid: process.pid, hostPid: hostInfo?.pid || null, live: live.map((a) => a.name || a.cwd), liveIds: live.map((a) => a.id), busy: fleetBusy(), shellApi: Number(process.env.FLEET_SHELL_API) || 0 });
  }
  if (req.method === 'POST' && (req.url === '/api/admin/reload' || req.url === '/api/admin/rollback')) {
    if (req.headers.origin) return send(res, 403, { error: 'forbidden' });
    if (!process.send) return send(res, 400, { error: 'not running under the desktop app' });
    process.send({ type: req.url.endsWith('rollback') ? 'rollback' : 'reload' });
    return send(res, 200, { ok: true });
  }
  // the master drives the command center page: switch tabs, open terminals... (fleet_ui)
  if (req.method === 'POST' && req.url === '/api/ui') return send(res, 200, await uiCommand(await readBody(req)));
  if (req.method === 'POST' && req.url === '/api/ui/done') {
    const r = await readBody(req);
    uiWaiters.get(r.id)?.(r);
    return send(res, 200, { ok: true });
  }
  // an agent's screen as text (the master's fleet_read_screen)
  if (req.method === 'GET' && req.url.startsWith('/api/agents/screen?')) {
    const a = getAgent(new URL(req.url, 'http://localhost').searchParams.get('id') || '');
    if (!a) return send(res, 404, { error: 'unknown_agent' });
    return send(res, 200, { lines: screenLines(a), alive: a.alive });
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
  if (req.method === 'POST' && req.url === '/api/theme') {
    const { theme } = await readBody(req);
    setTheme(theme);
    publish(); // every open page (and the phone) recolors with the next state
    return send(res, 200, { ok: true, theme: getTheme() });
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
      if (msg.type === 'input' && typeof msg.data === 'string') {
        writeRaw(agent, msg.data);
        agent.typedAt = Date.now(); // someone is typing here: the master's notices wait for a pause
        // Enter on an idle agent with nothing to answer: an order typed straight into its terminal
        // (an Enter that answers a dialog or a question doesn't change who gave the turn)
        const u = msg.data.includes('\r') && state?.units.find((x) => x.agentId === agent.id);
        if (u && u.status === 'idle' && !u.permission) noteOrder(agent, 'terminal', '');
      }
      else if (msg.type === 'resize') resizeAgent(agent, msg.cols, msg.rows);
    });
    ws.on('close', () => agent.clients.delete(ws));
  });
});

onAgentsChange(() => publish());

// Agents are our child processes: end them with the app rather than leaving orphans.
/** The app quits: the terminals end with it (the roster, kept as it was, brings the agents back). */
export async function shutdown() {
  stopMobile();
  freezeRoster(); // keep the roster as it was, so the next start restores these agents
  await killAll();
}

/** This server makes way for another (an update): the terminals stay, in the PTY host. */
export async function detach() {
  stopMobile();
  freezeRoster();
  for (const t of timers) clearInterval(t);
  await new Promise((r) => server.close(() => r()));
}

// Bring back the agents the last run left behind (a quit, an update, or a crash).
async function restoreRoster(saved) {
  // the ones still running in the PTY host (taken back at start) need nothing
  const roster = saved.filter((r) => !listAgents().some((a) => a.alive && (a.id === r.sessionId || a.sessionId === r.sessionId)));
  if (!roster.length || !agentSupport().ok) return;
  const { resume, skipped, killed } = planRestore(roster, collectSessions());
  console.log(`roster: ${saved.length} saved, ${saved.length - roster.length} still running in the PTY host`);
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

// For keep-awake: something is working, waiting on a permission prompt, or has orders queued.
export function fleetBusy() {
  if (!state) return false;
  return state.units.some((u) => u.status === 'busy' || u.permission) || state.agents.some((a) => a.alive && a.queue?.length);
}

export function liveAgents() {
  return listAgents().filter((a) => a.alive);
}
// (no killAll on exit: the terminals live in the PTY host and outlive this process on purpose)

export const url = `http://127.0.0.1:${config.port}`;
const timers = [];
let startedUp = false; // start() went all the way (the update tool waits for this)

// This server's version: the app folder it runs from (an update installs a new one, see desktop/appdir.cjs).
export const appVersion = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).fleetBuild || JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
})();

// Rejects with EADDRINUSE when another instance already serves the port.
export async function start() {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', resolve);
  });
  // the roster as the last run left it, read before anything can save over it
  const saved = loadRoster();
  // terminals still running in the PTY host (this server replaced another): taken back as they are
  const kept = await attachHost();
  if (kept) console.log(`pty host: took back ${kept} running terminal(s)`);
  adoptMaster();
  try {
    await restoreRoster(saved);
  } finally {
    rosterRestored(); // from now on the roster follows the agents
  }
  if (masterWanted() && agentSupport().ok) {
    try {
      startMaster(url);
    } catch (e) {
      console.error('master failed', e.message);
    }
  }
  await Promise.all([refreshUsage(), refreshGit()]);
  timers.push(setInterval(publish, config.intervals.sessions), setInterval(() => refreshUsage(), config.intervals.usage), setInterval(refreshGit, config.intervals.git));
  await startMobile({ clients, getState: () => state, action: (b) => agentAction({ ...b, via: 'phone' }), screen: (id) => {
    const a = getAgent(id);
    return { html: screenHtml(a?.screen), menu: a ? menuOptions(a) : [] };
  } });
  startedUp = true;
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
