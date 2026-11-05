// Claude Code agents launched by the command center: each one is the real interactive `claude`
// running in a pseudo-terminal we own, so we can show its screen and type into it.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, DEV, DEV_PREFIX } from './config.js';
import { L } from './i18n.js';
import * as host from './ptyclient.js';
import { BIN_DIR } from './preview.js';

const require = createRequire(import.meta.url);
const BUFFER_MAX = 512 * 1024; // screen history replayed to a newly opened terminal panel
// A headless copy of each agent's screen, so the server can read what is on it (e.g. the command
// a permission prompt asks about) without any terminal panel being open.
const { Terminal: Headless } = require('@xterm/headless');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The terminals live in the PTY host (server/ptyhost.cjs), a process of their own that outlives this
// server: an update or a crash of the server doesn't end them, and the next server takes them back.
let hostError = null;

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
  const env = termEnv();
  for (const k of Object.keys(env)) if (SESSION_VARS.includes(k.toUpperCase())) delete env[k];
  return env;
}

/**
 * The environment of every terminal we start. The server runs as Electron-in-node-mode: that switch
 * must not reach the terminals (an agent starting an Electron app would get a bare node instead), nor
 * the shell's own variables. TERM is set as a terminal would: started from the Start menu the app has
 * none, and Claude Code then drew its prompt in ASCII (">" instead of "❯").
 */
function termEnv() {
  const env = { ...process.env, FORCE_COLOR: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.FLEET_SHELL_API;
  // the installed app's terminals don't need it (it's the default) and must not pass it on: a dev
  // run started from one of them would take the installed app's data folder and terminals
  if (!DEV) delete env.MONITOR_DATA_DIR;
  env.TERM ||= 'xterm-256color';
  // fleet-open on the PATH, and as BROWSER for tools that honour it (forward slashes: Python's
  // webbrowser splits the value like a POSIX shell and would eat backslashes)
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[pathKey] = `${BIN_DIR}${path.delimiter}${env[pathKey] || ''}`;
  env.BROWSER = path.join(BIN_DIR, process.platform === 'win32' ? 'fleet-open.cmd' : 'fleet-open').replace(/\\/g, '/');
  return env;
}

// Claude Code's input line: its prompt mark (❯, or > when it draws ASCII) right under the input box's
// rule. A numbered menu option ("> 1. Yes") is not it.
const PROMPT = /^[❯>](?!\s*\d\.)/;

// Added to our agents' system prompt: pages are shown in Fleet Bridge.
const OPEN_HINT =
  'You run inside Fleet Bridge. To show the user a local HTML or Markdown file, an image, or a localhost page (e.g. a dev server), run `fleet-open <path-or-url>` (it is on PATH): it opens in Fleet Bridge, next to the terminals, and reloads when the files change. Do not start the system browser for these (no `start`, `Invoke-Item` or `open`). Outside http(s) links passed to fleet-open go to the system browser.';
const PROMPT_MARK = /^[❯>]\s*/;
const agents = new Map(); // sessionId -> agent
let onChange = () => {};
let promptSent = () => {};
/** Called when a new agent's first order (fleet_spawn's prompt) actually goes in. */
export function onPromptSent(fn) {
  promptSent = fn;
}

export function onAgentsChange(fn) {
  onChange = fn;
}

export function agentSupport() {
  return { ok: Boolean(!hostError && CLAUDE), error: hostError ? L(`终端组件加载失败：${hostError}`, `Terminal component failed to load: ${hostError}`, `ターミナルコンポーネントの読み込みに失敗：${hostError}`) : !CLAUDE ? L('找不到 claude 命令', 'claude command not found', 'claude コマンドが見つかりません') : null };
}

const exitNote = (agent, exitCode) =>
  agent.kind === 'shell'
    ? `\r\n\x1b[33m${L(`[终端已退出，代码 ${exitCode}]`, `[Shell exited with code ${exitCode}]`, `[ターミナルがコード ${exitCode} で終了しました]`)}\x1b[0m\r\n`
    : `\r\n\x1b[33m${L(`[进程已退出，代码 ${exitCode}。会话记录还在，可以从存档继续]`, `[Process exited with code ${exitCode}. The session is kept; continue it from the archive]`, `[プロセスがコード ${exitCode} で終了しました。セッション記録は残っているので、アーカイブから続行できます]`)}\x1b[0m\r\n`;

/** Output and exit of a terminal in the host, into the agent's screen, buffer and open panels. */
function wire(agent) {
  agent.term.onData((d) => {
    agent.screen.write(d);
    agent.buffer = (agent.buffer + d).slice(-BUFFER_MAX);
    agent.lastOutputAt = Date.now();
    for (const ws of agent.clients) ws.send(d);
  });
  agent.term.onExit(({ exitCode }) => {
    if (!agent.alive) return;
    agent.alive = false;
    agent.exitCode = exitCode;
    agent.exitedAt = Date.now();
    const note = exitNote(agent, exitCode);
    agent.buffer += note;
    for (const ws of agent.clients) ws.send(note);
    onChange();
  });
  agent.term.started?.catch((e) => {
    agent.term.onExit(() => {}); // no exit event will come for a terminal that never started
    agent.alive = false;
    agent.exitCode = -1;
    const note = `\r\n\x1b[31m${L(`[启动失败：${e.message}]`, `[Failed to start: ${e.message}]`, `[起動に失敗：${e.message}]`)}\x1b[0m\r\n`;
    agent.buffer += note;
    for (const ws of agent.clients) ws.send(note);
    onChange();
  });
}

/**
 * At startup: connect to the PTY host (starting it if needed) and take back the terminals it still
 * runs from before this server started (an update or a crash of the server), with their screens.
 */
export async function attachHost() {
  try {
    const list = await host.list();
    hostError = null;
    for (const t of list) {
      if (agents.has(t.id)) continue;
      const m = t.meta || {};
      const cols = m.cols || 120;
      const rows = m.rows || 32;
      const screen = new Headless({ cols, rows, scrollback: 0, allowProposedApi: true });
      screen.write(t.buf || '');
      const agent = { id: t.id, sessionId: m.sessionId ?? null, kind: m.kind === 'claude' ? undefined : m.kind, pid: m.pid || null, name: m.name || null, cwd: m.cwd, alive: t.alive, exitCode: t.exitCode, startedAt: m.startedAt || Date.now(), term: host.handle(t.id), screen, buffer: t.buf || '', clients: new Set(), lastOutputAt: Date.now(), reattached: true };
      agents.set(t.id, agent);
      if (t.alive) wire(agent);
    }
    onChange();
    return list.filter((t) => t.alive).length;
  } catch (e) {
    hostError = e.message;
    return 0;
  }
}

// the host gone (killed, or it crashed): its terminals went with it
host.onHostLost(() => {
  for (const a of agents.values()) {
    if (!a.alive) continue;
    a.alive = false;
    a.exitCode = -1;
    a.exitedAt = Date.now();
  }
  onChange();
});

export function listAgents() {
  return [...agents.values()].map(({ id, sessionId, kind, name, cwd, alive, exitCode, startedAt, pid, orderBy, exitedAt, endedByUser }) => ({ id, sessionId, kind: kind || 'claude', name, cwd, alive, exitCode, startedAt, pid, orderBy: orderBy || null, exitedAt: exitedAt || null, endedByUser: Boolean(endedByUser) }));
}

// node-pty reports pid 0 on Windows, and the session id changes on /clear or when a resume
// forks, so ownership is tracked by the claude process: the first new status file in the
// agent's folder after it started is ours, and its pid stays ours for the agent's lifetime.
export function bindAgents(sessions) {
  const bound = new Set([...agents.values()].map((a) => a.pid).filter(Boolean));
  for (const a of agents.values()) {
    if (!a.alive || a.kind === 'shell') continue;
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
    // the host keeps this with the terminal: a server started later knows whose session it is
    if (a.pid !== a.metaPid || a.sessionId !== a.metaSession) {
      a.metaPid = a.pid;
      a.metaSession = a.sessionId;
      host.setMeta(a.id, { pid: a.pid, sessionId: a.sessionId });
    }
  }
}

export function getAgent(id) {
  return agents.get(id) || null;
}

/**
 * @param {{cwd: string, name?: string, resume?: string, prompt?: string}} opts
 */
export function spawnAgent({ cwd, name, resume, prompt, kind, extraArgs = [] }) {
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
  // a dev run's agents carry the dev prefix: the installed app hides those sessions
  if (DEV) name = DEV_PREFIX + String(name || path.basename(cwd)).replace(DEV_PREFIX, '');
  if (name) args.push('--name', String(name).slice(0, 60));
  // where pages go: the command center, not the system browser
  args.push('--append-system-prompt', OPEN_HINT);
  const settings = agentSettingsFile();
  if (settings) args.push('--settings', settings);
  args.push(...extraArgs);

  const startedAt = Date.now();
  const term = host.spawn(sessionId, CLAUDE, args, { cwd, env: agentEnv(), meta: { kind: kind || 'claude', sessionId, name: name || null, cwd, startedAt } });
  const screen = new Headless({ cols: 120, rows: 32, scrollback: 0, allowProposedApi: true });
  const agent = { id: sessionId, sessionId, kind, pid: null, name: name || null, cwd, alive: true, exitCode: null, startedAt, term, screen, buffer: '', clients: new Set(), lastOutputAt: Date.now() };
  wire(agent);
  agents.set(sessionId, agent);
  if (prompt)
    whenQuiet(agent, () => {
      if (sendText(agent, prompt)) promptSent(agent, prompt); // the order's turn starts now, not at the spawn
    });
  onChange();
  return agent;
}

// A plain shell in the split view (PowerShell 7 if installed, else Windows PowerShell; $SHELL elsewhere),
// for git, npm and friends next to the agents. Not an agent: never bound to a session, saved in the
// sent orders or counted as a unit.
let SHELL;
function findShell() {
  if (SHELL !== undefined) return SHELL;
  if (process.platform !== 'win32') return (SHELL = process.env.SHELL || '/bin/bash');
  try {
    SHELL = execFileSync('where.exe', ['pwsh'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).find((l) => /\.exe$/i.test(l.trim()))?.trim() || 'powershell.exe';
  } catch {
    SHELL = 'powershell.exe';
  }
  return SHELL;
}

export function spawnShell({ cwd }) {
  if (hostError) throw new Error(agentSupport().error);
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(L('文件夹不存在', 'Folder does not exist', 'フォルダが存在しません'));
  const exe = findShell();
  const args = /powershell|pwsh/i.test(exe) ? ['-NoLogo'] : [];
  const id = crypto.randomUUID();
  const name = /pwsh/i.test(exe) ? 'PowerShell 7' : /powershell/i.test(exe) ? 'PowerShell' : path.basename(exe);
  const startedAt = Date.now();
  const term = host.spawn(id, exe, args, { cwd, env: termEnv(), meta: { kind: 'shell', sessionId: null, name, cwd, startedAt } });
  const screen = new Headless({ cols: 120, rows: 32, scrollback: 0, allowProposedApi: true });
  const agent = { id, sessionId: null, kind: 'shell', pid: null, name, cwd, alive: true, exitCode: null, startedAt, term, screen, buffer: '', clients: new Set(), lastOutputAt: Date.now() };
  wire(agent);
  agents.set(id, agent);
  onChange();
  return agent;
}

// Wait for the TUI to finish drawing its first screen before typing into it.
// The first order of a new agent goes in once its screen settles, but never while a dialog is up:
// typing it, and its Enter, into the folder-trust dialog picked the default "No, exit" and the agent
// quit. With a dialog on screen it waits (a person, or the master, answers it), then goes in.
// It also waits for Claude Code's input box to be drawn: a slow start used to look "quiet" before
// anything (dialog or input) was on screen, and the order went in too early and was lost.
function whenQuiet(agent, fn, quietMs = 1200, maxMs = 60_000) {
  let t0 = Date.now();
  const check = () => {
    if (!agent.alive) return;
    if (dialogShowing(agent)) {
      t0 = Date.now(); // the wait starts over once it's answered
      return setTimeout(check, 500);
    }
    const ready = inputLine(agent) !== null && Date.now() - agent.lastOutputAt >= quietMs;
    if (ready || Date.now() - t0 > maxMs) fn();
    else setTimeout(check, 250);
  };
  setTimeout(check, 1500);
}

/** Claude Code's input line (the ❯ line right under a rule), as text; null while it isn't drawn. */
function inputLine(agent) {
  const lines = screenLines(agent);
  for (let i = lines.length - 1; i > 0; i--) if (PROMPT.test(lines[i]) && /^[─━]{5,}/.test(lines[i - 1])) return lines[i].replace(PROMPT_MARK, '').trim();
  return null;
}

/**
 * Claude Code's "do you trust this folder" dialog, shown the first time it opens a folder (before
 * any session exists). Its two options are unnumbered, so it reads as a question with 1 = No, exit
 * and 2 = Yes, trust; answerPrompt moves the cursor for them.
 */
export function trustPrompt(agent) {
  const lines = screenLines(agent);
  const yes = lines.findIndex((l) => /Yes, I trust this folder/i.test(l));
  if (yes < 0) return null;
  const no = lines.findIndex((l) => /No, exit/i.test(l));
  const folder = lines.find((l, i) => i > 0 && /accessing workspace/i.test(lines[i - 1] || ''))?.trim() || agent.cwd;
  return {
    kind: 'question',
    trust: true,
    text: `Claude Code 第一次打开这个文件夹，问是否信任它：${folder}\n（选 2 信任后才能工作；选 1 会退出）`,
    options: [
      { key: '1', label: 'No, exit', current: no >= 0 && /^\s*[❯›>▸]/.test(lines[no]) },
      { key: '2', label: 'Yes, I trust this folder', current: /^\s*[❯›>▸]/.test(lines[yes]) },
    ],
  };
}

/** Any dialog waiting on a person: the trust dialog, a permission dialog or a numbered menu. */
export function dialogShowing(agent) {
  return Boolean(trustPrompt(agent) || menuOptions(agent).length || permissionPrompt(agent));
}

// Typed as a bracketed paste so multi-line text arrives as one message, then Enter submits it.
export function sendText(agent, text) {
  if (!agent?.alive) return false;
  agent.term.write(`\x1b[200~${String(text)}\x1b[201~`);
  setTimeout(() => agent.alive && agent.term.write('\r'), 150);
  // A Claude Code that has just started (e.g. right after the trust dialog) can swallow the Enter
  // that follows a paste: the order then sits in its input line. Seen there, Enter goes again.
  // (it may only show up there a few seconds later, while Claude Code finishes starting)
  const head = String(text).replace(/\s+/g, ' ').trim().slice(0, 10);
  const t0 = Date.now();
  let presses = 0;
  const verify = () => {
    if (!agent.alive || presses >= 3 || Date.now() - t0 > 12_000) return;
    if (orderInInput(agent, head) && Date.now() - agent.lastOutputAt > 800) {
      presses++;
      agent.term.write('\r');
    }
    setTimeout(verify, 1000);
  };
  setTimeout(verify, 1500);
  return true;
}

/** Whether Claude Code's input line (the ❯ line under a rule) still holds this text, or a collapsed paste. */
function orderInInput(agent, head) {
  const lines = screenLines(agent);
  for (let i = lines.length - 1; i > 0; i--) {
    if (!PROMPT.test(lines[i]) || !/^[─━]{5,}/.test(lines[i - 1])) continue;
    const input = lines[i].replace(PROMPT_MARK, '').replace(/\s+/g, ' ').trim();
    return Boolean(input) && (input.startsWith(head) || /^\[Pasted text/i.test(input));
  }
  return false;
}

// what a button can press: the command center uses esc; the phone page drives any dialog with the rest
const KEYS = { esc: '\x1b', 'ctrl-c': '\x03', enter: '\r', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', tab: '\t', 'shift-tab': '\x1b[Z', space: ' ', backspace: '\x7f', 1: '1', 2: '2', 3: '3' };

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
  return { kind: 'permission', text: body.filter((l, i, a) => l || (i && a[i - 1])).join('\n').trim(), options };
}

/**
 * Any other question waiting on a person: a live numbered menu (AskUserQuestion, plan approval, a
 * picker) with the question text above it, up to the rule that opens the box.
 */
export function questionPrompt(agent) {
  const options = menuOptions(agent);
  if (!options.length) return null;
  const lines = screenLines(agent);
  // the menu is the last one on screen (a numbered list in Claude's text above it is not)
  const optAt = lines.findLastIndex((l) => l.match(/^\s*(?:[❯›>▸]\s*)?(\d)\.\s+\S/)?.[1] === options[0].key);
  const body = [];
  for (let i = optAt - 1; i >= 0 && body.length < 16; i--) {
    const l = lines[i];
    if (/^[\s─━═]{8,}$/.test(l)) break;
    if (/^[\s╌┄-]{8,}$/.test(l)) continue;
    body.unshift(l.replace(/^[\s│╭╰╮╯]+|[\s│╭╰╮╯]+$/g, ''));
  }
  return { kind: 'question', text: body.filter((l, i, a) => l || (i && a[i - 1])).join('\n').trim(), options: options.map(({ key, label }) => ({ key, label })) };
}

/**
 * Whether the agent's own input line is empty (Claude Code shows a dim placeholder there), so a
 * message typed in for it won't land in the middle of what someone is writing.
 */
export function inputEmpty(agent) {
  const b = agent?.screen?.buffer.active;
  if (!b) return false;
  const rows = agent.screen.rows;
  for (let y = b.viewportY + rows - 1; y > b.viewportY; y--) {
    const line = b.getLine(y);
    const text = line?.translateToString(true) || '';
    if (!PROMPT.test(text)) continue;
    const above = b.getLine(y - 1)?.translateToString(true) || '';
    if (!/^[─━]{5,}/.test(above)) continue; // the prompt box opens with a rule; menus don't
    for (let x = 1; x < line.length; x++) {
      const c = line.getCell(x);
      if (!c) break;
      const ch = c.getChars();
      if (!ch.trim()) continue; // blanks, including the no-break space after ❯
      // placeholder text is drawn dim or in the dim palette color
      if (c.isDim() || (c.isFgPalette() && c.getFgColor() === 8)) continue;
      return false;
    }
    return true;
  }
  return false;
}

/** Answer a permission dialog by its option number (1 = yes); Esc rejects. */
export function answerPrompt(agent, choice) {
  if (!agent?.alive) return false;
  // the trust dialog takes the arrow keys and Enter, not digits
  const trust = trustPrompt(agent);
  if (trust && /^[12]$/.test(choice)) {
    const want = Number(choice) - 1;
    const at = trust.options.findIndex((o) => o.current);
    const moves = want - (at < 0 ? 0 : at);
    agent.term.write((moves > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(moves)));
    setTimeout(() => agent.alive && agent.term.write('\r'), 150);
    return true;
  }
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

/** Ended by the user (the ■ button, the phone, the master). */
export function endAgent(agent) {
  if (agent) agent.endedByUser = true;
  killAgent(agent);
}

export function removeAgent(id) {
  const a = agents.get(id);
  if (!a || a.alive) return false;
  for (const ws of a.clients) ws.close();
  agents.delete(id);
  host.forget(id);
  onChange();
  return true;
}

/** The app quits: every terminal ends with it, and the PTY host too. */
export async function killAll() {
  await host.killAll();
}
