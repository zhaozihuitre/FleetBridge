// Claude Code agents launched by the command center: each one is the real interactive `claude`
// running in a pseudo-terminal we own, so we can show its screen and type into it.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const require = createRequire(import.meta.url);
const BUFFER_MAX = 512 * 1024; // screen history replayed to a newly opened terminal panel
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let pty = null;
let ptyError = null;
try {
  pty = require('@lydell/node-pty');
} catch (e) {
  ptyError = e.message;
}

function findClaude() {
  try {
    const hit = execFileSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).find((l) => /\.exe$/i.test(l));
    if (hit) return hit.trim();
  } catch {
    // not on PATH
  }
  const fallback = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  return fs.existsSync(fallback) ? fallback : null;
}

const CLAUDE = findClaude();

// Extra settings for our agents only (--settings outranks user/project settings): no status line —
// the command center shows each agent's context itself, and the user's HUD would just eat terminal rows.
const AGENT_SETTINGS = path.join(DATA_DIR, 'agent-settings.json');
function agentSettingsFile() {
  const body = JSON.stringify({ statusLine: { type: 'command', command: 'exit 0' } }, null, 2);
  try {
    if (!fs.existsSync(AGENT_SETTINGS) || fs.readFileSync(AGENT_SETTINGS, 'utf8') !== body) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(AGENT_SETTINGS, body);
    }
    return AGENT_SETTINGS;
  } catch {
    return null; // can't write it: agents just keep the user's status line
  }
}

// Variables a running Claude Code session sets for its own children. If the app was started from
// inside a session they leak in, and the new claude then acts as a nested child (no status file,
// borrowed messaging inbox). User configuration such as ANTHROPIC_* or CLAUDE_CONFIG_DIR stays.
const SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
];

function agentEnv() {
  const env = { ...process.env, FORCE_COLOR: '1' };
  for (const k of Object.keys(env)) if (SESSION_VARS.includes(k.toUpperCase())) delete env[k];
  return env;
}
const agents = new Map(); // sessionId -> agent
let onChange = () => {};

export function onAgentsChange(fn) {
  onChange = fn;
}

export function agentSupport() {
  return { ok: Boolean(pty && CLAUDE), error: !pty ? `终端组件加载失败：${ptyError}` : !CLAUDE ? '找不到 claude 命令' : null };
}

export function listAgents() {
  return [...agents.values()].map(({ id, sessionId, name, cwd, alive, exitCode, startedAt, pid }) => ({ id, sessionId, name, cwd, alive, exitCode, startedAt, pid }));
}

// node-pty reports pid 0 on Windows, and the session id changes on /clear or when a resume
// forks, so ownership is tracked by the claude process: the first new status file in the
// agent's folder after it started is ours, and its pid stays ours for the agent's lifetime.
export function bindAgents(sessions) {
  const bound = new Set([...agents.values()].map((a) => a.pid).filter(Boolean));
  for (const a of agents.values()) {
    if (!a.alive) continue;
    if (!a.pid) {
      const s =
        sessions.find((x) => x.sessionId === a.sessionId && !bound.has(x.pid)) ||
        sessions.find((x) => !bound.has(x.pid) && x.cwd.toLowerCase() === a.cwd.toLowerCase() && x.startedAt >= a.startedAt - 3000);
      if (s) {
        a.pid = s.pid;
        bound.add(s.pid);
      }
    }
    const now = a.pid && sessions.find((x) => x.pid === a.pid);
    if (now) a.sessionId = now.sessionId; // follow /clear and forks
  }
}

export function getAgent(id) {
  return agents.get(id) || null;
}

/**
 * @param {{cwd: string, name?: string, resume?: string, prompt?: string}} opts
 */
export function spawnAgent({ cwd, name, resume, prompt }) {
  const support = agentSupport();
  if (!support.ok) throw new Error(support.error);
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('文件夹不存在');
  if (resume && !UUID.test(resume)) throw new Error('会话 ID 无效');
  // Already under our command (also after /clear or a fork changed its id): never attach a second
  // process to the same session, both would write into one transcript.
  const existing = resume && [...agents.values()].find((a) => a.alive && (a.id === resume || a.sessionId === resume));
  if (existing) return existing;

  // A new session gets an id we choose, so it maps to its transcript and status file from the start.
  const sessionId = resume || crypto.randomUUID();
  const args = resume ? ['--resume', resume] : ['--session-id', sessionId];
  if (name) args.push('--name', String(name).slice(0, 60));
  const settings = agentSettingsFile();
  if (settings) args.push('--settings', settings);

  const term = pty.spawn(CLAUDE, args, { name: 'xterm-256color', cols: 120, rows: 32, cwd, env: agentEnv() });
  const agent = { id: sessionId, sessionId, pid: null, name: name || null, cwd, alive: true, exitCode: null, startedAt: Date.now(), term, buffer: '', clients: new Set(), lastOutputAt: Date.now() };
  term.onData((d) => {
    agent.buffer = (agent.buffer + d).slice(-BUFFER_MAX);
    agent.lastOutputAt = Date.now();
    for (const ws of agent.clients) ws.send(d);
  });
  term.onExit(({ exitCode }) => {
    agent.alive = false;
    agent.exitCode = exitCode;
    const note = `\r\n\x1b[33m[进程已退出，代码 ${exitCode}。会话记录还在，可以从存档继续]\x1b[0m\r\n`;
    agent.buffer += note;
    for (const ws of agent.clients) ws.send(note);
    onChange();
  });
  agents.set(sessionId, agent);
  if (prompt) whenQuiet(agent, () => sendText(agent, prompt));
  onChange();
  return agent;
}

// Wait for the TUI to finish drawing its first screen before typing into it.
function whenQuiet(agent, fn, quietMs = 1200, maxMs = 15_000) {
  const t0 = Date.now();
  const check = () => {
    if (!agent.alive) return;
    if (Date.now() - agent.lastOutputAt >= quietMs || Date.now() - t0 > maxMs) fn();
    else setTimeout(check, 250);
  };
  setTimeout(check, 1500);
}

// Typed as a bracketed paste so multi-line text arrives as one message, then Enter submits it.
export function sendText(agent, text) {
  if (!agent?.alive) return false;
  agent.term.write(`\x1b[200~${String(text)}\x1b[201~`);
  setTimeout(() => agent.alive && agent.term.write('\r'), 120);
  return true;
}

const KEYS = { esc: '\x1b', 'ctrl-c': '\x03', enter: '\r' };

export function sendKey(agent, key) {
  if (!agent?.alive || !KEYS[key]) return false;
  agent.term.write(KEYS[key]);
  return true;
}

export function writeRaw(agent, data) {
  if (agent?.alive) agent.term.write(data);
}

export function resizeAgent(agent, cols, rows) {
  if (!agent?.alive) return;
  const c = Math.max(20, Math.min(400, cols | 0));
  const r = Math.max(5, Math.min(200, rows | 0));
  try {
    agent.term.resize(c, r);
  } catch {
    // the process may be exiting
  }
}

export function killAgent(agent) {
  if (agent?.alive) agent.term.kill();
}

export function removeAgent(id) {
  const a = agents.get(id);
  if (!a || a.alive) return false;
  for (const ws of a.clients) ws.close();
  agents.delete(id);
  onChange();
  return true;
}

export function killAll() {
  for (const a of agents.values()) killAgent(a);
}
