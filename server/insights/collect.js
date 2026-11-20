import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { readEvents } from './events.js';

// What the self-improvement analysis looks at, read from this machine only: Fleet Bridge's event log, the
// order log, what the user said to the master (its transcript), and for each agent that got orders in the
// period, what its transcript shows (failed tool calls, stop hooks, interruptions, what was typed into it
// by hand). Raw: redacting is the caller's job, before anything leaves this machine.

const TAIL = 8 * 1024 * 1024; // the end of each transcript read (once a day at most: a long session has its last days in it)

function tailLines(file, bytes = TAIL) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf
      .toString('utf8')
      .split('\n')
      .slice(size > len ? 1 : 0)
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

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text || '').join('\n') : '');
const NOTICE = /^\s*(【舰桥通知】|\[Fleet notice\]|【艦橋通知】)/;
const SYSTEMISH = /^<(command-|local-command|system-reminder|bash-)|^\[Request interrupted|^Stop hook feedback:|^Caveat:/;

/** The user's own messages in a transcript (not tool results, notices from Fleet Bridge, meta or commands). */
export function userMessages(entries, since) {
  const out = [];
  for (const e of entries) {
    if (e.type !== 'user' || e.isMeta || e.isSidechain) continue;
    const at = Date.parse(e.timestamp || '') || 0;
    if (at < since) continue;
    const c = e.message?.content;
    if (Array.isArray(c) && c.some((x) => x?.type === 'tool_result')) continue;
    const t = textOf(c).trim();
    if (!t || NOTICE.test(t) || SYSTEMISH.test(t)) continue;
    out.push({ at, text: t });
  }
  return out;
}

/** One agent session's signals in the period. */
export function sessionSignals(entries, since) {
  const tools = new Map(); // tool_use id -> { name, arg }
  const toolErrors = [];
  let stopHooks = 0;
  let interrupts = 0;
  let toolCalls = 0;
  for (const e of entries) {
    if (e.isSidechain) continue;
    const at = Date.parse(e.timestamp || '') || 0;
    if (at < since) continue;
    const c = e.message?.content;
    if (e.type === 'assistant' && Array.isArray(c)) {
      for (const x of c) {
        if (x?.type !== 'tool_use') continue;
        toolCalls++;
        tools.set(x.id, { name: x.name, arg: String(x.input?.command || x.input?.file_path || x.input?.pattern || x.input?.path || '').slice(0, 160) });
      }
    }
    if (e.type !== 'user') continue;
    if (/^Stop hook feedback:/.test(textOf(c).trim())) stopHooks++;
    if (/^\[Request interrupted by user/.test(textOf(c).trim())) interrupts++;
    if (Array.isArray(c))
      for (const x of c) {
        if (x?.type !== 'tool_result' || !x.is_error) continue;
        const t = tools.get(x.tool_use_id) || { name: '?', arg: '' };
        const msg = (typeof x.content === 'string' ? x.content : textOf(x.content)).replace(/\s+/g, ' ').trim();
        // turned down by the user isn't a failure of the tool
        if (/^The user doesn't want to proceed|^\[Request interrupted|was rejected/i.test(msg)) continue;
        toolErrors.push({ at, tool: t.name, arg: t.arg, error: msg.slice(0, 200) });
      }
  }
  return { toolErrors, stopHooks, interrupts, toolCalls, typed: userMessages(entries, since) };
}

function readJsonl(file, since) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((e) => e && (e.at || 0) >= since);
  } catch {
    return [];
  }
}

/**
 * @param {{ now?: number, days?: number, dataDir?: string, masterSession?: string|null,
 *   transcriptOf: (sessionId: string) => string|null }} o
 */
export function collect(o) {
  const now = o.now || Date.now();
  const since = now - (o.days || 14) * 86_400_000;
  const dataDir = o.dataDir || DATA_DIR;
  const events = readEvents(since, path.join(dataDir, 'events.jsonl'));
  const orders = readJsonl(path.join(dataDir, 'orders.jsonl'), since);
  let masterSays = [];
  const mf = o.masterSession && o.transcriptOf(o.masterSession);
  if (mf) {
    try {
      masterSays = userMessages(tailLines(mf), since);
    } catch {
      // unreadable: nothing from the master
    }
  }
  // each agent that got orders in the period (by session id; the agent id is its first session id)
  const ids = new Map();
  for (const x of orders) if (x.agentId && x.kind !== 'removed') ids.set(x.agentId, x.name || x.project || x.agentId.slice(0, 8));
  for (const e of events) if (e.agentId && !ids.has(e.agentId)) ids.set(e.agentId, e.agent || e.agentId.slice(0, 8));
  const sessions = [];
  for (const [id, name] of [...ids].slice(-40)) {
    if (id === o.masterSession) continue;
    const f = o.transcriptOf(id);
    if (!f) continue;
    try {
      sessions.push({ sessionId: id, name, ...sessionSignals(tailLines(f), since) });
    } catch {
      // unreadable transcript
    }
  }
  return { now, since, days: o.days || 14, events, orders, masterSays, sessions };
}
