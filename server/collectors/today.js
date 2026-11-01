import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { config } from '../config.js';

// Today's totals over every transcript written today (ended sessions and subagents included):
// tokens by kind, cache hit rate and the number of prompts the commander sent.
// Files are read incrementally like transcript.js; everything resets at local midnight.

const CHUNK = 1 << 20;
let day = '';
const files = new Map(); // path -> { offset, rest, decoder, usage: Map(message id -> usage), prompts }

function midnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// A prompt is a main-thread user line with text, not a tool result, a command wrapper (<…>) or meta.
function isPrompt(d) {
  if (d.type !== 'user' || d.isSidechain || d.isMeta || !d.message) return false;
  const c = d.message.content;
  if (typeof c === 'string') return c.trim() !== '' && !c.startsWith('<');
  return Array.isArray(c) && !c.some((b) => b?.type === 'tool_result') && c.some((b) => b?.type === 'text' && b.text?.trim() && !b.text.startsWith('<'));
}

function apply(st, d, since) {
  if (!d.timestamp || Date.parse(d.timestamp) < since) return;
  const msg = d.message;
  // One reply is written as several lines (one per content block) repeating the same usage,
  // with the final output count on the last: keep the last line per message id.
  if (d.type === 'assistant' && msg?.usage && msg.model !== '<synthetic>') st.usage.set(msg.id || d.uuid, msg.usage);
  else if (isPrompt(d)) st.prompts++;
}

function read(file, since) {
  let st = files.get(file);
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  if (!st || size < st.offset) {
    st = { offset: 0, rest: '', decoder: new StringDecoder('utf8'), usage: new Map(), prompts: 0 };
    files.set(file, st);
  }
  if (size <= st.offset) return st;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    while (st.offset < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - st.offset), st.offset);
      if (n <= 0) break;
      st.offset += n;
      const lines = (st.rest + st.decoder.write(buf.subarray(0, n))).split('\n');
      st.rest = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        try {
          apply(st, JSON.parse(line), since);
        } catch {
          // malformed line: skip it
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return st;
}

// <projects>/<dir>/<session>.jsonl and <projects>/<dir>/<session>/subagents/*.jsonl, modified today
function todaysFiles(root, since) {
  const out = [];
  const fresh = (p) => {
    try {
      return fs.statSync(p).mtimeMs >= since;
    } catch {
      return false;
    }
  };
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const d of dirs) {
    const dir = path.join(root, d.name);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        if (fresh(p)) out.push(p);
      } else if (e.isDirectory() && fresh(p)) {
        const sub = path.join(p, 'subagents');
        try {
          for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl') && fresh(path.join(sub, f))) out.push(path.join(sub, f));
        } catch {
          // no subagents
        }
      }
    }
  }
  return out;
}

export function collectToday() {
  const start = midnight();
  const key = start.toDateString();
  if (key !== day) {
    day = key;
    files.clear();
  }
  const since = start.getTime();
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, prompts: 0, sessions: 0 };
  for (const f of todaysFiles(path.join(config.claudeDir, 'projects'), since)) {
    const st = read(f, since);
    if (!st) continue;
    if (st.usage.size || st.prompts) t.sessions++;
    t.prompts += st.prompts;
    for (const u of st.usage.values()) {
      t.input += u.input_tokens || 0;
      t.output += u.output_tokens || 0;
      t.cacheRead += u.cache_read_input_tokens || 0;
      t.cacheWrite += u.cache_creation_input_tokens || 0;
    }
  }
  const inTotal = t.input + t.cacheRead + t.cacheWrite;
  return { ...t, total: inTotal + t.output, cacheHitPct: inTotal ? (t.cacheRead / inTotal) * 100 : null };
}
