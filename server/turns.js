import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { historyFiles } from './collectors/history.js';
import { DATA_DIR } from './config.js';

// Turns the master gave out: an order typed into one of our agents by the master (fleet_send, a
// queued order it sent later, the first order of fleet_spawn). When that turn is over (the agent is
// idle again and not stopped on a permission dialog or a question) the master is told, with the
// answer, so it doesn't have to watch screens. Orders from anyone else (typed in the terminal, the
// input box, the phone) are only remembered as "who gave the last order".

const REPLY_MAX = 1500; // characters of the answer in a notice: its start and its end
// kept in <data>/turns.json too: an update restarts the server, and the turns under way must still
// be told when they end (they used to be forgotten, and their notices with them)
const FILE = path.join(DATA_DIR, 'turns.json');
const turns = new Map(load()); // agent id -> { text, at, started }
let saved = JSON.stringify(Object.fromEntries(turns));

function load() {
  try {
    return Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')) || {});
  } catch {
    return [];
  }
}

function save() {
  const s = JSON.stringify(Object.fromEntries(turns));
  if (s === saved) return;
  saved = s;
  try {
    fs.writeFileSync(FILE, s);
  } catch {
    // kept in memory only
  }
}

/** Who gave an agent its last order: 'master', 'cc' (input box), 'phone', 'terminal' (typed into it). */
export function noteOrder(agent, by, text, now = Date.now()) {
  if (!agent || agent.kind === 'shell' || agent.kind === 'master') return;
  agent.orderBy = by;
  if (by === 'master') turns.set(agent.id, { text: String(text || ''), at: now, started: false });
  else turns.delete(agent.id); // someone else took over this agent: its next result isn't the master's
  save();
}

export const masterTurn = (id) => turns.get(id) || null;

/**
 * Called on every publish with our agents' live units and the ones waiting on a person.
 * @returns {{agentId: string, sessionId: string, name: string, text: string, ms: number}[]} turns that just ended
 */
export function endedTurns(units, waiting, now = Date.now()) {
  const done = [];
  for (const u of units) {
    const t = turns.get(u.agentId);
    if (!t) continue;
    if (u.status === 'busy') t.started = true;
    // started: seen busy, or its status changed after the order went out (a quick turn can go
    // busy -> idle between two polls). Stopped on a permission dialog or a question: not over yet.
    // (the second way also needs the session's last order to be this one: a resumed session shows up
    // idle with a fresh status time before anything was typed, and that used to count as done)
    const head = t.text.replace(/\s+/g, ' ').trim().slice(0, 30);
    const ours = !head || String(u.lastPrompt || '').replace(/\s+/g, ' ').trim().startsWith(head);
    const started = t.started || ((u.statusSince || 0) > t.at + 500 && ours);
    if (!started || u.status !== 'idle' || waiting.has(u.agentId)) {
      delete t.quiet;
      continue;
    }
    // Idle isn't enough: the transcript must show this turn (an answer, a tool call, an interruption).
    // A resumed session can sit idle under a dialog that came before the order ran (e.g. "Fable 5.1 now
    // uses usage credits"); idle with nothing in the transcript is told only after a minute of it, as
    // an order that never ran (the dialog cancelled, the order dropped).
    let neverRan = false;
    if (traced(u.sessionId, t.at) === false) {
      t.quiet ||= now;
      if (now - t.quiet < 60_000) continue;
      neverRan = true;
    }
    turns.delete(u.agentId);
    done.push({ agentId: u.agentId, sessionId: u.sessionId, name: u.name || u.project, text: t.text, ms: now - t.at, since: t.at, neverRan });
  }
  // agents that are gone don't finish
  const live = new Set(units.map((u) => u.agentId));
  for (const id of turns.keys()) if (!live.has(id) && now - turns.get(id).at > 600_000) turns.delete(id);
  save();
  return done;
}

// The session's transcript: from the history scan, else looked up once under ~/.claude/projects.
const found = new Map();
function transcriptOf(sessionId) {
  if (historyFiles.has(sessionId)) return historyFiles.get(sessionId);
  const hit = found.get(sessionId);
  if (hit && (hit.file || Date.now() - hit.at < 5000)) return hit.file;
  let file = null;
  try {
    const root = path.join(os.homedir(), '.claude', 'projects');
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) {
        file = f;
        break;
      }
    }
  } catch {
    // no projects folder
  }
  found.set(sessionId, { file, at: Date.now() }); // a new session's file may not be there yet: not found is retried after 5 s
  return file;
}

/** The last ~1 MB of a transcript as parsed entries. */
function tail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 1_048_576);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf
      .toString('utf8')
      .split('\n')
      .slice(size > len ? 1 : 0) // the first line may be cut
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * What the agent answered in the turn that started at `since`: its last assistant text, whether it
 * already messaged the master itself (SendMessage) in that turn, and whether the turn was cut short
 * (Esc, or a tool use turned down: "[Request interrupted by user…]" with no answer after it).
 * Only this turn counts: a turn that wrote no text has no reply (not the one before it).
 * @returns {{ reply: string, messaged: boolean, interrupted: boolean } | null} null: no transcript to read
 */
export function turnReply(sessionId, since) {
  const file = sessionId && transcriptOf(sessionId);
  if (!file) return null;
  let entries;
  try {
    entries = tail(file);
  } catch {
    return null;
  }
  let reply = '';
  let messaged = false;
  let interrupted = false;
  for (const e of entries) {
    const at = Date.parse(e.timestamp || '') || 0;
    if (!at || at < since - 2000) continue; // before this turn (entries with no time aren't messages)
    if (e.type === 'user' && cutShort(e.message?.content)) interrupted = true;
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const c of e.message.content) {
      if (c.type === 'text' && c.text?.trim()) {
        reply = c.text.trim();
        interrupted = false; // it went on and answered after all
      }
      if (c.type === 'tool_use' && c.name === 'SendMessage') messaged = true;
    }
  }
  return { reply, messaged, interrupted };
}

/** Whether the transcript has anything of the turn that started at `since` (null: no transcript to read). */
function traced(sessionId, since) {
  const file = sessionId && transcriptOf(sessionId);
  if (!file) return null;
  try {
    return tail(file).some((e) => {
      const at = Date.parse(e.timestamp || '') || 0;
      return at >= since - 2000 && (e.type === 'assistant' || (e.type === 'user' && cutShort(e.message?.content)));
    });
  } catch {
    return null;
  }
}

// Claude Code's mark for a turn stopped by the user: "[Request interrupted by user]",
// "[Request interrupted by user for tool use]"
function cutShort(content) {
  const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text) : [];
  return texts.some((s) => /^\[Request interrupted by user/.test(String(s || '').trim()));
}

/** Start and end of a long answer, with a marker in between. */
export function clip(text, max = REPLY_MAX) {
  const s = String(text || '').trim();
  if (s.length <= max) return { text: s, cut: false };
  const head = Math.round(max * 0.6);
  return { text: `${s.slice(0, head)}\n…（中略 ${s.length - max} 字）…\n${s.slice(-(max - head))}`, cut: true };
}
