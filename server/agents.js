// Claude Code agents launched by the command center: each one is the real interactive `claude`
// running in a pseudo-terminal we own, so we can show its screen and type into it.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { L } from './i18n.js';

const require = createRequire(import.meta.url);
const BUFFER_MAX = 512 * 1024; // screen history replayed to a newly opened terminal panel
// A headless copy of each agent's screen, so the server can read what is on it (e.g. the command
// a permission prompt asks about) without any terminal panel being open.
const { Terminal: Headless } = require('@xterm/headless');
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
// The dark-ansi theme draws Claude Code with the 16 terminal colors only (no fixed RGB), so the
// xterm palette in web/terminal.js can dress it in the command center's colors.
const AGENT_SETTINGS = path.join(DATA_DIR, 'agent-settings.json');

// Our agents' status line prints nothing, but Claude Code hands it the account's current quota
// (rate_limits) on every refresh: keep that in a file, so the quota stays current without polling
// the rate-limited usage endpoint. Runs as plain Node: this app's own executable in node mode.
const STATUSLINE_SCRIPT = path.join(DATA_DIR, 'statusline.cjs');
const STATUSLINE_CMD = path.join(DATA_DIR, 'statusline.cmd');
export const STATUSLINE_USAGE = path.join(DATA_DIR, 'statusline-usage.json');
// Claude Code does not close the status line's stdin: take the JSON as soon as it parses, and give
// up after a few seconds either way.
const STATUSLINE_SRC = `// Written by Fleet Bridge: saves the quota Claude Code passes to the status line; prints nothing.
const fs = require('fs');
let s = '';
const save = (j) => {
  const r = j.rate_limits;
  if (!r || !(r.five_hour || r.seven_day)) return;
  const out = ${JSON.stringify(STATUSLINE_USAGE)};
  fs.writeFileSync(out + '.tmp', JSON.stringify({ at: Date.now(), five_hour: r.five_hour || null, seven_day: r.seven_day || null }));
  fs.renameSync(out + '.tmp', out);
};
setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  s += d;
  let j;
  try {
    j = JSON.parse(s);
  } catch {
    return; // not all of it yet
  }
  try {
    save(j);
  } catch {}
  process.exit(0);
});
process.stdin.on('end', () => process.exit(0));
`;

// The status line may run in PowerShell or bash, so the command is just the path of a .cmd launcher
// (both shells run that); the launcher sets ELECTRON_RUN_AS_NODE for this one process only.
function writeIfChanged(file, body) {
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, body);
  }
}

function statusLineCommand() {
  try {
    writeIfChanged(STATUSLINE_SCRIPT, STATUSLINE_SRC);
    writeIfChanged(STATUSLINE_CMD, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${STATUSLINE_SCRIPT}"\r\n`);
  } catch {
    return 'exit 0';
  }
  const cmd = STATUSLINE_CMD.replace(/\\/g, '/');
  return /\s/.test(cmd) ? `"${cmd}"` : cmd; // unquoted where possible: a quoted string is not a command in PowerShell
}
function agentSettingsFile() {
  // MONITOR_AGENT_SETTINGS (dev / tests only): a JSON object merged in, e.g. to switch off a plugin
  let extra = {};
  try {
    extra = JSON.parse(process.env.MONITOR_AGENT_SETTINGS || '{}');
  } catch {
    // ignore a malformed override
  }
  const body = JSON.stringify({ statusLine: { type: 'command', command: statusLineCommand() }, theme: 'dark-ansi', ...extra }, null, 2);
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
  return { ok: Boolean(pty && CLAUDE), error: !pty ? L(`终端组件加载失败：${ptyError}`, `Terminal component failed to load: ${ptyError}`, `ターミナルコンポーネントの読み込みに失敗：${ptyError}`) : !CLAUDE ? L('找不到 claude 命令', 'claude command not found', 'claude コマンドが見つかりません') : null };
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
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(L('文件夹不存在', 'Folder does not exist', 'フォルダが存在しません'));
  if (resume && !UUID.test(resume)) throw new Error(L('会话 ID 无效', 'Invalid session id', '無効なセッション ID'));
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
  const screen = new Headless({ cols: 120, rows: 32, scrollback: 0, allowProposedApi: true });
  const agent = { id: sessionId, sessionId, pid: null, name: name || null, cwd, alive: true, exitCode: null, startedAt: Date.now(), term, screen, buffer: '', clients: new Set(), lastOutputAt: Date.now() };
  term.onData((d) => {
    screen.write(d);
    agent.buffer = (agent.buffer + d).slice(-BUFFER_MAX);
    agent.lastOutputAt = Date.now();
    for (const ws of agent.clients) ws.send(d);
  });
  term.onExit(({ exitCode }) => {
    agent.alive = false;
    agent.exitCode = exitCode;
    const note = `\r\n\x1b[33m${L(`[进程已退出，代码 ${exitCode}。会话记录还在，可以从存档继续]`, `[Process exited with code ${exitCode}. The session is kept; continue it from the archive]`, `[プロセスがコード ${exitCode} で終了しました。セッション記録は残っているので、アーカイブから続行できます]`)}\x1b[0m\r\n`;
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

// what a button can press: the command center uses esc; the phone page drives any dialog with the rest
const KEYS = { esc: '\x1b', 'ctrl-c': '\x03', enter: '\r', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', tab: '\t', 'shift-tab': '\x1b[Z', space: ' ', backspace: '\x7f' };

export function sendKey(agent, key) {
  if (!agent?.alive || !KEYS[key]) return false;
  agent.term.write(KEYS[key]);
  return true;
}

/** The agent's visible screen as plain text lines (trailing blanks trimmed). */
export function screenLines(agent) {
  const b = agent?.screen?.buffer.active;
  if (!b) return [];
  const out = [];
  for (let i = b.viewportY; i < b.viewportY + agent.screen.rows; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

/**
 * The permission dialog Claude Code is showing, if any: its text (the tool and command asked about)
 * and its numbered options. Found by the "❯ 1." style option list at the bottom of the screen.
 */
/** Any numbered menu at the bottom of the screen (select lists, questions), for the phone page. */
export function menuOptions(agent) {
  const lines = screenLines(agent);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*(?:[❯›>▸]\s*)?\d\.\s+\S/.test(lines[i])) { last = i; break; }
  if (last < 0) return [];
  // walk up through the options, their indented descriptions and the blank lines between them
  const inMenu = (l) => /^\s*(?:[❯›>▸]\s*)?\d\.\s+\S/.test(l) || /^\s{4,}\S/.test(l);
  let first = last;
  for (let i = last - 1; i >= 0; i--) {
    if (!lines[i].trim() || /^[\s─━╌┄-]{8,}$/.test(lines[i])) continue; // blank lines and dividers between options
    if (!inMenu(lines[i])) break;
    first = i;
  }
  const out = [];
  for (let i = first; i <= last; i++) {
    const m = lines[i].match(/^\s*([❯›>▸]\s*)?(\d)\.\s+(.+?)\s*$/);
    if (m) out.push({ key: m[2], label: m[3], current: Boolean(m[1]) });
  }
  // a live menu always marks its current option with a cursor (❯ in pickers, > in questions);
  // numbered lists in Claude's text do not
  return out.length >= 2 && out.some((o) => o.current) ? out : [];
}

export function permissionPrompt(agent) {
  const lines = screenLines(agent);
  const optAt = lines.findIndex((l) => /^\s*(?:[❯›>▸]\s*)?1\.\s+\S/.test(l));
  if (optAt < 0) return null;
  const options = [];
  for (let i = optAt; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:[❯›>▸]\s*)?(\d)\.\s+(.+?)\s*$/);
    if (m) options.push({ key: m[1], label: m[2] });
    else if (options.length && lines[i].trim() && !/^\s{3,}/.test(lines[i])) break;
  }
  // only Claude Code's permission dialogs, whose first answer is "Yes" (not other numbered menus)
  if (options.length < 2 || !/^yes\b/i.test(options[0].label)) return null;
  // the question and what it is about: the lines above the options, up to the solid rule that opens
  // the dialog (dotted rules inside it, around a file preview, are skipped)
  const body = [];
  for (let i = optAt - 1; i >= 0 && body.length < 14; i--) {
    const l = lines[i];
    if (/^[\s─━═]{8,}$/.test(l)) break;
    if (/^[\s╌┄-]{8,}$/.test(l)) continue;
    body.unshift(l.replace(/^[\s│╭╰╮╯]+|[\s│╭╰╮╯]+$/g, ''));
  }
  return { text: body.filter((l, i, a) => l || (i && a[i - 1])).join('\n').trim(), options };
}

/** Answer a permission dialog by its option number (1 = yes); Esc rejects. */
export function answerPrompt(agent, choice) {
  if (!agent?.alive) return false;
  if (choice === 'esc') agent.term.write('\x1b');
  else if (/^\d$/.test(choice)) agent.term.write(choice);
  else return false;
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
    agent.screen.resize(c, r);
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
